const express = require('express');
const router = express.Router();
const { getDB } = require('../db/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// GET all venues
router.get('/', async (req, res) => {
  try {
    const db = await getDB();
    const venues = await db.all('SELECT * FROM venues ORDER BY created_at DESC');
    const parsed = venues.map(v => ({
      ...v,
      seat_layout: JSON.parse(v.seat_layout)
    }));
    res.json({ venues: parsed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch venues.' });
  }
});

// GET single venue by ID
router.get('/:id', async (req, res) => {
  try {
    const db = await getDB();
    const venue = await db.get('SELECT * FROM venues WHERE id = ?', [req.params.id]);
    if (!venue) {
      return res.status(404).json({ error: 'Venue not found.' });
    }
    venue.seat_layout = JSON.parse(venue.seat_layout);
    res.json({ venue });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch venue details.' });
  }
});

// POST create venue (Admin only)
router.post('/', authenticateToken, requireRole(['ADMIN']), async (req, res) => {
  try {
    const { name, address, total_rows, seats_per_row, seat_layout } = req.body;

    if (!name || !address || !total_rows || !seats_per_row || !seat_layout) {
      return res.status(400).json({ error: 'Name, address, total_rows, seats_per_row, and seat_layout are required.' });
    }

    const db = await getDB();
    const result = await db.run(
      `INSERT INTO venues (name, address, total_rows, seats_per_row, seat_layout, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, address, total_rows, seats_per_row, typeof seat_layout === 'string' ? seat_layout : JSON.stringify(seat_layout), req.user.id]
    );

    const newVenue = await db.get('SELECT * FROM venues WHERE id = ?', [result.lastID]);
    newVenue.seat_layout = JSON.parse(newVenue.seat_layout);

    res.status(201).json({ message: 'Venue created successfully', venue: newVenue });
  } catch (err) {
    console.error('Create venue error:', err);
    res.status(500).json({ error: 'Failed to create venue.' });
  }
});

module.exports = router;
