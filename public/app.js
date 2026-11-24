'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const AUTO_KMH = 20;          // auto-start threshold
const AUTO_SECS = 30;         // sustained for this long
const STOP_SECS = 8 * 60;     // standing this long ends a ride (long enough for traffic jams)
const NEAR_M = 300;           // "you're driving next to a friend" radius
const JOIN_WINDOW = 30 * 60;
const FUEL = {
  benzin: { label: 'Benzin', unit: 'l', cons: 7.5 },
  diesel: { label: 'Diesel', unit: 'l', cons: 6.0 },
  lpg: { label: 'Autogas (LPG)', unit: 'l', cons: 9.5 },
  elektro: { label: 'Elektro', unit: 'kWh', cons: 18 },
};
const COLORS = ['#C8F03C', '#5CE1E6', '#FF8A5B', '#B69CFF', '#FFD25E', '#6EE7A8', '#FF6B9A', '#7AA7FF'];
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  token: lsGet('tk'), me: null, tab: 'home',
  feed: { rides: [], current: null, friends: 0, requests: 0, missingPrice: 0 },
  ws: null, watch: null, gps: 'off',
  pos: null, buf: [], outbox: [], inflight: null, seq: 0,
  stillSince: null, suppressUntil: 0, prompting: false, ending: false,
  map: null, meMarker: null, pins: new Map(), route: null, routeRide: null, follow: true,
  detail: null, dmap: null, dlayer: null,
  wake: null, installEvt: null, sheetClose: null, confirmFn: null,
  authMode: 'login', authRole: 'driver', openBal: new Set(), searchTimer: null,
};

// ── Utils ─────────────────────────────────────────────────────────────────────
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }
const $ = id => document.getElementById(id);
const nowS = () => Date.now() / 1000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = v => v == null ? '–' : v.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const kmNum = v => (v || 0).toLocaleString('de-DE', { minimumFractionDigits: v < 100 ? 1 : 0, maximumFractionDigits: v < 100 ? 1 : 0 });
const dec = (v, d = 1) => v == null ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const dur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min`; };
const durShort = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`; };
const dateStr = ts => new Date(ts * 1000).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
const timeStr = ts => new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fuelUnit = t => (FUEL[t] || FUEL.benzin).unit;
const isMe = u => u && S.me && u.id === S.me.id;
const isStandalone = () => matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Fuel-pump style price: 1,79⁹
function price(p, unit) {
  if (!p) return '–';
  const s = p.toFixed(3).replace('.', ',');
  return `${s.slice(0, -1)}<sup>${s.slice(-1)}</sup> €/${unit}`;
}

function meters(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lng - a.lng) * rad / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function av(u, size = 40) {
  if (!u) return '';
  const ini = esc((u.username || '?').slice(0, 2).toUpperCase());
  if (u.guest) return `<span class="av guest" style="--s:${size}px">${ini}</span>`;
  if (u.avatar) return `<img class="av" style="--s:${size}px" src="${esc(u.avatar)}" alt="">`;
  return `<span class="av" style="--s:${size}px;--c:${esc(u.color || COLORS[0])}">${ini}</span>`;
}
const avStack = (list, size = 28, max = 4) => `<span class="av-stack">${list.slice(0, max).map(u => av(u, size)).join('')}${list.length > max ? `<span class="av guest" style="--s:${size}px">+${list.length - max}</span>` : ''}</span>`;

const ICON = {
  car: '<svg viewBox="0 0 24 24"><path d="M5 17h14M6 17l1.5-6h9L18 17"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/><path d="M8.5 11 10 7h4l1.5 4"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pump: '<svg viewBox="0 0 24 24"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10"/><path d="M14 8h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M16 15h2"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.6 3.5 5.2"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
};

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && S.token) { logout(true); return { error: d.error || 'Bitte neu anmelden.' }; }
    if (!r.ok) return { error: d.error || `Fehler ${r.status}` };
    return d;
  } catch {
    return { error: 'Keine Verbindung zum Server.', offline: true };
  }
}

async function call(method, url, body, okMsg) {
  const r = await api(method, url, body);
  if (r.error) toast(r.error, 'err');
  else if (okMsg) toast(okMsg);
  return r;
}

let toastTimer;
function toast(msg, kind = '', action = null) {
  const t = $('toast');
  t.className = 'toast ' + kind;
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.fn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3200);
}

// ── Sheets ────────────────────────────────────────────────────────────────────
function openSheet(html, onClose = null) {
  if (S.sheetClose) { const f = S.sheetClose; S.sheetClose = null; f(); }
  $('sheet').innerHTML = `<div class="grab"></div>${html}`;
  $('sheet-bg').hidden = false;
  S.sheetClose = onClose;
}

function closeSheet() {
  if ($('sheet-bg').hidden) return;
  $('sheet-bg').hidden = true;
  $('sheet').innerHTML = '';
  const f = S.sheetClose;
  S.sheetClose = null;
  f?.();
}

function confirmSheet(title, text, label, fn, danger = false) {
  S.confirmFn = fn;
  openSheet(`<h3>${title}</h3><p>${text}</p>
    <button class="btn ${danger ? 'danger' : ''}" data-act="confirm-yes">${label}</button>
    <button class="btn ghost" data-act="close">Abbrechen</button>`);
}

// ── Boot / auth ───────────────────────────────────────────────────────────────
function boot() {
  const add = new URLSearchParams(location.search).get('add');
  if (add) { lsSet('pendingAdd', add); history.replaceState(null, '', '/'); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  $('friend-q').addEventListener('input', onSearch);
  $('auth-form').addEventListener('submit', onAuth);
  $('photo-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; if (S.tab === 'home') renderHome(); });
  document.addEventListener('visibilitychange', onVisible);
  setInterval(tick, 5000);
  setInterval(() => { if (!document.hidden && S.me) loadFeed(); }, 20000);
  if (S.token) start(); else showAuth();
}

function showAuth() {
  for (const id of ['home', 'rides', 'money', 'friends', 'detail', 'profile']) $(id).hidden = true;
  $('tabbar').hidden = true;
  $('auth').hidden = false;
  setAuthMode(S.authMode);
}

function setAuthMode(mode) {
  S.authMode = mode;
  document.querySelectorAll('#auth-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('auth-role').hidden = mode !== 'register';
  $('auth-submit').textContent = mode === 'register' ? 'Konto erstellen' : 'Anmelden';
  $('auth-form').password.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('auth-err').hidden = true;
}

async function onAuth(e) {
  e.preventDefault();
  const f = e.target;
  const btn = $('auth-submit');
  btn.disabled = true;
  const r = await api('POST', S.authMode === 'register' ? '/api/register' : '/api/login',
    { username: f.username.value.trim(), password: f.password.value, role: S.authRole });
  btn.disabled = false;
  if (r.error) { $('auth-err').textContent = r.error; $('auth-err').hidden = false; return; }
  S.token = r.token;
  lsSet('tk', r.token);
  f.reset();
  start();
}

async function start() {
  const r = await api('GET', '/api/me');
  if (r.error) {
    if (!S.token) return;
    toast(r.error, 'err');
    setTimeout(start, 5000);
    return;
  }
  S.me = r.me;
  $('auth').hidden = true;
  $('tabbar').hidden = false;
  restoreOutbox();
  initMap();
  showTab('home');
  renderTopAvatar();
  connectWS();
  startGPS();
  await loadFeed();
  const add = lsGet('pendingAdd');
  if (add) {
    lsSet('pendingAdd', null);
    if (add.toLowerCase() !== S.me.username.toLowerCase()) {
      const res = await call('POST', '/api/friends/request', { username: add });
      if (!res.error) toast(res.status === 'friends' ? `Du bist jetzt mit ${add} befreundet` : `Freundschaftsanfrage an ${add} gesendet`);
    }
  }
}

async function logout(expired = false) {
  if (!expired) await api('POST', '/api/logout');
  S.token = null;
  S.me = null;
  lsSet('tk', null);
  lsSet('outbox', null);
  S.outbox = [];
  S.ws?.close();
  if (S.watch != null) { navigator.geolocation.clearWatch(S.watch); S.watch = null; }
  keepAwake(false);
  closeSheet();
  showAuth();
}

// ── Navigation ────────────────────────────────────────────────────────────────
function showTab(tab) {
  S.tab = tab;
  for (const id of ['home', 'rides', 'money', 'friends']) $(id).hidden = id !== tab;
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'home') { S.map?.invalidateSize(); renderHome(); }
  if (tab === 'rides') loadHistory();
  if (tab === 'money') loadMoney();
  if (tab === 'friends') loadFriends();
}

function onVisible() {
  if (document.hidden || !S.me) return;
  connectWS();
  loadFeed();
  if (S.tab === 'money') loadMoney();
}

function tick() {
  if (!S.me) return;
  flush();
  const cur = currentRide();
  if (cur && isMe(cur.driver)) checkStop();
  if (cur && S.tab === 'home' && $('sheet-bg').hidden) renderHome();
}

// ── Feed ──────────────────────────────────────────────────────────────────────
const currentRide = () => S.feed.rides.find(r => r.id === S.feed.current) || null;
const amDriving = () => { const c = currentRide(); return !!(c && isMe(c.driver)); };

async function loadFeed() {
  const r = await api('GET', '/api/feed');
  if (r.error) return;
  S.feed = r;
  const cur = currentRide();
  keepAwake(!!(cur && isMe(cur.driver)));
  if (!cur || !isMe(cur.driver)) { S.outbox = []; saveOutbox(); }
  syncRouteLine();
  updatePins();
  updateChip();
  $('badge-friends').hidden = !r.requests;
  $('badge-friends').textContent = r.requests;
  $('badge-money').hidden = !r.missingPrice;
  $('badge-money').textContent = '!';
  if (S.tab === 'home') renderHome();
}

function liveCalc(r) {
  const total = r.total_distance || 0;
  const perKm = r.fuel_price && r.consumption ? r.consumption / 100 * r.fuel_price : null;
  const parts = r.participants || [];
  const shares = {};
  let driver = 0;
  parts.forEach(p => { shares[p.id] = 0; });
  if (perKm != null && total > 0) {
    const span = p => [Math.min(p.from_km || 0, total), p.to_km == null ? total : Math.min(p.to_km, total)];
    const cuts = [...new Set([0, total, ...parts.flatMap(span)])].sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1], b = cuts[i];
      const inCar = parts.filter(p => { const [x, y] = span(p); return x <= a && y >= b; });
      const each = (b - a) * perKm / (inCar.length + 1);
      driver += each;
      inCar.forEach(p => { shares[p.id] += each; });
    }
  }
  return { perKm, total: perKm == null ? null : total * perKm, driver, shares };
}

const inCarNow = r => r.participants.filter(p => p.to_km == null);

// ── Home ──────────────────────────────────────────────────────────────────────
function renderHome() {
  if (!S.me) return;
  const f = S.feed;
  const cur = currentRide();
  let h = '';

  if (cur) h += isMe(cur.driver) ? driveCard(cur) : passengerCard(cur);
  else h += idleCard();

  const mineEnded = f.rides.filter(r => isMe(r.driver) && r.status === 'ended' && !r.fuel_price && r.participants.length);
  for (const r of mineEnded.slice(0, 2)) {
    h += `<button class="alert" data-act="ride" data-id="${r.id}">${ICON.pump}<span class="grow">Spritpreis fehlt<small>Fahrt von ${timeStr(r.started_at)} · ${kmNum(r.total_distance)} km</small></span>${ICON.chev}</button>`;
  }
  if (f.missingPrice > mineEnded.length) {
    h += `<button class="alert" data-act="tab" data-tab="money">${ICON.pump}<span class="grow">${f.missingPrice} Fahrten ohne Spritpreis<small>Ohne Preis kann nicht abgerechnet werden</small></span>${ICON.chev}</button>`;
  }
  if (!isStandalone() && !lsGet('installHidden')) {
    h += `<button class="alert ac" data-act="install">${ICON.phone}<span class="grow">Als App installieren<small>Vollbild und zuverlässigere GPS-Erkennung</small></span>${ICON.chev}</button>`;
  }

  const others = f.rides.filter(r => !isMe(r.driver) && r.id !== f.current);
  const active = others.filter(r => r.status === 'active');
  const ended = others.filter(r => r.status === 'ended' && r.ended_at > f.now - JOIN_WINDOW);

  h += `<div class="section"><div class="section-h"><span>Freunde unterwegs</span><span>${active.length || ''}</span></div>`;
  if (!f.friends) {
    h += `<button class="alert ac" data-act="tab" data-tab="friends">${ICON.users}<span class="grow">Füge Freunde hinzu<small>Dann siehst du hier, wer gerade fährt</small></span>${ICON.chev}</button>`;
  } else {
    h += active.length ? active.map(rideRow).join('') : `<div class="empty">Gerade fährt keiner deiner Freunde.</div>`;
  }
  h += '</div>';
  if (ended.length) {
    h += `<div class="section"><div class="section-h"><span>Gerade angekommen</span></div>${ended.map(rideRow).join('')}</div>`;
  }
  $('home-body').innerHTML = h;
}

function idleCard() {
  const name = esc(S.me.username);
  if (S.me.role === 'driver') {
    const sub = S.gps === 'denied'
      ? 'Standort ist blockiert – Fahrten erkennt die App so nicht automatisch.'
      : S.me.auto_start
        ? `Fahr einfach los: ab ${AUTO_KMH} km/h startet die Fahrt automatisch – inklusive der ersten Meter.`
        : 'Automatischer Start ist aus. Starte deine Fahrt per Knopf.';
    return `<div class="hello"><h2>Hi ${name}</h2><p>${sub}</p></div>
      <button class="btn" data-act="start">${ICON.car} Fahrt jetzt starten</button>`;
  }
  return `<div class="hello"><h2>Hi ${name}</h2><p>Sobald ein Freund losfährt, siehst du ihn hier und auf der Karte. Mit einem Tipp fährst du mit – sitzt du schon im Auto, fragt dich die App von selbst.</p></div>`;
}

function driveCard(r) {
  const c = liveCalc(r);
  const people = inCarNow(r);
  const speed = S.pos && nowS() - S.pos.ts < 20 ? Math.round(S.pos.kmh) : 0;
  const per = c.total != null ? c.total / (people.length + 1) : null;
  return `<div class="live-head">Live · seit ${timeStr(r.started_at)}</div>
    <div class="live-title">Du fährst</div>
    <div class="stats">
      <div class="stat hi"><b>${kmNum(r.total_distance)}<small>km</small></b><span>Strecke</span></div>
      <div class="stat"><b>${durShort(nowS() - r.started_at)}<small>${nowS() - r.started_at >= 3600 ? 'h' : 'min'}</small></b><span>Dauer</span></div>
      <div class="stat"><b>${speed}<small>km/h</small></b><span>Tempo</span></div>
    </div>
    <div class="people">
      ${people.length ? avStack(people) : ''}
      <div class="grow">${people.length ? `${people.length} Mitfahrer · ${per != null ? `je ~${eur(per)}` : 'Preis fehlt'}` : 'Noch keine Mitfahrer'}</div>
      <button class="pill ghost" data-act="add-part" data-id="${r.id}">+ Mitfahrer</button>
    </div>
    <button class="btn" data-act="end" data-id="${r.id}">Fahrt beenden</button>
    <button class="link" data-act="discard" data-id="${r.id}">Fehlstart? Fahrt verwerfen</button>`;
}

function passengerCard(r) {
  const c = liveCalc(r);
  const mine = r.my_part;
  const share = mine ? c.shares[mine.id] : null;
  const others = inCarNow(r).filter(p => !isMe({ id: p.user_id }));
  return `<div class="live-head">Live · ${esc(r.driver.username)} fährt</div>
    <div class="live-title">Du fährst mit</div>
    <div class="stats">
      <div class="stat hi"><b>${kmNum(r.total_distance - (mine?.from_km || 0))}<small>km</small></b><span>Deine Strecke</span></div>
      <div class="stat"><b>${durShort(nowS() - r.started_at)}<small>${nowS() - r.started_at >= 3600 ? 'h' : 'min'}</small></b><span>Dauer</span></div>
      <div class="stat"><b>${share != null ? dec(share, 2) : '–'}<small>€</small></b><span>Dein Anteil</span></div>
    </div>
    <div class="people">${av(r.driver, 28)}${others.length ? avStack(others) : ''}<div class="grow">${esc(r.driver.username)}${others.length ? ` + ${others.length}` : ''}</div>
      <button class="pill ghost" data-act="ride" data-id="${r.id}">Details</button></div>
    <button class="btn ghost" data-act="leave" data-id="${r.id}">Ich bin ausgestiegen</button>`;
}

function rideRow(r) {
  const n = r.participants.length;
  const near = r.status === 'active' && S.pos && r.last_lat != null && meters(S.pos, { lat: r.last_lat, lng: r.last_lng }) < NEAR_M;
  let sub, btn;
  if (r.status === 'active') {
    sub = `seit ${dur(S.feed.now - r.started_at)} · ${kmNum(r.total_distance)} km${n ? ` · ${n} Mitfahrer` : ''}`;
    btn = r.joined ? '<span class="pill done">Dabei</span>' : `<button class="pill" data-act="join" data-id="${r.id}">Mitfahren</button>`;
  } else {
    const left = Math.max(0, Math.ceil((r.ended_at + JOIN_WINDOW - S.feed.now) / 60));
    sub = `angekommen ${timeStr(r.ended_at)} · ${kmNum(r.total_distance)} km · noch ${left} min`;
    btn = r.joined ? '<span class="pill done">Dabei</span>' : `<button class="pill ghost" data-act="join" data-id="${r.id}">Ich war dabei</button>`;
  }
  return `<div class="row tap" data-act="ride" data-id="${r.id}">
    ${av(r.driver, 44)}
    <div class="grow"><b class="ell">${esc(r.driver.username)}</b><small class="ell">${sub}</small>${near ? '<span class="near">In deiner Nähe</span>' : ''}</div>
    ${btn}</div>`;
}

// ── Map ───────────────────────────────────────────────────────────────────────
function initMap() {
  if (S.map || !window.L) return;
  S.map = L.map('map', { zoomControl: false, attributionControl: true }).setView([51.16, 10.45], 6);
  L.tileLayer(TILES, { attribution: ATTR, maxZoom: 19 }).addTo(S.map);
  S.map.on('dragstart', () => { S.follow = false; });
}

function centerOn(lat, lng, zoom) {
  if (!S.map) return;
  const z = zoom || Math.max(S.map.getZoom(), 15);
  const off = ($('home-sheet').offsetHeight || 0) / 2 - 30;
  const p = S.map.project([lat, lng], z).add([0, off]);
  S.map.setView(S.map.unproject(p, z), z, { animate: true });
}

function moveMe() {
  if (!S.map || !S.pos) return;
  const ll = [S.pos.lat, S.pos.lng];
  if (!S.meMarker) {
    S.meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 1000, interactive: false }).addTo(S.map);
    centerOn(ll[0], ll[1], 15);
  } else S.meMarker.setLatLng(ll);
  if (S.follow && S.tab === 'home') centerOn(ll[0], ll[1]);
}

function updatePins() {
  if (!S.map) return;
  const seen = new Set();
  for (const r of S.feed.rides) {
    if (r.status !== 'active' || isMe(r.driver) || r.last_lat == null) continue;
    seen.add(r.id);
    const icon = L.divIcon({
      className: '', iconSize: [34, 34], iconAnchor: [17, 17],
      html: `<div class="car-pin">${av(r.driver, 34)}<span>${esc(r.driver.username)} · ${Math.round(r.last_speed || 0)} km/h</span></div>`,
    });
    let m = S.pins.get(r.id);
    if (!m) {
      const id = r.id;
      m = L.marker([r.last_lat, r.last_lng], { icon }).addTo(S.map).on('click', () => openDetail(id));
      S.pins.set(r.id, m);
    } else {
      m.setLatLng([r.last_lat, r.last_lng]);
      m.setIcon(icon);
    }
  }
  for (const [id, m] of S.pins) if (!seen.has(id)) { m.remove(); S.pins.delete(id); }
}

async function syncRouteLine() {
  const cur = currentRide();
  if ((cur?.id || null) === S.routeRide) return;
  S.route?.remove();
  S.route = null;
  S.routeRide = cur?.id || null;
  if (!cur || !S.map) return;
  const d = await api('GET', `/api/rides/${cur.id}`);
  if (d.error || S.routeRide !== cur.id) return;
  S.route = L.polyline(d.points, { color: '#C8F03C', weight: 5, opacity: .9 }).addTo(S.map);
}

function updateChip() {
  const c = $('gps-chip');
  if (amDriving()) { c.className = 'chip drive'; c.textContent = 'Fahrt läuft'; return; }
  const map = { off: ['warn', 'GPS startet …'], ok: ['ok', 'GPS aktiv'], weak: ['warn', 'Schwaches GPS'], denied: ['bad', 'Standort blockiert'], none: ['bad', 'Kein GPS'] };
  const [cls, txt] = map[S.gps] || map.off;
  c.className = 'chip ' + cls;
  c.textContent = txt;
}

// ── GPS & ride detection ──────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) { S.gps = 'none'; updateChip(); return; }
  if (S.watch != null) return;
  S.watch = navigator.geolocation.watchPosition(onPos, e => {
    S.gps = e.code === 1 ? 'denied' : 'weak';
    updateChip();
    if (e.code === 1 && S.tab === 'home') renderHome();
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

function onPos(p) {
  const c = p.coords;
  const ts = (p.timestamp || Date.now()) / 1000;
  const here = { lat: c.latitude, lng: c.longitude };
  S.gps = c.accuracy > 80 ? 'weak' : 'ok';
  updateChip();
  let kmh = c.speed != null && c.speed >= 0 ? c.speed * 3.6 : null;
  if (kmh == null) {
    // Device gave no speed: derive it against a reference point at least 2 s old
    if (S.ref && ts - S.ref.ts >= 2) {
      const d = meters(S.ref, here);
      kmh = d > Math.max(c.accuracy || 0, 10) ? d / (ts - S.ref.ts) * 3.6 : 0;
      S.ref = { ...here, ts };
    } else {
      if (!S.ref) S.ref = { ...here, ts };
      kmh = S.pos?.kmh || 0;
    }
  }
  S.pos = { ...here, ts, kmh, acc: c.accuracy };
  moveMe();
  if (c.accuracy > 80) return;

  const pt = { lat: here.lat, lng: here.lng, speed: Math.round(S.pos.kmh * 10) / 10, ts: Math.round(ts) };
  S.buf.push(pt);
  while (S.buf.length && S.buf[0].ts < ts - 600) S.buf.shift();

  const cur = currentRide();
  if (cur && isMe(cur.driver)) {
    S.outbox.push(pt);
    saveOutbox();
    S.route?.addLatLng([pt.lat, pt.lng]);
  } else if (!cur) {
    detect();
  }
}

async function detect() {
  if (S.prompting || nowS() < S.suppressUntil || !S.me) return;
  const t = nowS();
  const win = S.buf.filter(p => p.ts >= t - AUTO_SECS);
  if (win.length < 4 || win[win.length - 1].ts - win[0].ts < AUTO_SECS - 5) return;
  const speeds = win.map(p => p.speed).sort((a, b) => a - b);
  if (speeds[Math.floor(speeds.length / 2)] < AUTO_KMH || speeds[0] < AUTO_KMH / 2) return;

  S.prompting = true;
  let keep = false;
  try {
    await loadFeed();
    if (currentRide()) return;
    const near = nearbyRide();
    if (near && !near.joined) { promptJoin(near); keep = true; return; }
    if (S.me.role === 'driver' && S.me.auto_start) await autoStart();
    else S.suppressUntil = t + 600;
  } finally {
    if (!keep) S.prompting = false;
  }
}

function nearbyRide() {
  if (!S.pos) return null;
  let best = null, bestD = NEAR_M;
  for (const r of S.feed.rides) {
    if (r.status !== 'active' || isMe(r.driver) || r.last_lat == null || S.feed.now - (r.last_seen || 0) > 120) continue;
    const d = meters(S.pos, { lat: r.last_lat, lng: r.last_lng });
    if (d < bestD) { best = r; bestD = d; }
  }
  return best;
}

function promptJoin(r) {
  const mode = S.feed.now - r.started_at < 300 ? 'start' : 'now';
  openSheet(`<div class="center">${av(r.driver, 72)}</div>
    <h3 class="center">Fährst du bei ${esc(r.driver.username)} mit?</h3>
    <p class="center">Ihr seid gerade gemeinsam unterwegs. Wenn du beitrittst, wird dein Anteil am Sprit automatisch berechnet.</p>
    <button class="btn" data-act="join-mode" data-id="${r.id}" data-mode="${mode}">Ja, ich fahre mit</button>
    ${S.me.role === 'driver' ? '<button class="btn ghost" data-act="prompt-self">Nein, ich fahre selbst</button>' : ''}
    <button class="link" data-act="close">Ignorieren</button>`,
  () => { S.prompting = false; S.suppressUntil = nowS() + 600; });
}

// Upload the route from the moment the car started rolling, not from when detection fired.
function departurePoints() {
  const b = S.buf;
  let i = b.length - 1;
  while (i > 0 && b[i - 1].speed >= 8) i--;
  return b.slice(Math.max(0, i - 1));
}

async function autoStart() {
  const r = await api('POST', '/api/rides', { auto: true, points: departurePoints() });
  if (r.error) { S.suppressUntil = nowS() + 120; return; }
  S.stillSince = null;
  await loadFeed();
  toast('Fahrt automatisch gestartet', '', { label: 'Rückgängig', fn: () => discardRide(r.ride.id) });
  notify('Fahrt gestartet', 'TankiGeldi zeichnet deine Strecke auf.');
}

function checkStop() {
  const t = nowS();
  const moving = S.pos && S.pos.kmh >= 5 && t - S.pos.ts < 30;
  if (moving) { S.stillSince = null; return; }
  if (S.stillSince == null) S.stillSince = t;
  if (t - S.stillSince > STOP_SECS && !S.ending) {
    const cur = currentRide();
    if (cur) endRide(cur.id, true);
  }
}

// ── Sending GPS ───────────────────────────────────────────────────────────────
function saveOutbox() {
  const cur = currentRide();
  lsSet('outbox', S.outbox.length && cur ? JSON.stringify({ rideId: cur.id, pts: S.outbox.slice(-3000) }) : null);
}

function restoreOutbox() {
  try {
    const o = JSON.parse(lsGet('outbox') || 'null');
    if (o?.pts?.length) { S.outbox = o.pts; S.outboxRide = o.rideId; }
  } catch { /* corrupt storage */ }
}

async function flush() {
  const cur = currentRide();
  if (!cur || !isMe(cur.driver) || !S.outbox.length) return;
  if (S.outboxRide) {
    const stale = S.outboxRide !== cur.id;
    S.outboxRide = null;
    if (stale) { S.outbox = []; saveOutbox(); return; }
  }
  if (S.inflight && Date.now() - S.inflight.at < 10000) return;
  const batch = S.outbox.slice(0, 500);
  const seq = ++S.seq;
  S.inflight = { seq, n: batch.length, at: Date.now() };
  if (S.ws?.readyState === 1) {
    S.ws.send(JSON.stringify({ type: 'points', rideId: cur.id, points: batch, seq }));
  } else {
    const r = await api('POST', `/api/rides/${cur.id}/points`, { points: batch });
    if (r.error) S.inflight = null;
    else ack(seq, r.total_distance);
  }
}

function ack(seq, dist) {
  if (S.inflight?.seq !== seq) return;
  S.outbox.splice(0, S.inflight.n);
  S.inflight = null;
  saveOutbox();
  const cur = currentRide();
  if (cur && dist != null) cur.total_distance = dist;
}

// ── Realtime ──────────────────────────────────────────────────────────────────
function connectWS() {
  if (!S.token || (S.ws && S.ws.readyState < 2)) return;
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: S.token }));
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onWS(m); };
  ws.onclose = () => { if (S.ws === ws) S.ws = null; if (S.token) setTimeout(connectWS, 4000); };
}

function onWS(m) {
  if (m.type === 'ack') return ack(m.seq, m.dist);
  if (m.type === 'pos') {
    const r = S.feed.rides.find(x => x.id === m.rideId);
    if (r) Object.assign(r, { last_lat: m.lat, last_lng: m.lng, last_speed: m.speed, total_distance: m.dist, last_seen: S.feed.now });
    updatePins();
    if (r && r.id === S.feed.current && !isMe(r.driver)) S.route?.addLatLng([m.lat, m.lng]);
    if (S.detail?.ride.id === m.rideId) {
      S.detail.ride.total_distance = m.dist;
      S.dline?.addLatLng([m.lat, m.lng]);
    }
    return;
  }
  if (m.type === 'ride_started') {
    toast(`${m.driver} fährt los`, '', { label: 'Ansehen', fn: () => openDetail(m.rideId) });
    notify(`${m.driver} fährt los`, 'Tippe hier, um mitzufahren.');
  } else if (m.msg) {
    toast(m.msg);
    notify('TankiGeldi', m.msg);
  }
  if (/^ride_/.test(m.type)) {
    loadFeed();
    if (S.detail?.ride.id === m.rideId) m.type === 'ride_deleted' ? closeDetail() : openDetail(m.rideId, true);
    if (S.tab === 'rides') loadHistory();
  }
  if (/^friend_/.test(m.type)) { loadFeed(); if (S.tab === 'friends') loadFriends(); }
  if (m.type === 'balance' || m.type === 'ride_ended') { if (S.tab === 'money') loadMoney(); }
}

async function notify(title, body) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', tag: 'tanki-' + title });
  } catch { /* notifications unsupported */ }
}

async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  if (on && !S.wake && !document.hidden) {
    try {
      S.wake = await navigator.wakeLock.request('screen');
      S.wake.addEventListener('release', () => { S.wake = null; });
    } catch { /* denied or not visible */ }
  } else if (!on && S.wake) {
    S.wake.release().catch(() => {});
    S.wake = null;
  }
}

// ── Ride actions ──────────────────────────────────────────────────────────────
async function startRide() {
  const r = await call('POST', '/api/rides', { points: [] });
  if (r.error) return;
  S.stillSince = null;
  await loadFeed();
  toast('Gute Fahrt! Die Strecke wird aufgezeichnet.');
}

async function endRide(id, auto = false) {
  if (S.ending) return;
  S.ending = true;
  const pts = S.outbox.splice(0);
  S.inflight = null;
  saveOutbox();
  const r = await api('POST', `/api/rides/${id}/end`, { points: pts });
  S.ending = false;
  if (r.error) { S.outbox.unshift(...pts); toast(r.error, 'err'); return; }
  S.stillSince = null;
  S.suppressUntil = nowS() + 180;
  keepAwake(false);
  await loadFeed();
  toast(auto ? 'Fahrt automatisch beendet' : 'Fahrt beendet – prüfe kurz Preis und Mitfahrer');
  if (auto) notify('Fahrt beendet', 'Prüfe kurz Spritpreis und Mitfahrer.');
  openDetail(id);
}

async function discardRide(id) {
  const r = await call('DELETE', `/api/rides/${id}`, null, 'Fahrt verworfen');
  if (r.error) return;
  S.outbox = [];
  saveOutbox();
  S.suppressUntil = nowS() + 900;
  closeDetail();
  loadFeed();
}

async function joinRide(id, mode) {
  const cur = currentRide();
  if (cur && isMe(cur.driver) && cur.status === 'active') {
    confirmSheet('Eigene Fahrt verwerfen?',
      `Du hast gerade eine eigene Fahrt laufen (${kmNum(cur.total_distance)} km). Um mitzufahren, wird sie verworfen.`,
      'Verwerfen & mitfahren', async () => {
        const d = await call('DELETE', `/api/rides/${cur.id}`);
        if (!d.error) { S.outbox = []; saveOutbox(); await joinRide(id, mode); }
      }, true);
    return;
  }
  const r = await call('POST', `/api/rides/${id}/join`, { mode }, 'Du fährst mit!');
  if (r.error) return;
  closeSheet();
  await loadFeed();
  if (S.detail?.ride.id === id) openDetail(id, true);
}

function askJoin(id) {
  const r = S.feed.rides.find(x => x.id === id) || S.detail?.ride;
  if (!r) return;
  if (r.status !== 'active') return joinRide(id, 'start');
  openSheet(`<div class="center">${av(r.driver, 64)}</div>
    <h3 class="center">Mit ${esc(r.driver.username)} fahren</h3>
    <p class="center">Seit wann sitzt du im Auto? Du zahlst nur für die Strecke, auf der du dabei warst.</p>
    <button class="btn" data-act="join-mode" data-id="${id}" data-mode="start">Von Anfang an</button>
    <button class="btn ghost" data-act="join-mode" data-id="${id}" data-mode="now">Ich steige jetzt ein (ab km ${kmNum(r.total_distance)})</button>`);
}

async function leaveRide(id) {
  const r = await call('POST', `/api/rides/${id}/leave`, null, 'Ausgestiegen – dein Anteil steht fest');
  if (r.error) return;
  S.suppressUntil = nowS() + 900;
  await loadFeed();
  if (S.detail?.ride.id === id) openDetail(id, true);
}

// ── Ride detail ───────────────────────────────────────────────────────────────
async function openDetail(id, silent = false) {
  const d = await api('GET', `/api/rides/${id}`);
  if (d.error) { if (!silent) toast(d.error, 'err'); return; }
  S.detail = d;
  $('detail').hidden = false;
  renderDetail();
  drawDetailMap();
}

function closeDetail() {
  $('detail').hidden = true;
  S.detail = null;
  S.dline = null;
}

function drawDetailMap() {
  if (!window.L) return;
  if (!S.dmap) {
    S.dmap = L.map('detail-map', { zoomControl: false, attributionControl: true });
    L.tileLayer(TILES, { attribution: ATTR, maxZoom: 19 }).addTo(S.dmap);
    S.dlayer = L.layerGroup().addTo(S.dmap);
  }
  S.dmap.invalidateSize();
  S.dlayer.clearLayers();
  const { points, ride } = S.detail;
  if (points.length) {
    S.dline = L.polyline(points, { color: '#C8F03C', weight: 5, opacity: .95 }).addTo(S.dlayer);
    L.marker(points[0], { icon: L.divIcon({ className: '', html: '<div class="pin-start"></div>', iconSize: [14, 14] }), interactive: false }).addTo(S.dlayer);
    if (ride.status === 'ended') {
      L.marker(points[points.length - 1], { icon: L.divIcon({ className: '', html: '<div class="pin-end"></div>', iconSize: [14, 14] }), interactive: false }).addTo(S.dlayer);
    }
    S.dmap.fitBounds(S.dline.getBounds(), { padding: [40, 40], maxZoom: 16 });
  } else if (S.pos) {
    S.dmap.setView([S.pos.lat, S.pos.lng], 14);
  } else {
    S.dmap.setView([51.16, 10.45], 6);
  }
}

function renderDetail() {
  const { ride: r, calc, joinable } = S.detail;
  const driver = isMe(r.driver);
  const unit = fuelUnit(r.fuel_type);
  const end = r.ended_at || S.feed.now || nowS();
  const secs = end - r.started_at;
  const avg = secs > 60 ? r.total_distance / (secs / 3600) : 0;
  const mine = r.my_part;
  const live = r.status === 'active';

  let h = `<div class="d-date">${dateStr(r.started_at)} · ${timeStr(r.started_at)}${r.ended_at ? '–' + timeStr(r.ended_at) : ' · live'}</div>
    <div class="d-title">${driver ? 'Deine Fahrt' : `Fahrt mit ${esc(r.driver.username)}`}</div>
    <div class="stats">
      <div class="stat"><b>${kmNum(r.total_distance)}<small>km</small></b><span>Strecke</span></div>
      <div class="stat"><b>${durShort(secs)}<small>${secs >= 3600 ? 'h' : 'min'}</small></b><span>Dauer</span></div>
      <div class="stat"><b>${Math.round(avg)}<small>km/h</small></b><span>Schnitt</span></div>
    </div>`;

  h += `<div class="cost-card"><div class="cost-top"><div>
      <div class="section-h"><span>${live ? 'Kosten bisher' : 'Spritkosten'}</span></div>
      ${calc.totalCost != null ? `<div class="cost-big">${eur(calc.totalCost)}</div>` : '<div class="cost-big missing">Preis fehlt</div>'}
    </div>${driver ? `<button class="pill ghost" data-act="edit-price">${calc.totalCost != null ? 'Ändern' : 'Eintragen'}</button>` : ''}</div>
    <div class="cost-meta"><span>${(FUEL[r.fuel_type] || FUEL.benzin).label}</span><span><b>${price(r.fuel_price, unit)}</b></span><span><b>${dec(r.consumption)}</b> ${unit}/100 km</span></div>
    ${calc.totalCost == null && !driver ? `<p class="note">${esc(r.driver.username)} muss noch den Spritpreis eintragen.</p>` : ''}
  </div>`;

  h += `<div class="section"><div class="section-h"><span>Im Auto</span><span>Anteil</span></div>
    <div class="row">${av(r.driver, 40)}<div class="grow"><b>${driver ? 'Du' : esc(r.driver.username)}</b><small>Fahrer · zahlt seinen Anteil selbst</small></div>
      <div class="amount">${calc.driverShare != null ? eur(calc.driverShare) : '–'}</div></div>`;
  for (const p of r.participants) {
    const self = mine && p.id === mine.id;
    const seg = [p.from_km > 0.05 ? `ab km ${kmNum(p.from_km)}` : '', p.to_km != null ? `bis km ${kmNum(p.to_km)}` : ''].filter(Boolean).join(' ');
    const share = p.live_share;
    let right = `<div class="amount">${share != null ? eur(share) : '–'}</div>`;
    if (!live && share > 0 && (driver || self)) {
      right = `<div class="amount">${eur(share)}</div><button class="paid-btn ${p.paid_at ? 'on' : ''}" data-act="paid" data-pid="${p.id}" data-paid="${p.paid_at ? 0 : 1}">${p.paid_at ? 'Bezahlt' : driver ? 'Offen' : 'Zahlen'}</button>`;
    }
    h += `<div class="row">${av(p, 40)}<div class="grow"><b class="ell">${self ? 'Du' : esc(p.username)}${p.guest ? ' <span class="mu">(Gast)</span>' : ''}</b><small>${seg || (live ? 'seit Start dabei' : 'ganze Strecke')}${p.to_km != null && live ? ' · ausgestiegen' : ''}</small></div>
      ${right}${driver && !p.paid_at ? `<button class="x-btn" data-act="rm-part" data-pid="${p.id}" aria-label="Entfernen">${ICON.x}</button>` : ''}</div>`;
  }
  if (!r.participants.length) h += `<div class="empty">${driver ? 'Keine Mitfahrer – du zahlst alles selbst.' : 'Noch keine Mitfahrer.'}</div>`;
  h += '</div>';
  h += `<p class="note">Die Kosten werden pro Streckenabschnitt auf alle aufgeteilt, die gerade im Auto sitzen – der Fahrer zählt mit.</p>`;

  h += '<div style="height:18px"></div>';
  if (driver) {
    if (live) h += `<button class="btn" data-act="end" data-id="${r.id}">Fahrt beenden</button>`;
    h += `<button class="btn ghost" data-act="add-part" data-id="${r.id}">+ Mitfahrer hinzufügen</button>`;
    h += `<button class="link danger" data-act="discard" data-id="${r.id}">Fahrt löschen</button>`;
  } else if (mine) {
    if (live && mine.to_km == null) h += `<button class="btn ghost" data-act="leave" data-id="${r.id}">Ich bin ausgestiegen</button>`;
    else if (!live && joinable && !mine.paid_at) h += `<button class="link danger" data-act="leave" data-id="${r.id}">Ich war doch nicht dabei</button>`;
  } else if (joinable) {
    h += `<button class="btn" data-act="join" data-id="${r.id}">${live ? 'Mitfahren' : 'Ich war dabei'}</button>`;
  }
  $('detail-body').innerHTML = h;
}

function editPriceSheet() {
  const r = S.detail.ride;
  const opts = Object.entries(FUEL).map(([k, v]) => `<option value="${k}" ${k === r.fuel_type ? 'selected' : ''}>${v.label}</option>`).join('');
  const unit = fuelUnit(r.fuel_type);
  openSheet(`<h3>Spritdaten</h3><p>Der Preis von deiner letzten Tankfüllung reicht.</p>
    <label class="field"><span>Kraftstoff</span><select id="p-type">${opts}</select></label>
    <div class="field-row">
      <label class="field"><span>Preis</span><div class="unit-input"><input id="p-price" inputmode="decimal" placeholder="1,799" value="${r.fuel_price ? String(r.fuel_price).replace('.', ',') : ''}"><em>€/${unit}</em></div></label>
      <label class="field"><span>Verbrauch</span><div class="unit-input"><input id="p-cons" inputmode="decimal" placeholder="7,5" value="${r.consumption ? String(r.consumption).replace('.', ',') : ''}"><em>/100 km</em></div></label>
    </div>
    <label class="check"><input type="checkbox" id="p-default" checked> Als Standard für mein Auto speichern</label>
    <div style="height:18px"></div>
    <button class="btn" data-act="save-price">Speichern & neu berechnen</button>`);
}

async function savePrice() {
  const r = S.detail.ride;
  const type = $('p-type').value;
  const body = { fuel_type: type, fuel_price: $('p-price').value.trim(), consumption: $('p-cons').value.trim() || String(FUEL[type].cons) };
  if (!body.fuel_price) return toast('Bitte einen Preis eintragen', 'err');
  const res = await call('PUT', `/api/rides/${r.id}`, body, 'Kosten neu berechnet');
  if (res.error) return;
  if ($('p-default').checked) await saveMe({ fuel_type: body.fuel_type, default_price: body.fuel_price, consumption: body.consumption || null });
  closeSheet();
  openDetail(r.id, true);
  loadFeed();
  if (S.tab === 'money') loadMoney();
}

async function addPartSheet(rideId) {
  const ride = S.feed.rides.find(x => x.id === rideId) || S.detail?.ride;
  const fr = await call('GET', '/api/friends');
  if (fr.error) return;
  const taken = new Set((ride?.participants || []).map(p => p.user_id));
  const list = fr.friends.filter(f => !taken.has(f.id));
  openSheet(`<h3>Mitfahrer hinzufügen</h3><p>Freunde zählen ab Fahrtbeginn mit. Für Leute ohne App kannst du einen Gast eintragen.</p>
    ${list.map(f => `<div class="row">${av(f, 40)}<div class="grow"><b>${esc(f.username)}</b></div><button class="pill" data-act="add-friend-part" data-id="${rideId}" data-uid="${f.id}">Hinzufügen</button></div>`).join('') || '<div class="empty">Alle deine Freunde sind schon dabei.</div>'}
    <label class="field"><span>Gast ohne App</span><input id="guest-name" maxlength="30" placeholder="Name"></label>
    <div style="height:12px"></div>
    <button class="btn ghost" data-act="add-guest" data-id="${rideId}">Gast hinzufügen</button>`);
}

async function afterPartChange(rideId) {
  await loadFeed();
  if (S.detail?.ride.id === rideId) openDetail(rideId, true);
}

// ── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
  const body = $('rides-body');
  const r = await api('GET', '/api/history');
  if (r.error) { body.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  if (!r.rides.length) {
    body.innerHTML = `<div class="empty-big">${ICON.car}<b>Noch keine Fahrten</b>Sobald du fährst oder mitfährst, landet die Strecke hier – mit Karte, Mitfahrern und Kosten.</div>`;
    return;
  }
  let h = '', month = '';
  for (const ride of r.rides) {
    const m = new Date(ride.started_at * 1000).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    if (m !== month) { h += `${month ? '</div>' : ''}<div class="section"><div class="section-h"><span>${m}</span></div>`; month = m; }
    const driver = isMe(ride.driver);
    const c = liveCalc(ride);
    const others = ride.participants.filter(p => !(ride.my_part && p.id === ride.my_part.id));
    let right;
    if (driver) {
      const open = ride.participants.filter(p => p.share_eur > 0 && !p.paid_at).reduce((s, p) => s + p.share_eur, 0);
      right = c.total == null
        ? '<div class="amount" style="color:var(--amber)">Preis<small>fehlt</small></div>'
        : `<div class="amount ${open > 0 ? 'in' : ''}">${eur(c.total)}<small>${open > 0 ? `${eur(open)} offen` : ride.participants.length ? 'alles bezahlt' : 'nur du'}</small></div>`;
    } else {
      const me = ride.my_part;
      right = me?.share_eur == null
        ? '<div class="amount mu">–<small>Preis fehlt</small></div>'
        : `<div class="amount ${me.paid_at ? '' : 'out'}">${eur(me.share_eur)}<small>${me.paid_at ? 'bezahlt' : 'offen'}</small></div>`;
    }
    h += `<div class="row tap" data-act="ride" data-id="${ride.id}">
      ${av(driver ? S.me : ride.driver, 44)}
      <div class="grow"><b class="ell">${driver ? (others.length ? `Du + ${others.map(p => esc(p.username)).join(', ')}` : 'Du allein') : `Mit ${esc(ride.driver.username)}`}</b>
      <small>${dateStr(ride.started_at)}, ${timeStr(ride.started_at)} · ${kmNum(ride.total_distance)} km</small></div>${right}</div>`;
  }
  body.innerHTML = h + '</div>';
}

// ── Money ─────────────────────────────────────────────────────────────────────
async function loadMoney() {
  const body = $('money-body');
  const r = await api('GET', '/api/balances');
  if (r.error) { body.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  let h = `<div class="totals">
    <div class="total in"><span>Du bekommst</span><b>${eur(r.incoming)}</b></div>
    <div class="total out"><span>Du schuldest</span><b>${eur(r.outgoing)}</b></div></div>`;
  for (const m of r.missing) {
    h += `<button class="alert" data-act="ride" data-id="${m.id}">${ICON.pump}<span class="grow">Spritpreis eintragen<small>${dateStr(m.started_at)}, ${timeStr(m.started_at)} · ${kmNum(m.total_distance)} km</small></span>${ICON.chev}</button>`;
  }
  if (!r.balances.length) {
    h += `<div class="empty-big">${ICON.wallet}<b>Alles ausgeglichen</b>Offene Beträge aus gemeinsamen Fahrten erscheinen hier.</div>`;
  } else {
    h += '<div class="section"><div class="section-h"><span>Offen</span></div>';
    for (const b of r.balances) {
      const open = S.openBal.has(b.key);
      const text = b.net > 0 ? `schuldet dir` : b.net < 0 ? 'du schuldest' : 'ausgeglichen';
      h += `<div class="bal ${open ? 'open' : ''}">
        <button class="bal-head" data-act="bal-toggle" data-key="${esc(b.key)}">${av(b.who, 44)}
          <div class="grow"><b class="ell">${esc(b.who.username)}${b.who.guest ? ' <span class="mu">(Gast)</span>' : ''}</b><small>${text} · ${b.items.length} ${b.items.length === 1 ? 'Fahrt' : 'Fahrten'}</small></div>
          <div class="amount ${b.net >= 0 ? 'in' : 'out'}">${eur(Math.abs(b.net))}</div>${ICON.chev}</button>
        ${open ? `<div class="bal-items">${b.items.map(i => `<div class="row">
            <div class="grow tap" data-act="ride" data-id="${i.ride_id}"><b>${dateStr(i.started_at)}</b><small>${kmNum(i.km)} km · ${i.dir === 'in' ? 'bekommst du' : 'zahlst du'}</small></div>
            <div class="amount ${i.dir}">${eur(i.amount)}</div>
            <button class="paid-btn" data-act="paid" data-pid="${i.pid}" data-paid="1">${i.dir === 'in' ? 'Erhalten' : 'Bezahlt'}</button></div>`).join('')}
          <div style="height:10px"></div><button class="btn sm dark" style="width:100%" data-act="settle" data-key="${esc(b.key)}" data-name="${esc(b.who.username)}">Alles ausgleichen (${eur(Math.abs(b.net))})</button></div>` : ''}
      </div>`;
    }
    h += '</div>';
  }
  body.innerHTML = h;
}

// ── Friends ───────────────────────────────────────────────────────────────────
async function loadFriends() {
  const body = $('friends-body');
  const r = await api('GET', '/api/friends');
  if (r.error) { body.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  let h = `<button class="invite" data-act="invite">${ICON.share}<span class="grow"><b>Freunde einladen</b><small>Link schicken – wer ihn öffnet, wird automatisch dein Freund</small></span></button>`;
  if (r.incoming.length) {
    h += `<div class="section"><div class="section-h"><span>Anfragen</span><span>${r.incoming.length}</span></div>`;
    h += r.incoming.map(u => `<div class="row">${av(u, 44)}<div class="grow"><b class="ell">${esc(u.username)}</b><small>möchte mit dir befreundet sein</small></div>
      <button class="pill" data-act="f-accept" data-uid="${u.id}">Annehmen</button><button class="x-btn" data-act="f-decline" data-uid="${u.id}" aria-label="Ablehnen">${ICON.x}</button></div>`).join('');
    h += '</div>';
  }
  h += `<div class="section"><div class="section-h"><span>Deine Freunde</span><span>${r.friends.length || ''}</span></div>`;
  h += r.friends.length
    ? r.friends.map(u => `<div class="row">${av(u, 44)}<div class="grow"><b class="ell">${esc(u.username)}</b><small>${u.active_ride ? '<span style="color:var(--ac)">fährt gerade</span>' : u.role === 'driver' ? 'Fahrer' : 'Mitfahrer'}</small></div>
        ${u.active_ride ? `<button class="pill" data-act="ride" data-id="${u.active_ride}">Ansehen</button>` : ''}
        <button class="x-btn" data-act="f-remove" data-uid="${u.id}" data-name="${esc(u.username)}" aria-label="Entfernen">${ICON.x}</button></div>`).join('')
    : '<div class="empty">Noch keine Freunde. Such oben nach einem Nutzernamen oder schick deinen Einladungslink.</div>';
  h += '</div>';
  if (r.outgoing.length) {
    h += `<div class="section"><div class="section-h"><span>Gesendet</span></div>`;
    h += r.outgoing.map(u => `<div class="row">${av(u, 40)}<div class="grow"><b class="ell">${esc(u.username)}</b><small>wartet auf Bestätigung</small></div>
      <button class="pill ghost" data-act="f-cancel" data-uid="${u.id}">Zurückziehen</button></div>`).join('');
    h += '</div>';
  }
  body.innerHTML = h;
}

function onSearch() {
  clearTimeout(S.searchTimer);
  const term = $('friend-q').value.trim();
  if (term.length < 2) { $('friend-results').innerHTML = ''; return; }
  S.searchTimer = setTimeout(async () => {
    const r = await api('GET', '/api/users/search?q=' + encodeURIComponent(term));
    if (r.error || $('friend-q').value.trim() !== term) return;
    const label = { friends: '<span class="pill done">Freund</span>', sent: '<span class="pill done">Gesendet</span>' };
    $('friend-results').innerHTML = `<div class="section" style="margin-top:8px">${r.users.length
      ? r.users.map(u => `<div class="row">${av(u, 40)}<div class="grow"><b class="ell">${esc(u.username)}</b></div>
          ${label[u.status] || `<button class="pill" data-act="f-add" data-uid="${u.id}">${u.status === 'received' ? 'Annehmen' : 'Hinzufügen'}</button>`}</div>`).join('')
      : '<div class="empty">Niemanden gefunden.</div>'}</div>`;
  }, 300);
}

async function invite() {
  const url = `${location.origin}/?add=${encodeURIComponent(S.me.username)}`;
  const text = `Fahr mit mir auf TankiTankiGeldiGeldi – dann teilen wir den Sprit fair auf:`;
  if (navigator.share) {
    try { await navigator.share({ title: 'TankiTankiGeldiGeldi', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Einladungslink kopiert'); }
  catch { openSheet(`<h3>Einladungslink</h3><p>Kopiere den Link und schick ihn deinen Freunden:</p><label class="field"><input value="${esc(url)}" readonly onfocus="this.select()"></label>`); }
}

// ── Profile ───────────────────────────────────────────────────────────────────
function renderTopAvatar() { $('btn-profile').innerHTML = av(S.me, 44); }

function openProfile() { $('profile').hidden = false; renderProfile(); }

function renderProfile() {
  const m = S.me;
  const unit = fuelUnit(m.fuel_type);
  const opts = Object.entries(FUEL).map(([k, v]) => `<option value="${k}" ${k === m.fuel_type ? 'selected' : ''}>${v.label}</option>`).join('');
  const notifOn = 'Notification' in window && Notification.permission === 'granted';
  let h = `<div class="prof-head"><button class="prof-av" data-act="avatar">${av(m, 76)}<i>${ICON.pen}</i></button>
      <div><h2>${esc(m.username)}</h2><span class="mu">${m.role === 'driver' ? 'Fahrer' : 'Mitfahrer'}</span></div></div>
    <div class="card"><div class="card-h">Wie bist du unterwegs?</div><div style="height:10px"></div>
      <div class="seg"><button class="${m.role === 'driver' ? 'on' : ''}" data-act="role" data-role="driver">Ich fahre</button><button class="${m.role !== 'driver' ? 'on' : ''}" data-act="role" data-role="passenger">Ich fahre mit</button></div>
      <p class="note">${m.role === 'driver' ? 'Deine Fahrten starten automatisch, sobald du schneller als 20 km/h fährst. Sitzt du bei einem Freund im Auto, fragt die App stattdessen, ob du mitfährst.' : 'Du startest keine eigenen Fahrten. Fährst du neben einem Freund her, der eine Fahrt hat, fragt dich die App, ob du mitfährst.'}</p>`;
  if (m.role === 'driver') {
    h += `<div class="switch-row"><div class="grow"><b>Automatisch starten</b><br><small class="mu">Ab ${AUTO_KMH} km/h für ${AUTO_SECS} Sekunden</small></div>
      <label class="switch"><input type="checkbox" id="auto-start" ${m.auto_start ? 'checked' : ''}><i></i></label></div>`;
  }
  h += '</div>';
  if (m.role === 'driver') {
    h += `<div class="card"><div class="card-h">Dein Auto</div>
      <label class="field"><span>Name (optional)</span><input id="car-name" maxlength="40" placeholder="z. B. Golf 7" value="${esc(m.car_name || '')}"></label>
      <label class="field"><span>Kraftstoff</span><select id="car-type">${opts}</select></label>
      <div class="field-row">
        <label class="field"><span>Verbrauch</span><div class="unit-input"><input id="car-cons" inputmode="decimal" placeholder="${String(FUEL[m.fuel_type]?.cons || 7.5).replace('.', ',')}" value="${m.consumption ? String(m.consumption).replace('.', ',') : ''}"><em>/100 km</em></div></label>
        <label class="field"><span>Spritpreis</span><div class="unit-input"><input id="car-price" inputmode="decimal" placeholder="1,799" value="${m.default_price ? String(m.default_price).replace('.', ',') : ''}"><em>€/${unit}</em></div></label>
      </div>
      <span class="hint" style="display:block;margin-top:8px;color:var(--mu);font-size:13px">Mit Preis und Verbrauch rechnet die App schon während der Fahrt. Nach dem Tanken einfach den Preis anpassen.</span>
      <div style="height:14px"></div><button class="btn" data-act="save-car">Speichern</button></div>`;
  }
  h += `<div class="card"><div class="card-h">App</div>
    <div class="row"><div class="grow"><b>Benachrichtigungen</b><small>Wenn Freunde losfahren oder dich hinzufügen</small></div>
      ${!('Notification' in window) ? '<span class="mu">nicht verfügbar</span>' : notifOn ? '<span class="pill done">An</span>' : Notification.permission === 'denied' ? '<span class="mu">blockiert</span>' : '<button class="pill" data-act="notif">Aktivieren</button>'}</div>
    <div class="row"><div class="grow"><b>Vollbild-App</b><small>${isStandalone() ? 'Installiert' : 'Zum Startbildschirm hinzufügen'}</small></div>
      ${isStandalone() ? '<span class="pill done">Aktiv</span>' : '<button class="pill" data-act="install">Anleitung</button>'}</div>
    <div class="row"><div class="grow"><b>Standort</b><small>${S.gps === 'denied' ? 'Blockiert – in den Browser-Einstellungen erlauben' : 'Wird nur während deiner eigenen Fahrten an Freunde geteilt'}</small></div></div>
  </div>
  <div style="height:18px"></div>
  <button class="btn danger" data-act="logout">Abmelden</button>
  <div class="version">TankiTankiGeldiGeldi · v2</div>`;
  $('profile-body').innerHTML = h;
}

async function saveMe(patch, msg) {
  const r = await call('PUT', '/api/me', patch, msg);
  if (!r.error) {
    S.me = r.me;
    renderTopAvatar();
    if (!$('profile').hidden) renderProfile();
    if (S.tab === 'home') renderHome();
  }
  return r;
}

function avatarSheet() {
  openSheet(`<h3>Profilbild</h3><p>Wähle eine Farbe oder ein Foto.</p>
    <div class="colors">${COLORS.map(c => `<button style="background:${c}" class="${c === S.me.color && !S.me.avatar ? 'on' : ''}" data-act="color" data-c="${c}" aria-label="Farbe"></button>`).join('')}</div>
    <button class="btn" data-act="photo">Foto auswählen</button>
    ${S.me.avatar ? '<button class="btn ghost" data-act="photo-remove">Foto entfernen</button>' : ''}`);
}

function onPhoto(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = async () => {
    const s = 256, c = document.createElement('canvas');
    c.width = c.height = s;
    const k = Math.max(s / img.width, s / img.height);
    const w = img.width * k, h = img.height * k;
    c.getContext('2d').drawImage(img, (s - w) / 2, (s - h) / 2, w, h);
    URL.revokeObjectURL(url);
    const r = await saveMe({ avatar_data: c.toDataURL('image/jpeg', 0.85) }, 'Profilbild gespeichert');
    if (!r.error) closeSheet();
  };
  img.onerror = () => toast('Bild konnte nicht gelesen werden', 'err');
  img.src = url;
}

function installSheet() {
  if (S.installEvt) {
    S.installEvt.prompt();
    S.installEvt.userChoice.finally(() => { S.installEvt = null; renderHome(); });
    return;
  }
  const steps = isIOS
    ? '<ol class="note" style="padding-left:18px;line-height:1.8"><li>Öffne die Seite in <b>Safari</b></li><li>Tippe unten auf <b>Teilen</b> (Quadrat mit Pfeil)</li><li>Wähle <b>Zum Home-Bildschirm</b></li><li>Starte Tanki ab jetzt über das neue Icon</li></ol>'
    : '<ol class="note" style="padding-left:18px;line-height:1.8"><li>Öffne die Seite in <b>Chrome</b></li><li>Tippe oben rechts auf <b>⋮</b></li><li>Wähle <b>App installieren</b> bzw. <b>Zum Startbildschirm hinzufügen</b></li><li>Starte Tanki ab jetzt über das neue Icon</li></ol>';
  openSheet(`<h3>Als App installieren</h3><p>Dann läuft Tanki im Vollbild ohne Browserleiste und erkennt Fahrten zuverlässiger.</p>${steps}
    <p class="note">Wichtig: Wenn du Tanki schon früher hinzugefügt hast, lösch das alte Icon und füge es neu hinzu – sonst bleibt die Browserleiste.</p>
    <div style="height:14px"></div><button class="btn ghost" data-act="install-hide">Nicht mehr anzeigen</button>`);
}

// ── Event delegation ──────────────────────────────────────────────────────────
const ACT = {
  'auth-mode': el => setAuthMode(el.dataset.mode),
  'auth-role': el => { S.authRole = el.dataset.role; document.querySelectorAll('.role-opt').forEach(b => b.classList.toggle('on', b === el)); },
  tab: el => { closeDetail(); $('profile').hidden = true; showTab(el.dataset.tab); },
  close: () => closeSheet(),
  'confirm-yes': async () => { const f = S.confirmFn; S.confirmFn = null; closeSheet(); await f?.(); },
  locate: () => { S.follow = true; if (S.pos) centerOn(S.pos.lat, S.pos.lng, 16); else toast('Noch kein GPS-Signal'); },
  start: () => startRide(),
  end: el => confirmSheet('Fahrt beenden?', 'Danach kannst du noch Spritpreis und Mitfahrer prüfen. Freunde können noch 30 Minuten nachträglich beitreten.', 'Beenden', () => endRide(+el.dataset.id)),
  discard: el => confirmSheet('Fahrt verwerfen?', 'Strecke und Mitfahrer werden gelöscht. Nutze das bei einem Fehlstart oder einer Testfahrt.', 'Verwerfen', () => discardRide(+el.dataset.id), true),
  join: el => askJoin(+el.dataset.id),
  'join-mode': el => { S.prompting = false; joinRide(+el.dataset.id, el.dataset.mode); },
  'prompt-self': () => { closeSheet(); S.suppressUntil = 0; S.prompting = false; autoStart(); },
  leave: el => confirmSheet('Ausgestiegen?', 'Dein Anteil wird bis hierhin berechnet.', 'Ja, ausgestiegen', () => leaveRide(+el.dataset.id)),
  ride: el => openDetail(+el.dataset.id),
  'detail-close': () => closeDetail(),
  'edit-price': () => editPriceSheet(),
  'save-price': () => savePrice(),
  'add-part': el => addPartSheet(+el.dataset.id),
  'add-friend-part': async el => {
    const id = +el.dataset.id;
    const r = await call('POST', `/api/rides/${id}/participants`, { userId: +el.dataset.uid }, 'Hinzugefügt');
    if (!r.error) { closeSheet(); afterPartChange(id); }
  },
  'add-guest': async el => {
    const id = +el.dataset.id;
    const name = $('guest-name').value.trim();
    if (!name) return toast('Bitte einen Namen eintragen', 'err');
    const r = await call('POST', `/api/rides/${id}/participants`, { guestName: name }, `${name} hinzugefügt`);
    if (!r.error) { closeSheet(); afterPartChange(id); }
  },
  'rm-part': el => confirmSheet('Mitfahrer entfernen?', 'Die Kosten werden neu aufgeteilt.', 'Entfernen', async () => {
    const id = S.detail.ride.id;
    const r = await call('DELETE', `/api/rides/${id}/participants/${el.dataset.pid}`);
    if (!r.error) afterPartChange(id);
  }, true),
  paid: async el => {
    const r = await call('POST', `/api/participants/${el.dataset.pid}/paid`, { paid: el.dataset.paid === '1' });
    if (r.error) return;
    if (S.detail) openDetail(S.detail.ride.id, true);
    if (S.tab === 'money') loadMoney();
    if (S.tab === 'rides') loadHistory();
  },
  'bal-toggle': el => { const k = el.dataset.key; S.openBal.has(k) ? S.openBal.delete(k) : S.openBal.add(k); loadMoney(); },
  settle: el => confirmSheet('Alles ausgleichen?', `Alle offenen Beträge mit ${esc(el.dataset.name)} werden als bezahlt markiert.`, 'Ausgleichen', async () => {
    const r = await call('POST', '/api/balances/settle', { key: el.dataset.key }, 'Ausgeglichen');
    if (!r.error) loadMoney();
  }),
  invite: () => invite(),
  'f-add': async el => {
    const r = await call('POST', '/api/friends/request', { userId: +el.dataset.uid });
    if (r.error) return;
    toast(r.status === 'friends' ? 'Ihr seid jetzt befreundet' : 'Anfrage gesendet');
    $('friend-q').value = '';
    $('friend-results').innerHTML = '';
    loadFriends();
    loadFeed();
  },
  'f-accept': async el => { const r = await call('POST', '/api/friends/respond', { userId: +el.dataset.uid, accept: true }, 'Freund hinzugefügt'); if (!r.error) { loadFriends(); loadFeed(); } },
  'f-decline': async el => { const r = await call('POST', '/api/friends/respond', { userId: +el.dataset.uid, accept: false }); if (!r.error) { loadFriends(); loadFeed(); } },
  'f-cancel': async el => { const r = await call('POST', '/api/friends/remove', { userId: +el.dataset.uid }); if (!r.error) loadFriends(); },
  'f-remove': el => confirmSheet(`${esc(el.dataset.name)} entfernen?`, 'Ihr seht dann gegenseitig keine Fahrten mehr. Offene Beträge bleiben bestehen.', 'Entfernen', async () => {
    const r = await call('POST', '/api/friends/remove', { userId: +el.dataset.uid });
    if (!r.error) { loadFriends(); loadFeed(); }
  }, true),
  profile: () => openProfile(),
  'profile-close': () => { $('profile').hidden = true; },
  role: el => saveMe({ role: el.dataset.role }),
  'save-car': () => saveMe({
    car_name: $('car-name').value, fuel_type: $('car-type').value,
    consumption: $('car-cons').value.trim() || null, default_price: $('car-price').value.trim() || null,
  }, 'Gespeichert'),
  avatar: () => avatarSheet(),
  color: async el => { const r = await saveMe({ avatar_color: el.dataset.c, avatar_data: null }); if (!r.error) closeSheet(); },
  photo: () => $('photo-input').click(),
  'photo-remove': async () => { const r = await saveMe({ avatar_data: null }); if (!r.error) closeSheet(); },
  notif: async () => {
    const p = await Notification.requestPermission();
    if (p === 'granted') toast('Benachrichtigungen aktiviert');
    renderProfile();
  },
  install: () => installSheet(),
  'install-hide': () => { lsSet('installHidden', '1'); closeSheet(); renderHome(); },
  logout: () => confirmSheet('Abmelden?', 'Du kannst dich jederzeit wieder anmelden.', 'Abmelden', () => logout(), true),
};

function onClick(e) {
  if (e.target.id === 'sheet-bg') return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
}

function onChange(e) {
  if (e.target.id === 'auto-start') saveMe({ auto_start: e.target.checked });
}

boot();
