const bcrypt = require('bcryptjs');
const { getDB } = require('./database');

async function initDB() {
  const db = await getDB();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ORGANISER', 'CUSTOMER')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      total_rows INTEGER NOT NULL,
      seats_per_row INTEGER NOT NULL,
      seat_layout TEXT NOT NULL,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      venue_id INTEGER NOT NULL,
      organiser_id INTEGER NOT NULL,
      event_date DATETIME NOT NULL,
      pricing TEXT NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(venue_id) REFERENCES venues(id)
    );

    CREATE TABLE IF NOT EXISTS event_seats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      seat_code TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'AVAILABLE',
      held_by_user_id INTEGER,
      hold_expires_at DATETIME,
      booking_id INTEGER,
      version INTEGER DEFAULT 0,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_reference TEXT UNIQUE NOT NULL,
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      seat_ids TEXT NOT NULL,
      seat_codes TEXT NOT NULL,
      seat_category TEXT NOT NULL,
      total_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      qr_code_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(event_id) REFERENCES events(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      seat_category TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'WAITING',
      offer_token TEXT UNIQUE,
      offered_seat_id INTEGER,
      offer_expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(event_id) REFERENCES events(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS outbox_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      to_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      type TEXT NOT NULL,
      content_html TEXT NOT NULL,
      qr_code_base64 TEXT,
      status TEXT DEFAULT 'SENT',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Check if users exist, if not seed initial demo data
  const userCount = await db.get('SELECT COUNT(*) as count FROM users');
  if (userCount.count === 0) {
    console.log('Seeding initial database content...');
    const hashedPass = await bcrypt.hash('password123', 10);

    // Seed default users
    const adminRes = await db.run(
      `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
      ['System Admin', 'admin@ticketapp.com', hashedPass, 'ADMIN']
    );
    const organiserRes = await db.run(
      `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
      ['PVR Cinemas Organiser', 'organiser@pvr.com', hashedPass, 'ORGANISER']
    );
    const customer1 = await db.run(
      `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
      ['Alice Smith', 'alice@gmail.com', hashedPass, 'CUSTOMER']
    );
    const customer2 = await db.run(
      `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
      ['Bob Jones', 'bob@gmail.com', hashedPass, 'CUSTOMER']
    );
    const customer3 = await db.run(
      `INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
      ['Charlie Brown', 'charlie@gmail.com', hashedPass, 'CUSTOMER']
    );

    // Seed Venue: Grand IMAX Theatre (4 rows, 6 seats per row = 24 seats)
    const venueLayout = {
      'A': 'Premium',
      'B': 'Premium',
      'C': 'Standard',
      'D': 'Standard'
    };
    const venueRes = await db.run(
      `INSERT INTO venues (name, address, total_rows, seats_per_row, seat_layout, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['Grand IMAX Auditorium', 'Downtown Tech Park, Sector 5', 4, 6, JSON.stringify(venueLayout), adminRes.lastID]
    );

    // Seed Event 1: Avengers: Secret Wars (Movie)
    const eventDate = new Date(Date.now() + 86400000 * 3).toISOString(); // 3 days from now
    const pricing = { 'Premium': 300, 'Standard': 180 };
    const eventRes = await db.run(
      `INSERT INTO events (title, description, category, venue_id, organiser_id, event_date, pricing, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'Avengers: Secret Wars (IMAX 3D)',
        'Experience the ultimate multiversal climax on the grandest screen.',
        'Movie',
        venueRes.lastID,
        organiserRes.lastID,
        eventDate,
        JSON.stringify(pricing),
        'ACTIVE'
      ]
    );

    // Generate seats for Event 1
    const rows = ['A', 'B', 'C', 'D'];
    for (const r of rows) {
      const cat = venueLayout[r];
      const price = pricing[cat];
      for (let s = 1; s <= 6; s++) {
        const seatCode = `${r}${s}`;
        await db.run(
          `INSERT INTO event_seats (event_id, row_label, seat_number, seat_code, category, price, status)
           VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE')`,
          [eventRes.lastID, r, s, seatCode, cat, price]
        );
      }
    }

    // Seed Event 2: Coldplay Music Concert (Concert)
    const concertDate = new Date(Date.now() + 86400000 * 7).toISOString();
    const concertPricing = { 'Premium': 1200, 'Standard': 600 };
    const concertRes = await db.run(
      `INSERT INTO events (title, description, category, venue_id, organiser_id, event_date, pricing, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'Coldplay: Music of the Spheres World Tour',
        'Live stadium concert featuring iconic laser lights and synth melodies.',
        'Concert',
        venueRes.lastID,
        organiserRes.lastID,
        concertDate,
        JSON.stringify(concertPricing),
        'ACTIVE'
      ]
    );

    for (const r of rows) {
      const cat = venueLayout[r];
      const price = concertPricing[cat];
      for (let s = 1; s <= 6; s++) {
        const seatCode = `${r}${s}`;
        await db.run(
          `INSERT INTO event_seats (event_id, row_label, seat_number, seat_code, category, price, status)
           VALUES (?, ?, ?, ?, ?, ?, 'AVAILABLE')`,
          [concertRes.lastID, r, s, seatCode, cat, price]
        );
      }
    }

    console.log('Database initialized and seeded successfully.');
  }
}

module.exports = { initDB };
