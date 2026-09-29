'use strict';
/*
 * Sinov darsi so'rovi signali — mentor ilovaning qaysi veb bo'limida bo'lmasin (Home, Career,
 * Jadval, Daromad...) yangi so'rov kelsa butun ekran oyna chiqadi va signal to'xtovsiz chaladi:
 * qabul qilguncha, rad etguncha yoki muddati tugaguncha. Work sahifasining o'z oynasi bor.
 *
 * Ilova ekrani yopiq/fonda bo'lsa JS ishlamaydi — o'sha holatda signalni push beradi
 * (server so'rov kutayotgan har daqiqada qayta yuboradi).
 */
(function () {
  if (window.__sorovSignal) return;
  window.__sorovSignal = true;

  const TG_BOT = '@MT_yordam_bot';
  const korilgan = new Set();
  let navbat = [];
  let joriy = null;

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qoldiMatn = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const vaqtYorliq = (iso) => {
    const d = new Date(iso);
    const kun = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
    const farq = Math.round((kun(d) - kun(Date.now())) / 86400000);
    const soat = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (farq === 0) return `Bugun, ${soat}`;
    if (farq === 1) return `Ertaga, ${soat}`;
    return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}, ${soat}`;
  };

  // ---------- ovoz: to'xtovsiz ----------
  let ctx = null;
  let ovozTaymer = null;
  function bipla() {
    try { navigator.vibrate?.([400, 200, 400, 200, 400]); } catch { /* yo'q */ }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = ctx || new AC();
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      [0, 0.3, 0.6, 1.1, 1.4, 1.7].forEach((t, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = i % 3 === 2 ? 1175 : 880;
        o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.3, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.25);
      });
    } catch { /* brauzer ruxsat bermasa jim */ }
  }
  function ovozBoshla() {
    if (ovozTaymer) return;
    bipla();
    ovozTaymer = setInterval(bipla, 2600);
  }
  function ovozToxtat() {
    clearInterval(ovozTaymer);
    ovozTaymer = null;
    try { navigator.vibrate?.(0); } catch { /* yo'q */ }
  }
  // Brauzer ovozni birinchi teginishgacha to'sadi — teginish bilan ochamiz
  document.addEventListener('pointerdown', () => { try { ctx?.resume(); } catch { /* yo'q */ } }, true);

  // ---------- oyna ----------
  const css = `
  .ss-oyna{position:fixed;inset:0;z-index:2147483000;background:#f7f7f5;color:#23262d;display:flex;flex-direction:column;
    padding:calc(28px + env(safe-area-inset-top)) 20px calc(24px + env(safe-area-inset-bottom));
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif}
  .ss-oyna[hidden]{display:none}
  .ss-yuqori{font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#3d7d5f;animation:ss-m 1s infinite}
  @keyframes ss-m{50%{opacity:.35}}
  .ss-oyna h2{font-size:28px;font-weight:800;margin:10px 0 4px;letter-spacing:-.5px}
  .ss-vaqt{font-size:20px;font-weight:700;color:#5f636b}
  .ss-izoh{margin-top:14px;background:#fff;border-radius:14px;padding:12px 14px;font-size:14.5px;color:#5f636b;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .ss-markaz{flex:1;display:grid;place-items:center}
  .ss-soat{width:170px;height:170px;border-radius:50%;display:grid;place-items:center;text-align:center;
    border:8px solid #6fa588;box-shadow:0 0 0 0 rgba(111,165,136,.5);animation:ss-t 1.6s infinite}
  .ss-soat.shoshil{border-color:#c98a83}
  @keyframes ss-t{70%{box-shadow:0 0 0 26px rgba(111,165,136,0)}100%{box-shadow:0 0 0 0 rgba(111,165,136,0)}}
  .ss-soat b{display:block;font-size:38px;font-variant-numeric:tabular-nums}
  .ss-soat small{font-size:12px;font-weight:600;color:#9a9ca3}
  .ss-oyna button{font:inherit;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .ss-oyna .ss-qabul{padding:20px;font-size:19px;font-weight:800;border-radius:16px;background:#3d7d5f;color:#fff}
  .ss-oyna .ss-rad{margin-top:10px;padding:14px;font-size:15px;font-weight:700;border-radius:14px;background:transparent;color:#5f636b}
  .ss-oyna button:disabled{opacity:.5}
  .ss-ogoh{font-size:12.5px;color:#9a9ca3;text-align:center;margin-top:6px}
  .ss-qadam{background:#fff;border-radius:16px;padding:14px 16px;margin-top:12px;font-size:14.5px;line-height:1.45;color:#5f636b;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .ss-qadam b{display:block;color:#23262d;font-size:15.5px;margin-bottom:3px}
  .ss-qadam a{color:#2f6fde;font-weight:700}
  .ss-qadam.sariq{background:#fffaeb;border:1.5px solid #f1c75a}
  .ss-toast{position:fixed;left:16px;right:16px;bottom:calc(20px + env(safe-area-inset-bottom));z-index:2147483001;max-width:528px;margin:0 auto;
    background:#23262d;color:#fff;border-radius:14px;padding:14px 16px;font:600 14px -apple-system,BlinkMacSystemFont,sans-serif}
  @media (prefers-reduced-motion:reduce){.ss-yuqori,.ss-soat{animation:none}}`;

  let oyna = null;
  function oynaYasa() {
    if (oyna) return oyna;
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    oyna = document.createElement('div');
    oyna.className = 'ss-oyna';
    oyna.hidden = true;
    oyna.setAttribute('role', 'dialog');
    oyna.setAttribute('aria-modal', 'true');
    document.body.appendChild(oyna);
    return oyna;
  }

  function toast(t) {
    document.querySelectorAll('.ss-toast').forEach((x) => x.remove());
    const d = document.createElement('div');
    d.className = 'ss-toast';
    d.textContent = t;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 4500);
  }

  function och(s) {
    joriy = s;
    korilgan.add(s.requestId);
    const o = oynaYasa();
    o.innerHTML = `
      <div class="ss-yuqori">Yangi sinov darsi</div>
      <h2>${esc(s.leadName || 'Yangi o‘quvchi')}</h2>
      <div class="ss-vaqt">${esc(vaqtYorliq(s.startsAt))} · ${s.durationMin || 60} daqiqa</div>
      ${s.note ? `<div class="ss-izoh">${esc(s.note)}</div>` : ''}
      <div class="ss-markaz"><div class="ss-soat"><div><b data-ss-qoldi>15:00</b><small>qabul qilish uchun</small></div></div></div>
      <button class="ss-qabul" type="button" data-ss-qabul>Qabul qilish</button>
      <button class="ss-rad" type="button" data-ss-rad>Rad etish</button>
      <div class="ss-ogoh">Rad etish yoki javob bermaslik reytingingizga ta’sir qiladi</div>`;
    o.querySelector('[data-ss-qabul]').onclick = (e) => qabul(s, e.currentTarget);
    o.querySelector('[data-ss-rad]').onclick = (e) => rad(s, e.currentTarget);
    o.hidden = false;
    taymer();
    ovozBoshla();
  }

  function yop() {
    ovozToxtat();
    joriy = null;
    if (oyna) oyna.hidden = true;
    const keyingi = navbat.find((x) => !korilgan.has(x.requestId) && new Date(x.expiresAt) > Date.now());
    if (keyingi) och(keyingi);
  }

  function taymer() {
    if (!joriy || !oyna || oyna.hidden) return;
    const ms = new Date(joriy.expiresAt).getTime() - Date.now();
    const el = oyna.querySelector('[data-ss-qoldi]');
    if (el) el.textContent = qoldiMatn(ms);
    oyna.querySelector('.ss-soat')?.classList.toggle('shoshil', ms < 3 * 60_000);
    if (ms <= 0) { yop(); toast('So‘rov muddati tugadi'); }
  }
  setInterval(taymer, 1000);

  async function post(yol) {
    try {
      const r = await fetch(yol, { method: 'POST' });
      return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
    } catch {
      return { ok: false, status: 0, data: { error: 'Internet aloqasini tekshiring' } };
    }
  }

  async function qabul(s, btn) {
    btn.disabled = true;
    ovozToxtat();
    const r = await post(`/api/trial/${s.requestId}/accept`);
    btn.disabled = false;
    if (!r.ok) {
      yop();
      return toast(r.data.message || r.data.error || 'Qabul qilib bo‘lmadi');
    }
    navbat = navbat.filter((x) => x.requestId !== s.requestId);
    keyingiQadamlar(r.data.booking || {});
  }

  // Qabul qilingach: qo'ng'iroq qilish va o'quvchini botga yo'naltirish
  function keyingiQadamlar(b) {
    const tel = b.leadPhone ? `<a href="tel:${esc(String(b.leadPhone).replace(/[^\d+]/g, ''))}">${esc(b.leadPhone)}</a>` : '';
    oyna.innerHTML = `
      <div class="ss-yuqori" style="animation:none">Sinov darsi sizniki</div>
      <h2>${esc(b.leadName || 'O‘quvchi')}</h2>
      <div class="ss-vaqt">${esc(vaqtYorliq(b.startsAt || joriy?.startsAt))}</div>
      <div class="ss-qadam sariq"><b>1. Hozir o‘quvchiga qo‘ng‘iroq qiling</b>${tel ? tel + ' — ' : ''}o‘quvchi real ekanini va vaqt aniqligini bilib oling.${b.confirmPending ? ' Slot Work bo‘limida sariq bo‘lib turadi — gaplashgach tasdiqlang.' : ''}</div>
      <div class="ss-qadam"><b>2. Telegram botga kirishini so‘rang</b>Telegramda <b style="display:inline">${TG_BOT}</b> ni qidirib, <b style="display:inline">Start</b> bossin — bot unga ilova havolasi va dars eslatmalarini o‘zi yuboradi.</div>
      <div style="flex:1"></div>
      <button class="ss-qabul" type="button" data-ss-yop>Tushunarli</button>`;
    oyna.querySelector('[data-ss-yop]').onclick = yop;
  }

  async function rad(s, btn) {
    if (!confirm('Rad etsangiz reytingingizga ta’sir qiladi. Rad etasizmi?')) return;
    btn.disabled = true;
    const r = await post(`/api/trial/${s.requestId}/decline`);
    btn.disabled = false;
    navbat = navbat.filter((x) => x.requestId !== s.requestId);
    yop();
    if (!r.ok) toast(r.data.message || r.data.error || 'Rad etib bo‘lmadi');
  }

  async function tekshir() {
    if (document.visibilityState !== 'visible') return;
    let d;
    try {
      const r = await fetch('/api/trial/incoming');
      if (!r.ok) return; // kirilmagan yoki mentor emas — jim
      d = await r.json();
    } catch { return; }
    navbat = Array.isArray(d) ? d : [];
    // Boshqa mentor olib bo'lgan yoki muddati tugagan bo'lsa — oynani yopamiz
    if (joriy && oyna && !oyna.hidden && oyna.querySelector('[data-ss-qabul]') && !navbat.some((x) => x.requestId === joriy.requestId)) {
      yop();
      toast('So‘rovni boshqa ustoz oldi yoki muddati tugadi');
    }
    const yangi = navbat.find((x) => !korilgan.has(x.requestId) && new Date(x.expiresAt) > Date.now());
    if (yangi && (!oyna || oyna.hidden)) och(yangi);
  }

  const boshla = () => {
    tekshir();
    setInterval(tekshir, 8000);
    document.addEventListener('visibilitychange', tekshir);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boshla);
  else boshla();
})();
