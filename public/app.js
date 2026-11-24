'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  token: null,
  user: null,
  currentTab: 'main',
  rides: [],
  myRide: null,
  viewRide: null,
  driverMap: null,
  detailMap: null,
  driverMarker: null,
  otherMarkers: {},
  routeLayer: null,
  ws: null,
  watchId: null,
  startedAt: null,
  timerInterval: null,
  speedHistory: [],
  autoCheckTimer: null,
  pendingGPS: [],
  selectedColor: '#C95B18',
  avatarData: null,
  // Pre-ride GPS buffer: collect points before ride is officially started
  gpsBuffer: [],         // [{lat, lng, speed, ts}] – last ~10 min
};

const COLORS = ['#C95B18','#2D7A58','#2A5FAC','#8B3A3A','#5A2D82','#B5860A','#2A7A7A','#6B3A6B'];
const AUTO_SPEED_KMH = 20;
const AUTO_SPEED_SECS = 30;
const AUTO_STOP_SECS = 300;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  S.token = localStorage.getItem('tanki_token');
  if (S.token) {
    const r = await api('GET', '/api/me');
    if (r?.user) {
      S.user = r.user;
      showLoggedIn();
      return;
    }
    localStorage.removeItem('tanki_token');
    S.token = null;
  }
  showScreen('auth');
});

function showLoggedIn() {
  el('tabbar').hidden = false;
  showTab('main');
  loadRides();
  connectWS();
  startGPS();
  renderProfileHead();
}

// ── Routing ───────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.hidden = true);
  el(`screen-${name}`).hidden = false;
}

function showTab(tab) {
  S.currentTab = tab;
  showScreen(tab);
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'my-ride') initDriverScreen();
  if (tab === 'profile') loadProfile();
}

document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => showTab(b.dataset.tab));
});

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, path, body = null) {
  try {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  } catch {
    return { error: 'Netzwerkfehler' };
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function el(id) { return document.getElementById(id); }

// ── Auth ──────────────────────────────────────────────────────────────────────
el('to-register').addEventListener('click', () => { el('form-login').hidden = true; el('form-register').hidden = false; el('auth-error').hidden = true; });
el('to-login').addEventListener('click', () => { el('form-login').hidden = false; el('form-register').hidden = true; el('auth-error').hidden = true; });

el('btn-login').addEventListener('click', async () => {
  const username = el('login-user').value.trim();
  const password = el('login-pass').value;
  if (!username || !password) return;
  el('btn-login').disabled = true;
  const r = await api('POST', '/api/login', { username, password });
  el('btn-login').disabled = false;
  if (r.error) { showAuthError(r.error); return; }
  S.token = r.token; S.user = r.user;
  localStorage.setItem('tanki_token', S.token);
  showLoggedIn();
});

el('btn-register').addEventListener('click', async () => {
  const username = el('reg-user').value.trim();
  const password = el('reg-pass').value;
  if (!username || !password) return;
  el('btn-register').disabled = true;
  const r = await api('POST', '/api/register', { username, password });
  el('btn-register').disabled = false;
  if (r.error) { showAuthError(r.error); return; }
  S.token = r.token; S.user = r.user;
  localStorage.setItem('tanki_token', S.token);
  showLoggedIn();
});

el('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') el('btn-login').click(); });
el('reg-pass').addEventListener('keydown', e => { if (e.key === 'Enter') el('btn-register').click(); });

function showAuthError(msg) {
  const e = el('auth-error');
  e.textContent = msg;
  e.hidden = false;
}

el('btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  S.token = null; S.user = null; S.myRide = null;
  localStorage.removeItem('tanki_token');
  stopGPS();
  if (S.ws) S.ws.close();
  el('tabbar').hidden = true;
  showScreen('auth');
});

// ── Rides list ────────────────────────────────────────────────────────────────
async function loadRides() {
  const r = await api('GET', '/api/rides');
  if (!r?.rides) return;
  S.rides = r.rides;
  renderRides();
  // Check if we're already driving
  const myActive = r.rides.find(ride => ride.driver_id === S.user?.id && ride.status === 'active');
  if (myActive && !S.myRide) {
    S.myRide = myActive;
  }
  updateMyRideTab();
}

function renderRides() {
  const list = el('rides-list');
  const active = S.rides.filter(r => r.status === 'active');
  const ended = S.rides.filter(r => r.status === 'ended');

  el('live-count').textContent = active.length === 1 ? '1 Fahrt live' : `${active.length} Fahrten live`;

  if (S.rides.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>
      <p>Keine aktiven Fahrten.<br>Starte eine und deine Freunde sehen sie hier.</p>
    </div>`;
    return;
  }

  list.innerHTML = '';
  if (active.length) {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = 'Jetzt aktiv';
    list.appendChild(lbl);
    active.forEach(r => list.appendChild(makeRideCard(r)));
  }
  if (ended.length) {
    const lbl = document.createElement('div');
    lbl.className = 'section-label';
    lbl.textContent = 'Kürzlich beendet (30 Min)';
    list.appendChild(lbl);
    ended.forEach(r => list.appendChild(makeRideCard(r)));
  }
}

function makeRideCard(ride) {
  const isMe = ride.driver_id === S.user?.id;
  const isEnded = ride.status === 'ended';
  const speedKmh = Math.round((ride.last_speed || 0) * 3.6);

  const card = document.createElement('div');
  card.className = 'ride-card' + (isEnded ? ' ended' : '');
  card.innerHTML = `
    ${avatarHTML(ride.driver_name, ride.driver_color, ride.driver_avatar, 50)}
    <div class="ride-info">
      <div class="ride-name">${esc(ride.driver_name)}${isMe ? ' (du)' : ''}</div>
      <div class="ride-meta">${isEnded ? 'Beendet' : `Fährt seit ${minsAgo(ride.started_at)} Min`}</div>
      <div class="ride-tags">
        <span class="tag">${esc(ride.fuel_type || 'benzin')}</span>
        <span class="tag">${ride.participant_count} ${ride.participant_count === 1 ? 'Person' : 'Personen'}</span>
        ${!isEnded && speedKmh > 0 ? `<span class="tag ac">${speedKmh} km/h</span>` : ''}
        ${isEnded ? '<span class="tag">Abrechnung möglich</span>' : ''}
      </div>
    </div>
    ${!isMe && !isEnded ? `<button class="btn-join">Dazu</button>` : ''}
  `;

  if (!isMe) {
    const joinBtn = card.querySelector('.btn-join');
    if (joinBtn) joinBtn.addEventListener('click', e => { e.stopPropagation(); joinRide(ride.id); });
  }
  card.addEventListener('click', () => openRideDetail(ride.id));
  return card;
}

async function joinRide(rideId) {
  const r = await api('POST', `/api/rides/${rideId}/join`);
  if (r.error) { toast(r.error); return; }
  toast('Du bist der Fahrt beigetreten!');
  loadRides();
}

function minsAgo(ts) {
  return Math.max(1, Math.round((Date.now() / 1000 - ts) / 60));
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function avatarHTML(name, color, avatarData, size) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  if (avatarData) {
    return `<div class="avatar" style="width:${size}px;height:${size}px"><img src="${avatarData}" alt="${esc(name)}"></div>`;
  }
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:${color}22;color:${color}">${initials}</div>`;
}

function miniAvatarHTML(name, color, avatarData) {
  if (avatarData) return `<div class="mini-avatar"><img src="${avatarData}" alt="${esc(name)}"></div>`;
  const initials = (name || '?').slice(0, 2).toUpperCase();
  return `<div class="mini-avatar" style="background:${color}22;color:${color}">${initials}</div>`;
}

// ── My ride screen ────────────────────────────────────────────────────────────
function updateMyRideTab() {
  const btn = document.querySelector('[data-tab="my-ride"] svg');
  if (!btn) return;
  if (S.myRide) {
    // Show active indicator on tab
    document.querySelector('[data-tab="my-ride"]').style.color = 'var(--ac)';
  }
}

function initDriverScreen() {
  if (!S.driverMap) {
    S.driverMap = L.map('map-driver', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OSM',
      maxZoom: 19,
    }).addTo(S.driverMap);
    L.control.zoom({ position: 'bottomright' }).addTo(S.driverMap);
    // Default position – will update when GPS comes in
    S.driverMap.setView([51.1657, 10.4515], 13);
    setTimeout(() => S.driverMap.invalidateSize(), 100);
  }
  renderRidePanel();
}

function renderRidePanel() {
  if (!S.myRide) return;
  renderParticipantsRow();
  updateStats();
}

async function renderParticipantsRow() {
  const r = await api('GET', `/api/rides/${S.myRide.id}`);
  if (!r?.participants) return;
  const row = el('participants-row');
  row.innerHTML = r.participants.map(p => miniAvatarHTML(p.username || p.guest_name, p.avatar_color || '#A89D84', p.avatar_data)).join('');
  el('stat-people').textContent = r.participants.length;
}

function updateStats() {
  if (!S.myRide || !S.startedAt) return;
  const secs = Math.floor((Date.now() - S.startedAt) / 1000);
  const mins = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, '0');
  el('stat-time').textContent = `${mins}:${ss}`;
}

// Start/stop interval for the timer
function startRideTimer() {
  S.startedAt = S.myRide ? (S.myRide.started_at * 1000) : Date.now();
  clearInterval(S.timerInterval);
  S.timerInterval = setInterval(updateStats, 1000);
}

function stopRideTimer() {
  clearInterval(S.timerInterval);
  S.timerInterval = null;
}

// Fuel sheet
el('btn-fuel').addEventListener('click', () => { el('fuel-sheet').hidden = false; });
el('fuel-sheet-close').addEventListener('click', () => { el('fuel-sheet').hidden = true; });
el('fuel-sheet').addEventListener('click', e => { if (e.target === el('fuel-sheet')) el('fuel-sheet').hidden = true; });

el('fuel-save').addEventListener('click', async () => {
  if (!S.myRide) return;
  const price = parseFloat(el('fuel-price').value.replace(',', '.'));
  const cons = parseFloat(el('fuel-consumption').value.replace(',', '.'));
  const type = el('fuel-type').value;
  if (!price || price <= 0) { toast('Bitte Preis eingeben'); return; }
  await api('PUT', `/api/rides/${S.myRide.id}`, {
    fuel_price: price,
    fuel_type: type,
    avg_consumption: isNaN(cons) ? null : cons,
  });
  el('fuel-sheet').hidden = true;
  toast('Spritdaten gespeichert');
});

// Add guest
el('btn-add-guest').addEventListener('click', () => { el('guest-sheet').hidden = false; el('guest-name').value = ''; });
el('guest-sheet-close').addEventListener('click', () => { el('guest-sheet').hidden = true; });
el('guest-sheet').addEventListener('click', e => { if (e.target === el('guest-sheet')) el('guest-sheet').hidden = true; });

el('guest-save').addEventListener('click', async () => {
  if (!S.myRide) return;
  const name = el('guest-name').value.trim();
  if (!name) { toast('Name eingeben'); return; }
  const r = await api('POST', `/api/rides/${S.myRide.id}/participants`, { guest_name: name });
  if (r.error) { toast(r.error); return; }
  el('guest-sheet').hidden = true;
  toast(`${name} hinzugefügt`);
  renderParticipantsRow();
});

// End ride
el('btn-end-ride').addEventListener('click', async () => {
  if (!S.myRide) return;
  if (!confirm('Fahrt wirklich beenden?')) return;
  const r = await api('DELETE', `/api/rides/${S.myRide.id}`);
  S.myRide = null;
  stopRideTimer();
  toast('Fahrt beendet');
  if (r.cost) {
    toast(`${r.cost.perPersonEur.toFixed(2)} € pro Person`);
  }
  loadRides();
  showTab('main');
});

el('auto-banner-dismiss').addEventListener('click', () => { el('auto-banner').hidden = true; });

// ── Ride detail ───────────────────────────────────────────────────────────────
el('btn-back').addEventListener('click', () => showTab('main'));

async function openRideDetail(rideId) {
  showScreen('detail');
  el('detail-driver-info').innerHTML = '';
  el('detail-cost-box').innerHTML = '';
  el('detail-participants').innerHTML = '';
  el('detail-join-area').innerHTML = '';

  const r = await api('GET', `/api/rides/${rideId}`);
  if (!r?.ride) { toast('Fahrt nicht gefunden'); return; }

  const { ride, participants, route, cost } = r;
  S.viewRide = ride;

  // Driver info
  el('detail-driver-info').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:4px">
      ${avatarHTML(ride.driver_name, ride.driver_color, ride.driver_avatar, 48)}
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800">${esc(ride.driver_name)}</div>
        <div style="font-size:13px;font-weight:600;color:var(--mu)">${ride.status === 'active' ? `Fährt seit ${minsAgo(ride.started_at)} Min` : 'Fahrt beendet'} · ${esc(ride.fuel_type || 'benzin')}</div>
      </div>
    </div>
  `;

  // Cost box
  if (cost) {
    el('detail-cost-box').innerHTML = `
      <div class="cost-box">
        <div class="cost-box-title">Dein Anteil</div>
        <div class="cost-amount">${cost.perPersonEur.toFixed(2).replace('.', ',')} <small>€ pro Person</small></div>
        <div class="cost-detail">${cost.distanceKm} km · ${cost.liters} L · ${cost.pricePerLiter?.toFixed(3).replace('.', ',')} €/L · ${cost.nParticipants} ${cost.nParticipants === 1 ? 'Person' : 'Personen'}</div>
        <div class="cost-detail" style="margin-top:4px">Gesamt: ${cost.totalEur.toFixed(2).replace('.', ',')} €</div>
      </div>
    `;
  } else {
    el('detail-cost-box').innerHTML = `
      <div class="cost-box" style="color:var(--mu);font-size:13px;font-weight:600">
        Spritdaten noch nicht eingegeben – Fahrer trägt sie nach der Fahrt ein.
      </div>
    `;
  }

  // Participants
  el('detail-participants').innerHTML = participants.map(p => `
    <div class="participant-row">
      ${miniAvatarHTML(p.username || p.guest_name, p.avatar_color || '#A89D84', p.avatar_data)}
      <div class="participant-name">${esc(p.username || p.guest_name)}</div>
      <div class="participant-badge">${p.guest_name ? 'Gast' : ''}</div>
    </div>
  `).join('');

  // Join button
  const isParticipant = participants.some(p => p.user_id === S.user?.id);
  const isDriver = ride.driver_id === S.user?.id;
  if (!isParticipant && !isDriver) {
    const canJoin = ride.status === 'active' || (ride.status === 'ended' && (Date.now() / 1000 - ride.ended_at) < 1800);
    el('detail-join-area').innerHTML = canJoin
      ? `<button class="btn" id="detail-join-btn">Dieser Fahrt beitreten</button>`
      : `<div style="text-align:center;color:var(--mu);font-size:13px;font-weight:600">Beitrittsfenster (30 Min) abgelaufen</div>`;
    el('detail-join-btn')?.addEventListener('click', async () => {
      const res = await api('POST', `/api/rides/${rideId}/join`);
      if (res.error) { toast(res.error); return; }
      toast('Beigetreten!');
      openRideDetail(rideId);
    });
  }

  // Map
  setTimeout(() => {
    if (!S.detailMap) {
      S.detailMap = L.map('detail-map', { zoomControl: false, dragging: false, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM', maxZoom: 19 }).addTo(S.detailMap);
    }
    if (route.length >= 2) {
      const latlngs = route.map(p => [p.lat, p.lng]);
      if (S.routeLayer) S.routeLayer.remove();
      S.routeLayer = L.polyline(latlngs, { color: '#C95B18', weight: 4 }).addTo(S.detailMap);
      S.detailMap.fitBounds(S.routeLayer.getBounds(), { padding: [20, 20] });
    } else if (ride.last_lat && ride.last_lng) {
      S.detailMap.setView([ride.last_lat, ride.last_lng], 14);
      L.circleMarker([ride.last_lat, ride.last_lng], { radius: 8, color: '#C95B18', fillColor: '#C95B18', fillOpacity: 1 }).addTo(S.detailMap);
    } else {
      S.detailMap.setView([51.1657, 10.4515], 6);
    }
    S.detailMap.invalidateSize();
  }, 150);
}

// ── GPS tracking ──────────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) return;
  S.watchId = navigator.geolocation.watchPosition(onPosition, onGPSError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000,
  });
}

function stopGPS() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
}

function onGPSError() { /* silent */ }

let lastGPSSend = 0;

function onPosition(pos) {
  const { latitude: lat, longitude: lng, speed } = pos.coords;
  const speedKmh = (speed || 0) * 3.6;
  const tsNow = Math.floor(Date.now() / 1000);

  // Always buffer GPS points so auto-started rides capture the full route from the beginning
  if (!S.myRide) {
    S.gpsBuffer.push({ lat, lng, speed: speed || 0, ts: tsNow });
    // Keep last 10 minutes (at 5-sec interval → max ~120 points)
    if (S.gpsBuffer.length > 150) S.gpsBuffer = S.gpsBuffer.slice(-150);
  }

  // Update driver map marker
  if (S.driverMap && S.currentTab === 'my-ride') {
    if (!S.driverMarker) {
      S.driverMarker = L.circleMarker([lat, lng], {
        radius: 10, color: '#C95B18', fillColor: '#C95B18', fillOpacity: .9, weight: 3
      }).addTo(S.driverMap);
      S.driverMap.setView([lat, lng], 15);
    } else {
      S.driverMarker.setLatLng([lat, lng]);
    }
    el('stat-speed').textContent = Math.round(speedKmh);
  }

  // Auto ride detection
  if (!S.myRide) {
    checkAutoRide(speedKmh, lat, lng);
  }

  // Send location if driving
  if (S.myRide && Date.now() - lastGPSSend > 4000) {
    lastGPSSend = Date.now();
    sendLocation(S.myRide.id, lat, lng, speed || 0);
    if (S.driverMap && S.currentTab === 'my-ride') {
      const dist = S.myRide.total_distance || 0;
      el('stat-dist').textContent = dist.toFixed(1).replace('.', ',');
    }
    // Auto-stop check
    checkAutoStop(speedKmh);
  }
}

let autoStopCount = 0;

function checkAutoStop(speedKmh) {
  if (!S.myRide) return;
  if (speedKmh < 5) {
    autoStopCount++;
    // After ~5 minutes of standing (300s / 4s interval = 75 checks)
    if (autoStopCount >= 75) {
      autoStopCount = 0;
    }
  } else {
    autoStopCount = 0;
  }
}

function checkAutoRide(speedKmh, lat, lng) {
  const now = Date.now();
  S.speedHistory = S.speedHistory.filter(e => now - e.t < (AUTO_SPEED_SECS + 5) * 1000);
  S.speedHistory.push({ speed: speedKmh, t: now });

  const recent = S.speedHistory.filter(e => now - e.t < AUTO_SPEED_SECS * 1000);
  if (recent.length < 3) return;
  const allFast = recent.every(e => e.speed >= AUTO_SPEED_KMH);
  if (allFast) {
    S.speedHistory = [];
    autoStartRide(lat, lng);
  }
}

async function autoStartRide(lat, lng) {
  if (S.myRide) return;
  const r = await api('POST', '/api/rides', { fuel_type: 'benzin' });
  if (r.error) return;
  S.myRide = r.ride;

  // Send all pre-buffered GPS points so the route starts from when driving began
  if (S.gpsBuffer.length > 0) {
    api('POST', `/api/rides/${S.myRide.id}/location/bulk`, { points: S.gpsBuffer });
    S.gpsBuffer = [];
  }

  updateMyRideTab();
  startRideTimer();
  el('auto-banner').hidden = false;
  if (S.currentTab === 'main') loadRides();
}

function sendLocation(rideId, lat, lng, speed) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ type: 'location', rideId, lat, lng, speed }));
  } else {
    // HTTP fallback
    api('POST', `/api/rides/${rideId}/location`, { lat, lng, speed }).then(r => {
      if (r?.totalDistance != null && S.myRide) {
        S.myRide.total_distance = r.totalDistance;
        if (S.currentTab === 'my-ride') {
          el('stat-dist').textContent = r.totalDistance.toFixed(1).replace('.', ',');
        }
      }
    });
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
let wsReconnect;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}`);

  S.ws.addEventListener('open', () => {
    S.ws.send(JSON.stringify({ type: 'auth', token: S.token }));
    clearTimeout(wsReconnect);
  });

  S.ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleWSMsg(msg);
  });

  S.ws.addEventListener('close', () => {
    wsReconnect = setTimeout(connectWS, 5000);
  });

  S.ws.addEventListener('error', () => {});
}

// Keep-alive ping
setInterval(() => {
  if (S.ws?.readyState === 1) S.ws.send(JSON.stringify({ type: 'ping' }));
}, 25000);

function handleWSMsg(msg) {
  switch (msg.type) {
    case 'auth_ok':
      break;

    case 'ride_started':
      if (!S.rides.find(r => r.id === msg.ride.id)) {
        S.rides.unshift(msg.ride);
        if (S.currentTab === 'main') renderRides();
        toast(`${msg.ride.driver_name} hat eine Fahrt gestartet`);
      }
      break;

    case 'ride_ended':
      S.rides = S.rides.map(r => r.id === msg.rideId ? { ...r, status: 'ended' } : r);
      if (S.currentTab === 'main') renderRides();
      break;

    case 'participant_joined':
      if (S.myRide?.id === msg.rideId) {
        renderParticipantsRow();
      }
      break;

    case 'driver_location': {
      const { rideId, lat, lng, driverName } = msg;
      // Update marker on main screen (small dots) or detail map
      if (S.detailMap && S.viewRide?.id === rideId) {
        // Update polyline endpoint
      }
      // Update ride card speed
      S.rides = S.rides.map(r => r.id === rideId ? { ...r, last_lat: lat, last_lng: lng, last_speed: msg.speed } : r);
      break;
    }

    case 'ride_updated':
      if (S.viewRide?.id === msg.rideId) {
        // Reload detail
        openRideDetail(msg.rideId);
      }
      break;
  }
}

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  renderProfileHead();
  const r = await api('GET', '/api/my-rides');
  const list = el('history-list');
  if (!r?.rides?.length) {
    list.innerHTML = `<div style="color:var(--mu);font-size:13px;font-weight:600;padding:16px 0">Noch keine beendeten Fahrten.</div>`;
    return;
  }
  list.innerHTML = r.rides.map(ride => {
    const nP = ride.participant_count;
    const cost = ride.fuel_price
      ? (ride.total_distance * (ride.avg_consumption || 7.5) / 100 * ride.fuel_price / nP).toFixed(2).replace('.', ',')
      : null;
    return `
      <div class="history-card" data-rideid="${ride.id}" style="cursor:pointer">
        <div class="history-left">
          ${ride.driver_id === S.user?.id ? 'Du gefahren' : `Mit ${esc(ride.driver_name)}`} · ${esc(ride.fuel_type || 'benzin')}
          <small>${new Date(ride.ended_at * 1000).toLocaleDateString('de-DE')} · ${ride.total_distance?.toFixed(1) || '?'} km · ${nP} ${nP === 1 ? 'Person' : 'Personen'}</small>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${cost ? `<div class="history-cost">${cost} €</div>` : '<div style="color:var(--mu);font-size:12px;font-weight:600">kein Preis</div>'}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--mu)" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
    `;
  }).join('');

  // Click → open detail with map + participants
  list.addEventListener('click', e => {
    const card = e.target.closest('.history-card[data-rideid]');
    if (card) openRideDetail(+card.dataset.rideid);
  });
}

function renderProfileHead() {
  if (!S.user) return;
  el('profile-name').textContent = S.user.username;
  const inner = el('profile-av-inner');
  if (S.user.avatar_data) {
    inner.outerHTML = `<img id="profile-av-inner" src="${S.user.avatar_data}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  } else {
    const col = S.user.avatar_color || '#C95B18';
    inner.style.cssText = `width:100%;height:100%;background:${col}22;color:${col};display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-size:26px;font-weight:800;border-radius:50%`;
    inner.textContent = (S.user.username || '?').slice(0, 2).toUpperCase();
  }
  el('profile-avatar-btn').style.cssText = `width:72px;height:72px;border-radius:50%;overflow:hidden;cursor:pointer;position:relative;`;
}

// Avatar sheet
el('profile-avatar-btn').addEventListener('click', () => {
  buildColorPicker();
  S.selectedColor = S.user?.avatar_color || '#C95B18';
  S.avatarData = null;
  el('avatar-sheet').hidden = false;
});
el('avatar-sheet-close').addEventListener('click', () => { el('avatar-sheet').hidden = true; });
el('avatar-sheet').addEventListener('click', e => { if (e.target === el('avatar-sheet')) el('avatar-sheet').hidden = true; });

function buildColorPicker() {
  const row = el('color-picker');
  row.innerHTML = COLORS.map(c => `
    <div class="color-swatch ${c === S.selectedColor ? 'selected' : ''}" style="background:${c}" data-c="${c}"></div>
  `).join('');
  row.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      row.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
      S.selectedColor = sw.dataset.c;
      S.avatarData = null;
      el('avatar-file').value = '';
    });
  });
}

el('avatar-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    // Resize to 128x128
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      // Crop to square
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
      S.avatarData = canvas.toDataURL('image/jpeg', 0.7);
      el('color-picker').querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

el('avatar-save').addEventListener('click', async () => {
  const body = S.avatarData
    ? { avatar_data: S.avatarData, avatar_color: S.selectedColor }
    : { avatar_color: S.selectedColor, avatar_data: null };
  await api('PUT', '/api/me', body);
  S.user.avatar_color = S.selectedColor;
  S.user.avatar_data = S.avatarData;
  el('avatar-sheet').hidden = false;
  el('avatar-sheet').hidden = true;
  renderProfileHead();
  toast('Profilbild gespeichert');
});

// ── Visibility / background handling ─────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // App came to foreground: refresh rides
  if (S.token) loadRides();
  if (S.ws?.readyState > 1) connectWS();
});

// ── Keyboard helpers (login) ───────────────────────────────────────────────────
el('login-user').addEventListener('keydown', e => { if (e.key === 'Enter') el('login-pass').focus(); });
el('reg-user').addEventListener('keydown', e => { if (e.key === 'Enter') el('reg-pass').focus(); });

// Polling fallback: refresh rides every 15s when app is visible
setInterval(() => {
  if (!document.hidden && S.token && S.currentTab === 'main') loadRides();
}, 15000);
