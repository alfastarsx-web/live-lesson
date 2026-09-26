'use strict';
/*
 * Sinovdan o'quvchi bo'lganda tabrik: mushakbozlik + ovoz.
 * Home, Work va Daromad sahifalari ochilganda ko'rilmagan tabriklarni so'raydi
 * (/api/wallet/celebrations). Har tabrik bir marta ko'rsatiladi.
 *
 * Ovoz fayl emas — Web Audio bilan shu yerda yasaladi (portlash va kichik kuy).
 * WebView ovozni teginishsiz bloklasa, birinchi teginishda chalinadi.
 */
(function () {
  const pul = (n) => {
    const v = Math.abs(Number(n) || 0);
    return v.toLocaleString('ru-RU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).replace(/\s/g, ' ');
  };
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kamHarakat = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const css = document.createElement('style');
  css.textContent = `
.tabrik{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;
  background:radial-gradient(120% 80% at 50% 0%,#1f6f5c 0%,#123f35 60%,#0c2a24 100%);color:#fff;font-family:inherit}
.tabrik canvas{position:absolute;inset:0;width:100%;height:100%}
.tabrik .quti{position:relative;max-width:360px;width:100%;text-align:center;animation:tabrikKir .5s cubic-bezier(.2,.9,.3,1.3) both}
.tabrik .tb-belgi{font-size:56px;line-height:1;margin-bottom:10px}
.tabrik small{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#c8f07a}
.tabrik h2{margin:8px 0 6px;font-size:26px;line-height:1.2;letter-spacing:-.5px;text-wrap:balance}
.tabrik p{margin:0;color:#cfe8df;font-size:15px}
.tabrik .bonus{margin:18px 0 10px;background:rgba(200,240,122,.14);border:1px solid rgba(200,240,122,.35);border-radius:18px;padding:14px}
.tabrik .bonus b{display:block;font-size:30px;letter-spacing:-1px;color:#c8f07a;font-variant-numeric:tabular-nums}
.tabrik .bonus span{font-size:13px;color:#e4f5ee}
.tabrik .oylik{background:rgba(255,255,255,.08);border-radius:14px;padding:11px;font-size:14px;color:#e4f5ee}
.tabrik .oylik b{color:#fff;font-variant-numeric:tabular-nums}
.tabrik button{margin-top:18px;width:100%;border:0;border-radius:16px;padding:15px;font-weight:800;font-size:16px;font-family:inherit;background:#c8f07a;color:#123f35;cursor:pointer}
.tabrik button:focus-visible{outline:3px solid #fff;outline-offset:3px}
@keyframes tabrikKir{from{opacity:0;transform:scale(.85) translateY(20px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.tabrik .quti{animation:none}}`;
  document.head.appendChild(css);

  // ---------- ovoz ----------
  let ctx = null;
  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    return ctx;
  }
  function portlash(t, kuch = 1) {
    const a = audio();
    if (!a) return;
    const len = Math.floor(a.sampleRate * 0.6);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3000, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.5);
    const g = a.createGain();
    g.gain.setValueAtTime(0.5 * kuch, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(f).connect(g).connect(a.destination);
    src.start(t);
    // chirsillash
    for (let i = 0; i < 6; i++) {
      const o = a.createOscillator();
      const og = a.createGain();
      const tt = t + 0.15 + Math.random() * 0.4;
      o.type = 'square';
      o.frequency.value = 2000 + Math.random() * 3000;
      og.gain.setValueAtTime(0.03 * kuch, tt);
      og.gain.exponentialRampToValueAtTime(0.0001, tt + 0.04);
      o.connect(og).connect(a.destination);
      o.start(tt);
      o.stop(tt + 0.05);
    }
  }
  function kuy(t) {
    const a = audio();
    if (!a) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((hz, i) => {
      const o = a.createOscillator();
      const g = a.createGain();
      const tt = t + i * 0.11;
      o.type = 'triangle';
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.25, tt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + (i === 3 ? 0.9 : 0.3));
      o.connect(g).connect(a.destination);
      o.start(tt);
      o.stop(tt + 1);
    });
  }
  function chal() {
    const a = audio();
    if (!a) return;
    const boshla = () => {
      const t = a.currentTime + 0.05;
      kuy(t);
      [0.5, 0.9, 1.3, 1.9, 2.4].forEach((d, i) => portlash(t + d, i % 2 ? 0.7 : 1));
    };
    if (a.state === 'running') boshla();
    else a.resume().then(() => (a.state === 'running' ? boshla() : kutTeginish(boshla))).catch(() => kutTeginish(boshla));
  }
  function kutTeginish(fn) {
    const bir = () => {
      document.removeEventListener('pointerdown', bir, true);
      audio()?.resume().then(fn).catch(() => {});
    };
    document.addEventListener('pointerdown', bir, true);
  }

  // ---------- mushakbozlik ----------
  function mushak(canvas) {
    const c = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const o = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    o();
    window.addEventListener('resize', o);
    const RANG = ['#c8f07a', '#f0a73a', '#e8715f', '#ffffff', '#7fd6b9', '#f7c873'];
    const zarralar = [];
    let ish = true;
    let oxirgi = 0;
    const W = () => canvas.width;
    const H = () => canvas.height;
    function otish() {
      const x = W() * (0.15 + Math.random() * 0.7);
      const y = H() * (0.06 + Math.random() * 0.22);
      const rang = RANG[Math.floor(Math.random() * RANG.length)];
      const n = 60 + Math.floor(Math.random() * 30);
      for (let i = 0; i < n; i++) {
        const burchak = (Math.PI * 2 * i) / n;
        const tezlik = (2 + Math.random() * 3.5) * dpr;
        zarralar.push({ x, y, vx: Math.cos(burchak) * tezlik, vy: Math.sin(burchak) * tezlik, hayot: 1, rang, r: (1.5 + Math.random() * 1.5) * dpr });
      }
    }
    function qadam(t) {
      if (!ish) return;
      if (t - oxirgi > 450) {
        otish();
        oxirgi = t;
      }
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = 'rgba(0,0,0,0.22)';
      c.fillRect(0, 0, W(), H());
      c.globalCompositeOperation = 'lighter';
      for (let i = zarralar.length - 1; i >= 0; i--) {
        const p = zarralar[i];
        p.vx *= 0.985;
        p.vy = p.vy * 0.985 + 0.045 * dpr;
        p.x += p.vx;
        p.y += p.vy;
        p.hayot -= 0.012;
        if (p.hayot <= 0) {
          zarralar.splice(i, 1);
          continue;
        }
        c.globalAlpha = p.hayot;
        c.fillStyle = p.rang;
        c.beginPath();
        c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
      requestAnimationFrame(qadam);
    }
    otish();
    requestAnimationFrame(qadam);
    return () => {
      ish = false;
      window.removeEventListener('resize', o);
    };
  }

  function korsat(t, ism) {
    return new Promise((tayyor) => {
      const el = document.createElement('div');
      el.className = 'tabrik';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-labelledby', 'tabrikSarlavha');
      el.innerHTML = `${kamHarakat ? '' : '<canvas aria-hidden="true"></canvas>'}
        <div class="quti">
          <div class="tb-belgi" aria-hidden="true">🎉</div>
          <small>Tabriklaymiz${ism ? `, ${esc(ism)} ustoz` : ''}!</small>
          <h2 id="tabrikSarlavha">${esc(t.studentName)} endi sizning o‘quvchingiz</h2>
          <p>Sinov darsingiz natija berdi — o‘quvchi to‘lov qildi.</p>
          ${t.qualified && t.bonusNet ? `<div class="bonus"><b>+${pul(t.bonusNet)} so‘m</b><span>24 soat ichida to‘lov bonusi — darhol balansda, yechib olsa bo‘ladi</span></div>` : '<div style="height:14px"></div>'}
          <div class="oylik">Shu o‘quvchidan oyiga <b>~${pul(t.monthlyNet)} so‘m</b> hisobingizga tushadi</div>
          <button type="button">Rahmat!</button>
        </div>`;
      document.body.appendChild(el);
      const toxta = kamHarakat ? () => {} : mushak(el.querySelector('canvas'));
      chal();
      if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
      const btn = el.querySelector('button');
      btn.focus();
      btn.onclick = () => {
        toxta();
        el.remove();
        tayyor();
      };
    });
  }

  /** Ko'rilmagan tabriklarni birin-ketin ko'rsatadi */
  window.tabriklarniKorsat = async function (ism) {
    if (ism && ism.toLowerCase() === 'ustoz') ism = '';
    try {
      const r = await fetch('/api/wallet/celebrations', { credentials: 'same-origin' });
      if (!r.ok) return;
      const list = await r.json();
      if (!Array.isArray(list)) return;
      for (const t of list) {
        await korsat(t, ism);
        await fetch(`/api/wallet/celebrations/${t.id}/seen`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      }
    } catch {
      /* tabrik ixtiyoriy — sahifa ishlashiga xalaqit bermaydi */
    }
  };
})();
