/**
 * OCR (`REPORT.md §3` A15).
 */

export const ocrPart = {
  'ocr.title': 'Metin tanıma (OCR)',
  'ocr.intro': 'Taranmış sayfaların üzerine aranabilir, görünmez bir metin katmanı eklenir.',
  'ocr.languages': 'Diller',
  'ocr.languagesHint': 'Her dil ayrı bir paket indirir; birden fazla dil tanımayı yavaşlatır.',
  'ocr.language.en': 'İngilizce',
  'ocr.language.tr': 'Türkçe',
  'ocr.language.missing': 'Dil paketi indirilmemiş: {lang}',
  'ocr.quality': 'Kalite',
  'ocr.quality.fast': 'Hızlı',
  'ocr.quality.best': 'Yüksek kalite',
  'ocr.dpi': 'Çözünürlük (DPI)',
  'ocr.dpiHint': '150–300 arası desteklenir.',
  'ocr.desktopOnly': 'OCR masaüstünde önerilir; çok sayfalı belgeler yavaş olabilir.',
  'ocr.textPresent': 'Bu sayfada zaten metin var ({count} sayfa); yazma modu',
  'ocr.textPresent.mode': 'Mevcut metin',
  'ocr.textPresentModeHint':
    'Metin katmanı olan sayfalarda ne yapılacağı; "atla" seçilirse bu sayfalar raporda listelenir.',
  'ocr.textPresent.skip': 'Metinli sayfaları atla',
  'ocr.textPresent.overwrite': 'Üzerine yaz',
  'ocr.skipped': '{count} sayfa zaten metin içeriyordu; değiştirilmedi.',
  'ocr.running': 'Sayfa {done}/{total} tanınıyor',
  'ocr.done': '{count} sayfaya metin katmanı eklendi.',
  'ocr.empty': 'Hiçbir sayfada metin bulunamadı.',
  'ocr.lowConfidence': 'Düşük güvenilirlikli sayfa: {page}',
  'ocr.pageFailed': 'Sayfa {page} tanınamadı: {reason}',
  'ocr.rotateHandled': 'Sayfa döndürmeleri tek kez uygulandı.',
} as const;
