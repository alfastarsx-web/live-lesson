'use strict';
/* Jonli dars xonasi: 1:1 WebRTC video + hujjat (PDF yoki rasm) ustida sinxron chizish. */

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

// Token uch yo'ldan birida keladi:
//   1. ?t=<token>          — mobil ilova WebView'da shunday ochadi
//   2. /dars/<xona>        — o'quvchi kurs kartasidagi havoladan kiradi (parolsiz)
//   3. cookie              — ustoz login/parol bilan kirgan
async function tokenTop() {
  if (TOKEN) return TOKEN;

  // Chegara server bilan bir xil bo'lishi shart: mentor xonasi
  // "mentor-<uuid>" 43 belgi, ilgari bu yerda 40 turgani uchun o'quvchi
  // ustoz login sahifasiga tushib qolardi
  const m = location.pathname.match(/^\/dars\/([a-z0-9-]{3,64})\/?$/i);
  if (m) {
    const nomi = Q.get('name') ? `?name=${encodeURIComponent(Q.get('name'))}` : '';
    const r = await fetch(`/api/join/${m[1].toLowerCase()}${nomi}`);
    if (r.ok) return (await r.json()).token;
    return null;
  }

  // /dars/ dan kelgan-u, xona nomi yaroqsiz — o'quvchini login sahifasiga
  // yubormaymiz, unda hisob yo'q
  if (location.pathname.startsWith('/dars/')) return null;

  const r = await fetch('/api/session');
  if (r.ok) return (await r.json()).token;
  return null;    // ustoz kirmagan
}

let CLAIMS = TOKEN ? peekToken(TOKEN) : null;
let ROOM = '', ROLE = 'student', NAME = '', IS_TEACHER = false;
// Dars tugadi: ws yopilganda qayta ulanish kerak emas
let DARS_TUGADI = false;

function rolniQoy(claims) {
  CLAIMS = claims;
  ROOM = (claims ? claims.room : Q.get('room') || '').toLowerCase();
  ROLE = (claims ? claims.role : Q.get('role')) === 'teacher' ? 'teacher' : 'student';
  NAME = (claims && claims.name) || Q.get('name') || (ROLE === 'teacher' ? 'Ustoz' : 'O‘quvchi');
  IS_TEACHER = ROLE === 'teacher';
}
rolniQoy(CLAIMS);

const $ = (s) => document.querySelector(s);
const el = {
  stage: $('#stage'), status: $('#status'),
  localVideo: $('#localVideo'), remoteVideo: $('#remoteVideo'), remoteAudio: $('#remoteAudio'),
  localPh: $('#localPh'), remotePh: $('#remotePh'),
  localTag: $('#localTag'), remoteTag: $('#remoteTag'),
  btnMic: $('#btnMic'), btnCam: $('#btnCam'), btnLeave: $('#btnLeave'),
  toolbar: $('#toolbar'), fileInput: $('#fileInput'),
  btnUndo: $('#btnUndo'), btnClear: $('#btnClear'),
  btnPrev: $('#btnPrev'), btnNext: $('#btnNext'), pageNo: $('#pageNo'), pagePill: $('#pagePill'),
  board: $('#board'), empty: $('#empty'), emptyHint: $('#emptyHint'),
  pdfbox: $('#pdfbox'), pdfCanvas: $('#pdfCanvas'), inkCanvas: $('#inkCanvas'),
  zoomBelgi: $('#zoomBelgi'), zoomFoiz: $('#zoomFoiz'), zoomTiklash: $('#zoomTiklash'),
  toast: $('#toast'),
  btnScreen: $('#btnScreen'), btnStudentDraw: $('#btnStudentDraw'),
  screenbox: $('#screenbox'), screenVideo: $('#screenVideo'), screenInk: $('#screenInk'),
};

// Ekran ulashish rejimi (ish maydonida ustoz ekrani) va o'quvchiga chizish ruxsati
let EKRAN = false, STUDENT_DRAW = false;
// Telefon brauzerlari ekranni ulasha olmaydi — tugmani faqat imkon bo'lsa ko'rsatamiz
const EKRAN_MUMKIN = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

function interfeysniSozla() {
  el.localTag.textContent = NAME + ' (siz)';
  document.body.classList.toggle('teacher', IS_TEACHER);
  el.btnScreen.hidden = !EKRAN_MUMKIN;
  if (IS_TEACHER) {
    document.body.classList.remove('viewer');
    document.body.classList.add('can-draw');
    el.toolbar.hidden = false;
    // O'quvchi darsga ilovadan kiradi — havola ko'rsatilmaydi
    el.emptyHint.textContent = 'PDF yoki rasm ochish uchun 📄 tugmasini bosing';
  } else {
    document.body.classList.add('viewer');
    el.emptyHint.textContent = 'Ustoz hujjat ochishini kuting';
    chizishHolati();
  }
}

/** O'quvchida asboblar paneli faqat ustoz ruxsat berganda chiqadi */
function chizishHolati() {
  if (IS_TEACHER) {
    el.btnStudentDraw.setAttribute('aria-pressed', String(STUDENT_DRAW));
    return;
  }
  document.body.classList.toggle('can-draw', STUDENT_DRAW);
  el.toolbar.hidden = !STUDENT_DRAW;
  if (STUDENT_DRAW && color === '#ef4444') rangQoy('#3b82f6'); // ustozdan farq qilsin
}
const chizaOladi = () => IS_TEACHER || STUDENT_DRAW;
interfeysniSozla();

let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}
function setStatus(t) { el.status.textContent = t; }

// ================= 1. WebSocket =================
let ws = null, myId = null, peerId = null, isInitiator = false, retry = 0, qaytaUlanishTaymer = null;

// Internet qaytdi — kutib o'tirmay darhol ulanamiz
window.addEventListener('online', () => {
  if (DARS_TUGADI || (ws && ws.readyState <= WebSocket.OPEN)) return;
  clearTimeout(qaytaUlanishTaymer);
  retry = 0;
  connect();
});

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
  // Ulanish allaqachon ochiq yoki ochilayotgan bo'lsa — ikkinchisini ochmaymiz
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(qaytaUlanishTaymer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = AKTIV_TOKEN
    ? `${proto}://${location.host}/ws?t=${encodeURIComponent(AKTIV_TOKEN)}`
    : `${proto}://${location.host}/ws?room=${encodeURIComponent(ROOM)}`
      + `&role=${ROLE}&name=${encodeURIComponent(NAME)}`;
  ws = new WebSocket(url);

  ws.onopen = () => { retry = 0; setStatus('Xonada'); flushOutbox(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onSignal(m); };
  ws.onclose = () => {
    // Dars tugagan bo'lsa qayta ulanmaymiz: aks holda o'quvchi xonaga qaytib
    // kirib qoladi va sinov darsi hisoboti kechikadi (u xona bo'shaganda ketadi)
    if (DARS_TUGADI) return;
    setStatus('Internet uzildi — qayta ulanmoqda…');
    retry += 1;
    // Internet qaytguncha urinib turamiz (~25 daqiqa); "online" bo'lishi bilan darhol
    if (retry < 200) qaytaUlanishTaymer = setTimeout(connect, Math.min(1000 * retry, 8000));
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
        + '<a href="/jadval.html" style="color:#8fbfa6">Jadvalga qaytish</a></span>';
      toast(m.message || 'Xatolik', 8000);
      break;

    case 'joined':
      myId = m.you.id;
      if (Array.isArray(m.iceServers) && m.iceServers.length) RTC_CONFIG.iceServers = m.iceServers;
      // Qayta ulanish: eski (uzilgan) video aloqani tashlab, yangidan quramiz
      if (pc) teardownPeer();
      if (m.peers.length) { peerId = m.peers[0].id; isInitiator = true; onPeerReady(m.peers[0]); }
      applyState(m.state);
      break;

    case 'peer-join':
      // Suhbatdosh qayta kirdi — eski aloqa yaroqsiz, yangisini kutamiz
      if (pc) teardownPeer();
      peerId = m.peer.id;
      isInitiator = false;
      onPeerReady(m.peer);
      break;

    // Ustoz darsni yakunladi — o'quvchidan darhol baho so'raymiz
    case 'dars-tugadi':
      if (!IS_TEACHER) {
        DARS_TUGADI = true;
        teardownPeer();
        if (localStream) localStream.getTracks().forEach((t) => t.stop());
        try { ws && ws.close(); } catch {}
        bahoOynasi();
      }
      break;

    // Shu dars boshqa oyna/qurilmada ochildi — bu oyna qayta ulanmasin
    case 'replaced':
      DARS_TUGADI = true;
      teardownPeer();
      setStatus('Dars boshqa oynada ochildi');
      el.remotePh.hidden = false;
      el.remotePh.innerHTML = '<b>Dars boshqa oynada ochildi</b><span>Shu dars boshqa qurilma yoki oynada davom etyapti.</span>';
      break;

    case 'peer-leave':
      if (m.id && peerId && m.id !== peerId) break; // eski ulanish — joriy suhbatdoshga tegishli emas
      peerId = null;
      teardownPeer();
      setStatus('Suhbatdosh uzildi — qaytishini kuting');
      el.remotePh.hidden = false;
      el.remotePh.innerHTML = '<b>Suhbatdosh uzildi</b><span>Dars davom etadi — u qaytib kirishi bilan aloqa tiklanadi.</span>';
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
    case 'undo':       oxirgisiniOchir(m.by || 'teacher'); redraw(); break;
    case 'clear':      strokes = strokes.filter((s) => s.page !== m.page); redraw(); break;
    case 'scroll':     applyScroll(m.y); break;
    case 'student-draw':
      STUDENT_DRAW = Boolean(m.on);
      chizishHolati();
      if (!IS_TEACHER) toast(STUDENT_DRAW ? '✏️ Ustoz sizga chizishga ruxsat berdi' : 'Chizish yopildi', 3500);
      break;
    case 'screen':     if (!IS_TEACHER) ekranRejimi(Boolean(m.on)); break;
    case 'notes':      daftarKeldi(m.notes, m.tab); break;
  }
}

function applyState(state) {
  if (!state) return;
  strokes = state.strokes || [];
  STUDENT_DRAW = Boolean(state.studentDraw);
  chizishHolati();
  if (!IS_TEACHER && state.screen) ekranRejimi(true);
  daftarKeldi(state.notes, null, true);
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

let pc = null, localStream = null, pendingIce = [], remoteStream = null;

// Telefonda kamera yengilroq: 720p kodlash telefonni qizdiradi va batareyani tez yeydi,
// kichik plitkada esa farqi ko'rinmaydi
const TELEFON = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const KAMERA = TELEFON
  ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' }
  : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' };

const AUDIO_SOZLAMALARI = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function initMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_SOZLAMALARI,
      video: KAMERA,
    });
  } catch (err) {
    console.warn('getUserMedia audio+video xato, faqat ovozni sinab ko‘ramiz:', err);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_SOZLAMALARI });
      toast('Kamera topilmadi yoki ruxsat yo‘q — faqat ovoz ulandi', 4000);
    } catch (err2) {
      console.warn('getUserMedia faqat audio xato, faqat kamerani sinaymiz:', err2);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: KAMERA });
        toast('Mikrofon topilmadi yoki ruxsat yo‘q — faqat kamera ulandi', 4000);
      } catch (err3) {
        console.warn('getUserMedia barcha qurilmalar xato:', err3);
        toast('Kamera/mikrofonga ruxsat berilmadi. Suhbatdoshni eshitish uchun sahifada qoling', 6000);
        return;
      }
    }
  }
  if (localStream) {
    const hasVideo = localStream.getVideoTracks().length > 0;
    const hasAudio = localStream.getAudioTracks().length > 0;
    if (hasVideo) {
      el.localVideo.srcObject = localStream;
      el.localPh.hidden = true;
    } else {
      el.localPh.hidden = false;
      const b = el.localPh.querySelector('b');
      if (b) b.textContent = 'Kamera o‘chiq';
    }
    el.btnMic.classList.toggle('off', !hasAudio);
    el.btnMic.textContent = hasAudio ? '🎤' : '🔇';
    el.btnCam.classList.toggle('off', !hasVideo);
  }
}

function ensurePc() {
  if (pc) return pc;
  pc = new RTCPeerConnection(RTC_CONFIG);

  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  // Agar mahalliy mikrofon yoki kamera bo'lmasa — qabul qilish (recvonly) yo'lagini qo'shamiz,
  // shunda suhbatdoshning ovozi va videosi keladi va ekran ulashish ishlaydi
  try {
    const senders = pc.getSenders();
    const hasAudio = senders.some((s) => s.track && s.track.kind === 'audio');
    const hasVideo = senders.some((s) => s.track && s.track.kind === 'video');
    if (!hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!hasVideo) pc.addTransceiver('video', { direction: 'recvonly' });
  } catch (e) { console.warn('transceivers', e); }
  // Ekran ulashilayotgan paytda o'quvchi qayta kirsa — unga ham ekran ketsin
  if (screenTrack) videoniAlmashtir(screenTrack);

  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'ice', candidate: e.candidate }); };

  pc.ontrack = (e) => {
    // Ovoz — alohida <audio> da; videolarga faqat tasvir. iPhone bir oqimni ikki video elementga
    // berilganda birini to'xtatadi — ekran ulashilganda ovoz shu sabab yo'qolardi
    remoteStream = e.streams[0];
    el.remoteAudio.srcObject = remoteStream;
    el.remoteVideo.srcObject = faqatVideo();
    if (EKRAN && !IS_TEACHER) el.screenVideo.srcObject = faqatVideo();
    el.remoteVideo.classList.remove('off');
    // Ekran ulashilayotgan bo'lsa plitkada "Ustoz ekranini ko'rsatyapti" qolsin
    el.remotePh.hidden = !(EKRAN && !IS_TEACHER);
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

/** Suhbatdoshning faqat video yo'lagi (ovozsiz) — video elementlar uchun */
function faqatVideo() {
  return remoteStream ? new MediaStream(remoteStream.getVideoTracks()) : null;
}

function playRemote() {
  el.remoteVideo.play().catch(() => {});
  el.remoteAudio.play().catch(() => {
    toast('Ovozni yoqish uchun ekranga bosing', 4000);
    const once = () => { el.remoteAudio.play().catch(() => {}); document.removeEventListener('click', once); };
    document.addEventListener('click', once);
  });
}

// Video yoki ovoz tizim tomonidan to'xtatilsa (iPhone, fonga o'tish) — darhol davom ettiramiz
[el.remoteVideo, el.localVideo, el.screenVideo, el.remoteAudio].forEach((m) => {
  m.addEventListener('pause', () => { if (m.srcObject) m.play().catch(() => {}); });
});

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
  remoteStream = null;
  el.remoteVideo.srcObject = null;
  el.remoteAudio.srcObject = null;
}

// --- Mic / Cam ---
el.btnMic.onclick = async () => {
  let t = localStream && localStream.getAudioTracks()[0];
  if (!t) {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_SOZLAMALARI });
      t = ms.getAudioTracks()[0];
      if (!localStream) localStream = new MediaStream();
      localStream.addTrack(t);
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) {
          await sender.replaceTrack(t);
        } else {
          pc.addTrack(t, localStream);
          if (pc.signalingState === 'stable') restartIce();
        }
      }
      el.btnMic.classList.remove('off');
      el.btnMic.textContent = '🎤';
      toast('Mikrofon yoqildi', 3000);
      return;
    } catch {
      return toast('Mikrofon ruxsati berilmadi');
    }
  }
  t.enabled = !t.enabled;
  el.btnMic.classList.toggle('off', !t.enabled);
  el.btnMic.textContent = t.enabled ? '🎤' : '🔇';
};
el.btnCam.onclick = async () => {
  let t = localStream && localStream.getVideoTracks()[0];
  if (!t) {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ video: KAMERA });
      t = ms.getVideoTracks()[0];
      if (!localStream) localStream = new MediaStream();
      localStream.addTrack(t);
      el.localVideo.srcObject = localStream;
      el.localPh.hidden = true;
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(t);
        } else {
          pc.addTrack(t, localStream);
          if (pc.signalingState === 'stable') restartIce();
        }
      }
      el.btnCam.classList.remove('off');
      toast('Kamera yoqildi', 3000);
      return;
    } catch {
      return toast('Kamera ruxsati berilmadi');
    }
  }
  t.enabled = !t.enabled;
  el.btnCam.classList.toggle('off', !t.enabled);
  el.localVideo.classList.toggle('off', !t.enabled);
  el.localPh.hidden = t.enabled;
};
// ================= Ekranni ulashish =================
// Kamera o'rniga ekran yuboriladi (replaceTrack) — qayta ulanish kerak emas, ovoz uzilmaydi.
let screenTrack = null;

/** Video yo'lagidagi uzatgich; kamera o'chirilgan bo'lsa ham yo'lak saqlanadi */
function videoUzatgich() {
  if (!pc) return null;
  const tr = pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
  return tr ? tr.sender : null;
}

async function videoniAlmashtir(track) {
  const sender = videoUzatgich();
  if (!sender) return false;
  try { await sender.replaceTrack(track); return true; } catch (e) { console.warn('replaceTrack', e); return false; }
}

async function ekranniBoshla() {
  if (!EKRAN_MUMKIN) return toast('Bu qurilmada ekranni ulashib bo‘lmaydi — kompyuterdan kiring', 4000);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
      selfBrowserSurface: 'exclude',   // dars oynasining o'zi ro'yxatda chiqmasin (cheksiz oyna)
      surfaceSwitching: 'include',
    });
  } catch {
    return; // ustoz bekor qildi
  }
  screenTrack = stream.getVideoTracks()[0];
  if (!screenTrack) return;
  screenTrack.contentHint = 'detail';     // matn aniq ko'rinsin
  screenTrack.onended = () => ekranniTugat(); // brauzerning "Stop sharing" tugmasi
  // Video yo'lagi kamera bilan ochiladi; kamera umuman bo'lmasa ekranni yuborishga joy yo'q
  if (pc && !videoUzatgich()) {
    screenTrack.stop(); screenTrack = null;
    return toast('Ekranni ulashish uchun kameraga ruxsat bering va sahifani yangilang', 5000);
  }
  await videoniAlmashtir(screenTrack);
  el.screenVideo.srcObject = new MediaStream([screenTrack]);
  ekranRejimi(true);
  wsSend({ type: 'screen', on: true });
}

async function ekranniTugat() {
  if (!screenTrack) return;
  const t = screenTrack;
  screenTrack = null;
  t.onended = null;
  t.stop();
  const kamera = localStream && localStream.getVideoTracks()[0];
  await videoniAlmashtir(kamera || null);
  ekranRejimi(false);
  wsSend({ type: 'screen', on: false });
}

/** Ish maydonida ekran ko'rinishi: hujjat yashirinadi, ekran va uning chizish qatlami chiqadi */
function ekranRejimi(on) {
  EKRAN = on;
  strokes = strokes.filter((x) => x.page !== 'screen');
  el.screenbox.hidden = !on;
  el.pdfbox.hidden = on || !pdfDoc;
  el.empty.hidden = on || Boolean(pdfDoc);
  el.pagePill.hidden = on || !pdfDoc || pdfDoc.numPages < 2;
  el.btnScreen.classList.toggle('jonli', on && IS_TEACHER);
  el.btnScreen.setAttribute('aria-pressed', String(on && IS_TEACHER));
  el.btnScreen.title = on ? 'Ekran ulashishni to‘xtatish' : 'Ekranni ulashish';
  $('#screenTag').textContent = IS_TEACHER ? '🔴 Ekraningiz ulashilmoqda' : '🖥️ Ustoz ekrani';
  if (!IS_TEACHER) {
    if (on) el.screenVideo.srcObject = faqatVideo();
    else el.screenVideo.srcObject = null;
    // Ustoz plitkasida ham ekran turadi — ikki marta ko'rsatmaymiz
    el.remotePh.hidden = !on;
    el.remotePh.classList.toggle('ekran', on);
    if (on) el.remotePh.innerHTML = '<b>🖥️ Ustoz ekranini ko‘rsatyapti</b>';
    else if (pc && pc.connectionState === 'connected') el.remotePh.hidden = true;
  }
  if (on) requestAnimationFrame(ekranOlcham);
  redraw();
}

/** Chizish qatlami videoning ko'rinib turgan o'lchamiga teng bo'lsin */
function ekranOlcham() {
  const v = el.screenVideo, c = el.screenInk;
  const w = v.clientWidth, h = v.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.style.width = w + 'px';
  c.style.height = h + 'px';
  c.width = Math.floor(w * dpr);
  c.height = Math.floor(h * dpr);
  redraw();
}
el.screenVideo.addEventListener('loadedmetadata', ekranOlcham);
el.screenVideo.addEventListener('resize', ekranOlcham);
el.screenVideo.play && el.screenVideo.addEventListener('canplay', () => el.screenVideo.play().catch(() => {}));

el.btnScreen.onclick = () => {
  if (!IS_TEACHER) return;
  if (screenTrack) ekranniTugat(); else ekranniBoshla();
};
el.btnStudentDraw.onclick = () => {
  if (!IS_TEACHER) return;
  STUDENT_DRAW = !STUDENT_DRAW;
  chizishHolati();
  wsSend({ type: 'student-draw', on: STUDENT_DRAW });
  toast(STUDENT_DRAW ? 'O‘quvchi endi chiza oladi' : 'O‘quvchining chizishi yopildi');
};

// --- Dars oxirida o'quvchining bahosi ---
let TANLANGAN_BAHO = 0;

function bahoOynasi() {
  const fon = document.getElementById('bahoFon');
  const yulduzlar = document.getElementById('yulduzlar');
  const yubor = document.getElementById('bahoYubor');
  fon.hidden = false;

  const sarlavha = document.getElementById('bahoSarlavha');
  const tavsif = document.getElementById('bahoTavsif');
  const izoh = document.getElementById('bahoIzoh');

  // 4 va undan past baho — nimani yaxshilash kerakligini so'raymiz.
  // Quruq yulduzcha sababni aytmaydi, izoh esa aytadi.
  const savolniMoslash = () => {
    const past = TANLANGAN_BAHO > 0 && TANLANGAN_BAHO <= 4;
    sarlavha.textContent = past ? 'Nimani yaxshilashimiz kerak?' : 'Dars qanday o\u2018tdi?';
    tavsif.textContent = past
      ? 'Fikringiz aynan nimani tuzatish kerakligini ko\u2018rsatadi'
      : 'Bahoyingiz ustozga yaxshilanishga yordam beradi';
    izoh.placeholder = past
      ? 'Nima yoqmadi yoki nima yetishmadi?'
      : 'Qisqacha fikringiz (ixtiyoriy)';
    izoh.classList.toggle('sorab-turibdi', past);
  };

  yulduzlar.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      TANLANGAN_BAHO = Number(b.dataset.y);
      yulduzlar.querySelectorAll('button').forEach((x) => {
        x.classList.toggle('tanlangan', Number(x.dataset.y) <= TANLANGAN_BAHO);
      });
      yubor.disabled = false;
      savolniMoslash();
      if (TANLANGAN_BAHO <= 4) izoh.focus();
    };
  });

  const chiq = () => { location.href = '/band.html'; };
  document.getElementById('bahoOtkaz').onclick = chiq;
  yubor.onclick = async () => {
    yubor.disabled = true;
    yubor.textContent = 'Yuborilmoqda…';
    try {
      await fetch(AKTIV_TOKEN ? `/api/baho?t=${encodeURIComponent(AKTIV_TOKEN)}` : '/api/baho', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: TANLANGAN_BAHO,
          comment: izoh.value,
        }),
      });
    } catch { /* baho ketmasa ham dars tugagan — o'quvchini ushlab turmaymiz */ }
    chiq();
  };
}

/** Ustoz uchun: vaqtincha chiqish (dars davom etadi) yoki darsni yakunlash */
function ustozChiqishOynasi() {
  return new Promise((resolve) => {
    const fon = document.createElement('div');
    fon.className = 'baho-fon';
    fon.innerHTML = `<div class="baho-oyna" style="max-width:360px">
      <h2>Darsdan chiqish</h2>
      <p>Darsni yakunlasangiz, o‘quvchi ham chiqadi va baho so‘raladi.</p>
      <div class="baho-amallar" style="flex-direction:column;gap:8px">
        <button class="baho-yubor" data-j="yakun">Darsni yakunlash</button>
        <button class="baho-otkaz" data-j="vaqtincha">Vaqtincha chiqish (qaytib kiraman)</button>
        <button class="baho-otkaz" data-j="bekor">Bekor qilish</button>
      </div></div>`;
    fon.addEventListener('click', (e) => {
      const j = e.target.dataset && e.target.dataset.j;
      if (!j && e.target !== fon) return;
      fon.remove();
      resolve(j || 'bekor');
    });
    document.body.appendChild(fon);
  });
}

el.btnLeave.onclick = async () => {
  if (IS_TEACHER) {
    const tanlov = await ustozChiqishOynasi();
    if (tanlov === 'bekor') return;
    if (tanlov === 'vaqtincha') {
      // Dars yopilmaydi: o'quvchi kutib turadi, ustoz jadvaldan qaytib kiradi
      DARS_TUGADI = true;
      try { ws && ws.close(); } catch {}
      teardownPeer();
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      location.href = '/jadval.html';
      return;
    }
  } else if (!confirm('Darsdan chiqasizmi?')) {
    return;
  }

  DARS_TUGADI = true;

  if (IS_TEACHER) {
    // O'quvchida baho oynasi o'zi ochilsin — u chiqish tugmasini bosmasligi mumkin
    wsSend({ type: 'dars-tugadi' });
    // Xabar ketib ulgursin, keyin yopamiz
    setTimeout(() => {
      try { ws && ws.close(); } catch {}
      teardownPeer();
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      location.href = '/jadval.html';
    }, 200);
    return;
  }

  try { ws && ws.close(); } catch {}
  teardownPeer();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  bahoOynasi();
};

// ================= 3. Hujjat (PDF yoki rasm) =================
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let pdfDoc = null, pageNum = 1, rendering = false, pendingPage = null, currentDocUrl = null;

const RASM_KENGAYTMA = /\.(png|jpe?g|webp|gif)$/i;

/**
 * Rasmni PDF hujjati kabi ko'rsatadi: bitta sahifa, xuddi shu interfeys.
 * Shunda renderPage/gotoPage va ink qatlami o'zgarmaydi.
 */
async function rasmHujjati(url) {
  const img = new Image();
  await new Promise((ok, xato) => {
    img.onload = ok;
    img.onerror = () => xato(new Error('rasm ochilmadi'));
    img.src = url;
  });
  return {
    numPages: 1,
    getPage: async () => ({
      getViewport: ({ scale }) => ({
        width: img.naturalWidth * scale,
        height: img.naturalHeight * scale,
      }),
      render: ({ canvasContext, viewport }) => ({
        promise: Promise.resolve().then(() => {
          canvasContext.drawImage(img, 0, 0, viewport.width, viewport.height);
        }),
      }),
    }),
  };
}

async function loadDoc(url, name, page = 1) {
  if (!url || url === currentDocUrl) { if (pdfDoc) gotoPage(page, false); return; }
  currentDocUrl = url;
  setStatus('Hujjat yuklanmoqda…');
  try {
    pdfDoc = RASM_KENGAYTMA.test(url)
      ? await rasmHujjati(url)
      : await pdfjsLib.getDocument(url).promise;
  } catch (e) {
    console.warn(e); toast('Hujjat ochilmadi'); currentDocUrl = null; return;
  }
  el.empty.hidden = true;
  el.pdfbox.hidden = EKRAN;
  // Rasmda sahifa yo'q — tugmalarni ko'rsatmaymiz
  el.pagePill.hidden = EKRAN || pdfDoc.numPages < 2;
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
  if (ZOOM > 1.02) zoomQoy(1);
  applyScroll(0);
  if (broadcast && IS_TEACHER) wsSend({ type: 'page', page: pageNum });
}

el.btnPrev.onclick = () => { if (IS_TEACHER) gotoPage(pageNum - 1); };
el.btnNext.onclick = () => { if (IS_TEACHER) gotoPage(pageNum + 1); };

// Ustoz hujjat yuklaydi (PDF yoki rasm)
el.fileInput.onchange = async () => {
  const f = el.fileInput.files[0];
  if (!f) return;
  if (f.size > 25 * 1024 * 1024) return toast('Fayl 25MB dan katta');
  setStatus('Yuklanmoqda…');
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await fetch(AKTIV_TOKEN ? `/api/upload?t=${encodeURIComponent(AKTIV_TOKEN)}` : '/api/upload',
                          { method: 'POST', body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'upload');
    strokes = []; liveRemote = null;
    await loadDoc(j.url, j.name);
    wsSend({ type: 'doc', url: j.url, name: j.name });
  } catch (e) {
    console.warn(e);
    // Serverdan kelgan aniq sababni ko'rsatamiz: "Yuklab bo'lmadi" ustozga
    // nima qilishni aytmaydi
    toast(e.message && e.message !== 'upload' ? e.message : 'Yuklab bo‘lmadi');
  }
  el.fileInput.value = '';
};

// --- Scroll sinxronizatsiyasi (ustoz suradi, o'quvchida ham suriladi) ---
let scrollFromPeer = false, scrollSent = 0, scrollTimer = null;

// Hujjat balandligiga nisbatan o'lchaymiz — ikkala ekranda ham bir xil joy chiqadi
function docHeight() { return el.pdfbox.clientHeight || el.board.scrollHeight || 1; }

function applyScroll(frac) {
  oxirgiScroll = frac;
  if (!IS_TEACHER && ZOOM > 1.02) return;   // o'quvchi o'zi kattalashtirgan — tinch qo'yamiz
  scrollFromPeer = true;
  el.board.scrollTop = frac * docHeight();
  requestAnimationFrame(() => { scrollFromPeer = false; });
}

{
  el.board.addEventListener('scroll', () => {
    if (!IS_TEACHER || scrollFromPeer || !pdfDoc) return;
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
  resizeTimer = setTimeout(() => { if (pdfDoc) renderPage(pageNum); if (EKRAN) ekranOlcham(); }, 180);
});

// ================= Kattalashtirish (ikki barmoq) =================
// O'quvchi hujjatni kattalashtirib ko'rishi tabiiy ehtiyoj. Kattalashtirilganda
// ustozning scroll'iga ergashishni to'xtatamiz — aks holda ekran tortishib turadi.
let ZOOM = 1;
const ZOOM_MIN = 1, ZOOM_MAX = 4;
const barmoqlar = new Map();
let pinchBoshDist = 0, pinchBoshZoom = 1;
let oxirgiScroll = 0;

function zoomQoy(yangi, markaz) {
  const eski = ZOOM;
  ZOOM = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, yangi));
  if (Math.abs(ZOOM - eski) < 0.001) return;

  el.pdfbox.style.zoom = ZOOM;

  // Barmoqlar orasidagi nuqta joyida qolsin
  if (markaz) {
    const k = ZOOM / eski;
    el.board.scrollLeft = (el.board.scrollLeft + markaz.x) * k - markaz.x;
    el.board.scrollTop = (el.board.scrollTop + markaz.y) * k - markaz.y;
  }

  el.zoomBelgi.hidden = ZOOM <= 1.02;
  el.zoomFoiz.textContent = `${Math.round(ZOOM * 100)}%`;

  // 1x ga qaytganda ustoz qayerda bo'lsa, o'sha yerga qaytamiz
  if (ZOOM <= 1.02 && !IS_TEACHER && oxirgiScroll) applyScroll(oxirgiScroll);
}

function zoomTiklash() {
  zoomQoy(1);
  if (!IS_TEACHER && oxirgiScroll) applyScroll(oxirgiScroll);
}
el.zoomTiklash.onclick = zoomTiklash;

el.board.addEventListener('pointerdown', (e) => {
  barmoqlar.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (barmoqlar.size === 2) {
    const [a, b] = [...barmoqlar.values()];
    pinchBoshDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchBoshZoom = ZOOM;
    bekorQilInk();          // ikki barmoq boshlansa chizishni to'xtatamiz
  }
}, { passive: true });

el.board.addEventListener('pointermove', (e) => {
  if (!barmoqlar.has(e.pointerId)) return;
  barmoqlar.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (barmoqlar.size !== 2 || !pinchBoshDist) return;

  const [a, b] = [...barmoqlar.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const r = el.board.getBoundingClientRect();
  zoomQoy(pinchBoshZoom * (dist / pinchBoshDist), {
    x: (a.x + b.x) / 2 - r.left,
    y: (a.y + b.y) / 2 - r.top,
  });
}, { passive: true });

const barmoqTushdi = (e) => {
  barmoqlar.delete(e.pointerId);
  if (barmoqlar.size < 2) pinchBoshDist = 0;
};
el.board.addEventListener('pointerup', barmoqTushdi, { passive: true });
el.board.addEventListener('pointercancel', barmoqTushdi, { passive: true });

// Ikki marta tez bosish — tiklaydi
let oxirgiTegish = 0;
el.board.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse') return;
  const now = performance.now();
  if (now - oxirgiTegish < 320 && barmoqlar.size === 0) zoomTiklash();
  oxirgiTegish = now;
}, { passive: true });

// Kompyuterda: Ctrl/Cmd + g'ildirak
el.board.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const r = el.board.getBoundingClientRect();
  zoomQoy(ZOOM * (e.deltaY < 0 ? 1.12 : 1 / 1.12), { x: e.clientX - r.left, y: e.clientY - r.top });
}, { passive: false });

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
function rangQoy(c) {
  color = c;
  document.querySelectorAll('.sw').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.color === c)));
}
document.querySelectorAll('.sw').forEach((b) => { b.onclick = () => rangQoy(b.dataset.color); });

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
  // Hujjat sahifasi va ekran — ikki alohida qatlam, har biri o'z chiziqlarini chizadi
  qatlamniChiz(el.inkCanvas, pageNum);
  if (EKRAN) qatlamniChiz(el.screenInk, 'screen');
}

function qatlamniChiz(c, page) {
  if (!c.width) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const W = c.width, H = c.height;
  for (const s of strokes) if (s.page === page) drawStroke(ctx, s, W, H);
  if (liveRemote && liveRemote.page === page) drawStroke(ctx, liveRemote, W, H);
  if (liveLocal && liveLocal.page === page) drawStroke(ctx, liveLocal, W, H);
}

/** Har kim faqat o'zining oxirgi chizig'ini qaytaradi */
function oxirgisiniOchir(by) {
  for (let i = strokes.length - 1; i >= 0; i--) {
    if ((strokes[i].by || 'teacher') === by) { strokes.splice(i, 1); return; }
  }
}

let bekorQilInk = () => {};   // chizish bo'limi uni to'ldiradi

// --- Qo'l harakati: hujjat va ekran qatlamlari ---
// Rol asinxron aniqlanadi, shuning uchun hodisalar doim ulanadi va har birida
// ruxsat tekshiriladi: ustoz doim, o'quvchi faqat ustoz ruxsat bergan bo'lsa.
let drawing = false;
function qatlamgaUlash(c, sahifa, tayyor) {
  let lastSent = 0, strokeStart = 0;

  const pos = (e) => {
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  c.addEventListener('pointerdown', (e) => {
    if (!chizaOladi() || !tayyor()) return;
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    drawing = true;
    c.setPointerCapture(e.pointerId);
    strokeStart = performance.now();
    liveLocal = { page: sahifa(), tool, color, w: WIDTH[tool], pts: [pos(e)], by: ROLE };
    redraw();
  });

  c.addEventListener('pointermove', (e) => {
    if (!drawing || !liveLocal || liveLocal.page !== sahifa()) return;
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
}

qatlamgaUlash(el.inkCanvas, () => pageNum, () => Boolean(pdfDoc) && !EKRAN);
qatlamgaUlash(el.screenInk, () => 'screen', () => EKRAN);

// Ikki barmoq bilan kattalashtirish boshlansa, yarim chizilgan chiziqni tashlaymiz
bekorQilInk = () => {
  if (!drawing) return;
  drawing = false;
  liveLocal = null;
  redraw();
};

el.btnUndo.onclick = () => {
  if (!chizaOladi()) return;
  oxirgisiniOchir(ROLE); redraw(); wsSend({ type: 'undo' });
};
el.btnClear.onclick = () => {
  if (!IS_TEACHER) return;
  const page = EKRAN ? 'screen' : pageNum;
  if (!confirm(EKRAN ? 'Ekrandagi belgilarni o‘chirasizmi?' : 'Shu sahifadagi belgilarni o‘chirasizmi?')) return;
  strokes = strokes.filter((s) => s.page !== page);
  redraw();
  wsSend({ type: 'clear', page });
};

// ================= 5. Ishga tushirish =================
let AKTIV_TOKEN = TOKEN;

(async function start() {
  try {
    AKTIV_TOKEN = await tokenTop();
  } catch { AKTIV_TOKEN = null; }

  if (!AKTIV_TOKEN && !ROOM) {
    // Kurs havolasidan kelgan o'quvchida hisob yo'q — login so'ramaymiz
    if (location.pathname.startsWith('/dars/')) {
      el.remotePh.hidden = false;
      el.remotePh.innerHTML = '<b>Dars xonasi topilmadi</b>'
        + '<span>Havola eskirgan bo\u2018lishi mumkin. Ustozdan yangi havola so\u2018rang.</span>';
      setStatus('Xona topilmadi');
      return;
    }
    // Ustoz — login sahifasiga
    // Mentor ilovasi ichida login so'ralmaydi — ilovadan yangi havola so'raymiz
    let ilova = Boolean(window.MyTeacher?.postMessage || window.flutter_inappwebview);
    try { ilova = ilova || sessionStorage.getItem('ll_ilova') === '1'; } catch { /* yo'q */ }
    if (ilova) {
      const xabar = { turi: 'tokenEskirdi', sahifa: location.pathname };
      try {
        if (window.MyTeacher?.postMessage) window.MyTeacher.postMessage(JSON.stringify(xabar));
        else window.flutter_inappwebview?.callHandler?.('mentorAction', xabar);
      } catch { /* ko'prik yo'q */ }
      el.remotePh.hidden = false;
      el.remotePh.innerHTML = '<b>Dars havolasi eskirgan</b>'
        + '<span>Ilovada darsni qayta oching.</span>';
      setStatus('Havola eskirgan');
      return;
    }
    location.replace('/login.html?keyin=' + encodeURIComponent(location.pathname + location.search));
    return;
  }

  if (AKTIV_TOKEN) { rolniQoy(peekToken(AKTIV_TOKEN)); interfeysniSozla(); }

  await initMedia();
  connect();
})();

window.addEventListener('beforeunload', () => { try { ws && ws.close(); } catch {} });
// Telefonda sahifa yopilganda "beforeunload" kelmasligi mumkin — serverga darhol bildiramiz
window.addEventListener('pagehide', () => { try { ws && ws.close(); } catch {} });

// Telefon orqa fondan qaytdi (qo'ng'iroq, boshqa ilova) — ulanish uzilgan bo'lsa darhol qayta ulanamiz
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || DARS_TUGADI) return;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    retry = 0;
    setStatus('Qayta ulanmoqda…');
    connect();
  }
});

// ================= Dars daftari =================
// Ustoz slayd ostida yozadi (eslatma, yangi so'zlar, uyga vazifa), o'quvchi jonli ko'radi.
// Server uni API ga saqlaydi — o'quvchi darsdan keyin Kurslar bo'limida qayta o'qiydi.
const DAFTAR = { matn: '', sozlar: '', vazifa: '' };
let daftarTab = 'matn', daftarTaymer = null;
const dEl = {
  box: document.getElementById('daftar'),
  matn: document.getElementById('daftarMatn'),
  kor: document.getElementById('daftarKor'),
  holat: document.getElementById('daftarHolat'),
  yig: document.getElementById('daftarYig'),
  tablar: [...document.querySelectorAll('.daftar-tab')],
};
const DAFTAR_NAMUNA = {
  matn: 'Masalan: Present Simple — he/she/it + s\nI work → She works\nXato: She go ❌ → She goes ✅',
  sozlar: 'Har qatorga bitta so‘z:\napple — olma\nto borrow — qarzga olmoq',
  vazifa: 'Masalan: 47-bet, 3-mashq. 5 ta gap tuzing (Present Simple).',
};
const DAFTAR_BOSH = {
  matn: 'Ustoz bu yerga dars eslatmalarini yozadi.',
  sozlar: 'Yangi so‘zlar shu yerda paydo bo‘ladi.',
  vazifa: 'Uyga vazifa shu yerda paydo bo‘ladi.',
};
const dEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function daftarJoy() {
  document.documentElement.style.setProperty('--daftar-joy', dEl.box.offsetHeight + 'px');
}

function daftarYigish(yig) {
  dEl.box.classList.toggle('yigiq', yig);
  dEl.yig.setAttribute('aria-expanded', String(!yig));
  setTimeout(() => {
    daftarJoy();
    if (pdfDoc) renderPage(pageNum);
    if (EKRAN) ekranOlcham();
  }, 220);
}

function daftarKorsat() {
  dEl.tablar.forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.d === daftarTab));
    if (b.dataset.d === daftarTab) b.classList.remove('yangi');
  });
  if (IS_TEACHER) {
    if (dEl.matn.value !== DAFTAR[daftarTab]) dEl.matn.value = DAFTAR[daftarTab];
    dEl.matn.placeholder = DAFTAR_NAMUNA[daftarTab];
    return;
  }
  const t = DAFTAR[daftarTab].trim();
  if (!t) { dEl.kor.innerHTML = `<span class="bosh">${DAFTAR_BOSH[daftarTab]}</span>`; return; }
  if (daftarTab === 'sozlar') {
    dEl.kor.innerHTML = t.split('\n').filter((q) => q.trim()).map((q) => {
      const [soz, ...qolgan] = q.split(/\s[—–-]\s|\s*[—–=:]\s*/);
      return `<div class="soz"><b>${dEsc(soz.trim())}</b><span>${dEsc(qolgan.join(' — ').trim())}</span></div>`;
    }).join('');
  } else {
    dEl.kor.textContent = t;
  }
  dEl.kor.scrollTop = dEl.kor.scrollHeight;
}

// Serverdan kelgan holat: kirganda (boshlang'ich) yoki ustoz yozganda
function daftarKeldi(notes, tab, boshlangich = false) {
  if (!notes) return;
  const eski = { ...DAFTAR };
  for (const k of ['matn', 'sozlar', 'vazifa']) DAFTAR[k] = typeof notes[k] === 'string' ? notes[k] : '';
  const bor = Object.values(DAFTAR).some((v) => v.trim());
  if (!IS_TEACHER) {
    if (tab && tab !== daftarTab && DAFTAR[tab] !== eski[tab]) {
      // Ustoz boshqa bo'limga yozyapti — o'quvchini o'sha yerga olib o'tamiz
      daftarTab = tab;
    }
    for (const k of ['matn', 'sozlar', 'vazifa']) {
      const b = dEl.tablar.find((x) => x.dataset.d === k);
      if (k !== daftarTab && DAFTAR[k] !== eski[k] && DAFTAR[k].trim()) b.classList.add('yangi');
    }
    if (boshlangich) daftarYigish(!bor);
    else if (bor && dEl.box.classList.contains('yigiq')) daftarYigish(false);
    dEl.holat.textContent = bor ? '✍️ Ustoz eslatmalari' : '';
  } else if (boshlangich && bor) {
    dEl.holat.textContent = '✓ saqlangan';
  }
  daftarKorsat();
}

function daftarYubor() {
  clearTimeout(daftarTaymer);
  daftarTaymer = null;
  wsSend({ type: 'notes', notes: { ...DAFTAR }, tab: daftarTab });
  dEl.holat.textContent = '✓ o‘quvchiga ko‘rinmoqda';
}

dEl.tablar.forEach((b) => b.addEventListener('click', () => {
  if (daftarTaymer) daftarYubor();
  daftarTab = b.dataset.d;
  if (dEl.box.classList.contains('yigiq')) daftarYigish(false);
  daftarKorsat();
  if (IS_TEACHER) dEl.matn.focus();
}));
dEl.yig.addEventListener('click', () => daftarYigish(!dEl.box.classList.contains('yigiq')));
dEl.matn.addEventListener('input', () => {
  DAFTAR[daftarTab] = dEl.matn.value.slice(0, 10000);
  dEl.holat.textContent = 'yozilmoqda…';
  clearTimeout(daftarTaymer);
  daftarTaymer = setTimeout(daftarYubor, 400);
});
dEl.matn.addEventListener('blur', () => { if (daftarTaymer) daftarYubor(); });
// Ustoz qo'lida klaviatura yozganda chizish/sahifa tugmalari ishga tushmasin
dEl.matn.addEventListener('keydown', (e) => e.stopPropagation());
daftarKorsat();
requestAnimationFrame(daftarJoy);
window.addEventListener('resize', daftarJoy);
