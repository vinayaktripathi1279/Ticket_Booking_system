const { getDB } = require('../db/database');
const { processWaitlistOnSeatRelease, expireWaitlistOffers } = require('./waitlistService');

let intervalId = null;

async function checkAndReleaseExpiredHolds() {
  try {
    const db = await getDB();
    const now = new Date().toISOString();

    // 1. Process expired regular seat holds (that are NOT part of an active waitlist offer)
    const expiredSeats = await db.all(
      `SELECT s.* FROM event_seats s
       LEFT JOIN waitlist w ON w.offered_seat_id = s.id AND w.status = 'OFFERED'
       WHERE s.status = 'HELD' 
         AND s.hold_expires_at IS NOT NULL 
         AND s.hold_expires_at < ?
         AND w.id IS NULL`,
      [now]
    );

    for (const seat of expiredSeats) {
      console.log(`Auto-releasing expired hold on seat ${seat.seat_code} (ID: ${seat.id}) for Event ${seat.event_id}`);

      // Try offering seat to next in waitlist queue
      const offerMade = await processWaitlistOnSeatRelease(seat.event_id, seat.category, seat.id);

      if (!offerMade) {
        // If no waitlist demand, make seat AVAILABLE
        await db.run(
          `UPDATE event_seats 
           SET status = 'AVAILABLE', held_by_user_id = NULL, hold_expires_at = NULL, version = version + 1
           WHERE id = ?`,
          [seat.id]
        );
      }
    }

    // 2. Process expired waitlist offers
    await expireWaitlistOffers();

  } catch (err) {
    console.error('Error in hold scheduler worker:', err);
  }
}

function startHoldScheduler(intervalMs = 5000) {
  if (intervalId) return;
  console.log(`Starting Seat Hold & Waitlist Expiry Worker (interval: ${intervalMs}ms)...`);
  intervalId = setInterval(checkAndReleaseExpiredHolds, intervalMs);
}

function stopHoldScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = {
  startHoldScheduler,
  stopHoldScheduler,
  checkAndReleaseExpiredHolds
};
