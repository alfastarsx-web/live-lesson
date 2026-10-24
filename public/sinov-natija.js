'use strict';
/*
 * Sinov natijasi — ustoz har bir o'tgan sinov darsidan keyin natijani izoh bilan kiritadi:
 * ✅ To'lashga rozi (to'lash sanasi majburiy), 🤔 O'ylamoqda (aniq javob sanasi majburiy),
 * ❌ Qiziqmadi, 📵 Bog'lanib bo'lmadi. Dars tugaganiga 1 soatdan oshib kiritilmasa —
 * natija kiritilmaguncha yangi sinov so'rovlari kelmaydi (server tomonda).
 *
 * Sahifada <main> bo'lsa — tepasiga karta, bo'lmasa — pastda tugma. Kechikkan bo'lsa oyna o'zi ochiladi.
 */
(function () {
  if (window.__sinovNatija) return;
  window.__sinovNatija = true;

  const NATIJALAR = [
    { k: 'rozi', t: '✅ To‘lashga rozi', sana: 'To‘lash sanasi', izoh: 'Qaysi kurs, qancha va qanday to‘lashini yozing' },
    { k: 'oylamoqda', t: '🤔 O‘ylamoqda', sana: 'Aniq javob beradigan sana', izoh: 'Masalan: xo‘jayinidan so‘rab, payshanba kuni aytadi' },
    { k: 'qiziqmadi', t: '❌ Qiziqmadi', sana: null, izoh: 'Nega qiziqmadi? (narx, vaqt, boshqa joyda o‘qiydi…)' },
    { k: 'boglanmadi', t: '📵 Bog‘lanib bo‘lmadi', sana: null, izoh: 'Necha marta qo‘ng‘iroq qildingiz, qanday javob bo‘ldi?' },
  ];

  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Toshkent kuni (YYYY-MM-DD), bugundan n kun keyin
  const kun = (n = 0) => new Date(Date.now() + 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
  const vaqt = (iso) => {
    const d = new Date(new Date(iso).getTime() + 5 * 3600e3);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };
  const xabar = (m) => {
    const t = document.createElement('div');
    t.setAttribute('role', 'status');
    t.textContent = m;
    t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1f2a27;color:#fff;padding:10px 16px;border-radius:12px;font-family:inherit;font-weight:600;font-size:14px;line-height:1.4;z-index:10001;max-width:90vw;text-align:center';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  };

  const uslub = document.createElement('style');
  uslub.textContent = `
  .sn-karta{display:flex;align-items:center;gap:12px;border-radius:18px;padding:14px 16px;margin:0 0 12px;cursor:pointer;border:0;width:100%;text-align:left;font:inherit;color:#1f2a27}
  .sn-karta.ogoh{background:#fdf1dc;box-shadow:0 0 0 1px #f3d9a8}
  .sn-karta.qizil{background:#fce9e5;box-shadow:0 0 0 1.5px #e8715f}
  .sn-karta b{display:block;font-size:15px}
  .sn-karta small{display:block;font-size:12.5px;color:#5f6864;margin-top:2px}
  .sn-karta .sn-n{margin-left:auto;font-weight:800;background:#fff;border-radius:999px;padding:4px 10px;font-size:13px}
  .sn-puls{width:10px;height:10px;border-radius:50%;background:#e8715f;flex-shrink:0;animation:snPuls 1.4s infinite}
  @keyframes snPuls{0%{box-shadow:0 0 0 0 rgba(232,113,95,.6)}70%{box-shadow:0 0 0 9px rgba(232,113,95,0)}100%{box-shadow:0 0 0 0 rgba(232,113,95,0)}}
  .sn-fon{position:fixed;inset:0;background:rgba(18,30,26,.45);z-index:10000;display:flex;align-items:flex-end;justify-content:center}
  .sn-oyna{background:#fff;width:100%;max-width:520px;border-radius:22px 22px 0 0;padding:18px 16px calc(16px + env(safe-area-inset-bottom));max-height:92vh;overflow:auto;font:14px/1.45 'Manrope',system-ui,sans-serif;color:#1f2a27}
  .sn-oyna h3{margin:0 0 2px;font-size:17px}
  .sn-oyna .sn-kim{color:#5f6864;font-size:13px;margin-bottom:12px}
  .sn-tanlov{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
  .sn-tanlov button{border:1.5px solid #e6e8e2;background:#fff;border-radius:14px;padding:12px 10px;font-family:inherit;font-weight:600;font-size:14px;cursor:pointer;text-align:left;color:#1f2a27}
  .sn-tanlov button[aria-pressed="true"]{border-color:#1f6f5c;background:#e2f2ec}
  .sn-yorliq{font-size:12.5px;font-weight:800;color:#5f6864;margin:4px 0 6px}
  .sn-chiplar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .sn-chiplar button{border:0;background:#f0f1ec;border-radius:999px;padding:6px 12px;font-family:inherit;font-weight:600;font-size:13px;cursor:pointer;color:#1f2a27}
  .sn-chiplar button[aria-pressed="true"]{background:#1f6f5c;color:#fff}
  .sn-oyna input[type=date],.sn-oyna textarea{width:100%;box-sizing:border-box;border:1.5px solid #e6e8e2;border-radius:12px;padding:10px 12px;font-family:inherit;font-size:15px;color:#1f2a27;margin-bottom:10px;background:#fff}
  .sn-oyna textarea{min-height:84px;resize:vertical}
  .sn-tugmalar{display:flex;gap:8px;margin-top:4px}
  .sn-tugmalar button{flex:1;border:0;border-radius:13px;padding:12px;font-family:inherit;font-weight:800;font-size:14px;cursor:pointer}
  .sn-saqla{background:#1f6f5c;color:#fff} .sn-saqla:disabled{opacity:.5}
  .sn-keyin{background:#f0f1ec;color:#1f2a27}
  .sn-ogoh{background:#fce9e5;color:#9b3424;border-radius:12px;padding:8px 12px;font-size:13px;margin-bottom:12px}
  .sn-pastki{position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:9999;border:0;border-radius:999px;padding:12px 18px;font-family:inherit;font-weight:800;font-size:14px;background:#e8715f;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);cursor:pointer}
  `;
  document.head.appendChild(uslub);

  let holat = null;
  let avtoOchildi = false;

  async function yukla() {
    try {
      const r = await fetch('/api/ai/trial-natija/mentor', { credentials: 'same-origin' });
      if (!r.ok) return;
      holat = await r.json();
    } catch { return; }
    chiz();
    if (holat.bloklangan && holat.items.length && !avtoOchildi) {
      avtoOchildi = true;
      och();
    }
  }

  function chiz() {
    document.querySelectorAll('.sn-karta,.sn-pastki').forEach((x) => x.remove());
    if (!holat || !holat.items.length) return;
    const n = holat.items.length;
    const main = document.querySelector('main');
    if (main) {
      const k = document.createElement('button');
      k.type = 'button';
      k.className = `sn-karta ${holat.bloklangan ? 'qizil' : 'ogoh'}`;
      k.innerHTML = `${holat.bloklangan ? '<span class="sn-puls" aria-hidden="true"></span>' : '<span aria-hidden="true" style="font-size:20px">📝</span>'}
        <span><b>Sinov natijasini kiriting</b><small>${holat.bloklangan
          ? 'Natija kiritilmaguncha sizga yangi sinov so‘rovlari kelmaydi — 1 daqiqa vaqt oladi 🙏'
          : `Dars tugagach ${holat.kutishDaq} daqiqa ichida kiriting — admin o‘quvchini kuzatib boradi`}</small></span>
        <span class="sn-n">${n} ta</span>`;
      k.onclick = och;
      const birinchi = main.querySelector('header, .salom');
      if (birinchi && birinchi.nextSibling) main.insertBefore(k, birinchi.nextSibling);
      else main.prepend(k);
    } else {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'sn-pastki';
      t.textContent = `📝 Sinov natijasini kiriting · ${n}`;
      t.onclick = och;
      document.body.appendChild(t);
    }
  }

  function och() {
    if (!holat || !holat.items.length) return;
    const s = holat.items[0];
    let tanlov = null;
    const fon = document.createElement('div');
    fon.className = 'sn-fon';
    fon.innerHTML = `<div class="sn-oyna" role="dialog" aria-modal="true" aria-labelledby="snS">
      <h3 id="snS">Sinov darsi qanday yakunlandi?</h3>
      <div class="sn-kim">${esc(s.ism)} · ${esc(vaqt(s.startsAt))}${holat.items.length > 1 ? ` · yana ${holat.items.length - 1} ta kutmoqda` : ''}</div>
      ${holat.bloklangan ? '<div class="sn-ogoh">Natija kiritilmaguncha yangi sinov so‘rovlari kelmaydi. Kiritgach darhol yana ochiladi.</div>' : ''}
      <div class="sn-tanlov">${NATIJALAR.map((x) => `<button type="button" data-k="${x.k}" aria-pressed="false">${x.t}</button>`).join('')}</div>
      <div class="sn-sana" hidden>
        <div class="sn-yorliq" id="snSanaY"></div>
        <div class="sn-chiplar">
          <button type="button" data-n="1" aria-pressed="false">Ertaga</button>
          <button type="button" data-n="2" aria-pressed="false">Indinga</button>
          <button type="button" data-n="3" aria-pressed="false">3 kundan keyin</button>
          <button type="button" data-n="7" aria-pressed="false">Bir haftada</button>
        </div>
        <input type="date" id="snSana" min="${kun()}" max="${kun(holat.sanaMaxKun || 30)}">
      </div>
      <div class="sn-yorliq">Izoh</div>
      <textarea id="snIzoh" maxlength="1000" placeholder="Avval natijani tanlang"></textarea>
      <div class="sn-tugmalar">
        <button type="button" class="sn-keyin">Keyinroq</button>
        <button type="button" class="sn-saqla" disabled>Saqlash</button>
      </div>
    </div>`;
    document.body.appendChild(fon);
    const $ = (q) => fon.querySelector(q);
    const saqlaT = $('.sn-saqla');
    const tekshir = () => {
      const x = NATIJALAR.find((n) => n.k === tanlov);
      saqlaT.disabled = !x || $('#snIzoh').value.trim().length < 3 || (x.sana && !$('#snSana').value);
    };
    fon.querySelectorAll('.sn-tanlov button').forEach((b) => {
      b.onclick = () => {
        tanlov = b.dataset.k;
        fon.querySelectorAll('.sn-tanlov button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        const x = NATIJALAR.find((n) => n.k === tanlov);
        $('.sn-sana').hidden = !x.sana;
        if (x.sana) $('#snSanaY').textContent = `${x.sana} (majburiy)`;
        $('#snIzoh').placeholder = x.izoh;
        tekshir();
      };
    });
    fon.querySelectorAll('.sn-chiplar button').forEach((b) => {
      b.onclick = () => {
        $('#snSana').value = kun(Number(b.dataset.n));
        fon.querySelectorAll('.sn-chiplar button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        tekshir();
      };
    });
    $('#snSana').oninput = () => {
      fon.querySelectorAll('.sn-chiplar button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      tekshir();
    };
    $('#snIzoh').oninput = tekshir;
    const yop = () => fon.remove();
    // Yopsa ham bo'ladi (masalan, darsga kirishi kerak) — bloklash serverda, qizil karta tepada qoladi
    $('.sn-keyin').onclick = yop;
    fon.addEventListener('click', (e) => { if (e.target === fon) yop(); });

    saqlaT.onclick = async () => {
      const x = NATIJALAR.find((n) => n.k === tanlov);
      saqlaT.disabled = true;
      saqlaT.textContent = 'Saqlanmoqda…';
      try {
        const r = await fetch('/api/ai/trial-natija/mentor', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookingId: s.bookingId, natija: tanlov, sana: x.sana ? $('#snSana').value : undefined, izoh: $('#snIzoh').value.trim() }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const m = Array.isArray(j.message) ? j.message[0] : j.message || j.error;
          xabar(`Kechirasiz, saqlanmadi: ${m || 'qayta urinib ko‘ring'} 🙏`);
          saqlaT.disabled = false;
          saqlaT.textContent = 'Saqlash';
          return;
        }
        yop();
        xabar('✅ Rahmat! Natija saqlandi');
        await yukla();
        if (holat && holat.items.length) och();
      } catch {
        xabar('Internet bilan muammo — qayta urinib ko‘ring 🙏');
        saqlaT.disabled = false;
        saqlaT.textContent = 'Saqlash';
      }
    };
  }

  const boshla = () => {
    yukla();
    // Sahifaga qaytganda (dars tugab, ilovaga qaytdi) — qayta tekshiramiz
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') yukla(); });
    setInterval(() => { if (document.visibilityState === 'visible') yukla(); }, 5 * 60e3);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boshla);
  else boshla();
})();
