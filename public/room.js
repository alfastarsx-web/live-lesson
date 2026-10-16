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

// Ustoz brauzerdan (ilovasiz) dars o'tayotganda ham adminda "onlayn" ko'rinsin: dars xonasi ham
// mentor sessiyasiga signal beradi (aks holda 3 daqiqada oflayn bo'lib qolardi). Ilovada onlayn
// holatni ilovaning o'zi ushlaydi. Ekran ulashilganda sahifa fonda bo'lsa ham dars davom etadi.
setInterval(() => {
  if (!IS_TEACHER || CLAIMS?.yordam || window.flutter_inappwebview || window.MyTeacher?.postMessage) return;
  fetch('/api/mentor-session/heartbeat', { method: 'POST' }).catch(() => {});
}, 60_000);

const $ = (s) => document.querySelector(s);
const el = {
  stage: $('#stage'), status: $('#status'),
  localVideo: $('#localVideo'), remoteVideo: $('#remoteVideo'), remoteAudio: $('#remoteAudio'),
  localPh: $('#localPh'), remotePh: $('#remotePh'),
  localTag: $('#localTag'), remoteTag: $('#remoteTag'),
  btnMic: $('#btnMic'), btnCam: $('#btnCam'), btnLeave: $('#btnLeave'),
  btnChat: $('#btnChat'), chatNuqta: $('#chatNuqta'),
  toolbar: $('#toolbar'), fileInput: $('#fileInput'),
  btnUndo: $('#btnUndo'), btnClear: $('#btnClear'),
  btnPrev: $('#btnPrev'), btnNext: $('#btnNext'), pageNo: $('#pageNo'), pagePill: $('#pagePill'),
  board: $('#board'), empty: $('#empty'), emptyHint: $('#emptyHint'),
  pdfbox: $('#pdfbox'), pdfCanvas: $('#pdfCanvas'), inkCanvas: $('#inkCanvas'),
  zoomBelgi: $('#zoomBelgi'), zoomFoiz: $('#zoomFoiz'), zoomTiklash: $('#zoomTiklash'),
  toast: $('#toast'), peerMedia: $('#peerMedia'), ozMedia: $('#ozMedia'),
  btnScreen: $('#btnScreen'), btnStudentDraw: $('#btnStudentDraw'),
  screenbox: $('#screenbox'), screenVideo: $('#screenVideo'), screenInk: $('#screenInk'),
};

// Ekran ulashish rejimi (ish maydonida ustoz ekrani) va o'quvchiga chizish ruxsati
let EKRAN = false, STUDENT_DRAW = false;
// Telefon brauzerlari ekranni ulasha olmaydi — tugmani faqat imkon bo'lsa ko'rsatamiz
const TELEFON = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const IS_MOBILE_DEVICE = TELEFON || (window.matchMedia && window.matchMedia('(pointer: coarse) and (max-width: 1024px)').matches);
const EKRAN_MUMKIN = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

function orientatsiyaYangila() {
  const landscape = window.innerWidth > window.innerHeight;
  document.body.classList.toggle('landscape', landscape);
  document.body.classList.toggle('portrait', !landscape);
}
if (IS_MOBILE_DEVICE) {
  document.body.classList.add('is-mobile');
}
orientatsiyaYangila();
window.addEventListener('resize', orientatsiyaYangila);
window.addEventListener('orientationchange', () => setTimeout(orientatsiyaYangila, 120));

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

// Ustozga: dars qancha davom etayotgani — kichik, ko'zga tashlanmaydigan taymer (o'quvchi bilan
// birinchi uchrashgandan beri; vaqtni server beradi, qayta ulanishda ham o'zgarmaydi)
let DARS_BOSHI = null;
const taymerEl = document.getElementById('darsTaymer');
function darsBoshiniQoy(otganMs) {
  if (!IS_TEACHER || !taymerEl || otganMs == null) return;
  DARS_BOSHI = Date.now() - otganMs;
  taymerChiz();
}
function taymerChiz() {
  if (!DARS_BOSHI || !taymerEl) return;
  const s = Math.max(0, Math.floor((Date.now() - DARS_BOSHI) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), c = s % 60;
  const mm = String(m).padStart(2, '0'), cc = String(c).padStart(2, '0');
  taymerEl.textContent = `⏱ ${h ? `${h}:${mm}` : m}:${cc}`;
  taymerEl.hidden = false;
}
setInterval(taymerChiz, 1000);

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
      darsBoshiniQoy(m.darsOtganMs);
      break;

    case 'dars-vaqti': darsBoshiniQoy(m.otganMs); break;

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
      if (m.sabab === 'ustoz-keldi') {
        setStatus('Ustoz kirdi');
        el.remotePh.hidden = false;
        el.remotePh.innerHTML = '<b>✅ Ustoz darsga kirdi</b><span>Texnik tekshiruv tugadi — dars ustozga o‘tdi. Rahmat!</span>';
        break;
      }
      setStatus('Dars boshqa oynada ochildi');
      el.remotePh.hidden = false;
      el.remotePh.innerHTML = '<b>Dars boshqa oynada ochildi</b><span>Shu dars boshqa qurilma yoki oynada davom etyapti.</span>';
      break;

    case 'peer-leave':
      if (m.id && peerId && m.id !== peerId) break; // eski ulanish — joriy suhbatdoshga tegishli emas
      peerId = null;
      teardownPeer();
      peerMediaChiz(null);
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
    case 'media':      peerMediaChiz(m); break;
    case 'chat':       chatQosh(m); break;
  }
}

function applyState(state) {
  if (!state) return;
  strokes = state.strokes || [];
  STUDENT_DRAW = Boolean(state.studentDraw);
  chizishHolati();
  if (!IS_TEACHER && state.screen) ekranRejimi(true);
  daftarKeldi(state.notes, null, true);
  if (Array.isArray(state.messages)) chatTikla(state.messages);
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

let pc = null, localStream = null, pendingIce = [], remoteStream = null, PEER_CAM = null;

// Telefonda kamera yengilroq: 720p kodlash telefonni qizdiradi va batareyani tez yeydi,
// kichik plitkada esa farqi ko'rinmaydi.
// Kompyuterlarda esa facingMode ko'rsatilmaydi, chunki tashqi USB veb-kameralar va
// virtual kameralar (OBS, ManyCam va h.k.) facingMode talab qilinsa OverconstrainedError beradi.
const KAMERA = TELEFON
  ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 }, facingMode: 'user' }
  : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };

const AUDIO_SOZLAMALARI = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// ===== Kamera/mikrofon holati: suhbatdoshga ko'rinadi, o'zida — yo'qolmaydigan ogohlantirish =====
// Holat: on | off (o'zi o'chirgan) | ruxsat (ruxsat berilmagan) | band (boshqa ilovada) | yoq (topilmadi)
const mediaXato = { mic: null, cam: null };
function xatoTuri(err) {
  const n = (err && err.name) || '';
  if (/NotAllowed|PermissionDenied|Security/.test(n)) return 'ruxsat';
  if (/NotReadable|TrackStart|Abort/.test(n)) return 'band';
  return 'yoq';
}
function trekHolati(t, xato) {
  if (t && t.readyState !== 'ended') return t.enabled ? 'on' : 'off';
  return xato || 'yoq';
}
function mediaHolati() {
  return {
    mic: trekHolati(localStream && localStream.getAudioTracks()[0], mediaXato.mic),
    cam: trekHolati(localStream && localStream.getVideoTracks()[0], mediaXato.cam),
  };
}
const ILOVADA = Boolean(window.flutter_inappwebview);
const MUAMMO = { ruxsat: 1, band: 1, yoq: 1 };

/** Suhbatdoshga holatni yuboradi va o'zida ogohlantirishni yangilaydi */
function mediaYubor() {
  const h = mediaHolati();
  wsSend({ type: 'media', mic: h.mic, cam: h.cam });
  ozMediaChiz(h);
}

let OZ_MEDIA_YOPILDI = false;
/** O'zida: mikrofon/kamera ishlamasa — yo'riqnoma va chat tugmasi */
function ozMediaChiz(h, majburiy = false) {
  if (OZ_MEDIA_YOPILDI && !majburiy) return;
  const qism = [];
  if (MUAMMO[h.mic]) qism.push(['mic', h.mic]);
  if (h.cam === 'ruxsat' || h.cam === 'band') qism.push(['cam', h.cam]);
  if (!qism.length) { el.ozMedia.hidden = true; return; }
  const nom = { mic: 'Mikrofon', cam: 'Kamera' };
  const sabab = (k, v) => v === 'ruxsat'
    ? `${nom[k]}ga ruxsat berilmagan`
    : v === 'band' ? `${nom[k]} boshqa ilovada band (Telegram, Zoom…)` : `${nom[k]} topilmadi`;
  const ruxsatYoq = qism.some(([, v]) => v === 'ruxsat');
  const yoriq = !ruxsatYoq ? '' : ILOVADA
    ? '«Sozlamalarni ochish» → Ruxsat berish.'
    : TELEFON
      ? '🔒 belgisi → Ruxsat berish.'
      : 'Brauzer 🔒 belgisidan ruxsat bering.';
  el.ozMedia.innerHTML =
    '<button type="button" class="oz-media-yop" data-oz="yop" title="Yopish" aria-label="Yopish">✕</button>'
    + `<b>${MUAMMO[h.mic] ? '🔇 Ustoz sizni eshitmayapti' : '📷 Ustoz sizni ko‘rmayapti'}</b>`
    + `<span>${qism.map(([k, v]) => sabab(k, v)).join('. ')}. ${yoriq}</span>`
    + '<div class="oz-media-tugmalar">'
    + (ILOVADA && ruxsatYoq ? '<button type="button" data-oz="sozlama">⚙️ Sozlamalar</button>' : '')
    + '<button type="button" data-oz="qayta">🔄 Qayta urinish</button>'
    + '<button type="button" data-oz="chat">💬 Chat orqali yozish</button></div>';
  el.ozMedia.hidden = false;
}

/** Suhbatdoshning kamera/mikrofon holati — videosi ustida */
function peerMediaChiz(m) {
  const kim = IS_TEACHER ? 'O‘quvchi' : 'Ustoz';
  const mic = {
    ruxsat: `🔇 ${kim} mikrofonga ruxsat bermagan — telefon sozlamalaridan yoqishini ayting`,
    band: `🔇 ${kim}ning mikrofoni boshqa ilovada band`,
    yoq: `🔇 ${kim}da mikrofon ishlamayapti`,
    off: `🔇 ${kim} mikrofonini o‘chirgan`,
  }[m && m.mic];
  const cam = {
    ruxsat: `📷 ${kim} kameraga ruxsat bermagan`,
    band: `📷 ${kim}ning kamerasi boshqa ilovada band (Telegram/Zoom)`,
    yoq: `📷 ${kim}da kamera topilmadi`,
  }[m && m.cam];
  const qator = [];
  if (mic) qator.push(`<span class="${MUAMMO[m.mic] ? 'xavf' : ''}">${mic}</span>`);
  if (cam) qator.push(`<span>${cam}</span>`);
  el.peerMedia.innerHTML = qator.join('');
  el.peerMedia.hidden = !qator.length;
  PEER_CAM = m ? m.cam : null;
  remoteKamChiz();
}

/** Suhbatdosh kamerasi o'chiq bo'lsa — qora video o'rniga plitkada "kamerasi o'chiq" */
function remoteKamChiz() {
  if (!remoteStream || !pc || pc.connectionState === 'closed') return;
  if (EKRAN && !IS_TEACHER) return; // plitkada "Ustoz ekranini ko'rsatyapti" turadi
  const off = Boolean(PEER_CAM) && PEER_CAM !== 'on';
  el.remoteVideo.classList.toggle('off', off);
  el.remotePh.hidden = !off;
  if (off) el.remotePh.innerHTML = `<b>📷 ${IS_TEACHER ? 'O‘quvchi' : 'Ustoz'} kamerasi o‘chiq</b>`;
}

/** Kamera xatolarini foydalanuvchiga tushunarli tarzda ko'rsatish */
function kameraXatosiniKorsat(err) {
  if (!err) return;
  const name = err.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    if (TELEFON) {
      toast('Kameraga ruxsat berilmagan. Telefon Sozlamalari -> Ilovalar -> Mentor -> Ruxsatlar orqali yoqing', 7000);
    } else {
      toast('Kameraga ruxsat berilmagan. Brauzer qidiruv qatoridagi qulf 🔒 belgisidan ruxsat bering', 7000);
    }
  } else if (name === 'NotReadableError' || name === 'TrackStartError') {
    toast('Kamera boshqa dastur (Telegram/Zoom) tomonidan band qilingan. Uni yopib qayta urinib ko‘ring', 7000);
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    toast('Kamera qurilmasi topilmadi. Qurilma ulanganini tekshiring', 5000);
  } else if (name === 'OverconstrainedError') {
    toast('Kamera ruxsati berildi, ammo kiritilgan parametrlar mos kelmadi', 5000);
  } else if (name === 'NotSupportedError') {
    toast('Brauzeringizda video/audio qo‘llab-quvvatlanmaydi yoki sayt HTTPS emas', 6000);
  } else {
    toast('Kamerani yoqib bo‘lmadi: ' + (err.message || name || 'xatolik yuz berdi'), 5000);
  }
}

/** Mikrofon xatolarini tushunarli tarzda ko'rsatish */
function mikrofonXatosiniKorsat(err) {
  if (!err) return;
  const name = err.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    if (TELEFON) {
      toast('Mikrofonga ruxsat berilmagan. Telefon Sozlamalari orqali ruxsat bering', 6000);
    } else {
      toast('Mikrofonga ruxsat berilmagan. Brauzer qidiruv qatoridagi qulf 🔒 belgisidan ruxsat bering', 6000);
    }
  } else if (name === 'NotReadableError' || name === 'TrackStartError') {
    toast('Mikrofon boshqa ilova tomonidan band qilingan', 6000);
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    toast('Mikrofon qurilmasi topilmadi', 5000);
  } else {
    toast('Mikrofonni yoqib bo‘lmadi: ' + (err.message || name), 5000);
  }
}

/** Kamerani optimal sozlamada olish; o'xshamasa cheklovsiz ({ video: true }) yumshoq sozlamada qayta urinish */
async function videoOlish() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('NOT_SUPPORTED');
    err.name = 'NotSupportedError';
    throw err;
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: KAMERA });
  } catch (err1) {
    console.warn('[kamera] optimal sozlamalar bilan xato:', err1);
    // Agar foydalanuvchi rad etgan bo'lsa yoki apparat band bo'lsa, qayta urinish befoyda
    if (err1.name === 'NotAllowedError' || err1.name === 'PermissionDeniedError' || err1.name === 'NotReadableError') {
      throw err1;
    }
    // Tashqi USB kameralar, virtual kameralar va nozik drayverlar uchun yumshoq cheklov bilan qayta urinish
    try {
      console.log('[kamera] yumshoq { video: true } sozlamasi bilan qayta urinilmoqda...');
      return await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (err2) {
      console.warn('[kamera] yumshoq sozlama bilan ham xato:', err2);
      throw err2;
    }
  }
}

/** Mikrofonni optimal, bo'lmasa oddiy sozlamada olish */
async function audioOlish() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('NOT_SUPPORTED');
    err.name = 'NotSupportedError';
    throw err;
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_SOZLAMALARI });
  } catch (err1) {
    console.warn('[audio] optimal sozlamalar bilan xato:', err1);
    if (err1.name === 'NotAllowedError' || err1.name === 'PermissionDeniedError' || err1.name === 'NotReadableError') {
      throw err1;
    }
    try {
      console.log('[audio] yumshoq { audio: true } bilan qayta urinilmoqda...');
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err2) {
      console.warn('[audio] yumshoq sozlama bilan ham xato:', err2);
      throw err2;
    }
  }
}

async function initMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Brauzerda video/audio qo‘llab-quvvatlanmadi. Suhbatdosh bilan chat orqali yozishingiz mumkin 💬', 7000);
    mediaXato.mic = mediaXato.cam = 'yoq';
    if (el.chatNuqta) el.chatNuqta.hidden = false;
    return;
  }

  // 1. Dastlab audio va videoni birgalikda so'raymiz (foydalanuvchiga bitta ruxsat oynasi chiqishi uchun)
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_SOZLAMALARI,
      video: KAMERA,
    });
  } catch (birgalikdaErr) {
    console.warn('[initMedia] audio+video birgalikda olishda xato, alohida sinab ko‘ramiz:', birgalikdaErr);

    // Agar birgalikda olish xato bersa, audio va videoni alohida olib ko'ramiz
    let aStream = null;
    let vStream = null;
    let vErr = null;

    try {
      aStream = await audioOlish();
    } catch (aErr) {
      mediaXato.mic = xatoTuri(aErr);
      console.warn('[initMedia] audio olinmadi:', aErr);
    }

    try {
      vStream = await videoOlish();
    } catch (err) {
      vErr = err;
      mediaXato.cam = xatoTuri(err);
      console.warn('[initMedia] video olinmadi:', err);
    }

    if (aStream && vStream) {
      localStream = new MediaStream([
        ...aStream.getAudioTracks(),
        ...vStream.getVideoTracks(),
      ]);
    } else if (aStream) {
      localStream = aStream;
      if (vErr) kameraXatosiniKorsat(vErr);
      else toast('Kamera topilmadi yoki ruxsat yo‘q — faqat ovoz ulandi', 4000);
    } else if (vStream) {
      localStream = vStream;
      toast('Faqat kamera ulandi — mikrofon o‘chiq', 4000);
    } else {
      toast('Kamera/mikrofonga ruxsat berilmadi. Suhbatdosh bilan chat orqali yozishingiz mumkin 💬', 7000);
      if (el.chatNuqta) el.chatNuqta.hidden = false;
      return;
    }
  }

  if (localStream) {
    const hasVideo = localStream.getVideoTracks().length > 0;
    const hasAudio = localStream.getAudioTracks().length > 0;
    if (hasVideo) {
      el.localVideo.setAttribute('playsinline', 'true');
      el.localVideo.setAttribute('webkit-playsinline', 'true');
      el.localVideo.muted = true;
      el.localVideo.srcObject = localStream;
      el.localVideo.play().catch(() => {});
      // Kamera kirishda o'chiq (ustoz ham, o'quvchi ham) — o'quvchilar noqulay his qilmasin.
      // Trek saqlanadi (ekran ulashish yo'lagi uchun), faqat yuborilmaydi; 📷 tugmasi bilan yoqiladi.
      localStream.getVideoTracks().forEach((t) => { t.enabled = false; });
      el.localVideo.classList.add('off');
      el.localPh.hidden = false;
    } else {
      el.localPh.hidden = false;
      const b = el.localPh.querySelector('b');
      if (b) b.textContent = 'Kamera o‘chiq';
    }
    el.btnMic.classList.toggle('off', !hasAudio);
    el.btnMic.textContent = hasAudio ? '🎤' : '🔇';
    el.btnCam.classList.add('off');
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
    remoteKamChiz();
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
  mediaYubor(); // yangi kirgan suhbatdosh holatimizni bilsin
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
  if (!t || t.readyState === 'ended') {
    try {
      const ms = await audioOlish();
      t = ms.getAudioTracks()[0];
      if (!t) throw new Error('AUDIO_TRACK_EMPTY');
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
      mediaXato.mic = null;
      mediaYubor();
      toast('Mikrofon yoqildi', 3000);
      return;
    } catch (err) {
      console.warn('[btnMic] xato:', err);
      mediaXato.mic = xatoTuri(err);
      mediaYubor();
      mikrofonXatosiniKorsat(err);
      return;
    }
  }
  t.enabled = !t.enabled;
  el.btnMic.classList.toggle('off', !t.enabled);
  el.btnMic.textContent = t.enabled ? '🎤' : '🔇';
  mediaYubor();
};
el.btnCam.onclick = async () => {
  let t = localStream && localStream.getVideoTracks()[0];
  if (!t || t.readyState === 'ended') {
    try {
      const ms = await videoOlish();
      t = ms.getVideoTracks()[0];
      if (!t) throw new Error('VIDEO_TRACK_EMPTY');
      if (!localStream) localStream = new MediaStream();
      localStream.addTrack(t);
      el.localVideo.setAttribute('playsinline', 'true');
      el.localVideo.setAttribute('webkit-playsinline', 'true');
      el.localVideo.muted = true;
      el.localVideo.srcObject = localStream;
      el.localVideo.play().catch(() => {});
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
      mediaXato.cam = null;
      mediaYubor();
      toast('Kamera yoqildi', 3000);
      return;
    } catch (err) {
      console.warn('[btnCam] xato:', err);
      mediaXato.cam = xatoTuri(err);
      mediaYubor();
      kameraXatosiniKorsat(err);
      return;
    }
  }
  t.enabled = !t.enabled;
  el.btnCam.classList.toggle('off', !t.enabled);
  el.localVideo.classList.toggle('off', !t.enabled);
  el.localPh.hidden = t.enabled;
  mediaYubor();
};

// O'zidagi ogohlantirish tugmalari: yopish / chat / sozlamalar / qayta urinish
el.ozMedia.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-oz]');
  if (!b) return;
  const oz = b.dataset.oz;
  if (oz === 'yop') {
    el.ozMedia.hidden = true;
    OZ_MEDIA_YOPILDI = true;
    return;
  }
  if (oz === 'chat') {
    el.ozMedia.hidden = true;
    OZ_MEDIA_YOPILDI = true;
    chatOch(true, true);
    return;
  }
  if (oz === 'sozlama') {
    try { await window.flutter_inappwebview.callHandler('sozlamalarniOch'); } catch {
      toast('Telefon Sozlamalari → Ilovalar → MyTeacher → Ruxsatlar', 6000);
    }
    return;
  }
  if (oz === 'qayta') {
    OZ_MEDIA_YOPILDI = false;
    const h = mediaHolati();
    if (MUAMMO[h.mic]) await el.btnMic.onclick();
    if (h.cam === 'ruxsat' || h.cam === 'band') await el.btnCam.onclick();
  }
});
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
  document.body.classList.toggle('has-screen', Boolean(on));
  if (on && (TELEFON || IS_MOBILE_DEVICE)) {
    try { daftarYigish(true); } catch {}
  }
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
    else if (pc && pc.connectionState === 'connected') { el.remotePh.hidden = true; remoteKamChiz(); }
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
  c.style.left = (v.offsetLeft || 0) + 'px';
  c.style.top = (v.offsetTop || 0) + 'px';
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

  const chiq = async () => {
    // 1. Ilova ko'prigi (Flutter / InAppWebView / MyTeacher / iframe)
    try {
      if (window.flutter_inappwebview?.callHandler) {
        window.flutter_inappwebview.callHandler('lessonAction', { turi: 'darsTugadi' });
        window.flutter_inappwebview.callHandler('mentorAction', { turi: 'darsTugadi' });
      }
      if (window.MyTeacher?.postMessage) {
        window.MyTeacher.postMessage(JSON.stringify({ turi: 'darsTugadi' }));
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'lesson-ended' }, '*');
      }
    } catch {}

    // 2. Agar sahifaga ichki sahifadan (masalan band.html) kelingan bo'lsa
    if (document.referrer && document.referrer.startsWith(location.origin)) {
      try {
        const refUrl = new URL(document.referrer);
        const refPath = refUrl.pathname;
        if (refPath !== '/login.html' && refPath !== '/room.html' && !refPath.startsWith('/dars/')) {
          location.href = document.referrer;
          return;
        }
      } catch {}
    }

    // 3. Agar tizimga kirgan o'quvchi bo'lsa (sessiyasi bor)
    try {
      const w = await fetch('/api/whoami').then((r) => (r.ok ? r.json() : null));
      if (w && (w.role === 'student' || w.hasSchedule)) {
        location.href = '/band.html';
        return;
      }
    } catch {}

    // 4. Havola bilan kirgan yoki sessiyasiz o'quvchi uchun — login sahifasiga HECH QACHON otmaymiz!
    // Buning o'rniga dars yakunlanganini bildiruvchi xushmuomala oyna ko'rsatamiz
    const oyna = document.querySelector('.baho-oyna');
    if (oyna) {
      oyna.innerHTML = `
        <div style="font-size:42px;margin-bottom:8px">🎉</div>
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:800">Dars yakunlandi!</h2>
        <p style="color:#6b6e76;margin:0 0 20px;font-size:14.5px;line-height:1.4">Ishtirokingiz uchun rahmat. Endi bu sahifani bemalol yopishingiz mumkin.</p>
        <div class="baho-amallar" style="justify-content:center">
          <button class="baho-yubor" id="bahoYopish" style="min-width:140px;padding:12px 24px">Oynani yopish</button>
        </div>
      `;
      document.getElementById('bahoYopish').onclick = () => {
        try { window.close(); } catch {}
      };
    }
  };
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
    await chiq();
  };
}

/** Ustoz darsdan chiqqanda xavfsiz qaytish (ilovaga xabar, referrer yoki /work.html) */
async function ustozChiqishi() {
  try {
    if (window.flutter_inappwebview?.callHandler) {
      window.flutter_inappwebview.callHandler('mentorAction', { turi: 'darsTugadi' });
    }
    if (window.MyTeacher?.postMessage) {
      window.MyTeacher.postMessage(JSON.stringify({ turi: 'darsTugadi' }));
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'lesson-ended' }, '*');
    }
  } catch {}

  if (document.referrer && document.referrer.startsWith(location.origin)) {
    try {
      const refUrl = new URL(document.referrer);
      const refPath = refUrl.pathname;
      if (refPath !== '/login.html' && refPath !== '/room.html' && !refPath.startsWith('/dars/')) {
        location.href = document.referrer;
        return;
      }
    } catch {}
  }

  location.href = '/work.html';
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
      // Dars yopilmaydi: o'quvchi kutib turadi, ustoz ish joyidan qaytib kiradi
      DARS_TUGADI = true;
      try { ws && ws.close(); } catch {}
      teardownPeer();
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      await ustozChiqishi();
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
    setTimeout(async () => {
      try { ws && ws.close(); } catch {}
      teardownPeer();
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      await ustozChiqishi();
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
  document.body.classList.add('has-doc');
  if (TELEFON || IS_MOBILE_DEVICE) { try { daftarYigish(true); } catch {} }
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
  ozMediaChiz(mediaHolati());
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

const chatEl = {
  panel: document.getElementById('chatPanel'),
  xabarlar: document.getElementById('chatXabarlar'),
  form: document.getElementById('chatForm'),
  kirit: document.getElementById('chatKirit'),
  btnYop: document.getElementById('btnChatYop'),
};

function chatOch(och = true, focus = false) {
  if (!chatEl.panel) return;
  chatEl.panel.hidden = !och;
  if (el.btnChat) {
    el.btnChat.classList.toggle('jonli', och);
    el.btnChat.setAttribute('aria-expanded', String(och));
  }
  if (och) {
    if (el.chatNuqta) el.chatNuqta.hidden = true;
    if (chatEl.xabarlar) chatEl.xabarlar.scrollTop = chatEl.xabarlar.scrollHeight;
    if (focus) setTimeout(() => chatEl.kirit && chatEl.kirit.focus(), 60);
  }
}

function chatQosh(m, boshlangich = false) {
  if (!chatEl.xabarlar || !m || !m.text) return;
  const isMe = m.from === myId;
  const div = document.createElement('div');
  div.className = 'chat-xabar ' + (isMe ? 'men' : 'u');

  const vaqt = m.time
    ? new Date(m.time).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' })
    : '';

  div.innerHTML = `
    <div class="chat-xabar-bosh">
      <span>${dEsc(m.name || (m.role === 'teacher' ? 'Ustoz' : 'O‘quvchi'))}</span>
      <span>${vaqt}</span>
    </div>
    <div class="chat-matn">${dEsc(m.text || '')}</div>
  `;
  chatEl.xabarlar.appendChild(div);
  chatEl.xabarlar.scrollTop = chatEl.xabarlar.scrollHeight;

  // Yangi habar kelganda: agar o'quvchida chat yopiq turgan bo'lsa — alohida chat paneli ochiladi
  const yopiq = !chatEl.panel || chatEl.panel.hidden;
  if (!IS_TEACHER && !isMe && !boshlangich) {
    if (yopiq) chatOch(true, false);
  } else if (yopiq && !isMe) {
    if (el.chatNuqta) el.chatNuqta.hidden = false;
  }

  if (!isMe) {
    toast(`💬 ${m.name || (m.role === 'teacher' ? 'Ustoz' : 'O‘quvchi')}: ${m.text}`, 3500);
  }
}

function chatTikla(messages) {
  if (!chatEl.xabarlar || !Array.isArray(messages)) return;
  chatEl.xabarlar.innerHTML = '<div class="chat-eslatma">💬 Jonli dars chati. Xabarlar bu yerda ko‘rinadi.</div>';
  messages.forEach((m) => chatQosh(m, true));
}

function daftarKorsat() {
  dEl.tablar.forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.d === daftarTab));
    if (b.dataset.d === daftarTab) b.classList.remove('yangi');
  });

  dEl.matn.hidden = !IS_TEACHER;
  dEl.kor.hidden = IS_TEACHER;

  if (IS_TEACHER) {
    if (dEl.matn.value !== (DAFTAR[daftarTab] || '')) dEl.matn.value = DAFTAR[daftarTab] || '';
    dEl.matn.placeholder = DAFTAR_NAMUNA[daftarTab] || '';
    return;
  }
  const t = (DAFTAR[daftarTab] || '').trim();
  if (!t) { dEl.kor.innerHTML = `<span class="bosh">${DAFTAR_BOSH[daftarTab] || ''}</span>`; return; }
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

if (chatEl.form) {
  chatEl.form.onsubmit = (e) => {
    e.preventDefault();
    const text = (chatEl.kirit.value || '').trim();
    if (!text) return;
    wsSend({ type: 'chat', text });
    chatEl.kirit.value = '';
    chatEl.kirit.focus();
  };
}

if (el.btnChat) {
  el.btnChat.onclick = () => {
    const hozirOchiq = chatEl.panel && !chatEl.panel.hidden;
    chatOch(!hozirOchiq, !hozirOchiq);
  };
}

if (chatEl.btnYop) {
  chatEl.btnYop.onclick = () => chatOch(false);
}

if (el.toast) {
  el.toast.style.cursor = 'pointer';
  el.toast.onclick = () => {
    if (el.board && el.board.classList.contains('toliq-rejim')) toliqEkran(false);
    chatOch(true, true);
    el.toast.hidden = true;
  };
}

if (chatEl.kirit) {
  chatEl.kirit.addEventListener('keydown', (e) => e.stopPropagation());
}

// ===== To'liq ekran (Fullscreen) boshqaruvi (telefon va planshetlar uchun) =====
function toliqEkran(yoq) {
  const board = el.board;
  if (!board) return;
  const hozir = board.classList.contains('toliq-rejim');
  const maqsad = typeof yoq === 'boolean' ? yoq : !hozir;

  board.classList.toggle('toliq-rejim', maqsad);
  document.body.classList.toggle('board-fullscreen', maqsad);

  const btnExit = document.getElementById('btnExitFs');
  if (btnExit) btnExit.hidden = !maqsad;

  if (maqsad) {
    if (board.requestFullscreen && !document.fullscreenElement) {
      board.requestFullscreen().catch(() => {});
    }
  } else {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  setTimeout(() => {
    if (pdfDoc) renderPage(pageNum);
    if (EKRAN) ekranOlcham();
  }, 100);
}

const btnFullEkran = document.getElementById('btnFullEkran');
if (btnFullEkran) btnFullEkran.onclick = (e) => { e.stopPropagation(); toliqEkran(true); };

const btnFullPdf = document.getElementById('btnFullPdf');
if (btnFullPdf) btnFullPdf.onclick = (e) => { e.stopPropagation(); toliqEkran(true); };

const btnExitFs = document.getElementById('btnExitFs');
if (btnExitFs) btnExitFs.onclick = (e) => { e.stopPropagation(); toliqEkran(false); };

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && el.board && el.board.classList.contains('toliq-rejim')) {
    toliqEkran(false);
  }
});

let lastBoardTap = 0;
if (el.board) {
  el.board.addEventListener('touchend', (e) => {
    if (e.target.closest('button, input, textarea')) return;
    const now = Date.now();
    if (now - lastBoardTap < 320) {
      toliqEkran();
      e.preventDefault();
    }
    lastBoardTap = now;
  });
}

daftarKorsat();
requestAnimationFrame(daftarJoy);
window.addEventListener('resize', daftarJoy);
