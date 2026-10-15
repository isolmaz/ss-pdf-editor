/** Repair a damaged PDF (`pdf-core/ops/repair.ts`). */

export const repairPart = {
  'repair.title': 'PDF’yi onar',
  'repair.intro':
    'Bozuk bir PDF seçin. Yapısı okunabilen içerikten yeniden kurulur ve sonuç yeni sekmede açılır; özgün dosya değişmez.',
  'repair.file': 'PDF dosyası',
  'repair.hint': 'Açılmayan ya da sayfaları eksik açılan bir dosya için deneyin.',
  'repair.suffix': 'onarıldı',
  'repair.done': 'Dosya onarıldı: {name}.',
  'repair.doneClean': 'Dosyanın onarıma ihtiyacı yoktu; {name} olarak yeniden yazıldı.',
  'home.tool.repair':
    'Açılmayan ya da sayfaları eksik görünen bozuk bir PDF’yi yeniden kurup temiz bir kopya kaydedin.',
  'open.repairHint': 'Dosya menüsündeki “PDF’yi onar” komutunu deneyin.',
  'op.note.repair.rebuilt': 'Dosya bozuktu; yapısı içinde bulunan nesnelerden yeniden kuruldu.',
  'op.note.repair.check': 'Sayfaları kontrol edin: bozuk dosyadan okunamayan içerik geri getirilemez.',
  'op.note.repair.rewritten':
    'Dosyanın onarıma ihtiyacı yoktu; kullanılmayan nesneler atılarak temiz bir dosya olarak yeniden yazıldı.',
  'op.note.repair.signatureBroken':
    'Belgede dijital imza var. Onarım dosyayı yeniden yazdığı için imza artık geçerli değil.',
  'op.note.repair.verified': 'Onarım doğrulandı: yeni dosya olduğu gibi açılıyor ve {pages} sayfası var.',
} as const;
