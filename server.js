'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

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

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Faqat PDF fayl, 25MB gacha' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

// ---------- Dars jurnallari (keyinchalik replay / AI tahlil uchun) ----------
app.get('/api/lessons', (req, res) => {
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

app.get('/api/lessons/:file', (req, res) => {
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
  const roomId = (url.searchParams.get('room') || '').trim().toLowerCase();
  const role = url.searchParams.get('role') === 'teacher' ? 'teacher' : 'student';
  const name = (url.searchParams.get('name') || '').slice(0, 40);

  if (!/^[a-z0-9\-]{3,40}$/.test(roomId)) {
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
});
