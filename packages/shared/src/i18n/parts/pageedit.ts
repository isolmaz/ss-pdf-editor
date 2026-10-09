/**
 * Page insert / page replace (page management v2) and the
 * print dialog's controls.
 *
 * Two capabilities and one dialog share this part because they are one workflow:
 * the pages an insert or a replace produces are the pages a print sheet carries,
 * and the print dialog's imposition controls (`print.perSheet`, `print.booklet`,
 * `print.duplex`) are the same words the page order is explained with. The notes
 * below are *measurements* the operations report: what the
 * engine carried, what it dropped, and which flip axis the printer has to be set
 * to — a produced duplex file that a user prints single-sided is the failure
 * this part exists to prevent.
 *
 * Framework vocabulary (`op.scope`, `op.apply`, `op.result.*`, `unit.mm`) stays
 * in `parts/common.ts` and `parts/dialogs.ts`; only the words these capabilities
 * alone say live here.
 *
 * Wired into `tr.ts` by the integration owner (the keys arrive with the ops).
 */

export const pageeditPart = {
  /* ----- insert pages (ops/page-insert.ts, ops/pageedit.ts) ----- */

  'insert.title': 'Sayfa ekle',
  'insert.intro':
    'Seçilen kaynaktan sayfalar geçerli belgeye eklenir. Bileşim belgenin kendi motor belgesi üzerinden yazılır: açıklamalar ve form değerleri korunur. Katalog yeniden yazılır — görünüm tercihleri, dil, çıktı amaçları ve katman yapılandırması yeni dosyaya taşınmaz.',
  'insert.source': 'Kaynak',
  'insert.source.blank': 'Boş sayfa',
  'insert.source.image': 'Görsellerden',
  'insert.source.document': 'Başka bir PDF’ten',
  'insert.position': 'Konum (N. sayfanın ardına)',
  'insert.positionHint':
    'N, 1 tabanlı sayfa numarasıdır: 1 ilk sayfanın ardına ekler. Belgenin başına eklemek için 0, sonuna eklemek için sayfa sayısını yazın.',
  'insert.count': 'Eklenecek sayfa sayısı',
  'insert.countHint': 'Sayfalar seçilen boyutta, içeriksiz olarak oluşturulur.',
  'insert.size': 'Sayfa boyutu',
  'insert.size.a4': 'A4',
  'insert.size.letter': 'Letter',
  'insert.size.match': 'Geçerli sayfayla aynı',
  'insert.sizeMatchHint':
    'Boyut, ekleme anında görüntülenen sayfadan alınır; döndürülmüş sayfalar okunduğu gibi eşleşir.',
  'insert.fit': 'Görsel yerleşimi',
  'insert.fit.fit': 'Sığdır',
  'insert.fit.fill': 'Doldur (taşanı kırp)',
  'insert.fit.stretch': 'Uzat (oranı koruma)',
  'insert.margin': 'Kenar boşluğu (mm)',
  'insert.marginHint': 'Görselin sayfa kenarına bıraktığı boşluk.',
  'insert.images': 'Görseller',
  'insert.imagesHint': 'Her görsel bir sayfa olur; PNG ve JPEG desteklenir, okunamayan dosyalar atlanır.',
  'insert.document': 'Kaynak PDF',
  'insert.documentHint': 'Seçilen sayfalar kaynak belgeden olduğu gibi kopyalanır.',
  'insert.range': 'Kaynak sayfa aralığı',
  'insert.rangeHint': 'Boş bırakılırsa kaynak belgenin tüm sayfaları eklenir.',
  'insert.progress.prepare': 'Eklenecek sayfalar hazırlanıyor',
  'insert.progress.place': 'Sayfalar yerleştiriliyor',
  'insert.note.storage': 'Açıklamalar ve form değerleri belgenin kendi deposundan taşındı.',
  'insert.note.catalog':
    'Bileşim yeni bir katalog yazar: görünüm tercihleri, dil, çıktı amaçları, katman (OCG) yapılandırması ve açılış eylemi taşınmaz.',
  'insert.note.info': 'Belge bilgisi (başlık, yazar, tarihler) taban belgeden kopyalandı.',
  'insert.note.labels':
    'Sayfa etiketleri: her sayfa kendi belgesinin verdiği etiketi korudu; sayfa etiketi olmayan bir belgeden gelen sayfa, o belgedeki sayfa numarasıyla etiketlendi (yeni boş sayfa 1 olur).',
  'insert.note.inserted': '{count} sayfa eklendi; ilk sayfa {position}. sırada.',
  'insert.note.skipped': '{count} görsel eklenemedi ve atlandı.',

  /* ----- replace pages (ops/page-insert.ts, ops/pageedit.ts) ----- */

  'replace.title': 'Sayfaları değiştir',
  'replace.intro':
    'Seçilen sayfalar, kaynaktan üretilen sayfalarla yerinde değiştirilir; sayfa sayısı değişmez. Bileşim yeni bir katalog yazar: görünüm tercihleri, dil ve katman yapılandırması yeni dosyaya taşınmaz.',
  'replace.source': 'Yeni sayfaların kaynağı',
  'replace.source.blank': 'Boş sayfa',
  'replace.source.image': 'Görsel',
  'replace.source.document': 'Başka bir PDF',
  'replace.countHint': 'Değiştirilecek sayfa sayısı kadar yedek sayfa üretilmelidir.',
  'replace.sizeHint':
    '“Geçerli sayfayla aynı” seçeneği her yedek sayfayı, yerine geçtiği sayfanın boyutunda üretir.',
  'replace.progress.prepare': 'Yedek sayfalar hazırlanıyor',
  'replace.progress.replace': 'Sayfalar değiştiriliyor',
  'replace.note.replaced': '{count} sayfa değiştirildi.',

  /* ----- print (printing/PrintDialog.tsx, printing/usePrinting.ts, ops/impose.ts) ----- */

  'print.scaleShrink': 'Küçült (büyütme)',
  'print.perSheet': 'Sayfa başına',
  'print.booklet': 'Kitapçık (forma)',
  'print.bookletHint':
    'Sayfalar forma sırasına dizilir ve yaprağın iki yüzü de yazılır; yaprak başına dört sayfa gerekir.',
  'print.duplex': 'Çift yönlü',
  'print.duplex.simplex': 'Tek yüz',
  'print.duplex.longEdge': 'Uzun kenardan çevir',
  'print.duplex.shortEdge': 'Kısa kenardan çevir',
  'print.duplexHint':
    'Arka yüzler üretilen dosyada yaprağa yerleştirilir; yazıcıda aynı çevirme eksenini seçin.',
  'print.margin': 'Kenar boşlukları (mm)',
  'print.marginHint': 'Yaprak kenarında bırakılan boşluk; hücreler bu boşluğun içine yerleşir.',
  'print.produce': 'Yazdırılacak PDF’i üret',
  'print.fileName': 'yazdirma.pdf',
  'print.imposeHint':
    'Sayfa başına, kitapçık, çift yönlü ve kenar boşluğu ayarları üretilen PDF’e uygulanır; “Yazdır” sayfaları olduğu gibi tarar.',
  'print.producing': 'Yapraklar hazırlanıyor: {done}/{total}',
  'print.produced': 'Yazdırma dosyası hazır: {name}',
  'print.progress.sheets': 'Yapraklar oluşturuluyor',
  'print.note.sheets': '{sheets} yaprak, {sides} yüz üretildi.',
  'print.note.simplex': 'Tek yüz: arka yüzler üretilmedi, yazıcıda çift yönlü baskı gerekmez.',
  'print.note.duplexLong':
    'Her yaprağın arka yüzü uzun kenara göre yerleştirildi; yazıcıda çift yönlü baskıyı ve uzun kenardan çevirmeyi seçin.',
  'print.note.duplexShort':
    'Her yaprağın arka yüzü kısa kenara göre yerleştirildi; yazıcıda çift yönlü baskıyı ve kısa kenardan çevirmeyi seçin.',
  'print.note.booklet':
    'Forma iki yüzüyle yazıldı; katlanma çizgisi yaprağın kısa kenarına paraleldir, yazıcıda kısa kenardan çevirmeyi seçin.',
  'print.note.padded': 'Formayı tamamlamak için {count} boş sayfa eklendi.',
  'print.note.actual':
    'Gerçek boyut: hücresinden büyük {count} sayfa, komşu hücreye taşmaması için hücre sınırında kırpıldı.',
  'print.note.cropMarks': 'Her hücrenin kesim köşelerine kesim işaretleri eklendi.',
  'print.note.vector': 'Sayfa içeriği vektör kaldı: metin seçilebilir ve aranabilir.',
  'print.note.lost': 'Yerleştirme bağlantıları, açıklamaları, form alanlarını ve içindekileri taşımaz.',
  'print.note.info': 'Belge bilgisi (başlık, yazar) kaynak belgeden kopyalandı.',
} as const;
