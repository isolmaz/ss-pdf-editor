/**
 * Error vocabulary of the operation panels: the codes they can raise in addition
 * to the base set. Every code needs a Turkish
 * message and a "what to do" hint — `errors.test.ts` holds the line count.
 */

export const errorsPart = {
  'error.pending-redactions.message':
    'Uygulanmamış karartma işaretleri var; kaydetme ve dışa aktarma durduruldu.',
  'error.pending-redactions.hint':
    'Belge kaydedilmedi. Karartmaları uygulayın veya işaretleri temizleyip yeniden deneyin; işaretler uygulanmadan teslim edilen dosya, kaldırılması istenen içeriği hâlâ taşır.',
  'error.range-invalid.message': 'Sayfa aralığı okunamadı.',
  'error.range-invalid.hint': '1-3, 5 veya 8-10 gibi bir aralık girin.',
  'error.value-out-of-range.message': 'Bir alanın değeri izin verilen aralığın dışında.',
  'error.value-out-of-range.hint': 'İşaretli alanı izin verilen en küçük ve en büyük değer arasında girin.',
  'error.selection-empty.message': 'Önce sayfa seçin.',
  'error.selection-empty.hint': 'Sayfalar panelinden bir veya daha fazla sayfa seçin.',
  'error.no-text.message': 'Seçilen sayfalarda okunabilir metin yok.',
  'error.no-text.hint': 'Sayfalar taranmış görünüyor; önce OCR uygulayıp yeniden deneyin.',
  'error.no-match.message': 'Aranan metin seçilen sayfalarda bulunamadı.',
  'error.no-match.hint':
    'Yazımı kontrol edin; büyük/küçük harf ve tam sözcük seçeneklerini kapatıp yeniden deneyin. Taranmış sayfalarda önce OCR gerekir.',
  'error.no-xfa.message': 'Bu belgede XFA formu yok.',
  'error.no-xfa.hint': 'Bu işlem yalnızca XFA içeren PDF formlarında çalışır.',
  'error.xfa-dynamic.message': 'Bu dinamik bir XFA formu: içeriği yalnızca XFA şablonunda duruyor.',
  'error.xfa-dynamic.hint':
    'Formu “XFA formunu doldur” ile açın ya da “XFA formunu normal PDF’ye dönüştür” işlemini kullanın.',
  'error.xfa-static.message': 'Bu statik bir XFA formu: sayfaları zaten PDF’in içinde.',
  'error.xfa-static.hint':
    'Alanları “Form alanlarını düzleştir” ile düzleştirin ya da “XFA’yı kaldır” ile yalnızca AcroForm’u bırakın.',
  'error.password-policy.message': 'Parola politikası gereği işlem durduruldu.',
  'error.password-policy.hint': 'Açma parolası olmadan şifreleme yapılamaz.',
} as const;
