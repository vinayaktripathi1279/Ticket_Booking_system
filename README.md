# 🎟️ High-Concurrency Ticket Booking System

A full-stack movie and concert ticket booking platform with interactive visual seat maps, TTL seat hold auto-release, concurrency race condition prevention, waitlist auto-assignment on cancellation, and email ticket delivery with QR codes.

---

## 🌟 Key Features

1. **Role-Based Access Control (RBAC)**:
   - **Customer**: Browse events, view live visual seat maps, place temporary seat holds, confirm bookings, receive email tickets with QR codes, view booking history, cancel bookings, join waitlists.
   - **Organiser**: Create event listings with per-category pricing (Premium, Standard), view revenue summary, ticket booking analytics, and waitlist queue metrics per event.
   - **Admin**: Create and manage venues with customizable seating layouts (rows and seats per row).

2. **Seat Hold with Configurable TTL**:
   - Holds seats temporarily (e.g. 10 minutes) while customer is checking out.
   - Background worker polls every 5 seconds and automatically releases expired holds back to the available pool or waitlist queue if checkout is abandoned.

3. **Concurrency Locking Protection**:
   - In-memory fine-grained key locking (`ConcurrencyLock`) prevents simultaneous requests for the exact same seat from double-booking or placing duplicate holds.

4. **Automated Waitlist & Time-Limited Offer Flow**:
   - When an event category is sold out, customers can join a FIFO waitlist.
   - When a booking or hold is cancelled, the system automatically assigns the seat to the next customer on the waitlist, issues a time-limited offer token (e.g. 5 minutes), and sends an email notification with a claim link.
   - If the offer expires without being claimed, it automatically rolls over to the next waitlisted customer in line.

5. **QR Code Ticket Generation & Email Service**:
   - Encodes unique booking references into high-resolution Base64 QR code images.
   - Sends HTML confirmation emails with inline QR code tickets via `Nodemailer`.
   - Includes an in-app **Email Outbox Inspector** tab to view simulated outbound emails and QR tickets directly in the browser without configuring SMTP software.

---

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher

### Installation & Launch

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Environment Setup**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

3. **Run Automated Test Suite**:
   ```bash
   npm test
   ```

4. **Start Application Server**:
   ```bash
   npm start
   ```

5. **Access Application**:
   Open browser at: [http://localhost:3000](http://localhost:3000)

---

## 👤 Demo Accounts (Pre-configured)

Use the **Quick Switch Role** buttons in the header to instantly switch between accounts:

| Role | Name | Email | Password |
|---|---|---|---|
| **Customer** | Alice Smith | `alice@gmail.com` | `password123` |
| **Customer** | Bob Jones | `bob@gmail.com` | `password123` |
| **Customer** | Charlie Brown | `charlie@gmail.com` | `password123` |
| **Organiser** | PVR Cinemas | `organiser@pvr.com` | `password123` |
| **Admin** | System Admin | `admin@ticketapp.com` | `password123` |

---

## 🛠️ REST API Reference

### Authentication
- `POST /api/auth/register` - Register new user account.
- `POST /api/auth/login` - Login and obtain JWT token.
- `GET /api/auth/me` - Get current authenticated user profile.

### Venues & Events
- `GET /api/venues` - List all venues (Admin).
- `POST /api/venues` - Create venue and seat layout (Admin).
- `GET /api/events` - List active events with availability breakdown (Filter by category/search).
- `GET /api/events/:id` - Get event details.
- `GET /api/events/:id/seats` - Fetch full visual seat grid with real-time seat statuses.
- `POST /api/events` - Create event listing and auto-generate seat map (Organiser/Admin).

### Seat Holds & Bookings
- `POST /api/seats/hold` - Place temporary TTL hold on selected seats (Protected by concurrency lock).
- `POST /api/seats/release-hold` - Release seat hold on checkout abandonment.
- `POST /api/bookings/confirm` - Confirm booking, generate QR ticket code, and send email.
- `POST /api/bookings/cancel` - Cancel booking and trigger waitlist auto-assignment.
- `GET /api/bookings/my-bookings` - Fetch user's booking history with QR code tickets.

### Waitlist
- `POST /api/waitlist/join` - Join waitlist for sold-out seat category.
- `GET /api/waitlist/my-waitlist` - View user's waitlist status and active seat offers.
- `GET /api/waitlist/offer/:token` - Validate waitlist claim token.

### Organiser & Inspection
- `GET /api/organiser/summary` - Organiser revenue analytics, ticket breakdown, and waitlist demand.
- `GET /api/organiser/outbox-emails` - Inspect generated outbound emails and embedded QR code tickets.

---

## 📁 Project Structure

```
.
├── server.js                   # Express server entry point & scheduler bootstrap
├── package.json                # Dependencies & scripts
├── .env.example                # Sample environment variables
├── SYSTEM_DESIGN.md            # System design write-up (800 words max)
├── test/
│   └── test-suite.js           # Automated integration test suite
├── src/
│   ├── db/
│   │   ├── database.js         # SQLite database connection module
│   │   └── init.js             # Database tables creation & seeding script
│   ├── middleware/
│   │   └── auth.js             # JWT authentication & RBAC middleware
│   ├── services/
│   │   ├── concurrencyLock.js  # Fine-grained in-memory key locking engine
│   │   ├── holdScheduler.js    # Background worker for TTL seat hold auto-release
│   │   ├── waitlistService.js  # FIFO waitlist queue auto-assignment logic
│   │   └── qrEmailService.js   # Base64 QR Code generator & Nodemailer email handler
│   └── routes/
│       ├── authRoutes.js       # Auth API endpoints
│       ├── venueRoutes.js      # Venue management endpoints
│       ├── eventRoutes.js      # Event listings & seat map endpoints
│       ├── bookingRoutes.js    # Seat hold, checkout & cancellation endpoints
│       ├── waitlistRoutes.js   # Waitlist queue endpoints
│       └── organiserRoutes.js  # Organiser revenue & email inspector endpoints
└── public/                     # Frontend Single Page Application
    ├── index.html              # HTML structure with modals & tabs
    ├── css/styles.css          # Glassmorphism dark-mode UI stylesheet
    └── js/app.js               # Client state, visual seat map, timer & API client
```
