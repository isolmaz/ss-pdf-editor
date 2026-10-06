/**
 * Measurement tool: distance, perimeter and area
 * measured on the page, with the page's scale, a grid and snapping.
 *
 * The words this tool alone says live here: the tool and its three measurements
 * (`tools.measure.*`), the scale field, its example and the refusal that keeps the
 * previous scale when the new one cannot be read, the unit, the grid and the snap
 * options (`tools.measure.unit`, `tools.measure.grid*`, `tools.measure.snap*`),
 * the progress line of the write and its notes (`op.progress.measure`,
 * `op.note.measure.*`) — including the note that says which `/Measure` subtypes are
 * Acrobat's own spelling and which names the standard defines.
 *
 * Framework vocabulary stays in the shared parts: the operation dialog's own labels
 * and buttons come from `dialog.*`, cancel and progress from `op.*`, and a refusal
 * reports the mapped `error.<code>.*` sentence — none of them is repeated here.
 *
 * Every `{param}` is passed by the call site.
 */

export const measurePart = {
  'tools.measure': 'Ölçüm',
  'tools.measure.distance': 'Mesafe',
  'tools.measure.perimeter': 'Çevre',
  'tools.measure.area': 'Alan',
  'tools.measure.scale': 'Ölçek',
  'tools.measure.scaleHint': 'örn. 1:100 · 1 cm = 5 m',
  'tools.measure.scaleUnreadable': 'Bu ölçek okunamadı; önceki ölçek geçerli.',
  'tools.measure.unit': 'Birim',
  'tools.measure.grid': 'Izgara',
  'tools.measure.gridGap': 'Aralık',
  'tools.measure.snapGrid': 'Izgaraya yapıştır',
  'tools.measure.snapPoints': 'Noktalara yapıştır',
  'op.progress.measure': 'Ölçümler yazılıyor',
  'op.note.measure.written': '{count} ölçüm açıklaması /Measure sözlüğüyle yazıldı.',
  'op.note.measure.readers':
    "/Measure sözlüğündeki /A ve /P alt türleri Acrobat'ın yazdığı biçimdir; ISO 32000-1 yalnızca /RL ve /GEO adlarını tanımlar.",
  'op.note.measure.nothing': 'Yazılacak ölçüm yok; belge olduğu gibi bırakıldı.',
} as const;
