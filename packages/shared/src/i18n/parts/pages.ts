/**
 * Page-structure capabilities (reorder, rotate/delete/duplicate, extract, split).
 */

export const pagesPart = {
  'pages.select.all': 'Tümünü seç',
  'pages.select.none': 'Seçimi temizle',
  'pages.selected': '{count} sayfa seçildi',
  'pages.moveUp': 'Yukarı taşı',
  'pages.moveDown': 'Aşağı taşı',
  'pages.moveTo': 'Şu konuma taşı',
  'pages.dragHandle': '{page}. sayfayı taşı',
  'pages.moved': '{count} sayfa taşındı.',
  'pages.rotate.left': 'Sola döndür',
  'pages.rotate.right': 'Sağa döndür',
  'pages.rotate.done': '{count} sayfa döndürüldü.',
  'pages.delete': 'Sayfaları sil',
  'pages.delete.done': '{count} sayfa silindi.',
  'pages.duplicate': 'Sayfaları çoğalt',
  'pages.duplicate.done': '{count} sayfa çoğaltıldı.',

  'pages.reverse': 'Sayfa sırasını ters çevir',
  'pages.reverse.done': 'Sayfa sırası ters çevrildi.',

  'tidy.blank.title': 'Boş sayfaları kaldır',
  'tidy.blank.intro':
    'Metni, resmi, çizimi ya da notu olmayan sayfaları bulur; hiçbir şey değişmeden önce hangilerinin kalkacağını gösterir.',
  'tidy.blank.confirm': 'Boş sayfaları bul',
  'tidy.blank.removed': 'Kaldırılan boş sayfa: {count} (sayfa {pages}).',
  'tidy.blank.done': '{count} boş sayfa kaldırıldı.',
  'tidy.blank.none': 'Boş sayfa bulunamadı. Hiçbir şey değişmedi.',
  'tidy.blank.all': 'Bütün sayfalar boş görünüyor; hiçbiri kaldırılmadı. Hiçbir şey değişmedi.',
  'tidy.progress.scan': 'Boş sayfalar aranıyor',

  'tidy.split.title': 'Çift sayfalı taramaları böl',
  'tidy.split.intro':
    'Yatay her sayfayı yeniden çizmeden sol ve sağ sayfa olarak ikiye böler. Not ya da form alanı olan sayfalar bölünmez.',
  'tidy.split.done': '{count} sayfa sol ve sağ sayfa olarak bölündü (sayfa {pages}).',
  'tidy.split.lossless': 'Sayfa içeriği değişmedi; her yeni sayfa özgün sayfanın kendi yarısını gösterir.',
  'tidy.split.portrait': 'Yatay olmayan {count} sayfa olduğu gibi bırakıldı.',
  'tidy.split.annotated': 'Not, bağlantı ya da form alanı olan {count} sayfa bölünmedi (sayfa {pages}).',
  'tidy.split.none': 'Bölünebilecek, notsuz ve form alanı olmayan yatay sayfa yok. Hiçbir şey değişmedi.',
  'tidy.progress.split': 'Sayfalar bölünüyor',
  'pages.extract.title': 'Sayfaları ayıkla',
  'pages.extract.intro':
    'Seçilen sayfalar yeni bir belge olur; geçerli belge değişmez. Görünüm tercihleri, dil ve katman ayarları yeni belgeye taşınmaz.',
  'organize.status': '{total} sayfadan {selected} tanesi seçili',
  'organize.page': '{page}. sayfa',
  'organize.help':
    'Sayfaları seçin; sürükleyin ya da Alt ya da Ctrl ile bir ok tuşuna basarak taşıyın. Enter sayfayı açar.',
  'organize.size': 'Küçük resim boyutu',
  'organize.selectMode': 'Birden çok seç',
  'organize.close': 'Belgeye dön',
  'organize.moveEarlier': 'Öne taşı',
  'organize.moveLater': 'Arkaya taşı',
  'organize.movedTo': '{position}. konuma taşındı.',

  'split.title': 'Belgeyi böl',
  'split.intro':
    'Belge, seçilen kurala göre ayrı PDF dosyalarına bölünür; parça sayısı ve adları raporda görünür. Görünüm tercihleri, dil ve katmanlar taşınmaz.',
  'split.mode': 'Bölme yöntemi',
  'split.mode.ranges': 'Aralıklara göre',
  'split.mode.everyN': 'Her N sayfada bir',
  'split.mode.size': 'Dosya boyutuna göre',
  'split.mode.booklet': 'Forma (booklet)',
  'split.mode.bookmarks': 'Yer imlerine göre',
  'split.bookmarkLevel': 'Yer imi düzeyi',
  'split.bookmarkLevelHint':
    '1 yalnızca üst düzey yer imlerinden böler; daha büyük sayı içlerindeki yer imlerinden de böler.',
  'split.bookmarks.lead': 'Başlangıç',
  'split.ranges': 'Aralıklar',
  'split.rangesHint': 'Her aralık ayrı bir dosya olur ve artan sırada numaralanır.',
  'split.everyN': 'Sayfa sayısı',
  'split.everyNHint': 'Her parçadaki sayfa sayısı; forma modunda bir formalık sayfa sayısı.',
  'split.maxSize': 'En büyük parça (MB)',
  'split.maxSizeHint': 'Parçalar bu boyutu aşmamaya çalışılır; tek sayfa daha büyükse tek başına çıkar.',
  'split.partNames': 'Dosya adı öneki',
  'split.partNamesHint':
    'Boş bırakılırsa belgenin adı kullanılır; numara, yer imine göre bölmede yer imi başlığı ve uzantı eklenir.',
  'split.done': '{count} parça üretildi.',
  'split.note.oversized':
    '{count} sayfa tek başına seçilen boyut sınırından büyük; sayfa bölünemediği için her biri kendi dosyasında sınırı aşıyor (sayfa: {pages}).',
  'split.note.bookmarksSkipped':
    '{count} yer imi bu belgede bir sayfaya işaret etmediği için bölmede kullanılmadı.',
} as const;
