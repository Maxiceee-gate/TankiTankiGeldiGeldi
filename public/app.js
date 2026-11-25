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

const fmtIban = s => (s || '').replace(/(.{4})/g, '$1 ').trim();

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
function openSheet(html, onClose = null, tall = false) {
  if (S.sheetClose) { const f = S.sheetClose; S.sheetClose = null; f(); }
  const sh = $('sheet');
  sh.style.transform = '';
  sh.style.transition = '';
  sh.classList.toggle('tall', tall);
  sh.scrollTop = 0;
  sh.innerHTML = `<div class="grab"></div>${html}`;
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

// Popup sheets: swipe down (from the top of their content) to close
function setupSheetSwipe() {
  const sh = $('sheet');
  let mode = null, y0 = 0, dy = 0, lastY = 0, lastT = 0, vel = 0;
  sh.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('input, select, textarea')) { mode = 'off'; return; }
    mode = null; y0 = lastY = e.touches[0].clientY; lastT = performance.now(); dy = 0; vel = 0;
  }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (mode === 'off' || mode === 'scroll') return;
    const y = e.touches[0].clientY, d = y - y0;
    if (mode === null) {
      if (Math.abs(d) < 6) return;
      mode = d > 0 && sh.scrollTop <= 0 ? 'drag' : 'scroll';
      if (mode === 'scroll') return;
      sh.style.transition = 'none';
    }
    e.preventDefault();
    const t = performance.now();
    vel = (y - lastY) / Math.max(t - lastT, 1);
    lastY = y; lastT = t;
    dy = Math.max(0, d);
    sh.style.transform = `translate3d(0,${dy}px,0)`;
  }, { passive: false });
  sh.addEventListener('touchend', () => {
    if (mode !== 'drag') { mode = null; return; }
    mode = null;
    sh.style.transition = 'transform .22s ease-out';
    if (dy > sh.offsetHeight * 0.25 || vel > 0.5) {
      sh.style.transform = 'translate3d(0,100%,0)';
      setTimeout(closeSheet, 200);
    } else sh.style.transform = '';
  });
}

// ── Boot / auth ───────────────────────────────────────────────────────────────
function boot() {
  const qs = new URLSearchParams(location.search);
  const add = qs.get('add');
  if (add) lsSet('pendingAdd', add);
  S.deepLink = qs.get('ride') || qs.get('plan') || qs.get('tab') || qs.get('stations') ? new URLSearchParams(qs) : null;
  if (location.search) history.replaceState(null, '', '/');
  navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open') openDeepLink(new URL(e.data.url, location.origin).searchParams); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  $('friend-q').addEventListener('input', onSearch);
  document.addEventListener('input', e => { if (e.target.id === 'car-q') renderCarList(e.target.value); });
  $('auth-form').addEventListener('submit', onAuth);
  $('photo-input').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); });
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; if (S.tab === 'home') renderHome(); });
  document.addEventListener('visibilitychange', onVisible);
  setInterval(tick, 5000);
  setupSheetSwipe();
  S.homeDrag = makeDraggable($('home-sheet'), () => [150, Math.round(vh() * 0.62), vh() - 76 - safeTop()],
    () => { if (S.follow && S.pos) centerOn(S.pos.lat, S.pos.lng); });
  S.detailDrag = makeDraggable($('detail-sheet'), () => {
    const t = document.querySelector('#detail-body .d-title');
    const head = (t ? t.offsetTop + t.offsetHeight + 14 : 110) + safeInset('bottom');
    return [head, Math.round(vh() * 0.58) + 24, vh() - 64 - safeTop()];
  },
    () => fitDetail());
  setInterval(() => { if (!document.hidden && S.me) loadFeed(); }, 20000);
  if (S.token) start(); else showAuth();
}

function showAuth() {
  for (const id of ['home', 'rides', 'money', 'friends', 'detail', 'profile']) $(id).hidden = true;
  $('tabbar').hidden = true;
  $('auth').hidden = false;
  const inviter = lsGet('pendingAdd');
  const banner = $('invite-banner');
  banner.hidden = !inviter;
  if (inviter) {
    if (S.authMode === 'login') S.authMode = 'register';
    banner.innerHTML = `<b>${esc(inviter)} lädt dich ein</b>
      <p>${isIOS && !isStandalone()
        ? 'Neu hier? Registrier dich unten. Hast du Tanki schon auf dem Startbildschirm? Dann kopier die Einladung, öffne Tanki und tippe bei <b style="display:inline;font:inherit;text-transform:none">Freunde</b> auf „Einladung einfügen“.'
        : 'Registrier dich oder melde dich an – danach seid ihr automatisch befreundet.'}</p>
      ${isIOS && !isStandalone() ? '<button type="button" class="btn ghost" data-act="copy-invite">Einladung kopieren</button>' : ''}`;
  }
  setAuthMode(S.authMode);
}

function parseInvite(text) {
  const t = String(text || '').trim();
  try { const name = new URL(t).searchParams.get('add'); if (name) return name; } catch { /* not a URL */ }
  return /^[\p{L}\p{N}_.-]{2,20}$/u.test(t) ? t : null;
}

async function addInvite(name) {
  if (!name) return toast('Keine gültige Einladung gefunden', 'err');
  if (name.toLowerCase() === S.me.username.toLowerCase()) return toast('Das ist deine eigene Einladung');
  const r = await call('POST', '/api/friends/request', { username: name });
  if (r.error) return;
  toast(r.status === 'friends' ? `Du bist jetzt mit ${name} befreundet` : `Freundschaftsanfrage an ${name} gesendet`);
  closeSheet();
  loadFeed();
  if (S.tab === 'friends') loadFriends();
}

async function pasteInvite() {
  try {
    const text = await navigator.clipboard.readText();
    const name = parseInvite(text);
    if (name) return addInvite(name);
  } catch { /* clipboard read blocked */ }
  openSheet(`<h3>Einladung einfügen</h3><p>Füge den Einladungslink oder den Nutzernamen ein.</p>
    <label class="field"><input id="invite-input" placeholder="Link oder Nutzername" autocapitalize="off"></label>
    <div style="height:14px"></div><button class="btn" data-act="invite-submit">Hinzufügen</button>`);
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
  if (add) { lsSet('pendingAdd', null); addInvite(add); }
  if (S.deepLink) { openDeepLink(S.deepLink); S.deepLink = null; }
  syncPush();
}

function openDeepLink(qs) {
  if (!S.me) { S.deepLink = qs; return; }
  if (qs.get('ride')) openDetail(+qs.get('ride'));
  else if (qs.get('plan')) openPlan(+qs.get('plan'));
  else if (qs.get('stations')) { closeDetail(); showTab('home'); toggleStations(true); }
  else if (qs.get('tab')) { closeDetail(); $('profile').hidden = true; $('user').hidden = true; showTab(qs.get('tab')); }
}

// ── Push notifications ────────────────────────────────────────────────────────
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64ToU8(s) {
  const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const k = await api('GET', '/api/push/key');
  if (k.error) throw new Error(k.error);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(k.key) });
  const r = await api('POST', '/api/push/subscribe', sub.toJSON());
  if (r.error) throw new Error(r.error);
  S.pushOn = true;
}
// Keep the server's subscription current whenever permission was already given
async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try { await subscribePush(); } catch { /* retried on next start */ }
}
async function enablePush() {
  if (!pushSupported()) {
    return toast(isIOS && !isStandalone() ? 'Auf dem iPhone geht das nur in der installierten App vom Startbildschirm' : 'Dieser Browser unterstützt keine Benachrichtigungen', 'err');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Benachrichtigungen wurden nicht erlaubt', 'err');
  try {
    await subscribePush();
    await api('POST', '/api/push/test');
    toast('Benachrichtigungen aktiviert');
  } catch (e) { toast('Aktivieren fehlgeschlagen: ' + e.message, 'err'); }
  if (!$('profile').hidden) renderProfile();
  if (S.tab === 'home') renderHome();
}

// ── Planned rides ─────────────────────────────────────────────────────────────
const whenStr = ts => {
  const d = new Date(ts * 1000), today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  const day = diff === 0 ? 'Heute' : diff === 1 ? 'Morgen' : d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${timeStr(ts)}`;
};

function planRow(p) {
  const mine = isMe(p.driver), joined = p.members.some(isMe), free = p.seats - p.members.length;
  const btn = mine ? '<span class="pill done">Deine</span>'
    : joined ? '<span class="pill done">Dabei</span>'
    : free > 0 ? `<button class="pill" data-act="plan-join" data-id="${p.id}">Mitfahren</button>` : '<span class="pill done">Voll</span>';
  return `<div class="row tap" data-act="plan" data-id="${p.id}">${av(p.driver, 44)}
    <div class="grow"><b class="ell">${mine ? 'Du' : esc(p.driver.username)} → ${esc(p.destination)}</b>
    <small class="ell">${whenStr(p.depart_at)} · ${p.members.length}/${p.seats} Plätze${p.members.length ? ' · ' + p.members.map(m => esc(m.username)).join(', ') : ''}</small></div>${btn}</div>`;
}

function planSheet() {
  const d = new Date(Date.now() + 3600e3);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  openSheet(`<h3>Fahrt planen</h3><p>Deine Freunde bekommen eine Nachricht und können sich anmelden. Wenn du losfährst, sind alle Angemeldeten automatisch dabei.</p>
    <label class="field"><span>Wohin?</span><input id="plan-dest" maxlength="60" placeholder="z. B. München, Uni, Fußballplatz"></label>
    <div class="field-row">
      <label class="field"><span>Abfahrt</span><input id="plan-when" type="datetime-local" value="${local}"></label>
      <label class="field"><span>Freie Plätze</span><input id="plan-seats" type="number" min="1" max="8" value="3" inputmode="numeric"></label>
    </div>
    <label class="field"><span>Notiz (optional)</span><input id="plan-note" maxlength="140" placeholder="z. B. Treffpunkt Bahnhof"></label>
    <div style="height:16px"></div><button class="btn" data-act="plan-save">Freunde benachrichtigen</button>`);
}

async function openPlan(id) {
  const r = await call('GET', `/api/plans/${id}`);
  if (r.error) return;
  const p = r.plan, mine = isMe(p.driver), joined = p.members.some(isMe), free = p.seats - p.members.length;
  openSheet(`<div class="center">${av(p.driver, 64)}</div>
    <h3 class="center">${mine ? 'Du fährst' : esc(p.driver.username) + ' fährt'} nach ${esc(p.destination)}</h3>
    <p class="center">${whenStr(p.depart_at)} · ${free > 0 ? `${free} ${free === 1 ? 'Platz' : 'Plätze'} frei` : 'voll'}${p.note ? `<br>${esc(p.note)}` : ''}</p>
    <div class="section-h"><span>Angemeldet</span><span>${p.members.length}/${p.seats}</span></div>
    ${p.members.map(m => `<div class="row">${av(m, 36)}<div class="grow"><b>${isMe(m) ? 'Du' : esc(m.username)}</b></div></div>`).join('') || '<div class="empty">Noch niemand.</div>'}
    <div style="height:16px"></div>
    ${mine ? `<button class="btn danger" data-act="plan-cancel" data-id="${p.id}">Fahrt absagen</button>`
      : joined ? `<button class="btn ghost" data-act="plan-leave" data-id="${p.id}">Doch nicht mitfahren</button>`
      : free > 0 ? `<button class="btn" data-act="plan-join" data-id="${p.id}">Ich fahre mit</button>` : ''}`);
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
  if (S.gps !== 'ok' || !S.pos || nowS() - S.pos.ts > 60) startGPS(true);
  connectWS();
  loadFeed();
  if (S.tab === 'money') loadMoney();
}

// Switching location off often just stops updates without an error, so probe when updates go quiet
function checkGpsAlive() {
  if (!navigator.geolocation || S.gpsProbing || document.hidden) return;
  if (S.pos && nowS() - S.pos.ts < 25) return;
  if (!S.pos && S.gps !== 'ok') return;
  S.gpsProbing = true;
  navigator.geolocation.getCurrentPosition(p => { S.gpsProbing = false; onPos(p); }, e => {
    S.gpsProbing = false;
    S.gps = e.code === 1 ? 'denied' : 'lost';
    updateChip();
    if (S.tab === 'home') renderHome();
    startGPS(true);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
}

function tick() {
  if (!S.me) return;
  checkGpsAlive();
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
  if (pushSupported() && Notification.permission === 'default' && !lsGet('pushHidden') && (isStandalone() || !isIOS)) {
    h += `<button class="alert ac" data-act="notif">${ICON.phone}<span class="grow">Benachrichtigungen aktivieren<small>Damit du mitbekommst, wenn Freunde losfahren oder eine Fahrt planen</small></span>${ICON.chev}</button>`;
  }
  if (!isStandalone() && !lsGet('installHidden')) {
    h += `<button class="alert ac" data-act="install">${ICON.phone}<span class="grow">Als App installieren<small>Vollbild und zuverlässigere GPS-Erkennung</small></span>${ICON.chev}</button>`;
  }

  const others = f.rides.filter(r => !isMe(r.driver) && r.id !== f.current);
  const active = others.filter(r => r.status === 'active');
  const ended = others.filter(r => r.status === 'ended' && r.ended_at > f.now - JOIN_WINDOW);

  if (f.plans?.length) {
    h += `<div class="section"><div class="section-h"><span>Geplante Fahrten</span><span>${f.plans.length}</span></div>${f.plans.map(planRow).join('')}</div>`;
  }
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
      <button class="btn" data-act="start">${ICON.car} Fahrt jetzt starten</button>
      <button class="btn ghost" data-act="plan-new">Fahrt planen & Freunde fragen</button>
      ${S.me.fuel || S.me.tank_cap ? `<div class="people" style="display:block">${fuelGauge(S.me.fuel, true)}</div>` : ''}
      <button class="link" data-act="tanked">Gerade getankt? Preis aktualisieren (${S.me.default_price ? price(S.me.default_price, fuelUnit(myFuel())).replace(/<\/?sup>/g, '') : 'fehlt'})</button>`;
  }
  return `<div class="hello"><h2>Hi ${name}</h2><p>Sobald ein Freund losfährt, siehst du ihn hier und auf der Karte. Mit einem Tipp fährst du mit – sitzt du schon im Auto, fragt dich die App von selbst.</p></div>
    <button class="btn ghost" data-act="start">${ICON.car} Ich fahre selbst – Fahrt starten</button>
    <button class="btn ghost" data-act="plan-new">Fahrt planen & Freunde fragen</button>`;
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
  let last = null;
  try { last = JSON.parse(lsGet('lastPos') || 'null'); } catch { /* ignore */ }
  S.map = L.map('map', { zoomControl: false, attributionControl: false }).setView(last || [51.16, 10.45], last ? 15 : 6);
  L.tileLayer(TILES, { maxZoom: 19, crossOrigin: true }).addTo(S.map);
  S.map.on('dragstart', () => { S.follow = false; });
}

function centerOn(lat, lng, zoom) {
  if (!S.map) return;
  const z = zoom || Math.max(S.map.getZoom(), 15);
  const off = (S.homeDrag?.visible() || 0) / 2 - 30;
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
  const map = { off: ['warn', 'GPS startet …'], ok: ['ok', 'GPS aktiv'], weak: ['warn', 'Schwaches GPS'], lost: ['bad', 'Kein GPS-Signal'], denied: ['bad', 'Standort blockiert'], none: ['bad', 'Kein GPS'] };
  const [cls, txt] = map[S.gps] || map.off;
  c.className = 'chip ' + cls;
  c.textContent = txt;
}

// ── GPS & ride detection ──────────────────────────────────────────────────────
// Location turned off makes browsers end the watch for good, so restart it until it delivers again.
function startGPS(force = false) {
  if (!navigator.geolocation || !S.me) { if (!navigator.geolocation) { S.gps = 'none'; updateChip(); } return; }
  if (S.watch != null && !force) return;
  if (S.watch != null) navigator.geolocation.clearWatch(S.watch);
  clearTimeout(S.gpsRetry);
  S.watch = navigator.geolocation.watchPosition(onPos, e => {
    S.gps = e.code === 1 ? 'denied' : 'lost';
    updateChip();
    if (S.tab === 'home') renderHome();
    if (e.code !== 3) {
      navigator.geolocation.clearWatch(S.watch);
      S.watch = null;
      clearTimeout(S.gpsRetry);
      S.gpsRetry = setTimeout(startGPS, 5000);
    }
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
  if (S.gpsRetry) { clearTimeout(S.gpsRetry); S.gpsRetry = null; }
  if (!S.lastSaved || Date.now() - S.lastSaved > 20000) { S.lastSaved = Date.now(); lsSet('lastPos', JSON.stringify([here.lat, here.lng])); }
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
  if (m.type === 'ride_started') toast(`${m.driver} fährt los`, '', { label: 'Ansehen', fn: () => openDetail(m.rideId) });
  else if (m.msg) toast(m.msg);
  if (m.type === 'plan') loadFeed();
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

// ── Draggable sheets ──────────────────────────────────────────────────────────
// Bottom sheet with fixed height that slides via transform (GPU-composited, no relayout while dragging).
// Touch drags from anywhere: up expands until full, then content scrolls; down collapses once content is at top.
function makeDraggable(sheet, snaps, onSnap) {
  const zone = sheet.querySelector('.grab-zone');
  const body = sheet.querySelector('#home-body, .detail-body');
  let h = 0, maxH = 0, raf = 0, pending = null;
  let mode = null, startY = 0, startH = 0, lastY = 0, lastT = 0, vel = 0, moved = false, onZone = false;

  const apply = () => { raf = 0; if (pending != null) { sheet.style.transform = `translate3d(0,${maxH - pending}px,0)`; pending = null; } };
  const setH = (nh, anim) => {
    h = nh;
    sheet.classList.toggle('anim', anim);
    pending = nh;
    if (anim) { cancelAnimationFrame(raf); apply(); setTimeout(() => onSnap?.(h), 300); }
    else if (!raf) raf = requestAnimationFrame(apply);
  };
  const layout = () => {
    const s = snaps();
    maxH = s[s.length - 1];
    sheet.style.height = maxH + 'px';
    setH(h ? Math.min(Math.max(h, s[0]), maxH) : s[1], false);
  };
  const snapTo = () => {
    const s = snaps();
    let target;
    if (!moved) target = h >= s[s.length - 1] - 10 ? s[1] : s[s.length - 1];
    else if (Math.abs(vel) > 0.4) target = vel > 0 ? s.find(x => x > h + 10) ?? s[s.length - 1] : [...s].reverse().find(x => x < h - 10) ?? s[0];
    else target = s.reduce((x, y) => Math.abs(y - h) < Math.abs(x - h) ? y : x);
    setH(target, true);
  };
  const begin = y => { startY = lastY = y; lastT = performance.now(); vel = 0; moved = false; startH = h; sheet.classList.remove('anim'); };
  const drag = y => {
    const s = snaps(), t = performance.now();
    vel = (lastY - y) / Math.max(t - lastT, 1);
    lastY = y; lastT = t;
    setH(Math.min(Math.max(startH + startY - y, s[0] - 40), s[s.length - 1]), false);
  };

  sheet.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest('.chart, input, select, textarea')) { mode = 'off'; return; }
    mode = null; onZone = !!e.target.closest('.grab-zone');
    begin(e.touches[0].clientY);
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (mode === 'off' || mode === 'scroll') return;
    const y = e.touches[0].clientY, dy = startY - y;
    if (mode === null) {
      if (Math.abs(dy) < 6) return;
      const atMax = h >= maxH - 2;
      mode = onZone || (dy > 0 && !atMax) || (dy < 0 && body.scrollTop <= 0) ? 'drag' : 'scroll';
      if (mode === 'scroll') return;
      begin(y);
      moved = true;
    }
    e.preventDefault();
    drag(y);
  }, { passive: false });
  sheet.addEventListener('touchend', e => {
    if (mode === 'drag') snapTo();
    else if (mode === null && onZone) { moved = false; snapTo(); e.preventDefault(); }
    mode = null;
  });

  // Mouse: drag via the handle
  zone.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return;
    zone.setPointerCapture(e.pointerId);
    begin(e.clientY);
  });
  zone.addEventListener('pointermove', e => {
    if (!zone.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientY - startY) > 4) moved = true;
    if (moved) drag(e.clientY);
  });
  const end = e => { if (zone.hasPointerCapture(e.pointerId)) { zone.releasePointerCapture(e.pointerId); snapTo(); } };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);

  window.addEventListener('resize', layout);
  layout();
  return {
    reset: () => { const s = snaps(); h = 0; maxH = s[s.length - 1]; sheet.style.height = maxH + 'px'; setH(s[1], false); },
    visible: () => h,
  };
}

const vh = () => window.innerHeight;
const safeTop = () => safeInset('top');
function safeInset(side) {
  const d = document.createElement('div');
  d.style.cssText = `position:fixed;visibility:hidden;height:env(safe-area-inset-${side},0px)`;
  document.body.appendChild(d);
  const h = d.offsetHeight;
  d.remove();
  return h;
}

// ── Ride analysis ─────────────────────────────────────────────────────────────
const SPEED_STOPS = [[0, [92, 225, 230]], [40, [200, 240, 60]], [80, [255, 210, 94]], [120, [255, 138, 91]], [160, [255, 77, 109]]];
function speedColor(v) {
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [v1, c1] = SPEED_STOPS[i];
    if (v <= v1 || i === SPEED_STOPS.length - 1) {
      const [v0, c0] = SPEED_STOPS[i - 1];
      const k = Math.min(Math.max((v - v0) / (v1 - v0), 0), 1);
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(',')})`;
    }
  }
}

function analyze(track) {
  const smp = [];
  let km = 0;
  for (let i = 0; i < track.length; i++) {
    const [lat, lng, sp, ts] = track[i];
    let v = sp;
    if (i > 0) {
      const [pl, pg, , pt] = track[i - 1];
      const d = meters({ lat: pl, lng: pg }, { lat, lng }) / 1000;
      km += d;
      if (!(sp > 0)) v = ts > pt ? d / ((ts - pt) / 3600) : 0;
    }
    smp.push({ lat, lng, km, t: ts, v: Math.min(v || 0, 250) });
  }
  for (let i = 1; i < smp.length - 1; i++) smp[i].vs = (smp[i - 1].v + smp[i].v + smp[i + 1].v) / 3;
  smp.forEach(p => { p.v = Math.round(p.vs ?? p.v); delete p.vs; });

  let standing = 0, moving = 0, movingKm = 0, max = 0, lastB = -1e9, lastA = -1e9;
  const events = [];
  for (let i = 1; i < smp.length; i++) {
    const a = smp[i - 1], b = smp[i], dt = b.t - a.t;
    if (dt <= 0) continue;
    // Standing still stores no points, so a stop shows up as a time gap between two points
    const segKm = b.km - a.km, segV = segKm / (dt / 3600);
    const driveSecs = segV < 3 ? 0 : Math.min(dt, segKm / (Math.max((a.v + b.v) / 2, 5) / 3600));
    standing += dt - driveSecs; moving += driveSecs; movingKm += driveSecs ? segKm : 0;
    max = Math.max(max, b.v);
    if (dt > 8) continue;
    const acc = (b.v - a.v) / 3.6 / dt;
    if (acc < -3.0 && b.t - lastB > 6) { events.push({ type: 'brake', ...b, acc }); lastB = b.t; }
    if (acc > 2.8 && b.t - lastA > 6) { events.push({ type: 'accel', ...b, acc }); lastA = b.t; }
  }
  const total = smp.length ? smp[smp.length - 1].km : 0;
  const brakes = events.filter(e => e.type === 'brake').length;
  const accels = events.length - brakes;
  const per10 = Math.max(total / 10, 0.5);
  const score = Math.round(Math.max(0, Math.min(100, 100 - (brakes * 8 + accels * 5) / per10 - Math.max(0, max - 160) * 0.3)));
  return { smp, total, max, standing, moving, avgMoving: moving > 0 ? movingKm / (moving / 3600) : 0, events, brakes, accels, score };
}

function styleLabel(score) {
  return score >= 85 ? 'Sehr entspannt' : score >= 70 ? 'Entspannt' : score >= 50 ? 'Sportlich' : 'Wild';
}

function statsHtml(an, zones) {
  const zl = { stadt: 'Stadt', land: 'Land', autobahn: 'Autobahn' };
  const zc = { stadt: speedColor(25), land: speedColor(75), autobahn: speedColor(125) };
  const zKm = Object.values(zones || {}).reduce((s, z) => s + z.km, 0) || 1;
  let h = `<div class="section"><div class="section-h"><span>Auswertung</span></div>
    <div class="chart-read" id="chart-read">Finger über den Graph ziehen</div>
    <div class="chart" id="chart"></div>
    <div class="legend"><span>0</span><i></i><span>160+ km/h</span></div>
    <div class="stats" style="margin-top:12px">
      <div class="stat"><b>${Math.round(an.max)}<small>km/h</small></b><span>Max</span></div>
      <div class="stat"><b>${Math.round(an.avgMoving)}<small>km/h</small></b><span>Ø fahrend</span></div>
      <div class="stat"><b>${an.standing < 60 ? Math.round(an.standing) : durShort(an.standing)}<small>${an.standing < 60 ? 's' : an.standing >= 3600 ? 'h' : 'min'}</small></b><span>Standzeit</span></div>
    </div>`;
  if (zones) {
    h += `<div class="cost-card"><div class="zone-bar">${Object.keys(zl).map(k => `<i style="width:${zones[k].km / zKm * 100}%;background:${zc[k]}"></i>`).join('')}</div>
      ${Object.keys(zl).map(k => `<div class="zone-row"><span class="dot" style="background:${zc[k]}"></span><b>${zl[k]}</b><span class="grow mu">${kmNum(zones[k].km)} km · ${dur(zones[k].s)}</span><span>${dec(zones[k].l)} l${zones[k].km > 0.3 ? ` <small class="mu">(${dec(zones[k].l / zones[k].km * 100)}/100)</small>` : ''}</span></div>`).join('')}
    </div>`;
  }
  h += `<div class="cost-card style-card"><div class="score" style="--c:${an.score >= 70 ? 'var(--ac)' : an.score >= 50 ? 'var(--amber)' : 'var(--red)'}"><b>${an.score}</b><small>/100</small></div>
    <div class="grow"><b>${styleLabel(an.score)}</b><small>${an.brakes} starke Bremsungen · ${an.accels} starke Beschleunigungen${an.events.length ? ' – auf der Karte markiert' : ''}</small></div></div>`;
  return h + '</div>';
}

function drawChart() {
  const el = $('chart');
  const an = S.detail?.an;
  if (!el || !an) return;
  const W = el.clientWidth, H = 170, smp = an.smp;
  const vmax = Math.max(60, Math.ceil(an.max / 50) * 50);
  const step = Math.max(1, Math.floor(smp.length / 400));
  const pts = smp.filter((_, i) => i % step === 0 || i === smp.length - 1);
  const x = km => an.total ? km / an.total * W : 0, y = v => H - v / vmax * (H - 8);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.km).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const grid = [];
  for (let v = 50; v < vmax; v += 50) grid.push(`<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${W - 4}" y="${y(v) - 4}" text-anchor="end">${v}</text>`);
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><linearGradient id="cg" x1="0" x2="${W}" y1="0" y2="0" gradientUnits="userSpaceOnUse">${pts.filter((_, i) => i % 8 === 0).map(p => `<stop offset="${(x(p.km) / W).toFixed(3)}" stop-color="${speedColor(p.v)}"/>`).join('')}</linearGradient></defs>
    <g class="grid">${grid.join('')}</g>
    <path d="${line}L${W},${H}L0,${H}Z" fill="url(#cg)" opacity=".18"/>
    <path d="${line}" fill="none" stroke="url(#cg)" stroke-width="2.5" stroke-linejoin="round"/>
    ${an.events.map(e => `<circle cx="${x(e.km)}" cy="${y(e.v)}" r="4" class="ev-${e.type}"/>`).join('')}
    <line id="chart-cur" y1="0" y2="${H}" x1="-10" x2="-10"/>
  </svg>`;
  const move = e => {
    const r = el.getBoundingClientRect();
    const km = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * an.total;
    let lo = 0, hi = smp.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (smp[mid].km < km) lo = mid + 1; else hi = mid; }
    const p = smp[lo];
    const cur = $('chart-cur');
    cur.setAttribute('x1', x(p.km)); cur.setAttribute('x2', x(p.km));
    $('chart-read').innerHTML = `<b style="color:${speedColor(p.v)}">${p.v} km/h</b> · km ${kmNum(p.km)} · ${timeStr(p.t)}`;
    if (S.dmap) {
      if (!S.dcur) S.dcur = L.circleMarker([p.lat, p.lng], { radius: 8, color: '#0B0C0A', weight: 3, fillColor: '#F3F5EF', fillOpacity: 1 });
      S.dcur.setLatLng([p.lat, p.lng]).addTo(S.dlayer);
    }
  };
  el.onpointerdown = e => { el.setPointerCapture(e.pointerId); move(e); };
  el.onpointermove = e => { if (e.buttons || e.pointerType === 'mouse') move(e); };
}

// ── Ride detail ───────────────────────────────────────────────────────────────
async function openDetail(id, silent = false) {
  const d = await api('GET', `/api/rides/${id}`);
  if (d.error) { if (!silent) toast(d.error, 'err'); return; }
  if (!silent || S.detail?.ride.id !== id) S.detailDrag?.reset();
  d.an = d.track && d.track.length >= 5 && d.ride.status === 'ended' ? analyze(d.track) : null;
  S.detail = d;
  S.dcur = null;
  $('detail').hidden = false;
  renderDetail();
  drawDetailMap();
  drawChart();
}

function fitDetail() {
  if (!S.dmap || !S.dline || !S.dline.getLatLngs().length) return;
  S.dmap.invalidateSize();
  const covered = S.detailDrag?.visible() || 0;
  S.dmap.fitBounds(S.dline.getBounds(), { paddingTopLeft: [30, 70], paddingBottomRight: [30, covered + 20], maxZoom: 16 });
}

function closeDetail() {
  $('detail').hidden = true;
  S.detail = null;
  S.dline = null;
}

function drawDetailMap() {
  if (!window.L) return;
  if (!S.dmap) {
    S.dmap = L.map('detail-map', { zoomControl: false, attributionControl: false, preferCanvas: true });
    L.tileLayer(TILES, { maxZoom: 19, crossOrigin: true }).addTo(S.dmap);
    S.dlayer = L.layerGroup().addTo(S.dmap);
  }
  S.dmap.invalidateSize();
  S.dlayer.clearLayers();
  const { points, ride } = S.detail;
  const an = S.detail.an;
  if (an) {
    let run = [an.smp[0]], bucket = Math.round(an.smp[0].v / 10);
    const flush = () => { if (run.length > 1) L.polyline(run.map(p => [p.lat, p.lng]), { color: speedColor(bucket * 10), weight: 6, opacity: 1, interactive: false }).addTo(S.dlayer); };
    for (let i = 1; i < an.smp.length; i++) {
      const p = an.smp[i], b = Math.round(p.v / 10);
      run.push(p);
      if (b !== bucket) { flush(); run = [p]; bucket = b; }
    }
    flush();
    for (const e of an.events) {
      L.circleMarker([e.lat, e.lng], { radius: 6, weight: 2, color: '#0B0C0A', fillColor: e.type === 'brake' ? '#FF6B57' : '#FFC24B', fillOpacity: 1 })
        .bindTooltip(`${e.type === 'brake' ? 'Starke Bremsung' : 'Starke Beschleunigung'} · ${e.v} km/h`).addTo(S.dlayer);
    }
  }
  if (points.length) {
    S.dline = L.polyline(points, { color: '#C8F03C', weight: 5, opacity: an ? 0 : .95, interactive: false }).addTo(S.dlayer);
    L.marker(points[0], { icon: L.divIcon({ className: '', html: '<div class="pin-start"></div>', iconSize: [14, 14] }), interactive: false }).addTo(S.dlayer);
    if (ride.status === 'ended') {
      L.marker(points[points.length - 1], { icon: L.divIcon({ className: '', html: '<div class="pin-end"></div>', iconSize: [14, 14] }), interactive: false }).addTo(S.dlayer);
    }
    fitDetail();
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
    <div class="d-title">${r.name ? esc(r.name) : driver ? 'Deine Fahrt' : `Fahrt mit ${esc(r.driver.username)}`}${driver || mine ? `<button class="x-btn rename" data-act="rename" aria-label="Umbenennen">${ICON.pen}</button>` : ''}</div>
    <div class="stats">
      <div class="stat"><b>${kmNum(r.total_distance)}<small>km</small></b><span>Strecke</span></div>
      <div class="stat"><b>${durShort(secs)}<small>${secs >= 3600 ? 'h' : 'min'}</small></b><span>Dauer</span></div>
      <div class="stat"><b>${Math.round(avg)}<small>km/h</small></b><span>Schnitt</span></div>
    </div>`;

  h += `<div class="cost-card"><div class="cost-top"><div>
      <div class="section-h"><span>${live ? 'Kosten bisher' : 'Spritkosten'}</span></div>
      ${calc.totalCost != null ? `<div class="cost-big">${eur(calc.totalCost)}</div>` : '<div class="cost-big missing">Preis fehlt</div>'}
    </div>${driver ? `<button class="pill ghost" data-act="edit-price">${calc.totalCost != null ? 'Ändern' : 'Eintragen'}</button>` : ''}</div>
    <div class="cost-meta">${r.car ? `<span><b>${esc(r.car)}</b></span>` : ''}<span>${(FUEL[r.fuel_type] || FUEL.benzin).label}</span><span><b>${price(r.fuel_price, unit)}</b></span><span><b>${dec(calc.effConsumption || r.consumption)}</b> ${unit}/100 km${calc.effConsumption ? ' (nach Fahrweise)' : ''}</span></div>
    ${r.price_note ? `<p class="note">Preis von ${esc(r.price_note)}</p>` : ''}
    ${calc.totalCost == null && !driver ? `<p class="note">${esc(r.driver.username)} muss noch den Spritpreis eintragen.</p>` : ''}
  </div>`;

  if (S.detail.an) h += statsHtml(S.detail.an, S.detail.zones);
  h += `<div class="section"><div class="section-h"><span>Im Auto</span><span>Anteil</span></div>
    <div class="row">${av(r.driver, 40)}<div class="grow"><b>${driver ? 'Du' : esc(r.driver.username)}</b><small>Fahrer · zahlt seinen Anteil selbst</small></div>
      <div class="amount">${calc.driverShare != null ? eur(calc.driverShare) : '–'}</div></div>`;
  for (const p of r.participants) {
    const self = mine && p.id === mine.id;
    const seg = [p.from_km > 0.05 ? `ab km ${kmNum(p.from_km)}` : '', p.to_km != null ? `bis km ${kmNum(p.to_km)}` : ''].filter(Boolean).join(' ');
    const share = p.live_share;
    let right = `<div class="amount">${share != null ? eur(share) : '–'}</div>`;
    if (!live && share > 0 && (driver || self)) {
      right = `<div class="amount">${eur(share)}</div>${self && !p.paid_at
        ? '<button class="paid-btn" data-act="pay-ride">Zahlen</button>'
        : `<button class="paid-btn ${p.paid_at ? 'on' : ''}" data-act="paid" data-pid="${p.id}" data-paid="${p.paid_at ? 0 : 1}">${p.paid_at ? 'Bezahlt' : 'Offen'}</button>`}`;
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
  openSheet(`<h3>Spritdaten</h3><p>Trag den Preis ein, den du beim letzten Tanken bezahlt hast.</p>
    <label class="field"><span>Kraftstoff</span><select id="p-type">${opts}</select></label>
    <div class="field-row">
      <label class="field"><span>Preis</span><div class="unit-input"><input id="p-price" inputmode="decimal" placeholder="1,799" value="${r.fuel_price ? String(r.fuel_price).replace('.', ',') : ''}"><em>€/${unit}</em></div></label>
      <label class="field"><span>Verbrauch</span><div class="unit-input"><input id="p-cons" inputmode="decimal" placeholder="7,5" value="${r.consumption ? String(r.consumption).replace('.', ',') : ''}"><em>/100 km</em></div></label>
    </div>
    ${r.car ? `<p class="note">Verbrauch berechnet aus ${esc(r.car)} und deiner Fahrweise. Änderst du ihn, gilt dein Wert.</p>` : ''}
    <label class="check"><input type="checkbox" id="p-default" checked> Preis als Standard speichern</label>
    <div style="height:18px"></div>
    <button class="btn" data-act="save-price">Speichern & neu berechnen</button>`);
}

async function savePrice() {
  const r = S.detail.ride;
  const type = $('p-type').value;
  const body = { fuel_type: type, fuel_price: $('p-price').value.trim() };
  const cons = $('p-cons').value.trim();
  if (cons !== $('p-cons').defaultValue || !r.car) body.consumption = cons || String(FUEL[type].cons);
  if (!body.fuel_price) return toast('Bitte einen Preis eintragen', 'err');
  const res = await call('PUT', `/api/rides/${r.id}`, body, 'Kosten neu berechnet');
  if (res.error) return;
  if ($('p-default').checked) await saveMe(S.me.cons_mode === 'car' ? { default_price: body.fuel_price } : { fuel_type: body.fuel_type, default_price: body.fuel_price, consumption: body.consumption || null });
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
      <div class="grow"><b class="ell">${ride.name ? esc(ride.name) : driver ? (others.length ? `Du + ${others.map(p => esc(p.username)).join(', ')}` : 'Du allein') : `Mit ${esc(ride.driver.username)}`}</b>
      <small>${dateStr(ride.started_at)}, ${timeStr(ride.started_at)} · ${kmNum(ride.total_distance)} km${ride.name ? ` · ${driver ? (others.length ? `mit ${others.map(p => esc(p.username)).join(', ')}` : 'allein') : `mit ${esc(ride.driver.username)}`}` : ''}</small></div>${right}</div>`;
  }
  body.innerHTML = h + '</div>';
}

// ── Money ─────────────────────────────────────────────────────────────────────
async function loadMoney() {
  const body = $('money-body');
  const r = await api('GET', '/api/balances');
  if (r.error) { body.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  S.balances = r.balances;
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
          <div style="height:10px"></div>${b.net < 0 ? `<button class="btn sm" style="width:100%" data-act="pay-bal" data-key="${esc(b.key)}">${eur(-b.net)} bezahlen</button><div style="height:8px"></div>` : ''}<button class="btn sm dark" style="width:100%" data-act="settle" data-key="${esc(b.key)}" data-name="${esc(b.who.username)}">Alles ausgleichen (${eur(Math.abs(b.net))})</button></div>` : ''}
      </div>`;
    }
    h += '</div>';
  }
  h += `<div class="section"><div class="section-h"><span>Monatsabrechnung</span></div><div id="statement"></div></div>`;
  body.innerHTML = h;
  loadStatement();
}

// ── Friends ───────────────────────────────────────────────────────────────────
async function loadFriends() {
  const body = $('friends-body');
  const r = await api('GET', '/api/friends');
  if (r.error) { body.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  let h = `<button class="invite" data-act="invite">${ICON.share}<span class="grow"><b>Freunde einladen</b><small>Link schicken – wer ihn öffnet, wird automatisch dein Freund</small></span></button>
    <button class="btn ghost" style="margin-top:10px" data-act="paste-invite">Einladung einfügen</button>`;
  if (r.incoming.length) {
    h += `<div class="section"><div class="section-h"><span>Anfragen</span><span>${r.incoming.length}</span></div>`;
    h += r.incoming.map(u => `<div class="row">${av(u, 44)}<div class="grow"><b class="ell">${esc(u.username)}</b><small>möchte mit dir befreundet sein</small></div>
      <button class="pill" data-act="f-accept" data-uid="${u.id}">Annehmen</button><button class="x-btn" data-act="f-decline" data-uid="${u.id}" aria-label="Ablehnen">${ICON.x}</button></div>`).join('');
    h += '</div>';
  }
  h += `<div class="section"><div class="section-h"><span>Deine Freunde</span><span>${r.friends.length || ''}</span></div>`;
  h += r.friends.length
    ? r.friends.map(u => `<div class="row tap" data-act="user" data-uid="${u.id}">${av(u, 44)}<div class="grow"><b class="ell">${esc(u.username)}</b><small>${u.active_ride ? '<span style="color:var(--ac)">fährt gerade</span>' : u.role === 'driver' ? 'Fahrer' : 'Mitfahrer'}</small></div>
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
    <button class="invite" data-act="user" data-uid="${m.id}">${ICON.car}<span class="grow"><b>Meine Statistik</b><small>Fahrten, Kilometer, Rekorde und Abzeichen</small></span>${ICON.chev}</button>
    <div class="card"><div class="card-h">Wie bist du unterwegs?</div><div style="height:10px"></div>
      <div class="seg"><button class="${m.role === 'driver' ? 'on' : ''}" data-act="role" data-role="driver">Ich fahre</button><button class="${m.role !== 'driver' ? 'on' : ''}" data-act="role" data-role="passenger">Ich fahre mit</button></div>
      <p class="note">${m.role === 'driver' ? 'Deine Fahrten starten automatisch, sobald du schneller als 20 km/h fährst. Sitzt du bei einem Freund im Auto, fragt die App stattdessen, ob du mitfährst.' : 'Du startest keine eigenen Fahrten. Fährst du neben einem Freund her, der eine Fahrt hat, fragt dich die App, ob du mitfährst.'}</p>`;
  if (m.role === 'driver') {
    h += `<div class="switch-row"><div class="grow"><b>Automatisch starten</b><br><small class="mu">Ab ${AUTO_KMH} km/h für ${AUTO_SECS} Sekunden</small></div>
      <label class="switch"><input type="checkbox" id="auto-start" ${m.auto_start ? 'checked' : ''}><i></i></label></div>`;
  }
  h += '</div>';
  if (m.role === 'driver') {
    const car = m.car;
    h += `<div class="card"><div class="card-h">Dein Auto & Verbrauch</div><div style="height:10px"></div>
      <div class="seg"><button class="${m.cons_mode !== 'car' ? 'on' : ''}" data-act="cons-mode" data-mode="manual">Manuell</button><button class="${m.cons_mode === 'car' ? 'on' : ''}" data-act="cons-mode" data-mode="car">Aus Datenbank</button></div>`;
    if (m.cons_mode === 'car') {
      h += `<button class="row tap" style="width:100%;text-align:left" data-act="car-pick">${ICON.car}<div class="grow"><b>${car ? esc(`${car.brand} ${car.model}`) : 'Auto auswählen'}</b><small>${car ? esc(car.engine) + ' · ' + FUEL[car.fuel].label : 'Marke, Modell und Motor'}</small></div>${ICON.chev}</button>
        ${car ? `<div class="cost-meta" style="margin-top:0"><span>Stadt <b>${dec(car.city)}</b></span><span>Land <b>${dec(car.rural)}</b></span><span>Autobahn <b>${dec(car.motorway)}</b> l/100 km</span><span>Tank <b>${car.tank} l</b></span></div>` : ''}
        <p class="note">Der Verbrauch wird pro Abschnitt aus deinem tatsächlich gefahrenen Tempo berechnet – Stadtverkehr, Landstraße und Autobahn zählen unterschiedlich. Die Werte sind Praxis-Schätzungen.</p>
        <label class="field"><span>Spritpreis</span><div class="unit-input"><input id="car-price" inputmode="decimal" placeholder="1,799" value="${m.default_price ? String(m.default_price).replace('.', ',') : ''}"><em>€/${unit}</em></div></label>
        ${stationBtn(m.car.fuel)}
        <div style="height:14px"></div><button class="btn" data-act="save-car-price">Speichern</button>`;
    } else {
      h += `<label class="field"><span>Name (optional)</span><input id="car-name" maxlength="40" placeholder="z. B. Golf 7" value="${esc(m.car_name || '')}"></label>
      <div class="field-row">
        <label class="field"><span>Kraftstoff</span><select id="car-type">${opts}</select></label>
        <label class="field"><span>Tankgröße</span><div class="unit-input"><input id="car-tank" inputmode="numeric" placeholder="50" value="${m.tank_l || ''}"><em>l</em></div></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Verbrauch</span><div class="unit-input"><input id="car-cons" inputmode="decimal" placeholder="${String(FUEL[m.fuel_type]?.cons || 7.5).replace('.', ',')}" value="${m.consumption ? String(m.consumption).replace('.', ',') : ''}"><em>/100 km</em></div></label>
        <label class="field"><span>Spritpreis</span><div class="unit-input"><input id="car-price" inputmode="decimal" placeholder="1,799" value="${m.default_price ? String(m.default_price).replace('.', ',') : ''}"><em>€/${unit}</em></div></label>
      </div>
      ${stationBtn(m.fuel_type)}
      <p class="note">Fester Verbrauch, egal wie du fährst. Nach dem Tanken einfach den Preis anpassen.</p>
      <div style="height:14px"></div><button class="btn" data-act="save-car">Speichern</button>`;
    }
    if ((m.cons_mode === 'car' ? car?.fuel : m.fuel_type) === 'benzin') {
      h += `<div class="switch-row"><div class="grow"><b>Sorte</b><br><small class="mu">Für automatische Preise von Tankstellen</small></div>
        <div class="seg" style="width:150px"><button class="${m.petrol_grade !== 'e10' ? 'on' : ''}" data-act="grade" data-g="e5">E5</button><button class="${m.petrol_grade === 'e10' ? 'on' : ''}" data-act="grade" data-g="e10">E10</button></div></div>`;
    }
    h += `<p class="note">Zuletzt: ${lastFill()}</p>`;
    h += `<div class="card-h" style="padding-top:10px">Tankstand</div>${fuelGauge(m.fuel, true)}`;
    h += '</div>';
  }
  h += `<div class="card"><div class="card-h">Zahlungsdaten</div>
    <p class="note" style="margin-top:6px">Sehen nur Freunde, die dir Spritgeld schulden – so können sie mit einem Tipp bezahlen.</p>
    <label class="field"><span>Revolut-Nutzername</span><input id="pay-revolut" autocapitalize="off" placeholder="z. B. maxi123 (aus revolut.me/…)" value="${esc(m.revolut || '')}"></label>
    <label class="field"><span>IBAN</span><input id="pay-iban" autocapitalize="characters" placeholder="DE89 3704 0044 0532 0130 00" value="${esc(fmtIban(m.iban))}"></label>
    <label class="field"><span>Kontoinhaber</span><input id="pay-name" placeholder="Vor- und Nachname" value="${esc(m.account_name || '')}"></label>
    <div style="height:14px"></div><button class="btn ghost" data-act="save-pay">Zahlungsdaten speichern</button></div>`;
  h += `<div class="card"><div class="card-h">App</div>
    <div class="row"><div class="grow"><b>Benachrichtigungen</b><small>Wenn Freunde losfahren oder dich hinzufügen</small></div>
      ${!pushSupported() ? `<span class="mu">${isIOS && !isStandalone() ? 'nur in der App' : 'nicht verfügbar'}</span>` : notifOn ? '<button class="pill ghost" data-act="push-test">Testen</button>' : Notification.permission === 'denied' ? '<span class="mu">blockiert</span>' : '<button class="pill" data-act="notif">Aktivieren</button>'}</div>
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

function paySheet(to, pay, amount, pids) {
  S.payPids = pids;
  const ref = `Tanki Sprit ${new Date().toLocaleDateString('de-DE')}`;
  const copyRow = (label, value, show = value) => `<div class="row"><div class="grow"><small>${label}</small><b class="ell" style="user-select:text">${esc(show)}</b></div><button class="pill ghost" data-act="copy" data-v="${esc(value)}">Kopieren</button></div>`;
  let h = `<div class="center">${av(to, 64)}</div><h3 class="center">${eur(amount)} an ${esc(to.username)}</h3>`;
  if (!pay) {
    h += `<p class="center">${esc(to.username)} hat noch keine Zahlungsdaten hinterlegt. Zahl bar oder frag nach PayPal/IBAN – und markier es danach als bezahlt.</p>`;
  } else {
    h += '<p class="center">Bezahl per Revolut oder Überweisung und markier es danach als bezahlt.</p>';
    if (pay.revolut) h += `<a class="btn" href="https://revolut.me/${encodeURIComponent(pay.revolut)}" target="_blank" rel="noopener">Mit Revolut bezahlen</a><div style="height:10px"></div>`;
    h += copyRow('Betrag', amount.toFixed(2).replace('.', ','), eur(amount));
    if (pay.iban) h += copyRow('IBAN', pay.iban, fmtIban(pay.iban)) + copyRow('Empfänger', pay.account_name);
    h += copyRow('Verwendungszweck', ref);
  }
  h += `<div style="height:14px"></div><button class="btn ${pay ? 'ghost' : ''}" data-act="pay-done">Ich habe bezahlt</button>`;
  openSheet(h);
}

async function carPickSheet() {
  if (!S.cars) { const r = await call('GET', '/api/cars'); if (r.error) return; S.cars = r.cars; }
  openSheet(`<h3>Dein Auto</h3><p>Marke, Modell oder Motor eintippen. E-Autos sind nicht dabei – dafür „Manuell“ nutzen.</p>
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="car-q" placeholder="z. B. Golf TDI" autocomplete="off"></div>
    <div id="car-list"></div>
    <p class="note">Dein Auto fehlt? Nimm ein ähnliches Modell mit gleichem Motor oder stell auf „Manuell“.</p>`, null, true);
  renderCarList('');
}

function renderCarList(term) {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  const list = S.cars.filter(c => { const t = `${c.brand} ${c.model} ${c.engine} ${c.fuel}`.toLowerCase(); return words.every(w => t.includes(w)); }).slice(0, 60);
  $('car-list').innerHTML = list.map(c => `<button class="row tap" style="width:100%;text-align:left" data-act="car-set" data-id="${esc(c.id)}">
      <div class="grow"><b>${esc(c.brand)} ${esc(c.model)}</b><small>${esc(c.engine)} · ${FUEL[c.fuel].label}</small></div>
      <div class="amount" style="font-size:16px">${dec(c.combined)}<small>l/100 km</small></div></button>`).join('') || '<div class="empty">Nichts gefunden.</div>';
}

async function allUsersSheet() {
  const r = await call('GET', '/api/users');
  if (r.error) return;
  const label = { friends: '<span class="pill done">Freund</span>', sent: '<span class="pill done">Gesendet</span>' };
  openSheet(`<h3>Alle Nutzer</h3><p>${r.users.length} ${r.users.length === 1 ? 'Person nutzt' : 'Personen nutzen'} Tanki.</p>
    ${r.users.map(u => `<div class="row">${av(u, 40)}<div class="grow"><b class="ell">${esc(u.username)}</b><small>${u.role === 'driver' ? 'Fahrer' : 'Mitfahrer'}</small></div>
      ${label[u.status] || `<button class="pill" data-act="f-add" data-uid="${u.id}">${u.status === 'received' ? 'Annehmen' : 'Hinzufügen'}</button>`}</div>`).join('') || '<div class="empty">Außer dir ist noch niemand angemeldet.</div>'}`);
}

// ── User profile & stats ──────────────────────────────────────────────────────
const DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

async function openUser(id) {
  $('user').hidden = false;
  $('user-body').innerHTML = '<div class="empty">Lädt …</div>';
  const st = await api('GET', `/api/users/${id}/stats`);
  if (st.error) { $('user-body').innerHTML = `<div class="empty">${esc(st.error)}</div>`; return; }
  S.userStats = st;
  $('user-body').innerHTML = statsPage(st);
}

function statsPage(st) {
  const u = st.user, d = st.driven, r = st.ridden, self = isMe(u);
  const rides = d.n + r.n, km = d.km + r.km, secs = d.secs + r.secs;
  const tile = (v, unit, label, hi) => `<div class="stat${hi ? ' hi' : ''}"><b>${v}<small>${unit}</small></b><span>${label}</span></div>`;
  const h = st.hours;
  const slot = h.length ? (() => {
    const c = { Morgens: 0, Mittags: 0, Abends: 0, Nachts: 0 };
    h.forEach(x => { c[x >= 5 && x < 11 ? 'Morgens' : x >= 11 && x < 17 ? 'Mittags' : x >= 17 && x < 22 ? 'Abends' : 'Nachts']++; });
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
  })() : null;
  const night = h.filter(x => x >= 22 || x < 5).length;
  const since = new Date(u.since * 1000).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

  const badges = [
    [km >= 100, '100-km-Club', 'Über 100 km unterwegs'],
    [km >= 1000, 'Tausender', 'Über 1.000 km unterwegs'],
    [rides >= 10, 'Stammgast', '10 Fahrten oder mehr'],
    [st.carried.n >= 10, 'Taxi', '10+ Mitfahrer mitgenommen'],
    [night >= 3, 'Nachteule', '3+ Fahrten nach 22 Uhr'],
    [Math.max(d.longest, r.longest) >= 200, 'Roadtrip', 'Eine Fahrt über 200 km'],
    [st.topSpeed >= 200, 'Raser', 'Über 200 km/h gemessen'],
  ].filter(b => b[0]);

  let html = `<div class="prof-head">${av(u, 76)}<div><h2>${esc(u.username)}</h2>
      <span class="mu">${u.role === 'driver' ? 'Fahrer' : 'Mitfahrer'} · dabei seit ${since}</span>
      ${u.car ? `<div class="mu" style="font-size:13px;margin-top:2px">${ICON.car.replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px"')} ${esc(u.car)}</div>` : ''}</div></div>`;

  if (u.fuel) html += `<div class="card"><div class="card-h">Tank</div>${fuelGauge(u.fuel, false)}</div>`;
  if (st.together) {
    const t = st.together;
    html += `<div class="card"><div class="card-h">${self ? '' : 'Ihr zusammen'}</div><div style="height:10px"></div>
      <div class="stats">${tile(t.n, '', 'Fahrten', true)}${tile(kmNum(t.km), 'km', 'Strecke')}
      ${tile(t.net === 0 ? '0' : dec(Math.abs(t.net), 2), '€', t.net > 0 ? 'schuldet dir' : t.net < 0 ? 'du schuldest' : 'ausgeglichen')}</div>
      ${t.recent.map(x => `<div class="row tap" data-act="ride" data-id="${x.id}"><div class="grow"><b class="ell">${x.name ? esc(x.name) : x.driver_is_them ? `${esc(u.username)} ist gefahren` : 'Du bist gefahren'}</b><small>${dateStr(x.started_at)} · ${kmNum(x.km)} km</small></div>${ICON.chev}</div>`).join('')
      || '<div class="empty">Noch keine gemeinsame Fahrt.</div>'}</div>`;
  }

  html += `<div class="card"><div class="card-h">Gesamt</div><div style="height:10px"></div>
    <div class="stats">${tile(rides, '', 'Fahrten', true)}${tile(kmNum(km), 'km', 'Strecke')}${secs < 3600 ? tile(Math.round(secs / 60), 'min', 'im Auto') : tile(dec(secs / 3600, secs < 36000 ? 1 : 0), 'h', 'im Auto')}</div>
    <div class="stats">${tile(kmNum(Math.max(d.longest, r.longest)), 'km', 'Längste Fahrt')}${tile(st.topSpeed ? Math.round(st.topSpeed) : '–', 'km/h', 'Top-Speed')}${tile(rides ? kmNum(km / rides) : '0', 'km', 'Ø pro Fahrt')}</div></div>`;

  html += `<div class="card"><div class="card-h">Als Fahrer</div><div style="height:10px"></div>
    <div class="stats">${tile(d.n, '', 'Fahrten')}${tile(kmNum(d.km), 'km', 'gefahren')}${tile(st.carried.people, '', 'Leute mitgenommen')}</div>
    <div class="stats">${tile(dec(d.fuel_eur, d.fuel_eur < 100 ? 2 : 0), '€', 'Spritkosten')}${tile(dec(d.liters, d.liters < 100 ? 1 : 0), 'l', 'verbraucht')}${tile(d.km > 0 ? dec(d.liters / d.km * 100) : '–', 'l', 'Ø /100 km')}</div></div>`;

  html += `<div class="card"><div class="card-h">Als Mitfahrer</div><div style="height:10px"></div>
    <div class="stats">${tile(r.n, '', 'Fahrten')}${tile(kmNum(r.km), 'km', 'mitgefahren')}${tile(dec(r.paid_eur, r.paid_eur < 100 ? 2 : 0), '€', 'Spritanteil')}</div></div>`;

  if (rides) {
    html += `<div class="card"><div class="card-h">Gewohnheiten</div>
      ${st.days[0] ? `<div class="row"><div class="grow"><b>Lieblingstag</b><small>${st.days[0].c} von ${rides} ${rides === 1 ? 'Fahrt' : 'Fahrten'}</small></div><b>${DAYS[+st.days[0].d]}</b></div>` : ''}
      ${slot ? `<div class="row"><div class="grow"><b>Meist unterwegs</b><small>nach Startzeit</small></div><b>${slot}</b></div>` : ''}
      ${st.buddy ? `<div class="row tap" data-act="user" data-uid="${st.buddy.id}">${av(st.buddy, 36)}<div class="grow"><b>${esc(st.buddy.username)}</b><small>Am häufigsten zusammen · ${st.buddy.count} ${st.buddy.count === 1 ? 'Fahrt' : 'Fahrten'}</small></div>${ICON.chev}</div>` : ''}
    </div>`;
  }

  html += `<div class="card"><div class="card-h">${self ? 'Deine Fahrten' : `Fahrten von ${esc(u.username)}`}</div>
    ${st.rides.length ? st.rides.map(x => {
      const drove = x.driver.id === u.id;
      const title = x.name ? esc(x.name) : drove ? (self ? 'Selbst gefahren' : `${esc(u.username)} ist gefahren`) : `Mit ${isMe(x.driver) ? 'dir' : esc(x.driver.username)}`;
      return `<div class="row tap" data-act="ride" data-id="${x.id}">${av(x.driver, 36)}<div class="grow"><b class="ell">${title}</b>
        <small>${dateStr(x.started_at)}, ${timeStr(x.started_at)} · ${kmNum(x.km)} km · ${dur(x.ended_at - x.started_at)}${x.people > 1 ? ` · ${x.people} Pers.` : ''}</small></div>${ICON.chev}</div>`;
    }).join('') : '<div class="empty">Noch keine Fahrten, die du sehen kannst.</div>'}</div>`;

  html += `<div class="card"><div class="card-h">Abzeichen</div>
    ${badges.length ? `<div class="badges">${badges.map(b => `<div class="badge-item"><b>${b[1]}</b><small>${b[2]}</small></div>`).join('')}</div>` : '<div class="empty">Noch keine – einfach mehr fahren.</div>'}</div>`;
  return html;
}

const myFuel = () => S.me.cons_mode === 'car' && S.me.car ? S.me.car.fuel : S.me.fuel_type;
function lastFill() {
  const m = S.me;
  if (!m.default_price) return 'Noch kein Spritpreis hinterlegt';
  const days = m.price_at ? Math.floor((Date.now() / 1000 - m.price_at) / 86400) : null;
  const when = days == null ? '' : days === 0 ? 'heute' : days === 1 ? 'gestern' : `vor ${days} Tagen`;
  return `${price(m.default_price, fuelUnit(myFuel()))}${when ? ' · getankt ' + when : ''}${m.price_note ? ` · ${esc(m.price_note.replace(' (Tankerkönig)', ''))}` : ''}`;
}

function tankSheet() {
  const m = S.me;
  openSheet(`<h3>Gerade getankt?</h3><p>Trag den Preis ein, den du bezahlt hast. Er gilt für alle Fahrten ab jetzt, bis du wieder tankst.</p>
    <p class="note" style="margin-top:-8px">Bisher: ${lastFill()}</p>
    <label class="field"><span>Preis</span><div class="unit-input"><input id="tank-price" inputmode="decimal" placeholder="1,799" value=""><em>€/${fuelUnit(myFuel())}</em></div></label>
    ${stationBtn(myFuel(), 'tank-price')}
    <label class="check"><input type="checkbox" id="tank-full" checked onchange="document.getElementById('tank-liters-wrap').hidden=this.checked"> Vollgetankt</label>
    <label class="field" id="tank-liters-wrap" hidden><span>Getankte Liter</span><div class="unit-input"><input id="tank-liters" inputmode="decimal" placeholder="z. B. 30"><em>l</em></div></label>
    <div style="height:14px"></div><button class="btn" data-act="tank-save">Speichern</button>`);
}

// ── Tank level ────────────────────────────────────────────────────────────────
function fuelGauge(fuel, self) {
  if (!fuel) {
    return self ? `<div class="row tap" data-act="range"><div class="grow"><b>Tankstand unbekannt</b><small>Trag einmal die Reichweite aus dem Bordcomputer ein</small></div>${ICON.chev}</div>` : '';
  }
  const pct = fuel.pct != null ? fuel.pct : null;
  const cls = fuel.range < 60 ? 'low' : fuel.range < 150 ? 'mid' : '';
  return `<div ${self ? 'class="tap" data-act="range"' : ''} style="padding:6px 0">
    <div style="display:flex;justify-content:space-between;align-items:baseline"><b>ca. ${dec(fuel.liters)} l im Tank</b><span class="mu">noch ~${fuel.range} km</span></div>
    ${pct != null ? `<div class="gauge ${cls}"><i style="width:${Math.round(pct * 100)}%"></i></div>` : ''}
    <small class="mu">Schätzung${fuel.cap ? ` · Tank ${fuel.cap} l` : ''}${self ? ' · tippen zum Korrigieren' : ''}</small></div>`;
}

function rangeSheet() {
  openSheet(`<h3>Reichweite eintragen</h3><p>Schau in den Bordcomputer, wie viele Kilometer du noch fahren kannst. Die App rechnet daraus die Liter im Tank und zieht nach jeder Fahrt den Verbrauch ab.</p>
    <label class="field"><span>Reichweite laut Auto</span><div class="unit-input"><input id="range-km" inputmode="numeric" placeholder="z. B. 420"><em>km</em></div></label>
    <div style="height:14px"></div><button class="btn" data-act="range-save">Speichern</button>`);
}

// ── Fuel stations on the map ──────────────────────────────────────────────────
const myGrade = () => myFuel() === 'diesel' ? 'diesel' : S.me.petrol_grade === 'e10' ? 'e10' : 'e5';
const GRADE_LABEL = { e5: 'Super E5', e10: 'Super E10', diesel: 'Diesel' };
S.stationById = new Map();
S.stationLayer = null;

function toggleStations(force) {
  S.showStations = force ?? !S.showStations;
  $('btn-stations').classList.toggle('on', S.showStations);
  if (!S.map) return;
  if (!S.showStations) { S.stationLayer?.remove(); S.stationLayer = null; return; }
  S.stationLayer = L.layerGroup().addTo(S.map);
  if (!S.stationHook) { S.stationHook = true; S.map.on('moveend', () => { clearTimeout(S.stTimer); S.stTimer = setTimeout(loadStationsOnMap, 400); }); }
  loadStationsOnMap();
}

async function loadStationsOnMap() {
  if (!S.showStations || !S.map) return;
  if (S.map.getZoom() < 11) { S.stationLayer?.clearLayers(); return toast('Zoom etwas näher heran, um Tankstellen zu sehen'); }
  const c = S.map.getCenter(), b = S.map.getBounds();
  const rad = Math.min(25, Math.max(2, Math.ceil(b.getNorthEast().distanceTo(c) / 1000)));
  const r = await api('GET', `/api/fuel/nearby?lat=${c.lat.toFixed(4)}&lng=${c.lng.toFixed(4)}&rad=${rad}`);
  if (r.error) return toast(r.error, 'err');
  if (!r.available) { toggleStations(false); return toast('Tankstellen sind erst verfügbar, wenn der Tankerkönig-Key eingerichtet ist', 'err'); }
  const grade = myGrade();
  const prices = r.stations.filter(s => s.open && s[grade]).map(s => s[grade]);
  const min = prices.length ? Math.min(...prices) : null;
  S.stationLayer.clearLayers();
  for (const st of r.stations) {
    S.stationById.set(st.id, st);
    const p = st[grade];
    const label = !st.open ? 'zu' : p ? p.toFixed(3).replace('.', ',').slice(0, -1) + toSup(p) : '–';
    const cls = !st.open ? 'closed' : p && p === min ? 'cheap' : '';
    L.marker([st.lat, st.lng], { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="st-pin"><b class="${cls}">${label}</b><i></i></div>` }) })
      .on('click', () => stationSheet(st.id)).addTo(S.stationLayer);
  }
}
const toSup = p => ({ 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' })[Math.round(p * 1000) % 10];

function stationSheet(id) {
  const st = S.stationById.get(id);
  if (!st) return;
  const grade = myGrade();
  const d = S.pos ? meters(S.pos, st) / 1000 : st.dist;
  const nav = isIOS ? `https://maps.apple.com/?daddr=${st.lat},${st.lng}` : `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}`;
  openSheet(`<h3>${esc(st.name)}</h3><p>${esc(st.street)}, ${esc(st.postCode || '')} ${esc(st.place || '')}<br>
      <span style="color:${st.open ? 'var(--ac)' : 'var(--red)'}">${st.open ? 'Geöffnet' : 'Geschlossen'}</span> · ${dec(d)} km entfernt</p>
    <div class="price-grid">${['e5', 'e10', 'diesel'].map(g => `<div class="stat${g === grade ? ' hi' : ''}"><b style="font-size:20px">${st[g] ? price(st[g], 'l').replace(' €/l', '') : '–'}</b><span>${GRADE_LABEL[g]}</span></div>`).join('')}</div>
    ${st.fullName && st.fullName !== st.name ? `<p class="note">${esc(st.fullName)}</p>` : ''}
    <a class="btn" href="${nav}" target="_blank" rel="noopener">Route dorthin</a>
    <button class="btn ghost" data-act="station-tanked" data-id="${esc(st.id)}">Hier getankt</button>
    <p class="note">Preise: Tankerkönig (MTS-K), CC BY 4.0 · höchstens 10 Minuten alt</p>`);
}

// ── Fuel stations nearby (Tankerkönig) ───────────────────────────────────────
function stationBtn(fuel, target = 'car-price') {
  if (fuel !== 'benzin' && fuel !== 'diesel') return '';
  return `<button class="btn ghost sm" style="width:100%;margin-top:12px" data-act="stations" data-target="${target}" data-fuel="${fuel}">${ICON.pump} Preis von dieser Tankstelle</button><div id="stations"></div>`;
}

async function showStations(el) {
  const box = $('stations');
  const fuel = el.dataset.fuel;
  if (fuel !== 'benzin' && fuel !== 'diesel') return toast('Für diese Kraftstoffart gibt es keine Tankstellenpreise', 'err');
  const lat = +el.dataset.lat || S.pos?.lat, lng = +el.dataset.lng || S.pos?.lng;
  if (!lat) return toast('Noch kein Standort – GPS einschalten', 'err');
  box.innerHTML = '<div class="empty">Suche Tankstellen …</div>';
  const r = await api('GET', `/api/fuel/nearby?lat=${lat}&lng=${lng}`);
  if (r.error) { box.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  if (!r.available) { box.innerHTML = '<div class="empty">Die Tankstellenliste ist noch nicht freigeschaltet – trag den Preis bitte von Hand ein.</div>'; return; }
  const grade = fuel === 'diesel' ? 'diesel' : S.me.petrol_grade === 'e10' ? 'e10' : 'e5';
  const list = r.stations.filter(st => st.open && st[grade]);
  box.innerHTML = list.length ? list.map((st, i) => `<button class="row tap" style="width:100%;text-align:left" data-act="station-pick" data-i="${i}" data-target="${el.dataset.target}">
      <div class="grow"><b class="ell">${esc(st.name)}</b><small class="ell">${esc(st.street || st.place || '')} · ${dec(st.dist)} km</small></div>
      <div class="amount" style="font-size:18px">${price(st[grade], 'l')}</div></button>`).join('') + '<p class="note">Preise: Tankerkönig (MTS-K), CC BY 4.0</p>'
    : '<div class="empty">Keine geöffnete Tankstelle im Umkreis von 5 km gefunden.</div>';
  S.stationList = list.map(st => ({ value: String(st[grade]).replace('.', ','), note: `${st.name}, ${st.street || st.place} (Tankerkönig)` }));
}

// ── Monthly statement ─────────────────────────────────────────────────────────
function monthKey(offset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthLabel = k => new Date(k + '-15').toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

async function loadStatement() {
  const box = $('statement');
  if (!box) return;
  S.stMonth ||= monthKey(0);
  const r = await api('GET', `/api/statement?month=${S.stMonth}`);
  if (r.error) { box.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  S.statement = r;
  const chips = [0, 1, 2, 3, 4, 5].map(monthKey).map(k => `<button class="${k === S.stMonth ? 'on' : ''}" data-act="st-month" data-m="${k}">${new Date(k + '-15').toLocaleDateString('de-DE', { month: 'short' })}</button>`).join('');
  let h = `<div class="seg month-seg">${chips}</div>
    <div class="stats" style="margin-top:12px">
      <div class="stat"><b>${r.rides}</b><span>Fahrten</span></div>
      <div class="stat"><b>${kmNum(r.km)}<small>km</small></b><span>Strecke</span></div>
      <div class="stat hi"><b>${dec(r.myCost, 2)}<small>€</small></b><span>Dein Sprit</span></div>
    </div>`;
  if (r.fuelSpent) h += `<p class="note" style="margin-top:0">Als Fahrer hast du ${eur(r.fuelSpent)} Sprit verfahren.</p>`;
  if (r.missing) h += `<p class="note" style="color:var(--amber)">${r.missing} ${r.missing === 1 ? 'Fahrt hat' : 'Fahrten haben'} noch keinen Spritpreis.</p>`;
  h += r.people.length ? r.people.map(p => {
    const net = p.toMe - p.fromMe, open = p.openToMe - p.openFromMe;
    return `<div class="row">${av(p.who, 40)}<div class="grow"><b class="ell">${esc(p.who.username)}</b>
      <small>${p.toMe ? `bekommst ${eur(p.toMe)}` : ''}${p.toMe && p.fromMe ? ' · ' : ''}${p.fromMe ? `zahlst ${eur(p.fromMe)}` : ''}</small></div>
      <div class="amount ${net >= 0 ? 'in' : 'out'}">${eur(Math.abs(net))}<small>${Math.abs(open) < 0.005 ? 'erledigt' : `${eur(Math.abs(open))} offen`}</small></div></div>`;
  }).join('') : '<div class="empty">In diesem Monat keine gemeinsamen Kosten.</div>';
  if (r.rides) h += `<div style="height:12px"></div><button class="btn ghost" data-act="st-share">${ICON.share} Abrechnung teilen</button>`;
  box.innerHTML = h;
}

async function shareStatement() {
  const r = S.statement;
  const lines = [`TankiGeldi – Abrechnung ${monthLabel(r.month)}`, `${S.me.username}: ${r.rides} Fahrten, ${kmNum(r.km)} km, Spritanteil ${eur(r.myCost)}`, ''];
  for (const p of r.people) {
    const net = p.toMe - p.fromMe, open = p.openToMe - p.openFromMe;
    lines.push(`${p.who.username}: ${net >= 0 ? 'bekommt ' + S.me.username : 'bekommt von ' + S.me.username} ${eur(Math.abs(net))}${Math.abs(open) < 0.005 ? ' ✓ erledigt' : ` (offen ${eur(Math.abs(open))})`}`);
  }
  const text = lines.join('\n');
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Abrechnung kopiert – jetzt in WhatsApp einfügen'); }
  catch { toast('Teilen nicht möglich', 'err'); }
}

function withNote(o) {
  o.price_note = S.stationPick && S.stationPick.value === o.default_price ? S.stationPick.note : null;
  return o;
}

// ── Event delegation ──────────────────────────────────────────────────────────
const ACT = {
  'auth-mode': el => setAuthMode(el.dataset.mode),
  'auth-role': el => { S.authRole = el.dataset.role; document.querySelectorAll('.role-opt').forEach(b => b.classList.toggle('on', b === el)); },
  tab: el => { closeDetail(); $('profile').hidden = true; $('user').hidden = true; showTab(el.dataset.tab); },
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
  rename: () => {
    const r = S.detail.ride;
    openSheet(`<h3>Fahrt benennen</h3><p>Den Namen sehen alle, die bei der Fahrt dabei waren.</p>
      <label class="field"><input id="ride-name" maxlength="50" placeholder="z. B. Ausflug Bodensee" value="${esc(r.name || '')}"></label>
      <div style="height:14px"></div><button class="btn" data-act="save-name">Speichern</button>`);
    setTimeout(() => $('ride-name')?.focus(), 50);
  },
  'save-name': async () => {
    const id = S.detail.ride.id;
    const r = await call('POST', `/api/rides/${id}/name`, { name: $('ride-name').value });
    if (r.error) return;
    closeSheet();
    openDetail(id, true);
    if (S.tab === 'rides') loadHistory();
  },
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
  stations: el => showStations(el),
  'station-pick': el => {
    const pick = S.stationList[+el.dataset.i];
    $(el.dataset.target).value = pick.value;
    S.stationPick = pick;
    $('stations').innerHTML = '';
    toast('Preis übernommen');
  },
  grade: el => saveMe({ petrol_grade: el.dataset.g }),
  'st-month': el => { S.stMonth = el.dataset.m; loadStatement(); },
  'st-share': () => shareStatement(),
  user: el => openUser(+el.dataset.uid),
  'user-close': () => { $('user').hidden = true; },
  'all-users': () => allUsersSheet(),
  'cons-mode': el => saveMe({ cons_mode: el.dataset.mode }),
  'car-pick': () => carPickSheet(),
  'car-set': async el => { const r = await saveMe({ car_id: el.dataset.id, cons_mode: 'car' }, 'Auto gespeichert'); if (!r.error) closeSheet(); },
  'save-car-price': () => saveMe(withNote({ default_price: $('car-price').value.trim() || null }), 'Gespeichert'),
  tanked: () => tankSheet(),
  'tank-save': async () => {
    const v = $('tank-price').value.trim();
    if (!v) return toast('Bitte einen Preis eintragen', 'err');
    const patch = withNote({ default_price: v });
    if ($('tank-full').checked) { if (S.me.tank_cap) patch.fuel_full = true; }
    else if ($('tank-liters').value.trim()) patch.fuel_added = $('tank-liters').value.trim();
    const r = await saveMe(patch, 'Getankt – Preis und Tankstand gespeichert');
    if (!r.error) closeSheet();
  },
  range: () => rangeSheet(),
  'range-save': async () => {
    const v = $('range-km').value.trim();
    if (!v) return toast('Bitte die Reichweite eintragen', 'err');
    const r = await saveMe({ range_km: v }, 'Tankstand gespeichert');
    if (!r.error) closeSheet();
  },
  'stations-toggle': () => toggleStations(),
  station: el => stationSheet(el.dataset.id),
  'station-tanked': el => {
    const st = S.stationById.get(el.dataset.id), grade = myGrade();
    closeSheet();
    tankSheet();
    if (st && st[grade]) {
      $('tank-price').value = String(st[grade]).replace('.', ',');
      S.stationPick = { value: $('tank-price').value, note: `${st.name}, ${st.street || st.place} (Tankerkönig)` };
    }
  },
  'save-pay': () => saveMe({ revolut: $('pay-revolut').value, iban: $('pay-iban').value, account_name: $('pay-name').value }, 'Zahlungsdaten gespeichert'),
  copy: async el => {
    try { await navigator.clipboard.writeText(el.dataset.v); toast('Kopiert'); }
    catch { toast('Kopieren nicht möglich – bitte manuell markieren', 'err'); }
  },
  'pay-bal': el => {
    const b = S.balances.find(x => x.key === el.dataset.key);
    if (b) paySheet(b.who, b.pay, -b.net, b.items.filter(i => i.dir === 'out').map(i => i.pid));
  },
  'pay-ride': () => {
    const { ride, pay } = S.detail;
    paySheet(ride.driver, pay, ride.my_part.share_eur, [ride.my_part.id]);
  },
  'pay-done': async () => {
    for (const pid of S.payPids || []) {
      const r = await call('POST', `/api/participants/${pid}/paid`, { paid: true });
      if (r.error) return;
    }
    closeSheet();
    toast('Als bezahlt markiert');
    if (S.detail) openDetail(S.detail.ride.id, true);
    if (S.tab === 'money') loadMoney();
  },
  'paste-invite': () => pasteInvite(),
  'invite-submit': () => addInvite(parseInvite($('invite-input').value)),
  'copy-invite': async () => {
    const url = `${location.origin}/?add=${encodeURIComponent(lsGet('pendingAdd') || '')}`;
    try { await navigator.clipboard.writeText(url); toast('Kopiert – jetzt Tanki öffnen und bei Freunde einfügen'); }
    catch { toast('Kopieren nicht möglich – such in der App einfach nach dem Namen', 'err'); }
  },
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
    consumption: $('car-cons').value.trim() || null, tank_l: $('car-tank').value.trim() || null, ...withNote({ default_price: $('car-price').value.trim() || null }),
  }, 'Gespeichert'),
  avatar: () => avatarSheet(),
  color: async el => { const r = await saveMe({ avatar_color: el.dataset.c, avatar_data: null }); if (!r.error) closeSheet(); },
  photo: () => $('photo-input').click(),
  'photo-remove': async () => { const r = await saveMe({ avatar_data: null }); if (!r.error) closeSheet(); },
  notif: () => enablePush(),
  'push-test': () => call('POST', '/api/push/test', null, 'Test-Benachrichtigung gesendet'),
  'plan-new': () => planSheet(),
  plan: el => openPlan(+el.dataset.id),
  'plan-save': async () => {
    const when = new Date($('plan-when').value).getTime() / 1000;
    const r = await call('POST', '/api/plans', { destination: $('plan-dest').value, depart_at: when, seats: $('plan-seats').value, note: $('plan-note').value }, 'Geplant – deine Freunde werden benachrichtigt');
    if (!r.error) { closeSheet(); loadFeed(); }
  },
  'plan-join': async el => { const r = await call('POST', `/api/plans/${el.dataset.id}/join`, null, 'Du bist angemeldet'); if (!r.error) { closeSheet(); loadFeed(); } },
  'plan-leave': async el => { const r = await call('POST', `/api/plans/${el.dataset.id}/leave`, null, 'Abgemeldet'); if (!r.error) { closeSheet(); loadFeed(); } },
  'plan-cancel': el => confirmSheet('Fahrt absagen?', 'Alle Angemeldeten bekommen eine Nachricht.', 'Absagen', async () => {
    const r = await call('DELETE', `/api/plans/${el.dataset.id}`, null, 'Fahrt abgesagt');
    if (!r.error) loadFeed();
  }, true),
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
