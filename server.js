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
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = http.createServer(app);

// ---------- Signaling + annotatsiya sinxronizatsiyasi ----------
// rooms: Map<roomId, { peers: Map<clientId, ws>, state: {...} }>
const rooms = new Map();

function emptyState() {
  return { doc: null, page: 1, strokes: [], scroll: 0 };
}

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { peers: new Map(), state: emptyState() });
  return rooms.get(id);
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
        break;

      case 'page':
        if (role !== 'teacher') return;
        room.state.page = Math.max(1, Number(msg.page) || 1);
        room.state.scroll = 0;
        broadcast(room, { type: 'page', page: room.state.page }, clientId);
        break;

      case 'scroll':
        if (role !== 'teacher') return;
        room.state.scroll = Math.min(1, Math.max(0, Number(msg.y) || 0));
        broadcast(room, { type: 'scroll', y: room.state.scroll }, clientId);
        break;

      case 'stroke':
        if (role !== 'teacher') return;
        if (room.state.strokes.length < 5000) room.state.strokes.push(msg.stroke);
        broadcast(room, { type: 'stroke', stroke: msg.stroke }, clientId);
        break;

      case 'stroke-live':
        if (role !== 'teacher') return;
        broadcast(room, { type: 'stroke-live', stroke: msg.stroke }, clientId);
        break;

      case 'undo':
        if (role !== 'teacher') return;
        room.state.strokes.pop();
        broadcast(room, { type: 'undo' }, clientId);
        break;

      case 'clear':
        if (role !== 'teacher') return;
        room.state.strokes = room.state.strokes.filter((s) => s.page !== room.state.page);
        broadcast(room, { type: 'clear', page: room.state.page }, clientId);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    room.peers.delete(clientId);
    broadcast(room, { type: 'peer-leave', id: clientId });
    if (room.peers.size === 0) {
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
