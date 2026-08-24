const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET list of active events (with optional filtering)
router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    const db = await getDB();

    let query = `
      SELECT e.*, v.name as venue_name, v.address as venue_address, u.name as organiser_name
      FROM events e
      JOIN venues v ON e.venue_id = v.id
      JOIN users u ON e.organiser_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (category) {
      query += ` AND e.category = ?`;
      params.push(category);
    }
    if (search) {
      query += ` AND (e.title LIKE ? OR e.description LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY e.event_date ASC`;

    const events = await db.all(query, params);

    // Attach availability summary per category to each event
    for (const ev of events) {
      ev.pricing = JSON.parse(ev.pricing);
      const seatCounts = await db.all(
        `SELECT category, status, COUNT(*) as count 
         FROM event_seats 
         WHERE event_id = ? 
         GROUP BY category, status`,
        [ev.id]
      );

      // Structure counts: e.g. { Premium: { available: 5, held: 1, booked: 6, total: 12 } }
      const availability = {};
      for (const [cat] of Object.entries(ev.pricing)) {
        availability[cat] = { available: 0, held: 0, booked: 0, total: 0 };
      }

      for (const row of seatCounts) {
        if (!availability[row.category]) {
          availability[row.category] = { available: 0, held: 0, booked: 0, total: 0 };
        }
        availability[row.category].total += row.count;
        if (row.status === 'AVAILABLE') availability[row.category].available += row.count;
        if (row.status === 'HELD') availability[row.category].held += row.count;
        if (row.status === 'BOOKED') availability[row.category].booked += row.count;
      }

      ev.availability = availability;
    }

    res.json({ events });
  } catch (err) {
    console.error('Fetch events error:', err);
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

// GET single event details
router.get('/:id', async (req, res) => {
  try {
    const db = await getDB();
    const event = await db.get(
      `SELECT e.*, v.name as venue_name, v.address as venue_address, v.total_rows, v.seats_per_row, v.seat_layout
       FROM events e
       JOIN venues v ON e.venue_id = v.id
       WHERE e.id = ?`,
      [req.params.id]
    );

    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    event.pricing = JSON.parse(event.pricing);
    event.seat_layout = JSON.parse(event.seat_layout);
    res.json({ event });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch event details.' });
  }
});

// GET full visual seat map grid for an event
router.get('/:id/seats', async (req, res) => {
  try {
    const db = await getDB();
    const seats = await db.all(
      `SELECT id, row_label, seat_number, seat_code, category, price, status, held_by_user_id, hold_expires_at
       FROM event_seats 
       WHERE event_id = ?
       ORDER BY row_label ASC, seat_number ASC`,
      [req.params.id]
    );

    res.json({ seats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch event seats map.' });
  }
});

// POST Create new Event listing (Organiser or Admin)
router.post('/', authenticateToken, requireRole(['ORGANISER', 'ADMIN']), async (req, res) => {
  try {
    const { title, description, category, venue_id, event_date, pricing } = req.body;

    if (!title || !category || !venue_id || !event_date || !pricing) {
      return res.status(400).json({ error: 'Title, category, venue_id, event_date, and pricing are required.' });
    }

    const db = await getDB();
    const venue = await db.get('SELECT * FROM venues WHERE id = ?', [venue_id]);
    if (!venue) {
      return res.status(404).json({ error: 'Selected venue does not exist.' });
    }

    const seatLayout = JSON.parse(venue.seat_layout);

    const result = await db.run(
      `INSERT INTO events (title, description, category, venue_id, organiser_id, event_date, pricing)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        description || '',
        category,
        venue_id,
        req.user.id,
        new Date(event_date).toISOString(),
        typeof pricing === 'string' ? pricing : JSON.stringify(pricing)
      ]
    );

    const eventId = result.lastID;
    const pricingObj = typeof pricing === 'string' ? JSON.parse(pricing) : pricing;

    // Auto-generate seats for this event based on venue layout
    const rowLabels = Object.keys(seatLayout);
    for (const r of rowLabels) {
      const seatCat = seatLayout[r];
      const price = pricingObj[seatCat] || 100;
      for (let s = 1; s <= venue.seats_per_row; s++) {
        const seatCode = `${r}${s}`;
        await db.run(
          `INSERT INTO event_seats (event_id, row_label, seat_number, seat_code, category, price, status)
           VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE')`,
          [eventId, r, s, seatCode, seatCat, price]
        );
      }
    }

    const newEvent = await db.get('SELECT * FROM events WHERE id = ?', [eventId]);
    newEvent.pricing = JSON.parse(newEvent.pricing);

    res.status(201).json({ message: 'Event listing created successfully', event: newEvent });
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ error: 'Failed to create event.' });
  }
});

module.exports = router;
