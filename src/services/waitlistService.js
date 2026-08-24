const crypto = require('crypto');
const { getDB } = require('../db/database');
const { sendWaitlistOfferEmail } = require('./qrEmailService');

const OFFER_TTL_MINUTES = parseInt(process.env.OFFER_TTL_MINUTES || '5');

/**
 * Triggered whenever a seat becomes available (via booking cancellation or hold release)
 * Checks if there is a customer on the waitlist for that event and seat category.
 * If yes, holds the seat exclusively for them and issues a time-limited offer token.
 * 
 * @param {number} eventId 
 * @param {string} seatCategory 
 * @param {number} seatId 
 */
async function processWaitlistOnSeatRelease(eventId, seatCategory, seatId) {
  const db = await getDB();

  // Find next waiting customer in FIFO order
  const waitlistEntry = await db.get(
    `SELECT w.*, u.email, u.name 
     FROM waitlist w
     JOIN users u ON w.user_id = u.id
     WHERE w.event_id = ? AND w.seat_category = ? AND w.status = 'WAITING'
     ORDER BY w.created_at ASC
     LIMIT 1`,
    [eventId, seatCategory]
  );

  if (!waitlistEntry) {
    // No waitlisted users, set seat back to AVAILABLE
    if (seatId) {
      await db.run(
        `UPDATE event_seats 
         SET status = 'AVAILABLE', held_by_user_id = NULL, hold_expires_at = NULL, version = version + 1
         WHERE id = ?`,
        [seatId]
      );
    }
    return null;
  }

  // Fetch event details for email
  const event = await db.get(`SELECT title FROM events WHERE id = ?`, [eventId]);

  const offerToken = `OFFER-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const offerExpiresAt = new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000).toISOString();

  // Hold the specific seat for this waitlisted user
  if (seatId) {
    await db.run(
      `UPDATE event_seats 
       SET status = 'HELD', held_by_user_id = ?, hold_expires_at = ?, version = version + 1
       WHERE id = ?`,
      [waitlistEntry.user_id, offerExpiresAt, seatId]
    );
  }

  // Update waitlist entry
  await db.run(
    `UPDATE waitlist
     SET status = 'OFFERED', offer_token = ?, offered_seat_id = ?, offer_expires_at = ?
     WHERE id = ?`,
    [offerToken, seatId, offerExpiresAt, waitlistEntry.id]
  );

  // Send waitlist email notification
  await sendWaitlistOfferEmail(
    waitlistEntry.email,
    waitlistEntry.name,
    event.title,
    seatCategory,
    offerToken,
    offerExpiresAt
  );

  console.log(`Waitlist offer ${offerToken} sent to user ${waitlistEntry.email} for seat ${seatId}`);
  return offerToken;
}

/**
 * Checks for expired waitlist offers and rolls them over to the next person in line.
 */
async function expireWaitlistOffers() {
  const db = await getDB();
  const now = new Date().toISOString();

  const expiredOffers = await db.all(
    `SELECT * FROM waitlist 
     WHERE status = 'OFFERED' AND offer_expires_at < ?`,
    [now]
  );

  for (const offer of expiredOffers) {
    console.log(`Expiring waitlist offer ${offer.offer_token} for user ${offer.user_id}`);

    // Mark offer as EXPIRED
    await db.run(`UPDATE waitlist SET status = 'EXPIRED' WHERE id = ?`, [offer.id]);

    // Check if the offered seat is still HELD by this user
    if (offer.offered_seat_id) {
      const seat = await db.get(
        `SELECT * FROM event_seats WHERE id = ? AND status = 'HELD' AND held_by_user_id = ?`,
        [offer.offered_seat_id, offer.user_id]
      );

      if (seat) {
        // Seat is still held by expired user, roll it over to the next waitlisted customer
        await processWaitlistOnSeatRelease(offer.event_id, offer.seat_category, offer.offered_seat_id);
      }
    }
  }
}

module.exports = {
  processWaitlistOnSeatRelease,
  expireWaitlistOffers
};
