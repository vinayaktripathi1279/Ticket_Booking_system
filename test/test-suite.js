const assert = require('assert');
const { initDB } = require('../src/db/init');
const { getDB } = require('../src/db/database');
const lockManager = require('../src/services/concurrencyLock');
const { processWaitlistOnSeatRelease, expireWaitlistOffers } = require('../src/services/waitlistService');
const { generateQRCode } = require('../src/services/qrEmailService');

async function runTestSuite() {
  console.log('🧪 Starting Ticket Booking Platform Automated Verification Test Suite...\n');

  try {
    // 1. Database Initialization
    await initDB();
    const db = await getDB();
    console.log('✅ 1. Database initialized & schema verified.');

    // 2. Concurrency Lock Test
    console.log('⏳ 2. Testing Concurrency Lock Protection for simultaneous seat requests...');
    const testKeys = ['event_1_seat_1'];
    
    // Acquire lock first time
    const lock1 = lockManager.acquireLocks(testKeys);
    assert.strictEqual(lock1, true, 'First lock acquisition must succeed.');

    // Attempt second simultaneous lock for the same seat
    const lock2 = lockManager.acquireLocks(testKeys);
    assert.strictEqual(lock2, false, 'Simultaneous second lock acquisition must be rejected.');

    // Release lock
    lockManager.releaseLocks(testKeys);
    const lock3 = lockManager.acquireLocks(testKeys);
    assert.strictEqual(lock3, true, 'Lock re-acquisition after release must succeed.');
    lockManager.releaseLocks(testKeys);
    console.log('✅ 2. Concurrency Lock Protection VERIFIED.');

    // 3. QR Code Generation Test
    console.log('⏳ 3. Testing QR Code Generation for booking reference...');
    const bookingRef = 'REF-TEST-998877';
    const qrDataUrl = await generateQRCode(bookingRef);
    assert.ok(qrDataUrl.startsWith('data:image/png;base64,'), 'QR Code output must be valid PNG Base64 Data URL.');
    console.log('✅ 3. QR Code Ticket Generator VERIFIED.');

    // 4. Waitlist Auto-Assignment Test
    console.log('⏳ 4. Testing Waitlist Auto-Assignment on Booking Cancellation...');
    
    // Insert test waitlist entry for User 3 (Charlie) for Event 1 (Avengers), Category 'Premium'
    const event = await db.get('SELECT id FROM events LIMIT 1');
    const user = await db.get("SELECT id FROM users WHERE email = 'charlie@gmail.com'");

    await db.run(
      `INSERT INTO waitlist (event_id, seat_category, user_id, status) VALUES (?, 'Premium', ?, 'WAITING')`,
      [event.id, user.id]
    );

    // Get an available seat
    const seat = await db.get("SELECT * FROM event_seats WHERE event_id = ? AND category = 'Premium' LIMIT 1", [event.id]);

    // Trigger seat cancellation release
    const offerToken = await processWaitlistOnSeatRelease(event.id, 'Premium', seat.id);
    assert.ok(offerToken && offerToken.startsWith('OFFER-'), 'Waitlist release must produce an active offer token for the next customer in line.');

    const updatedSeat = await db.get('SELECT * FROM event_seats WHERE id = ?', [seat.id]);
    assert.strictEqual(updatedSeat.status, 'HELD', 'Released seat must be held for waitlisted customer.');
    assert.strictEqual(updatedSeat.held_by_user_id, user.id, 'Seat must be assigned to waitlisted user ID.');

    console.log('✅ 4. Waitlist Auto-Assignment Flow VERIFIED.');

    console.log('\n🎉 ALL AUTOMATED VERIFICATION TESTS PASSED SUCCESSFULLY!\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test Suite Failed:', err);
    process.exit(1);
  }
}

runTestSuite();
