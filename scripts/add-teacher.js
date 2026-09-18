#!/usr/bin/env node
'use strict';
const { add } = require('../lib/teachers');

const [login, password, name, room] = process.argv.slice(2);
if (!login || !password) {
  console.error('Foydalanish: node scripts/add-teacher.js <login> <parol> "<Ism>" [xona]');
  process.exit(1);
}
const rec = add({ login, password, name, room });
console.log(`Ustoz qo'shildi: ${rec.login} (${rec.name}) -> xona "${rec.room}"`);
console.log(`O'quvchi havolasi: /dars/${rec.room}`);
