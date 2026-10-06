/**
 * Page-structure capabilities (reorder, rotate/delete/duplicate, extract, split).
 */

export const pagesPart = {
  'pages.select.all': 'Tümünü seç',
  'pages.select.none': 'Seçimi temizle',
  'pages.select.invert': 'Seçimi ters çevir',
  'pages.selected': '{count} sayfa seçildi',
  'pages.moveUp': 'Yukarı taşı',
  'pages.moveDown': 'Aşağı taşı',
  'pages.moveTo': 'Şu konuma taşı…',
  'pages.dragHandle': '{page}. sayfayı taşı',
  'pages.moved': '{count} sayfa taşındı.',
  'pages.rotate.left': 'Sola döndür',
  'pages.rotate.right': 'Sağa döndür',
  'pages.rotate.done': '{count} sayfa döndürüldü.',
  'pages.delete': 'Sayfaları sil',
  'pages.delete.done': '{count} sayfa silindi.',
  'pages.delete.lastPage': 'Belgenin tüm sayfaları silinemez.',
  'pages.duplicate': 'Sayfaları çoğalt',
  'pages.duplicate.done': '{count} sayfa çoğaltıldı.',
  'pages.extract.title': 'Sayfaları ayıkla',
  'pages.extract.intro':
    'Seçilen sayfalar yeni bir belge olur; geçerli belge değişmez. Bileşim yeni bir katalog yazar: görünüm tercihleri, dil ve katman yapılandırması yeni belgeye taşınmaz.',
  'pages.extract.done': '{count} sayfa ayıklandı.',
  'pages.insert': 'Sayfa ekle…',

  'split.title': 'Belgeyi böl',
  'split.intro':
    'Belge, seçilen kurala göre ayrı PDF dosyalarına bölünür. Parça sayısı ve dosya adları çalıştırıldığında hesaplanır ve raporda gösterilir. Her parça yeni bir katalog yazar: görünüm tercihleri, dil ve katman yapılandırması parçalara taşınmaz.',
  'split.mode': 'Bölme yöntemi',
  'split.mode.ranges': 'Aralıklara göre',
  'split.mode.everyN': 'Her N sayfada bir',
  'split.mode.size': 'Dosya boyutuna göre',
  'split.mode.booklet': 'Forma (booklet)',
  'split.ranges': 'Aralıklar',
  'split.rangesHint': 'Her aralık ayrı bir dosya olur ve artan sırada numaralanır.',
  'split.everyN': 'Sayfa sayısı',
  'split.everyNHint': 'Her parçadaki sayfa sayısı; forma modunda bir formalık sayfa sayısı.',
  'split.maxSize': 'En büyük parça (MB)',
  'split.maxSizeHint': 'Parçalar bu boyutu aşmamaya çalışılır; tek sayfa daha büyükse tek başına çıkar.',
  'split.partNames': 'Dosya adı öneki',
  'split.partNamesHint': 'Boş bırakılırsa belgenin adı kullanılır; numara ve uzantı otomatik eklenir.',
  'split.preview': '{count} parça üretilecek',
  'split.done': '{count} parça üretildi.',
  'split.zip': 'ZIP olarak indir',
  'split.tooMany': 'Çok fazla parça üretilecek; aralığı daraltın.',

  'pages.range.invalid': 'Sayfa aralığı okunamadı: {value}',
  'pages.range.duplicate': 'Aralıkta tekrar eden sayfa var: {value}',
  'pages.range.outOfBounds': 'Aralık belge sınırlarını aşıyor: {value}',
  'pages.range.none': 'Aralık en az bir sayfa içermeli.',
} as const;
