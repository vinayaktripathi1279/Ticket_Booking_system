const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { getDB } = require('../db/database');

// Create test transporter or configure custom SMTP if available
let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  } else {
    // Fallback Ethereal fake SMTP account for local testing
    try {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
    } catch (err) {
      console.warn('Ethereal setup failed, using mock logger transporter');
      transporter = {
        sendMail: async (mailOptions) => ({ messageId: 'mock-mail-id' })
      };
    }
  }
  return transporter;
}

/**
 * Generates Base64 Data URL for QR Code string
 * @param {string} text 
 */
async function generateQRCode(text) {
  try {
    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 250,
      color: {
        dark: '#1e293b',
        light: '#ffffff'
      }
    });
    return dataUrl;
  } catch (err) {
    console.error('Error generating QR Code:', err);
    throw err;
  }
}

/**
 * Sends booking confirmation email containing QR Code ticket
 */
async function sendBookingConfirmationEmail(userEmail, userName, booking) {
  const db = await getDB();
  const qrDataUrl = await generateQRCode(booking.booking_reference);

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px; max-width: 600px; margin: auto;">
      <h2 style="color: #38bdf8; margin-top: 0;">🎟️ Booking Confirmed!</h2>
      <p>Hello <strong>${userName}</strong>,</p>
      <p>Your ticket purchase for <strong>${booking.event_title}</strong> was successful!</p>
      
      <div style="background-color: #1e293b; border: 1px solid #334155; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 4px 0;"><strong>Booking Ref:</strong> <span style="color: #f59e0b; font-family: monospace; font-size: 16px;">${booking.booking_reference}</span></p>
        <p style="margin: 4px 0;"><strong>Seats:</strong> ${booking.seat_codes.join(', ')} (${booking.seat_category})</p>
        <p style="margin: 4px 0;"><strong>Total Paid:</strong> $${booking.total_amount}</p>
        <p style="margin: 4px 0;"><strong>Venue:</strong> ${booking.venue_name}</p>
        <p style="margin: 4px 0;"><strong>Show Date:</strong> ${new Date(booking.event_date).toLocaleString()}</p>
      </div>

      <div style="text-align: center; margin: 24px 0;">
        <p style="margin-bottom: 8px;">Scan this QR code at venue entry:</p>
        <img src="${qrDataUrl}" alt="Ticket QR Code" style="border: 4px solid #ffffff; border-radius: 8px;" />
      </div>
      
      <p style="font-size: 12px; color: #94a3b8;">Thank you for booking with Unthinkale Tickets!</p>
    </div>
  `;

  // Log to outbox table for UI inspection
  await db.run(
    `INSERT INTO outbox_emails (to_email, subject, type, content_html, qr_code_base64)
     VALUES (?, ?, ?, ?, ?)`,
    [userEmail, `Booking Confirmed: ${booking.booking_reference}`, 'BOOKING_CONFIRMATION', htmlContent, qrDataUrl]
  );

  // Send via Nodemailer
  try {
    const t = await getTransporter();
    await t.sendMail({
      from: process.env.FROM_EMAIL || '"Unthinkale Tickets" <no-reply@unthinkaletickets.com>',
      to: userEmail,
      subject: `Booking Confirmed: ${booking.booking_reference} - ${booking.event_title}`,
      html: htmlContent
    });
  } catch (err) {
    console.error('Failed sending SMTP email:', err.message);
  }

  return qrDataUrl;
}

/**
 * Sends Waitlist Offer Email to next user in queue when a seat opens up
 */
async function sendWaitlistOfferEmail(userEmail, userName, eventTitle, seatCategory, offerToken, expiresAt) {
  const db = await getDB();
  const claimUrl = `http://localhost:${process.env.PORT || 3000}/#offerToken=${offerToken}`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px; max-width: 600px; margin: auto;">
      <h2 style="color: #10b981; margin-top: 0;">⚡ Good News! Seat Available for ${eventTitle}</h2>
      <p>Hello <strong>${userName}</strong>,</p>
      <p>A cancelled seat in your waitlisted category (<strong>${seatCategory}</strong>) has just opened up!</p>

      <div style="background-color: #1e293b; border: 1px dashed #10b981; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 4px 0;"><strong>Offer Expiration:</strong> <span style="color: #ef4444; font-weight: bold;">${new Date(expiresAt).toLocaleTimeString()}</span></p>
        <p style="margin: 4px 0; font-size: 13px; color: #cbd5e1;">You have <strong>5 minutes</strong> to claim this seat before it rolls over to the next waitlisted customer.</p>
      </div>

      <div style="text-align: center; margin: 24px 0;">
        <a href="${claimUrl}" style="background-color: #10b981; color: #ffffff; text-decoration: none; font-weight: bold; padding: 12px 24px; border-radius: 8px; display: inline-block;">Claim Your Ticket Now</a>
      </div>

      <p style="font-size: 12px; color: #94a3b8;">If you do not complete booking before expiration, the offer will pass to the next person on the list.</p>
    </div>
  `;

  await db.run(
    `INSERT INTO outbox_emails (to_email, subject, type, content_html, qr_code_base64)
     VALUES (?, ?, ?, ?, ?)`,
    [userEmail, `Waitlist Offer: Seat available for ${eventTitle}!`, 'WAITLIST_OFFER', htmlContent, null]
  );

  try {
    const t = await getTransporter();
    await t.sendMail({
      from: process.env.FROM_EMAIL || '"Unthinkale Tickets" <no-reply@unthinkaletickets.com>',
      to: userEmail,
      subject: `⚡ Waitlist Offer: Seat available for ${eventTitle}!`,
      html: htmlContent
    });
  } catch (err) {
    console.error('Failed sending SMTP waitlist offer email:', err.message);
  }
}

module.exports = {
  generateQRCode,
  sendBookingConfirmationEmail,
  sendWaitlistOfferEmail
};
