'use strict';
/*
 * Career bo'limi tablari: Umumiy | Yo'l | Liga | Akademiya.
 * Sahifaning o'z rang tokenlaridan foydalanadi (--card, --line, --brand, --mute, --display),
 * shuning uchun yorug' va qorong'i rejimda ham sahifa bilan bir xil ko'rinadi.
 * Akademiyada qo'yilmaydi — u yerda o'z qadam-baqadam paneli bor.
 */
(function () {
  const TABLAR = [
    ['/career.html', 'Umumiy'],
    ['/mentor/yol.html', 'Yo‘l'],
    ['/mentor/liga.html', 'Liga'],
    ['/mentor/akademiya.html', 'Akademiya'],
  ];
  const joriy = location.pathname.replace(/\/$/, '') || '/';

  const css = document.createElement('style');
  css.textContent = `
.career-nav{position:sticky;top:0;z-index:30;background:var(--card);border-bottom:1px solid var(--line);
  padding:8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left))}
.career-nav .ichi{max-width:720px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
.career-nav a{text-align:center;padding:9px 2px;font-family:var(--display);font-size:13.5px;font-weight:600;
  color:var(--mute);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap}
.career-nav a[aria-current="page"]{color:var(--brand);border-bottom-color:var(--brand)}
.career-nav a:focus-visible{outline:3px solid var(--gold, #FF9A1F);outline-offset:2px}`;
  document.head.appendChild(css);

  const nav = document.createElement('nav');
  nav.className = 'career-nav';
  nav.setAttribute('aria-label', 'Career bo‘limlari');
  nav.innerHTML = '<div class="ichi">' + TABLAR.map(([href, nom]) =>
    `<a href="${href}"${joriy === href ? ' aria-current="page"' : ''}>${nom}</a>`).join('') + '</div>';
  document.body.prepend(nav);
})();
