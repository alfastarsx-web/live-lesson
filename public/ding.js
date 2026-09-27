'use strict';
/*
 * Kichik quvonchlar: ball qo'shilganda yoki prioritet ko'tarilganda yengil "ding",
 * yangi nishon olinganda tabrik oynasi. Ovoz fayl emas — Web Audio bilan yasaladi.
 *
 *   ding()                       — bitta yoqimli ding
 *   ballKuzat(bugungiBall, el)   — oxirgi ko'rilgandan ko'p bo'lsa ding + "+N"
 *   prioritetKuzat(qiymat)       — ko'tarilgan bo'lsa ding
 *   nishonTabrik(nishonlar)      — yangi nishonlar uchun oyna (birin-ketin)
 */
(function () {
  let ctx = null;
  const audio = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = ctx || new AC();
    return ctx;
  };
  const oqi = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const yoz = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ixtiyoriy */ } };

  function chal(fn) {
    const a = audio();
    if (!a) return;
    if (a.state === 'running') return fn(a);
    a.resume().then(() => (a.state === 'running' ? fn(a) : kutTeginish(fn))).catch(() => kutTeginish(fn));
  }
  function kutTeginish(fn) {
    const bir = () => {
      document.removeEventListener('pointerdown', bir, true);
      const a = audio();
      if (a) a.resume().then(() => fn(a)).catch(() => {});
    };
    document.addEventListener('pointerdown', bir, true);
  }

  /** Yengil qo'ng'iroqcha: ikki garmonika, tez so'nadi */
  window.ding = function ding(baland = false) {
    chal((a) => {
      const t = a.currentTime + 0.02;
      const notalar = baland ? [1318.5, 1760] : [1046.5, 1568];
      notalar.forEach((hz, i) => {
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = 'sine';
        o.frequency.value = hz;
        const bosh = t + i * 0.09;
        g.gain.setValueAtTime(0.0001, bosh);
        g.gain.exponentialRampToValueAtTime(0.18, bosh + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, bosh + 0.9);
        o.connect(g).connect(a.destination);
        o.start(bosh);
        o.stop(bosh + 1);
      });
    });
    if (navigator.vibrate) navigator.vibrate(18);
  };

  const css = document.createElement('style');
  css.textContent = `
.ding-plus{position:fixed;z-index:95;font:800 18px/1 'Manrope',system-ui,sans-serif;color:#1f6f5c;pointer-events:none;
  animation:dingUch 1.4s cubic-bezier(.2,.8,.3,1) forwards;text-shadow:0 2px 8px rgba(255,255,255,.9)}
@keyframes dingUch{0%{opacity:0;transform:translateY(8px) scale(.8)}15%{opacity:1;transform:translateY(0) scale(1.1)}100%{opacity:0;transform:translateY(-46px) scale(1)}}
.nishon-oyna{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(18,63,53,.55);backdrop-filter:blur(4px)}
.nishon-oyna .q{background:#fff;border-radius:24px;padding:26px 22px 20px;max-width:320px;width:100%;text-align:center;font-family:'Manrope',system-ui,sans-serif;
  animation:nishonKir .45s cubic-bezier(.2,.9,.3,1.3) both}
.nishon-oyna .belgi-n{width:96px;height:96px;margin:0 auto 10px;border-radius:50%;display:grid;place-items:center;font-size:52px;
  background:radial-gradient(circle at 35% 30%,#fff7d6,#f7c873 70%);box-shadow:0 10px 30px rgba(240,167,58,.45),inset 0 -4px 0 rgba(0,0,0,.06)}
.nishon-oyna small{font-size:11.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#b7761c}
.nishon-oyna h3{margin:4px 0 6px;font-size:22px;color:#1f2a27}
.nishon-oyna p{margin:0;font-size:13.5px;color:#5f6864}
.nishon-oyna button{margin-top:16px;width:100%;border:0;border-radius:14px;padding:13px;font-family:inherit;font-weight:800;font-size:15px;background:#1f6f5c;color:#fff;cursor:pointer}
@keyframes nishonKir{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.ding-plus,.nishon-oyna .q{animation:none}}`;
  document.head.appendChild(css);

  function plusChiz(n, el) {
    const d = document.createElement('div');
    d.className = 'ding-plus';
    d.textContent = `+${n}`;
    const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2 - 20, top: 120, width: 40 };
    d.style.left = `${r.left + r.width / 2 - 16}px`;
    d.style.top = `${r.top - 6}px`;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1500);
  }

  /** Bugungi ball oxirgi ko'rilgandan ko'p bo'lsa — ding va "+N" */
  window.ballKuzat = function ballKuzat(ball, el, kun) {
    const k = `ding:ball:${kun || new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)}`;
    const oldin = oqi(k);
    yoz(k, String(ball));
    if (oldin === null) return;
    const farq = ball - Number(oldin);
    if (farq > 0) {
      ding();
      plusChiz(farq, el);
    }
  };

  window.prioritetKuzat = function prioritetKuzat(qiymat) {
    const oldin = oqi('ding:prioritet');
    yoz('ding:prioritet', String(qiymat));
    if (oldin !== null && qiymat > Number(oldin)) ding(true);
  };

  /** Yangi nishonlar — birin-ketin oyna, oxirida "ko'rildi" */
  let korsatilmoqda = false;
  const korildi = new Set();
  window.nishonTabrik = async function nishonTabrik(nishonlar) {
    const yangi = (nishonlar || []).filter((b) => b.isNew && !korildi.has(b.code));
    if (!yangi.length || korsatilmoqda) return;
    korsatilmoqda = true;
    yangi.forEach((b) => korildi.add(b.code));
    // Darhol "ko'rildi" — sahifa qayta so'rasa ham tabrik takrorlanmaydi
    fetch('/api/ai/mentor-gamification/badges/seen', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    for (const b of yangi) {
      await new Promise((tayyor) => {
        const o = document.createElement('div');
        o.className = 'nishon-oyna';
        o.setAttribute('role', 'dialog');
        o.setAttribute('aria-modal', 'true');
        o.innerHTML = `<div class="q"><div class="belgi-n" aria-hidden="true">${b.emoji}</div>
          <small>Yangi nishon</small><h3></h3><p></p><button type="button">Zo‘r!</button></div>`;
        o.querySelector('h3').textContent = b.name;
        o.querySelector('p').textContent = b.done || b.how;
        document.body.appendChild(o);
        ding(true);
        setTimeout(() => ding(), 260);
        const btn = o.querySelector('button');
        btn.focus();
        btn.onclick = () => { o.remove(); tayyor(); };
      });
    }
    korsatilmoqda = false;
  };
})();
