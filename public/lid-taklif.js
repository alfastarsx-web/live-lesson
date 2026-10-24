'use strict';
/*
 * Vaqtsiz target lid — reklamadan kelib, sinov vaqtini o'zi tanlamagan odam. Bot uni eng yaqin bo'sh soati
 * bor ustozlarga o'rtaga tashlaydi: kim birinchi "Olaman" desa — o'shaniki. Keyin ustoz qo'ng'iroq qiladi va:
 *   📅 o'z bo'sh kalendaridan soat tanlab sinovga yozadi, yoki
 *   ⏰ "Vaqti to'g'ri kelmadi" — o'quvchiga qulay vaqtni belgilaydi (shu vaqtda bo'sh ustozlarga ketadi), yoki
 *   📵 ko'tarmadi / ❌ qiziqmadi.
 * Olgach 30 daqiqada hech narsa qilinmasa lid qaytib olinadi (server tomonda).
 */
(function () {
  if (window.__lidTaklif) return;
  window.__lidTaklif = true;

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toshkent = (iso) => new Date(new Date(iso).getTime() + 5 * 3600e3);
  const p2 = (x) => String(x).padStart(2, '0');
  const kunKalit = (d) => d.toISOString().slice(0, 10);
  // "Bugun 21:00", "Ertaga 10:00", "27.10 15:00"
  const vaqtYorliq = (iso) => {
    const t = toshkent(iso);
    const bugun = kunKalit(toshkent(new Date().toISOString()));
    const ertaga = kunKalit(toshkent(new Date(Date.now() + 86400e3).toISOString()));
    const k = kunKalit(t);
    const s = `${p2(t.getUTCHours())}:00`;
    return k === bugun ? `Bugun ${s}` : k === ertaga ? `Ertaga ${s}` : `${p2(t.getUTCDate())}.${p2(t.getUTCMonth() + 1)} ${s}`;
  };
  const qoldi = (iso) => {
    const s = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
    return `${Math.floor(s / 60)}:${p2(s % 60)}`;
  };
  const xabar = (m) => {
    const t = document.createElement('div');
    t.setAttribute('role', 'status');
    t.textContent = m;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f2a27;color:#fff;padding:10px 16px;border-radius:12px;font-family:inherit;font-weight:600;font-size:14px;z-index:10003;max-width:90vw;text-align:center';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  };
  const sorov = async (yol, opts = {}) => {
    try {
      const r = await fetch(yol, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, data: j };
    } catch {
      return { ok: false, data: { message: 'Internet bilan muammo — qayta urinib ko‘ring' } };
    }
  };
  const xatoMatn = (d) => (Array.isArray(d.message) ? d.message[0] : d.message) || d.error || 'Qayta urinib ko‘ring';
  // Qisqa signal (Web Audio) va tebranish
  const signal = () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const a = new AC();
      [0, 0.25, 0.5].forEach((t) => {
        const o = a.createOscillator();
        const g = a.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, a.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.25, a.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + t + 0.2);
        o.connect(g).connect(a.destination);
        o.start(a.currentTime + t);
        o.stop(a.currentTime + t + 0.22);
      });
    } catch { /* ovoz yo'q — tebranish yetadi */ }
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch { /* yo'q */ }
  };

  const uslub = document.createElement('style');
  uslub.textContent = `
  .lt-fon{position:fixed;inset:0;background:rgba(18,30,26,.55);z-index:10002;display:flex;align-items:flex-end;justify-content:center}
  .lt-oyna{background:#fff;width:100%;max-width:520px;border-radius:22px 22px 0 0;padding:18px 16px calc(16px + env(safe-area-inset-bottom));max-height:92vh;overflow:auto;font-family:'Manrope',system-ui,sans-serif;font-size:14px;line-height:1.45;color:#1f2a27}
  .lt-oyna h3{margin:0 0 4px;font-size:18px}
  .lt-xira{color:#5f6864;font-size:13px}
  .lt-katta{display:block;width:100%;border:0;border-radius:14px;padding:14px;font-family:inherit;font-weight:800;font-size:16px;cursor:pointer;margin-top:10px}
  .lt-yashil{background:#1f6f5c;color:#fff} .lt-kul{background:#f0f1ec;color:#1f2a27} .lt-qizil{background:#fce9e5;color:#9b3424}
  .lt-katta:disabled{opacity:.5}
  .lt-sanoq{display:inline-block;background:#fdf1dc;color:#9a6315;border-radius:999px;padding:4px 10px;font-weight:800;font-size:13px;font-variant-numeric:tabular-nums}
  .lt-chiplar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
  .lt-chiplar button{border:1.5px solid #e6e8e2;background:#fff;border-radius:12px;padding:9px 12px;font-family:inherit;font-weight:700;font-size:14px;cursor:pointer;color:#1f2a27}
  .lt-chiplar button[aria-pressed="true"]{border-color:#1f6f5c;background:#e2f2ec}
  .lt-yorliq{font-size:12.5px;font-weight:800;color:#5f6864;margin:10px 0 4px}
  .lt-oyna select,.lt-oyna input,.lt-oyna textarea{width:100%;box-sizing:border-box;border:1.5px solid #e6e8e2;border-radius:12px;padding:10px 12px;font-family:inherit;font-size:15px;color:#1f2a27;background:#fff}
  .lt-qator{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .lt-karta{display:flex;align-items:center;gap:12px;border:0;width:100%;text-align:left;border-radius:18px;padding:14px 16px;margin:0 0 12px;cursor:pointer;background:#e2f2ec;box-shadow:0 0 0 1.5px #1f6f5c;font-family:inherit;color:#1f2a27}
  .lt-karta b{display:block;font-size:15px} .lt-karta small{display:block;font-size:12.5px;color:#5f6864}
  .lt-pastki{position:fixed;left:50%;transform:translateX(-50%);bottom:70px;z-index:9998;border:0;border-radius:999px;padding:12px 18px;font-family:inherit;font-weight:800;font-size:14px;background:#1f6f5c;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);cursor:pointer}
  `;
  document.head.appendChild(uslub);

  const korilgan = new Set();
  let ochiqOyna = null;
  let sanoqTaymer = null;

  const yop = () => {
    if (ochiqOyna) ochiqOyna.remove();
    ochiqOyna = null;
    clearInterval(sanoqTaymer);
  };
  const oynaOch = (html) => {
    yop();
    const fon = document.createElement('div');
    fon.className = 'lt-fon';
    fon.innerHTML = `<div class="lt-oyna" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(fon);
    ochiqOyna = fon;
    return fon;
  };

  // ---------- 1. O'rtaga tashlangan lid: Olaman / O'tkazib yuborish ----------
  function signalOyna(t) {
    korilgan.add(t.taklifId);
    const fon = oynaOch(`
      <h3>📞 Yangi lid — kim birinchi olsa</h3>
      <div class="lt-xira">${esc(t.manba)}</div>
      <div style="font-size:22px;font-weight:800;margin:12px 0 4px">${esc(t.ism)}</div>
      <div>Sinov darsiga yozilmoqchi, lekin vaqtni tanlamagan. Oling — qo‘ng‘iroq qilib, vaqtni kelishing.</div>
      ${t.yaqinSlot ? `<div class="lt-xira" style="margin-top:6px">Sizning eng yaqin bo‘sh soatingiz: <b>${esc(vaqtYorliq(t.yaqinSlot))}</b></div>` : ''}
      ${t.izoh ? `<div class="lt-xira" style="margin-top:6px">📝 ${esc(t.izoh)}</div>` : ''}
      <div style="margin-top:10px"><span class="lt-sanoq" id="ltSanoq">${qoldi(t.expiresAt)}</span> <span class="lt-xira">ichida oling</span></div>
      <button type="button" class="lt-katta lt-yashil" id="ltOl">Olaman</button>
      <button type="button" class="lt-katta lt-kul" id="ltOtkaz">O‘tkazib yuborish</button>`);
    signal();
    sanoqTaymer = setInterval(() => {
      const el = fon.querySelector('#ltSanoq');
      if (!el) return;
      el.textContent = qoldi(t.expiresAt);
      if (new Date(t.expiresAt).getTime() <= Date.now()) { yop(); xabar('Muddat tugadi — lid boshqa ustozlarga ketdi'); }
    }, 1000);
    fon.querySelector('#ltOl').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Olinmoqda…';
      const r = await sorov(`/api/ai/lid-taklif/${t.taklifId}/accept`, { method: 'POST' });
      if (!r.ok) {
        yop();
        xabar(`😔 ${xatoMatn(r.data)}`);
        return;
      }
      ishPanel(r.data);
    };
    fon.querySelector('#ltOtkaz').onclick = async () => {
      yop();
      await sorov(`/api/ai/lid-taklif/${t.taklifId}/decline`, { method: 'POST' });
    };
  }

  // ---------- 2. Olingan lid: qo'ng'iroq va natija ----------
  function ishPanel(l) {
    const fon = oynaOch(`
      <h3>✅ Lid sizniki — qo‘ng‘iroq qiling</h3>
      <div style="font-size:20px;font-weight:800;margin-top:6px">${esc(l.ism || 'Mijoz')}</div>
      ${l.harakatGacha ? `<div class="lt-xira" style="margin-top:4px"><span class="lt-sanoq" id="ltSanoq">${qoldi(l.harakatGacha)}</span> ichida sinovga yozing — aks holda lid boshqa ustozga o‘tadi</div>` : ''}
      ${l.telefon ? `<a class="lt-katta lt-yashil" style="text-align:center;text-decoration:none;box-sizing:border-box" href="tel:+${esc(String(l.telefon).replace(/\D/g, ''))}">📞 Qo‘ng‘iroq qilish · +${esc(String(l.telefon).replace(/\D/g, ''))}</a>` : ''}
      <div class="lt-yorliq">Gaplashdingizmi? Natijani tanlang</div>
      <button type="button" class="lt-katta lt-kul" id="ltYoz">📅 Sinovga yozish — mening bo‘sh soatimga</button>
      <button type="button" class="lt-katta lt-kul" id="ltVaqt">⏰ Vaqti to‘g‘ri kelmadi</button>
      <div class="lt-qator">
        <button type="button" class="lt-katta lt-kul" id="ltKotarmadi">📵 Ko‘tarmadi</button>
        <button type="button" class="lt-katta lt-qizil" id="ltQiziqmadi">❌ Qiziqmadi</button>
      </div>
      <button type="button" class="lt-katta" style="background:none;color:#5f6864" id="ltKeyin">Keyinroq</button>`);
    if (l.harakatGacha) {
      sanoqTaymer = setInterval(() => {
        const el = fon.querySelector('#ltSanoq');
        if (el) el.textContent = qoldi(l.harakatGacha);
      }, 1000);
    }
    fon.querySelector('#ltYoz').onclick = () => slotPanel(l);
    fon.querySelector('#ltVaqt').onclick = () => vaqtPanel(l);
    fon.querySelector('#ltKotarmadi').onclick = () => holatQoy(l, 'unreachable', 'Ko‘tarmadi');
    fon.querySelector('#ltQiziqmadi').onclick = () => holatQoy(l, 'lost', 'Qiziqmadi');
    fon.querySelector('#ltKeyin').onclick = () => { yop(); tekshir(); };
  }

  async function holatQoy(l, status, nom) {
    const izoh = window.prompt(`${nom} — qisqa izoh yozing (nima bo‘ldi?)`, '');
    if (izoh === null) return;
    const r = await sorov(`/api/ai/leads/${l.leadId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note: izoh.trim() ? `${nom}: ${izoh.trim()}` : undefined }),
    });
    if (!r.ok) return xabar(`Kechirasiz, saqlanmadi: ${xatoMatn(r.data)} 🙏`);
    yop();
    xabar('Saqlandi, rahmat 🙏');
    tekshir();
  }

  async function slotPanel(l) {
    const fon = oynaOch(`<h3>📅 Sinovga yozish</h3><div class="lt-xira">Kalendaringizdagi bo‘sh soatlar yuklanmoqda…</div>`);
    const r = await sorov(`/api/ai/lid-taklif/${l.taklifId}/slotlar`);
    if (!r.ok) { yop(); return xabar(`😔 ${xatoMatn(r.data)}`); }
    const slotlar = Array.isArray(r.data) ? r.data : [];
    let tanlov = null;
    fon.querySelector('.lt-oyna').innerHTML = `
      <h3>📅 Sinovga yozish</h3>
      <div class="lt-xira">${esc(l.ism || 'Mijoz')} bilan kelishilgan soatni tanlang (3 kunlik bo‘sh soatlaringiz)</div>
      ${slotlar.length
        ? `<div class="lt-chiplar">${slotlar.map((s) => `<button type="button" data-s="${esc(s)}" aria-pressed="false">${esc(vaqtYorliq(s))}</button>`).join('')}</div>`
        : '<div class="lt-xira" style="margin:12px 0">Yaqin 3 kunda bo‘sh soatingiz yo‘q. «Vaqti to‘g‘ri kelmadi» ni bosing — o‘quvchi uchun qulay vaqtni belgilaysiz.</div>'}
      <button type="button" class="lt-katta lt-yashil" id="ltSaqla" disabled>Sinovga yozish</button>
      <button type="button" class="lt-katta lt-kul" id="ltOrqaga">Orqaga</button>`;
    fon.querySelectorAll('[data-s]').forEach((b) => {
      b.onclick = () => {
        tanlov = b.dataset.s;
        fon.querySelectorAll('[data-s]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        fon.querySelector('#ltSaqla').disabled = false;
      };
    });
    fon.querySelector('#ltOrqaga').onclick = () => ishPanel(l);
    fon.querySelector('#ltSaqla').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Belgilanmoqda…';
      const res = await sorov('/api/booking/trial', { method: 'POST', body: JSON.stringify({ leadId: l.leadId, startsAt: tanlov }) });
      if (!res.ok) {
        e.target.disabled = false;
        e.target.textContent = 'Sinovga yozish';
        return xabar(`😔 ${xatoMatn(res.data)}`);
      }
      yop();
      xabar(`✅ Sinov darsi belgilandi: ${vaqtYorliq(tanlov)}. O‘quvchiga botdan xabar boradi`);
      tekshir();
    };
  }

  function vaqtPanel(l) {
    const bugun = toshkent(new Date().toISOString());
    const kunlar = [0, 1, 2, 3, 4, 5, 6].map((n) => {
      const d = new Date(Date.UTC(bugun.getUTCFullYear(), bugun.getUTCMonth(), bugun.getUTCDate() + n));
      return { k: kunKalit(d), t: n === 0 ? 'Bugun' : n === 1 ? 'Ertaga' : `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}` };
    });
    const soatlar = Array.from({ length: 16 }, (_, i) => 8 + i);
    const fon = oynaOch(`
      <h3>⏰ Vaqti to‘g‘ri kelmadi</h3>
      <div class="lt-xira">O‘quvchiga qaysi kun va soat qulay? Lid shu vaqtda bo‘sh ustozlarga o‘rtaga tashlanadi.</div>
      <div class="lt-yorliq">Kun</div>
      <div class="lt-chiplar">${kunlar.map((d) => `<button type="button" data-k="${d.k}" aria-pressed="false">${d.t}</button>`).join('')}</div>
      <div class="lt-yorliq">Soat</div>
      <select id="ltSoat"><option value="">Soatni tanlang</option>${soatlar.map((h) => `<option value="${h}">${p2(h)}:00</option>`).join('')}</select>
      <div class="lt-yorliq">Izoh (ixtiyoriy)</div>
      <textarea id="ltIzoh" rows="2" maxlength="300" placeholder="Masalan: faqat ishdan keyin bo‘sh"></textarea>
      <button type="button" class="lt-katta lt-yashil" id="ltSaqla" disabled>Saqlash va tashlash</button>
      <button type="button" class="lt-katta lt-kul" id="ltOrqaga">Orqaga</button>`);
    let kun = null;
    const tekshirT = () => { fon.querySelector('#ltSaqla').disabled = !kun || !fon.querySelector('#ltSoat').value; };
    fon.querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = () => {
        kun = b.dataset.k;
        fon.querySelectorAll('[data-k]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        tekshirT();
      };
    });
    fon.querySelector('#ltSoat').onchange = tekshirT;
    fon.querySelector('#ltOrqaga').onclick = () => ishPanel(l);
    fon.querySelector('#ltSaqla').onclick = async (e) => {
      const h = Number(fon.querySelector('#ltSoat').value);
      // Toshkent vaqti (UTC+5) → UTC
      const [y, m, d] = kun.split('-').map(Number);
      const startsAt = new Date(Date.UTC(y, m - 1, d, h) - 5 * 3600e3).toISOString();
      e.target.disabled = true;
      e.target.textContent = 'Saqlanmoqda…';
      const r = await sorov(`/api/ai/lid-taklif/${l.taklifId}/vaqt`, {
        method: 'POST',
        body: JSON.stringify({ startsAt, izoh: fon.querySelector('#ltIzoh').value.trim() || undefined }),
      });
      if (!r.ok) {
        e.target.disabled = false;
        e.target.textContent = 'Saqlash va tashlash';
        return xabar(`😔 ${xatoMatn(r.data)}`);
      }
      yop();
      xabar('✅ Rahmat! Shu vaqtda bo‘sh ustozlarga yuborildi');
      tekshir();
    };
  }

  // ---------- Tekshiruv: yangi takliflar va olingan lidlar ----------
  let faollar = [];
  function kartaChiz() {
    document.querySelectorAll('.lt-karta,.lt-pastki').forEach((x) => x.remove());
    if (!faollar.length) return;
    const l = faollar[0];
    const main = document.querySelector('main');
    const matn = `${faollar.length > 1 ? `${faollar.length} ta lid` : esc(l.ism || 'Lid')} — qo‘ng‘iroq qilib sinovga yozing`;
    if (main) {
      const k = document.createElement('button');
      k.type = 'button';
      k.className = 'lt-karta';
      k.innerHTML = `<span aria-hidden="true" style="font-size:22px">📞</span><span><b>${matn}</b><small>${l.harakatGacha ? `${qoldi(l.harakatGacha)} qoldi · ` : ''}bosing — telefon va amallar</small></span>`;
      k.onclick = () => ishPanel(l);
      const salom = main.querySelector('header, .salom');
      if (salom && salom.nextSibling) main.insertBefore(k, salom.nextSibling);
      else main.prepend(k);
    } else {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'lt-pastki';
      t.textContent = `📞 ${faollar.length} ta lid kutyapti`;
      t.onclick = () => ishPanel(l);
      document.body.appendChild(t);
    }
  }

  async function tekshir() {
    const [inc, faol] = await Promise.all([sorov('/api/ai/lid-taklif/mentor/incoming'), sorov('/api/ai/lid-taklif/mentor/faol')]);
    faollar = faol.ok && Array.isArray(faol.data) ? faol.data : [];
    kartaChiz();
    if (ochiqOyna) return;
    const yangi = inc.ok && Array.isArray(inc.data) ? inc.data.find((t) => !korilgan.has(t.taklifId)) : null;
    if (yangi) signalOyna(yangi);
  }

  const boshla = () => {
    tekshir();
    setInterval(() => { if (document.visibilityState === 'visible') tekshir(); }, 15e3);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tekshir(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boshla);
  else boshla();
})();
