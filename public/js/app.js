// Application State
const state = {
  token: localStorage.getItem('jwt_token') || '',
  user: JSON.parse(localStorage.getItem('user_info') || 'null'),
  events: [],
  selectedEvent: null,
  selectedSeatIds: [],
  activeSeats: [],
  heldExpiresAt: null,
  holdTimerInterval: null,
  activeWaitlistOffer: null
};

// API Base Request Helper
async function apiRequest(endpoint, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(endpoint, opts);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'API Request failed');
  }
  return data;
}

// Initialization
document.addEventListener('DOMContentLoaded', async () => {
  if (!state.token) {
    await quickLogin('alice@gmail.com');
  } else {
    updateUserHeader();
  }

  await loadEvents();
  setupPolling();

  // Check URL hash for waitlist offer token e.g. #offerToken=OFFER-XXXX
  checkOfferTokenFromUrl();
});

// Real-time polling for seat updates every 3 seconds
function setupPolling() {
  setInterval(async () => {
    if (document.getElementById('sec-seat-map').classList.contains('active') && state.selectedEvent) {
      await fetchSeats(state.selectedEvent.id, false);
    }
  }, 3000);
}

// User Profile & Header Update
function updateUserHeader() {
  const nameEl = document.getElementById('user-name-display');
  const roleEl = document.getElementById('user-role-pill');

  if (state.user) {
    nameEl.textContent = state.user.name;
    roleEl.textContent = state.user.role;
    roleEl.className = `role-pill role-${state.user.role}`;

    // Show/hide role-specific nav tabs
    document.getElementById('nav-organiser').style.display = ['ORGANISER', 'ADMIN'].includes(state.user.role) ? 'inline-block' : 'none';
    document.getElementById('nav-admin').style.display = state.user.role === 'ADMIN' ? 'inline-block' : 'none';
  }
}

// Quick Switch Role Helper
async function quickLogin(email) {
  try {
    const res = await apiRequest('/api/auth/login', 'POST', { email, password: 'password123' });
    state.token = res.token;
    state.user = res.user;
    localStorage.setItem('jwt_token', res.token);
    localStorage.setItem('user_info', JSON.stringify(res.user));

    updateUserHeader();
    await loadEvents();
    if (document.getElementById('sec-my-bookings').classList.contains('active')) loadMyBookings();
    if (document.getElementById('sec-waitlist').classList.contains('active')) loadWaitlist();
    if (document.getElementById('sec-organiser').classList.contains('active')) loadOrganiserSummary();
  } catch (err) {
    alert(`Quick login failed: ${err.message}`);
  }
}

// Navigation Tab Switcher
function switchTab(tabName) {
  document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const secMap = {
    'events': 'sec-events',
    'seat-map': 'sec-seat-map',
    'my-bookings': 'sec-my-bookings',
    'waitlist': 'sec-waitlist',
    'organiser': 'sec-organiser',
    'admin': 'sec-admin',
    'outbox': 'sec-outbox'
  };

  const targetSec = document.getElementById(secMap[tabName]);
  if (targetSec) targetSec.classList.add('active');

  // Trigger data reload for specific tabs
  if (tabName === 'my-bookings') loadMyBookings();
  if (tabName === 'waitlist') loadWaitlist();
  if (tabName === 'organiser') loadOrganiserSummary();
  if (tabName === 'admin') loadVenuesForDropdown();
  if (tabName === 'outbox') loadOutboxEmails();
}

// 1. Load Events
async function loadEvents(categoryFilter = '') {
  try {
    let url = '/api/events';
    if (categoryFilter) url += `?category=${categoryFilter}`;
    const res = await apiRequest(url);
    state.events = res.events;
    renderEventsGrid();
  } catch (err) {
    console.error('Failed to load events:', err);
  }
}

function filterEvents(cat) {
  loadEvents(cat);
}

function renderEventsGrid() {
  const container = document.getElementById('events-list');
  container.innerHTML = '';

  if (state.events.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No events found matching filter.</p>';
    return;
  }

  state.events.forEach(ev => {
    const card = document.createElement('div');
    card.className = 'glass-panel event-card';

    const dateStr = new Date(ev.event_date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const badgeClass = ev.category.toLowerCase() === 'movie' ? 'badge-movie' : 'badge-concert';

    // Pricing HTML
    let pricingHtml = '';
    for (const [cat, price] of Object.entries(ev.pricing)) {
      const avail = ev.availability[cat] ? ev.availability[cat].available : 0;
      const isSoldOut = avail === 0;

      pricingHtml += `
        <div class="category-price-row">
          <div>
            <strong>${cat}</strong>: $${price}
            <span style="font-size: 11px; margin-left: 6px; color: ${isSoldOut ? '#f43f5e' : '#34d399'};">
              (${avail} seats left)
            </span>
          </div>
          ${isSoldOut ? `
            <button class="btn-danger" onclick="openJoinWaitlistModal(${ev.id}, '${cat}')">Join Waitlist</button>
          ` : ''}
        </div>
      `;
    }

    card.innerHTML = `
      <div>
        <span class="event-badge ${badgeClass}">${ev.category}</span>
        <h3 class="event-title">${ev.title}</h3>
        <div class="event-meta">
          <span>📍 ${ev.venue_name} (${ev.venue_address})</span>
          <span>📅 ${dateStr}</span>
          <span>👤 Organiser: ${ev.organiser_name}</span>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">${ev.description || ''}</p>
        
        <div style="margin-bottom: 16px;">
          ${pricingHtml}
        </div>
      </div>

      <button class="btn-primary" onclick="openSeatMap(${ev.id})">💺 View Visual Seat Map</button>
    `;

    container.appendChild(card);
  });
}

// 2. Visual Seat Map Engine
async function openSeatMap(eventId) {
  const ev = state.events.find(e => e.id === eventId);
  if (!ev) {
    const res = await apiRequest(`/api/events/${eventId}`);
    state.selectedEvent = res.event;
  } else {
    state.selectedEvent = ev;
  }

  document.getElementById('seat-map-event-title').textContent = state.selectedEvent.title;
  document.getElementById('seat-map-event-meta').textContent = `${state.selectedEvent.venue_name} • ${new Date(state.selectedEvent.event_date).toLocaleString()}`;

  state.selectedSeatIds = [];
  updateCartUI();

  await fetchSeats(eventId, true);
  switchTab('seat-map');
}

async function fetchSeats(eventId, preserveSelection = false) {
  try {
    const res = await apiRequest(`/api/events/${eventId}/seats`);
    state.activeSeats = res.seats;

    if (!preserveSelection) {
      state.selectedSeatIds = [];
    }

    renderSeatGrid();
  } catch (err) {
    console.error('Failed to fetch seats:', err);
  }
}

function renderSeatGrid() {
  const container = document.getElementById('seat-grid-target');
  container.innerHTML = '';

  // Group seats by row_label
  const rowsMap = {};
  state.activeSeats.forEach(s => {
    if (!rowsMap[s.row_label]) rowsMap[s.row_label] = [];
    rowsMap[s.row_label].push(s);
  });

  // Check if current user has any HELD seats
  let myHeldExpiresAt = null;

  Object.keys(rowsMap).sort().forEach(rowLabel => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'seat-row';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'row-label';
    labelSpan.textContent = rowLabel;
    rowDiv.appendChild(labelSpan);

    rowsMap[rowLabel].sort((a,b) => a.seat_number - b.seat_number).forEach(seat => {
      const btn = document.createElement('button');
      btn.className = `seat-btn category-${seat.category} ${seat.status}`;

      if (seat.status === 'HELD' && seat.held_by_user_id === state.user.id) {
        btn.classList.add('MINE');
        if (seat.hold_expires_at) myHeldExpiresAt = seat.hold_expires_at;
      }

      if (state.selectedSeatIds.includes(seat.id)) {
        btn.classList.add('SELECTED');
      }

      btn.textContent = seat.seat_code;
      btn.title = `${seat.seat_code} (${seat.category} - $${seat.price}) - Status: ${seat.status}`;

      btn.onclick = () => toggleSeatSelection(seat);
      rowDiv.appendChild(btn);
    });

    container.appendChild(rowDiv);
  });

  // Start hold countdown timer if user holds seats
  if (myHeldExpiresAt) {
    startHoldTimer(myHeldExpiresAt);
  }
}

function toggleSeatSelection(seat) {
  if (seat.status === 'BOOKED') return;
  if (seat.status === 'HELD' && seat.held_by_user_id !== state.user.id) return;

  const idx = state.selectedSeatIds.indexOf(seat.id);
  if (idx > -1) {
    state.selectedSeatIds.splice(idx, 1);
  } else {
    state.selectedSeatIds.push(seat.id);
  }

  renderSeatGrid();
  updateCartUI();
}

function updateCartUI() {
  const seatsListEl = document.getElementById('cart-seats-list');
  const totalPriceEl = document.getElementById('cart-total-price');

  if (state.selectedSeatIds.length === 0) {
    seatsListEl.textContent = 'None selected';
    totalPriceEl.textContent = '$0';
    return;
  }

  const selectedSeats = state.activeSeats.filter(s => state.selectedSeatIds.includes(s.id));
  const codes = selectedSeats.map(s => s.seat_code).join(', ');
  const total = selectedSeats.reduce((sum, s) => sum + s.price, 0);

  seatsListEl.textContent = codes;
  totalPriceEl.textContent = `$${total}`;
}

// Hold Seats Action
async function handleHoldSeats() {
  if (state.selectedSeatIds.length === 0) {
    alert('Please select at least one seat to place a hold.');
    return;
  }

  try {
    const res = await apiRequest('/api/seats/hold', 'POST', {
      event_id: state.selectedEvent.id,
      seat_ids: state.selectedSeatIds
    });

    alert(res.message);
    state.heldExpiresAt = res.expires_at;
    startHoldTimer(res.expires_at);
    await fetchSeats(state.selectedEvent.id, true);
  } catch (err) {
    alert(`Hold Failed: ${err.message}`);
  }
}

// Release Hold Action
async function handleReleaseHold() {
  if (!state.selectedEvent) return;
  try {
    await apiRequest('/api/seats/release-hold', 'POST', {
      event_id: state.selectedEvent.id,
      seat_ids: state.selectedSeatIds.length ? state.selectedSeatIds : state.activeSeats.filter(s => s.held_by_user_id === state.user.id).map(s => s.id)
    });
    stopHoldTimer();
    state.selectedSeatIds = [];
    await fetchSeats(state.selectedEvent.id, false);
    alert('Seat holds released.');
  } catch (err) {
    alert(`Release failed: ${err.message}`);
  }
}

// Confirm Booking Action
async function handleConfirmBooking() {
  // If we have selected seat IDs or held seats
  let seatIdsToBook = state.selectedSeatIds;
  if (seatIdsToBook.length === 0) {
    const myHeld = state.activeSeats.filter(s => s.status === 'HELD' && s.held_by_user_id === state.user.id);
    seatIdsToBook = myHeld.map(s => s.id);
  }

  if (seatIdsToBook.length === 0) {
    alert('Please select/hold seats before confirming booking.');
    return;
  }

  try {
    // First ensure seats are held
    const myHeld = state.activeSeats.filter(s => seatIdsToBook.includes(s.id) && s.status === 'HELD' && s.held_by_user_id === state.user.id);
    if (myHeld.length !== seatIdsToBook.length) {
      await apiRequest('/api/seats/hold', 'POST', {
        event_id: state.selectedEvent.id,
        seat_ids: seatIdsToBook
      });
    }

    const res = await apiRequest('/api/bookings/confirm', 'POST', {
      event_id: state.selectedEvent.id,
      seat_ids: seatIdsToBook
    });

    stopHoldTimer();
    state.selectedSeatIds = [];
    alert(`🎟️ BOOKING CONFIRMED!\nRef: ${res.booking.booking_reference}\nA confirmation email with your QR code ticket has been sent!`);

    await loadMyBookings();
    switchTab('my-bookings');
  } catch (err) {
    alert(`Booking failed: ${err.message}`);
  }
}

// Countdown Timer Handler for Seat Holds
function startHoldTimer(expiresAtIso) {
  stopHoldTimer();

  const container = document.getElementById('cart-hold-timer-container');
  const timerText = document.getElementById('cart-hold-timer');
  const globalBanner = document.getElementById('global-hold-banner');
  const globalTimer = document.getElementById('global-hold-timer');

  container.style.display = 'block';
  globalBanner.style.display = 'block';

  function update() {
    const remainingMs = new Date(expiresAtIso) - new Date();
    if (remainingMs <= 0) {
      stopHoldTimer();
      timerText.textContent = 'EXPIRED';
      globalTimer.textContent = 'EXPIRED';
      alert('Your seat hold has expired and been automatically released.');
      if (state.selectedEvent) fetchSeats(state.selectedEvent.id, false);
      return;
    }

    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    const formatted = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    timerText.textContent = formatted;
    globalTimer.textContent = formatted;
  }

  update();
  state.holdTimerInterval = setInterval(update, 1000);
}

function stopHoldTimer() {
  if (state.holdTimerInterval) {
    clearInterval(state.holdTimerInterval);
    state.holdTimerInterval = null;
  }
  document.getElementById('cart-hold-timer-container').style.display = 'none';
  document.getElementById('global-hold-banner').style.display = 'none';
}

// 3. Load My Bookings
async function loadMyBookings() {
  try {
    const res = await apiRequest('/api/bookings/my-bookings');
    const container = document.getElementById('bookings-list');
    container.innerHTML = '';

    if (res.bookings.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted);">You have no bookings yet.</p>';
      return;
    }

    res.bookings.forEach(b => {
      const card = document.createElement('div');
      card.className = 'glass-panel';
      card.style.padding = '24px';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';

      const isCancelled = b.status === 'CANCELLED';

      card.innerHTML = `
        <div style="flex: 1;">
          <div style="display: flex; gap: 10px; align-items: center; margin-bottom: 8px;">
            <span style="font-family: monospace; font-size: 16px; font-weight: 800; color: var(--accent-amber);">${b.booking_reference}</span>
            <span class="role-pill ${isCancelled ? 'role-ADMIN' : 'role-CUSTOMER'}">${b.status}</span>
          </div>

          <h3 style="font-size: 20px; font-weight: 700;">${b.event_title}</h3>
          <p style="color: var(--text-muted); font-size: 13px; margin: 4px 0;">
            📍 ${b.venue_name} | 📅 ${new Date(b.event_date).toLocaleString()}
          </p>
          <p style="font-size: 14px; margin-top: 8px;">
            <strong>Seats:</strong> ${b.seat_codes.join(', ')} (${b.seat_category}) | 
            <strong>Total Paid:</strong> $${b.total_amount}
          </p>
        </div>

        <div style="text-align: center; margin-left: 20px;">
          ${b.qr_code_data && !isCancelled ? `
            <img src="${b.qr_code_data}" alt="QR Ticket" style="width: 120px; height: 120px; border-radius: 8px; border: 2px solid white;">
            <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">Scan at Entry</div>
          ` : ''}

          ${!isCancelled ? `
            <button class="btn-danger" style="margin-top: 12px; width: 100%;" onclick="handleCancelBooking(${b.id})">
              Cancel Booking
            </button>
          ` : ''}
        </div>
      `;

      container.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load bookings:', err);
  }
}

async function handleCancelBooking(bookingId) {
  if (!confirm('Are you sure you want to cancel this booking? The seats will be automatically assigned to waitlisted customers!')) return;

  try {
    const res = await apiRequest('/api/bookings/cancel', 'POST', { booking_id: bookingId });
    alert(res.message);
    await loadMyBookings();
  } catch (err) {
    alert(`Cancellation failed: ${err.message}`);
  }
}

// 4. Waitlist Queue Handler
function openJoinWaitlistModal(eventId, category) {
  document.getElementById('wl-event-id').value = eventId;
  document.getElementById('wl-category').value = category;
  document.getElementById('modal-join-waitlist').classList.add('open');
}

async function submitJoinWaitlist() {
  const eventId = document.getElementById('wl-event-id').value;
  const category = document.getElementById('wl-category').value;

  try {
    const res = await apiRequest('/api/waitlist/join', 'POST', {
      event_id: parseInt(eventId),
      seat_category: category
    });

    closeModal('modal-join-waitlist');
    alert(`🎉 ${res.message}\nYour queue position: #${res.queue_position}`);
    switchTab('waitlist');
  } catch (err) {
    alert(`Join waitlist failed: ${err.message}`);
  }
}

async function loadWaitlist() {
  try {
    const res = await apiRequest('/api/waitlist/my-waitlist');
    const container = document.getElementById('waitlist-list');
    container.innerHTML = '';

    const activeOffer = res.waitlist.find(w => w.status === 'OFFERED');
    if (activeOffer) {
      state.activeWaitlistOffer = activeOffer;
      showWaitlistOfferBanner(activeOffer);
    } else {
      document.getElementById('waitlist-offer-banner').style.display = 'none';
    }

    if (res.waitlist.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted);">You are not currently in any waitlist queue.</p>';
      return;
    }

    res.waitlist.forEach(w => {
      const card = document.createElement('div');
      card.className = 'glass-panel';
      card.style.padding = '20px';
      card.style.display = 'flex';
      card.style.justifyContent = 'space-between';
      card.style.alignItems = 'center';

      card.innerHTML = `
        <div>
          <h4 style="font-size: 18px; font-weight: 700;">${w.event_title}</h4>
          <p style="font-size: 13px; color: var(--text-muted);">
            Category: <strong>${w.seat_category}</strong> | Date: ${new Date(w.event_date).toLocaleString()}
          </p>
        </div>

        <div>
          <span class="role-pill role-${w.status === 'OFFERED' ? 'ORGANISER' : 'CUSTOMER'}">${w.status}</span>
        </div>
      `;

      container.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load waitlist:', err);
  }
}

function showWaitlistOfferBanner(offer) {
  const banner = document.getElementById('waitlist-offer-banner');
  const text = document.getElementById('offer-banner-text');
  banner.style.display = 'block';

  text.textContent = `Seat available for ${offer.event_title} (${offer.seat_category} Category)! Token: ${offer.offer_token}`;
}

async function handleClaimOffer() {
  if (!state.activeWaitlistOffer) return;

  try {
    const res = await apiRequest('/api/bookings/confirm', 'POST', {
      event_id: state.activeWaitlistOffer.event_id,
      offer_token: state.activeWaitlistOffer.offer_token
    });

    alert(`🎉 WAITLIST OFFER CLAIMED SUCCESSFULLY!\nRef: ${res.booking.booking_reference}`);
    document.getElementById('waitlist-offer-banner').style.display = 'none';
    state.activeWaitlistOffer = null;
    await loadMyBookings();
    switchTab('my-bookings');
  } catch (err) {
    alert(`Claim offer failed: ${err.message}`);
  }
}

function checkOfferTokenFromUrl() {
  const hash = window.location.hash;
  if (hash.includes('offerToken=')) {
    const token = hash.split('offerToken=')[1];
    if (token) {
      switchTab('waitlist');
    }
  }
}

// 5. Organiser Analytics
async function loadOrganiserSummary() {
  try {
    const res = await apiRequest('/api/organiser/summary');
    renderOrganiserDashboard(res.summary);
  } catch (err) {
    console.error('Failed to load organiser summary:', err);
  }
}

function renderOrganiserDashboard(summary) {
  const metricsContainer = document.getElementById('organiser-metrics');
  const tableContainer = document.getElementById('organiser-table-container');

  const totalRevenue = summary.reduce((sum, s) => sum + s.total_revenue, 0);
  const totalBookings = summary.reduce((sum, s) => sum + s.total_bookings, 0);
  const totalWaitlist = summary.reduce((sum, s) => sum + s.waitlist_count, 0);

  metricsContainer.innerHTML = `
    <div class="glass-panel" style="padding: 20px; text-align: center;">
      <span style="font-size: 13px; color: var(--text-muted);">Total Revenue</span>
      <h2 style="font-size: 32px; font-weight: 800; color: var(--accent-emerald);">$${totalRevenue}</h2>
    </div>
    <div class="glass-panel" style="padding: 20px; text-align: center;">
      <span style="font-size: 13px; color: var(--text-muted);">Total Confirmed Tickets</span>
      <h2 style="font-size: 32px; font-weight: 800; color: var(--accent-blue);">${totalBookings}</h2>
    </div>
    <div class="glass-panel" style="padding: 20px; text-align: center;">
      <span style="font-size: 13px; color: var(--text-muted);">Waitlist Demand Queue</span>
      <h2 style="font-size: 32px; font-weight: 800; color: var(--accent-amber);">${totalWaitlist}</h2>
    </div>
  `;

  let tableHtml = `
    <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px;">
      <thead>
        <tr style="border-bottom: 1px solid var(--border-color); color: var(--text-muted);">
          <th style="padding: 12px;">Event Title</th>
          <th style="padding: 12px;">Venue</th>
          <th style="padding: 12px;">Available Seats</th>
          <th style="padding: 12px;">Booked Seats</th>
          <th style="padding: 12px;">Revenue</th>
          <th style="padding: 12px;">Waitlist</th>
        </tr>
      </thead>
      <tbody>
  `;

  summary.forEach(s => {
    tableHtml += `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
        <td style="padding: 12px; font-weight: 700;">${s.title}</td>
        <td style="padding: 12px;">${s.venue_name}</td>
        <td style="padding: 12px; color: #34d399;">${s.seat_breakdown.AVAILABLE} / ${s.seat_breakdown.TOTAL}</td>
        <td style="padding: 12px; color: #38bdf8;">${s.seat_breakdown.BOOKED}</td>
        <td style="padding: 12px; font-weight: 700; color: var(--accent-emerald);">$${s.total_revenue}</td>
        <td style="padding: 12px; color: var(--accent-amber);">${s.waitlist_count}</td>
      </tr>
    `;
  });

  tableHtml += '</tbody></table>';
  tableContainer.innerHTML = tableHtml;
}

// Organiser Event Creation
function openCreateEventModal() {
  loadVenuesForDropdown();
  document.getElementById('modal-create-event').classList.add('open');
}

async function loadVenuesForDropdown() {
  try {
    const res = await apiRequest('/api/venues');
    const select = document.getElementById('ev-venue-id');
    select.innerHTML = '';
    res.venues.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.total_rows * v.seats_per_row} seats)`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Failed to load venues:', err);
  }
}

async function handleCreateEvent(e) {
  e.preventDefault();
  const title = document.getElementById('ev-title').value;
  const category = document.getElementById('ev-category').value;
  const venue_id = parseInt(document.getElementById('ev-venue-id').value);
  const event_date = document.getElementById('ev-date').value;
  const pricePrem = parseFloat(document.getElementById('ev-price-premium').value);
  const priceStd = parseFloat(document.getElementById('ev-price-standard').value);

  try {
    await apiRequest('/api/events', 'POST', {
      title,
      category,
      venue_id,
      event_date,
      pricing: { Premium: pricePrem, Standard: priceStd }
    });

    closeModal('modal-create-event');
    alert('🎉 Event listing created successfully!');
    await loadEvents();
    switchTab('events');
  } catch (err) {
    alert(`Failed to create event: ${err.message}`);
  }
}

// 6. Admin Venue Creator
async function handleCreateVenue(e) {
  e.preventDefault();
  const name = document.getElementById('v-name').value;
  const address = document.getElementById('v-address').value;
  const total_rows = parseInt(document.getElementById('v-rows').value);
  const seats_per_row = parseInt(document.getElementById('v-cols').value);

  // Generate rows layout A, B, C, D...
  const layout = {};
  const rowNames = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  for (let i = 0; i < total_rows; i++) {
    const rowName = rowNames[i] || `Row${i+1}`;
    layout[rowName] = i < 2 ? 'Premium' : 'Standard';
  }

  try {
    await apiRequest('/api/venues', 'POST', {
      name,
      address,
      total_rows,
      seats_per_row,
      seat_layout: layout
    });

    alert('🎉 Venue created successfully!');
    document.getElementById('form-create-venue').reset();
    switchTab('events');
  } catch (err) {
    alert(`Venue creation failed: ${err.message}`);
  }
}

// 7. Outbox Email Inspector
async function loadOutboxEmails() {
  try {
    const res = await apiRequest('/api/organiser/outbox-emails');
    const container = document.getElementById('outbox-email-list');
    container.innerHTML = '';

    if (res.emails.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted);">No outbox emails recorded yet. Book a ticket or cancel a booking to see emails generated!</p>';
      return;
    }

    res.emails.forEach(e => {
      const card = document.createElement('div');
      card.className = 'email-card';
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <div>
            <strong>To:</strong> ${e.to_email} | <strong>Subject:</strong> ${e.subject}
          </div>
          <span style="font-size: 11px; color: var(--text-muted);">${new Date(e.created_at).toLocaleString()}</span>
        </div>
        <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
          ${e.content_html}
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.error('Failed to load outbox emails:', err);
  }
}

// Utility Modal Helper
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
