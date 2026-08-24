const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');
const { authenticateToken } = require('../middleware/auth');

// POST Join Waitlist for an event category
router.post('/join', authenticateToken, async (req, res) => {
  try {
    const { event_id, seat_category } = req.body;
    if (!event_id || !seat_category) {
      return res.status(400).json({ error: 'event_id and seat_category are required.' });
    }

    const db = await getDB();
    const event = await db.get('SELECT * FROM events WHERE id = ?', [event_id]);

    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    // Check if user is already waiting for this event + category
    const existing = await db.get(
      `SELECT * FROM waitlist 
       WHERE event_id = ? AND seat_category = ? AND user_id = ? AND status IN ('WAITING', 'OFFERED')`,
      [event_id, seat_category, req.user.id]
    );

    if (existing) {
      return res.status(400).json({ error: 'You are already on the waitlist for this seat category.' });
    }

    const result = await db.run(
      `INSERT INTO waitlist (event_id, seat_category, user_id, status)
       VALUES (?, ?, ?, 'WAITING')`,
      [event_id, seat_category, req.user.id]
    );

    // Calculate queue position
    const queuePosition = await db.get(
      `SELECT COUNT(*) as pos FROM waitlist 
       WHERE event_id = ? AND seat_category = ? AND status = 'WAITING' AND id <= ?`,
      [event_id, seat_category, result.lastID]
    );

    res.status(201).json({
      message: `Successfully joined waitlist for ${seat_category} category!`,
      waitlist_id: result.lastID,
      queue_position: queuePosition.pos
    });
  } catch (err) {
    console.error('Waitlist join error:', err);
    res.status(500).json({ error: 'Failed to join waitlist.' });
  }
});

// GET My Waitlist Entries
router.get('/my-waitlist', authenticateToken, async (req, res) => {
  try {
    const db = await getDB();
    const entries = await db.all(
      `SELECT w.*, e.title as event_title, e.event_date, v.name as venue_name
       FROM waitlist w
       JOIN events e ON w.event_id = e.id
       JOIN venues v ON e.venue_id = v.id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );

    res.json({ waitlist: entries });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch waitlist entries.' });
  }
});

// GET Validate Waitlist Offer Token
router.get('/offer/:token', authenticateToken, async (req, res) => {
  try {
    const { token } = req.params;
    const db = await getDB();

    const offer = await db.get(
      `SELECT w.*, e.title as event_title, e.event_date, s.seat_code, s.price
       FROM waitlist w
       JOIN events e ON w.event_id = e.id
       LEFT JOIN event_seats s ON w.offered_seat_id = s.id
       WHERE w.offer_token = ? AND w.user_id = ?`,
      [token, req.user.id]
    );

    if (!offer) {
      return res.status(404).json({ error: 'Waitlist offer token not found or does not belong to you.' });
    }

    if (offer.status !== 'OFFERED') {
      return res.status(400).json({ error: `Offer is no longer active (status: ${offer.status}).` });
    }

    if (new Date(offer.offer_expires_at) < new Date()) {
      return res.status(400).json({ error: 'This waitlist offer has expired.' });
    }

    res.json({ offer });
  } catch (err) {
    res.status(500).json({ error: 'Failed to validate waitlist offer.' });
  }
});

module.exports = router;
