/**
 * Document-operation notes, progress labels and report wording for the
 * capabilities implemented in `packages/pdf-core/src/ops` (`metadata`, `stamp`,
 * `impose`, `compress`, `text-export`).
 *
 * Every `note(...)` key and every progress `labelKey` those operations emit is
 * declared here, so an untranslated note stays a compile error instead of an
 * English string in the interface (`packages/pdf-core/src/ops/types.ts`).
 *
 * The loss/preservation wording is a product promise: a
 * `lost` note names what the user will actually miss, a `preserved` note names
 * the guarantee the operation makes, a `warning` says where to look.
 */

export const docopsPart = {
  /* progress labels: the phase name; the numbers come from `done`/`total` */
  'op.progress.metadata': 'Belge özellikleri yazılıyor',
  'op.progress.stamp': 'Damga çiziliyor',
  'op.progress.impose': 'Yapraklar oluşturuluyor',
  'op.progress.compress.render': 'Sayfalar görüntüye çevriliyor',
  'op.progress.compress.assemble': 'Belge yeniden oluşturuluyor',
  'op.progress.textExport': 'Metin çıkarılıyor',

  /* metadata (Info + XMP) */
  'op.note.metadata.infoDropped': 'Info alanları (başlık, yazar, tarihler) silindi.',
  'op.note.metadata.producerKept': 'Üretici satırı korundu: {producer}',
  'op.note.metadata.xmpDropped': 'XMP paketi silindi.',
  'op.note.metadata.xmpCreated': 'Yeni bir XMP paketi yazıldı.',
  'op.note.metadata.xmpMerged': 'XMP paketi korunarak güncellendi; paketteki diğer alanlara dokunulmadı.',
  'op.note.metadata.xmpUntouched': 'XMP paketi değiştirilmedi.',

  /* header/footer, page numbers, Bates, watermark */
  'op.note.stamp.drawn': '{count} sayfaya damga çizildi.',
  'op.note.stamp.fontEmbedded': 'Yazı tipi gömüldü: {font} (Türkçe karakterler için gerekli).',
  'op.note.stamp.rotateAware':
    '{count} döndürülmüş sayfada konum sayfa döndürmesine göre hesaplandı; damga ekranda düz okunur.',
  'op.note.stamp.untouchedPages': 'Seçilmeyen {count} sayfa değiştirilmedi.',
  'op.note.stamp.fileTokenEmpty': 'Belgede başlık olmadığı için {file} boş bırakıldı.',
  'op.note.stamp.overContent': 'Filigran sayfa içeriğinin üzerine çizildi.',
  'op.note.stamp.imageEmbedded': 'Filigran görseli gömüldü: {name}',
  'op.note.stamp.noPrint':
    'Yazdırma engeli PDF optik katmanı (OCG, yazdırma durumu kapalı) ile uygulandı; katmanları yok sayan görüntüleyiciler damgayı yine yazdırabilir.',

  /* imposition: N-up, booklet, poster */
  'op.note.impose.sheets': '{sheets} yaprak üretildi.',
  'op.note.impose.padded': 'Formayı tamamlamak için {count} boş sayfa eklendi.',
  'op.note.impose.rotated': '{count} sayfa hücresine sığması için 90° döndürüldü.',
  'op.note.impose.cropMarks': 'Kesim (hizalama) işaretleri eklendi.',
  'op.note.impose.vector': 'Sayfa içeriği vektör olarak kaldı; metin seçilebilir ve aranabilir.',
  'op.note.impose.infoCopied': 'Belge özellikleri (Info) yeni belgeye kopyalandı.',
  'op.note.impose.lostInteractive':
    'Bağlantılar, açıklamalar, form alanları ve içindekiler yeni yapraklara taşınmaz.',

  /* compression: structure and raster */
  'op.note.compress.infoDropped': 'Info alanları (başlık, yazar, tarihler) silindi.',
  'op.note.compress.infoKept': 'Info alanları korundu.',
  'op.note.compress.structureContent':
    'İçerik, bağlantılar, açıklamalar, içindekiler ve form alanları korundu.',
  'op.note.compress.rasterized':
    '{count} sayfa görüntüye çevrildi: bu sayfalarda metin katmanı, bağlantılar ve açıklamalar kayboldu ve arama çalışmaz; içindekiler bu sayfalara gitmeye devam eder.',
  'op.note.compress.greyscale': 'Sayfalar gri tonlamaya çevrildi.',
  'op.note.compress.rotationBaked':
    '{count} sayfada döndürme görüntünün içine işlendi; sayfa boyutu görünen (döndürülmüş) boyut oldu.',
  'op.note.compress.otherPages': 'Seçilmeyen {count} sayfa olduğu gibi korundu.',
  'op.note.compress.infoCopied': 'Belge özellikleri (Info) korundu.',
} as const;
