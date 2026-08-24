const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET Organiser summary & revenue analytics per event
router.get('/summary', authenticateToken, requireRole(['ORGANISER', 'ADMIN']), async (req, res) => {
  try {
    const db = await getDB();
    let eventQuery = `SELECT e.*, v.name as venue_name FROM events e JOIN venues v ON e.venue_id = v.id`;
    const params = [];

    if (req.user.role === 'ORGANISER') {
      eventQuery += ` WHERE e.organiser_id = ?`;
      params.push(req.user.id);
    }
    eventQuery += ` ORDER BY e.created_at DESC`;

    const events = await db.all(eventQuery, params);

    const summary = [];
    for (const ev of events) {
      // Aggregate bookings revenue
      const revenueRow = await db.get(
        `SELECT COUNT(*) as total_bookings, SUM(total_amount) as total_revenue
         FROM bookings 
         WHERE event_id = ? AND status = 'CONFIRMED'`,
        [ev.id]
      );

      // Seat status breakdown
      const seatCounts = await db.all(
        `SELECT status, COUNT(*) as count FROM event_seats WHERE event_id = ? GROUP BY status`,
        [ev.id]
      );

      const seatBreakdown = { AVAILABLE: 0, HELD: 0, BOOKED: 0, TOTAL: 0 };
      for (const row of seatCounts) {
        seatBreakdown[row.status] = row.count;
        seatBreakdown.TOTAL += row.count;
      }

      // Waitlist queue count
      const waitlistRow = await db.get(
        `SELECT COUNT(*) as waitlist_count FROM waitlist WHERE event_id = ? AND status = 'WAITING'`,
        [ev.id]
      );

      summary.push({
        event_id: ev.id,
        title: ev.title,
        category: ev.category,
        venue_name: ev.venue_name,
        event_date: ev.event_date,
        total_bookings: revenueRow.total_bookings || 0,
        total_revenue: revenueRow.total_revenue || 0,
        seat_breakdown: seatBreakdown,
        waitlist_count: waitlistRow.waitlist_count || 0
      });
    }

    res.json({ summary });
  } catch (err) {
    console.error('Organiser summary error:', err);
    res.status(500).json({ error: 'Failed to generate organiser summary.' });
  }
});

// GET Outbox Emails Inspector (Allows inspecting sent tickets & QR codes in UI)
router.get('/outbox-emails', async (req, res) => {
  try {
    const db = await getDB();
    const emails = await db.all(`SELECT * FROM outbox_emails ORDER BY created_at DESC LIMIT 50`);
    res.json({ emails });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch outbox emails.' });
  }
});

module.exports = router;
