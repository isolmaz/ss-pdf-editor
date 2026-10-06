/** XFA forms (`pdf-core/ops/xfa-form.ts`, `xfa-flatten.ts`, `pdf-ui/dialogs/XfaFormDialog.tsx`). */

export const xfaPart = {
  // the notice under the tool strip
  'xfa.banner.static':
    'Statik XFA formu. Alanlar normal form olarak doldurulur; her yazımda XFA verisi de güncellenir.',
  'xfa.banner.dynamic':
    'Dinamik XFA formu. Görünen sayfa yalnızca “Lütfen bekleyin…” yer tutucusudur; formu “XFA formunu doldur” ile açın.',
  'xfa.banner.more': 'Neler destekleniyor?',
  'xfa.banner.supported':
    'Desteklenen: statik formu doldurma ve XFA verisini eşitleme, dinamik formu görüntüleme–doldurma–kaydetme, XFA verisini dışa/içe aktarma, düzleştirme. Desteklenmeyen: XFA betikleri (FormCalc, JavaScript), doğrulama, hesaplama, dinamik göster/gizle.',
  'xfa.banner.fill': 'XFA formunu doldur',
  'xfa.banner.remove': 'XFA’yı kaldır',
  'xfa.banner.flatten': 'Normal PDF’ye dönüştür',
  'xfa.banner.data': 'XFA verisi…',

  // commands
  'xfa.cmd.fill': 'XFA formunu doldur…',
  'xfa.cmd.remove': 'XFA’yı kaldır (AcroForm kalsın)…',
  'xfa.cmd.flatten': 'XFA formunu normal PDF’ye dönüştür…',
  'xfa.cmd.data': 'XFA verisini dışa/içe aktar…',
  'home.tool.xfa': 'XFA formunu doldurun, normal PDF’ye dönüştürün ya da XFA’yı kaldırın.',

  // fill dialog
  'xfa.fill.title': 'XFA formunu doldur',
  'xfa.fill.intro':
    'Form, pdf.js’in XFA işleyicisiyle çizilir. Yazdıklarınız belgenin XFA verisine kaydedilir; belgedeki sayfa yine yer tutucu olarak kalır.',
  'xfa.fill.loading': 'Form hazırlanıyor…',
  'xfa.fill.limits':
    'XFA betikleri (FormCalc, JavaScript), doğrulamalar, hesaplamalar ve dinamik göster/gizle çalışmaz; böyle bir alan yalnızca saklı değerini gösterir.',
  'xfa.fill.save': 'Belgeye kaydet',
  'xfa.fill.export': 'Veriyi dışa aktar (XML)',
  'xfa.fill.close': 'Kapat',
  'xfa.fill.discard': 'Kaydetmeden kapat',
  'xfa.fill.unsaved':
    'Yazdıklarınız henüz belgeye kaydedilmedi. “Belgeye kaydet”i kullanın ya da kaydetmeden kapatın.',
  'xfa.fill.nothing': 'Formda kaydedilecek bir değişiklik yok.',
  'xfa.fill.saved': '{count} değer belgenin XFA verisine kaydedildi.',

  // remove
  'xfa.remove.title': 'XFA’yı kaldır',
  'xfa.remove.intro':
    'Statik bir formda XFA’yı kaldırır; alanlar ve değerleri (AcroForm) olduğu gibi kalır ve okuyucular yalnızca onları kullanır. XFA betikleri, hesaplamalar ve doğrulamalar kaybolur.',
  'xfa.remove.confirm': 'XFA’yı kaldır',
  'xfa.remove.done': 'XFA kaldırıldı; form alanları korundu.',

  // data
  'xfa.data.title': 'XFA verisi',
  'xfa.data.intro':
    'Formun XFA verisini XML olarak dışa aktarın ya da bir XML dosyasındaki veriyi forma aktarın. Statik formda alanlar da bu veriyle doldurulur.',
  'xfa.data.fileHint': 'Acrobat’ın “Veriyi dışa aktar” dosyası (XML ya da XDP).',

  // flatten
  'xfa.flatten.title': 'XFA formunu normal PDF’ye dönüştür',
  'xfa.flatten.intro':
    'Dinamik formun sayfaları tarayıcıda çizilir ve yeni bir PDF’ye resim olarak yazılır; üzerine arama ve kopyalama için görünmez bir metin katmanı eklenir. Önce formu doldurup belgeye kaydedin: yazdıklarınız da dönüşür. Sonuç yeni sekmede açılır.',
  'xfa.flatten.resolution': 'Çözünürlük',
  'xfa.flatten.resolution.1.5': '108 dpi (küçük dosya)',
  'xfa.flatten.resolution.2': '144 dpi (önerilen)',
  'xfa.flatten.resolution.3': '216 dpi (keskin, büyük dosya)',
  'xfa.flatten.done': '{count} sayfa normal PDF’ye dönüştürüldü.',
  'op.progress.xfa.flatten': 'Form sayfaları çiziliyor',

  // report notes
  'xfa.note.synced': '{count} alanın değeri XFA verisine de yazıldı.',
  'xfa.note.notSynced':
    '{count} alan XFA verisine yazılamadı (biçim kalıbı olan tarih/sayı alanı ya da bağlanamayan alan); bunlar XFA’da eski değerini korur.',
  'xfa.note.removed': 'XFA kaldırıldı; belgede yalnızca AcroForm kaldı.',
  'xfa.note.fieldsKept': '{count} form alanı ve değerleri olduğu gibi korundu.',
  'xfa.note.scriptsLost': 'XFA betikleri, hesaplamalar, doğrulamalar ve (varsa) kullanım hakları artık yok.',
  'xfa.note.imported': '{count} veri değeri formun XFA verisine aktarıldı.',
  'xfa.note.widgetsFilled': '{count} form alanı bu veriyle dolduruldu.',
  'xfa.note.exported': '{count} veri değeri dışa aktarıldı.',
  'xfa.note.dataSaved': '{count} değer belgenin XFA verisine kaydedildi.',
  'xfa.note.templateKept': 'XFA şablonu ve diğer paketler değişmedi.',
  'xfa.note.nothingChanged': 'Veri öncekiyle aynı: forma yazılan bir değişiklik yok.',
  'xfa.note.flattened': '{count} XFA sayfası normal PDF sayfasına dönüştürüldü.',
  'xfa.note.flattenPictures':
    'Sayfalar resimdir: çözünürlük çizim anında belirlendi; metin yalnızca görünmez bir katman olarak aranabilir ve kopyalanabilir.',
  'xfa.note.fieldsGone': 'Alanlar artık doldurulamaz; XFA şablonu, verisi ve betikleri belgede yok.',
  'xfa.note.fonts':
    'Metin, formun yazı tipleriyle değil tarayıcının yazı tipleriyle çizildi; satır sonları küçük farklar gösterebilir.',
} as const;
