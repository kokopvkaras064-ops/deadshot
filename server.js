'use strict';
// Deadshot.io Tournament Platform — zero-dependency Node.js backend (node:sqlite + node:http)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'data.db');

// ---------------------------------------------------------------- Database
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_host INTEGER NOT NULL DEFAULT 0,
  host_type TEXT NOT NULL DEFAULT 'none',
  perm_level TEXT NOT NULL DEFAULT 'none',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  points INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  username TEXT NOT NULL,
  PRIMARY KEY (team_id, username)
);
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  team1 TEXT NOT NULL,
  team2 TEXT NOT NULL,
  score1 INTEGER NOT NULL DEFAULT 0,
  score2 INTEGER NOT NULL DEFAULT 0,
  winner TEXT
);
`);

function seedIfEmpty() {
  if (db.prepare('SELECT COUNT(*) c FROM teams').get().c === 0) {
    const insTeam = db.prepare('INSERT INTO teams (id,name,points) VALUES (?,?,?)');
    const insMember = db.prepare('INSERT INTO team_members (team_id,username) VALUES (?,?)');
    const seed = [
      { id: newId('t'), name: 'Alpha Squad', points: 150, members: ['Viper_Sniper', 'Deadshot_Pro'] },
      { id: newId('t'), name: 'Cyber Kings', points: 110, members: ['Ghost_Rider', 'Shadow_NXT'] },
      { id: newId('t'), name: 'Viper Clan', points: 80, members: ['Kratos_99', 'Phoenix_X'] },
    ];
    for (const t of seed) {
      insTeam.run(t.id, t.name, t.points);
      for (const m of t.members) insMember.run(t.id, m);
    }
  }
  if (db.prepare('SELECT COUNT(*) c FROM rounds').get().c === 0) {
    const rId = newId('r');
    db.prepare('INSERT INTO rounds (id,title) VALUES (?,?)').run(rId, 'الجولة الأولى - التصفيات الرسمية');
    db.prepare('INSERT INTO matches (id,round_id,team1,team2,score1,score2,winner) VALUES (?,?,?,?,?,?,?)')
      .run(newId('m'), rId, 'Alpha Squad', 'Viper Clan', 16, 12, 'Alpha Squad');
    db.prepare('INSERT INTO matches (id,round_id,team1,team2,score1,score2,winner) VALUES (?,?,?,?,?,?,?)')
      .run(newId('m'), rId, 'Cyber Kings', 'الفائز القادم', 0, 0, null);
  }
}

function newId(prefix) {
  return `${prefix}_${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------- Auth helpers
const PW_RE = /^[a-zA-Z0-9]{6,}$/;

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ).get(token, Date.now());
  return row || null;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, Date.now() + 30 * 24 * 3600 * 1000);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}

function destroySession(req) {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    isHost: !!u.is_host,
    hostType: u.is_host ? u.host_type : 'none',
    permLevel: u.is_host ? u.perm_level : 'none',
  };
}

function canManageTeams(u) {
  if (!u) return false;
  if (u.host_type === 'primary') return true;
  if (!u.is_host) return false;
  return ['full', 'teams_only'].includes(u.perm_level || 'full');
}

function canManageSchedule(u) {
  if (!u) return false;
  if (u.host_type === 'primary') return true;
  if (!u.is_host) return false;
  return ['full', 'schedule_only'].includes(u.perm_level || 'full');
}

const isPrimary = (u) => u && u.host_type === 'primary';

// ---------------------------------------------------------------- Serializers
function getTeams() {
  const teams = db.prepare('SELECT * FROM teams').all();
  const members = db.prepare('SELECT * FROM team_members').all();
  return teams.map(t => ({
    id: t.id,
    name: t.name,
    points: t.points,
    members: members.filter(m => m.team_id === t.id).map(m => m.username),
  }));
}

function getRounds() {
  const rounds = db.prepare('SELECT * FROM rounds').all();
  const matches = db.prepare('SELECT * FROM matches').all();
  return rounds.map(r => ({
    id: r.id,
    title: r.title,
    matches: matches.filter(m => m.round_id === r.id).map(m => ({
      id: m.id, team1: m.team1, team2: m.team2, score1: m.score1, score2: m.score2, winner: m.winner,
    })),
  }));
}

function deriveWinner(match) {
  if (match.score1 > match.score2) return match.team1;
  if (match.score2 > match.score1) return match.team2;
  return null;
}

// ---------------------------------------------------------------- HTTP utils
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e5) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------------------------------------------------------------- API routes
const VALID_PERMS = ['full', 'schedule_only', 'teams_only', 'readonly'];

async function handleApi(req, res, pathname) {
  const method = req.method;
  const u = currentUser(req);
  const body = (method === 'POST' || method === 'PATCH' || method === 'PUT') ? await readBody(req) : {};

  // ---- Auth ----
  if (method === 'POST' && pathname === '/api/register') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    if (!username || !password) return json(res, 400, { error: 'يرجى ملء جميع الحقول المطلوبة' });
    if (!PW_RE.test(password)) return json(res, 400, { error: 'كلمة المرور يجب أن تتكون من حروف وأرقام فقط وأن تكون أكثر من 5 خانات' });
    if (!/^[^\s]{3,24}$/.test(username)) return json(res, 400, { error: 'اسم المستخدم يجب أن يكون من 3 إلى 24 حرفاً بدون مسافات' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return json(res, 409, { error: 'الاسم مستخدم قبل كده' });

    const isHostUsername = username.toLowerCase().endsWith('.host');
    let hostType = 'none';
    let permLevel = 'none';
    if (isHostUsername) {
      const hasPrimary = db.prepare("SELECT id FROM users WHERE host_type = 'primary' AND is_host = 1").get();
      hostType = hasPrimary ? 'secondary' : 'primary';
      permLevel = 'full';
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const info = db.prepare(
      'INSERT INTO users (username,password_hash,salt,is_host,host_type,perm_level,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(username, hashPassword(password, salt), salt, isHostUsername ? 1 : 0, hostType, permLevel, Date.now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    createSession(res, user.id);
    return json(res, 200, { user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/login') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '').trim();
    if (!username || !password) return json(res, 400, { error: 'يرجى ملء جميع الحقول المطلوبة' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return json(res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    const check = Buffer.from(hashPassword(password, user.salt), 'hex');
    const real = Buffer.from(user.password_hash, 'hex');
    if (check.length !== real.length || !crypto.timingSafeEqual(check, real)) {
      return json(res, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    createSession(res, user.id);
    return json(res, 200, { user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    if (u) destroySession(req);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/state') {
    const teams = getTeams().sort((a, b) => b.points - a.points);
    const rounds = getRounds();
    if (!u) return json(res, 200, { user: null, teams, rounds });
    return json(res, 200, { user: publicUser(u), teams, rounds });
  }

  // Everything below requires login
  if (!u) return json(res, 401, { error: 'يرجى تسجيل الدخول أولاً' });

  if (method === 'GET' && pathname === '/api/me') return json(res, 200, { user: publicUser(u) });

  if (method === 'POST' && pathname === '/api/password') {
    const newPass = String(body.newPassword || '').trim();
    if (!PW_RE.test(newPass)) return json(res, 400, { error: 'كلمة المرور يجب تكون أكثر من 5 خانات وحروف وأرقام فقط' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(newPass, salt), salt, u.id);
    return json(res, 200, { ok: true });
  }

  // ---- Teams (host, teams permission) ----
  if (pathname === '/api/teams' && method === 'POST') {
    if (!canManageTeams(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الفرق!' });
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'اسم الفريق مطلوب' });
    if (db.prepare('SELECT id FROM teams WHERE name = ?').get(name)) return json(res, 409, { error: 'يوجد فريق بنفس الاسم' });
    db.prepare('INSERT INTO teams (id,name,points) VALUES (?,?,0)').run(newId('t'), name);
    return json(res, 200, { ok: true });
  }

  let m = pathname.match(/^\/api\/teams\/([^/]+)$/);
  if (m && method === 'PATCH') {
    if (!canManageTeams(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الفرق!' });
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(m[1]);
    if (!team) return json(res, 404, { error: 'الفريق غير موجود' });
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return json(res, 400, { error: 'اسم الفريق مطلوب' });
      const dup = db.prepare('SELECT id FROM teams WHERE name = ? AND id != ?').get(name, team.id);
      if (dup) return json(res, 409, { error: 'يوجد فريق بنفس الاسم' });
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, team.id);
    }
    if (body.points !== undefined) {
      db.prepare('UPDATE teams SET points = ? WHERE id = ?').run(parseInt(body.points) || 0, team.id);
    }
    return json(res, 200, { ok: true });
  }
  if (m && method === 'DELETE') {
    if (!canManageTeams(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الفرق!' });
    db.prepare('DELETE FROM teams WHERE id = ?').run(m[1]);
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(m[1]);
    return json(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/teams\/([^/]+)\/members$/);
  if (m && method === 'POST') {
    if (!canManageTeams(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الفرق!' });
    const username = String(body.username || '').trim();
    if (!username) return json(res, 400, { error: 'اسم اللاعب مطلوب' });
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(m[1]);
    if (!team) return json(res, 404, { error: 'الفريق غير موجود' });
    const exists = db.prepare('SELECT username FROM team_members WHERE team_id = ? AND username = ?').get(team.id, username);
    if (!exists) db.prepare('INSERT INTO team_members (team_id,username) VALUES (?,?)').run(team.id, username);
    return json(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/teams\/([^/]+)\/members\/(.+)$/);
  if (m && method === 'DELETE') {
    if (!canManageTeams(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الفرق!' });
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND username = ?').run(m[1], decodeURIComponent(m[2]));
    return json(res, 200, { ok: true });
  }

  // ---- Rounds & matches (host, schedule permission) ----
  if (pathname === '/api/rounds' && method === 'POST') {
    if (!canManageSchedule(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الجداول!' });
    const count = db.prepare('SELECT COUNT(*) c FROM rounds').get().c;
    const title = String(body.title || '').trim() || `الجولة ${count + 1} - جولة جديدة`;
    db.prepare('INSERT INTO rounds (id,title) VALUES (?,?)').run(newId('r'), title);
    return json(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/rounds\/([^/]+)$/);
  if (m && method === 'PATCH') {
    if (!canManageSchedule(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الجداول!' });
    const title = String(body.title || '').trim();
    if (!title) return json(res, 400, { error: 'اسم الجولة مطلوب' });
    const r = db.prepare('SELECT * FROM rounds WHERE id = ?').get(m[1]);
    if (!r) return json(res, 404, { error: 'الجولة غير موجودة' });
    db.prepare('UPDATE rounds SET title = ? WHERE id = ?').run(title, r.id);
    return json(res, 200, { ok: true });
  }
  if (m && method === 'DELETE') {
    if (!canManageSchedule(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الجداول!' });
    db.prepare('DELETE FROM rounds WHERE id = ?').run(m[1]);
    db.prepare('DELETE FROM matches WHERE round_id = ?').run(m[1]);
    return json(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/rounds\/([^/]+)\/matches$/);
  if (m && method === 'POST') {
    if (!canManageSchedule(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الجداول!' });
    const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(m[1]);
    if (!round) return json(res, 404, { error: 'الجولة غير موجودة' });
    db.prepare('INSERT INTO matches (id,round_id,team1,team2,score1,score2,winner) VALUES (?,?,?,?,?,?,?)')
      .run(newId('m'), round.id, String(body.team1 || 'الفريق الأول'), String(body.team2 || 'الفريق الثاني'), 0, 0, null);
    return json(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/matches\/([^/]+)$/);
  if (m && method === 'PATCH') {
    if (!canManageSchedule(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الجداول!' });
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(m[1]);
    if (!match) return json(res, 404, { error: 'المباراة غير موجودة' });
    const updated = {
      team1: body.team1 !== undefined ? String(body.team1) : match.team1,
      team2: body.team2 !== undefined ? String(body.team2) : match.team2,
      score1: body.score1 !== undefined ? (parseInt(body.score1) || 0) : match.score1,
      score2: body.score2 !== undefined ? (parseInt(body.score2) || 0) : match.score2,
    };
    updated.winner = deriveWinner(updated);
    db.prepare('UPDATE matches SET team1=?, team2=?, score1=?, score2=?, winner=? WHERE id=?')
      .run(updated.team1, updated.team2, updated.score1, updated.score2, updated.winner, match.id);
    return json(res, 200, { ok: true });
  }
  if (m && method === 'DELETE') {
    if (!canManageSchedule(u)) return json(res, 403, { error: 'غير مصرح لك بتعديل الجداول!' });
    db.prepare('DELETE FROM matches WHERE id = ?').run(m[1]);
    return json(res, 200, { ok: true });
  }

  // ---- Permissions (primary host only for mutations; any host can list) ----
  if (pathname === '/api/users' && method === 'GET') {
    if (!u.is_host) return json(res, 403, { error: 'منع الوصول' });
    const users = db.prepare('SELECT * FROM users ORDER BY id').all();
    return json(res, 200, { users: users.map(publicUser) });
  }

  m = pathname.match(/^\/api\/users\/(\d+)\/perm$/);
  if (m && method === 'PATCH') {
    if (!isPrimary(u)) return json(res, 403, { error: 'هذه اللوحة مخصصة للهوست الرئيسي فقط!' });
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(m[1]));
    if (!target || !target.is_host || isPrimary(target)) return json(res, 400, { error: 'لا يمكن تعديل صلاحيات هذا الحساب' });
    if (!VALID_PERMS.includes(body.permLevel)) return json(res, 400, { error: 'مستوى صلاحية غير صالح' });
    db.prepare('UPDATE users SET perm_level = ? WHERE id = ?').run(body.permLevel, target.id);
    return json(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/users\/(\d+)\/promote$/);
  if (m && method === 'POST') {
    if (!isPrimary(u)) return json(res, 403, { error: 'هذه اللوحة مخصصة للهوست الرئيسي فقط!' });
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(m[1]));
    if (!target || isPrimary(target)) return json(res, 400, { error: 'لا يمكن ترقية هذا الحساب' });
    db.prepare("UPDATE users SET is_host = 1, host_type = 'secondary', perm_level = 'full' WHERE id = ?").run(target.id);
    return json(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/users\/(\d+)\/demote$/);
  if (m && method === 'POST') {
    if (!isPrimary(u)) return json(res, 403, { error: 'هذه اللوحة مخصصة للهوست الرئيسي فقط!' });
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(m[1]));
    if (!target || isPrimary(target)) return json(res, 400, { error: 'لا يمكن تنزيل هذا الحساب' });
    db.prepare("UPDATE users SET is_host = 0, host_type = 'none', perm_level = 'none' WHERE id = ?").run(target.id);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'مسار غير معروف' });
}

// ---------------------------------------------------------------- Server
seedIfEmpty();

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch(err => {
      console.error(err);
      json(res, 400, { error: 'طلب غير صالح' });
    });
  } else if (req.method === 'GET') {
    serveStatic(req, res, pathname);
  } else {
    json(res, 405, { error: 'method not allowed' });
  }
});

server.listen(PORT, () => {
  console.log(`Deadshot Tournament Platform running at http://localhost:${PORT}`);
});
