'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { AUTH_ON, sign, verify, ROOM_RE } = require('./lib/token');
const { TURN_ON, TURN_HOST, iceServers } = require('./lib/turn');
const teachers = require('./lib/teachers');
const aiteacher = require('./lib/aiteacher');

const PORT = process.env.PORT || 4300;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const LOG_DIR = path.join(__dirname, 'data', 'lessons');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const app = express();

// ---------- PDF yuklash ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-60);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

// Tokendagi rolni tekshiradi (AUTH_ON bo'lmasa — lokal rejim, hamma narsa ochiq)
function claimsFrom(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return verify(req.query.t || bearer);
}

app.post('/api/upload', (req, res, next) => {
  if (!AUTH_ON) return next();
  const c = claimsFrom(req);
  if (!c || c.role !== 'teacher') return res.status(403).json({ error: 'ruxsat yo\u2018q' });
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Faqat PDF fayl, 25MB gacha' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

// Sinov uchun token yasash — faqat DEV_TOKENS=true bo'lganda ochiladi
app.get('/api/dev-token', (req, res) => {
  if (!AUTH_ON) return res.status(400).json({ error: 'LESSON_TOKEN_SECRET yo\u2018q' });
  if (process.env.DEV_TOKENS !== 'true') return res.status(404).json({ error: 'topilmadi' });
  const room = String(req.query.room || '').toLowerCase();
  if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'xona nomi noto\u2018g\u2018ri' });
  const role = req.query.role === 'teacher' ? 'teacher' : 'student';
  const name = String(req.query.name || '').slice(0, 40);
  // ttl — sekundlarda, ko'pi bilan 30 kun (sinov havolasi tez o'lib qolmasligi uchun)
  const ttl = Math.min(Number(req.query.ttl) || 3 * 3600, 30 * 24 * 3600);
  res.json({ token: sign({ room, role, name }, ttl), ttl });
});

// ---------- Dars jurnallari (keyinchalik replay / AI tahlil uchun) ----------
// Jurnallar — ustoz/admin uchun. AUTH_ON bo'lsa ADMIN_KEY talab qilinadi.
function adminOnly(req, res, next) {
  if (!AUTH_ON) return next();
  const key = process.env.ADMIN_KEY || '';
  if (!key || req.headers['x-admin-key'] !== key) {
    return res.status(403).json({ error: 'ruxsat yo\u2018q' });
  }
  next();
}

app.get('/api/lessons', adminOnly, (req, res) => {
  fs.readdir(LOG_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: 'o\u2018qib bo\u2018lmadi' });
    const list = files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { file: f, room: f.split('__')[0], size: st.size, mtime: st.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json(list);
  });
});

app.get('/api/lessons/:file', adminOnly, (req, res) => {
  const f = req.params.file;
  if (!/^[\w.\-]+\.jsonl$/.test(f)) return res.status(400).json({ error: 'noto\u2018g\u2018ri nom' });
  fs.readFile(path.join(LOG_DIR, f), 'utf8', (err, txt) => {
    if (err) return res.status(404).json({ error: 'topilmadi' });
    const events = txt.trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    res.json({ file: f, events });
  });
});

app.use(express.json({ limit: '10kb' }));

// ---------- Ustoz kirishi (login + parol) ----------
const COOKIE = 'll_sessiya';        // ustozning dars xonasi tokeni
const AI_COOKIE = 'll_aiteacher';   // ai.myteacher.uz kirish tokeni (jadval uchun)

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    }).filter(([k]) => k),
  );
}

function cookieHeader(req, name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
}

function setSession(req, res, { room, name }) {
  const token = sign({ room, role: 'teacher', name }, 12 * 3600);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`
    + (req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
  res.json({ ok: true, room, name, role: 'mentor', redirect: '/room.html' });
}

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!AUTH_ON) return res.status(500).json({ error: 'server sozlanmagan (LESSON_TOKEN_SECRET yo‘q)' });
  if (!login || !password) return res.status(400).json({ error: 'Login va parol kiriting' });

  // 1) Asosiy yo'l — ai.myteacher.uz dagi mavjud hisob (mentor ham, o'quvchi ham)
  if (aiteacher.AITEACHER_ON) {
    const r = await aiteacher.signIn(login, password);
    if (r.ok) {
      const headers = [cookieHeader(req, AI_COOKIE, r.token || '', 12 * 3600)];

      if (r.isMentor) {
        // Mentorga dars xonasi tokeni ham beriladi
        const token = sign({ room: `mentor-${r.id}`, role: 'teacher', name: r.name }, 12 * 3600);
        headers.push(cookieHeader(req, COOKIE, token, 12 * 3600));
      }

      res.setHeader('Set-Cookie', headers);
      return res.json({
        ok: true,
        name: r.name,
        role: r.isMentor ? 'mentor' : 'student',
        redirect: r.isMentor ? '/jadval.html' : '/band.html',
      });
    }
    if (r.status === 403 || r.status === 502) return res.status(r.status).json({ error: r.message });
  }

  // 2) Zaxira — lokal teachers.json (ai.myteacher.uz ishlamay qolsa ham dars o'tilsin)
  const t = teachers.find(login);
  if (t && teachers.check(String(password), t.pass)) {
    return setSession(req, res, { room: t.room, name: t.name });
  }

  res.status(401).json({ error: 'Login yoki parol noto‘g‘ri' });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
    `${AI_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
  ]);
  res.json({ ok: true });
});

// Ustoz sahifasi tokenni shu yerdan oladi (cookie HttpOnly — JS uni o'qiy olmaydi)
app.get('/api/session', (req, res) => {
  const token = cookies(req)[COOKIE];
  const c = verify(token);
  if (!c) return res.status(401).json({ error: 'kirilmagan' });
  res.json({ token, room: c.room, role: c.role, name: c.name, studentUrl: `/dars/${c.room}` });
});

// ---------- ai.myteacher.uz ga proksi (jadval va band qilish) ----------
// Brauzer ai.myteacher.uz ga to'g'ridan-to'g'ri murojaat qilmaydi: token HttpOnly
// cookie'da yotadi va JS uni o'qiy olmaydi. Shu sabab so'rovlar shu yerdan o'tadi.
async function aiProxy(req, res, targetPath) {
  const token = cookies(req)[AI_COOKIE];
  if (!token) return res.status(401).json({ error: 'kirilmagan' });
  if (!aiteacher.AITEACHER_ON) return res.status(500).json({ error: 'AITEACHER_API sozlanmagan' });

  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  const qs = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method);

  try {
    const r = await fetch(`${base}${targetPath}${qs}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(req.body ?? {}) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch {
    res.status(502).json({ error: 'ai.myteacher.uz javob bermadi' });
  }
}

app.all(/^\/api\/booking(\/.*)?$/, (req, res) => {
  const sub = req.path.replace(/^\/api\/booking/, '');
  aiProxy(req, res, `/lesson-booking${sub}`);
});

app.get('/api/my-mentor', (req, res) => aiProxy(req, res, '/assignments/my-mentor'));

// Mentor ekranlari uchun o'qish endpointlari — ruxsat etilganlar ro'yxati bo'yicha.
// Ochiq proksi qilmaymiz: faqat kerakli yo'llar o'tadi.
const RUXSAT = [
  /^assignments\/my-students$/,
  /^assignments\/my-students\/active$/,
  /^assignments\/my-students\/online-count$/,
  /^student-activity\/students\/[0-9a-f-]{36}\/logs$/,
  /^calls$/,
  /^leads\/my$/,
];

// Lid holatini o'zgartirish (PATCH) — ruxsat etilgan yozish amali
app.patch(/^\/api\/ai\/leads\/([0-9a-f-]{36})\/status$/, (req, res) => {
  const id = req.path.split('/')[4];
  aiProxy(req, res, `/leads/${id}/status`);
});

app.get(/^\/api\/ai\/(.+)$/, (req, res) => {
  const yol = req.path.replace(/^\/api\/ai\//, '');
  if (!RUXSAT.some((re) => re.test(yol))) return res.status(404).json({ error: 'topilmadi' });
  aiProxy(req, res, `/${yol}`);
});

// Ilova WebView'ni #ai=<token> bilan ochadi — sahifa tokenni shu yerga uzatib,
// cookie'ga aylantiradi. Hash serverga umuman yuborilmaydi, ya'ni loglarga tushmaydi.
app.post('/api/adopt', (req, res) => {
  const token = String(req.body?.token || '');
  const payload = aiteacher.jwtPayload(token);
  if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) {
    return res.status(400).json({ error: 'token yaroqsiz' });
  }
  res.setHeader('Set-Cookie', cookieHeader(req, AI_COOKIE, token, 12 * 3600));
  const roles = aiteacher.collectRoles(payload);
  res.json({ ok: true, role: roles.includes('mentor') || roles.includes('admin') ? 'mentor' : 'student' });
});

// Kim kirgan — sahifalar shundan biladi
app.get('/api/whoami', (req, res) => {
  const ai = cookies(req)[AI_COOKIE];
  const lesson = verify(cookies(req)[COOKIE]);
  if (!ai && !lesson) return res.status(401).json({ error: 'kirilmagan' });
  const payload = ai ? aiteacher.jwtPayload(ai) : null;
  const roles = payload ? aiteacher.collectRoles(payload) : [];
  res.json({
    name: lesson?.name || null,
    role: roles.includes('mentor') || roles.includes('admin') || lesson ? 'mentor' : 'student',
    hasSchedule: Boolean(ai),
  });
});

// ---------- Tezkor dars (jadvalsiz, "hoziroq") ----------
// Ustoz o'quvchi kartasidan video darsni darhol boshlashi uchun.
// Xona nomi ikkala tomon id'sidan hosil qilinadi — har safar bir xil chiqadi,
// ya'ni ustoz va o'quvchi albatta bitta xonada uchrashadi.
app.post('/api/tezkor', (req, res) => {
  const c = verify(cookies(req)[COOKIE]);
  if (!c || c.role !== 'teacher') return res.status(401).json({ error: 'kirilmagan' });

  const student = String(req.body?.studentId || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (student.length < 8) return res.status(400).json({ error: 'o\u2018quvchi aniqlanmadi' });

  // "mentor-<uuid>" dan mentor qismini olamiz; uzunlikni 64 belgiga sig'diramiz
  const mentor = c.room.replace(/^mentor-/, '').replace(/-/g, '').slice(0, 12);
  const oquvchi = student.replace(/-/g, '').slice(0, 12);
  const room = `dars-${mentor}-${oquvchi}`;

  const token = sign({ room, role: 'teacher', name: c.name }, 4 * 3600);
  res.json({
    room,
    teacherUrl: `/room.html?t=${encodeURIComponent(token)}`,
    studentUrl: `/dars/${room}`,
  });
});

// ---------- O'quvchi kirishi (havola bilan, parolsiz) ----------
// Kurs kartasidagi havola shu yerga olib keladi: /dars/<xona>
app.get('/dars/:room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/api/join/:room', (req, res) => {
  const room = String(req.params.room || '').toLowerCase();
  if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'xona nomi noto\u2018g\u2018ri' });
  if (!AUTH_ON) return res.json({ token: null, room });
  const name = String(req.query.name || '').slice(0, 40) || 'O\u2018quvchi';
  res.json({ token: sign({ room, role: 'student', name }, 6 * 3600), room });
});

// Ilova qaysi rejimda ishlayotganini bosh sahifa shundan biladi
app.get('/api/config', (req, res) => {
  res.json({
    auth: AUTH_ON ? 'token' : 'open',
    devTokens: process.env.DEV_TOKENS === 'true',
  });
});

// Vaqtinchalik TURN hisob ma'lumotlari. Token rejimida token talab qilinadi.
app.get('/api/ice', (req, res) => {
  if (AUTH_ON) {
    const c = claimsFrom(req);
    if (!c) return res.status(403).json({ error: 'ruxsat yo‘q' });
    return res.json({ iceServers: iceServers(c.room) });
  }
  res.json({ iceServers: iceServers('dev') });
});

// Bosh sahifa — rol tanlash yo'q, rol hisobdan aniqlanadi
app.get('/', (req, res) => res.redirect('/login.html'));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);

// ---------- Signaling + annotatsiya sinxronizatsiyasi ----------
// rooms: Map<roomId, { peers: Map<clientId, ws>, state: {...} }>
const rooms = new Map();

function emptyState() {
  return { doc: null, page: 1, strokes: [], scroll: 0 };
}

function getRoom(id) {
  if (!rooms.has(id)) {
    const startedAt = Date.now();
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    const room = {
      peers: new Map(),
      state: emptyState(),
      startedAt,
      logFile: path.join(LOG_DIR, `${id}__${stamp}.jsonl`),
    };
    rooms.set(id, room);
    logEvent(room, { type: 'lesson-start', room: id });
  }
  return rooms.get(id);
}

// Dars voqealari vaqt belgisi bilan diskka yoziladi — keyin qayta o'ynatish uchun.
// t = dars boshlanganidan beri o'tgan millisekund.
function logEvent(room, ev) {
  const line = JSON.stringify({ t: Date.now() - room.startedAt, at: Date.now(), ...ev });
  fs.appendFile(room.logFile, line + '\n', (err) => {
    if (err) console.warn('jurnalga yozib bo\'lmadi:', err.message);
  });
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  for (const [id, peer] of room.peers) {
    if (id !== exceptId) send(peer, msg);
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  // Token rejimida xona, rol va ism faqat imzolangan tokendan olinadi —
  // mijoz yuborgan query parametrlariga ishonilmaydi.
  let roomId, role, name;
  if (AUTH_ON) {
    const claims = verify(url.searchParams.get('t'));
    if (!claims) {
      send(ws, { type: 'error', message: 'Kirish tokeni yaroqsiz yoki muddati tugagan' });
      return ws.close();
    }
    ({ room: roomId, role, name } = claims);
  } else {
    roomId = (url.searchParams.get('room') || '').trim().toLowerCase();
    role = url.searchParams.get('role') === 'teacher' ? 'teacher' : 'student';
    name = (url.searchParams.get('name') || '').slice(0, 40);
  }

  if (!ROOM_RE.test(roomId)) {
    send(ws, { type: 'error', message: 'Xona nomi noto‘g‘ri' });
    return ws.close();
  }

  const room = getRoom(roomId);
  if (room.peers.size >= 2) {
    send(ws, { type: 'full' });
    return ws.close();
  }

  const clientId = crypto.randomUUID();
  ws.meta = { clientId, roomId, role, name };
  room.peers.set(clientId, ws);

  // Kim birinchi kirdi — o'sha "polite" bo'lmaydi (offer yaratadi yangi kelgan).
  const peerList = [...room.peers.values()]
    .filter((p) => p !== ws)
    .map((p) => ({ id: p.meta.clientId, role: p.meta.role, name: p.meta.name }));

  send(ws, {
    type: 'joined',
    you: { id: clientId, role, name },
    peers: peerList,
    state: room.state,
    iceServers: iceServers(roomId),
  });

  broadcast(room, { type: 'peer-join', peer: { id: clientId, role, name } }, clientId);
  logEvent(room, { type: 'join', role, name });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      // --- WebRTC signaling: to'g'ridan-to'g'ri boshqa peer'ga ---
      case 'offer':
      case 'answer':
      case 'ice':
        broadcast(room, { ...msg, from: clientId }, clientId);
        break;

      // --- Workspace (faqat ustoz o'zgartiradi) ---
      case 'doc':
        if (role !== 'teacher') return;
        room.state.doc = { url: String(msg.url || ''), name: String(msg.name || '') };
        room.state.page = 1;
        room.state.strokes = [];
        room.state.scroll = 0;
        broadcast(room, { type: 'doc', ...room.state.doc }, clientId);
        logEvent(room, { type: 'doc', url: room.state.doc.url, name: room.state.doc.name });
        break;

      case 'page':
        if (role !== 'teacher') return;
        room.state.page = Math.max(1, Number(msg.page) || 1);
        room.state.scroll = 0;
        broadcast(room, { type: 'page', page: room.state.page }, clientId);
        logEvent(room, { type: 'page', page: room.state.page });
        break;

      case 'scroll':
        if (role !== 'teacher') return;
        room.state.scroll = Math.min(1, Math.max(0, Number(msg.y) || 0));
        broadcast(room, { type: 'scroll', y: room.state.scroll }, clientId);
        break;

      case 'stroke': {
        if (role !== 'teacher') return;
        const stroke = { ...msg.stroke, t: Date.now() - room.startedAt };
        if (room.state.strokes.length < 5000) room.state.strokes.push(stroke);
        broadcast(room, { type: 'stroke', stroke }, clientId);
        logEvent(room, { type: 'stroke', stroke });
        break;
      }

      case 'stroke-live':
        if (role !== 'teacher') return;
        broadcast(room, { type: 'stroke-live', stroke: msg.stroke }, clientId);
        break;

      case 'undo':
        if (role !== 'teacher') return;
        room.state.strokes.pop();
        broadcast(room, { type: 'undo' }, clientId);
        logEvent(room, { type: 'undo' });
        break;

      case 'clear':
        if (role !== 'teacher') return;
        room.state.strokes = room.state.strokes.filter((s) => s.page !== room.state.page);
        broadcast(room, { type: 'clear', page: room.state.page }, clientId);
        logEvent(room, { type: 'clear', page: room.state.page });
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    room.peers.delete(clientId);
    broadcast(room, { type: 'peer-leave', id: clientId });
    logEvent(room, { type: 'leave', role, name });
    if (room.peers.size === 0) {
      logEvent(room, { type: 'lesson-end', strokes: room.state.strokes.length });
      setTimeout(() => {
        const r = rooms.get(roomId);
        if (r && r.peers.size === 0) rooms.delete(roomId);
      }, 10 * 60 * 1000); // 10 daqiqa ichida qaytsa, doska saqlanib qoladi
    }
  });
});

server.listen(PORT, () => {
  console.log(`Jonli dars: http://127.0.0.1:${PORT}`);
  console.log(TURN_ON ? `TURN: ${TURN_HOST}` : 'TURN: yo‘q — faqat STUN (qattiq NAT ortida ulanmasligi mumkin)');
  console.log(AUTH_ON
    ? 'Rejim: TOKEN — kirish faqat imzolangan token bilan'
    : 'Rejim: OCHIQ — LESSON_TOKEN_SECRET yo‘q, havola bilan kiriladi (faqat ishlab chiqish uchun)');
});
