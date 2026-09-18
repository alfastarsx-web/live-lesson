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
