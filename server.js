'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const webpush = require('web-push');

const PORT = process.env.PORT || 8081;
const TK_KEY = process.env.TANKERKOENIG_KEY || null;
const APP_URL = 'https://tankigeldi.lsh-portal.de';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tankigeldi.db');
const PUBLIC = path.join(__dirname, 'public');
const JOIN_WINDOW = 30 * 60;
const STALE_AFTER = 15 * 60;
const PAUSE_MAX = 3 * 3600;
const DEFAULT_CONSUMPTION = { benzin: 7.5, diesel: 6.0, lpg: 9.5, elektro: 18 };
const FUEL_TYPES = Object.keys(DEFAULT_CONSUMPTION);
const COLORS = ['#005387', '#00757A', '#B8460E', '#5B4A8C', '#8A6300', '#007A4D', '#A3245E', '#3F5F8F'];

// Real-world consumption (l/100 km) per car: city, rural (~80 km/h), motorway (~130 km/h)
const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const CARS = require('./data/cars.json').map(([brand, model, engine, fuel, city, rural, motorway, tank]) => ({
  id: slug(`${brand} ${model} ${engine}`), brand, model, engine, fuel, city, rural, motorway, tank,
  combined: Math.round((city + rural + motorway) / 3 * 10) / 10,
}));
const CAR_BY_ID = new Map(CARS.map(c => [c.id, c]));
const carLabel = c => c && `${c.brand} ${c.model} ${c.engine}`;

// Consumption at a given average speed, interpolated between the car's three profile points
function consAt(car, v) {
  if (v <= 25) return car.city * (1 + (25 - v) / 25 * 0.35);
  if (v <= 80) return car.city + (car.rural - car.city) * (v - 25) / 55;
  if (v <= 130) return car.rural + (car.motorway - car.rural) * (v - 80) / 50;
  return car.motorway * (1 + (v - 130) * 0.012);
}

// Cumulative fuel along the route: [[km, liters], ...] from ~500 m chunks at their real speed
function fuelProfile(ride) {
  const car = CAR_BY_ID.get(ride.car_id);
  if (!car) return null;
  const pts = db.prepare('SELECT lat, lng, ts, kind FROM gps_points WHERE ride_id = ? ORDER BY ts').all(ride.id);
  if (pts.length < 2) return null;
  const prof = [[0, 0]];
  let km = 0, liters = 0, chunkKm = 0, chunkT0 = pts[0].ts;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].kind === 2) { chunkT0 = pts[i].ts; chunkKm = 0; continue; }
    chunkKm += haversine(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    if (chunkKm >= 0.5 || i === pts.length - 1) {
      const hours = Math.max(pts[i].ts - chunkT0, 1) / 3600;
      const v = Math.min(Math.max(chunkKm / hours, 3), 220);
      liters += chunkKm * consAt(car, v) / 100;
      km += chunkKm;
      prof.push([km, liters]);
      chunkKm = 0;
      chunkT0 = pts[i].ts;
    }
  }
  // Scale km to the stored total so participant km offsets line up exactly
  const total = ride.total_distance || km;
  return km > 0 ? prof.map(([k, l]) => [k * total / km, l]) : null;
}

// Distance, time and fuel split into city (<50 km/h), rural (50–100) and motorway (>100) from ~500 m chunks
function rideZones(ride, pts) {
  const car = CAR_BY_ID.get(ride.car_id);
  const zones = { stadt: { km: 0, s: 0, l: 0 }, land: { km: 0, s: 0, l: 0 }, autobahn: { km: 0, s: 0, l: 0 } };
  let chunkKm = 0, t0 = pts[0]?.[3];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][4] === 2) { t0 = pts[i][3]; chunkKm = 0; continue; }
    chunkKm += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (chunkKm >= 0.5 || i === pts.length - 1) {
      const secs = Math.max(pts[i][3] - t0, 1);
      const v = chunkKm / (secs / 3600);
      const z = zones[v < 50 ? 'stadt' : v <= 100 ? 'land' : 'autobahn'];
      z.km += chunkKm;
      z.s += secs;
      z.l += chunkKm * (car ? consAt(car, Math.min(Math.max(v, 3), 220)) : ride.consumption || 7.5) / 100;
      chunkKm = 0;
      t0 = pts[i][3];
    }
  }
  return zones;
}

function litersAt(prof, x) {
  for (let i = 1; i < prof.length; i++) {
    if (x <= prof[i][0]) {
      const [k0, l0] = prof[i - 1], [k1, l1] = prof[i];
      return k1 === k0 ? l1 : l0 + (l1 - l0) * (x - k0) / (k1 - k0);
    }
  }
  return prof[prof.length - 1][1];
}

function ibanOk(s) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  let m = 0;
  for (const ch of (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => c.charCodeAt(0) - 55)) m = (m * 10 + +ch) % 97;
  return m === 1;
}

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT,
    avatar_data TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY,
    driver_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'active',
    fuel_type TEXT DEFAULT 'benzin',
    fuel_price REAL,
    total_distance REAL DEFAULT 0,
    started_at INTEGER DEFAULT (unixepoch()),
    ended_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS ride_participants (
    id INTEGER PRIMARY KEY,
    ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    guest_name TEXT,
    joined_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS gps_points (
    id INTEGER PRIMARY KEY,
    ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    speed REAL DEFAULT 0,
    ts INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(requester_id, addressee_id)
  );
`);

function ensureCols(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, def] of Object.entries(cols)) {
    if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    destination TEXT NOT NULL, depart_at INTEGER NOT NULL, seats INTEGER NOT NULL DEFAULT 3, note TEXT,
    cancelled INTEGER DEFAULT 0, ride_id INTEGER, created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS plan_members (
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (plan_id, user_id)
  );
`);
// Avatar colours moved from the old neon palette to the road-sign palette
{
  const OLD_COLORS = ['#C8F03C', '#5CE1E6', '#FF8A5B', '#B69CFF', '#FFD25E', '#6EE7A8', '#FF6B9A', '#7AA7FF'];
  const swap = db.prepare('UPDATE users SET avatar_color = ? WHERE upper(avatar_color) = ?');
  db.transaction(() => OLD_COLORS.forEach((c, i) => swap.run(COLORS[i], c)))();
}
ensureCols('users', {
  role: "TEXT DEFAULT 'passenger'", auto_start: 'INTEGER DEFAULT 1', car_name: 'TEXT',
  fuel_type: "TEXT DEFAULT 'benzin'", consumption: 'REAL', default_price: 'REAL', avatar_v: 'INTEGER',
  cons_mode: "TEXT DEFAULT 'manual'", car_id: 'TEXT', petrol_grade: "TEXT DEFAULT 'e5'", price_at: 'INTEGER', price_note: 'TEXT', tank_l: 'REAL', fuel_l: 'REAL', fuel_at: 'INTEGER', revolut: 'TEXT', iban: 'TEXT', account_name: 'TEXT',
});
ensureCols('rides', {
  consumption: 'REAL', last_lat: 'REAL', last_lng: 'REAL', last_speed: 'REAL',
  last_ts: 'INTEGER', last_seen: 'INTEGER', auto_started: 'INTEGER DEFAULT 0', car_id: 'TEXT', name: 'TEXT', price_note: 'TEXT',
});
ensureCols('rides', { paused_at: 'INTEGER', seg_break: 'INTEGER DEFAULT 0', pause_total: 'INTEGER DEFAULT 0' });
ensureCols('gps_points', { kind: 'INTEGER DEFAULT 0' });
ensureCols('ride_participants', {
  from_km: 'REAL DEFAULT 0', to_km: 'REAL', share_eur: 'REAL', paid_at: 'INTEGER', paid_by: 'INTEGER',
});
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_gps_ride ON gps_points(ride_id, ts);
  CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
  CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);
  CREATE INDEX IF NOT EXISTS idx_part_ride ON ride_participants(ride_id);
  CREATE INDEX IF NOT EXISTS idx_part_user ON ride_participants(user_id);
  -- the old version stored the driver as a participant; the driver is now implicit
  DELETE FROM ride_participants WHERE user_id = (SELECT driver_id FROM rides WHERE rides.id = ride_participants.ride_id);
  UPDATE users SET avatar_color = '#005387' WHERE avatar_color IS NULL OR avatar_color = '#C95B18';
  UPDATE users SET avatar_v = unixepoch() WHERE avatar_data IS NOT NULL AND avatar_v IS NULL;
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => Math.floor(Date.now() / 1000);
const r2 = v => Math.round(v * 100) / 100;

class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpErr(status, msg); };

function num(v, min, max) {
  if (v == null || v === '') return null;
  const n = +String(v).replace(',', '.');
  if (!Number.isFinite(n) || n < min || n > max) fail(400, `Wert muss zwischen ${min} und ${max} liegen.`);
  return n;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByToken: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  ride: db.prepare('SELECT * FROM rides WHERE id = ?'),
  parts: db.prepare(`
    SELECT p.*, u.username, u.avatar_color, u.avatar_v FROM ride_participants p
    LEFT JOIN users u ON u.id = p.user_id WHERE p.ride_id = ? ORDER BY p.joined_at, p.id`),
  part: db.prepare('SELECT * FROM ride_participants WHERE ride_id = ? AND user_id = ?'),
  planById: db.prepare('SELECT * FROM plans WHERE id = ?'),
  friendIds: db.prepare(`
    SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id
    FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`),
  isFriend: db.prepare(`
    SELECT 1 FROM friendships WHERE status = 'accepted'
      AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`),
  activeAsDriver: db.prepare("SELECT * FROM rides WHERE driver_id = ? AND status = 'active'"),
  activeAsPassenger: db.prepare(`
    SELECT r.* FROM ride_participants p JOIN rides r ON r.id = p.ride_id
    WHERE p.user_id = ? AND r.status = 'active' AND p.to_km IS NULL`),
};

const friendIds = uid => q.friendIds.all(uid, uid, uid).map(r => r.id);
const isFriend = (a, b) => !!q.isFriend.get(a, b, b, a);
const currentRide = uid => q.activeAsDriver.get(uid) || q.activeAsPassenger.get(uid) || null;

const getSetting = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

// ── Web Push (VAPID keys are generated once and kept in the database) ─────────
let vapid = getSetting('vapid');
if (!vapid) { vapid = JSON.stringify(webpush.generateVAPIDKeys()); setSetting('vapid', vapid); }
vapid = JSON.parse(vapid);
webpush.setVapidDetails(APP_URL, vapid.publicKey, vapid.privateKey);

function push(uids, payload, exclude = null) {
  const ids = [...new Set(uids)].filter(id => id && id !== exclude);
  if (!ids.length) return;
  const subs = db.prepare(`SELECT * FROM push_subs WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const body = JSON.stringify(payload);
  for (const sub of subs) {
    webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { TTL: 6 * 3600 })
      .catch(e => { if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id); });
  }
}

// ── Fuel prices (Tankerkönig, data by MTS-K) ──────────────────────────────────
const tkCache = new Map();
async function nearbyStations(lat, lng, rad = 5) {
  if (!TK_KEY) return null;
  const key = `${lat.toFixed(2)},${lng.toFixed(2)},${rad}`;
  const hit = tkCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.d;
  const r = await fetch(`https://creativecommons.tankerkoenig.de/json/list.php?lat=${lat}&lng=${lng}&rad=${rad}&sort=dist&type=all&apikey=${TK_KEY}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.message || 'Tankerkönig-Fehler');
  const d = j.stations.sort((a, b) => a.dist - b.dist).slice(0, 80).map(s => ({
    id: s.id, name: (s.brand || s.name || 'Tankstelle').trim(), fullName: s.name, street: `${s.street || ''} ${s.houseNumber || ''}`.trim(),
    postCode: s.postCode, place: s.place, lat: s.lat, lng: s.lng, open: s.isOpen !== false,
    dist: s.dist, e5: s.e5 || null, e10: s.e10 || null, diesel: s.diesel || null,
  }));
  tkCache.set(key, { t: Date.now(), d });
  return d;
}

function pub(u) {
  return {
    id: u.id, username: u.username, color: u.avatar_color || COLORS[0],
    avatar: u.avatar_v ? `/api/avatar/${u.id}?v=${u.avatar_v}` : null,
  };
}

function meJson(u) {
  return {
    ...pub(u), role: u.role, auto_start: !!u.auto_start, car_name: u.car_name,
    fuel_type: u.fuel_type || 'benzin', consumption: u.consumption, default_price: u.default_price,
    cons_mode: u.cons_mode === 'car' ? 'car' : 'manual', car: CAR_BY_ID.get(u.car_id) || null, petrol_grade: u.petrol_grade === 'e10' ? 'e10' : 'e5', price_at: u.price_at, price_note: u.price_note,
    revolut: u.revolut, iban: u.iban, account_name: u.account_name,
    tank_l: u.tank_l, tank_cap: tankCap(u), fuel: fuelState(u),
  };
}

// Estimated tank level: set from the range on the dashboard or a fill-up, minus fuel used on each ride
function userCar(u) { return u.cons_mode === 'car' ? CAR_BY_ID.get(u.car_id) || null : null; }
function userCons(u) { const car = userCar(u); return car ? car.combined : u.consumption || DEFAULT_CONSUMPTION[u.fuel_type || 'benzin']; }
function tankCap(u) { return u.tank_l || userCar(u)?.tank || null; }
function fuelState(u) {
  if (u.fuel_l == null) return null;
  const cap = tankCap(u), cons = userCons(u);
  return { liters: Math.round(u.fuel_l * 10) / 10, cap, pct: cap ? Math.min(1, u.fuel_l / cap) : null, range: Math.round(u.fuel_l / cons * 100), at: u.fuel_at };
}

function payInfo(u) {
  return u && (u.revolut || u.iban) ? { revolut: u.revolut, iban: u.iban, account_name: u.account_name || u.username } : null;
}

function partJson(p) {
  return {
    id: p.id, user_id: p.user_id, guest: !p.user_id,
    username: p.user_id ? p.username : p.guest_name,
    color: p.avatar_color || '#8D958A',
    avatar: p.avatar_v ? `/api/avatar/${p.user_id}?v=${p.avatar_v}` : null,
    from_km: p.from_km || 0, to_km: p.to_km, share_eur: p.share_eur, paid_at: p.paid_at,
  };
}

function rideCard(r, meId, parts = q.parts.all(r.id)) {
  const mine = parts.find(p => p.user_id === meId);
  return {
    id: r.id, name: r.name, status: r.status, started_at: r.started_at, ended_at: r.ended_at,
    paused_at: r.paused_at, pause_total: r.pause_total || 0,
    total_distance: r.total_distance || 0, fuel_type: r.fuel_type, fuel_price: r.fuel_price,
    consumption: r.consumption, auto_started: !!r.auto_started, car: carLabel(CAR_BY_ID.get(r.car_id)) || null, price_note: r.price_note,
    last_lat: r.last_lat, last_lng: r.last_lng, last_speed: r.last_speed, last_seen: r.last_seen,
    driver: pub(q.userById.get(r.driver_id)),
    participants: parts.map(partJson),
    joined: !!mine, my_part: mine ? partJson(mine) : null,
  };
}

// Cost is split per stretch of road among everyone in the car at that time, driver included.
function shareCalc(ride, parts, prof = fuelProfile(ride)) {
  const total = ride.total_distance || 0;
  const perKm = ride.fuel_price && (ride.consumption || prof) ? (ride.consumption || 7.5) / 100 * ride.fuel_price : null;
  const costBetween = prof
    ? (a, b) => (litersAt(prof, b) - litersAt(prof, a)) * ride.fuel_price
    : (a, b) => (b - a) * perKm;
  const shares = {};
  let driverShare = 0;
  parts.forEach(p => { shares[p.id] = 0; });
  if (perKm !== null && total > 0) {
    const span = p => [Math.min(p.from_km || 0, total), p.to_km == null ? total : Math.min(p.to_km, total)];
    const cuts = [...new Set([0, total, ...parts.flatMap(span)])].sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1], b = cuts[i];
      const inCar = parts.filter(p => { const [x, y] = span(p); return x <= a && y >= b; });
      const each = costBetween(a, b) / (inCar.length + 1);
      driverShare += each;
      inCar.forEach(p => { shares[p.id] += each; });
    }
  }
  for (const k in shares) shares[k] = perKm === null ? null : r2(shares[k]);
  return {
    perKm, totalCost: perKm === null ? null : r2(costBetween(0, total)),
    effConsumption: prof && total > 0 ? Math.round(litersAt(prof, total) / total * 1000) / 10 : null,
    driverShare: perKm === null ? null : r2(driverShare), shares,
  };
}

const updShare = db.prepare('UPDATE ride_participants SET share_eur = ? WHERE id = ?');
function settle(rideId) {
  const ride = q.ride.get(rideId);
  if (!ride) return;
  const parts = q.parts.all(rideId);
  const { shares, effConsumption } = shareCalc(ride, parts);
  db.transaction(() => {
    if (effConsumption) db.prepare('UPDATE rides SET consumption = ? WHERE id = ?').run(effConsumption, rideId);
    parts.forEach(p => updShare.run(shares[p.id], p.id));
  })();
}

const insPoint = db.prepare('INSERT INTO gps_points (ride_id, lat, lng, speed, ts, kind) VALUES (?, ?, ?, ?, ?, ?)');
const updRidePos = db.prepare(`
  UPDATE rides SET total_distance = ?, last_lat = ?, last_lng = ?, last_speed = ?, last_ts = ?, last_seen = ?, seg_break = ?
  WHERE id = ?`);

// kind: 0 measured · 1 estimated (gap filled along the road) · 2 first point after a pause (no line to the previous one)
function addPoints(ride, pts, filler = []) {
  if (ride.paused_at) return ride;
  const t = now();
  let { last_lat: lat0, last_lng: lng0, last_ts: t0, last_speed: spd } = ride;
  let dist = ride.total_distance || 0;
  let segBreak = !!ride.seg_break;
  const clean = (Array.isArray(pts) ? pts : [])
    .map(p => ({ lat: +p.lat, lng: +p.lng, speed: Math.max(0, +p.speed || 0), ts: Math.round(+p.ts * 10) / 10, kind: 0 }))
    .filter(p => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && p.ts > t - 6 * 3600 && p.ts <= t + 60)
    .sort((a, b) => a.ts - b.ts)
    .slice(-3000);
  db.transaction(() => {
    for (const p of [...filler, ...clean]) {
      if (t0 && p.ts <= t0) continue;
      let kind = p.kind;
      if (lat0 != null) {
        const d = haversine(lat0, lng0, p.lat, p.lng);
        if (kind === 0 && segBreak) { kind = 2; segBreak = false; }
        else if (kind === 0) {
          if (d / Math.max(p.ts - t0, 0.5) * 3600 > 250) continue;  // GPS jump
          if (d < 0.003 && p.speed < 4) { spd = p.speed; continue; }  // jitter while standing
        }
        if (kind !== 2) dist += d;
      }
      insPoint.run(ride.id, p.lat, p.lng, p.speed, p.ts, kind);
      lat0 = p.lat; lng0 = p.lng; t0 = p.ts; spd = p.speed;
    }
    updRidePos.run(Math.round(dist * 1000) / 1000, lat0, lng0, spd, t0, t, segBreak ? 1 : 0, ride.id);
  })();
  Object.assign(ride, { total_distance: dist, last_lat: lat0, last_lng: lng0, last_speed: spd, last_ts: t0, last_seen: t, seg_break: segBreak ? 1 : 0 });
  return ride;
}

// When the phone sent nothing for a while (app in background, screen off), estimate the missing stretch along the road
async function gapFill(ride, pts) {
  if (ride.last_ts == null || ride.paused_at || ride.seg_break) return [];
  const first = (Array.isArray(pts) ? pts : [])
    .map(p => ({ lat: +p.lat, lng: +p.lng, ts: Math.round(+p.ts * 10) / 10 }))
    .filter(p => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && p.ts > ride.last_ts && p.ts <= now() + 60)
    .sort((a, b) => a.ts - b.ts)[0];
  if (!first) return [];
  const gap = first.ts - ride.last_ts;
  const direct = haversine(ride.last_lat, ride.last_lng, first.lat, first.lng);
  if (gap < 20 || direct < 0.15 || gap > 3 * 3600 || direct / (gap / 3600) > 220) return [];
  let line = [[ride.last_lng, ride.last_lat], [first.lng, first.lat]];
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${ride.last_lng},${ride.last_lat};${first.lng},${first.lat}?overview=full&geometries=geojson`,
      { signal: ctl.signal, headers: { 'User-Agent': 'TankiTankiGeldiGeldi/1.0 (private friends app)' } });
    clearTimeout(timer);
    const j = await r.json();
    const c = j.routes?.[0]?.geometry?.coordinates;
    if (j.code === 'Ok' && c?.length >= 2 && j.routes[0].distance / 1000 < direct * 2.5 + 1) line = c;
  } catch { /* routing unavailable: straight line */ }
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0]));
  const total = cum[cum.length - 1];
  const n = Math.min(Math.max(Math.round(gap / 5), 2), 240);
  const kmh = Math.round(total / (gap / 3600) * 10) / 10;
  const out = [];
  for (let k = 1; k < n; k++) {
    const target = total * k / n;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const f = (target - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    out.push({
      lat: line[i - 1][1] + (line[i][1] - line[i - 1][1]) * f, lng: line[i - 1][0] + (line[i][0] - line[i - 1][0]) * f,
      speed: kmh, ts: Math.round((ride.last_ts + gap * k / n) * 10) / 10, kind: 1,
    });
  }
  return out;
}

// One batch per ride at a time, so a slow routing call cannot overlap with the next batch
const chains = new Map();
function ingest(rideId, pts) {
  const run = async () => {
    const ride = q.ride.get(rideId);
    if (!ride || ride.status !== 'active') return ride;
    return addPoints(ride, pts, await gapFill(ride, pts));
  };
  const next = (chains.get(rideId) || Promise.resolve()).then(run, run);
  chains.set(rideId, next);
  next.finally(() => { if (chains.get(rideId) === next) chains.delete(rideId); }).catch(() => {});
  return next;
}

// ── Realtime ──────────────────────────────────────────────────────────────────
const sockets = new Map(); // userId → Set<ws>

function send(uids, msg, exclude = null) {
  const s = JSON.stringify(msg);
  for (const id of new Set(uids)) {
    if (id === exclude) continue;
    sockets.get(id)?.forEach(ws => { if (ws.readyState === 1) ws.send(s); });
  }
}

function audience(ride) {
  return [ride.driver_id, ...friendIds(ride.driver_id), ...q.parts.all(ride.id).filter(p => p.user_id).map(p => p.user_id)];
}

function broadcastPos(r) {
  send(audience(r), { type: 'pos', rideId: r.id, lat: r.last_lat, lng: r.last_lng, speed: r.last_speed, dist: r.total_distance });
}

function endRide(ride, at = now()) {
  const open = q.ride.get(ride.id)?.paused_at;
  db.prepare("UPDATE rides SET status = 'ended', ended_at = ?, pause_total = COALESCE(pause_total, 0) + ?, paused_at = NULL WHERE id = ?")
    .run(at, open ? Math.max(0, at - open) : 0, ride.id);
  settle(ride.id);
  const driver = q.userById.get(ride.driver_id), done = q.ride.get(ride.id);
  if (driver.fuel_l != null && done.total_distance > 0) {
    const used = done.total_distance * (done.consumption || userCons(driver)) / 100;
    const left = Math.max(0, driver.fuel_l - used);
    db.prepare('UPDATE users SET fuel_l = ? WHERE id = ?').run(Math.round(left * 10) / 10, driver.id);
    const before = driver.fuel_l / userCons(driver) * 100, after = left / userCons(driver) * 100;
    if (after < 60 && before >= 60) push([driver.id], { title: 'Tank fast leer', body: `Laut Schätzung noch ca. ${Math.round(after)} km Reichweite.`, url: '/?stations=1' });
  }
  send(audience(ride), { type: 'ride_ended', rideId: ride.id });
}

function deleteRide(ride) {
  const aud = audience(ride);
  db.prepare('DELETE FROM rides WHERE id = ?').run(ride.id);
  send(aud, { type: 'ride_deleted', rideId: ride.id });
}

// Rides whose driver's phone went silent are closed automatically; tiny false starts are dropped.
setInterval(() => {
  const stale = db.prepare(`SELECT * FROM rides WHERE status = 'active' AND (
    (paused_at IS NULL AND COALESCE(last_seen, started_at) < ?) OR (paused_at IS NOT NULL AND paused_at < ?))`)
    .all(now() - STALE_AFTER, now() - PAUSE_MAX);
  for (const r of stale) {
    const hasParts = q.parts.all(r.id).length > 0;
    if ((r.total_distance || 0) < 0.3 && !hasParts) deleteRide(r);
    else endRide(r, r.paused_at || r.last_ts || r.started_at);
  }
}, 60 * 1000);

// ── Routes ────────────────────────────────────────────────────────────────────
const routes = [];
const route = (m, p, auth, fn) => routes.push({
  m, auth, fn, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'),
});

function driverRide(id, uid) {
  const r = q.ride.get(id) || fail(404, 'Fahrt nicht gefunden.');
  if (r.driver_id !== uid) fail(403, 'Nur der Fahrer kann das.');
  return r;
}

function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, uid);
  return { token, me: meJson(q.userById.get(uid)) };
}

// Auth
route('POST', '/api/register', false, ({ body }) => {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!/^[\p{L}\p{N}_.-]{2,20}$/u.test(username)) fail(400, 'Nutzername: 2–20 Zeichen, nur Buchstaben, Zahlen und _ . -');
  if (password.length < 6) fail(400, 'Passwort braucht mindestens 6 Zeichen.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'Dieser Nutzername ist schon vergeben.');
  const role = body.role === 'driver' ? 'driver' : 'passenger';
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const id = db.prepare('INSERT INTO users (username, password_hash, role, avatar_color) VALUES (?, ?, ?, ?)')
    .run(username, bcrypt.hashSync(password, 10), role, color).lastInsertRowid;
  return newSession(id);
});

route('POST', '/api/login', false, ({ body }) => {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username || '').trim());
  if (!u || !bcrypt.compareSync(String(body.password || ''), u.password_hash)) fail(400, 'Nutzername oder Passwort falsch.');
  return newSession(u.id);
});

route('POST', '/api/logout', true, ({ token }) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
});

route('GET', '/api/me', true, ({ user }) => ({ me: meJson(user) }));

route('PUT', '/api/me', true, ({ user, body }) => {
  const u = {};
  if ('role' in body) u.role = body.role === 'driver' ? 'driver' : 'passenger';
  if ('auto_start' in body) u.auto_start = body.auto_start ? 1 : 0;
  if ('car_name' in body) u.car_name = String(body.car_name || '').trim().slice(0, 40) || null;
  if ('fuel_type' in body) {
    if (!FUEL_TYPES.includes(body.fuel_type)) fail(400, 'Unbekannte Kraftstoffart.');
    u.fuel_type = body.fuel_type;
  }
  if ('consumption' in body) u.consumption = num(body.consumption, 1, 40);
  if ('default_price' in body) {
    u.default_price = num(body.default_price, 0.1, 5);
    u.price_at = u.default_price ? now() : null;
    u.price_note = body.price_note ? String(body.price_note).slice(0, 120) : null;
  }
  if ('petrol_grade' in body) u.petrol_grade = body.petrol_grade === 'e10' ? 'e10' : 'e5';
  if ('cons_mode' in body) u.cons_mode = body.cons_mode === 'car' ? 'car' : 'manual';
  if ('car_id' in body) {
    const car = body.car_id ? CAR_BY_ID.get(body.car_id) || fail(400, 'Auto nicht gefunden.') : null;
    u.car_id = car ? car.id : null;
    if (car) u.fuel_type = car.fuel;
  }
  if ('revolut' in body) {
    const r = String(body.revolut || '').trim().replace(/^(https?:\/\/)?(www\.)?revolut\.me\//i, '').replace(/^@/, '').replace(/\/.*$/, '');
    if (r && !/^[a-z0-9._-]{3,40}$/i.test(r)) fail(400, 'Revolut-Nutzername ungültig.');
    u.revolut = r || null;
  }
  if ('iban' in body) {
    const iban = String(body.iban || '').replace(/\s+/g, '').toUpperCase();
    if (iban && !ibanOk(iban)) fail(400, 'Die IBAN ist ungültig – bitte nochmal prüfen.');
    u.iban = iban || null;
  }
  if ('account_name' in body) u.account_name = String(body.account_name || '').trim().slice(0, 60) || null;
  if ('avatar_color' in body) {
    if (!/^#[0-9a-f]{6}$/i.test(body.avatar_color)) fail(400, 'Ungültige Farbe.');
    u.avatar_color = body.avatar_color;
  }
  if ('avatar_data' in body) {
    if (body.avatar_data === null) { u.avatar_data = null; u.avatar_v = null; }
    else {
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.avatar_data) || body.avatar_data.length > 400000) fail(400, 'Bild ungültig oder zu groß.');
      u.avatar_data = body.avatar_data; u.avatar_v = now();
    }
  }
  if ('tank_l' in body) u.tank_l = num(body.tank_l, 5, 200);
  let keys = Object.keys(u);
  if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => u[k]), user.id);

  const fresh = q.userById.get(user.id), cap = tankCap(fresh);
  let fuel;
  if (body.range_km != null) fuel = num(body.range_km, 0, 3000) * userCons(fresh) / 100;
  else if (body.fuel_full) fuel = cap || fail(400, 'Trag zuerst die Tankgröße deines Autos ein.');
  else if (body.fuel_added != null) fuel = (fresh.fuel_l || 0) + num(body.fuel_added, 0.5, 200);
  if (fuel != null) {
    db.prepare('UPDATE users SET fuel_l = ?, fuel_at = ? WHERE id = ?').run(Math.round((cap ? Math.min(cap, fuel) : fuel) * 10) / 10, now(), user.id);
  }
  return { me: meJson(q.userById.get(user.id)) };
});

// Feed: my current ride + friends' active and just-ended rides
route('GET', '/api/feed', true, ({ user }) => {
  const fids = friendIds(user.id);
  const ids = [user.id, ...fids];
  const rides = db.prepare(`
    SELECT * FROM rides WHERE driver_id IN (${ids.map(() => '?').join(',')})
      AND (status = 'active' OR ended_at > ?) ORDER BY started_at DESC`).all(...ids, now() - JOIN_WINDOW);
  const cur = currentRide(user.id);
  if (cur && !rides.some(r => r.id === cur.id)) rides.unshift(cur);
  const missingPrice = db.prepare(`
    SELECT COUNT(*) AS n FROM rides r WHERE driver_id = ? AND status = 'ended' AND fuel_price IS NULL
      AND EXISTS (SELECT 1 FROM ride_participants p WHERE p.ride_id = r.id)`).get(user.id).n;
  const requests = db.prepare("SELECT COUNT(*) AS n FROM friendships WHERE addressee_id = ? AND status = 'pending'").get(user.id).n;
  const plans = db.prepare(`
    SELECT * FROM plans WHERE cancelled = 0 AND ride_id IS NULL AND depart_at > ?
      AND driver_id IN (${ids.map(() => '?').join(',')}) ORDER BY depart_at LIMIT 20`).all(now() - 3 * 3600, ...ids).map(planJson);
  return {
    plans,
    rides: rides.map(r => rideCard(r, user.id)), current: cur ? cur.id : null,
    friends: fids.length, requests, missingPrice, now: now(),
  };
});

route('GET', '/api/rides/:id', true, ({ user, params }) => {
  const ride = q.ride.get(params.id) || fail(404, 'Fahrt nicht gefunden.');
  const parts = q.parts.all(ride.id);
  if (ride.driver_id !== user.id && !parts.some(p => p.user_id === user.id) && !isFriend(user.id, ride.driver_id)) fail(403, 'Keine Berechtigung.');
  const calc = shareCalc(ride, parts);
  const mine = parts.find(p => p.user_id === user.id);
  const pay = mine ? payInfo(q.userById.get(ride.driver_id)) : null;
  const rows = db.prepare('SELECT lat, lng, speed, ts, kind FROM gps_points WHERE ride_id = ? ORDER BY ts').all(ride.id);
  const points = rows.map(p => [p.lat, p.lng]);
  const segments = [];
  for (const p of rows) { if (p.kind === 2 || !segments.length) segments.push([]); segments[segments.length - 1].push([p.lat, p.lng]); }
  const card = rideCard(ride, user.id, parts);
  const track = rows.map(p => [p.lat, p.lng, p.speed, p.ts, p.kind]);
  const zones = track.length > 1 ? rideZones(ride, track) : null;
  card.participants.forEach(p => { p.live_share = calc.shares[p.id]; });
  return {
    ride: card, points, segments, joinable: ride.status === 'active' || ride.ended_at > now() - JOIN_WINDOW,
    calc: { perKm: calc.perKm, totalCost: calc.totalCost, driverShare: calc.driverShare, effConsumption: calc.effConsumption }, pay, track, zones,
  };
});

route('POST', '/api/rides', true, ({ user, body }) => {
  if (q.activeAsDriver.get(user.id)) fail(409, 'Du hast schon eine laufende Fahrt.');
  if (q.activeAsPassenger.get(user.id)) fail(409, 'Du fährst gerade bei jemandem mit.');
  const pts = Array.isArray(body.points) ? body.points : [];
  const t = now();
  const firstTs = pts.length ? Math.round(Math.min(...pts.map(p => +p.ts || t))) : t;
  const started = Math.max(Math.min(firstTs, t), t - 900);
  const car = user.cons_mode === 'car' ? CAR_BY_ID.get(user.car_id) : null;
  const fuel = car ? car.fuel : user.fuel_type || 'benzin';
  const id = db.prepare(`
    INSERT INTO rides (driver_id, fuel_type, consumption, fuel_price, started_at, last_seen, auto_started, car_id, price_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, fuel, car ? car.combined : user.consumption || DEFAULT_CONSUMPTION[fuel],
    user.default_price, started, t, body.auto ? 1 : 0, car ? car.id : null, user.price_note).lastInsertRowid;
  const ride = addPoints(q.ride.get(id), pts.filter(p => +p.ts >= started));

  // A ride started around a planned departure takes over the plan's sign-ups
  const plan = db.prepare(`SELECT * FROM plans WHERE driver_id = ? AND cancelled = 0 AND ride_id IS NULL
    AND depart_at BETWEEN ? AND ? ORDER BY ABS(depart_at - ?) LIMIT 1`).get(user.id, t - 3 * 3600, t + 3600, t);
  if (plan) {
    db.prepare('UPDATE plans SET ride_id = ? WHERE id = ?').run(id, plan.id);
    db.prepare('UPDATE rides SET name = ? WHERE id = ?').run(`Nach ${plan.destination}`.slice(0, 50), id);
    const members = db.prepare('SELECT user_id FROM plan_members WHERE plan_id = ?').all(plan.id).map(m => m.user_id);
    const ins = db.prepare('INSERT INTO ride_participants (ride_id, user_id) VALUES (?, ?)');
    members.forEach(m => ins.run(id, m));
    settle(id);
    push(members, { title: `Fahrt nach ${plan.destination} läuft`, body: `${user.username} ist losgefahren – du bist als Mitfahrer eingetragen.`, url: `/?ride=${id}`, tag: 'ride-' + id });
  }
  send(audience(ride), { type: 'ride_started', rideId: id, driver: user.username }, user.id);
  push(friendIds(user.id).filter(f => !plan || !db.prepare('SELECT 1 FROM plan_members WHERE plan_id = ? AND user_id = ?').get(plan.id, f)),
    { title: `${user.username} fährt los`, body: 'Sitzt du mit drin? Tippe zum Mitfahren.', url: `/?ride=${id}`, tag: 'ride-' + id });
  return { ride: rideCard(ride, user.id) };
});

route('POST', '/api/rides/:id/points', true, async ({ user, params, body }) => {
  const ride = driverRide(params.id, user.id);
  if (ride.status !== 'active') fail(409, 'Fahrt ist schon beendet.');
  const r = await ingest(ride.id, body.points);
  broadcastPos(r);
  return { total_distance: r.total_distance };
});

route('POST', '/api/rides/:id/pause', true, ({ user, params }) => {
  const ride = driverRide(params.id, user.id);
  if (ride.status !== 'active') fail(409, 'Fahrt ist schon beendet.');
  if (!ride.paused_at) db.prepare('UPDATE rides SET paused_at = ? WHERE id = ?').run(now(), ride.id);
  send(audience(ride), { type: 'ride_updated', rideId: ride.id }, user.id);
});

route('POST', '/api/rides/:id/resume', true, ({ user, params }) => {
  const ride = driverRide(params.id, user.id);
  if (ride.status !== 'active') fail(409, 'Fahrt ist schon beendet.');
  if (ride.paused_at) {
    db.prepare('UPDATE rides SET pause_total = COALESCE(pause_total, 0) + ?, paused_at = NULL, seg_break = 1, last_seen = ? WHERE id = ?')
      .run(now() - ride.paused_at, now(), ride.id);
  }
  send(audience(ride), { type: 'ride_updated', rideId: ride.id }, user.id);
});

route('POST', '/api/rides/:id/end', true, async ({ user, params, body }) => {
  const ride = driverRide(params.id, user.id);
  if (ride.status !== 'active') fail(409, 'Fahrt ist schon beendet.');
  if (body.points) await ingest(ride.id, body.points);
  endRide(q.ride.get(ride.id));
  return { ok: true };
});

route('DELETE', '/api/rides/:id', true, ({ user, params }) => {
  const ride = driverRide(params.id, user.id);
  if (db.prepare('SELECT 1 FROM ride_participants WHERE ride_id = ? AND paid_at IS NOT NULL').get(ride.id)) {
    fail(409, 'Es wurde schon bezahlt – Fahrt kann nicht gelöscht werden.');
  }
  deleteRide(ride);
});

route('PUT', '/api/rides/:id', true, ({ user, params, body }) => {
  const ride = driverRide(params.id, user.id);
  const u = {};
  if ('fuel_type' in body) {
    if (!FUEL_TYPES.includes(body.fuel_type)) fail(400, 'Unbekannte Kraftstoffart.');
    u.fuel_type = body.fuel_type;
  }
  if ('fuel_price' in body) { u.fuel_price = num(body.fuel_price, 0.1, 5); u.price_note = body.price_note ? String(body.price_note).slice(0, 120) : null; }
  if ('consumption' in body) { u.consumption = num(body.consumption, 1, 40); u.car_id = null; }
  const keys = Object.keys(u);
  if (keys.length) db.prepare(`UPDATE rides SET ${keys.map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => u[k]), ride.id);
  settle(ride.id);
  send(audience(ride), { type: 'ride_updated', rideId: ride.id }, user.id);
});

route('POST', '/api/rides/:id/name', true, ({ user, params, body }) => {
  const ride = q.ride.get(params.id) || fail(404, 'Fahrt nicht gefunden.');
  if (ride.driver_id !== user.id && !q.part.get(ride.id, user.id)) fail(403, 'Nur Leute aus der Fahrt können sie umbenennen.');
  const name = String(body.name || '').trim().slice(0, 50) || null;
  db.prepare('UPDATE rides SET name = ? WHERE id = ?').run(name, ride.id);
  send(audience(ride), { type: 'ride_updated', rideId: ride.id }, user.id);
});

route('POST', '/api/rides/:id/join', true, ({ user, params, body }) => {
  const ride = q.ride.get(params.id) || fail(404, 'Fahrt nicht gefunden.');
  if (ride.driver_id === user.id) fail(400, 'Das ist deine eigene Fahrt.');
  if (!isFriend(user.id, ride.driver_id)) fail(403, 'Nur Freunde des Fahrers können beitreten.');
  if (ride.status !== 'active' && ride.ended_at < now() - JOIN_WINDOW) fail(409, 'Beitreten geht nur bis 30 Minuten nach Fahrtende.');
  if (q.part.get(ride.id, user.id)) fail(409, 'Du bist schon dabei.');
  if (ride.status === 'active') {
    const cur = currentRide(user.id);
    if (cur) fail(409, cur.driver_id === user.id ? 'Beende oder verwirf zuerst deine eigene Fahrt.' : 'Du bist schon in einer anderen Fahrt.');
  }
  const from = ride.status === 'active' && body.mode === 'now' ? ride.total_distance || 0 : 0;
  db.prepare('INSERT INTO ride_participants (ride_id, user_id, from_km) VALUES (?, ?, ?)').run(ride.id, user.id, from);
  settle(ride.id);
  send(audience(ride), { type: 'ride_updated', rideId: ride.id, msg: `${user.username} fährt mit` }, user.id);
  push([ride.driver_id], { title: `${user.username} fährt mit`, body: 'Die Spritkosten werden automatisch aufgeteilt.', url: `/?ride=${ride.id}`, tag: 'ride-' + ride.id });
});

route('POST', '/api/rides/:id/leave', true, ({ user, params }) => {
  const ride = q.ride.get(params.id) || fail(404, 'Fahrt nicht gefunden.');
  const p = q.part.get(ride.id, user.id) || fail(404, 'Du bist nicht in dieser Fahrt.');
  if (p.paid_at) fail(409, 'Schon bezahlt – Austreten geht nicht mehr.');
  const atKm = ride.total_distance || 0;
  if (ride.status === 'active' && atKm - (p.from_km || 0) >= 0.2) {
    db.prepare('UPDATE ride_participants SET to_km = ? WHERE id = ?').run(atKm, p.id);
  } else {
    db.prepare('DELETE FROM ride_participants WHERE id = ?').run(p.id);
  }
  settle(ride.id);
  send(audience(ride), { type: 'ride_updated', rideId: ride.id, msg: `${user.username} ist ausgestiegen` }, user.id);
});

route('POST', '/api/rides/:id/participants', true, ({ user, params, body }) => {
  const ride = driverRide(params.id, user.id);
  if (body.userId) {
    const uid = +body.userId;
    if (!isFriend(user.id, uid)) fail(403, 'Du kannst nur Freunde hinzufügen.');
    if (q.part.get(ride.id, uid)) fail(409, 'Ist schon dabei.');
    db.prepare('INSERT INTO ride_participants (ride_id, user_id) VALUES (?, ?)').run(ride.id, uid);
    send([uid], { type: 'ride_updated', rideId: ride.id, msg: `${user.username} hat dich zu einer Fahrt hinzugefügt` });
    push([uid], { title: 'Zu einer Fahrt hinzugefügt', body: `${user.username} hat dich als Mitfahrer eingetragen.`, url: `/?ride=${ride.id}` });
  } else {
    const name = String(body.guestName || '').trim().slice(0, 30) || fail(400, 'Name fehlt.');
    db.prepare('INSERT INTO ride_participants (ride_id, guest_name) VALUES (?, ?)').run(ride.id, name);
  }
  settle(ride.id);
  send(audience(ride), { type: 'ride_updated', rideId: ride.id }, user.id);
});

route('DELETE', '/api/rides/:id/participants/:pid', true, ({ user, params }) => {
  const ride = driverRide(params.id, user.id);
  const p = db.prepare('SELECT * FROM ride_participants WHERE id = ? AND ride_id = ?').get(params.pid, ride.id) || fail(404, 'Nicht gefunden.');
  if (p.paid_at) fail(409, 'Schon bezahlt – kann nicht entfernt werden.');
  db.prepare('DELETE FROM ride_participants WHERE id = ?').run(p.id);
  settle(ride.id);
  send(audience(ride).concat(p.user_id ? [p.user_id] : []), { type: 'ride_updated', rideId: ride.id }, user.id);
});

route('GET', '/api/history', true, ({ user }) => {
  const rides = db.prepare(`
    SELECT r.* FROM rides r WHERE r.status = 'ended' AND (r.driver_id = ?
      OR EXISTS (SELECT 1 FROM ride_participants p WHERE p.ride_id = r.id AND p.user_id = ?))
    ORDER BY r.started_at DESC LIMIT 300`).all(user.id, user.id);
  return { rides: rides.map(r => rideCard(r, user.id)) };
});

// Money
route('GET', '/api/balances', true, ({ user }) => {
  const owed = db.prepare(`
    SELECT p.id, p.ride_id, p.user_id, p.guest_name, p.share_eur, r.started_at, r.total_distance,
      u.username, u.avatar_color, u.avatar_v
    FROM ride_participants p JOIN rides r ON r.id = p.ride_id LEFT JOIN users u ON u.id = p.user_id
    WHERE r.driver_id = ? AND r.status = 'ended' AND p.share_eur > 0 AND p.paid_at IS NULL`).all(user.id);
  const owe = db.prepare(`
    SELECT p.id, p.ride_id, p.share_eur, r.started_at, r.total_distance,
      u.id AS user_id, u.username, u.avatar_color, u.avatar_v
    FROM ride_participants p JOIN rides r ON r.id = p.ride_id JOIN users u ON u.id = r.driver_id
    WHERE p.user_id = ? AND r.status = 'ended' AND p.share_eur > 0 AND p.paid_at IS NULL`).all(user.id);

  const map = new Map();
  const bucket = (key, who) => map.get(key) || map.set(key, { key, who, net: 0, items: [] }).get(key);
  let incoming = 0, outgoing = 0;
  for (const o of owed) {
    const b = o.user_id
      ? bucket('u' + o.user_id, pub({ id: o.user_id, username: o.username, avatar_color: o.avatar_color, avatar_v: o.avatar_v }))
      : bucket('g' + o.guest_name.toLowerCase(), { username: o.guest_name, guest: true, color: '#8D958A' });
    b.net += o.share_eur; incoming += o.share_eur;
    b.items.push({ pid: o.id, ride_id: o.ride_id, amount: o.share_eur, dir: 'in', started_at: o.started_at, km: o.total_distance });
  }
  for (const o of owe) {
    const b = bucket('u' + o.user_id, pub({ id: o.user_id, username: o.username, avatar_color: o.avatar_color, avatar_v: o.avatar_v }));
    b.pay ??= payInfo(q.userById.get(o.user_id));
    b.net -= o.share_eur; outgoing += o.share_eur;
    b.items.push({ pid: o.id, ride_id: o.ride_id, amount: o.share_eur, dir: 'out', started_at: o.started_at, km: o.total_distance });
  }
  const balances = [...map.values()]
    .map(b => ({ ...b, net: r2(b.net), items: b.items.sort((x, y) => y.started_at - x.started_at) }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const missing = db.prepare(`
    SELECT r.id, r.started_at, r.total_distance FROM rides r
    WHERE r.driver_id = ? AND r.status = 'ended' AND r.fuel_price IS NULL
      AND EXISTS (SELECT 1 FROM ride_participants p WHERE p.ride_id = r.id)
    ORDER BY r.started_at DESC`).all(user.id);
  return { balances, incoming: r2(incoming), outgoing: r2(outgoing), missing };
});

route('POST', '/api/participants/:pid/paid', true, ({ user, params, body }) => {
  const p = db.prepare('SELECT p.*, r.driver_id FROM ride_participants p JOIN rides r ON r.id = p.ride_id WHERE p.id = ?').get(params.pid)
    || fail(404, 'Nicht gefunden.');
  if (p.driver_id !== user.id && p.user_id !== user.id) fail(403, 'Keine Berechtigung.');
  const paid = body.paid !== false;
  db.prepare('UPDATE ride_participants SET paid_at = ?, paid_by = ? WHERE id = ?').run(paid ? now() : null, paid ? user.id : null, p.id);
  const other = p.driver_id === user.id ? p.user_id : p.driver_id;
  if (other && paid) {
    const msg = `${user.username}: ${p.share_eur?.toFixed(2).replace('.', ',')} € als bezahlt markiert`;
    send([other], { type: 'balance', msg });
    push([other], { title: 'Zahlung', body: msg, url: '/?tab=money' });
  }
});

route('POST', '/api/balances/settle', true, ({ user, body }) => {
  const key = String(body.key || '');
  const t = now();
  const base = `UPDATE ride_participants SET paid_at = ?, paid_by = ?
    WHERE paid_at IS NULL AND share_eur > 0 AND ride_id IN (SELECT id FROM rides WHERE status = 'ended' AND driver_id = ?)`;
  if (key.startsWith('u')) {
    const uid = +key.slice(1);
    db.prepare(base + ' AND user_id = ?').run(t, user.id, user.id, uid);
    db.prepare(base + ' AND user_id = ?').run(t, user.id, uid, user.id);
    send([uid], { type: 'balance', msg: `${user.username} hat eure Rechnung ausgeglichen` });
  } else if (key.startsWith('g')) {
    db.prepare(base + ' AND user_id IS NULL AND lower(guest_name) = ?').run(t, user.id, user.id, key.slice(1));
  } else fail(400, 'Ungültig.');
});

// Friends
route('GET', '/api/users/search', true, ({ user, url }) => {
  const term = (url.searchParams.get('q') || '').trim();
  if (term.length < 2) return { users: [] };
  const rows = db.prepare(`
    SELECT u.*, f.status AS f_status, f.requester_id AS f_req FROM users u
    LEFT JOIN friendships f ON (f.requester_id = ? AND f.addressee_id = u.id) OR (f.addressee_id = ? AND f.requester_id = u.id)
    WHERE u.username LIKE ? ESCAPE '\\' AND u.id != ? ORDER BY length(u.username) LIMIT 20`)
    .all(user.id, user.id, '%' + term.replace(/[\\%_]/g, '\\$&') + '%', user.id);
  return {
    users: rows.map(u => ({
      ...pub(u),
      status: !u.f_status ? 'none' : u.f_status === 'accepted' ? 'friends' : u.f_req === user.id ? 'sent' : 'received',
    })),
  };
});

route('GET', '/api/users', true, ({ user }) => {
  const rows = db.prepare(`
    SELECT u.*, f.status AS f_status, f.requester_id AS f_req FROM users u
    LEFT JOIN friendships f ON (f.requester_id = ? AND f.addressee_id = u.id) OR (f.addressee_id = ? AND f.requester_id = u.id)
    WHERE u.id != ? ORDER BY u.username COLLATE NOCASE`).all(user.id, user.id, user.id);
  return {
    users: rows.map(u => ({
      ...pub(u), role: u.role,
      status: !u.f_status ? 'none' : u.f_status === 'accepted' ? 'friends' : u.f_req === user.id ? 'sent' : 'received',
    })),
  };
});

route('GET', '/api/users/:id/stats', true, ({ user, params }) => {
  const u = q.userById.get(params.id) || fail(404, 'Nutzer nicht gefunden.');
  const self = u.id === user.id;
  if (!self && !isFriend(user.id, u.id)) fail(403, 'Nur Profile von Freunden sind sichtbar.');
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  const driven = one(`
    SELECT COUNT(*) AS n, COALESCE(SUM(total_distance), 0) AS km, COALESCE(SUM(ended_at - started_at - COALESCE(pause_total, 0)), 0) AS secs,
      COALESCE(MAX(total_distance), 0) AS longest,
      COALESCE(SUM(CASE WHEN fuel_price IS NOT NULL THEN total_distance * consumption / 100 * fuel_price END), 0) AS fuel_eur,
      COALESCE(SUM(total_distance * consumption / 100), 0) AS liters
    FROM rides WHERE driver_id = ? AND status = 'ended'`, u.id);
  const ridden = one(`
    SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(p.to_km, r.total_distance) - COALESCE(p.from_km, 0)), 0) AS km,
      COALESCE(SUM(r.ended_at - r.started_at - COALESCE(r.pause_total, 0)), 0) AS secs, COALESCE(SUM(p.share_eur), 0) AS paid_eur,
      COALESCE(MAX(COALESCE(p.to_km, r.total_distance) - COALESCE(p.from_km, 0)), 0) AS longest
    FROM ride_participants p JOIN rides r ON r.id = p.ride_id WHERE p.user_id = ? AND r.status = 'ended'`, u.id);
  const carried = one(`
    SELECT COUNT(*) AS n, COUNT(DISTINCT COALESCE(p.user_id, 'g' || p.guest_name)) AS people
    FROM ride_participants p JOIN rides r ON r.id = p.ride_id WHERE r.driver_id = ? AND r.status = 'ended'`, u.id);
  const topSpeed = one(`
    SELECT COALESCE(MAX(g.speed), 0) AS v FROM gps_points g JOIN rides r ON r.id = g.ride_id
    WHERE r.status = 'ended' AND g.speed < 260 AND g.kind != 1 AND (r.driver_id = ? OR r.id IN (SELECT ride_id FROM ride_participants WHERE user_id = ? AND COALESCE(from_km, 0) = 0 AND to_km IS NULL))`, u.id, u.id).v;

  const involved = `SELECT id, started_at FROM rides WHERE status = 'ended' AND (driver_id = @u OR id IN (SELECT ride_id FROM ride_participants WHERE user_id = @u))`;
  const days = db.prepare(`SELECT strftime('%w', started_at, 'unixepoch', 'localtime') AS d, COUNT(*) AS c FROM (${involved}) GROUP BY d ORDER BY c DESC`).all({ u: u.id });
  const hours = db.prepare(`SELECT CAST(strftime('%H', started_at, 'unixepoch', 'localtime') AS INTEGER) AS h FROM (${involved})`).all({ u: u.id }).map(r => r.h);

  const buddy = one(`
    SELECT other, COUNT(*) AS c FROM (
      SELECT p.user_id AS other FROM ride_participants p JOIN rides r ON r.id = p.ride_id WHERE r.driver_id = @u AND r.status = 'ended' AND p.user_id IS NOT NULL
      UNION ALL SELECT r.driver_id FROM ride_participants p JOIN rides r ON r.id = p.ride_id WHERE p.user_id = @u AND r.status = 'ended'
      UNION ALL SELECT p2.user_id FROM ride_participants p JOIN ride_participants p2 ON p2.ride_id = p.ride_id AND p2.user_id != @u
        JOIN rides r ON r.id = p.ride_id WHERE p.user_id = @u AND r.status = 'ended' AND p2.user_id IS NOT NULL
    ) GROUP BY other ORDER BY c DESC LIMIT 1`, { u: u.id });

  let together = null;
  if (!self) {
    const shared = db.prepare(`
      SELECT r.* FROM rides r WHERE r.status = 'ended' AND (
        (r.driver_id = @a AND EXISTS (SELECT 1 FROM ride_participants WHERE ride_id = r.id AND user_id = @b)) OR
        (r.driver_id = @b AND EXISTS (SELECT 1 FROM ride_participants WHERE ride_id = r.id AND user_id = @a)) OR
        (EXISTS (SELECT 1 FROM ride_participants WHERE ride_id = r.id AND user_id = @a) AND EXISTS (SELECT 1 FROM ride_participants WHERE ride_id = r.id AND user_id = @b)))
      ORDER BY r.started_at DESC`).all({ a: user.id, b: u.id });
    const owedToMe = one(`SELECT COALESCE(SUM(p.share_eur), 0) AS v FROM ride_participants p JOIN rides r ON r.id = p.ride_id
      WHERE r.driver_id = ? AND p.user_id = ? AND r.status = 'ended' AND p.paid_at IS NULL`, user.id, u.id).v;
    const iOwe = one(`SELECT COALESCE(SUM(p.share_eur), 0) AS v FROM ride_participants p JOIN rides r ON r.id = p.ride_id
      WHERE r.driver_id = ? AND p.user_id = ? AND r.status = 'ended' AND p.paid_at IS NULL`, u.id, user.id).v;
    together = {
      n: shared.length, km: shared.reduce((x, r) => x + (r.total_distance || 0), 0), net: r2(owedToMe - iOwe),
      recent: shared.slice(0, 5).map(r => ({ id: r.id, name: r.name, started_at: r.started_at, km: r.total_distance, driver_is_them: r.driver_id === u.id })),
    };
  }

  // Their rides the viewer may open: viewer drove, rode along, or is a friend of the driver
  const rides = db.prepare(`
    SELECT r.* FROM rides r WHERE r.status = 'ended'
      AND (r.driver_id = @u OR EXISTS (SELECT 1 FROM ride_participants p WHERE p.ride_id = r.id AND p.user_id = @u))
      AND (r.driver_id = @me OR EXISTS (SELECT 1 FROM ride_participants p WHERE p.ride_id = r.id AND p.user_id = @me)
        OR EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted'
          AND ((f.requester_id = @me AND f.addressee_id = r.driver_id) OR (f.addressee_id = @me AND f.requester_id = r.driver_id))))
    ORDER BY r.started_at DESC LIMIT 50`).all({ u: u.id, me: user.id }).map(r => {
    const parts = q.parts.all(r.id);
    const p = parts.find(x => x.user_id === u.id);
    return {
      id: r.id, name: r.name, started_at: r.started_at, ended_at: r.ended_at, pause_total: r.pause_total || 0, driver: pub(q.userById.get(r.driver_id)),
      km: p ? (p.to_km ?? r.total_distance) - (p.from_km || 0) : r.total_distance, people: parts.length + 1,
    };
  });

  const buddyUser = buddy ? q.userById.get(buddy.other) : null;
  return {
    user: { ...pub(u), role: u.role, since: u.created_at, car: carLabel(CAR_BY_ID.get(u.car_id)) || u.car_name || null, fuel: fuelState(u) },
    driven, ridden, carried, topSpeed, days, hours, rides,
    buddy: buddyUser ? { ...pub(buddyUser), count: buddy.c } : null,
    together,
  };
});

function planJson(p) {
  const members = db.prepare('SELECT u.* FROM plan_members m JOIN users u ON u.id = m.user_id WHERE m.plan_id = ? ORDER BY m.created_at').all(p.id);
  return {
    id: p.id, destination: p.destination, depart_at: p.depart_at, seats: p.seats, note: p.note,
    driver: pub(q.userById.get(p.driver_id)), members: members.map(pub),
  };
}

function viewablePlan(id, uid) {
  const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) || fail(404, 'Fahrt nicht gefunden.');
  if (p.driver_id !== uid && !isFriend(uid, p.driver_id)) fail(403, 'Keine Berechtigung.');
  return p;
}

route('POST', '/api/plans', true, ({ user, body }) => {
  const destination = String(body.destination || '').trim().slice(0, 60) || fail(400, 'Bitte ein Ziel eintragen.');
  const depart = Math.round(+body.depart_at);
  if (!Number.isFinite(depart) || depart < now() - 3600 || depart > now() + 60 * 86400) fail(400, 'Bitte eine Abfahrtszeit innerhalb der nächsten 60 Tage wählen.');
  const seats = Math.min(Math.max(Math.round(+body.seats) || 3, 1), 8);
  const note = String(body.note || '').trim().slice(0, 140) || null;
  const id = db.prepare('INSERT INTO plans (driver_id, destination, depart_at, seats, note) VALUES (?, ?, ?, ?, ?)').run(user.id, destination, depart, seats, note).lastInsertRowid;
  const when = new Date(depart * 1000).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  const fids = friendIds(user.id);
  push(fids, { title: `${user.username} fährt nach ${destination}`, body: `${when} · ${seats} ${seats === 1 ? 'Platz' : 'Plätze'} frei – tippe zum Mitfahren.`, url: `/?plan=${id}`, tag: 'plan-' + id });
  send(fids, { type: 'plan', msg: `${user.username} plant eine Fahrt nach ${destination}` });
  return { plan: planJson(q.planById.get(id)) };
});

route('GET', '/api/plans/:id', true, ({ user, params }) => ({ plan: planJson(viewablePlan(params.id, user.id)) }));

route('POST', '/api/plans/:id/join', true, ({ user, params }) => {
  const p = viewablePlan(params.id, user.id);
  if (p.driver_id === user.id) fail(400, 'Das ist deine eigene Fahrt.');
  if (p.cancelled || p.ride_id) fail(409, 'Diese Fahrt ist nicht mehr offen.');
  const n = db.prepare('SELECT COUNT(*) AS n FROM plan_members WHERE plan_id = ?').get(p.id).n;
  if (n >= p.seats) fail(409, 'Alle Plätze sind schon vergeben.');
  db.prepare('INSERT OR IGNORE INTO plan_members (plan_id, user_id) VALUES (?, ?)').run(p.id, user.id);
  push([p.driver_id], { title: `${user.username} fährt mit nach ${p.destination}`, body: `${n + 1} von ${p.seats} Plätzen belegt.`, url: `/?plan=${p.id}`, tag: 'plan-' + p.id });
  send([p.driver_id, ...friendIds(p.driver_id)], { type: 'plan' }, user.id);
});

route('POST', '/api/plans/:id/leave', true, ({ user, params }) => {
  const p = viewablePlan(params.id, user.id);
  db.prepare('DELETE FROM plan_members WHERE plan_id = ? AND user_id = ?').run(p.id, user.id);
  push([p.driver_id], { title: `${user.username} fährt doch nicht mit`, body: `Fahrt nach ${p.destination}`, url: `/?plan=${p.id}`, tag: 'plan-' + p.id });
  send([p.driver_id, ...friendIds(p.driver_id)], { type: 'plan' }, user.id);
});

route('DELETE', '/api/plans/:id', true, ({ user, params }) => {
  const p = viewablePlan(params.id, user.id);
  if (p.driver_id !== user.id) fail(403, 'Nur der Fahrer kann absagen.');
  const members = db.prepare('SELECT user_id FROM plan_members WHERE plan_id = ?').all(p.id).map(m => m.user_id);
  db.prepare('UPDATE plans SET cancelled = 1 WHERE id = ?').run(p.id);
  push(members, { title: `Fahrt nach ${p.destination} abgesagt`, body: `${user.username} hat die Fahrt abgesagt.`, url: '/' });
  send([user.id, ...friendIds(user.id)], { type: 'plan' }, user.id);
});

route('GET', '/api/push/key', true, () => ({ key: vapid.publicKey }));

route('POST', '/api/push/subscribe', true, ({ user, body }) => {
  const endpoint = String(body.endpoint || '');
  const { p256dh, auth } = body.keys || {};
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) fail(400, 'Ungültiges Abo.');
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`).run(user.id, endpoint, p256dh, auth);
});

route('POST', '/api/push/test', true, ({ user }) => {
  push([user.id], { title: 'Benachrichtigungen funktionieren', body: 'So siehst du, wenn Freunde losfahren oder eine Fahrt planen.', url: '/' });
});

route('GET', '/api/fuel/nearby', true, async ({ url }) => {
  if (!TK_KEY) return { available: false, stations: [] };
  const lat = +url.searchParams.get('lat'), lng = +url.searchParams.get('lng');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) fail(400, 'Position fehlt.');
  const rad = Math.min(Math.max(Math.round(+url.searchParams.get('rad') || 5), 1), 25);
  try { return { available: true, stations: await nearbyStations(lat, lng, rad) }; }
  catch (e) { fail(502, 'Tankerkönig ist gerade nicht erreichbar.'); }
});

// Monthly statement: who owes whom from rides in a month, paid or not
route('GET', '/api/statement', true, ({ user, url }) => {
  const m = /^(\d{4})-(\d{2})$/.exec(url.searchParams.get('month') || '') || fail(400, 'Monat fehlt.');
  const from = Date.UTC(+m[1], +m[2] - 1, 1) / 1000, to = Date.UTC(+m[1], +m[2], 1) / 1000;
  const rides = db.prepare(`
    SELECT r.* FROM rides r WHERE r.status = 'ended' AND r.started_at >= ? AND r.started_at < ?
      AND (r.driver_id = ? OR EXISTS (SELECT 1 FROM ride_participants p WHERE p.ride_id = r.id AND p.user_id = ?))
    ORDER BY r.started_at`).all(from, to, user.id, user.id);
  const people = new Map();
  const person = (key, who) => people.get(key) || people.set(key, { key, who, toMe: 0, fromMe: 0, openToMe: 0, openFromMe: 0 }).get(key);
  let km = 0, fuelSpent = 0, myCost = 0, missing = 0;
  for (const r of rides) {
    const parts = q.parts.all(r.id);
    const calc = shareCalc(r, parts);
    if (calc.totalCost == null) missing++;
    if (r.driver_id === user.id) {
      km += r.total_distance || 0;
      fuelSpent += calc.totalCost || 0;
      myCost += calc.driverShare || 0;
      for (const p of parts) {
        if (!(p.share_eur > 0)) continue;
        const b = p.user_id ? person('u' + p.user_id, pub(q.userById.get(p.user_id))) : person('g' + p.guest_name.toLowerCase(), { username: p.guest_name, guest: true, color: '#8D958A' });
        b.toMe += p.share_eur;
        if (!p.paid_at) b.openToMe += p.share_eur;
      }
    } else {
      const p = parts.find(x => x.user_id === user.id);
      km += (p.to_km ?? r.total_distance) - (p.from_km || 0);
      myCost += p.share_eur || 0;
      if (p.share_eur > 0) {
        const b = person('u' + r.driver_id, pub(q.userById.get(r.driver_id)));
        b.fromMe += p.share_eur;
        if (!p.paid_at) b.openFromMe += p.share_eur;
      }
    }
  }
  const round = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));
  return {
    month: m[0], rides: rides.length, km: Math.round(km * 10) / 10, fuelSpent: r2(fuelSpent), myCost: r2(myCost), missing,
    people: [...people.values()].map(round).sort((a, b) => Math.abs(b.toMe - b.fromMe) - Math.abs(a.toMe - a.fromMe)),
  };
});

// On the 1st of each month, tell everyone who drove last month that their statement is ready
setInterval(() => {
  const d = new Date();
  if (d.getUTCDate() !== 1 || d.getUTCHours() < 8) return;
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const key = 'statement-' + prev.toISOString().slice(0, 7);
  if (getSetting(key)) return;
  setSetting(key, '1');
  const from = prev.getTime() / 1000, to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  const uids = db.prepare(`
    SELECT driver_id AS id FROM rides WHERE status = 'ended' AND started_at >= ? AND started_at < ?
    UNION SELECT p.user_id FROM ride_participants p JOIN rides r ON r.id = p.ride_id
      WHERE r.status = 'ended' AND r.started_at >= ? AND r.started_at < ? AND p.user_id IS NOT NULL`).all(from, to, from, to).map(r => r.id);
  const label = prev.toLocaleDateString('de-DE', { month: 'long', timeZone: 'UTC' });
  push(uids, { title: `Monatsabrechnung ${label}`, body: 'Schau nach, wer wem noch etwas schuldet.', url: '/?tab=money' });
}, 30 * 60 * 1000);

route('GET', '/api/cars', false, () => ({ cars: CARS }));

route('POST', '/api/friends/request', true, ({ user, body }) => {
  const target = body.userId
    ? q.userById.get(+body.userId)
    : db.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username || '').trim());
  if (!target) fail(404, 'Nutzer nicht gefunden.');
  if (target.id === user.id) fail(400, 'Das bist du selbst.');
  const f = db.prepare('SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)')
    .get(user.id, target.id, target.id, user.id);
  if (f?.status === 'accepted') fail(409, 'Ihr seid schon befreundet.');
  if (f && f.requester_id === user.id) fail(409, 'Anfrage wurde schon gesendet.');
  if (f) {
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(f.id);
    send([target.id], { type: 'friend_accepted', msg: `${user.username} ist jetzt dein Freund` });
    return { status: 'friends' };
  }
  db.prepare('INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)').run(user.id, target.id);
  send([target.id], { type: 'friend_request', msg: `${user.username} möchte mit dir befreundet sein` });
  push([target.id], { title: 'Freundschaftsanfrage', body: `${user.username} möchte mit dir befreundet sein.`, url: '/?tab=friends' });
  return { status: 'sent' };
});

route('POST', '/api/friends/respond', true, ({ user, body }) => {
  const f = db.prepare("SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'").get(+body.userId, user.id)
    || fail(404, 'Anfrage nicht gefunden.');
  if (body.accept) {
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(f.id);
    send([f.requester_id], { type: 'friend_accepted', msg: `${user.username} hat deine Anfrage angenommen` });
    push([f.requester_id], { title: 'Neuer Freund', body: `${user.username} hat deine Anfrage angenommen.`, url: '/?tab=friends' });
  } else {
    db.prepare('DELETE FROM friendships WHERE id = ?').run(f.id);
  }
});

route('POST', '/api/friends/remove', true, ({ user, body }) => {
  const uid = +body.userId;
  db.prepare('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)').run(user.id, uid, uid, user.id);
});

route('GET', '/api/friends', true, ({ user }) => {
  const friends = db.prepare(`
    SELECT u.*, (SELECT id FROM rides WHERE driver_id = u.id AND status = 'active') AS active_ride
    FROM friendships f JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
    WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
    ORDER BY u.username COLLATE NOCASE`).all(user.id, user.id, user.id);
  const incoming = db.prepare(`
    SELECT u.* FROM friendships f JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`).all(user.id);
  const outgoing = db.prepare(`
    SELECT u.* FROM friendships f JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`).all(user.id);
  return {
    friends: friends.map(u => ({ ...pub(u), role: u.role, active_ride: u.active_ride })),
    incoming: incoming.map(pub), outgoing: outgoing.map(pub),
  };
});

// ── HTTP ──────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) { d = ''; req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function serveStatic(pathname, res) {
  let fp;
  try { fp = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname))); } catch { fp = PUBLIC; }
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(fp, (err, st) => {
    if (err || st.isDirectory()) fp = path.join(PUBLIC, 'index.html');
    fs.readFile(fp, (e, data) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
        'Cache-Control': /\.(png|svg)$/.test(fp) ? 'public, max-age=86400' : 'no-cache',
      });
      res.end(data);
    });
  });
}

function serveAvatar(id, res) {
  const u = db.prepare('SELECT avatar_data FROM users WHERE id = ?').get(id);
  const m = u?.avatar_data?.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(Buffer.from(m[2], 'base64'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
  try {
    const am = url.pathname.match(/^\/api\/avatar\/(\d+)$/);
    if (am) return serveAvatar(+am[1], res);
    const r = routes.find(x => x.m === req.method && x.re.test(url.pathname)) || fail(404, 'Nicht gefunden.');
    const params = Object.fromEntries(Object.entries(url.pathname.match(r.re).groups || {}).map(([k, v]) => [k, +v]));
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = token ? q.userByToken.get(token) : null;
    if (r.auth && !user) fail(401, 'Bitte melde dich neu an.');
    const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    json(res, 200, (await r.fn({ req, url, user, body, params, token })) ?? { ok: true });
  } catch (e) {
    if (!(e instanceof HttpErr)) console.error(e);
    json(res, e.status || 500, { error: e.status ? e.message : 'Serverfehler – bitte nochmal versuchen.' });
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', ws => {
  let user = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', async raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'auth') {
      user = q.userByToken.get(String(m.token || ''));
      if (!user) return ws.close(4001);
      if (!sockets.has(user.id)) sockets.set(user.id, new Set());
      sockets.get(user.id).add(ws);
      return;
    }
    if (!user || m.type !== 'points') return;
    const ride = q.ride.get(+m.rideId);
    if (!ride || ride.driver_id !== user.id || ride.status !== 'active') return;
    try {
      const r = await ingest(ride.id, m.points);
      broadcastPos(r);
      ws.send(JSON.stringify({ type: 'ack', seq: m.seq, dist: r.total_distance }));
    } catch (e) { console.error(e); }
  });
  ws.on('close', () => {
    if (!user) return;
    const set = sockets.get(user.id);
    set?.delete(ws);
    if (set && !set.size) sockets.delete(user.id);
  });
});

setInterval(() => wss.clients.forEach(ws => {
  if (!ws.isAlive) return ws.terminate();
  ws.isAlive = false;
  ws.ping();
}), 30000);

server.listen(PORT, () => console.log(`TankiTankiGeldiGeldi läuft auf Port ${PORT}`));
