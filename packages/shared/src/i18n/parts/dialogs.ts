/**
 * Operation-dialog, command and dock vocabulary.
 *
 * Only the keys the shared dialog framework itself authors live here: the field
 * renderer, the progress/cancel state machine and the result report. A
 * capability's own labels (`stamp.format`, `redact.mode.*`) stay in that
 * capability's part — this file is the framework's share of the dictionary, and
 * every key here is used by `packages/pdf-ui/src/dialogs/**`, `commands/**`,
 * `shell/Dock.tsx` or `panels/**`.
 *
 * The cross-cutting vocabulary (`op.*`, `progress.*`, `palette.*`, `dock.*`) was
 * already written by the shell owner; what is left are the four sentences the
 * framework alone says: the second half of a destructive confirmation, the
 * number-field range error, the two report groups that had no heading yet, and
 * the redaction mark's page line.
 */

export const dialogsPart = {
  /**
   * The confirm button of the blocking destructive step.
   * Deliberately a verb with no object: the sentence above it names the loss, and
   * `op.result.confirmDestructive` is the question this answers.
   */
  'dialog.confirm.continue': 'Devam et',

  /** A number field whose value fell outside the range its spec declares. */
  'dialog.field.numberRange': 'Bu değer {min} ile {max} arasında olmalı.',
  'dialog.field.chooseFile': 'Dosya seç',
  'dialog.field.chooseFiles': 'Dosyaları seç',
  'dialog.field.noFile': 'Henüz dosya seçilmedi',
  'dialog.field.filesChosen': '{count} dosya seçildi',
  'dialog.advanced': 'Gelişmiş seçenekler ({count})',
  'dialog.step.settings': 'Ayarlar',
  'dialog.step.review': 'Önizle ve uygula',
  'dialog.step.result': 'Sonuç',

  /** Report groups `op.result.losses`/`op.result.preserved` did not name. */
  'dialog.result.changed': 'Değişenler',
  'dialog.result.warnings': 'Uyarılar',

  /** One redaction mark: the page it was drawn on (1-based, as the UI counts). */
  'dialog.redactMark.page': '{page}. sayfa',
} as const;
