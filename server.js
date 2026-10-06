'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { AUTH_ON, sign, verify, ROOM_RE, signEslab, verifyEslab } = require('./lib/token');
const { TURN_ON, TURN_HOST, iceServers } = require('./lib/turn');
const teachers = require('./lib/teachers');
const aiteacher = require('./lib/aiteacher');

const PORT = process.env.PORT || 4300;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const LOG_DIR = path.join(__dirname, 'data', 'lessons');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
// Server qayta ishga tushsa (deploy) ham dars davom etsin: doska va o'quvchi qatnashuvi shu yerda
const ROOM_DIR = path.join(__dirname, 'data', 'rooms');
fs.mkdirSync(ROOM_DIR, { recursive: true });

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
  if (!diskdaJoyBor()) return res.status(507).json({ error: 'Serverda joy vaqtincha tugagan — faylni ekran ulashish orqali ko‘rsating' });
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
  // Bir xil fayl (masalan, har darsda ochiladigan "Lesson 5.pdf") diskda bitta nusxa bo'lib turadi:
  // nomi — mazmunining xeshi. Takror yuklansa, yangisi o'chiriladi va eskisining muddati yangilanadi.
  try {
    const xesh = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
    const kengaytma = (path.extname(req.file.originalname).toLowerCase().match(/^\.(pdf|png|jpe?g|webp|gif)$/) || ['.pdf'])[0];
    const nom = `${xesh}${kengaytma}`;
    const yol = path.join(UPLOAD_DIR, nom);
    if (fs.existsSync(yol)) {
      fs.unlinkSync(req.file.path);
      const hozir = new Date();
      fs.utimesSync(yol, hozir, hozir);
    } else {
      fs.renameSync(req.file.path, yol);
    }
    return res.json({ url: `/uploads/${nom}`, name: req.file.originalname });
  } catch (e) {
    console.warn('Faylni joylab bo\u2018lmadi:', e.message);
    return res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
  }
});

// ---------- Dars materiallari: diskni tejash ----------
// Darsda ochilgan fayl o'quvchining Kurslar bo'limida shuncha kun ko'rinadi; oxirgi marta
// ishlatilganidan shuncha kun o'tgan fayl o'chiriladi (har darsda ochilsa — muddati yangilanadi).
const MATERIAL_KUN = 60;
// Serverda shundan kam joy qolsa, yangi fayl qabul qilinmaydi (dars to'xtamasin, disk to'lmasin)
const MIN_BOSH_JOY = 2 * 1024 ** 3;
function diskdaJoyBor() {
  try {
    const s = fs.statfsSync(UPLOAD_DIR);
    return s.bavail * s.bsize >= MIN_BOSH_JOY;
  } catch { return true; }
}
function materialniYangila(url) {
  const m = /^\/uploads\/([\w.\-]+)$/.exec(String(url || ''));
  if (!m) return;
  const hozir = new Date();
  fs.utimes(path.join(UPLOAD_DIR, m[1]), hozir, hozir, () => {});
}
function eskiMateriallarniTozala() {
  const chegara = Date.now() - MATERIAL_KUN * 86_400_000;
  let n = 0;
  for (const nom of fs.readdirSync(UPLOAD_DIR)) {
    if (nom.startsWith('.')) continue; // .gitkeep
    const yol = path.join(UPLOAD_DIR, nom);
    try {
      const st = fs.statSync(yol);
      if (st.isFile() && st.mtimeMs < chegara) { fs.unlinkSync(yol); n += 1; }
    } catch { /* boshqa jarayon o'chirgan bo'lishi mumkin */ }
  }
  if (n) console.log(`Eski dars materiallari o'chirildi: ${n} ta (${MATERIAL_KUN} kundan eski)`);
}
setTimeout(eskiMateriallarniTozala, 60_000);
setInterval(eskiMateriallarniTozala, 12 * 3600_000);

// O'quvchining Kurslar sahifasi (app-course) materialni ilova ichida ochadi — PDF'ni shu yerdan oladi
app.use('/uploads', (req, res, next) => {
  const o = req.headers.origin;
  if (o === 'https://app-course.myteacher.uz' || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o || '')) {
    res.set({ 'Access-Control-Allow-Origin': o, Vary: 'Origin' });
  }
  next();
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

// Haqiqiy mijoz IP si (nginx ortida) — API kirish urinishlarini shu bo'yicha cheklaydi, server IP si bo'yicha emas
function mijozIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    }).filter(([k]) => k),
  );
}

// VAQTINCHA: mentor ilovasi tablarni (lesson, mentor-home, mentor-career) #ai= tokensiz
// ochadi. Sessiya cookie'si uchala domenga umumiy — bitta tabda kirilsa, qolganlari so'ramaydi.
// Ilova #ai=<token> uzatadigan bo'lgach, COOKIE_DOMAIN= (bo'sh) qilib o'chirsa bo'ladi.
function umumiyDomen(req) {
  if (process.env.COOKIE_DOMAIN !== undefined) return process.env.COOKIE_DOMAIN || null;
  const host = String(req.hostname || '');
  return host === 'myteacher.uz' || host.endsWith('.myteacher.uz') ? '.myteacher.uz' : null;
}

function cookieHeader(req, name, value, maxAge, domain = umumiyDomen(req)) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (domain ? `; Domain=${domain}` : '')
    + (req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
}

// [[nom, qiymat, maxAge], ...] — umumiy domen yoqilgan bo'lsa, shu domenning eski
// (domensiz) nusxasi o'chiriladi: aks holda brauzer ikkalasini yuborib, eskisi xalaqit beradi
function setCookies(req, res, royxat) {
  const domain = umumiyDomen(req);
  const headers = royxat.map(([nom, qiymat, maxAge]) => cookieHeader(req, nom, qiymat, maxAge, domain));
  if (domain) headers.push(...royxat.map(([nom]) => cookieHeader(req, nom, '', 0, null)));
  // Sessiya yangilash middleware'i oldinroq cookie qo'ygan bo'lishi mumkin — ustidan yozmaymiz, qo'shamiz
  const oldin = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(oldin ? [].concat(oldin) : []), ...headers]);
}

// ---------- "Meni eslab qol": bir marta kirgan odamdan parol qayta so'ralmaydi ----------
// ll_eslab — 180 kunlik imzolangan kalit (faqat userId). ai.myteacher.uz tokeni (1 kun) eskirsa,
// server uni shu kalit bilan parolsiz yangilaydi. Ilova (WebView) ham, brauzer ham shu bilan ishlaydi.
const ESLAB = 'll_eslab';
const ESLAB_MUDDAT = 180 * 24 * 3600;
const AI_COOKIE_MUDDAT = 7 * 24 * 3600;
const XONA_MUDDAT = 12 * 3600;

function eslabCookie(userId) {
  return [ESLAB, signEslab(userId, ESLAB_MUDDAT), ESLAB_MUDDAT];
}

// Bir vaqtda kelgan so'rovlar API ni bir necha marta chaqirmasin
const SESSIYA_KESH = new Map(); // userId -> { promise, until }
function aiSessiya(userId) {
  const k = SESSIYA_KESH.get(userId);
  if (k && k.until > Date.now()) return k.promise;
  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  const promise = fetch(`${base}/auth/live-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lesson-secret': process.env.LESSON_TOKEN_SECRET || '' },
    body: JSON.stringify({ userId }),
    signal: AbortSignal.timeout(8000),
  }).then(async (r) => {
    if (!r.ok) return { ok: false, status: r.status };
    const d = await r.json().catch(() => ({}));
    return d.accessToken ? { ok: true, token: d.accessToken, roles: d.roles || [], name: d.firstName || 'Ustoz' } : { ok: false, status: 502 };
  }).catch(() => ({ ok: false, status: 502 }));
  SESSIYA_KESH.set(userId, { promise, until: Date.now() + 10 * 60_000 });
  // Xato bo'lsa keshda qolmasin — keyingi so'rov qayta urinsin
  promise.then((x) => { if (!x.ok) SESSIYA_KESH.delete(userId); });
  if (SESSIYA_KESH.size > 5000) SESSIYA_KESH.delete(SESSIYA_KESH.keys().next().value);
  return promise;
}

// Token haqiqatan ai.myteacher.uz niki ekanini API dan so'raymiz (imzoni bu server tekshira olmaydi)
const TEKSHIRILGAN = new Map(); // token -> Promise<userId|null>
function tokenEgasi(token) {
  if (TEKSHIRILGAN.has(token)) return TEKSHIRILGAN.get(token);
  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  const p = fetch(`${base}/users/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) })
    .then(async (r) => {
      if (!r.ok) return null;
      const d = await r.json().catch(() => ({}));
      const id = String(d.id || d.data?.id || '').toLowerCase();
      return /^[0-9a-f-]{36}$/.test(id) ? id : null;
    })
    .catch(() => undefined); // tarmoq xatosi — keshlamaymiz
  TEKSHIRILGAN.set(token, p);
  p.then((x) => { if (x === undefined) TEKSHIRILGAN.delete(token); });
  if (TEKSHIRILGAN.size > 5000) TEKSHIRILGAN.delete(TEKSHIRILGAN.keys().next().value);
  return p;
}

// Yangi qiymatni shu so'rovning o'zida ham ko'rinadigan qilamiz (keyingi handlerlar cookies(req) o'qiydi)
function reqCookie(req, nom, qiymat) {
  const c = cookies(req);
  c[nom] = qiymat;
  req.headers.cookie = Object.entries(c).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
}

const tokenSub = (p) => String(p?.sub || p?.id || p?.userId || '').toLowerCase();

async function sessiyaniYangila(req, res) {
  if (!AUTH_ON || !aiteacher.AITEACHER_ON) return;
  const c = cookies(req);
  const ai = c[AI_COOKIE];
  const p = ai ? aiteacher.jwtPayload(ai) : null;
  const tirik = p && p.exp && p.exp * 1000 > Date.now() + 3600_000;
  const eslab = verifyEslab(c[ESLAB]);

  // 1) Eslab kaliti bor — token eskirgan/yo'q bo'lsa parolsiz yangilaymiz
  if (eslab) {
    const boshqaOdam = p && tokenSub(p) && tokenSub(p) !== eslab.userId;
    if (boshqaOdam) return;
    const royxat = [];
    let rollar = p ? aiteacher.collectRoles(p) : [];
    let ism = null;
    if (!tirik) {
      const s = await aiSessiya(eslab.userId);
      if (!s.ok) {
        // Akkaunt o'chirilgan / ruxsat yo'q — kalitni tozalaymiz; tarmoq xatosida tegmaymiz
        if (s.status === 401 || s.status === 403) setCookies(req, res, [[ESLAB, '', 0]]);
        return;
      }
      royxat.push([AI_COOKIE, s.token, AI_COOKIE_MUDDAT]);
      reqCookie(req, AI_COOKIE, s.token);
      rollar = aiteacher.collectRoles({ roles: s.roles });
      ism = s.name;
      req.sessiyaYangilandi = true;
    }
    // Mentorning dars xonasi tokeni ham yangilanadi
    const mentor = rollar.includes('mentor') || rollar.includes('admin');
    if (mentor && !verify(c[COOKIE])) {
      if (!ism) ism = (await aiSessiya(eslab.userId)).name || 'Ustoz';
      const safeId = eslab.userId.replace(/[^a-z0-9-]+/g, '').slice(0, 50);
      const xona = sign({ room: `mentor-${safeId}`, role: 'teacher', name: String(ism).slice(0, 40) }, XONA_MUDDAT);
      royxat.push([COOKIE, xona, XONA_MUDDAT]);
      reqCookie(req, COOKIE, xona);
    }
    // Kalit muddati har kuni uzayadi — faol odam hech qachon chiqib ketmaydi
    if (eslab.iat * 1000 < Date.now() - 24 * 3600_000) royxat.push(eslabCookie(eslab.userId));
    if (royxat.length) setCookies(req, res, royxat);
    return;
  }

  // 2) Eslab yo'q, lekin hozir amaldagi sessiya bor (deploydan oldin kirganlar) — bir marta tekshirib, kalit beramiz
  if (ai && p && p.exp * 1000 > Date.now()) {
    const id = await tokenEgasi(ai);
    if (id && id === tokenSub(p)) setCookies(req, res, [eslabCookie(id)]);
  }
}

// Statik fayllar (js/css/rasm) uchun API chaqirmaymiz — faqat sahifalar va /api so'rovlari
const YANGILANMAYDI = /\.(js|css|png|jpe?g|svg|ico|webp|gif|woff2?|ttf|map|json|txt|mp3|wav|pdf)$/i;
app.use(async (req, res, next) => {
  if (YANGILANMAYDI.test(req.path) || req.path === '/api/logout' || req.path === '/api/login') return next();
  try { await sessiyaniYangila(req, res); } catch (e) { console.warn('Sessiya yangilanmadi:', e.message); }
  next();
});

function setSession(req, res, { room, name }) {
  const token = sign({ room, role: 'teacher', name }, 12 * 3600);
  setCookies(req, res, [[COOKIE, token, 12 * 3600]]);
  res.json({ ok: true, room, name, role: 'mentor', redirect: '/room.html' });
}

// Mobil ilova har tabni o'z domenida login.html orqali ochadi (Home | Work | Career).
// Kirgandan keyin shu tabning sahifasi ochilsin; Home va Career akademiyani talab qilmaydi.
async function mentorBoshSahifa(req, token) {
  const host = String(req.hostname || '');
  if (host.startsWith('mentor-home.')) return '/home.html';
  if (host.startsWith('mentor-career.')) return '/career.html';
  return (await akademiyaKerak(token)) || '/work.html';
}

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!AUTH_ON) return res.status(500).json({ error: 'server sozlanmagan (LESSON_TOKEN_SECRET yo‘q)' });
  if (!login || !password) return res.status(400).json({ error: 'Login va parol kiriting' });

  // 1) Asosiy yo'l — ai.myteacher.uz dagi mavjud hisob (mentor ham, o'quvchi ham)
  if (aiteacher.AITEACHER_ON) {
    const r = await aiteacher.signIn(login, password, mijozIp(req));
    if (r.ok) {
      const royxat = [[AI_COOKIE, r.token || '', AI_COOKIE_MUDDAT]];
      if (AUTH_ON && /^[0-9a-f-]{36}$/.test(r.id)) royxat.push(eslabCookie(r.id));

      if (r.isMentor) {
        // Mentorga dars xonasi tokeni ham beriladi
        const token = sign({ room: `mentor-${r.id}`, role: 'teacher', name: r.name }, 12 * 3600);
        royxat.push([COOKIE, token, 12 * 3600]);
      }

      setCookies(req, res, royxat);
      return res.json({
        ok: true,
        name: r.name,
        role: r.isMentor ? 'mentor' : 'student',
        mustChangePassword: Boolean(r.mustChangePassword),
        redirect: r.isMentor ? await mentorBoshSahifa(req, r.token) : '/band.html',
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
  setCookies(req, res, [[COOKIE, '', 0], [AI_COOKIE, '', 0], [ESLAB, '', 0]]);
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

// Mentor hamyoni (Work → Daromad, Home grafigi). Admin yo'llari bu yerdan o'tmaydi.
app.all(/^\/api\/wallet(\/.*)?$/, (req, res) => {
  const sub = req.path.replace(/^\/api\/wallet/, '');
  if (/^\/admin(\/|$)/.test(sub)) return res.status(404).json({ error: 'topilmadi' });
  aiProxy(req, res, `/mentor-wallet${sub}`);
});

app.all(/^\/api\/booking(\/.*)?$/, (req, res) => {
  const sub = req.path.replace(/^\/api\/booking/, '');
  aiProxy(req, res, `/lesson-booking${sub}`);
});

// ---------- Bepul sinov darsi landingi (bepul-dars.html) ----------
// Ochiq sahifa: ilova ichida (Kurslar) va reklamada. Ilovada yozilish native orqali,
// brauzerda esa shu forma — lid ai.myteacher.uz ga tushadi va operator qo'ng'iroq qiladi.
// Ilova Kurslar sahifasi (app-course.myteacher.uz) landing so'rovlari uchun CORS
const BEPUL_ORIGINS = new Set(['https://app-course.myteacher.uz', 'https://www.myteacher.uz', 'https://myteacher.uz']);
app.use('/api/bepul-dars', (req, res, next) => {
  const o = req.headers.origin;
  if (o && BEPUL_ORIGINS.has(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST', Vary: 'Origin' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const BEPUL_LIMIT = new Map(); // ip -> [vaqtlar]
app.get('/api/bepul-dars/stats', async (req, res) => {
  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/lesson-booking/public/stats`, { signal: AbortSignal.timeout(8000) });
    res.status(r.ok ? 200 : 502).json(r.ok ? await r.json() : {});
  } catch {
    res.status(502).json({});
  }
});
app.get('/api/bepul-dars/slots', async (req, res) => {
  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/trial-requests/public/slots`, { signal: AbortSignal.timeout(15000) });
    res.status(r.ok ? 200 : 502).json(r.ok ? await r.json() : {});
  } catch {
    res.status(502).json({});
  }
});
// Lid manbasi: www saytidanmi yoki lesson/app-course'danmi, Meta reklamasidanmi
function bepulManba(req) {
  const origin = String(req.headers.origin || '');
  const www = origin === 'https://www.myteacher.uz' || origin === 'https://myteacher.uz';
  return `${www ? 'www' : 'web'}-bepul-dars${req.body?.meta ? '-fb' : ''}`;
}
app.post('/api/bepul-dars', async (req, res) => {
  const ip = String(req.headers['x-real-ip'] || req.ip || '');
  const hozir = Date.now();
  const oldingi = (BEPUL_LIMIT.get(ip) || []).filter((t) => hozir - t < 3600_000);
  if (oldingi.length >= 5) return res.status(429).json({ error: 'Juda ko‘p urinish, birozdan keyin qayta yuboring' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const raqam = String(req.body?.phone || '').replace(/[^\d]/g, '');
  if (name.length < 2 || raqam.length < 9 || raqam.length > 12) return res.status(400).json({ error: 'Ism va telefonni tekshiring' });
  const phoneNumber = raqam.length === 9 ? `+998${raqam}` : `+${raqam}`;
  BEPUL_LIMIT.set(ip, [...oldingi, hozir]);
  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  // Vaqt tanlangan bo'lsa — to'g'ridan-to'g'ri sinov so'rovi (bo'sh mentorlarga ketadi)
  const startsAt = String(req.body?.startsAt || '');
  if (startsAt) {
    try {
      const r = await fetch(`${base}/trial-requests/public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lesson-secret': process.env.LESSON_TOKEN_SECRET || '' },
        body: JSON.stringify({ name, phone: phoneNumber, startsAt, manba: bepulManba(req), maqsad: String(req.body?.maqsad || '').slice(0, 20) || undefined }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json().catch(() => ({}));
      return res.status(r.ok ? 201 : r.status === 400 ? 400 : 502).json(r.ok ? { ok: true } : { error: d.message || 'Yuborib bo‘lmadi' });
    } catch {
      return res.status(502).json({ error: 'Yuborib bo‘lmadi' });
    }
  }
  try {
    const r = await fetch(`${base}/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phoneNumber, formId: 'web-bepul-dars', note: 'Landing: bepul 1-1 sinov darsi' }),
      signal: AbortSignal.timeout(10000),
    });
    res.status(r.ok ? 201 : 502).json({ ok: r.ok });
  } catch {
    res.status(502).json({ ok: false });
  }
});

// Onlayn/Oflayn tugmasi (Work) — holat va bugungi onlayn vaqt
app.get('/api/mentor-session/me', (req, res) => aiProxy(req, res, '/mentor-session/me'));
app.post('/api/mentor-session/status', (req, res) => aiProxy(req, res, '/mentor-session/status'));

// Mentor veb sahifada ishlayotganini bildiradi — aks holda tizim uni oflayn
// deb biladi va lid bermaydi (mobil ilova soket orqali ulanadi, veb esa shu yo'l bilan)
// Akademiyadan o'tmagan mentor onlayn hisoblanmaydi — ya'ni unga lid tushmaydi
app.post('/api/mentor-session/heartbeat', async (req, res) => {
  const yopiq = await akademiyaKerak(cookies(req)[AI_COOKIE]);
  if (yopiq) return res.status(403).json({ error: 'akademiya', redirect: yopiq });
  aiProxy(req, res, '/mentor-session/heartbeat');
});

// Operator yuborgan sinov darsi so'rovlari: ko'rish, qabul qilish, rad etish.
// Akademiyadan o'tmagan mentor so'rov ololmaydi.
app.get('/api/trial/incoming', async (req, res) => {
  if (await akademiyaKerak(cookies(req)[AI_COOKIE])) return res.json([]);
  aiProxy(req, res, '/trial-requests/incoming');
});
app.post(/^\/api\/trial\/([0-9a-f-]{36})\/(accept|decline)$/, async (req, res) => {
  const yopiq = await akademiyaKerak(cookies(req)[AI_COOKIE]);
  if (yopiq) return res.status(403).json({ error: 'akademiya', redirect: yopiq });
  aiProxy(req, res, `/trial-requests/${req.params[0]}/${req.params[1]}`);
});

// O'quvchi o'zi yozilgan sinov darsi: mentor qo'ng'iroq qilgach tasdiqlaydi, vaqtni ko'chiradi yoki bo'shatadi;
// start-now — o'quvchi oldinroq tayyor bo'lsa darsni shu daqiqaga ko'chirib boshlash
app.post(/^\/api\/trial\/booking\/([0-9a-f-]{36})\/(confirm|move|release|start-now)$/, (req, res) => {
  aiProxy(req, res, `/trial-requests/booking/${req.params[0]}/${req.params[1]}`);
});

// Sinovdan keyin ustoz taklifi: haftalik jadval, takliflar ro'yxati, yuborish, bekor qilish
app.all(/^\/api\/course-offers(\/[0-9a-z-]+)*$/, (req, res) => {
  aiProxy(req, res, req.path.replace(/^\/api/, ''));
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

    const sub = tokenSub(aiteacher.jwtPayload(jwt));
    setCookies(req, res, [[AI_COOKIE, jwt, AI_COOKIE_MUDDAT], ...(AUTH_ON && /^[0-9a-f-]{36}$/.test(sub) ? [eslabCookie(sub)] : [])]);
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
  /^mentor\/salary$/,
  /^mentor-gamification\/home$/,
  /^mentor-gamification\/history$/,
  /^mentor-gamification\/progress$/,
  /^mentor-bot\/link$/,
];

// Mentor Telegram botidan uzish
app.delete('/api/ai/mentor-bot/link', (req, res) => aiProxy(req, res, '/mentor-bot/link'));

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

// Yangi nishonlar ko'rildi — tabrik qayta chiqmasin
app.post('/api/ai/mentor-gamification/badges/seen', (req, res) => aiProxy(req, res, '/mentor-gamification/badges/seen'));

// Ball yozuviga e'tiroz — mentorning o'z yozuviga (backend tekshiradi)
app.post(/^\/api\/ai\/mentor-gamification\/entries\/([0-9a-f-]{36})\/dispute$/, (req, res) => {
  aiProxy(req, res, `/mentor-gamification/entries/${req.params[0]}/dispute`);
});

app.get(/^\/api\/ai\/(.+)$/, (req, res) => {
  const yol = req.path.replace(/^\/api\/ai\//, '');
  if (!RUXSAT.some((re) => re.test(yol))) return res.status(404).json({ error: 'topilmadi' });
  aiProxy(req, res, `/${yol}`);
});

// Ilova WebView'ni #ai=<token> bilan ochadi — sahifa tokenni shu yerga uzatib,
// cookie'ga aylantiradi. Hash serverga umuman yuborilmaydi, ya'ni loglarga tushmaydi.
app.post('/api/adopt', async (req, res) => {
  const token = String(req.body?.token || '');
  const payload = aiteacher.jwtPayload(token);
  if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) {
    return res.status(400).json({ error: 'token yaroqsiz' });
  }
  // Ilova tokeni — eslab kaliti faqat API tasdiqlasa beriladi (aks holda soxta token bilan kirib bo'lardi)
  const egasi = AUTH_ON && aiteacher.AITEACHER_ON ? await tokenEgasi(token) : null;
  const royxat = [[AI_COOKIE, token, AI_COOKIE_MUDDAT]];
  if (egasi && egasi === tokenSub(payload)) royxat.push(eslabCookie(egasi));
  setCookies(req, res, royxat);
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
const AKADEMIYA_KESH = new Map(); // userId -> { kerak, vaqt }; kerak — yo'naltiriladigan sahifa yoki null
const KESH_OTGAN_MS = 10 * 60 * 1000;
const KESH_KERAK_MS = 20 * 1000;
const OFERTA_SAHIFA = '/mentor/oferta.html';

// Mentor ish sahifalariga kira oladimi: yo'q bo'lsa — qayerga yuborish kerak.
// Avval oferta (qabul qilinmagan bo'lsa), keyin akademiya. Kira olsa — null.
async function akademiyaKerak(aiToken) {
  const id = mentorTokeni(aiToken);
  if (!id || !aiteacher.AITEACHER_ON) return null;

  const k = AKADEMIYA_KESH.get(id);
  if (k && Date.now() - k.vaqt < (k.kerak ? KESH_KERAK_MS : KESH_OTGAN_MS)) return k.kerak;

  const base = (process.env.AITEACHER_API || '').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/mentor-academy/status`, {
      headers: { Authorization: `Bearer ${aiToken}` },
      signal: AbortSignal.timeout(8000),
    });
    // API ishlamasa yoki token eskirgan bo'lsa ishlayotgan mentorni to'smaymiz
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    const kerak = d && d.offerRequired ? OFERTA_SAHIFA : d && d.required ? '/mentor/akademiya.html' : null;
    AKADEMIYA_KESH.set(id, { kerak, vaqt: Date.now() });
    return kerak;
  } catch {
    return null;
  }
}

app.get('/api/akademiya/holat', (req, res) => aiProxy(req, res, '/mentor-academy/status'));
app.post('/api/akademiya/boshla', (req, res) => aiProxy(req, res, '/mentor-academy/start'));
app.post('/api/akademiya/modul', (req, res) => aiProxy(req, res, '/mentor-academy/progress'));
app.get('/api/akademiya/savollar', (req, res) => aiProxy(req, res, '/mentor-academy/questions'));
// Mentor ofertasi — qabul qilmaguncha ish sahifalari va akademiya yopiq
app.get('/api/mentor-oferta', (req, res) => aiProxy(req, res, '/mentor-academy/offer'));
app.post('/api/mentor-oferta/qabul', (req, res) => {
  const id = mentorTokeni(cookies(req)[AI_COOKIE]);
  if (id) AKADEMIYA_KESH.delete(id);
  aiProxy(req, res, '/mentor-academy/offer/accept');
});
app.post('/api/akademiya/natija', (req, res) => {
  // O'tgan bo'lsa keshdagi eski "kerak" darhol unutilsin
  const id = mentorTokeni(cookies(req)[AI_COOKIE]);
  if (id) AKADEMIYA_KESH.delete(id);
  aiProxy(req, res, '/mentor-academy/submit');
});

// Brauzerdan kirilganda ish sahifalari server tomonda yopiladi.
// WebView birinchi ochilishda cookie hali yo'q — u holatni auth-webview.js tekshiradi.
// Career (yo'l, liga, akademiya) yopilmaydi — yangi mentor ham o'qib o'rganadi
const AKADEMIYA_YOPIQ = /^\/(work|jadval|oquvchilar|oquvchi|lidlar)(\.html)?$/;
app.get(AKADEMIYA_YOPIQ, async (req, res, next) => {
  const yopiq = await akademiyaKerak(cookies(req)[AI_COOKIE]);
  if (yopiq) return res.redirect(yopiq);
  next();
});
// Akademiyaning o'zi ham oferta qabul qilingandan keyin ochiladi
app.get(/^\/mentor\/akademiya(\.html)?$/, async (req, res, next) => {
  if ((await akademiyaKerak(cookies(req)[AI_COOKIE])) === OFERTA_SAHIFA) return res.redirect(OFERTA_SAHIFA);
  next();
});

// Cookie'dagi ai.myteacher.uz tokeni — muddati o'tmagan bo'lsa
function amaldagiAiToken(req) {
  const t = cookies(req)[AI_COOKIE];
  const p = t ? aiteacher.jwtPayload(t) : null;
  if (!p || (p.exp && p.exp * 1000 < Date.now())) return null;
  return t;
}

// Kirgan odam uchun shu domendagi bosh sahifa (mentor — tab sahifasi, o'quvchi — band.html)
async function boshSahifa(req, aiToken) {
  const roles = aiteacher.collectRoles(aiteacher.jwtPayload(aiToken));
  const mentor = roles.includes('mentor') || roles.includes('admin');
  return mentor ? mentorBoshSahifa(req, aiToken) : '/band.html';
}

// login.html #ai=<token> ni cookie'ga aylantirgach qayerga o'tishni shu yerdan so'raydi
app.get('/api/bosh-sahifa', async (req, res) => {
  const ai = amaldagiAiToken(req);
  if (!ai) return res.status(401).json({ error: 'kirilmagan' });
  res.json({ redirect: await boshSahifa(req, ai) });
});

// Bosh sahifa. Ilova tablari o'z domenining ildizini ochadi (#ai=<token> bilan) —
// login emas, tab sahifasi ochilsin: sahifaning o'zi #ai= ni qabul qiladi.
// Brauzer 302 da #... qismini saqlaydi.
app.get('/', async (req, res) => {
  const host = String(req.hostname || '');
  if (host.startsWith('mentor-home.')) return res.redirect('/home.html');
  if (host.startsWith('mentor-career.')) return res.redirect('/career.html');
  const ai = amaldagiAiToken(req);
  res.redirect(ai ? await boshSahifa(req, ai) : '/login.html');
});

// Sessiyasi bor odamga login formasi ko'rsatilmaydi. ?keyin= bo'lsa — sahifa hozirgina
// 401 olgan (token bekor qilingan), qayta yo'naltirsak aylanib qoladi — formani ko'rsatamiz.
app.get(/^\/login(\.html)?$/, async (req, res, next) => {
  const ai = amaldagiAiToken(req);
  if (!ai) return next();
  if (req.query.keyin) {
    // Sessiya hozirgina eslab kaliti bilan yangilandi — formani emas, so'ralgan sahifani ochamiz
    const keyin = String(req.query.keyin);
    if (!req.sessiyaYangilandi || !keyin.startsWith('/') || keyin.startsWith('//')) return next();
    return res.redirect(keyin);
  }
  res.redirect(await boshSahifa(req, ai));
});

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

// Dars daftarini API ga saqlash (ustoz yozishdan to'xtagach 3 soniyada; dars tugaganda darhol)
const DAFTAR_KUTISH_MS = 3000;
function daftarSaqla(roomId, room, darhol = false) {
  clearTimeout(room.daftarTaymer);
  const yubor = () => {
    room.daftarTaymer = null;
    liveApi('notes', {
      room: roomId,
      lessonId: room.lessonId || undefined,
      notes: { ...room.state.notes, materiallar: room.state.materiallar || [] },
    })
      .catch((err) => console.warn('Dars daftari saqlanmadi:', err.message));
  };
  if (darhol) yubor();
  else room.daftarTaymer = setTimeout(yubor, DAFTAR_KUTISH_MS);
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

function chizaOladi(room, role) {
  return role === 'teacher' || (role === 'student' && room.state.studentDraw);
}

/** Chiziqni tekshirib, faqat kerakli maydonlarni qoldiradi; muallifni server qo'yadi */
function toza(st, role) {
  if (!st || !Array.isArray(st.pts) || st.pts.length > 4000) return null;
  const page = st.page === 'screen' ? 'screen' : Math.max(1, Number(st.page) || 1);
  const pts = st.pts
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
  if (!pts.length) return null;
  return {
    page,
    tool: st.tool === 'hl' ? 'hl' : 'pen',
    color: /^#[0-9a-f]{6}$/i.test(String(st.color)) ? st.color : '#ef4444',
    w: Math.min(0.05, Math.max(0.001, Number(st.w) || 0.0045)),
    pts,
    dur: Number.isFinite(st.dur) ? st.dur : undefined,
    by: role,
  };
}

/** Ekran yoqilganda ham, o'chganda ham ekrandagi eski belgilar tozalanadi */
function ekranHolati(room, on, fromId) {
  room.state.screen = on;
  room.state.strokes = room.state.strokes.filter((s) => s.page !== 'screen');
  broadcast(room, { type: 'screen', on }, fromId);
  logEvent(room, { type: 'screen', on });
}

function emptyState() {
  // screen — ustoz ekranini ulashyapti; studentDraw — o'quvchiga chizishga ruxsat
  // notes — dars daftari: ustoz yozadi, o'quvchi jonli ko'radi, API ga saqlanadi
  return { doc: null, page: 1, strokes: [], scroll: 0, screen: false, studentDraw: false,
    notes: { matn: '', sozlar: '', vazifa: '' }, materiallar: [] };
}

// ---------- xona holatini saqlash (deploy/qayta ishga tushishdan keyin tiklash) ----------
const xonaFayli = (id) => path.join(ROOM_DIR, `${id}.json`);

function saqlanganXona(id) {
  try {
    const d = JSON.parse(fs.readFileSync(xonaFayli(id), 'utf8'));
    return Date.now() - d.savedAt < 3 * 3600_000 ? d : null;
  } catch {
    return null;
  }
}

const saqlashNavbati = new Map();
/** Xona holatini 2 soniyada bir marta diskka yozadi (o'quvchi soniyalari hozirgacha hisoblanib) */
function xonaniSaqla(id, room) {
  if (saqlashNavbati.has(id)) return;
  saqlashNavbati.set(id, setTimeout(() => {
    saqlashNavbati.delete(id);
    if (!rooms.has(id)) return;
    const ish = room.ishtirok;
    const soniya = ish.studentSeconds + (ish.studentEnteredAt ? Math.round((Date.now() - ish.studentEnteredAt) / 1000) : 0);
    const d = {
      savedAt: Date.now(),
      startedAt: room.startedAt,
      state: { ...room.state, strokes: room.state.strokes.slice(-2000) },
      studentJoined: ish.studentJoined,
      studentSeconds: soniya,
      ended: room.ended,
    };
    fs.writeFile(xonaFayli(id), JSON.stringify(d), (err) => {
      if (err) console.warn('Xona holati saqlanmadi:', err.message);
    });
  }, 2000));
}

function xonaFayliniOchir(id) {
  fs.unlink(xonaFayli(id), () => {});
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
    // Server qayta ishga tushgan bo'lsa — doska va o'quvchi qancha o'tirgani qaytadi
    const eski = saqlanganXona(id);
    if (eski) {
      room.state = { ...emptyState(), ...eski.state };
      room.startedAt = eski.startedAt || startedAt;
      room.ishtirok.studentJoined = Boolean(eski.studentJoined);
      room.ishtirok.studentSeconds = Number(eski.studentSeconds) || 0;
      room.ended = Boolean(eski.ended);
    }
    rooms.set(id, room);
    logEvent(room, { type: eski ? 'lesson-restored' : 'lesson-start', room: id });
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

// Uzilgan (javob bermaydigan) ulanishni tez aniqlaymiz — aks holda u xonada "arvoh" bo'lib
// qolib, qayta kirmoqchi bo'lgan ustoz yoki o'quvchiga "Xona to'la" chiqardi
const PING_MS = 15_000;
setInterval(() => {
  for (const c of wss.clients) {
    if (c.tirik === false) { c.terminate(); continue; }
    c.tirik = false;
    try { c.ping(); } catch { /* yopilayotgan bo'lishi mumkin */ }
  }
  // O'quvchi xonada o'tirgan vaqt diskda yangilanib tursin
  for (const [id, room] of rooms) if (room.ishtirok.studentEnteredAt) xonaniSaqla(id, room);
}, PING_MS);

wss.on('connection', async (ws, req) => {
  ws.tirik = true;
  ws.on('pong', () => { ws.tirik = true; });
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
  // Xona bo'shab qolgan edi — qaytib kelishdi, yakunlash bekor
  if (room.bushTaymer) {
    clearTimeout(room.bushTaymer);
    room.bushTaymer = null;
  }
  // Bir xonada bitta ustoz va bitta o'quvchi. Shu roldagi eski ulanish (interneti uzilgan
  // telefon, yopilmay qolgan oyna) yangisiga joy bo'shatadi — "Xona to'la" chiqmaydi
  for (const [id, p] of room.peers) {
    if (p.meta.role !== role) continue;
    // Boshqa odam (boshqa akkaunt) shu rol bilan kirsa — eski ishtirokchini chiqarib yubormaydi
    if (claims?.userId && p.meta.userId && p.meta.userId !== claims.userId) continue;
    p.almashtirildi = true;
    if (role === 'student' && room.ishtirok.studentEnteredAt) {
      room.ishtirok.studentSeconds += Math.round((Date.now() - room.ishtirok.studentEnteredAt) / 1000);
      room.ishtirok.studentEnteredAt = null;
    }
    room.peers.delete(id);
    send(p, { type: 'replaced' });
    try { p.terminate(); } catch { /* allaqachon yopilgan */ }
    broadcast(room, { type: 'peer-leave', id });
    logEvent(room, { type: 'replaced', role });
  }
  if (room.peers.size >= 2) {
    send(ws, { type: 'full' });
    return ws.close();
  }

  const clientId = crypto.randomUUID();
  ws.meta = { clientId, roomId, role, name, userId: claims?.userId || null };
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
  xonaniSaqla(roomId, room);

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
        if (room.daftarTaymer) daftarSaqla(roomId, room, true);
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
        // Darsda ochilgan fayl dars daftariga "Dars materiallari" bo'lib qo'shiladi (o'quvchi keyin ham ochadi)
        if (/^\/uploads\/[\w.\-]+$/.test(room.state.doc.url)) {
          const royxat = Array.isArray(room.state.materiallar) ? room.state.materiallar : [];
          if (!royxat.some((m) => m.url === room.state.doc.url)) {
            royxat.push({ url: room.state.doc.url, name: room.state.doc.name.slice(0, 120) || 'Material' });
            room.state.materiallar = royxat.slice(-10);
            materialniYangila(room.state.doc.url);
            daftarSaqla(roomId, room);
          }
        }
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

      // --- Chizish: ustoz doim, o'quvchi faqat ustoz ruxsat bersa ---
      case 'stroke': {
        if (!chizaOladi(room, role)) return;
        const stroke = toza(msg.stroke, role);
        if (!stroke) return;
        stroke.t = Date.now() - room.startedAt;
        if (room.state.strokes.length < 5000) room.state.strokes.push(stroke);
        broadcast(room, { type: 'stroke', stroke }, clientId);
        logEvent(room, { type: 'stroke', stroke });
        break;
      }

      case 'stroke-live': {
        if (!chizaOladi(room, role)) return;
        const stroke = toza(msg.stroke, role);
        if (stroke) broadcast(room, { type: 'stroke-live', stroke }, clientId);
        break;
      }

      // Har kim faqat o'zining oxirgi chizig'ini qaytaradi
      case 'undo': {
        if (!chizaOladi(room, role)) return;
        const list = room.state.strokes;
        for (let i = list.length - 1; i >= 0; i--) {
          if ((list[i].by || 'teacher') === role) { list.splice(i, 1); break; }
        }
        broadcast(room, { type: 'undo', by: role }, clientId);
        logEvent(room, { type: 'undo', by: role });
        break;
      }

      case 'clear': {
        if (role !== 'teacher') return;
        const page = msg.page === 'screen' ? 'screen' : room.state.page;
        room.state.strokes = room.state.strokes.filter((s) => s.page !== page);
        broadcast(room, { type: 'clear', page }, clientId);
        logEvent(room, { type: 'clear', page });
        break;
      }

      // --- Ustoz o'quvchiga chizishga ruxsat beradi / oladi ---
      case 'student-draw':
        if (role !== 'teacher') return;
        room.state.studentDraw = Boolean(msg.on);
        broadcast(room, { type: 'student-draw', on: room.state.studentDraw }, clientId);
        logEvent(room, { type: 'student-draw', on: room.state.studentDraw });
        break;

      // --- Dars daftari: eslatmalar, yangi so'zlar, uyga vazifa (faqat ustoz yozadi) ---
      case 'notes': {
        if (role !== 'teacher') return;
        const n = msg.notes || {};
        const toza = (v) => (typeof v === 'string' ? v.slice(0, 10000) : '');
        room.state.notes = { matn: toza(n.matn), sozlar: toza(n.sozlar), vazifa: toza(n.vazifa) };
        const tab = ['matn', 'sozlar', 'vazifa'].includes(msg.tab) ? msg.tab : null;
        broadcast(room, { type: 'notes', notes: room.state.notes, tab }, clientId);
        daftarSaqla(roomId, room);
        break;
      }

      // --- Ustoz ekranini ulashdi / to'xtatdi (video o'zi WebRTC orqali keladi) ---
      case 'screen':
        if (role !== 'teacher') return;
        ekranHolati(room, Boolean(msg.on), clientId);
        break;

      default:
        break;
    }
    if (msg.type !== 'offer' && msg.type !== 'answer' && msg.type !== 'ice' && msg.type !== 'stroke-live') {
      xonaniSaqla(roomId, room);
    }
  });

  ws.on('close', () => {
    // Shu rol uchun yangi ulanish kelgan — eski ulanish hech narsaga ta'sir qilmasin
    if (ws.almashtirildi) return;
    room.peers.delete(clientId);
    broadcast(room, { type: 'peer-leave', id: clientId });
    // Ustoz chiqib ketsa ekran ulashish ham tugaydi — o'quvchida qotib qolgan kadr qolmasin
    if (role === 'teacher' && room.state.screen) ekranHolati(room, false, clientId);
    logEvent(room, { type: 'leave', role, name });

    if (role === 'student' && room.ishtirok.studentEnteredAt) {
      room.ishtirok.studentSeconds += Math.round((Date.now() - room.ishtirok.studentEnteredAt) / 1000);
      room.ishtirok.studentEnteredAt = null;
    }
    // Pullik dars: ustoz qaytmasa yopiladi. Internet uzilishi/telefon almashtirish uchun 10 daqiqa
    if (role === 'teacher' && room.lessonId && !room.ended) {
      room.endTimer = setTimeout(() => {
        if (![...room.peers.values()].some((peer) => peer.meta.role === 'teacher')) {
          void endActiveRoom(roomId, room);
        }
      }, 10 * 60 * 1000);
    }
    xonaniSaqla(roomId, room);
    if (room.peers.size === 0) {
      logEvent(room, { type: 'lesson-end', strokes: room.state.strokes.length });
      // Oraliq hisobot: dars YOPILMAYDI (ikkalasi ham bir lahza uzilgan bo'lishi mumkin)
      void sinovHisoboti(roomId, room, room.ended);
      // 10 daqiqa ichida hech kim qaytmasa — endi yakuniy: lid holati va dars yopiladi
      room.bushTaymer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (!r || r.peers.size > 0) return;
        void sinovHisoboti(roomId, r, true);
        rooms.delete(roomId);
        xonaFayliniOchir(roomId);
      }, 10 * 60 * 1000);
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
