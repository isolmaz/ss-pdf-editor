/** Straighten scanned pages (`pdf-core/src/ops/deskew.ts`, `pdf-ui/src/ops/deskew.ts`). */

export const deskewPart = {
  'deskew.title': 'Eğik sayfaları düzelt',
  'deskew.intro':
    'Taranmış sayfaların eğikliği ölçülür ve içerik dikleştirilir. Tarama yeniden kodlanmaz, sayfa boyutu değişmez; açıklamalar yerinde kalır.',
  'deskew.done': '{count} sayfa düzeltildi.',
  'home.tool.deskew': 'Eğik taranmış sayfaları ölçüp dikleştirin.',
  'op.progress.deskew': 'Sayfa eğikliği ölçülüyor',

  'deskew.note.straightened': 'Sayfa {page}: {angle:degrees} eğiklik giderildi.',
  'deskew.note.level': 'Sayfa {page} zaten düz; değiştirilmedi.',
  'deskew.note.unclear': 'Sayfa {page} atlandı: net metin satırı bulunamadı.',
  'deskew.note.edge': 'Sayfa {page} atlandı: {angle:degrees} döndürülürse metin sayfa kenarından taşardı.',
  'deskew.note.lossless':
    'Taramalar yeniden kodlanmadı: sayfa içeriğine yalnızca bir döndürme eklendi. Sayfa boyutu ve kutular değişmedi.',
  'deskew.note.annotations':
    'Düzeltilen sayfalardan {count} tanesinde açıklama, bağlantı ya da form alanı var; bunlar yerinde kaldı ve içerikle hizalanmayabilir.',
  'deskew.note.unchanged': 'Seçilen sayfalarda düzeltilecek bir şey yok; dosya yazılmadı.',
} as const;
