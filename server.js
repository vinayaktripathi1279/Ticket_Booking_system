require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDB } = require('./src/db/init');
const { startHoldScheduler } = require('./src/services/holdScheduler');

const authRoutes = require('./src/routes/authRoutes');
const venueRoutes = require('./src/routes/venueRoutes');
const eventRoutes = require('./src/routes/eventRoutes');
const bookingRoutes = require('./src/routes/bookingRoutes');
const waitlistRoutes = require('./src/routes/waitlistRoutes');
const organiserRoutes = require('./src/routes/organiserRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend UI
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/venues', venueRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/seats', bookingRoutes); // Handles /api/seats/hold & release-hold
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/organiser', organiserRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', system: 'Unthinkale Ticket Booking Platform', timestamp: new Date().toISOString() });
});

// Fallback to index.html for single-page application routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server & Background Services
async function bootstrap() {
  try {
    console.log('Initializing database schema and seed data...');
    await initDB();

    console.log('Starting background background seat hold & waitlist release worker...');
    startHoldScheduler(5000); // Polls every 5 seconds for hold TTL auto-release

    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`🎟️ Ticket Booking System running at http://localhost:${PORT}`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
}

bootstrap();
