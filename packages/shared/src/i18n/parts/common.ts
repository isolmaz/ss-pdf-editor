/**
 * Shared operation vocabulary (`PLAN.md §9/K3`): the words every Phase 2 panel,
 * dialog, progress line and result report uses.
 *
 * The dictionary is split by namespace so a capability's copy lives with the
 * capability: `parts/<group>.ts`. This file owns the cross-cutting verbs.
 * Every key is flat and dotted, like the rest of `tr`.
 */

export const commonPart = {
  'unit.pt': 'pt',
  'op.apply': 'Önizle',
  'op.cancel': 'Vazgeç',
  'op.close': 'Kapat',
  'op.running': 'İşleniyor…',
  'op.busy': 'Başka bir işlem sürüyor — bitmesini bekleyin.',
  'op.progress': '{label} ({done}/{total})',
  'op.cancelled': 'İşlem iptal edildi.',
  'op.cancelRequested': 'İptal istendi…',

  'op.scope': 'Sayfa aralığı',
  'op.scope.all': 'Tüm sayfalar ({count})',
  'op.scope.current': 'Geçerli sayfa ({page})',
  'op.scope.selection': 'Seçilen sayfalar ({count})',
  'op.scope.custom': 'Aralık',
  'op.scope.placeholder': 'örn. 1-3, 5, 8-10',
  'op.scope.empty': 'Hiç sayfa seçilmedi.',

  'op.result.title': 'İşlem raporu',
  'op.result.pages': '{count} sayfa',
  'op.result.size': 'Boyut: {before} → {after}',
  'op.result.size.grew': 'Boyut: {before} → {after} (büyüdü)',
  'op.result.steps': 'Çalışan adımlar: {steps}',
  'op.result.incremental': 'Artımlı yazıldı',
  'op.result.fullRewrite': 'Yeniden yazıldı (artımlı değil)',
  'op.result.losses': 'Kaybedilenler',
  'op.result.preserved': 'Korunanlar',
  'op.result.notes': 'Notlar',
  'op.result.apply': 'Belgeye uygula',
  'op.result.newTab': 'Yeni sekmede aç',
  'op.result.download': 'İndir',
  'op.result.applied': 'Belgeye uygulandı: {label} (Ctrl+Z ile geri alın)',
  'op.result.noChangePages': 'Değişiklik yapılmadı: işlemin uygulanacağı sayfa bulunamadı.',
  'op.result.opened': 'Yeni sekmede açıldı: {name}',
  'op.result.downloaded': 'İndirildi: {name}',
  'op.result.files': '{count} dosya üretildi',
  'op.result.confirmDestructive': 'Bu işlem geri alınamaz biçimde içerik silebilir. Devam edilsin mi?',

  'op.undo': 'Geri al',
  'op.redo': 'Yinele',
  'op.undo.done': 'Geri alındı: {label}',
  'op.undo.unavailable': 'Bu adımın verisi bu oturumda yok; geri alınamıyor.',
  'op.redo.done': 'Yinelendi: {label}',
  'op.history.empty': 'Bu belgede işlem geçmişi yok.',

  'op.step.pages': 'sayfa düzeni',
  'op.step.rotate': 'sayfa döndürme',
  'op.step.metadata': 'üst veri',
  'op.step.stamp': 'damga',
  'op.step.mupdf': 'MuPDF yazımı',
  'op.step.qpdf': 'şifreleme',
  'op.step.ocr': 'OCR',
  'op.step.render': 'görüntüleme',
  'op.step.verify': 'doğrulama',

  'unit.mm': 'mm',
} as const;
