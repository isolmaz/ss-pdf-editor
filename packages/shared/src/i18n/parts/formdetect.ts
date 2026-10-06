/** Prepare form: find the fields of a flat PDF and create them (`pdf-core/ops/form-detect.ts`). */

export const formDetectPart = {
  'formDetect.title': 'Form alanlarını algıla',
  'cmd.formDetect.label': 'Form alanlarını algıla…',
  'home.tool.formDetect':
    'Düz bir formdaki çizgileri, kutuları ve onay karelerini bulup gerçek form alanına çevirin.',
  'op.progress.formDetect': 'Sayfalar form alanları için taranıyor',

  'formDetect.panel.intro':
    'Alanı olmayan bir formun doldurulacak yerlerini sayfadan tahmin edin, gözden geçirin ve gerçek form alanı olarak ekleyin.',
  'formDetect.panel.start': 'Alanları algıla',
  'formDetect.panel.scanning': 'Sayfalar taranıyor…',
  'formDetect.panel.found': '{count} alan bulundu: {high} etiketli, {medium} tahmini.',
  'formDetect.panel.none': 'Bu belgede doldurulacak bir yer bulunamadı.',
  'formDetect.panel.hint':
    'Sayfadaki çerçeveleri inceleyin. İstemediğiniz alanı ✕ ile kaldırın; kalanlar eklenir.',
  'formDetect.panel.create': '{count} alanı ekle',
  'formDetect.panel.cancel': 'Vazgeç',
  'formDetect.panel.again': 'Yeniden algıla',
  'formDetect.panel.list': 'Bulunan alanlar',
  'formDetect.panel.removedCount': '{count} alan kaldırıldı.',
  'formDetect.panel.restore': 'Kaldırılanları geri getir',
  'formDetect.panel.nothingLeft': 'Eklenecek alan kalmadı.',
  'formDetect.remove': '{name} alanını kaldır',
  'formDetect.candidate': '{name} — {kind}, sayfa {page}',
  'formDetect.confidence.high': 'Etiketli',
  'formDetect.confidence.medium': 'Tahmini',
  'formDetect.confidence.high.hint': 'Yanında bir etiket ve çizili bir yer var.',
  'formDetect.confidence.medium.hint':
    'Etiket ya da yer tahmin edildi (altında yazan açıklama, iki noktayla biten bir etiket, tablo başlığı…).',
  'formDetect.needsOcr':
    '{pages} sayfa yalnızca resim ve metni yok; alanlara ad verecek etiket olmadığı için bu sayfalar atlandı. Önce OCR çalıştırın.',
  'formDetect.raster':
    '{pages} sayfa taranmış görüntü: yalnızca yatay çizgiler piksellerden okundu; kutular ve daireler bulunamaz, alanlar tahminidir.',
  'formDetect.already': '{count} yer zaten form alanı olduğu için atlandı.',
  'formDetect.truncated': 'Çok fazla aday var; ilk {count} tanesi listelendi.',
  'formDetect.done': '{count} form alanı eklendi.',
  'formDetect.stale': 'Belge değişti; alanları yeniden algılayın.',
  'formDetect.source.line': 'çizgi',
  'formDetect.source.blank': 'noktalı/alt çizgili boşluk',
  'formDetect.source.box': 'kutu',
  'formDetect.source.comb': 'hücreli kutu',
  'formDetect.source.cell': 'tablo hücresi',
  'formDetect.source.glyph': 'işaret karakteri',
  'formDetect.source.square': 'kare',
  'formDetect.source.circle': 'daire',
  'formDetect.source.colon': 'iki noktalı etiket',

  'formDetect.note.created': '{count} form alanı bulunan yerlerde oluşturuldu.',
  'formDetect.note.pageUnchanged':
    'Sayfanın görünümü değişmedi: alanlar çizgilerin, kutuların ve karelerin üstüne şeffaf yerleştirildi.',
  'formDetect.note.verified':
    'Her alan, dosya yeniden okunarak doğrulandı: ad, tür, sayfa ve konum istenenle aynı.',
  'formDetect.note.review':
    'Alanlar sayfanın çizimine bakılarak tahmin edilir; ad ve konumları kontrol edin, gerekirse Form alanları listesinden düzeltin.',
} as const;
