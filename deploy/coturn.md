# TURN server (coturn) — o'rnatilgan holat

**Server:** 46.8.195.59 (myteacher.uz), Ubuntu 26.04, coturn 4.6.1
**Manzil:** `myteacher.uz` — mavjud Let's Encrypt sertifikatidan foydalanadi
**O'rnatilgan sana:** 2026-09-18

## Portlar

| Port | Protokol | Nima uchun |
|---|---|---|
| 3478 | UDP + TCP | asosiy TURN |
| 5349 | TCP/TLS | `turns:` — qattiq firewall ortida 443 kabi o'tadi |
| 49152–49500 | UDP | relay portlari |

## Muhim: server NAT ortida

Interfeys IP — `10.10.29.230/30`, tashqi IP — `46.8.195.59`. Shuning uchun konfiguratsiyada:

```
listening-ip=10.10.29.230
relay-ip=10.10.29.230
external-ip=46.8.195.59/10.10.29.230
```

Agar `relay-ip` ga to'g'ridan-to'g'ri tashqi IP yozilsa, coturn portlarni bog'lay olmaydi
(`Trying to bind ... errno=99`) va relay nomzodlari umuman paydo bo'lmaydi. Bu xato
jimgina sodir bo'ladi — xizmat "active" ko'rinadi, lekin ishlamaydi.

## Autentifikatsiya

Doimiy parol yo'q. coturn `use-auth-secret` rejimida: dars serveri har bir ulanish uchun
qisqa muddatli parol yasaydi (`lib/turn.js`):

```
username = <muddat(unix)>:<xona>
password = base64( HMAC-SHA1(TURN_SECRET, username) )
```

Sekret serverda: `/etc/coturn-secret` (chmod 600). Shu qiymat dars ilovasida
`TURN_SECRET` bo'lib turishi kerak.

## Sertifikat yangilanishi

`/etc/letsencrypt/renewal-hooks/deploy/coturn.sh` — certbot sertifikatni yangilaganda
nusxani `/etc/coturn/certs/` ga ko'chiradi va coturn'ni qayta yuklaydi. Ya'ni 90 kunda
bir marta qo'lda ish qilish shart emas.

## Xavfsizlik

Konfiguratsiyada ichki tarmoqlar `denied-peer-ip` bilan taqiqlangan (10.x, 172.16–31.x,
192.168.x, loopback, link-local). Busiz TURN relay orqali serverning ichki xizmatlariga
murojaat qilish mumkin bo'lardi.

Kvotalar: `user-quota=12`, `total-quota=1200`.

## Tekshirish

```bash
systemctl status coturn
journalctl -u coturn -n 50 --no-pager
ss -lnup | grep 3478
```

Brauzerdan (eng ishonchli sinov — relay nomzodi kelishi kerak):

```js
const {iceServers} = await (await fetch('/api/ice')).json();
const pc = new RTCPeerConnection({iceServers, iceTransportPolicy: 'relay'});
pc.createDataChannel('x');
pc.onicecandidate = e => e.candidate && console.log(e.candidate.candidate);
await pc.setLocalDescription(await pc.createOffer());
// " typ relay" li nomzodlar chiqsa — TURN ishlayapti
```

## Diqqat

Serverda disk **96% to'la** (2.1 GB bo'sh). coturn kam joy egallaydi, lekin dars
ilovasi shu serverga chiqarilsa, PDF yuklamalari uchun joy tozalash kerak bo'ladi.
