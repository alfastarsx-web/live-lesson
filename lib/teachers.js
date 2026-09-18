'use strict';
/*
 * Ustoz hisoblari — kichik JSON fayl. Ilova backend'i ulangunicha shu yetarli.
 * Parol scrypt bilan xeshlanadi, ochiq holda hech qayerda saqlanmaydi.
 *
 * Qo'shish: node scripts/add-teacher.js <login> <parol> "<Ism>" [xona]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.TEACHERS_FILE || path.join(__dirname, '..', 'teachers.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  fs.chmodSync(FILE, 0o600);
}

function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${key}`;
}

function check(password, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const a = Buffer.from(key, 'hex');
  const b = crypto.scryptSync(password, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function find(login) {
  const l = String(login || '').trim().toLowerCase();
  return load().find((t) => t.login === l) || null;
}

function add({ login, password, name, room }) {
  const list = load();
  const l = String(login).trim().toLowerCase();
  const rec = {
    login: l,
    pass: hash(password),
    name: name || l,
    room: (room || l).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
  };
  const i = list.findIndex((t) => t.login === l);
  if (i >= 0) list[i] = rec; else list.push(rec);
  save(list);
  return rec;
}

module.exports = { load, find, add, check, FILE };
