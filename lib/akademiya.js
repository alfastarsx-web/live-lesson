'use strict';
/*
 * Mentor akademiyasi — yangi mentor ish sahifalariga kirishdan oldin
 * 8 modulni o'qib, yakuniy testdan o'tishi shart.
 *
 * To'g'ri javoblar faqat shu yerda turadi: sahifa savollarni javobsiz oladi,
 * tekshirish serverda bo'ladi. Aks holda javoblarni sahifa kodidan o'qib olish mumkin edi.
 *
 * Natijalar data/akademiya.json da (git'ga tushmaydi, serverda saqlanib qoladi).
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'akademiya.json');
const PASS = 13;

// a — to'g'ri variant, m — javob qaysi modulda
const QUESTIONS = [
  { q: "Ochilgan slotda onlayn bo'lmasangiz nima bo'ladi?", o: ["Hech narsa, slot shunchaki yopiladi", "Bo'sh qolgan har 30 daqiqa uchun ball ayiriladi", "Hisobingiz darhol bloklanadi", "Keyingi hafta kalendar yopiladi"], a: 1, m: 2 },
  { q: "Bir vaqtda qo'lingizda nechta ishlanmagan talabgor tura oladi?", o: ["Cheklov yo'q", "10 ta", "5 ta", "3 ta"], a: 3, m: 4 },
  { q: "Talabgorga necha daqiqa tegmasangiz, u qaytarib olinadi?", o: ["15 daqiqa", "45 daqiqa", "2 soat", "Kun oxirigacha"], a: 1, m: 4 },
  { q: "Kunlik norma nimaga teng?", o: ["Kuniga 100 ball", "Kuniga 8 soat onlayn", "12 ta qo'ng'iroq, boshqa hech narsa", "Norma yo'q"], a: 0, m: 3 },
  { q: "O'tkazilgan birinchi dars (diagnostika) necha ball beradi?", o: ["8", "15", "30", "50"], a: 2, m: 3 },
  { q: "Telefon qo'ng'irog'ining maqsadi nima?", o: ["Kursni sotish va to'lov qildirish", "Narxni aytib, o'ylab ko'rishini so'rash", "Bepul birinchi darsga vaqt kelishish", "Darajasini telefonda aniqlash"], a: 2, m: 5 },
  { q: "Odam telefonda \"qimmat\" desa, to'g'ri javob qaysi?", o: ["Chegirma taklif qilaman", "\"Birinchi dars bepul, majburiyat yo'q. Avval ko'ring\"", "Narxni batafsil asoslab beraman", "Arzonroq kurslar borligini aytaman"], a: 1, m: 5 },
  { q: "XEI nimani anglatadi?", o: ["Xohish, Ehtiyoj, Imkoniyat", "Xulosa, Eksperiment, Intizom", "Xarid, Ehtimol, Investitsiya", "Xohish, Ehtiyotkorlik, Ishonch"], a: 0, m: 6 },
  { q: "O'quvchi \"sertifikat olishim kerak\" desa, qaysi dastur va narx?", o: ["Speaking dasturi, 350 000 so'mdan", "IELTS / CEFR tayyorgarlik, 550 000 so'mdan", "Farqi yo'q, ikkalasi ham bir xil", "O'quvchi o'zi tanlaydi"], a: 1, m: 7 },
  { q: "Promokod bilan bergan chegirmangizni kim to'laydi?", o: ["Kompaniya", "Siz — chegirma sizning ulushingizdan chiqadi", "Kompaniya va siz teng bo'lasiz", "Chegirma o'quvchining keyingi oyidan ushlanadi"], a: 1, m: 7 },
  { q: "O'quvchi chegirma so'rasa nima qilasiz?", o: ["Narxni 300 000 gacha tushiraman", "Narxni emas, haftadagi dars sonini kamaytiraman", "Administratordan ruxsat so'rayman", "Birinchi oyni bepul qilaman"], a: 1, m: 7 },
  { q: "Birinchi darsdan keyin o'quvchi 24 soat ichida to'lasa, sizga nima beriladi?", o: ["Hech narsa, faqat obunadan ulush", "Bitta dars puli miqdorida bonus", "Ikki barobar obuna ulushi", "Keyingi oyda rank ko'tariladi"], a: 1, m: 7 },
  { q: "Prioritet raqami nimani belgilaydi?", o: ["Oyliq maoshingizni", "Ertaga qancha talabgor olishingizni", "O'quvchining darajasini", "Qaysi smenada ishlashingizni"], a: 1, m: 4 },
  { q: "Darsni qanday material bilan o'tasiz?", o: ["Faqat ilovadagi dastur bo'yicha", "O'quvchiga mos materialni o'zim tanlayman, o'z kitobi bo'lsa o'shandan davom etaman", "Har safar yangi material beraman", "Material kerak emas, faqat suhbat"], a: 1, m: 1 },
  { q: "Sizga kelgan talabgor sertifikat kerakligini aytdi, lekin sizda IELTS darajasi yo'q. Nima qilasiz?", o: ["O'zim tayyorlayman, farqi yo'q", "Ilovada IELTS oqimiga o'tkazaman va sababini tushuntiraman", "Talabgorni yopib qo'yaman", "Speaking narxida IELTS tayyorlashni va'da qilaman"], a: 1, m: 4 },
  { q: "O'quvchi bilan platformadan tashqarida kelishsangiz nima bo'ladi?", o: ["Ogohlantirish beriladi", "Ball ayiriladi", "Darhol blok, bonuslar bekor va qonuniy javobgarlik", "Administrator komissiya oladi"], a: 2, m: 8 },
];

function oqi() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function yoz(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

function yozuv(id) {
  return oqi()[id] || null;
}

function otganmi(id) {
  return Boolean(yozuv(id)?.passedAt);
}

// Akademiya joriy qilinishidan oldin ishlab kelgan mentor — testsiz o'tkaziladi
function ozod(id, sabab) {
  const db = oqi();
  db[id] = { ...(db[id] || {}), passedAt: new Date().toISOString(), exempt: sabab };
  yoz(db);
}

// Savollar sahifaga javobsiz beriladi
function savollar() {
  return { pass: PASS, questions: QUESTIONS.map(({ q, o }) => ({ q, o })) };
}

function tekshir(id, answers) {
  if (!Array.isArray(answers) || answers.length !== QUESTIONS.length) return null;
  const review = QUESTIONS.map((s, i) => ({
    correct: answers[i] === s.a, answer: s.a, module: s.m,
  }));
  const score = review.filter((r) => r.correct).length;
  const pass = score >= PASS;

  const db = oqi();
  const eski = db[id] || {};
  db[id] = {
    ...eski,
    attempts: (eski.attempts || 0) + 1,
    lastScore: score,
    lastAt: new Date().toISOString(),
    ...(pass && !eski.passedAt ? { passedAt: new Date().toISOString(), score } : {}),
  };
  yoz(db);
  return { score, pass, total: QUESTIONS.length, review };
}

module.exports = { otganmi, ozod, savollar, tekshir, yozuv };
