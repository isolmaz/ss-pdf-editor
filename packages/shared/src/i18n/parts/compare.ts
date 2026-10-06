/**
 * Phase 4 document comparison (`PLAN.md §5/Phase 4`): the text diff and the
 * rendered-pixel diff of two documents (`ops/compare.ts`) and the panel that
 * renders their per-page rows (`panels/ComparePanel.tsx`).
 *
 * The words this workstream alone says live here: the panel's tab label
 * (`panel.compare`), the two run commands, the table's headers and the empty,
 * running and no-result states (`compare.*`), the per-row method, status and
 * detail lines, and the names of the bounds a comparison ran into
 * (`compare.reason.*`) — a bounded row says so rather than looking complete.
 *
 * Framework vocabulary stays in the shared parts: the progress lines are the
 * operations' own keys (`op.progress.textExport` for the extraction stage,
 * `op.progress.compress.render` for the raster stage), with `op.progress` and
 * `op.cancel`; none of them is repeated here. A comparison is a read of two byte
 * buffers — it journals nothing and writes nothing, so this part carries no note
 * of its own and a refused run reports the mapped `error.<code>.*` sentence.
 *
 * Every `{param}` is passed by the call site: the DPI in `compare.method.pixels`,
 * the two page counts, and the truncation reasons joined from `compare.reason.*`.
 */

export const comparePart = {
  'compare.title': 'Belge karşılaştırma',
  'compare.pick': 'İkinci belgeyi seç',
  'compare.picked': 'Seçilen: {name}',
  'compare.runText': 'Metni karşılaştır',
  'compare.runPixels': 'Görüntüyü karşılaştır',
  'compare.empty': 'Karşılaştırmak için ikinci bir PDF seçin.',
  'compare.running': 'Karşılaştırılıyor…',
  'compare.noResult': 'Henüz sonuç yok: Metni karşılaştır ya da Görüntüyü karşılaştır.',
  'compare.table': 'Sayfa bazında karşılaştırma sonuçları',
  'compare.column.page': 'Sayfa',
  'compare.column.method': 'Yöntem',
  'compare.column.status': 'Durum',
  'compare.column.detail': 'Ayrıntı',
  'compare.column.jump': 'Sayfaya git',
  'compare.jump': 'Git',
  'compare.method.text': 'Metin',
  'compare.method.pixels': 'Görüntü pikseli ({dpi} dpi)',
  'compare.status.identical': 'Aynı',
  'compare.status.changed': 'Değişti',
  'compare.status.added': 'Eklendi',
  'compare.status.removed': 'Silindi',
  'compare.status.unavailable': 'Karşılaştırılamadı',
  'compare.detail.lines': '{changed} değişen, {added} eklenen, {removed} silinen satır',
  'compare.detail.noChanges': 'Değişiklik yok',
  'compare.detail.pageOnly': 'Sayfa yalnızca bir belgede',
  'compare.pageCounts': 'Sayfa sayısı: {left} → {right}',
  'compare.mismatch': 'Sayfa sayısı farkı: {delta}',
  'compare.truncated': 'Karşılaştırma sınırlandı: {reasons}',
  'compare.truncatedRow': '* bu satırın ayrıntısı sınırlandı',
  'compare.reason.lineMatrix': 'satır matrisi sınırı',
  'compare.reason.wordMatrix': 'kelime matrisi sınırı',
  'compare.reason.lineList': 'satır listesi sınırı',
  'compare.reason.rasterCap': 'piksel sınırı',
  'compare.reason.pageTooLarge': 'sayfa piksel sınırının üzerinde',
  'compare.reason.pageSizeMismatch': 'sayfa boyutları farklı',
  'compare.reason.unknown': 'bilinmeyen sınır',
} as const;
