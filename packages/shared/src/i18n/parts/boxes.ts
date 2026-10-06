/**
 * Page boxes, page size and page labels ("Page boxes & size",
 * "Header/footer + Bates + page labels").
 *
 * Every `labelKey`/`hintKey`/`unitKey`/`titleKey`/`introKey`, every `note(...)` key and
 * the progress keys of `ops/page-boxes.ts` and `ops/page-labels.ts` live here, plus the
 * keys of the two dialogs (`packages/pdf-ui/src/ops/pageboxes.ts`,
 * `packages/pdf-ui/src/ops/pagelabels.ts`), so an untranslated sentence stays a compile
 * error instead of an English string in the interface (`ops/types.ts`).
 *
 * The box names are the PDF vocabulary (`MediaBox`, `CropBox`, …) on purpose: they are
 * what the file carries, what a print shop asks for, and what the report must name. The
 * Turkish explanation sits next to them in the select options.
 *
 * Wired into `tr.ts` by the integration owner (the keys arrive with the ops).
 */

export const boxesPart = {
  'boxes.title': 'Sayfa kutuları ve boyutu',
  /* progress: the unit is a page, never a synthetic percentage */
  'op.progress.boxes': 'Sayfa kutuları yazılıyor',
  'op.progress.labels': 'Sayfa etiketleri yazılıyor',
  'op.progress.boxes.measure': 'İçerik sınırları ölçülüyor',

  /* page boxes & size dialog */
  'boxes.dialog.title': 'Sayfa kutuları ve boyut',
  'boxes.dialog.intro':
    'Sayfa kutuları PDF’in kendi ölçüleridir: MediaBox kâğıdı, CropBox görünen alanı, Trim/Bleed/Art ise baskı ve içerik sınırlarını tanımlar. Otomatik kırpma sayfayı tarayıp gerçekten basılmış içeriği ölçer; beyaz kenarlar kırpılır. Kutu değişiklikleri var olan açıklamaları taşımaz, içerik kaydırma/açı işlemleri ise sayfanın kendi mekanizmasıyla yapılır ve rapor hangisini kullandığını yazar.',
  'boxes.dialog.done': '{count} sayfa güncellendi.',
  'boxes.dialog.mode': 'İşlem',
  'boxes.dialog.mode.set': 'Kutu değerini ayarla',
  'boxes.dialog.mode.resize': 'Sayfa boyutunu değiştir',
  'boxes.dialog.mode.scale': 'İçeriği ölçekle',
  'boxes.dialog.mode.autoCrop': 'Otomatik kırp (beyaz kenarlar)',
  'boxes.dialog.mode.shift': 'İçeriği kaydır',
  'boxes.dialog.mode.rotate': 'İçeriği döndür',
  'boxes.dialog.box': 'Kutu',
  'boxes.dialog.box.media': 'MediaBox (kâğıt)',
  'boxes.dialog.box.crop': 'CropBox (görünen alan)',
  'boxes.dialog.box.trim': 'TrimBox (kesim)',
  'boxes.dialog.box.bleed': 'BleedBox (taşma)',
  'boxes.dialog.box.art': 'ArtBox (içerik)',
  'boxes.dialog.rectHint':
    'PDF kullanıcı uzayı, sol alt köşe esaslı ve nokta biriminde. Değerler MediaBox dışına taşarsa kutuya kırpılır ve rapor bunu yazar.',
  'boxes.dialog.x': 'X',
  'boxes.dialog.y': 'Y',
  'boxes.dialog.width': 'Genişlik',
  'boxes.dialog.height': 'Yükseklik',
  'boxes.dialog.fit': 'İçeriğin yerleşimi',
  'boxes.dialog.fit.none': 'Ölçekleme yok',
  'boxes.dialog.fit.fit': 'Sığdır (tam görünür)',
  'boxes.dialog.fit.fill': 'Doldur (taşan kırpılır)',
  'boxes.dialog.fit.stretch': 'Uzat (oran korunmaz)',
  'boxes.dialog.margin': 'Kenar boşluğu',
  'boxes.dialog.factor': 'Ölçek oranı',
  'boxes.dialog.factorHint': '1 değişiklik yapmaz; 0,5 yarısı, 2 iki katı büyüklük demektir.',
  'boxes.dialog.scaleBoxes': 'Kutuları da ölçekle',
  'boxes.dialog.scaleBoxesHint': 'Kapalıysa yalnızca içerik ölçeklenir, kutu ölçüleri olduğu gibi kalır.',
  'boxes.dialog.padding': 'İçerikten sonra pay',
  'boxes.dialog.paddingHint':
    'Ölçülen içerik sınırının dışına eklenen boşluk; kırpma en az 18 nokta (çeyrek inç) olur.',
  'boxes.dialog.alsoTrim': 'TrimBox da aynı ölçüye gelsin',
  'boxes.dialog.offsetX': 'Yatay kaydırma',
  'boxes.dialog.offsetY': 'Dikey kaydırma',
  'boxes.dialog.offsetHint': 'Pozitif değer sağa/yukarı kaydırır.',
  'boxes.dialog.degrees': 'Açı',
  'boxes.dialog.degrees.90': '90° sağa',
  'boxes.dialog.degrees.180': '180°',
  'boxes.dialog.degrees.270': '270° (90° sola)',
  'boxes.unit.points': 'nokta',
  'boxes.unit.mm': 'mm',

  /* page boxes & size report */
  'boxes.note.set': '{count} sayfada {box} kutusu yazıldı.',
  'boxes.note.resize': '{count} sayfa {width}×{height} noktaya getirildi.',
  'boxes.note.scaled': '{count} sayfa {factor}× ölçeklendi.',
  'boxes.note.scaleOrigin': 'Ölçekleme, sayfa kullanıcı uzayının (0,0) noktasına göre uygulandı.',
  'boxes.note.annotationsScaled': '{count} sayfadaki açıklamalar içerikle birlikte ölçeklendi.',
  'boxes.note.boxesScaled': 'Sayfa kutuları da içerikle aynı oranda ölçeklendi.',
  'boxes.note.autoCrop':
    '{count} sayfa {dpi} dpi taranarak ölçülen içerik sınırına kırpıldı (beyaz kenarlar gitti).',
  'boxes.note.trimWritten': 'TrimBox de kırpılan alanla aynı ölçüye getirildi.',
  'boxes.note.shift': '{count} sayfada içerik {x} mm yatay, {y} mm dikey kaydırıldı.',
  'boxes.note.rotated':
    '{count} sayfanın içeriği {degrees}° döndürüldü; döndürme sayfanın /Rotate girdisine yazıldı.',
  'boxes.note.rotateMovesAnnots':
    'Döndürme /Rotate ile yapıldığı için açıklamalar ve kutular içerikle birlikte döner; hiçbiri eski yönelimde kalmaz.',
  'boxes.note.boxChangeAnnots':
    'Var olan açıklamalar ve bağlantılar taşınmadı; yeni kutunun dışında kalanlar görünmez olabilir.',
  'boxes.note.contentMovedAnnots':
    'Var olan açıklamalar ve bağlantılar içerikle birlikte taşınmadı (motor taşıma yapmıyor); içerik üzerindeki işaretler kayabilir.',
  'boxes.note.clamped': '{count} kutu MediaBox sınırına kırpıldı.',
  'boxes.note.minCrop':
    'İçerik çok küçük olduğu için {count} sayfada kırpma en az {points} noktaya genişletildi.',
  'boxes.note.emptyContent': '{count} sayfada basılı içerik bulunamadı; kutusu değiştirilmedi.',
  'boxes.note.unchangedPages': '{count} sayfa zaten istenen durumdaydı; değiştirilmedi.',
  'boxes.note.unchanged': 'Seçilen sayfalarda değişecek bir şey yok; dosya yazılmadı.',
  'boxes.note.producer': 'Üretici satırı ve belge üst verisi korundu.',

  /* page labels dialog */
  'labels.dialog.title': 'Sayfa etiketleri',
  'labels.dialog.intro':
    'Etiketler, okuyucunun ve yazdırma penceresinin sayfa numarası yerine gösterdiği metindir (ör. “Önsöz iii”, “Ek-A”). Bu pencere belgenin bütün etiket planını değiştirir: önceki plan silinir, kural aralığın ilk sayfasından belgenin sonuna kadar uygulanır ve önceki sayfalar varsayılan numarayı korur. Yazılan etiketler geri okunup raporda gösterilir.',
  'labels.dialog.range': 'Kuralın başladığı sayfa',
  'labels.dialog.rangeHint':
    '1 tabanlı sayfa numaraları; aralığın ilk sayfası kuralın başlangıcı olur (ör. 1-3,7 → 1. sayfa).',
  'labels.dialog.style': 'Numaralandırma',
  'labels.dialog.prefix': 'Ön ek',
  'labels.dialog.prefixHint': 'Numaranın önüne yazılır; “Ek-” gibi. Boş bırakılabilir.',
  'labels.dialog.start': 'Başlangıç numarası',
  'labels.dialog.startHint': 'Aralığın ilk sayfasının numarası; sonraki sayfalar birer artar.',
  'labels.dialog.done': '{count} sayfa etiketlendi.',
  'labels.style.none': 'Numarasız (yalnızca ön ek)',
  'labels.style.decimal': '1, 2, 3',
  'labels.style.romanUpper': 'I, II, III',
  'labels.style.romanLower': 'i, ii, iii',
  'labels.style.alphaUpper': 'A, B, C',
  'labels.style.alphaLower': 'a, b, c',

  /* page labels report */
  'labels.note.plan': 'Etiket planı {count} kural ile yazıldı.',
  'labels.note.previous':
    'Belgenin önceki etiket planı silindi; geri alınmadan önceki etiketler dosyada kalmaz.',
  'labels.note.info': 'Info alanları ve üretici satırı değiştirilmedi.',
  'labels.note.count': 'Belgenin {from}. sayfasından sonuna kadar {count} sayfa etiketlendi.',
  'labels.note.verified': 'Etiketler geri okunarak doğrulandı: ilk “{first}”, son “{last}”.',
  'labels.note.mismatch':
    'Geri okunan ilk etiket beklenenden farklı: beklenen “{expected}”, okunan “{actual}”.',
} as const;
