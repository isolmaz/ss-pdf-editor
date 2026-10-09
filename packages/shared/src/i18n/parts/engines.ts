/**
 * Engine-backed capabilities: encryption/unlocking,
 * redaction and OCR.
 *
 * The notes here are the product's honesty contract for the three
 * operations where "did it actually work?" is the whole question: an encryption
 * that silently produced an unencrypted file, a redaction that left the text in
 * a previous revision, or an OCR layer that is not selectable must be visible in
 * the report — that is what these keys say.
 */

export const enginesPart = {
  'op.note.security.encryptionApplied': 'AES-256 şifreleme uygulandı.',
  'op.note.security.opensWithoutPassword':
    'Belge parolasız açılıyor; izinler yalnızca sahip parolasıyla sınırlanır.',
  'op.note.security.signatureInvalidated':
    'Belgede dijital imza var. Şifreleme dosyayı yeniden yazdığı için imza artık geçerli olmayacak.',
  'op.note.security.signatureInvalidatedUnlock':
    'Belgede dijital imza var. Parolayı kaldırmak dosyayı yeniden yazdığı için imza artık geçerli olmayacak.',
  'op.note.security.verified': 'Çıktı yeniden açılıp şifreleme doğrulandı.',
  'op.note.security.protectionRemoved': 'Parola kaldırıldı; çıktı korumasız.',
  'op.note.security.alreadyUnprotected': 'Belge zaten şifresiz; dosya değiştirilmedi.',

  'op.note.redact.contentErased': 'Hedeflenen içerik belgeden silindi.',
  'op.note.redact.verified': 'Silme doğrulandı: işaretli alanlarda içerik kalmadı.',
  'op.note.redact.singleRevision': 'Çıktı tek revizyon; önceki sürüm dosyada kalmadı.',
  'op.note.redact.imagesUntouched': 'Görsellere dokunulmadı; yalnızca işaretli alanlar temizlendi.',
  'op.note.redact.emptyMarks':
    'Uyarı: {pages}. sayfadaki işaret hiçbir metinle örtüşmedi; o alanlarda silinen içerik yok.',
  'op.note.redact.metadataCleared': 'Üst veri temizlendi.',
  'op.note.redact.producerKept': 'Üretici satırı korundu.',
  'op.note.redact.attachmentsRemoved': '{count} ek kaldırıldı.',
  'op.note.redact.fieldsRemoved': 'İşaretli alanların altındaki {count} form alanı kaldırıldı.',
  'op.note.redact.xfaDropped':
    'XFA form tanımı ve verisi atıldı: kaldırılan alanların değerlerini hâlâ taşıyorlardı. Kalan AcroForm alanları değerlerini korur.',
  'op.note.redact.annotationsRemoved':
    'İşaretli alanların altındaki {count} açıklama (yorum, işaretleme) kaldırıldı.',

  'op.progress.encrypt': 'Belge şifreleniyor',
  'op.progress.decrypt': 'Parola kaldırılıyor',
  'op.progress.redact': 'Alanlar siliniyor',
  'op.progress.redact.save': 'Belge yeniden yazılıyor',

  'op.progress.ocr.detect': 'Taranmış sayfalar belirleniyor',
  'op.progress.ocr.save': 'Metin katmanı yazılıyor',
  'op.note.ocr.layerAdded': '{pages} sayfaya {words} kelimelik görünmez metin katmanı eklendi ({dpi} DPI).',
  'op.note.ocr.skippedPages': 'Metni olan {count} sayfa atlandı.',
  'op.note.ocr.overwriteIsAdditive':
    '"Yeniden oku" mevcut metni silmez; tanınan sözcükler yeni bir katman olarak eklenir.',
  'op.note.ocr.lowConfidence': 'Sayfa {page}: düşük güvenilirlik (%{confidence}).',
  'op.note.ocr.hiddenLayer': 'Metin katmanı görünmez yazıldı; seçilebilir ve aranabilir.',
  'op.note.ocr.bestModel':
    'Seçilen dillerden bazılarının yalnızca en yüksek kalite modeli var; tanıma o modelle yapıldı (daha yavaş, daha doğru).',
} as const;
