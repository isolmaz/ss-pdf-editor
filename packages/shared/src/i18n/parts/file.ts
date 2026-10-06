/**
 * File-level capabilities (`REPORT.md §3` A1 merge/add, A17 images→PDF,
 * A8 text export, A7 image export).
 */

export const filePart = {
  'file.add.title': 'Belge ekle / içe aktar',
  'file.add.intro':
    'Eklenen belge geçerli belgeye katılır ve sonuç geçerli belgenin yerini alır. Eklenen belgenin üst verisi (Info/XMP) taşınmaz; sonuç, üst verisini geçerli belgeden alır.',
  'file.add.insertAt': 'Ekleme yeri',
  'file.add.atEnd': 'Belgenin sonuna',
  'file.add.atStart': 'Belgenin başına',
  'file.add.afterCurrent': 'Geçerli sayfadan sonra',
  'file.add.choose': 'PDF seç',
  'file.add.sourceHint': 'Sayfaları, seçilen konuma eklenir.',
  'file.add.noFile': 'Eklenecek belge seçilmedi.',
  'file.add.done': '{count} sayfa eklendi.',
  'file.merge.metadataFrom': 'Üst veri kaynağı',
  'file.merge.metadataFrom.first': 'İlk belge',
  'file.merge.metadataFrom.current': 'Geçerli belge',

  'file.createImages.title': 'Görsellerden PDF oluştur',
  'file.createImages.intro':
    'Her görsel bir sayfa olur. Desteklenmeyen dosyalar atlanır ve rapora yazılır; metin katmanı olmayan yeni bir belge üretilir.',
  'file.createImages.name': 'Görseller',
  'file.createImages.files': 'Görseller',
  'file.createImages.choose': 'Görsel seç',
  'file.createImages.empty': 'Görsel seçilmedi.',
  'file.createImages.pageSize': 'Sayfa boyutu',
  'file.createImages.pageSize.fit': 'Görsele göre',
  'file.createImages.pageSize.a4': 'A4',
  'file.createImages.pageSize.letter': 'Letter',
  'file.createImages.fit': 'Yerleştirme',
  'file.createImages.fit.contain': 'Sığdır',
  'file.createImages.fit.cover': 'Doldur (kırp)',
  'file.createImages.fit.stretch': 'Uzat',
  'file.createImages.margin': 'Kenar boşluğu (mm)',
  'file.createImages.orientation': 'EXIF yönü',
  'file.createImages.orientation.auto': 'Otomatik uygula',
  'file.createImages.orientation.ignore': 'Yoksay',
  'file.createImages.done': '{count} görselden PDF oluşturuldu.',
  'file.createImages.unsupported': 'Desteklenmeyen görsel atlandı: {name}',

  'export.images.title': 'Sayfaları görüntü olarak dışa aktar',
  'export.images.intro':
    'Her sayfa ayrı bir görüntü dosyası olarak üretilir; görüntüde metin katmanı, bağlantı ve açıklama bulunmaz.',
  'export.images.format': 'Biçim',
  'export.images.format.png': 'PNG',
  'export.images.format.jpeg': 'JPEG',
  'export.images.format.webp': 'WebP',
  'export.images.loss.text':
    'Görüntü çıktısında metin katmanı, bağlantı ve açıklama yoktur; metin aranamaz ve seçilemez.',
  'export.images.dpi': 'Çözünürlük (DPI)',
  'export.images.dpiHint': 'Yüksek DPI daha büyük dosya üretir.',
  'export.images.namePattern': 'Dosya adı',
  'export.images.namePatternHint':
    'Numara ve uzantı otomatik eklenir; boş bırakılırsa belgenin adı kullanılır.',
  'export.images.zip': 'ZIP olarak indir',
  'export.images.done': '{count} görüntü üretildi.',
  'export.images.tooLarge':
    '{dpi} DPI bu sayfa için çok büyük (sınır {megapixels} MP). {suggested} DPI deneyin.',

  'export.text.title': 'Metni dışa aktar',
  'export.text.intro':
    'Metin, belgenin kendi metin katmanından çıkarılır. Taranmış sayfalarda metin katmanı yoktur; bu sayfalar boş kalır ve rapora yazılır.',
  'export.text.format': 'Biçim',
  'export.text.format.text': 'Düz metin',
  'export.text.format.markdown': 'Markdown',
  'export.text.source': 'Metin kaynağı',
  'export.text.source.layer': 'Belgenin metin katmanı',
  'export.text.source.ocr': 'OCR (taranmış sayfalar)',
  'export.text.detected': 'Bu belge taranmış görünüyor; OCR önerilir.',
  'export.text.done': 'Metin dışa aktarıldı: {name}',
  'export.text.covered': '{count} sayfadan metin çıkarıldı.',
  'export.text.empty': 'Seçilen sayfalarda metin bulunamadı.',
} as const;
