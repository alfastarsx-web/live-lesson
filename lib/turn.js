'use strict';
/*
 * TURN uchun vaqtinchalik (ephemeral) hisob ma'lumotlari — coturn REST API usuli.
 *
 * Doimiy login/parol klient JS'ida ochiq yotadi va uni istalgan odam ko'chirib olib,
 * sizning trafigingiz hisobidan foydalanishi mumkin. Shuning uchun coturn
 * `use-auth-secret` rejimida ishlaydi: har bir foydalanuvchiga qisqa muddatli
 * parol beriladi, u sekretdan HMAC orqali hosil qilinadi.
 *
 *   username = <muddati tugash vaqti(unix)>:<belgi>
 *   password = base64( HMAC-SHA1(TURN_SECRET, username) )
 *
 * TURN_SECRET va TURN_HOST berilmasa — faqat STUN qaytariladi (hozirgi holat).
 */

const crypto = require('crypto');

const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_TTL = Number(process.env.TURN_TTL || 12 * 3600);
const TURN_ON = TURN_SECRET.length > 0 && TURN_HOST.length > 0;

const STUN = {
  urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
};

function credentials(label = 'dars') {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${expiry}:${label}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { username, credential, expiry };
}

function iceServers(label) {
  if (!TURN_ON) return [STUN];
  const { username, credential } = credentials(label);
  return [
    STUN,
    {
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`,
        `turns:${TURN_HOST}:5349?transport=tcp`, // qattiq firewall ortida 443/TLS kabi o'tadi
      ],
      username,
      credential,
    },
  ];
}

module.exports = { TURN_ON, TURN_HOST, iceServers };
