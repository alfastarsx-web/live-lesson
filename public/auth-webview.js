'use strict';
/*
 * Mentor ilovasi WebView'ni shunday ochadi:
 *   https://lesson.myteacher.uz/oquvchilar.html#ai=<ai.myteacher.uz access token>
 *
 * Hash (#) qismi serverga UMUMAN yuborilmaydi — ya'ni token nginx loglariga
 * tushmaydi. Sahifa uni o'qib, bir marta serverga uzatadi va cookie'ga aylantiradi.
 */
window.WebViewAuth = {
  async tayyorla() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get('ai') || new URLSearchParams(location.search).get('ai');

    if (token) {
      try {
        await fetch('/api/adopt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
      } catch { /* pastda baribir tekshiriladi */ }
      // Tokenni manzil satridan olib tashlaymiz
      history.replaceState(null, '', location.pathname);
    }
  },
};

window.api = async function api(yol, opts) {
  const r = await fetch(yol, opts);
  if (r.status === 401) {
    location.href = '/login.html?keyin=' + encodeURIComponent(location.pathname + location.search);
    return null;
  }
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
};

/**
 * Mentor veb sahifada ishlayotganini tizimga bildiradi.
 *
 * Mobil ilova soket orqali ulanadi va shu bilan onlayn hisoblanadi. Kompyuterda
 * ishlayotgan mentorda bunday ulanish yo'q edi, ya'ni ishlab turib ham tizim
 * uchun oflayn bo'lib qolardi: avtomatik lid kelmasdi va qo'lidagi tegilmagan
 * lidlar tortib olinardi.
 *
 * Signal faqat sahifa ko'rinib turganda yuboriladi — mentor boshqa ilovaga
 * o'tsa yoki brauzerni yopsa, sessiya server tomonda bir necha daqiqada yopiladi.
 * Shuning uchun ochiq qoldirilgan oynaning o'zi mentorni onlayn qilib turmaydi.
 */
window.mentorNabzi = function mentorNabzi() {
  const ORALIQ = 60_000;
  let taymer = null;

  const yubor = () => {
    if (document.visibilityState !== 'visible') return;
    // Sahifa yopilayotgan bo'lsa ham xato chiqmasin
    fetch('/api/mentor-session/heartbeat', { method: 'POST' }).catch(() => {});
  };

  const boshla = () => {
    if (taymer) return;
    yubor();
    taymer = setInterval(yubor, ORALIQ);
  };
  const toxtat = () => {
    if (!taymer) return;
    clearInterval(taymer);
    taymer = null;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') boshla();
    else toxtat();
  });

  boshla();
};

// --- umumiy yordamchilar ---
window.bosh = (ism) => (ism || '?').trim().charAt(0).toUpperCase();

window.sanaQisqa = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
};

window.sanaVaqt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

window.soatQisqa = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// Sekundlarni 5:12 yoki 1:03:20 ko'rinishiga keltiradi
window.davomiylik = (boshIso, oxirIso) => {
  if (!boshIso) return '—';
  const bosh = new Date(boshIso).getTime();
  const oxir = oxirIso ? new Date(oxirIso).getTime() : Date.now();
  let sek = Math.max(0, Math.round((oxir - bosh) / 1000));
  const soat = Math.floor(sek / 3600); sek -= soat * 3600;
  const daq = Math.floor(sek / 60); sek -= daq * 60;
  return soat
    ? `${soat}:${String(daq).padStart(2, '0')}:${String(sek).padStart(2, '0')}`
    : `${daq}:${String(sek).padStart(2, '0')}`;
};

window.HOLAT = {
  active: { matn: 'Faol', sinf: 's-active' },
  completed: { matn: 'Yakunlangan', sinf: 's-completed' },
  cancelled: { matn: 'Bekor qilingan', sinf: 's-cancelled' },
};

// uz-UZ lokali oyni "M09" deb yozadi — o'zimiz formatlaymiz
const OYLAR = ['yan','fev','mar','apr','may','iyn','iyl','avg','sen','okt','noy','dek'];

window.sanaChiroyli = (iso) => {
  const d = new Date(iso);
  return `${d.getDate()} ${OYLAR[d.getMonth()]}, `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
