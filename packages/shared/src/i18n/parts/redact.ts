/**
 * Redaction — true erasure with MuPDF.
 */

export const redactPart = {
  'redact.title': 'Karartma (kalıcı silme)',
  'redact.intro': 'İşaretlenen alanlardaki metin ve grafikler belgeden kalıcı olarak silinir.',
  'redact.mode.box': 'Kutu çiz',
  'redact.tool.start': 'Karartma aracını aç',
  'redact.tool.stop': 'Karartma aracını kapat',
  'redact.marks': 'İşaretler',
  'redact.marks.empty': 'Henüz işaret yok. Sayfa üzerinde kutu çizin.',
  'redact.markCount': '{count} işaret',
  'redact.removeMark': 'İşareti kaldır',
  'redact.clearMarks': 'İşaretleri temizle',
  'redact.cleanMetadata': 'Üst veri ve ekleri de temizle',
  'redact.verify.done': 'Doğrulama: hedeflenen içerik artık belgede yok.',
  'redact.verify.failed': 'Doğrulama başarısız: hedeflenen içerik hâlâ bulunuyor.',
  'redact.warning.localTrace':
    'Karartma, dışa aktarılan dosyadan içeriği siler; cihazdaki önceki kopyalar (özgün dosya, taslak, küçük resim) ayrıca ele alınmalıdır.',
  'redact.sensitive.on': 'Hassas oturum: kalıcı taslak kapalı.',
  'redact.sensitive.off': 'Hassas oturum kapatıldı.',
  'redact.imageMethod': 'Görsel işleme',
  'redact.imageMethodHint':
    'Kutu bir görselin üzerine geldiğinde ne yapılacağı: görseli tamamen kaldırmak ya da yalnızca kutu içindeki pikselleri silmek.',
  'redact.cleanInfo': 'Üst veri (Info + XMP)',
  'redact.cleanAttachments': 'Ekler (tümü)',
  'redact.cleanHint': 'Seçilenler karartma sırasında belgeden tamamen silinir.',
  'redact.verify.remaining': 'Doğrulama: {count} sayfada içerik hâlâ bulunuyor.',
  'redact.imageMethod.none': 'Görsellere dokunma',
  'redact.imageMethod.remove': 'Görseli tamamen kaldır',
  'redact.imageMethod.pixels': 'Sadece kutu içini sil',
} as const;
