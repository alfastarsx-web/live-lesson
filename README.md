# Jonli dars (live-lesson)

Ustoz va o‘quvchi uchun **1:1 video xona** + PDF ustida **sinxron belgilash**.
Zoom emas — faqat kerakli minimum: ko‘rish, eshitish, bitta hujjatni birga o‘qish.

## Nima bor

- **Video/audio** — WebRTC P2P (server orqali o‘tmaydi, shuning uchun tez va arzon)
- **Ish maydoni** — ustoz PDF ochadi, o‘quvchida bir zumda ochiladi
- **Qalam va marker** — ustoz chizadi, o‘quvchi real vaqtda ko‘radi
- **Sinxron sahifa va scroll** — ikkovi ham bir joyga qaraydi
- **Orqaga / tozalash**, 4 ta rang
- **Mobil tartib** — ekranning tepa yarmi ishtirokchilar, pasti ish maydoni
- Kech qo‘shilgan ishtirokchi darsning joriy holatini (hujjat, sahifa, belgilar) to‘liq oladi

Ataylab **yo‘q**: chat, ekran ulashish, yozib olish, 3+ ishtirokchi, booking.

## Ishga tushirish

```bash
npm install
npm start          # http://127.0.0.1:4300
```

Sinash: bitta brauzerda ustoz, boshqa oynada (yoki incognito'da) o‘quvchi:

- ustoz: `http://127.0.0.1:4300/room.html?room=dars-1&role=teacher&name=Ustoz`
- o‘quvchi: `http://127.0.0.1:4300/room.html?room=dars-1&role=student&name=Ali`

Yoki bosh sahifadan (`/`) xona nomi va rolni tanlab kiring.

## Kirish tokeni

Ikki rejim bor, `LESSON_TOKEN_SECRET` ni bor-yo'qligi hal qiladi (`.env.example` ga qarang):

- **Ochiq rejim** (sekret yo'q) — xonaga havola bilan kiriladi. Faqat lokal ishlab chiqish uchun.
- **Token rejimi** (sekret bor) — kirish faqat imzolangan token bilan:
  `room.html?t=<TOKEN>`. Xona, rol va ism **faqat tokendan** olinadi; mijoz yuborgan
  `role=teacher` kabi parametrlar e'tiborga olinmaydi. Ustoz PDF yuklashi ham,
  jurnallarni o'qish ham shu tekshiruvdan o'tadi.

```bash
LESSON_TOKEN_SECRET=<uzun-tasodifiy-satr> DEV_TOKENS=true npm start
curl "http://127.0.0.1:4300/api/dev-token?room=dars-1&role=teacher&name=Ustoz"
```

Tokenni odatda MyTeacher backend'i imzolaydi — batafsil va Flutter integratsiyasi:
[INTEGRATION.md](INTEGRATION.md).

## Muhim: HTTPS shart

`getUserMedia` (kamera/mikrofon) faqat **https** yoki **localhost** da ishlaydi.
Telefondan sinash uchun tunnel oching:

```bash
cloudflared tunnel --url http://localhost:4300
```

## Arxitektura

```
server.js          Express (statik + PDF yuklash) + WebSocket signaling
public/index.html  kirish sahifasi (xona + rol)
public/room.html   dars xonasi
public/room.css    tartib (mobil: 50/50, keng ekran: doska + yon panel)
public/room.js     WebRTC, PDF.js, chizish, sinxronizatsiya
```

WebSocket xabarlari: `offer`/`answer`/`ice` (WebRTC), `doc`/`page`/`scroll`/`stroke`/
`stroke-live`/`undo`/`clear` (ish maydoni). Ish maydonini **faqat ustoz** o‘zgartira oladi —
bu server tomonda ham tekshiriladi. Xona holati serverda saqlanadi, shuning uchun
aloqa uzilib qayta ulansa ham belgilar yo‘qolmaydi.

Chiziqlar kanvas o‘lchamiga **nisbiy** (0..1) saqlanadi — telefon va noutbukda bir xil joyga tushadi.

## TURN server

STUN bilan foydalanuvchilarning ~90% i ulanadi. Qattiq NAT va mobil operatorlar ortidagilar
uchun TURN kerak — u **o‘rnatilgan va ishlayapti**: `myteacher.uz` (coturn, 46.8.195.59).

ICE serverlari klientga **server tomondan** beriladi (`joined` xabarida va `GET /api/ice`),
parol esa har safar qisqa muddatli qilib yasaladi. Shuning uchun klient kodida hech qanday
TURN paroli yozilmagan — aks holda uni ko‘chirib olib, trafigingiz hisobidan foydalanish mumkin bo‘lardi.

Ilovani ishga tushirishda:

```bash
TURN_SECRET=<serverdagi /etc/coturn-secret> TURN_HOST=myteacher.uz npm start
```

`TURN_SECRET` yoki `TURN_HOST` berilmasa — faqat STUN ishlatiladi.

O‘rnatish tafsilotlari, NAT gotcha'si va tekshirish usuli: [deploy/coturn.md](deploy/coturn.md).

## Ilovaga ulash (WebView)

To'liq qo'llanma: **[INTEGRATION.md](INTEGRATION.md)** (Flutter kodi, token formati, platforma sozlamalari).

Xona sahifasini ilova ichida WebView orqali ochish mumkin:

- **Android** — `WebChromeClient.onPermissionRequest` da `request.grant(request.getResources())`,
  manifestda `CAMERA` + `RECORD_AUDIO`, `mediaPlaybackRequiresUserGesture = false`
- **iOS** — WKWebView (iOS 14.3+), `allowsInlineMediaPlayback = true`,
  `mediaTypesRequiringUserActionForPlayback = []`, Info.plist da
  `NSCameraUsageDescription` va `NSMicrophoneUsageDescription`

Ilova foydalanuvchini to‘g‘ridan-to‘g‘ri
`https://<domen>/room.html?room=<dars_id>&role=student&name=<ism>` manziliga yuboradi.

## Dars jurnali (timestamp)

Har bir dars `data/lessons/<xona>__<sana>.jsonl` fayliga yoziladi. Har qatorda bitta voqea:

```json
{"t":1206,"at":1789672009421,"type":"stroke","stroke":{"page":2,"tool":"pen","t":1206,"dur":120,"pts":[[0.2,0.3]]}}
```

- `t` — dars boshlanganidan beri o‘tgan millisekund (server qo‘yadi, mijozga ishonilmaydi)
- `at` — mutlaq vaqt (unix ms)
- `dur` — chiziq qancha vaqtda chizilgani

Voqea turlari: `lesson-start`, `join`, `doc`, `page`, `stroke`, `undo`, `clear`, `leave`, `lesson-end`.
Shovqin bo‘lgani uchun `scroll` va `stroke-live` yozilmaydi.

O‘qish:

```
GET /api/lessons            # darslar ro‘yxati
GET /api/lessons/<fayl>     # bitta darsning barcha voqealari
```

Shu ma’lumot bilan keyinchalik darsni **video yozmasdan** qayta o‘ynatish mumkin:
qaysi sahifada qancha turilgan, nima belgilangan, qaysi tartibda. Audio yozish va
transcript qo‘shilganda, transcript ham shu vaqt o‘qiga tushadi.

> Token rejimida bu endpointlar `x-admin-key: $ADMIN_KEY` sarlavhasini talab qiladi.

## Lidlar: o‘quvchi akkauntini bitta tugma bilan ochish

Mentor `/lidlar.html` da lid kartasidagi **“Akkaunt ochish”** tugmasini bosadi. Server
`POST /api/ai/leads/:id/create-account` so‘rovini ai.myteacher.uz ga o‘tkazadi (mentor tokeni
HttpOnly cookie’da turadi). Akkaunt ochiladi va login/parol o‘quvchiga **Telegram bot**
(`TRIAL_BOT_TOKEN` API tomonida) orqali ilova ko‘rsatmasi va skrinshotlar bilan yuboriladi;
Telegram bo‘lmasa SMS **yuborilmaydi**: kod kartada ko‘rinadi va mentor uni o‘quvchiga o‘zi aytadi. Batafsil oqim: aiteacher-api `CLAUDE.md`
→ “Trial lessons: Telegram bot”.

Bu yo‘l ochiq proksi emas: `server.js` da faqat aynan shu POST manzili ruxsat etilgan.
`LESSON_TOKEN_SECRET` bu server va API’da **bir xil** bo‘lishi shart.

## Keyingi bosqich

Booking (time slot), audio yozish va transcript — hali yo‘q (dars jurnali esa yozilmoqda).
Kirish tokeni tayyor; TURN server hali qo‘yilmagan.
