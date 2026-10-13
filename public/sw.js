'use strict';
/*
 * Mentor sahifalari "ilova" sifatida o'rnatilishi (PWA) uchun service worker.
 * Hech narsa keshlanmaydi — sahifalar har doim serverdan (yangi versiya darhol ko'rinadi).
 * Faqat internet yo'qligida sahifa o'rniga tushunarli xabar ko'rsatiladi.
 */
const OFFLINE = `<!doctype html><html lang="uz"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Internet yo‘q</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;
background:#f7f7f4;color:#1d2422;text-align:center;padding:24px}button{margin-top:16px;border:0;border-radius:12px;
background:#1f6f5c;color:#fff;font-weight:700;font-size:15px;padding:12px 18px}</style></head>
<body><div><div style="font-size:44px">📡</div><h2>Internet yo‘q</h2>
<p>Ulanishni tekshirib, qayta urinib ko‘ring.</p><button onclick="location.reload()">Qayta urinish</button></div></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  // Faqat sahifa ochilishi; API, rasm, video dars (WebRTC/WebSocket) — brauzerning o'zi
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
  );
});
