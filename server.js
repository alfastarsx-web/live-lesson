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

// ---------- Hujjat yuklash (PDF va rasm) ----------
const RASM_TURLARI = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-]+/g, '_').slice(-60);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  // Telefondan fayl tanlanganda brauzer ko'pincha application/octet-stream yoki
  // bo'sh tur yuboradi — faqat mimetype'ga ishonsak, haqiqiy PDF ham rad etiladi.
  // Shuning uchun kengaytma ham tekshiriladi.
  fileFilter: (req, file, cb) => {
    const tur = file.mimetype || '';
    const nom = file.originalname || '';
    const mosTur = tur === 'application/pdf' || RASM_TURLARI.includes(tur);
    const mosNom = /\.(pdf|png|jpe?g|webp|gif)$/i.test(nom);
    if (mosTur || mosNom) return cb(null, true);
    console.warn(`Qabul qilinmadi: nom="${nom}" tur="${tur}"`);
    cb(null, false);
  },
});

// Tokendagi rolni tekshiradi (AUTH_ON bo'lmasa — lokal rejim, hamma narsa ochiq)
function claimsFrom(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return verify(req.query.t || bearer);
}

const pdfYukla = upload.single('file');

app.post('/api/upload', (req, res, next) => {
  if (!AUTH_ON) return next();
  const c = claimsFrom(req);
  if (!c || c.role !== 'teacher') return res.status(403).json({ error: 'ruxsat yo\u2018q' });
  next();
}, (req, res, next) => {
  // Multer xatosini o'zimiz ushlaymiz — aks holda hajm chegarasida 500 qaytardi
  pdfYukla(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Fayl 25MB dan katta' });
    }
    console.warn('PDF yuklash xatosi:', err.message);
    res.status(400).json({ error: 'Faylni yuklab bo\u2018lmadi, qaytadan urinib ko\u2018ring' });
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Fayl mos emas. PDF yoki rasm (JPG, PNG) tanlang' });
  }
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
        mustChangePassword: Boolean(r.mustChangePassword),
        redirect: r.isMentor
          ? (await akademiyaKerak(r.token) ? '/mentor/akademiya.html' : '/work.html')
          : '/band.html',
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

// Mentor veb sahifada ishlayotganini bildiradi — aks holda tizim uni oflayn
// deb biladi va lid bermaydi (mobil ilova soket orqali ulanadi, veb esa shu yo'l bilan)
// Akademiyadan o'tmagan mentor onlayn hisoblanmaydi — ya'ni unga lid tushmaydi
app.post('/api/mentor-session/heartbeat', async (req, res) => {
  if (await akademiyaKerak(cookies(req)[AI_COOKIE])) {
    return res.status(403).json({ error: 'akademiya', redirect: '/mentor/akademiya.html' });
  }
  aiProxy(req, res, '/mentor-session/heartbeat');
});

// Operator yuborgan sinov darsi so'rovlari: ko'rish, qabul qilish, rad etish.
// Akademiyadan o'tmagan mentor so'rov ololmaydi.
app.get('/api/trial/incoming', async (req, res) => {
  if (await akademiyaKerak(cookies(req)[AI_COOKIE])) return res.json([]);
  aiProxy(req, res, '/trial-requests/incoming');
});
app.post(/^\/api\/trial\/([0-9a-f-]{36})\/(accept|decline)$/, async (req, res) => {
  if (await akademiyaKerak(cookies(req)[AI_COOKIE])) {
    return res.status(403).json({ error: 'akademiya', redirect: '/mentor/akademiya.html' });
  }
  aiProxy(req, res, `/trial-requests/${req.params[0]}/${req.params[1]}`);
});

app.get('/api/my-mentor', (req, res) => aiProxy(req, res, '/assignments/my-mentor'));

// Mentor bergan bir martalik kod bilan kirgan o'quvchi o'z parolini qo'yadi
app.post('/api/parol', (req, res) => aiProxy(req, res, '/auth/set-initial-password'));

/**
 * Telegram botda raqamini tasdiqlagan odam uchun bir bosishlik kirish.
 * Token ai.myteacher.uz tomonidan imzolangan — biz uni tekshirmaymiz,
 * almashtiramiz: API tokenni qabul qilsa, sessiya cookie'si qo'yiladi.
 */
app.post('/api/kirish', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Havola topilmadi' });
  if (!aiteacher.AITEACHER_ON) return res.status(500).json({ error: 'AITEACHER_API sozlanmagan' });

  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/auth/one-time-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status === 400 ? 401 : r.status)
        .json({ error: data.message || 'Havola eskirgan' });
    }
    const jwt = aiteacher.findJwt(data);
    if (!jwt) return res.status(502).json({ error: 'Kirish tokeni kelmadi' });

    res.setHeader('Set-Cookie', [cookieHeader(req, AI_COOKIE, jwt, 12 * 3600)]);
    return res.json({ ok: true });
  } catch {
    return res.status(502).json({ error: 'ai.myteacher.uz javob bermadi' });
  }
});

// Mentor ekranlari uchun o'qish endpointlari — ruxsat etilganlar ro'yxati bo'yicha.
// Ochiq proksi qilmaymiz: faqat kerakli yo'llar o'tadi.
const RUXSAT = [
  /^assignments\/my-students$/,
  /^assignments\/my-students\/active$/,
  /^assignments\/my-students\/paid$/,
  /^assignments\/my-students\/online-count$/,
  /^student-activity\/students\/[0-9a-f-]{36}\/logs$/,
  /^calls$/,
  /^leads\/my$/,
];

// Lid holati va izohi (PATCH) — ruxsat etilgan yozish amallari
app.patch(/^\/api\/ai\/leads\/([0-9a-f-]{36})\/(status|note)$/, (req, res) => {
  const [, , , , id, amal] = req.path.split('/');
  aiProxy(req, res, `/leads/${id}/${amal}`);
});

// O'quvchi akkauntini bitta tugma bilan ochish (login+parol Telegramga yoki SMS'ga ketadi)
app.post(/^\/api\/ai\/leads\/([0-9a-f-]{36})\/create-account$/, (req, res) => {
  const id = req.path.split('/')[4];
  aiProxy(req, res, `/leads/${id}/create-account`);
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
// Sinov va eski ochiq havolalar shu yerga olib keladi: /dars/<xona>
app.get('/dars/:room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

function managedRoom(room) {
  return room.startsWith('jonli-')
    || /^dars-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(room);
}

async function trialWindow(room) {
  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  const secret = process.env.LESSON_TOKEN_SECRET || '';
  if (!base || !secret) throw new Error('Sinov darsi tekshiruvi sozlanmagan');
  const response = await fetch(`${base}/lesson-booking/trial/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lesson-secret': secret },
    body: JSON.stringify({ room }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Sinov darsi API: ${response.status}`);
  return response.json();
}

app.get('/api/join/:room', async (req, res) => {
  const room = String(req.params.room || '').toLowerCase();
  if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'xona nomi noto\u2018g\u2018ri' });
  let expiresIn = 6 * 3600;
  // Individual lessons use authenticated, student-bound tokens from the main API.
  if (managedRoom(room)) {
    return res.status(403).json({ error: 'Darsga ilovadan kiring' });
  }
  if (room.startsWith('sinov-')) {
    try {
      const result = await trialWindow(room);
      if (!result.allowed) {
        return res.status(403).json({ error: 'Sinov darsi hali boshlanmadi yoki yakunlandi' });
      }
      const remaining = Date.parse(result.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        return res.status(403).json({ error: 'Sinov darsi yakunlandi' });
      }
      expiresIn = Math.ceil(remaining / 1000);
    } catch {
      return res.status(503).json({ error: 'Sinov darsini tekshirib bo\u2018lmadi' });
    }
  }
  if (!AUTH_ON) return res.json({ token: null, room });
  const name = String(req.query.name || '').slice(0, 40) || 'O\u2018quvchi';
  res.json({ token: sign({ room, role: 'student', name }, expiresIn), room });
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

// ---------- Mentor akademiyasi ----------
// Yangi mentor ish sahifalariga kirishdan oldin akademiya modullarini ketma-ket o'qib,
// testdan o'tadi. Holat, savollar va tekshiruv ai.myteacher.uz da (/mentor-academy) —
// bu server faqat sahifalarni yopadi va so'rovlarni uzatadi.

// ai.myteacher.uz tokenidan mentor bo'lishi mumkinmi (admin — tekshirilmaydi)
function mentorTokeni(aiToken) {
  const p = aiToken ? aiteacher.jwtPayload(aiToken) : null;
  if (!p || (p.exp && p.exp * 1000 < Date.now())) return null;
  const roles = aiteacher.collectRoles(p);
  if (!roles.includes('mentor') || roles.includes('admin')) return null;
  return String(p.sub || p.id || p.userId || '') || null;
}

// Har sahifada backend'ga bormaslik uchun: o'tganlar uzoqroq, o'tmaganlar qisqa eslanadi
const AKADEMIYA_KESH = new Map(); // userId -> { kerak, vaqt }
const KESH_OTGAN_MS = 10 * 60 * 1000;
const KESH_KERAK_MS = 20 * 1000;

async function akademiyaKerak(aiToken) {
  const id = mentorTokeni(aiToken);
  if (!id || !aiteacher.AITEACHER_ON) return false;

  const k = AKADEMIYA_KESH.get(id);
  if (k && Date.now() - k.vaqt < (k.kerak ? KESH_KERAK_MS : KESH_OTGAN_MS)) return k.kerak;

  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/mentor-academy/status`, {
      headers: { Authorization: `Bearer ${aiToken}` },
      signal: AbortSignal.timeout(8000),
    });
    // API ishlamasa yoki token eskirgan bo'lsa ishlayotgan mentorni to'smaymiz
    if (!r.ok) return false;
    const d = await r.json().catch(() => null);
    const kerak = Boolean(d && d.required);
    AKADEMIYA_KESH.set(id, { kerak, vaqt: Date.now() });
    return kerak;
  } catch {
    return false;
  }
}

app.get('/api/akademiya/holat', (req, res) => aiProxy(req, res, '/mentor-academy/status'));
app.post('/api/akademiya/boshla', (req, res) => aiProxy(req, res, '/mentor-academy/start'));
app.post('/api/akademiya/modul', (req, res) => aiProxy(req, res, '/mentor-academy/progress'));
app.get('/api/akademiya/savollar', (req, res) => aiProxy(req, res, '/mentor-academy/questions'));
app.post('/api/akademiya/natija', (req, res) => {
  // O'tgan bo'lsa keshdagi eski "kerak" darhol unutilsin
  const id = mentorTokeni(cookies(req)[AI_COOKIE]);
  if (id) AKADEMIYA_KESH.delete(id);
  aiProxy(req, res, '/mentor-academy/submit');
});

// Brauzerdan kirilganda ish sahifalari server tomonda yopiladi.
// WebView birinchi ochilishda cookie hali yo'q — u holatni auth-webview.js tekshiradi.
const AKADEMIYA_YOPIQ = /^\/(work|jadval|oquvchilar|oquvchi|lidlar|mentor\/yol|mentor\/liga)(\.html)?$/;
app.get(AKADEMIYA_YOPIQ, async (req, res, next) => {
  if (await akademiyaKerak(cookies(req)[AI_COOKIE])) return res.redirect('/mentor/akademiya.html');
  next();
});

// Bosh sahifa — rol tanlash yo'q, rol hisobdan aniqlanadi
app.get('/', (req, res) => res.redirect('/login.html'));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);

// ---------- Signaling + annotatsiya sinxronizatsiyasi ----------
// rooms: Map<roomId, { peers: Map<clientId, ws>, state: {...} }>
const rooms = new Map();

async function liveApi(action, data) {
  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  const secret = process.env.LESSON_TOKEN_SECRET || '';
  if (!base || !secret) throw new Error('Jonli dars API sozlanmagan');
  const response = await fetch(`${base}/lesson-booking/live/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lesson-secret': secret },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Jonli dars API: ${response.status}`);
  return response.json();
}

async function endActiveRoom(roomId, room) {
  if (!room.lessonId || room.ended) return;
  room.ended = true;
  const report = async () => {
    try {
      await liveApi('end', { lessonId: room.lessonId, room: roomId });
    } catch (err) {
      console.warn('Darsni yakunlash xatosi:', err.message);
      // Keep the room closed and retry until the invitation naturally expires.
      if (Date.now() < room.expiresAt) setTimeout(report, 10_000);
    }
  };
  await report();
}

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
      // Sinov darsi hisoboti uchun: o'quvchi qachon kirdi va qancha turdi
      ishtirok: { studentJoined: false, studentSeconds: 0, studentEnteredAt: null },
      lessonId: null,
      ended: false,
      endTimer: null,
      expiresAt: 0,
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

/**
 * Sinov darsi tugagach ai.myteacher.uz ga xabar beramiz: lid kirdimi va
 * qancha turdi. Shunga qarab lid holati o'zi "o'tildi" yoki "kelmadi" bo'ladi.
 * Faqat "sinov-" bilan boshlanadigan xonalar uchun.
 */
// O'quvchi dars oxirida baho qoldiradi. Token xonani aniqlaydi, ya'ni
// o'quvchi faqat o'zi qatnashgan darsni baholay oladi.
app.post('/api/baho', async (req, res) => {
  const c = claimsFrom(req);
  if (AUTH_ON && !c) return res.status(403).json({ error: 'ruxsat yo\u2018q' });

  const room = (c && c.room) || req.body?.room;
  const rating = Number(req.body?.rating);
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.slice(0, 1000) : '';

  if (!room) return res.status(400).json({ error: 'xona aniqlanmadi' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Bahoni tanlang' });
  }

  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  const secret = process.env.LESSON_TOKEN_SECRET || '';
  if (!base || !secret) return res.status(500).json({ error: 'server sozlanmagan' });

  try {
    const r = await fetch(`${base}/lesson-booking/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-lesson-secret': secret },
      body: JSON.stringify({ room, rating, comment }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json().catch(() => ({}));
    console.log(`Dars bahosi: ${room} yulduz=${rating} -> ${r.ok ? (d.matched ? 'saqlandi' : 'dars topilmadi') : `xato ${r.status}`}`);
    // Baho saqlanmasa ham o'quvchiga xato ko'rsatmaymiz — dars tugagan
    res.json({ ok: true });
  } catch (e) {
    console.warn('Baho yuborilmadi:', e.message);
    res.json({ ok: true });
  }
});

async function sinovHisoboti(roomId, room, ended = false) {
  if (!roomId.startsWith('sinov-')) return;

  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  const secret = process.env.LESSON_TOKEN_SECRET || '';
  if (!base || !secret) return;

  const { studentJoined } = room.ishtirok;
  const studentSeconds = room.ishtirok.studentSeconds +
    (room.ishtirok.studentEnteredAt
      ? Math.round((Date.now() - room.ishtirok.studentEnteredAt) / 1000) : 0);

  try {
    const r = await fetch(`${base}/lesson-booking/trial/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-lesson-secret': secret },
      body: JSON.stringify({ room: roomId, studentJoined, studentSeconds, ended }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json().catch(() => ({}));
    console.log(`Sinov darsi hisoboti: ${roomId} kirdi=${studentJoined} soniya=${studentSeconds} -> `
      + `${r.ok ? (d.status || 'qabul qilindi') : `xato ${r.status}`}`);
  } catch (e) {
    // Hisobot ketmasa dars baribir o'tgan — mentor holatni qo'lda qo'yadi
    console.warn('Sinov darsi hisoboti yuborilmadi:', e.message);
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  // Token rejimida xona, rol va ism faqat imzolangan tokendan olinadi —
  // mijoz yuborgan query parametrlariga ishonilmaydi.
  let roomId, role, name, claims = null;
  if (AUTH_ON) {
    claims = verify(url.searchParams.get('t'));
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

  if ((AUTH_ON && managedRoom(roomId)) || roomId.startsWith('sinov-')) {
    if (roomId.startsWith('sinov-') && !claims?.userId) {
      try {
        const result = await trialWindow(roomId);
        if (!result.allowed || role !== 'student') {
          send(ws, { type: 'error', message: 'Bu sinov darsi hozir faol emas' });
          return ws.close();
        }
      } catch (err) {
        console.warn('Sinov darsiga kirishni tekshirish xatosi:', err.message);
        send(ws, { type: 'error', message: 'Sinov darsini tekshirib bo‘lmadi' });
        return ws.close();
      }
    } else {
      if (!claims?.userId || (!claims.lessonId && !claims.bookingId)) {
        send(ws, { type: 'error', message: 'Darsga kirish ruxsati yo‘q' });
        return ws.close();
      }
      try {
        const result = await liveApi('validate', {
          lessonId: claims.lessonId, bookingId: claims.bookingId,
          room: roomId, userId: claims.userId, role,
        });
        if (!result.allowed) {
          send(ws, { type: 'error', message: 'Bu dars siz uchun faol emas' });
          return ws.close();
        }
      } catch (err) {
        console.warn('Darsga kirishni tekshirish xatosi:', err.message);
        send(ws, { type: 'error', message: 'Darsga kirishni tekshirib bo‘lmadi' });
        return ws.close();
      }
    }
  }

  if (ws.readyState !== ws.OPEN) return;

  const room = getRoom(roomId);
  if (room.ended) {
    send(ws, { type: 'error', message: 'Dars tugagan' });
    return ws.close();
  }
  if (claims?.lessonId) {
    room.lessonId = claims.lessonId;
    room.expiresAt = Math.max(room.expiresAt, claims.exp * 1000);
  }
  if (role === 'teacher' && room.endTimer) {
    clearTimeout(room.endTimer);
    room.endTimer = null;
  }
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

  if (role === 'student') {
    room.ishtirok.studentJoined = true;
    room.ishtirok.studentEnteredAt = Date.now();
  }

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

      // --- Ustoz darsni yakunladi: o'quvchida baho oynasi ochiladi ---
      case 'dars-tugadi':
        if (role !== 'teacher') return;
        if (roomId.startsWith('sinov-')) {
          room.ended = true;
          void sinovHisoboti(roomId, room, true);
        } else {
          void endActiveRoom(roomId, room);
        }
        broadcast(room, { type: 'dars-tugadi' }, clientId);
        logEvent(room, { type: 'lesson-end-by-teacher' });
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

    if (role === 'student' && room.ishtirok.studentEnteredAt) {
      room.ishtirok.studentSeconds += Math.round((Date.now() - room.ishtirok.studentEnteredAt) / 1000);
      room.ishtirok.studentEnteredAt = null;
    }
    if (role === 'teacher' && room.lessonId && !room.ended) {
      room.endTimer = setTimeout(() => {
        if (![...room.peers.values()].some((peer) => peer.meta.role === 'teacher')) {
          void endActiveRoom(roomId, room);
        }
      }, 2 * 60 * 1000);
    }
    if (room.peers.size === 0) {
      logEvent(room, { type: 'lesson-end', strokes: room.state.strokes.length });
      void sinovHisoboti(roomId, room, room.ended);
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
