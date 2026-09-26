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
.career-nav{position:sticky;top:0;z-index:30;background:var(--bg);
  padding:10px max(16px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left))}
.career-nav .ichi{max-width:720px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:2px;
  background:#f2f2ef;border-radius:14px;padding:4px;box-shadow:inset 0 0 0 1px var(--line)}
.career-nav a{text-align:center;padding:8px 2px;font-family:var(--display);font-size:13.5px;font-weight:700;
  color:var(--mute);text-decoration:none;border-radius:10px;white-space:nowrap}
.career-nav a[aria-current="page"]{background:var(--card);color:var(--text);box-shadow:0 0 0 1px var(--line)}
.career-nav a:focus-visible{outline:2px solid var(--brand);outline-offset:2px}`;
  document.head.appendChild(css);

  const nav = document.createElement('nav');
  nav.className = 'career-nav';
  nav.setAttribute('aria-label', 'Career bo‘limlari');
  nav.innerHTML = '<div class="ichi">' + TABLAR.map(([href, nom]) =>
    `<a href="${href}"${joriy === href ? ' aria-current="page"' : ''}>${nom}</a>`).join('') + '</div>';
  document.body.prepend(nav);
})();
