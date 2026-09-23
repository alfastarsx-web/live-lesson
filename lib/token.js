'use strict';
/*
 * Dars xonasiga kirish tokeni (HS256, JWT ko'rinishida — tashqi kutubxonasiz).
 *
 * Tokenni MyTeacher backend'i imzolaydi, bu server faqat tekshiradi.
 * Claims: { room, role, name, exp }
 *   room — xona nomi (dars id), role — 'teacher' | 'student', name — ko'rinadigan ism
 *
 * LESSON_TOKEN_SECRET berilmagan bo'lsa token talab qilinmaydi (lokal ishlab chiqish rejimi).
 */

const crypto = require('crypto');

const SECRET = process.env.LESSON_TOKEN_SECRET || '';
const AUTH_ON = SECRET.length > 0;

// UUID ham sig'sin: "mentor-550e8400-e29b-41d4-a716-446655440000" = 43 belgi
const ROOM_RE = /^[a-z0-9-]{3,64}$/;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(claims, ttlSec = 3 * 3600) {
  if (!AUTH_ON) throw new Error('LESSON_TOKEN_SECRET yo‘q');
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + ttlSec };
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function verify(token) {
  if (!AUTH_ON || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [h, p, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  if (!ROOM_RE.test(String(payload.room || ''))) return null;

  return {
    room: String(payload.room),
    role: payload.role === 'teacher' ? 'teacher' : 'student',
    name: String(payload.name || '').slice(0, 40),
    lessonId: typeof payload.lessonId === 'string' ? payload.lessonId : null,
    bookingId: typeof payload.bookingId === 'string' ? payload.bookingId : null,
    userId: typeof payload.userId === 'string' ? payload.userId : null,
    exp: payload.exp,
  };
}

module.exports = { AUTH_ON, sign, verify, ROOM_RE };
