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

STUN bilan foydalanuvchilarning ~90% i ulanadi. Qattiq NAT / mobil operator ortidagilar uchun
TURN kerak. `public/room.js` dagi `RTC_CONFIG` ichida joyi tayyor:

```js
{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }
```

O‘z serveringizga `coturn` o‘rnatish yetarli.

## Ilovaga ulash (WebView)

Xona sahifasini ilova ichida WebView orqali ochish mumkin:

- **Android** — `WebChromeClient.onPermissionRequest` da `request.grant(request.getResources())`,
  manifestda `CAMERA` + `RECORD_AUDIO`, `mediaPlaybackRequiresUserGesture = false`
- **iOS** — WKWebView (iOS 14.3+), `allowsInlineMediaPlayback = true`,
  `mediaTypesRequiringUserActionForPlayback = []`, Info.plist da
  `NSCameraUsageDescription` va `NSMicrophoneUsageDescription`

Ilova foydalanuvchini to‘g‘ridan-to‘g‘ri
`https://<domen>/room.html?room=<dars_id>&role=student&name=<ism>` manziliga yuboradi.

## Keyingi bosqich

Booking (time slot), auth, dars tarixi — hali yo‘q. Xona nomi hozircha ochiq havola;
prodakshnda qisqa muddatli token bilan almashtirish kerak.
