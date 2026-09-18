'use strict';
/*
 * ai.myteacher.uz dagi mavjud mentor hisoblari bilan kirish.
 *
 * Alohida parollar ro'yxatini yuritmaymiz — mentor o'zining telefon raqami va
 * paroli bilan kiradi. Bu yerda faqat tekshiramiz: parol to'g'rimi va bu odam
 * mentormi. Parol saqlanmaydi, faqat uzatiladi.
 */

const API = (process.env.AITEACHER_API || '').replace(/\/$/, '');
const AITEACHER_ON = API.length > 0;

// "901234567", "998901234567", "+998 90 123 45 67" — hammasi bir xil ko'rinishga keladi
function normalizePhone(v) {
  const d = String(v).replace(/[^\d]/g, '');
  if (d.length === 9) return `+998${d}`;
  if (d.length === 12 && d.startsWith('998')) return `+${d}`;
  return String(v).trim();
}

// Javob ichidan JWT ko'rinishidagi birinchi satrni topamiz (maydon nomi har xil bo'lishi mumkin)
function findJwt(obj, depth = 0) {
  if (!obj || depth > 6) return null;
  if (typeof obj === 'string') {
    return /^ey[\w-]+\.[\w-]+\.[\w-]+$/.test(obj) ? obj : null;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findJwt(v, depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    // avval "access" so'zi bor kalitlarni ko'ramiz — refresh tokenni olib qo'ymaslik uchun
    const keys = Object.keys(obj).sort((a, b) =>
      (b.toLowerCase().includes('access') ? 1 : 0) - (a.toLowerCase().includes('access') ? 1 : 0));
    for (const k of keys) { const r = findJwt(obj[k], depth + 1); if (r) return r; }
  }
  return null;
}

function jwtPayload(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch { return null; }
}

function collectRoles(...sources) {
  const out = [];
  for (const s of sources) {
    if (!s) continue;
    for (const key of ['role', 'roles', 'userRole', 'userRoles', 'type']) {
      const v = s[key];
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) out.push(...v.map(String));
    }
    if (s.user) out.push(...collectRoles(s.user));
  }
  return out.map((r) => r.toLowerCase());
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

/**
 * @returns {Promise<{ok:true, id, name, roles}|{ok:false, status, message}>}
 */
async function signIn(login, password) {
  if (!AITEACHER_ON) return { ok: false, status: 500, message: 'AITEACHER_API sozlanmagan' };

  const body = String(login).includes('@')
    ? { email: String(login).trim(), password }
    : { phoneNumber: normalizePhone(login), password };

  let r, data;
  try {
    r = await fetch(`${API}/auth/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, status: 502, message: 'Autentifikatsiya xizmatiga ulanib bo‘lmadi' };
  }

  if (!r.ok) {
    return { ok: false, status: 401, message: data.message || 'Login yoki parol noto‘g‘ri' };
  }

  const token = findJwt(data);
  const payload = token ? jwtPayload(token) : null;
  const user = data.user || data.data?.user || data.data || {};
  const roles = collectRoles(payload, data, user);

  // Diagnostika: parol/token emas, faqat tuzilma nomlari yoziladi
  const diag = () => console.warn('[aiteacher] javob kalitlari:', Object.keys(data),
    '| user kalitlari:', Object.keys(user || {}),
    '| token claim nomlari:', payload ? Object.keys(payload) : null,
    '| topilgan rollar:', roles);

  if (!roles.includes('mentor') && !roles.includes('admin')) {
    diag();
    return { ok: false, status: 403, message: 'Bu hisob mentor emas' };
  }

  const id = pick(payload || {}, ['sub', 'id', 'userId']) || pick(user, ['id', 'userId', '_id']);
  if (!id) {
    diag();
    return { ok: false, status: 502, message: 'Foydalanuvchi aniqlanmadi' };
  }

  const name = pick(user, ['firstName', 'name', 'fullName'])
    || pick(payload || {}, ['firstName', 'name', 'fullName'])
    || 'Ustoz';

  return { ok: true, id: String(id), name: String(name).slice(0, 40), roles };
}

module.exports = { AITEACHER_ON, signIn, normalizePhone, findJwt, jwtPayload, collectRoles };
