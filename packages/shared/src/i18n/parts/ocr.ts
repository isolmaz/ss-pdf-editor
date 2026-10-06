/**
 * OCR.
 */

export const ocrPart = {
  'ocr.title': 'Metin tanıma (OCR)',
  'ocr.intro': 'Taranmış sayfaların üzerine aranabilir, görünmez bir metin katmanı eklenir.',
  'ocr.languages': 'Diller',
  'ocr.languagesHint': 'Her dil ayrı bir paket indirir; birden fazla dil tanımayı yavaşlatır.',
  'ocr.language.en': 'İngilizce',
  'ocr.language.tr': 'Türkçe',
  'ocr.quality': 'Kalite',
  'ocr.quality.fast': 'Hızlı',
  'ocr.quality.best': 'Yüksek kalite',
  'ocr.dpi': 'Çözünürlük (DPI)',
  'ocr.dpiHint': '150–300 arası desteklenir.',
  'ocr.textPresent.mode': 'Mevcut metin',
  'ocr.textPresentModeHint':
    'Metin katmanı olan sayfalarda ne yapılacağı; "atla" seçilirse bu sayfalar raporda listelenir.',
  'ocr.textPresent.skip': 'Metinli sayfaları atla',
  'ocr.textPresent.overwrite': 'Üzerine yaz',
  'ocr.skipped': '{count} sayfa zaten metin içeriyordu; değiştirilmedi.',
  'ocr.running': 'Sayfa {done}/{total} tanınıyor',
  'ocr.done': '{count} sayfaya metin katmanı eklendi.',
  'ocr.empty': 'Hiçbir sayfada metin bulunamadı.',
} as const;
