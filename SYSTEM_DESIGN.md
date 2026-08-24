# System Design Document: Ticket Booking Platform

## Overview
This document outlines the architecture, data models, concurrency controls, TTL seat hold mechanisms, and waitlist auto-assignment flows for the Unthinkale High-Concurrency Ticket Booking System.

---

## 1. Seat Hold and TTL Auto-Release Mechanism

To handle high-demand movie premieres and concert ticket releases, seats are not booked immediately upon selection. Instead, an intermediary **Seat Hold** phase is introduced.

### Lifecycle of a Seat Hold:
1. **Hold Request**: When a customer selects seats on the interactive visual seat grid, the system issues a hold with a configurable TTL (Time-To-Live, default 10 minutes).
2. **Database State**: The target seats transition from `AVAILABLE` to `HELD`, with `held_by_user_id` bound to the requesting account and `hold_expires_at` set to `NOW() + TTL`.
3. **Checkout Abandonment & Auto-Release**: If the customer abandons checkout, closes their browser, or fails to confirm payment before `hold_expires_at`, a background scheduler worker running at 5-second intervals identifies expired holds (`hold_expires_at < NOW()`).
4. **Release or Reallocation**: The worker atomically clears the hold. If waitlisted demand exists for that seat's category, the seat is directly routed to the next customer in the waitlist queue; otherwise, it is reset to `AVAILABLE`.

```
[AVAILABLE] ──(Customer Hold)──> [HELD (TTL: 10m)] ──(Checkout Success)──> [BOOKED]
     ▲                                 │
     │                           (TTL Expired /
     └───────(No Waitlist)─────── Cancelled) ───(Waitlist Exists)──> [WAITLIST OFFER (TTL: 5m)]
```

---

## 2. Concurrency Protection & Race Condition Prevention

In high-concurrency ticket sales, thousands of users may click the same popular seat simultaneously. Preventing double-booking or duplicate holds is guaranteed via multi-layer concurrency protection.

### Implementation Architecture:
1. **Fine-Grained In-Memory Key Locking**: Before executing any database transaction for seat holds or bookings, the backend acquires exclusive locks for target seat keys (e.g. `event_{id}_seat_{seatId}`).
2. **Atomic Lock Acquisition**: If two requests attempt to hold or book the exact same seat simultaneously, the `ConcurrencyLock` service grants the lock to the first request and immediately rejects the second request with HTTP `409 Conflict` ("Seat currently being processed by another transaction").
3. **Database Versioning / Optimistic Concurrency**: Every row in `event_seats` maintains an incremental `version` counter. State mutations require `version = expected_version`, preventing stale state overwrites.

---

## 3. Waitlist Auto-Assignment & Time-Limited Offer Flow

When an event category (e.g., Premium or Standard) sells out, customers can join a First-In, First-Out (FIFO) waitlist queue.

### Automated Reallocation Workflow:
1. **Trigger Event**: A booking is cancelled by a customer or a seat hold expires.
2. **Queue Lookup**: The system queries the `waitlist` table for the earliest entry matching the `event_id` and `seat_category` with status `WAITING`.
3. **Time-Limited Offer Generation**:
   - The waitlist status is updated to `OFFERED`.
   - A unique, cryptographically secure `offer_token` is generated.
   - The released seat is placed on exclusive hold for the waitlisted customer with an offer TTL (default 5 minutes).
4. **Notification**: The system dispatches an email containing a time-limited claim link (`/#offerToken=...`).
5. **Rollover Handling**: If the waitlisted customer does not claim the offer before `offer_expires_at`, the scheduler marks the offer `EXPIRED` and automatically rolls the seat offer over to the next customer in line.

---

## 4. Seat Map Data Model & Real-Time Status Updates

### Relational Schema (SQLite):
- **`venues`**: Stores seating dimensions (`total_rows`, `seats_per_row`) and row-category layouts (e.g. `{"Row A": "Premium", "Row C": "Standard"}`).
- **`events`**: Maps listings to venues, dates, and per-category pricing.
- **`event_seats`**: Per-show seat state tracking (`row_label`, `seat_number`, `category`, `price`, `status`, `held_by_user_id`, `hold_expires_at`, `booking_id`).
- **`bookings`**: Confirmed purchases storing unique `booking_reference`, total amount, and Base64-encoded QR code ticket data.

### Real-Time Synchronization:
The frontend polls seat status at 3-second intervals and listens for active hold updates, keeping visual seat map colors synchronized in real time across multiple concurrent browser windows.

---

## 5. QR Code Generation & Verification

Upon booking confirmation:
1. The backend encodes the unique `booking_reference` into a high-density Base64 PNG QR Code using the `qrcode` library.
2. The QR Code is embedded in the confirmation email dispatched via `Nodemailer` and logged to the in-app Outbox Email Inspector for instant auditing.
3. Gate inspectors scan the QR code to instantly query `/api/bookings` and validate ticket authenticity.
