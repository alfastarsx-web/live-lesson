'use strict';

/**
 * Sinov darsi webappi — o'quvchi tomoni.
 *
 * Kurslar bo'limidagi havoladan ochiladi. Havolaga ilova `?name=..&userId=..`
 * qo'shadi, lekin biz ularga ISHONMAYMIZ: ular imzolanmagan, ya'ni har kim
 * o'zgartira oladi. Kim kirayotganini faqat telefon + parol aniqlaydi.
 */

const el = (id) => document.getElementById(id);

const BOLIMLAR = ['kirishBolimi', 'parolBolimi', 'darsBolimi'];
function korsat(nom) {
  for (const b of BOLIMLAR) el(b).hidden = b !== nom;
  el('yuklanmoqda').hidden = true;
}

function xatoKorsat(qutiId, matn) {
  const q = el(qutiId);
  if (!matn) { q.hidden = true; return; }
  q.textContent = matn;
  q.hidden = false;
}

async function api(yol, opts = {}) {
  const r = await fetch(yol, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.message || 'Xatolik yuz berdi');
  return data;
}

// ---------- Vaqt ----------

const OYLAR = [
  'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
];

/**
 * Toshkent vaqtida "Bugun, 14:00" yoki "22-sentabr, 14:00".
 *
 * uz-UZ lokaliga tayanmaymiz: ko'p brauzer va Android WebView'da u to'liq
 * emas va oy nomi o'rniga "M09" chiqadi. Shuning uchun faqat vaqt mintaqasini
 * Intl'dan olamiz, oy nomini o'zimiz yozamiz.
 */
function toshkent(iso) {
  const qism = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const p = {};
  for (const q of qism) p[q.type] = q.value;
  return {
    kun: Number(p.day), oy: Number(p.month), yil: Number(p.year),
    soat: `${p.hour}:${p.minute}`,
  };
}

function vaqtMatni(iso, hozir = Date.now()) {
  const d = toshkent(iso);
  const b = toshkent(new Date(hozir).toISOString());

  const bir = (x) => `${x.yil}-${x.oy}-${x.kun}`;
  if (bir(d) === bir(b)) return `Bugun, ${d.soat}`;

  const ertaga = toshkent(new Date(hozir + 24 * 3600_000).toISOString());
  if (bir(d) === bir(ertaga)) return `Ertaga, ${d.soat}`;

  return `${d.kun}-${OYLAR[d.oy - 1]}, ${d.soat}`;
}

/**
 * Darsga kirish tugmasi qachon ochilishini aytadi.
 * Server 10 daqiqa oldin ochadi — sahifa ham shunga qarab yozadi, aks holda
 * o'quvchi tugmani bosib "hali vaqti bo'lmadi" degan xatoni ko'radi.
 */
const OLDIN_DAQ = 10;
function kirishHolati(startsAt, durationMin, hozir = Date.now()) {
  const boshlanish = new Date(startsAt).getTime();
  const ochiladi = boshlanish - OLDIN_DAQ * 60_000;
  const yopiladi = boshlanish + (durationMin + 10) * 60_000;

  if (hozir > yopiladi) return { holat: 'otgan', matn: 'Bu darsning vaqti o‘tgan' };
  if (hozir >= ochiladi) return { holat: 'ochiq', matn: 'Darsga kirish' };

  const qoldi = Math.ceil((ochiladi - hozir) / 60_000);
  if (qoldi < 60) return { holat: 'kutish', matn: `Kirish ${qoldi} daqiqadan so‘ng ochiladi` };
  const soat = Math.floor(qoldi / 60);
  if (soat < 24) return { holat: 'kutish', matn: `Kirish ${soat} soatdan so‘ng ochiladi` };
  // Sana kartaning yuqorisida allaqachon yozilgan — takrorlamaymiz
  return { holat: 'kutish', matn: 'Kirish dars boshlanishiga 10 daqiqa qolganda ochiladi' };
}

// ---------- Kirish ----------

el('kirishForma').addEventListener('submit', async (e) => {
  e.preventDefault();
  xatoKorsat('kirishXato', '');

  const login = el('telefon').value.trim();
  const password = el('parol').value;
  if (!login || !password) return xatoKorsat('kirishXato', 'Telefon va kodni kiriting');

  const tugma = el('kirishTugma');
  tugma.disabled = true;
  tugma.textContent = 'Kirilmoqda…';
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    });
    // Parol qo'yish taklif qilinadi, majburlanmaydi: kod SMS'da turibdi,
    // odam uni istalgan vaqtda topib kiraveradi
    if (r.mustChangePassword) return korsat('parolBolimi');
    await darslarniKorsat();
  } catch (err) {
    xatoKorsat('kirishXato', err.message);
  } finally {
    tugma.disabled = false;
    tugma.textContent = 'Kirish';
  }
});

// ---------- O'z parolini qo'yish ----------

el('parolForma').addEventListener('submit', async (e) => {
  e.preventDefault();
  xatoKorsat('parolXato', '');

  const p1 = el('yangiParol').value;
  const p2 = el('yangiParol2').value;
  if (p1.length < 6) return xatoKorsat('parolXato', 'Parol kamida 6 belgi bo‘lsin');
  if (p1 !== p2) return xatoKorsat('parolXato', 'Parollar bir xil emas');

  const tugma = el('parolTugma');
  tugma.disabled = true;
  tugma.textContent = 'Saqlanmoqda…';
  try {
    await api('/api/parol', { method: 'POST', body: JSON.stringify({ newPassword: p1 }) });
    await darslarniKorsat();
  } catch (err) {
    xatoKorsat('parolXato', err.message);
  } finally {
    tugma.disabled = false;
    tugma.textContent = 'Saqlash';
  }
});

// ---------- Darslar ----------

function darsKartasi(d) {
  const k = document.createElement('div');
  k.className = 'dars';

  const teg = d.isTrial ? '<div class="dars-teg">Bepul sinov darsi</div>' : '';
  const ustoz = d.mentorName ? `<div class="dars-ustoz">${matn(d.mentorName)}</div>` : '';
  k.innerHTML = `${teg}${ustoz}<div class="dars-vaqt">${vaqtMatni(d.startsAt)}</div>`;

  const h = kirishHolati(d.startsAt, d.durationMin || 60);
  if (h.holat === 'ochiq') {
    const tugma = document.createElement('button');
    tugma.className = 'asosiy';
    tugma.textContent = h.matn;
    tugma.onclick = () => darsgaKir(d.id, tugma);
    k.appendChild(tugma);
  } else {
    const p = document.createElement('p');
    p.className = 'dars-kutish';
    p.textContent = h.matn;
    k.appendChild(p);
  }
  return k;
}

/** Foydalanuvchi nomini HTML sifatida talqin qilmaymiz. */
function matn(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

async function darsgaKir(id, tugma) {
  tugma.disabled = true;
  tugma.textContent = 'Ochilmoqda…';
  try {
    const r = await api(`/api/booking/${id}/entry`);
    const url = r.url || r.joinUrl || r.studentUrl;
    if (!url) throw new Error('Kirish havolasi kelmadi');
    location.href = url;
  } catch (err) {
    tugma.disabled = false;
    tugma.textContent = 'Darsga kirish';
    alert(err.message);
  }
}

async function darslarniKorsat() {
  el('yuklanmoqda').hidden = false;
  const royxat = await api('/api/booking/my');

  const quti = el('darsRoyxati');
  quti.textContent = '';

  if (!Array.isArray(royxat) || !royxat.length) {
    quti.innerHTML = '<div class="bosh"><b>Hozircha dars yo‘q</b>'
      + 'Ustozingiz sinov darsi belgilagach, shu yerda ko‘rinadi.</div>';
  } else {
    for (const d of royxat) quti.appendChild(darsKartasi(d));
  }

  korsat('darsBolimi');
}

el('keyinroq').addEventListener('click', () => { darslarniKorsat(); });

el('chiqish').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch { /* baribir chiqaramiz */ }
  location.reload();
});

// ---------- Boshlanish ----------

/**
 * Telegram botdan kelgan bir bosishlik havola: ?k=<imzolangan token>.
 * Tokenni sessiyaga almashtiramiz va manzil qatoridan darhol o'chiramiz —
 * u boshqaga ko'rsatilgan ekranda yoki tarixda qolib ketmasin.
 */
async function telegramdanKirish() {
  const p = new URLSearchParams(location.search);
  const k = p.get('k');
  if (!k) return false;

  history.replaceState(null, '', location.pathname);
  try {
    await api('/api/kirish', { method: 'POST', body: JSON.stringify({ token: k }) });
    return true;
  } catch (err) {
    korsat('kirishBolimi');
    xatoKorsat('kirishXato', `${err.message}. Telefon va kod bilan kiring.`);
    return 'xato';
  }
}

(async function boshla() {
  const tg = await telegramdanKirish();
  if (tg === 'xato') return;

  // Allaqachon kirgan bo'lsa (cookie bor) — to'g'ridan-to'g'ri darslarga
  try {
    await api('/api/whoami');
    await darslarniKorsat();
  } catch {
    korsat('kirishBolimi');
  }
})();

// Sinov uchun ochib qo'yamiz
if (typeof module !== 'undefined') module.exports = { kirishHolati, vaqtMatni };
