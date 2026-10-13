'use strict';
/*
 * Brauzer versiyasi (Mentor ilovasisiz): sahifalarni telefonga "ilova" qilib o'rnatish (PWA).
 * - manifest + service worker: Chrome "Ilovani o'rnatish" taklif qiladi, bosh ekranda ikonka chiqadi;
 * - pastki menyu Bosh | Work | Career — ilovada bu tablar native, brauzerda esa shu yerda;
 * - "📲 Ilovani o'rnatish" tugmasi (brauzer ruxsat bergan bo'lsa).
 * Mentor ilovasi (WebView) ichida hech narsa qilmaydi.
 */
(function () {
  const ilovada = () => {
    if (window.MyTeacher?.postMessage || window.flutter_inappwebview) return true;
    try {
      return (typeof window.ilovadami === 'function' && window.ilovadami()) || sessionStorage.getItem('ll_ilova') === '1';
    } catch { return false; }
  };
  if (ilovada()) return;

  const head = document.head;
  const qosh = (tag, attrs) => {
    if (attrs.rel && head.querySelector(`${tag}[rel="${attrs.rel}"]`)) return;
    if (attrs.name && head.querySelector(`${tag}[name="${attrs.name}"]`)) return;
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    head.appendChild(el);
  };
  qosh('link', { rel: 'manifest', href: '/manifest.webmanifest' });
  qosh('link', { rel: 'apple-touch-icon', href: '/img/pwa/apple-180.png' });
  qosh('meta', { name: 'theme-color', content: '#1f6f5c' });
  qosh('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  qosh('meta', { name: 'apple-mobile-web-app-title', content: 'Mentor' });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const yol = location.pathname.replace(/\/$/, '') || '/';
  const MENTOR_SAHIFA = /^\/(home|work|oquvchilar|jadval|daromad|career)(\.html)?$|^\/mentor\/(yol|liga|qollanma)(\.html)?$/;
  const menyu = MENTOR_SAHIFA.test(yol);
  const faol = /^\/home/.test(yol) ? 'home' : /^\/(career|mentor\/)/.test(yol) ? 'career' : 'work';

  const css = document.createElement('style');
  css.textContent = `
.pwa-nav{position:fixed;left:0;right:0;bottom:0;z-index:35;display:grid;grid-template-columns:repeat(3,1fr);
  background:#fff;border-top:1px solid #e6e8e2;padding:6px 8px calc(6px + env(safe-area-inset-bottom));
  box-shadow:0 -4px 16px rgba(15,23,42,.06);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.pwa-nav a{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 0;text-decoration:none;
  color:#8f9793;font-size:11.5px;font-weight:700;border-radius:12px}
.pwa-nav a svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pwa-nav a[aria-current="page"]{color:#1f6f5c}
.pwa-nav a:focus-visible{outline:2px solid #1f6f5c;outline-offset:2px}
body.pwa-menyu{padding-bottom:calc(64px + env(safe-area-inset-bottom)) !important}
/* Sahifaning o'z pastki panellari va xabarlari menyu ustida tursin (oynalar — menyudan yuqori z-index) */
body.pwa-menyu .saqla-bar{bottom:calc(62px + env(safe-area-inset-bottom)) !important}
body.pwa-menyu .toast{bottom:calc(80px + env(safe-area-inset-bottom)) !important}
.pwa-ornat{position:fixed;left:50%;transform:translateX(-50%);z-index:901;display:flex;align-items:center;gap:8px;
  bottom:calc(14px + env(safe-area-inset-bottom));background:#1f6f5c;color:#fff;border-radius:999px;
  padding:6px 6px 6px 16px;box-shadow:0 8px 24px rgba(31,111,92,.35);font:700 14px system-ui,sans-serif;white-space:nowrap}
body.pwa-menyu .pwa-ornat{bottom:calc(74px + env(safe-area-inset-bottom))}
.pwa-ornat button{border:0;border-radius:999px;font:inherit;cursor:pointer;padding:8px 12px}
.pwa-ornat .ha{background:#fff;color:#1f6f5c}
.pwa-ornat .yoq{background:transparent;color:#fff;opacity:.8;padding:8px}`;
  head.appendChild(css);

  function menyuQoy() {
    if (!menyu || document.querySelector('.pwa-nav')) return;
    const nav = document.createElement('nav');
    nav.className = 'pwa-nav';
    nav.setAttribute('aria-label', 'Asosiy bo‘limlar');
    const tab = (k, href, matn, svg) =>
      `<a href="${href}"${faol === k ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>${matn}</a>`;
    nav.innerHTML =
      tab('home', '/home.html', 'Bosh', '<path d="M4 11l8-7 8 7v8a1 1 0 01-1 1h-4v-6h-6v6H5a1 1 0 01-1-1z"/>') +
      tab('work', '/work.html', 'Work', '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 012-2h4a2 2 0 012 2v2"/>') +
      tab('career', '/career.html', 'Career', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>');
    document.body.appendChild(nav);
    document.body.classList.add('pwa-menyu');
  }

  // O'rnatish taklifi: brauzer ruxsat bergan bo'lsa (Chrome / Android), rad etilsa 7 kun so'ramaymiz
  const KALIT = 'pwa_ornat_yopildi';
  const yopilgan = () => { try { return Date.now() - Number(localStorage.getItem(KALIT) || 0) < 7 * 864e5; } catch { return false; } };
  const ornatilgan = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  let taklif = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    taklif = e;
    if (yopilgan() || ornatilgan()) return;
    const tugmaQoy = () => {
      if (document.querySelector('.pwa-ornat')) return;
      const t = document.createElement('div');
      t.className = 'pwa-ornat';
      t.setAttribute('role', 'region');
      t.setAttribute('aria-label', 'Ilovani o‘rnatish');
      t.innerHTML = '📲 Telefonga o‘rnating <button type="button" class="ha">O‘rnatish</button><button type="button" class="yoq" aria-label="Yopish">✕</button>';
      t.querySelector('.ha').onclick = async () => {
        t.remove();
        if (!taklif) return;
        taklif.prompt();
        const r = await taklif.userChoice.catch(() => null);
        taklif = null;
        if (r && r.outcome !== 'accepted') { try { localStorage.setItem(KALIT, String(Date.now())); } catch { /* */ } }
      };
      t.querySelector('.yoq').onclick = () => {
        t.remove();
        try { localStorage.setItem(KALIT, String(Date.now())); } catch { /* */ }
      };
      document.body.appendChild(t);
    };
    if (document.body) tugmaQoy(); else document.addEventListener('DOMContentLoaded', tugmaQoy);
  });
  window.addEventListener('appinstalled', () => document.querySelector('.pwa-ornat')?.remove());

  if (document.body) menyuQoy(); else document.addEventListener('DOMContentLoaded', menyuQoy);
})();
