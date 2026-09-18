'use strict';
/* Jonli dars xonasi: 1:1 WebRTC video + PDF ustida sinxron chizish. */

// ---------- Parametrlar ----------
const Q = new URLSearchParams(location.search);
const TOKEN = Q.get('t') || '';

// Token ichidagi ma'lumot faqat interfeysni to'g'ri chizish uchun o'qiladi —
// haqiqiy tekshiruv serverda, imzo bo'yicha bo'ladi.
function peekToken(tok) {
  try {
    const p = tok.split('.')[1];
    const json = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch { return null; }
}

const CLAIMS = TOKEN ? peekToken(TOKEN) : null;
const ROOM = (CLAIMS ? CLAIMS.room : Q.get('room') || '').toLowerCase();
const ROLE = (CLAIMS ? CLAIMS.role : Q.get('role')) === 'teacher' ? 'teacher' : 'student';
const NAME = (CLAIMS && CLAIMS.name) || Q.get('name') || (ROLE === 'teacher' ? 'Ustoz' : 'O‘quvchi');
const IS_TEACHER = ROLE === 'teacher';

if (!ROOM && !TOKEN) location.replace('index.html');

const $ = (s) => document.querySelector(s);
const el = {
  stage: $('#stage'), status: $('#status'),
  localVideo: $('#localVideo'), remoteVideo: $('#remoteVideo'),
  localPh: $('#localPh'), remotePh: $('#remotePh'),
  localTag: $('#localTag'), remoteTag: $('#remoteTag'),
  btnMic: $('#btnMic'), btnCam: $('#btnCam'), btnLeave: $('#btnLeave'),
  toolbar: $('#toolbar'), fileInput: $('#fileInput'),
  btnUndo: $('#btnUndo'), btnClear: $('#btnClear'),
  btnPrev: $('#btnPrev'), btnNext: $('#btnNext'), pageNo: $('#pageNo'), pagePill: $('#pagePill'),
  board: $('#board'), empty: $('#empty'), emptyHint: $('#emptyHint'),
  pdfbox: $('#pdfbox'), pdfCanvas: $('#pdfCanvas'), inkCanvas: $('#inkCanvas'),
  toast: $('#toast'),
};

el.localTag.textContent = NAME + ' (siz)';
if (IS_TEACHER) {
  document.body.classList.add('can-draw');
  el.emptyHint.textContent = 'PDF ochish uchun 📄 tugmasini bosing';
} else {
  document.body.classList.add('viewer');
  el.toolbar.hidden = true;
}

let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}
function setStatus(t) { el.status.textContent = t; }

// ================= 1. WebSocket =================
let ws = null, myId = null, peerId = null, isInitiator = false, retry = 0;

const outbox = [];
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else if (outbox.length < 200) outbox.push(obj); // ulanish tiklanganda jo'natiladi
}
function flushOutbox() {
  while (outbox.length && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outbox.shift()));
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = TOKEN
    ? `${proto}://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`
    : `${proto}://${location.host}/ws?room=${encodeURIComponent(ROOM)}`
      + `&role=${ROLE}&name=${encodeURIComponent(NAME)}`;
  ws = new WebSocket(url);

  ws.onopen = () => { retry = 0; setStatus('Xonada'); flushOutbox(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onSignal(m); };
  ws.onclose = () => {
    setStatus('Uzildi, qayta ulanmoqda…');
    retry += 1;
    if (retry < 40) setTimeout(connect, Math.min(1000 * retry, 8000));
  };
  ws.onerror = () => {};
}

async function onSignal(m) {
  switch (m.type) {
    case 'full':
      // Sahifadan otib yubormaymiz — nima bo'lganini ko'rsatamiz
      retry = 99;                       // qayta ulanishga urinmasin
      setStatus('Xona to‘la');
      el.remotePh.hidden = false;
      el.remotePh.innerHTML = '<b>Xona to‘la</b><span>Bu darsda allaqachon 2 ta ishtirokchi bor.<br>'
        + 'Boshqa qurilmada ochiq oynangiz bo‘lsa, yoping va qayta urinib ko‘ring.</span>';
      toast('Xona to‘la — boshqa ochiq oynani yoping', 8000);
      break;

    case 'error':
      // Sahifadan otib yubormaymiz — sababi ko'rinib tursin
      retry = 99;
      setStatus(m.message || 'Xatolik');
      el.remotePh.hidden = false;
      el.remotePh.innerHTML = `<b>Xonaga kirib bo‘lmadi</b><span>${m.message || 'Xatolik'}<br>`
        + '<a href="index.html" style="color:#60a5fa">Bosh sahifaga qaytish</a></span>';
      toast(m.message || 'Xatolik', 8000);
      break;

    case 'joined':
      myId = m.you.id;
      if (Array.isArray(m.iceServers) && m.iceServers.length) RTC_CONFIG.iceServers = m.iceServers;
      if (m.peers.length) { peerId = m.peers[0].id; isInitiator = true; onPeerReady(m.peers[0]); }
      applyState(m.state);
      break;

    case 'peer-join':
      peerId = m.peer.id;
      isInitiator = false;
      onPeerReady(m.peer);
      break;

    case 'peer-leave':
      peerId = null;
      teardownPeer();
      setStatus('Suhbatdosh chiqdi');
      el.remotePh.hidden = false;
      el.remotePh.querySelector('b').textContent = 'Suhbatdosh chiqdi';
      el.remoteVideo.classList.add('off');
      break;

    // --- WebRTC ---
    case 'offer':  await onOffer(m.sdp); break;
    case 'answer': await onAnswer(m.sdp); break;
    case 'ice':    await onRemoteIce(m.candidate); break;

    // --- Workspace ---
    case 'doc':        loadDoc(m.url, m.name); break;
    case 'page':       gotoPage(m.page, false); break;
    case 'stroke':     strokes.push(m.stroke); liveRemote = null; redraw(); break;
    case 'stroke-live': liveRemote = m.stroke; redraw(); break;
    case 'undo':       strokes.pop(); redraw(); break;
    case 'clear':      strokes = strokes.filter((s) => s.page !== m.page); redraw(); break;
    case 'scroll':     applyScroll(m.y); break;
  }
}

function applyState(state) {
  if (!state) return;
  strokes = state.strokes || [];
  if (state.doc && state.doc.url) {
    loadDoc(state.doc.url, state.doc.name, state.page || 1)
      .then(() => applyScroll(state.scroll || 0));
  }
}

// ================= 2. Media + WebRTC =================
// ICE serverlar server tomondan keladi ('joined' xabarida): STUN, TURN sozlangan bo'lsa TURN ham.
// TURN paroli qisqa muddatli — shuning uchun bu yerda hech narsa qattiq yozilmaydi.
const RTC_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

let pc = null, localStream = null, pendingIce = [];

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    });
  } catch (err) {
    console.warn('getUserMedia:', err);
    toast('Kamera/mikrofonga ruxsat berilmadi', 5000);
    return;
  }
  el.localVideo.srcObject = localStream;
  el.localPh.hidden = true;
}

function ensurePc() {
  if (pc) return pc;
  pc = new RTCPeerConnection(RTC_CONFIG);

  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'ice', candidate: e.candidate }); };

  pc.ontrack = (e) => {
    el.remoteVideo.srcObject = e.streams[0];
    el.remoteVideo.classList.remove('off');
    el.remotePh.hidden = true;
    playRemote();
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') { setStatus('Aloqa o‘rnatildi'); reportPath(); }
    else if (s === 'connecting') setStatus('Ulanmoqda…');
    else if (s === 'failed') { setStatus('Aloqa uzildi'); restartIce(); }
    else if (s === 'disconnected') setStatus('Aloqa beqaror…');
  };

  return pc;
}

// Aloqa to'g'ridan-to'g'rimi yoki TURN orqalimi — nosozlikni topishda asqotadi
async function reportPath() {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const relayed = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
    console.log(`[aloqa] ${local && local.candidateType} <-> ${remote && remote.candidateType}`
                + (relayed ? ' (TURN orqali)' : ' (to‘g‘ridan-to‘g‘ri)'));
  } catch {}
}

function playRemote() {
  el.remoteVideo.play().catch(() => {
    toast('Ovozni yoqish uchun ekranga bosing', 4000);
    const once = () => { el.remoteVideo.play().catch(() => {}); document.removeEventListener('click', once); };
    document.addEventListener('click', once);
  });
}

async function onPeerReady(peer) {
  el.remoteTag.textContent = peer.name || (peer.role === 'teacher' ? 'Ustoz' : 'O‘quvchi');
  el.remotePh.querySelector('b').textContent = 'Video kutilmoqda…';
  ensurePc();
  if (isInitiator) await makeOffer();
}

async function makeOffer() {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'offer', sdp: pc.localDescription });
  } catch (e) { console.warn('offer', e); }
}

async function onOffer(sdp) {
  ensurePc();
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushIce();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: 'answer', sdp: pc.localDescription });
}

async function onAnswer(sdp) {
  if (!pc || pc.signalingState === 'stable') return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushIce();
}

async function onRemoteIce(candidate) {
  if (!candidate) return;
  if (!pc || !pc.remoteDescription) { pendingIce.push(candidate); return; }
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.warn('ice', e); }
}

async function flushIce() {
  const list = pendingIce; pendingIce = [];
  for (const c of list) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {} }
}

async function restartIce() {
  if (!pc || !isInitiator) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    wsSend({ type: 'offer', sdp: pc.localDescription });
  } catch {}
}

function teardownPeer() {
  if (pc) { pc.close(); pc = null; }
  pendingIce = [];
  el.remoteVideo.srcObject = null;
}

// --- Mic / Cam ---
el.btnMic.onclick = () => {
  const t = localStream && localStream.getAudioTracks()[0];
  if (!t) return toast('Mikrofon yo‘q');
  t.enabled = !t.enabled;
  el.btnMic.classList.toggle('off', !t.enabled);
  el.btnMic.textContent = t.enabled ? '🎤' : '🔇';
};
el.btnCam.onclick = () => {
  const t = localStream && localStream.getVideoTracks()[0];
  if (!t) return toast('Kamera yo‘q');
  t.enabled = !t.enabled;
  el.btnCam.classList.toggle('off', !t.enabled);
  el.localVideo.classList.toggle('off', !t.enabled);
  el.localPh.hidden = t.enabled;
};
el.btnLeave.onclick = () => {
  if (!confirm('Darsdan chiqasizmi?')) return;
  try { ws && ws.close(); } catch {}
  teardownPeer();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  location.href = 'index.html';
};

// ================= 3. PDF =================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let pdfDoc = null, pageNum = 1, rendering = false, pendingPage = null, currentDocUrl = null;

async function loadDoc(url, name, page = 1) {
  if (!url || url === currentDocUrl) { if (pdfDoc) gotoPage(page, false); return; }
  currentDocUrl = url;
  setStatus('Hujjat yuklanmoqda…');
  try {
    pdfDoc = await pdfjsLib.getDocument(url).promise;
  } catch (e) {
    console.warn(e); toast('PDF ochilmadi'); currentDocUrl = null; return;
  }
  el.empty.hidden = true;
  el.pdfbox.hidden = false;
  el.pagePill.hidden = false;
  setStatus(pc && pc.connectionState === 'connected' ? 'Aloqa o‘rnatildi' : 'Xonada');
  if (name) toast(`Hujjat: ${name}`);
  await gotoPage(page, false);
}

async function renderPage(n) {
  if (!pdfDoc) return;
  if (rendering) { pendingPage = n; return; }
  rendering = true;

  const page = await pdfDoc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const avail = Math.max(240, el.board.clientWidth - 16);
  const viewport = page.getViewport({ scale: avail / base.width }); // eniga moslab
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const c = el.pdfCanvas;
  c.width = Math.floor(viewport.width * dpr);
  c.height = Math.floor(viewport.height * dpr);
  c.style.width = Math.floor(viewport.width) + 'px';
  c.style.height = Math.floor(viewport.height) + 'px';

  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Ink qatlamini bir xil o'lchamga keltiramiz
  el.inkCanvas.width = c.width;
  el.inkCanvas.height = c.height;
  el.inkCanvas.style.width = c.style.width;
  el.inkCanvas.style.height = c.style.height;
  redraw();

  el.pageNo.textContent = `${n}/${pdfDoc.numPages}`;
  rendering = false;
  if (pendingPage !== null) { const p = pendingPage; pendingPage = null; renderPage(p); }
}

async function gotoPage(n, broadcast = true) {
  if (!pdfDoc) return;
  const next = Math.min(Math.max(1, n), pdfDoc.numPages);
  pageNum = next;
  await renderPage(pageNum);
  applyScroll(0);
  if (broadcast && IS_TEACHER) wsSend({ type: 'page', page: pageNum });
}

el.btnPrev.onclick = () => gotoPage(pageNum - 1);
el.btnNext.onclick = () => gotoPage(pageNum + 1);

// Ustoz PDF yuklaydi
el.fileInput.onchange = async () => {
  const f = el.fileInput.files[0];
  if (!f) return;
  if (f.size > 25 * 1024 * 1024) return toast('Fayl 25MB dan katta');
  setStatus('Yuklanmoqda…');
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await fetch(TOKEN ? `/api/upload?t=${encodeURIComponent(TOKEN)}` : '/api/upload',
                          { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'upload');
    strokes = []; liveRemote = null;
    await loadDoc(j.url, j.name);
    wsSend({ type: 'doc', url: j.url, name: j.name });
  } catch (e) {
    console.warn(e); toast('Yuklab bo‘lmadi');
  }
  el.fileInput.value = '';
};

// --- Scroll sinxronizatsiyasi (ustoz suradi, o'quvchida ham suriladi) ---
let scrollFromPeer = false, scrollSent = 0, scrollTimer = null;

// Hujjat balandligiga nisbatan o'lchaymiz — ikkala ekranda ham bir xil joy chiqadi
function docHeight() { return el.pdfbox.clientHeight || el.board.scrollHeight || 1; }

function applyScroll(frac) {
  scrollFromPeer = true;
  el.board.scrollTop = frac * docHeight();
  requestAnimationFrame(() => { scrollFromPeer = false; });
}

if (IS_TEACHER) {
  el.board.addEventListener('scroll', () => {
    if (scrollFromPeer || !pdfDoc) return;
    const now = performance.now();
    const emit = () => {
      scrollSent = performance.now();
      wsSend({ type: 'scroll', y: el.board.scrollTop / docHeight() });
    };
    if (now - scrollSent > 120) emit();
    else { clearTimeout(scrollTimer); scrollTimer = setTimeout(emit, 120); }
  }, { passive: true });
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (pdfDoc) renderPage(pageNum); }, 180);
});

// ================= 4. Chizish =================
let strokes = [];          // barcha tasdiqlangan chiziqlar
let liveRemote = null;     // suhbatdoshning hozir chizayotgani
let liveLocal = null;      // o'zimizniki
let tool = 'pen';
let color = '#ef4444';

const WIDTH = { pen: 0.0045, hl: 0.030 }; // kanvas eniga nisbatan

document.querySelectorAll('.tool').forEach((b) => {
  b.onclick = () => {
    tool = b.dataset.tool;
    document.querySelectorAll('.tool').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  };
});
document.querySelectorAll('.sw').forEach((b) => {
  b.onclick = () => {
    color = b.dataset.color;
    document.querySelectorAll('.sw').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  };
});

function drawStroke(ctx, s, W, H) {
  if (!s || !s.pts || s.pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = Math.max(1, s.w * W);
  ctx.lineJoin = 'round';
  if (s.tool === 'hl') {
    ctx.globalAlpha = 0.32;
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'multiply';
  } else {
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
  }
  ctx.beginPath();
  s.pts.forEach((p, i) => {
    const x = p[0] * W, y = p[1] * H;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  if (s.pts.length === 1) { // bitta nuqta — kichik doira
    ctx.lineTo(s.pts[0][0] * W + 0.01, s.pts[0][1] * H);
  }
  ctx.stroke();
  ctx.restore();
}

function redraw() {
  const c = el.inkCanvas;
  if (!c.width) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const W = c.width, H = c.height;
  for (const s of strokes) if (s.page === pageNum) drawStroke(ctx, s, W, H);
  if (liveRemote && liveRemote.page === pageNum) drawStroke(ctx, liveRemote, W, H);
  if (liveLocal && liveLocal.page === pageNum) drawStroke(ctx, liveLocal, W, H);
}

// --- Ustozning qo'l harakati ---
if (IS_TEACHER) {
  const c = el.inkCanvas;
  let drawing = false, lastSent = 0, strokeStart = 0;

  const pos = (e) => {
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  c.addEventListener('pointerdown', (e) => {
    if (!pdfDoc) return;
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    drawing = true;
    c.setPointerCapture(e.pointerId);
    strokeStart = performance.now();
    liveLocal = { page: pageNum, tool, color, w: WIDTH[tool], pts: [pos(e)] };
    redraw();
  });

  c.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pos(e);
    const pts = liveLocal.pts;
    const last = pts[pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.002) return; // mayda titrashni tashlab ketamiz
    pts.push(p);
    redraw();
    const now = performance.now();
    if (now - lastSent > 70) { lastSent = now; wsSend({ type: 'stroke-live', stroke: liveLocal }); }
  });

  const finish = () => {
    if (!drawing) return;
    drawing = false;
    const s = liveLocal;
    liveLocal = null;
    if (s && s.pts.length) {
      s.dur = Math.round(performance.now() - strokeStart); // chizish qancha davom etdi
      strokes.push(s);
      wsSend({ type: 'stroke', stroke: s });
    }
    redraw();
  };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
  c.addEventListener('pointerleave', finish);

  el.btnUndo.onclick = () => { strokes.pop(); redraw(); wsSend({ type: 'undo' }); };
  el.btnClear.onclick = () => {
    if (!confirm('Shu sahifadagi belgilarni o‘chirasizmi?')) return;
    strokes = strokes.filter((s) => s.page !== pageNum);
    redraw();
    wsSend({ type: 'clear' });
  };
}

// ================= 5. Ishga tushirish =================
(async function start() {
  await initMedia();
  connect();
})();

window.addEventListener('beforeunload', () => { try { ws && ws.close(); } catch {} });
