/**
 * Page composition, split and image operations — the notes and progress
 * sentences of `ops/compose.ts`, `ops/split.ts` and `ops/images.ts`.
 *
 * Why these are their own part: every entry is a *measurement* the operation
 * reports back (what the engine carried, what it dropped, what it is doing right
 * now), so the wording is part of the product's honesty contract rather
 * than UI decoration. `op.note.compose.catalog` is shared by `composeDocument`
 * and `mergeDocuments` because both run the same pdf.js `extractPages` writer
 * and therefore drop the same catalog entries.
 *
 * Wired into `tr.ts` by the integration owner (the keys arrive with the ops).
 */

export const pageopsPart = {
  // Progress: real units, never a synthetic percentage.
  'op.progress.compose.extract': 'Sayfalar bileştiriliyor…',
  // Counts belong to the banner's own template (`op.progress`): a label that also
  // interpolated them printed the placeholder twice — "Döndürme uygulanıyor:
  // {done}/{total} (1/1)" — because the label was translated with no params.
  'op.progress.compose.rotate': 'Döndürme uygulanıyor',
  'op.progress.merge.documents': 'Belgeler birleştiriliyor…',
  'op.progress.split.parts': 'Parça üretiliyor',
  'op.progress.images.embed': 'Görseller ekleniyor',
  'op.progress.images.render': 'Sayfalar görüntüye dönüştürülüyor',

  // composeDocument
  'op.note.compose.storage': 'Açıklamalar ve form değerleri belgenin kendi deposundan taşındı.',
  'op.note.compose.catalog':
    'Bileşim yeni bir katalog yazar: görünüm tercihleri, dil, çıktı amaçları, katman (OCG) yapılandırması ve açılış eylemi taşınmaz.',
  'op.note.compose.rotation': '{count} sayfaya döndürme uygulandı (kaynak döndürme + istenen açı).',
  'op.note.compose.outlineCopies':
    'Çoğaltılan sayfa nedeniyle içindekiler ağacı {copies} kez yinelendi (extractPages davranışı).',
  'op.note.compose.verified': 'Bileşim doğrulandı: {pages} sayfa.',

  // mergeDocuments
  'op.note.merge.metadata': 'Eklenen belgelerin üst verisi taşınmadı; Info ve XMP taban belgeden alındı.',
  'op.note.merge.encryptionDropped':
    'Birleştirilen belgelerin parola koruması taşınmadı; birleştirilmiş dosya korumasızdır.',
  'op.note.merge.structure':
    'Motorun birleştirdiği yapı ölçüldü: {outline} yer imi, {labels} sayfa etiketi kaydı, {fields} form alanı.',
  'op.note.merge.outlineLost': 'Taban belgede {expected} yer imi vardı, sonuçta {actual} kaldı.',
  'op.note.merge.verified': 'Birleştirme doğrulandı: {pages} sayfa.',

  // imagesToPdf
  'op.note.images.unsupported': 'Desteklenmeyen görsel atlandı: {name}',
  'op.note.images.failed': 'Görsel eklenemedi (bozuk olabilir) ve atlandı: {name}',
  'op.note.images.exif': '{count} görselde EXIF yönü uygulandı.',
} as const;
