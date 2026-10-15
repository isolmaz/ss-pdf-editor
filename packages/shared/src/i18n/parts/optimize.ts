/**
 * Optimisation and export of the whole document.
 */

export const optimizePart = {
  'optimize.title': 'Optimize et / küçült',
  'optimize.intro':
    'Görüntüye çevirme, seçilen sayfalarda metin katmanını, bağlantıları, açıklamaları ve içindekileri kaybeder; arama çalışmaz. Yapıyı koru içeriği değiştirmez. Sonuç dosya özgün dosyadan büyük çıkabilir.',
  'optimize.mode': 'Yöntem',
  'optimize.mode.structure': 'Yapıyı koru (kayıpsız)',
  'optimize.mode.rasterize': 'Sayfaları görüntüye çevir (kayıplı)',
  'optimize.imageQuality': 'Görsel kalitesi',
  'optimize.qualityHint': '0,3 küçük dosya, 0,95 yüksek kalite (JPEG kalitesi).',
  'optimize.dpi': 'Çözünürlük (DPI)',
  'optimize.greyscale': 'Gri tonlamaya çevir',
  'optimize.stripMetadata': 'Üst veriyi temizle',
  'optimize.producerKept': 'Üretici satırı korunur.',
  'optimize.grew': 'Sonuç dosya özgün dosyadan büyük; sıkıştırma kazanç sağlamadı.',
  'optimize.saved': '{before:bytes} → {after:bytes} (%{percent} azalma)',
  'optimize.noGain': 'Kazanç yok: {before:bytes} → {after:bytes}',
} as const;
