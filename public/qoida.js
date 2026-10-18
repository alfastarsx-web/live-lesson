// Qat'iy qoida kartasi: ustoz "Tushunarli, qabul qildim" bosmaguncha ko'rinadi.
// Qabul serverda saqlanadi (vaqti va matn versiyasi) — boshqa qurilmada ham qayta chiqmaydi.
(function () {
  const karta = document.getElementById('qoidaOgoh');
  const tugma = document.getElementById('qoidaQabul');
  if (!karta || !tugma) return;

  fetch('/api/qoida', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d && d.qabul === false) karta.hidden = false; })
    .catch(() => {});

  tugma.onclick = async () => {
    tugma.disabled = true;
    try {
      const r = await fetch('/api/qoida', { method: 'POST', credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.qabul) {
        karta.hidden = true;
        return;
      }
    } catch { /* pastda */ }
    tugma.disabled = false;
    tugma.textContent = 'Saqlab bo‘lmadi — qayta bosing';
  };
})();
