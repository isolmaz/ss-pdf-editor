/** Find and replace across the document (`pdf-core/ops/find-replace.ts`). */

export const findReplacePart = {
  'findReplace.title': 'Bul ve değiştir',
  'findReplace.intro':
    'Belgedeki bir metni bulun ve her geçtiği yerde değiştirin. Eski metin gerçekten silinir; yenisi aynı yere, aynı boyut ve renkte yazılır.',
  'findReplace.confirm': 'Tümünü değiştir',
  'findReplace.find': 'Aranan',
  'findReplace.replace': 'Yeni metin',
  'findReplace.replaceHint': 'Boş bırakırsanız bulunan metin silinir.',
  'findReplace.matchCase': 'Büyük/küçük harfe duyarlı',
  'findReplace.wholeWord': 'Yalnızca tam sözcük',
  'findReplace.done': '{count} eşleşme değiştirildi.',
  'findReplace.fromFindBar': 'Değiştir…',
  'cmd.findReplace.label': 'Bul ve değiştir…',
  'home.tool.findReplace': 'Bir metni belgenin her yerinde değiştirin.',
  'op.progress.findReplace.read': 'Sayfalar okunuyor',
  'op.note.findReplace.replaced': '{count} eşleşme değiştirildi (sayfa {pages}).',
  'op.note.findReplace.shrunk':
    '{count} yeni metin yerine sığması için çevresindeki metinden biraz küçük yazıldı.',
  'op.note.findReplace.ownFont': 'Yeni metin belgenin kendi yazı tipiyle yazıldı ({font}).',
  'op.note.findReplace.moved':
    '{count} satırda yeni metin yerine sığmadı; satırın devamı aynı yazı tipiyle kaydırıldı.',
  'op.note.findReplace.reflowed': '{count} paragraf, yeni metin satırına sığmadığı için yeniden dizildi.',
  'op.note.findReplace.overflow':
    '{count} paragraf eski alanına sığmadı ve aşağı taştı; bu paragrafları kontrol edin.',
  'op.note.findReplace.noRoom':
    '{count} eşleşme tablo hücresine en küçük boyutta bile sığmadı ve değiştirilmedi.',
  'op.note.findReplace.skipped':
    '{count} eşleşme düzenlenemeyen metinde (taranmış, döndürülmüş ya da Type3) ve değiştirilmedi (sayfa {pages}).',
  'op.note.findReplace.standardFace':
    'Yeni metin gömülmeyen standart yazı tipiyle yazıldı ({font}); okuyucu bu yazı tipini kendisi sağlar.',
} as const;
