'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8081;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tankigeldi.db');
const PUBLIC = path.join(__dirname, 'public');

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#C95B18',
    avatar_data TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS rides (
    id INTEGER PRIMARY KEY,
    driver_id INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    fuel_type TEXT DEFAULT 'benzin',
    fuel_price REAL,
    avg_consumption REAL,
    total_distance REAL DEFAULT 0,
    started_at INTEGER DEFAULT (unixepoch()),
    ended_at INTEGER,
    FOREIGN KEY (driver_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS ride_participants (
    id INTEGER PRIMARY KEY,
    ride_id INTEGER NOT NULL,
    user_id INTEGER,
    guest_name TEXT,
    joined_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS gps_points (
    id INTEGER PRIMARY KEY,
    ride_id INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    speed REAL DEFAULT 0,
    ts INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_gps_ride ON gps_points(ride_id, ts);
  CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const token = () => crypto.randomBytes(32).toString('hex');

function userFromToken(t) {
  if (!t) return null;
  const s = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(t);
  if (!s) return null;
  return db.prepare('SELECT id, username, avatar_color, avatar_data FROM users WHERE id = ?').get(s.user_id);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function recalcDistance(rideId) {
  const pts = db.prepare('SELECT lat, lng FROM gps_points WHERE ride_id = ? ORDER BY ts ASC').all(rideId);
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng);
  db.prepare('UPDATE rides SET total_distance = ? WHERE id = ?').run(Math.round(d * 1000) / 1000, rideId);
  return d;
}

function costBreakdown(ride, nParticipants) {
  if (!ride.fuel_price || !ride.total_distance) return null;
  const cons = ride.avg_consumption || (ride.fuel_type === 'diesel' ? 6.5 : ride.fuel_type === 'elektro' ? 0 : 7.5);
  const liters = (ride.total_distance * cons) / 100;
  const total = liters * ride.fuel_price;
  const pp = total / Math.max(nParticipants, 1);
  return {
    totalEur: +(total.toFixed(2)),
    perPersonEur: +(pp.toFixed(2)),
    liters: +(liters.toFixed(2)),
    distanceKm: +(ride.total_distance.toFixed(1)),
    nParticipants,
    fuelType: ride.fuel_type,
    pricePerLiter: ride.fuel_price,
    consumption: cons,
  };
}

function rideRow(r) {
  return db.prepare(`
    SELECT r.*, u.username AS driver_name, u.avatar_color AS driver_color, u.avatar_data AS driver_avatar,
      (SELECT COUNT(*) FROM ride_participants WHERE ride_id = r.id) AS participant_count,
      (SELECT lat FROM gps_points WHERE ride_id = r.id ORDER BY ts DESC LIMIT 1) AS last_lat,
      (SELECT lng FROM gps_points WHERE ride_id = r.id ORDER BY ts DESC LIMIT 1) AS last_lng,
      (SELECT speed FROM gps_points WHERE ride_id = r.id ORDER BY ts DESC LIMIT 1) AS last_speed
    FROM rides r JOIN users u ON u.id = r.driver_id
    WHERE r.id = ?
  `).get(r.id ?? r);
}

// ── HTTP utils ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) { d = ''; req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function staticFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: any unknown path → index.html
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── WebSocket clients ─────────────────────────────────────────────────────────
// Map: userId → ws
const clients = new Map();

function broadcast(data, excludeUserId = null) {
  const msg = JSON.stringify(data);
  clients.forEach((ws, uid) => {
    if (uid !== excludeUserId && ws.readyState === 1) ws.send(msg);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const authToken = req.headers.authorization?.slice(7) || url.searchParams.get('token');

  if (!p.startsWith('/api/')) {
    // Serve static
    const fp = p === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, p);
    // Prevent path traversal
    if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    return staticFile(res, fp);
  }

  // ── API ──
  const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};

  // Public endpoints
  if (p === '/api/register' && req.method === 'POST') {
    const { username, password } = body;
    if (!username?.trim() || !password || username.trim().length < 2 || password.length < 4)
      return json(res, 400, { error: 'Benutzername (min. 2) und Passwort (min. 4 Zeichen) erforderlich.' });
    try {
      const hash = bcrypt.hashSync(password, 10);
      const u = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, username, avatar_color').get(username.trim(), hash);
      const t = token();
      db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(t, u.id);
      return json(res, 201, { token: t, user: u });
    } catch {
      return json(res, 409, { error: 'Benutzername bereits vergeben.' });
    }
  }

  if (p === '/api/login' && req.method === 'POST') {
    const { username, password } = body;
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.trim());
    if (!u || !bcrypt.compareSync(password || '', u.password_hash))
      return json(res, 401, { error: 'Falscher Benutzername oder Passwort.' });
    const t = token();
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(t, u.id);
    return json(res, 200, { token: t, user: { id: u.id, username: u.username, avatar_color: u.avatar_color, avatar_data: u.avatar_data } });
  }

  // Protected endpoints – require auth
  const user = userFromToken(authToken);
  if (!user) return json(res, 401, { error: 'Nicht angemeldet.' });

  if (p === '/api/me' && req.method === 'GET')
    return json(res, 200, { user });

  if (p === '/api/me' && req.method === 'PUT') {
    const { avatar_color, avatar_data, username } = body;
    if (username?.trim() && username.trim().length >= 2) {
      try { db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username.trim(), user.id); }
      catch { return json(res, 409, { error: 'Benutzername bereits vergeben.' }); }
    }
    if (avatar_color) db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run(avatar_color, user.id);
    if (avatar_data !== undefined) db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(avatar_data, user.id);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(authToken);
    return json(res, 200, { ok: true });
  }

  // Rides list
  if (p === '/api/rides' && req.method === 'GET') {
    const rides = db.prepare(`
      SELECT r.*, u.username AS driver_name, u.avatar_color AS driver_color, u.avatar_data AS driver_avatar,
        (SELECT COUNT(*) FROM ride_participants rp WHERE rp.ride_id = r.id) AS participant_count,
        (SELECT lat FROM gps_points WHERE ride_id = r.id ORDER BY ts DESC LIMIT 1) AS last_lat,
        (SELECT lng FROM gps_points WHERE ride_id = r.id ORDER BY ts DESC LIMIT 1) AS last_lng,
        (SELECT speed FROM gps_points WHERE ride_id = r.id ORDER BY ts DESC LIMIT 1) AS last_speed
      FROM rides r JOIN users u ON u.id = r.driver_id
      WHERE r.status = 'active'
         OR (r.status = 'ended' AND r.ended_at > unixepoch() - 1800)
      ORDER BY r.status DESC, r.started_at DESC
    `).all();
    return json(res, 200, { rides });
  }

  // Start ride
  if (p === '/api/rides' && req.method === 'POST') {
    const existing = db.prepare("SELECT id FROM rides WHERE driver_id = ? AND status = 'active'").get(user.id);
    if (existing) return json(res, 409, { error: 'Du hast bereits eine aktive Fahrt.' });
    const r = db.prepare('INSERT INTO rides (driver_id, fuel_type) VALUES (?, ?) RETURNING *').get(user.id, body.fuel_type || 'benzin');
    db.prepare('INSERT INTO ride_participants (ride_id, user_id) VALUES (?, ?)').run(r.id, user.id);
    const full = rideRow(r);
    broadcast({ type: 'ride_started', ride: full });
    return json(res, 201, { ride: full });
  }

  // Single ride
  const m1 = p.match(/^\/api\/rides\/(\d+)$/);
  if (m1) {
    const rideId = +m1[1];
    if (req.method === 'GET') {
      const ride = db.prepare(`
        SELECT r.*, u.username AS driver_name, u.avatar_color AS driver_color, u.avatar_data AS driver_avatar
        FROM rides r JOIN users u ON u.id = r.driver_id WHERE r.id = ?
      `).get(rideId);
      if (!ride) return json(res, 404, { error: 'Fahrt nicht gefunden.' });
      const participants = db.prepare(`
        SELECT rp.id, rp.guest_name, rp.joined_at, u.id AS user_id, u.username, u.avatar_color, u.avatar_data
        FROM ride_participants rp LEFT JOIN users u ON u.id = rp.user_id
        WHERE rp.ride_id = ? ORDER BY rp.joined_at ASC
      `).all(rideId);
      const route = db.prepare('SELECT lat, lng, speed, ts FROM gps_points WHERE ride_id = ? ORDER BY ts ASC').all(rideId);
      const nP = participants.length;
      const cost = costBreakdown(ride, nP);
      return json(res, 200, { ride, participants, route, cost });
    }
    if (req.method === 'DELETE') {
      const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND driver_id = ? AND status = 'active'").get(rideId, user.id);
      if (!ride) return json(res, 404, { error: 'Fahrt nicht gefunden.' });
      const dist = recalcDistance(rideId);
      db.prepare("UPDATE rides SET status = 'ended', ended_at = unixepoch(), total_distance = ? WHERE id = ?").run(dist, rideId);
      const nP = db.prepare('SELECT COUNT(*) AS c FROM ride_participants WHERE ride_id = ?').get(rideId).c;
      const updatedRide = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
      const cost = costBreakdown(updatedRide, nP);
      broadcast({ type: 'ride_ended', rideId, cost });
      return json(res, 200, { ok: true, cost });
    }
    if (req.method === 'PUT') {
      // Update fuel info
      const { fuel_type, fuel_price, avg_consumption } = body;
      db.prepare('UPDATE rides SET fuel_type = COALESCE(?, fuel_type), fuel_price = COALESCE(?, fuel_price), avg_consumption = COALESCE(?, avg_consumption) WHERE id = ? AND driver_id = ?')
        .run(fuel_type ?? null, fuel_price ?? null, avg_consumption ?? null, rideId, user.id);
      const updRide = db.prepare('SELECT * FROM rides WHERE id = ?').get(rideId);
      const nP = db.prepare('SELECT COUNT(*) AS c FROM ride_participants WHERE ride_id = ?').get(rideId).c;
      const cost = costBreakdown(updRide, nP);
      broadcast({ type: 'ride_updated', rideId, cost });
      return json(res, 200, { ok: true, cost });
    }
  }

  // Join ride
  const m2 = p.match(/^\/api\/rides\/(\d+)\/join$/);
  if (m2 && req.method === 'POST') {
    const rideId = +m2[1];
    const ride = db.prepare(`SELECT * FROM rides WHERE id = ? AND (status = 'active' OR (status = 'ended' AND ended_at > unixepoch() - 1800))`).get(rideId);
    if (!ride) return json(res, 404, { error: 'Fahrt nicht mehr verfügbar.' });
    const already = db.prepare('SELECT id FROM ride_participants WHERE ride_id = ? AND user_id = ?').get(rideId, user.id);
    if (already) return json(res, 409, { error: 'Du bist bereits dabei.' });
    db.prepare('INSERT INTO ride_participants (ride_id, user_id) VALUES (?, ?)').run(rideId, user.id);
    broadcast({ type: 'participant_joined', rideId, participant: { username: user.username, avatar_color: user.avatar_color, avatar_data: user.avatar_data, user_id: user.id } });
    return json(res, 200, { ok: true });
  }

  // Add guest participant
  const m3 = p.match(/^\/api\/rides\/(\d+)\/participants$/);
  if (m3 && req.method === 'POST') {
    const rideId = +m3[1];
    const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND driver_id = ?").get(rideId, user.id);
    if (!ride) return json(res, 403, { error: 'Nur der Fahrer kann Teilnehmer hinzufügen.' });
    const { guest_name } = body;
    if (!guest_name?.trim()) return json(res, 400, { error: 'Name erforderlich.' });
    db.prepare('INSERT INTO ride_participants (ride_id, guest_name) VALUES (?, ?)').run(rideId, guest_name.trim());
    broadcast({ type: 'participant_joined', rideId, participant: { username: guest_name.trim(), avatar_color: '#A89D84', isGuest: true } });
    return json(res, 200, { ok: true });
  }

  // GPS location via HTTP (fallback when WS unavailable)
  const m4 = p.match(/^\/api\/rides\/(\d+)\/location$/);
  if (m4 && req.method === 'POST') {
    const rideId = +m4[1];
    const { lat, lng, speed } = body;
    if (!lat || !lng) return json(res, 400, { error: 'Koordinaten fehlen.' });
    db.prepare('INSERT INTO gps_points (ride_id, lat, lng, speed) VALUES (?, ?, ?, ?)').run(rideId, lat, lng, speed || 0);
    const dist = recalcDistance(rideId);
    broadcast({ type: 'driver_location', rideId, lat, lng, speed: speed || 0, driverId: user.id, driverName: user.username }, user.id);
    return json(res, 200, { ok: true, totalDistance: dist });
  }

  // Bulk GPS upload – pre-buffered points from before ride auto-start
  const m4b = p.match(/^\/api\/rides\/(\d+)\/location\/bulk$/);
  if (m4b && req.method === 'POST') {
    const rideId = +m4b[1];
    const { points } = body;
    if (!Array.isArray(points) || points.length === 0) return json(res, 400, { error: 'Keine Punkte.' });
    const insert = db.prepare('INSERT INTO gps_points (ride_id, lat, lng, speed) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction(pts => {
      for (const pt of pts) {
        if (pt.lat != null && pt.lng != null) insert.run(rideId, pt.lat, pt.lng, pt.speed || 0);
      }
    });
    insertMany(points);
    const dist = recalcDistance(rideId);
    return json(res, 200, { ok: true, inserted: points.length, totalDistance: dist });
  }

  // Ride history for profile
  if (p === '/api/my-rides' && req.method === 'GET') {
    const rides = db.prepare(`
      SELECT r.*, u.username AS driver_name,
        (SELECT COUNT(*) FROM ride_participants WHERE ride_id = r.id) AS participant_count
      FROM rides r
      JOIN ride_participants rp ON rp.ride_id = r.id AND (rp.user_id = ? OR r.driver_id = ?)
      JOIN users u ON u.id = r.driver_id
      WHERE r.status = 'ended'
      GROUP BY r.id
      ORDER BY r.ended_at DESC LIMIT 50
    `).all(user.id, user.id);
    return json(res, 200, { rides });
  }

  json(res, 404, { error: 'Route nicht gefunden.' });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let user = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      user = userFromToken(msg.token);
      if (user) {
        // Replace existing connection for this user
        const old = clients.get(user.id);
        if (old && old !== ws && old.readyState < 2) old.close();
        clients.set(user.id, ws);
        ws.send(JSON.stringify({ type: 'auth_ok', userId: user.id }));
      } else {
        ws.send(JSON.stringify({ type: 'auth_fail' }));
      }
      return;
    }

    if (!user) return;

    if (msg.type === 'location') {
      const { rideId, lat, lng, speed } = msg;
      if (!rideId || lat == null || lng == null) return;
      db.prepare('INSERT INTO gps_points (ride_id, lat, lng, speed) VALUES (?, ?, ?, ?)').run(rideId, lat, lng, speed || 0);
      recalcDistance(rideId);
      // Broadcast to all other clients
      const out = JSON.stringify({ type: 'driver_location', rideId, lat, lng, speed: speed || 0, driverId: user.id, driverName: user.username });
      clients.forEach((c, uid) => {
        if (uid !== user.id && c.readyState === 1) c.send(out);
      });
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (user && clients.get(user.id) === ws) clients.delete(user.id);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`tanki läuft auf :${PORT}`));
