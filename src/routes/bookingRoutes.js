const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDB } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');
const lockManager = require('../services/concurrencyLock');
const { processWaitlistOnSeatRelease } = require('../services/waitlistService');
const { sendBookingConfirmationEmail } = require('../services/qrEmailService');

const HOLD_TTL_MINUTES = parseInt(process.env.HOLD_TTL_MINUTES || '10');

// POST Hold Seats (Customer places temporary hold with TTL)
router.post('/hold', authenticateToken, async (req, res) => {
  try {
    const { event_id, seat_ids } = req.body;

    if (!event_id || !Array.isArray(seat_ids) || seat_ids.length === 0) {
      return res.status(400).json({ error: 'event_id and an array of seat_ids are required.' });
    }

    const lockKeys = seat_ids.map(id => `event_${event_id}_seat_${id}`);

    // Concurrency protection via fine-grained lock
    const result = await lockManager.withLock(lockKeys, async () => {
      const db = await getDB();
      const now = new Date().toISOString();

      // Check seat availability
      const placeholders = seat_ids.map(() => '?').join(',');
      const seats = await db.all(
        `SELECT * FROM event_seats WHERE event_id = ? AND id IN (${placeholders})`,
        [event_id, ...seat_ids]
      );

      if (seats.length !== seat_ids.length) {
        return { status: 404, data: { error: 'One or more selected seats were not found.' } };
      }

      // Check if any seat is already booked or currently held by another user
      for (const seat of seats) {
        if (seat.status === 'BOOKED') {
          return { status: 409, data: { error: `Seat ${seat.seat_code} is already booked.` } };
        }
        if (seat.status === 'HELD' && seat.held_by_user_id !== req.user.id) {
          // If hold is not expired
          if (new Date(seat.hold_expires_at) > new Date()) {
            return { status: 409, data: { error: `Seat ${seat.seat_code} is currently held by another customer.` } };
          }
        }
      }

      // Calculate hold expiry time
      const expiresAt = new Date(Date.now() + HOLD_TTL_MINUTES * 60 * 1000).toISOString();

      // Update seats to HELD status
      for (const id of seat_ids) {
        await db.run(
          `UPDATE event_seats 
           SET status = 'HELD', held_by_user_id = ?, hold_expires_at = ?, version = version + 1
           WHERE id = ?`,
          [req.user.id, expiresAt, id]
        );
      }

      return {
        status: 200,
        data: {
          message: `Seats held successfully for ${HOLD_TTL_MINUTES} minutes.`,
          seat_ids,
          expires_at: expiresAt
        }
      };
    });

    return res.status(result.status).json(result.data);
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message });
    }
    console.error('Seat hold error:', err);
    res.status(500).json({ error: 'Failed to place hold on seats.' });
  }
});

// POST Release Hold (Customer abandons checkout)
router.post('/release-hold', authenticateToken, async (req, res) => {
  try {
    const { event_id, seat_ids } = req.body;
    if (!event_id || !Array.isArray(seat_ids)) {
      return res.status(400).json({ error: 'event_id and seat_ids required.' });
    }

    const db = await getDB();
    for (const seatId of seat_ids) {
      const seat = await db.get(
        `SELECT * FROM event_seats WHERE id = ? AND event_id = ? AND held_by_user_id = ?`,
        [seatId, event_id, req.user.id]
      );

      if (seat && seat.status === 'HELD') {
        // Release hold and check waitlist trigger
        await processWaitlistOnSeatRelease(event_id, seat.category, seatId);
      }
    }

    res.json({ message: 'Seat holds released.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to release seat holds.' });
  }
});

// POST Confirm Booking (Checkout)
router.post('/confirm', authenticateToken, async (req, res) => {
  try {
    const { event_id, seat_ids, offer_token } = req.body;

    const db = await getDB();
    let targetSeatIds = seat_ids;

    // Handle waitlist offer claim if offer_token provided
    if (offer_token) {
      const offer = await db.get(
        `SELECT * FROM waitlist WHERE offer_token = ? AND user_id = ? AND status = 'OFFERED'`,
        [offer_token, req.user.id]
      );

      if (!offer) {
        return res.status(400).json({ error: 'Invalid or expired waitlist offer token.' });
      }

      if (new Date(offer.offer_expires_at) < new Date()) {
        return res.status(400).json({ error: 'Waitlist offer has expired.' });
      }

      targetSeatIds = [offer.offered_seat_id];
    }

    if (!event_id || !Array.isArray(targetSeatIds) || targetSeatIds.length === 0) {
      return res.status(400).json({ error: 'event_id and valid seat_ids are required.' });
    }

    const lockKeys = targetSeatIds.map(id => `event_${event_id}_seat_${id}`);

    const result = await lockManager.withLock(lockKeys, async () => {
      const now = new Date();

      // Fetch seats
      const placeholders = targetSeatIds.map(() => '?').join(',');
      const seats = await db.all(
        `SELECT * FROM event_seats WHERE event_id = ? AND id IN (${placeholders})`,
        [event_id, ...targetSeatIds]
      );

      if (seats.length !== targetSeatIds.length) {
        return { status: 404, data: { error: 'One or more seats not found.' } };
      }

      // Verify that user holds all these seats and hold has not expired
      for (const seat of seats) {
        if (seat.status === 'BOOKED') {
          return { status: 409, data: { error: `Seat ${seat.seat_code} is already booked by someone else.` } };
        }
        if (seat.status !== 'HELD' || seat.held_by_user_id !== req.user.id) {
          return { status: 400, data: { error: `Seat ${seat.seat_code} is not currently held by your account. Please select/hold seats first.` } };
        }
        if (new Date(seat.hold_expires_at) < now) {
          return { status: 400, data: { error: `Seat hold for ${seat.seat_code} has expired. Please select seats again.` } };
        }
      }

      // Calculate totals
      const seatCodes = seats.map(s => s.seat_code);
      const category = seats[0].category;
      const totalAmount = seats.reduce((sum, s) => sum + s.price, 0);

      const bookingRef = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

      // Insert booking record
      const bookingInsert = await db.run(
        `INSERT INTO bookings (booking_reference, event_id, user_id, seat_ids, seat_codes, seat_category, total_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED')`,
        [
          bookingRef,
          event_id,
          req.user.id,
          JSON.stringify(targetSeatIds),
          JSON.stringify(seatCodes),
          category,
          totalAmount
        ]
      );

      const bookingId = bookingInsert.lastID;

      // Mark seats as BOOKED
      for (const id of targetSeatIds) {
        await db.run(
          `UPDATE event_seats 
           SET status = 'BOOKED', booking_id = ?, held_by_user_id = NULL, hold_expires_at = NULL, version = version + 1
           WHERE id = ?`,
          [bookingId, id]
        );
      }

      // If this came from a waitlist offer, update waitlist entry
      if (offer_token) {
        await db.run(
          `UPDATE waitlist SET status = 'CONVERTED' WHERE offer_token = ?`,
          [offer_token]
        );
      }

      // Fetch event & venue info for email
      const eventDetails = await db.get(
        `SELECT e.title as event_title, e.event_date, v.name as venue_name
         FROM events e
         JOIN venues v ON e.venue_id = v.id
         WHERE e.id = ?`,
        [event_id]
      );

      const bookingObj = {
        id: bookingId,
        booking_reference: bookingRef,
        event_title: eventDetails.event_title,
        event_date: eventDetails.event_date,
        venue_name: eventDetails.venue_name,
        seat_codes: seatCodes,
        seat_category: category,
        total_amount: totalAmount
      };

      // Generate QR Code & Send Confirmation Email
      const qrCodeBase64 = await sendBookingConfirmationEmail(req.user.email, req.user.name, bookingObj);

      // Store QR code data on booking
      await db.run(`UPDATE bookings SET qr_code_data = ? WHERE id = ?`, [qrCodeBase64, bookingId]);
      bookingObj.qr_code_data = qrCodeBase64;

      return {
        status: 201,
        data: {
          message: 'Booking confirmed successfully!',
          booking: bookingObj
        }
      };
    });

    return res.status(result.status).json(result.data);
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message });
    }
    console.error('Booking confirmation error:', err);
    res.status(500).json({ error: 'Failed to process booking confirmation.' });
  }
});

// POST Cancel Booking (Triggers Waitlist Auto-Assignment)
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const { booking_id } = req.body;
    if (!booking_id) {
      return res.status(400).json({ error: 'booking_id is required.' });
    }

    const db = await getDB();
    const booking = await db.get('SELECT * FROM bookings WHERE id = ?', [booking_id]);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    if (booking.user_id !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'You are not authorized to cancel this booking.' });
    }

    if (booking.status === 'CANCELLED') {
      return res.status(400).json({ error: 'Booking is already cancelled.' });
    }

    // Mark booking as CANCELLED
    await db.run(`UPDATE bookings SET status = 'CANCELLED' WHERE id = ?`, [booking_id]);

    const seatIds = JSON.parse(booking.seat_ids);

    // Process each seat release: offer to waitlisted customer if any exists
    for (const seatId of seatIds) {
      const seat = await db.get('SELECT * FROM event_seats WHERE id = ?', [seatId]);
      if (seat) {
        await db.run(
          `UPDATE event_seats 
           SET status = 'AVAILABLE', booking_id = NULL, held_by_user_id = NULL, hold_expires_at = NULL, version = version + 1
           WHERE id = ?`,
          [seatId]
        );

        // Auto-assign seat to waitlist queue!
        await processWaitlistOnSeatRelease(seat.event_id, seat.category, seatId);
      }
    }

    res.json({
      message: 'Booking cancelled successfully. Released seats have been automatically offered to waitlisted customers.'
    });
  } catch (err) {
    console.error('Booking cancellation error:', err);
    res.status(500).json({ error: 'Failed to cancel booking.' });
  }
});

// GET My Bookings
router.get('/my-bookings', authenticateToken, async (req, res) => {
  try {
    const db = await getDB();
    const bookings = await db.all(
      `SELECT b.*, e.title as event_title, e.category as event_category, e.event_date, v.name as venue_name
       FROM bookings b
       JOIN events e ON b.event_id = e.id
       JOIN venues v ON e.venue_id = v.id
       WHERE b.user_id = ?
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );

    const formatted = bookings.map(b => ({
      ...b,
      seat_ids: JSON.parse(b.seat_ids),
      seat_codes: JSON.parse(b.seat_codes)
    }));

    res.json({ bookings: formatted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user bookings.' });
  }
});

module.exports = router;
