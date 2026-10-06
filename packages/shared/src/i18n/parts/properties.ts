/**
 * Document properties: Info + XMP read/write.
 */

export const propertiesPart = {
  'properties.title': 'Belge özellikleri',
  'properties.intro':
    'Değerler Info sözlüğüne yazılır; "XMP paketine de yaz" işaretlenirse XMP paketi de güncellenir. Üretici satırı her durumda korunur.',
  'properties.keep.title': 'Mevcut değerler',
  'properties.keep.note': 'Belgedeki değerler korunur; yalnızca doldurulan alanlar değiştirilir.',
  'properties.info': 'Info sözlüğü',
  'properties.xmp': 'XMP',
  'properties.field.title': 'Başlık',
  'properties.field.keepHint': 'Boş bırakılırsa değiştirilmez.',
  'properties.field.dateHint': 'Boş bırakılırsa değiştirilmez. Örnek: 2026-09-15 veya D:20260915120000Z',
  'properties.field.author': 'Yazar',
  'properties.field.subject': 'Konu',
  'properties.field.keywords': 'Anahtar sözcükler',
  'properties.field.keywordsHint': 'Virgülle ayırın.',
  'properties.field.creator': 'Oluşturan uygulama',
  'properties.field.producer': 'Üretici',
  'properties.field.creationDate': 'Oluşturma tarihi',
  'properties.field.modificationDate': 'Değiştirme tarihi',
  'properties.field.trapped': 'Trapped',
  'properties.empty': 'Bu belgede üst veri yok.',
  'properties.xmpPresent': 'XMP paketi var',
  'properties.xmpAbsent': 'XMP paketi yok (yazınca oluşturulur)',
  'properties.producer.locked': 'Üretici satırı ürün politikası gereği korunur.',
  'properties.done': 'Belge özellikleri güncellendi.',
  'properties.noChange': 'Yazılacak bir değişiklik yok; belge olduğu gibi bırakıldı.',
  'properties.writeXmp': 'XMP paketine de yaz',
  'properties.writeXmpHint':
    'XMP paketi varsa korunarak güncellenir, yoksa oluşturulur. İşaretlenmezse yalnızca Info yazılır.',
  'properties.clean.title': 'Üst veriyi temizle',
  'properties.clean.info': 'Info alanlarını sil',
  'properties.clean.xmp': 'XMP paketini sil',
  'properties.clean.warning': 'Temizleme, üretici satırını silmez (AGPL bildirimi).',
  'properties.dates.invalid': 'Tarih okunamadı: {value}',
} as const;
