/**
 * Error vocabulary added by Phase 2 (`PLAN.md §3.1`): the codes the operation
 * panels can raise in addition to the Phase 0/1 set. Every code needs a Turkish
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
  'error.password-policy.message': 'Parola politikası gereği işlem durduruldu.',
  'error.password-policy.hint': 'Açma parolası olmadan şifreleme yapılamaz.',
} as const;
