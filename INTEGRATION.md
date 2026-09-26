# Mobil ilovaga ulash (Flutter + WebView)

Dars xonasi mobil ilovada **WebView** orqali ochiladi. Ilova faqat ikki ish qiladi:
kirish tokenini oladi va WebView'ni to'g'ri sozlab ochadi.

---

## 1. Kirish tokeni

Xonaga ochiq havola bilan kirib bo'lmaydi — **imzolangan token** kerak.
Tokenni **MyTeacher backend'i** imzolaydi, dars serveri faqat tekshiradi.
Ikkala tomonda bir xil `LESSON_TOKEN_SECRET` bo'lishi shart.

Token oddiy JWT (HS256), ichida:

```json
{ "room": "dars-12345", "role": "teacher", "name": "Dilnoza", "iat": 1789733098, "exp": 1789743898 }
```

| Maydon | Ma'nosi |
|---|---|
| `room` | dars identifikatori — `[a-z0-9-]`, 3–40 belgi (masalan `dars-12345`) |
| `role` | `teacher` yoki `student` — **kim chiza olishini shu belgilaydi** |
| `name` | ekranda ko'rinadigan ism |
| `exp` | amal qilish muddati (unix, sekund). Dars uzunligi + zaxira, masalan 3 soat |

Backend tomonda (NestJS, mavjud `jsonwebtoken` bilan):

```ts
const token = jwt.sign(
  { room: `dars-${lesson.id}`, role: isMentor ? 'teacher' : 'student', name: user.firstName },
  process.env.LESSON_TOKEN_SECRET,
  { expiresIn: '3h' },
);
```

Muhim: `role` ni **ilova emas, backend** belgilaydi. Ilova query'da `role=teacher` yuborsa ham
server tokendagi rolni oladi — bu tekshirilgan.

Ilova WebView'da ochadigan manzil:

```
https://lesson.myteacher.uz/room.html?t=<TOKEN>
```

---

## 2. Flutter: paketlar

```yaml
dependencies:
  flutter_inappwebview: ^6.0.0
  permission_handler: ^11.3.0
  wakelock_plus: ^1.2.0
```

`flutter_inappwebview` tanlandi, chunki `onPermissionRequest` ni to'g'ridan-to'g'ri beradi —
`webview_flutter` da buni platformaga alohida yozish kerak.

---

## 3. Flutter: dars ekrani

```dart
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

class LessonScreen extends StatefulWidget {
  final String token; // backend'dan olingan kirish tokeni
  const LessonScreen({super.key, required this.token});

  @override
  State<LessonScreen> createState() => _LessonScreenState();
}

class _LessonScreenState extends State<LessonScreen> {
  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();          // dars davomida ekran uxlamasin
    _askPermissions();
  }

  Future<void> _askPermissions() async {
    // WebView ruxsat so'rashidan OLDIN native ruxsat olinishi kerak
    await [Permission.camera, Permission.microphone].request();
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final url = 'https://lesson.myteacher.uz/room.html?t=${Uri.encodeComponent(widget.token)}';

    return Scaffold(
      body: SafeArea(
        child: InAppWebView(
          initialUrlRequest: URLRequest(url: WebUri(url)),
          initialSettings: InAppWebViewSettings(
            // --- WebRTC uchun majburiy ---
            mediaPlaybackRequiresUserGesture: false,
            allowsInlineMediaPlayback: true,          // iOS: videoni to'liq ekranga otmasin
            iframeAllow: 'camera; microphone',
            iframeAllowFullscreen: true,

            // --- qulaylik ---
            transparentBackground: true,
            disableVerticalScroll: false,
            supportZoom: false,                        // ikki barmoq bilan zoom PDF chizishga xalaqit beradi
            useHybridComposition: true,                // Android: video tekis chiqsin
            allowsLinkPreview: false,
          ),

          // Android: WebView kamera so'raganda ruxsat berish
          onPermissionRequest: (controller, request) async {
            return PermissionResponse(
              resources: request.resources,
              action: PermissionResponseAction.GRANT,
            );
          },

          onConsoleMessage: (controller, msg) {
            debugPrint('[dars] ${msg.message}');       // nosozlikni topishda juda asqotadi
          },
        ),
      ),
    );
  }
}
```

---

## 4. Android sozlamalari

`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

`minSdkVersion` kamida **21**, lekin amalda **23+** tavsiya etiladi.

---

## 5. iOS sozlamalari

`ios/Runner/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Jonli darsda ustoz va o'quvchi bir-birini ko'rishi uchun kamera kerak</string>
<key>NSMicrophoneUsageDescription</key>
<string>Jonli darsda gaplashish uchun mikrofon kerak</string>
```

**Eng muhim cheklov:** WKWebView'da kamera faqat **haqiqiy `https` manzil**dan yuklangan
sahifada ishlaydi. `loadHTMLString` yoki ilova ichidagi `file://` fayl bilan **ishlamaydi** —
shuning uchun sahifa albatta `https://lesson.myteacher.uz` dan ochilishi kerak.

Minimal iOS: **14.3**.

---

## 6. Bilib qo'yish kerak bo'lgan xatti-harakatlar

| Holat | Nima bo'ladi | Nima qilish kerak |
|---|---|---|
| Ilova fonga o'tdi / ekran qulflandi | WKWebView media'ni to'xtatadi, aloqa uziladi | Wake Lock yoqilgan; qo'shimcha — foydalanuvchini "darsdan chiqyapsiz" deb ogohlantirish |
| Telefonga qo'ng'iroq keldi | Audio sessiya tortib olinadi, dars uziladi | Qo'ng'iroq tugagach sahifani yangilash kerak bo'lishi mumkin |
| Token muddati tugadi | Server ulanishni rad etadi, ekranda xabar chiqadi | Ilova yangi token olib WebView'ni qayta yuklaydi |
| Xona to'la (2 kishi) | `full` xabari qaytadi | Ilova "dars allaqachon boshlangan" ekranini ko'rsatadi |
| Qattiq NAT / mobil internet | Video ulanmasligi mumkin | Serverga TURN (coturn) qo'yish — `room.js` dagi `RTC_CONFIG` ga qo'shiladi |

---

## 7. Sinov tartibi

Haqiqiy qurilmada sinash **shart** — simulyator/emulyatorda kamera va audio marshruti boshqacha.

1. Android telefon + iPhone (ikki xil tarmoqda: biri Wi-Fi, biri mobil internet)
2. Ovoz aks-sadosi (echo) bor-yo'qligi — karnay rejimida
3. Ilovani fonga otib, qaytib kirish
4. 20+ daqiqalik uzluksiz dars — issiqlik va batareya

## Work bo'limi (mentor ilovasi)

Ilovaning **Work** tabi WebView'da shu manzilni ochadi — login/parol so'ralmaydi:

```
https://lesson.myteacher.uz/work.html#ai=<ai.myteacher.uz access token>
```

- Token `#` dan keyin beriladi: serverga va nginx loglariga tushmaydi. Sahifa uni bir marta
  cookie'ga aylantiradi va manzildan o'chiradi.
- Yangi mentor akademiyadan o'tmagan bo'lsa, sahifa o'zi `/mentor/akademiya.html` ga o'tadi.
- **Token eskirsa** sahifa login ko'rsatmaydi. U ilovaga xabar yuboradi (mavjud ko'prik orqali:
  `MyTeacher.postMessage` yoki `flutter_inappwebview.callHandler('mentorAction', ...)`):

  ```json
  { "turi": "tokenEskirdi", "sahifa": "/work.html" }
  ```

  Ilova yangi access token olib, WebView'da `https://lesson.myteacher.uz<sahifa>#ai=<yangi token>`
  ni ochishi kerak. Ochiq sahifada faqat `#ai=` ni almashtirish ham yetarli — sahifa uni ushlaydi.
- Sinov darsi so'rovi push'i `data: { screen: 'work', type: 'trial_request', requestId, expiresAt }`
  bilan keladi. Bosilganda Work tabini oching — so'rov ekrani o'zi chiqadi.
