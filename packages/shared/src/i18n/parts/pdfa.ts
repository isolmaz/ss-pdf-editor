/**
 * PDF/A: the conversion dialog and its report notes (`pdf-core/ops/pdfa.ts`), the checker's
 * per-rule sentences and the panel's copy (`pdf-core/ops/pdfa-check.ts`,
 * `pdf-ui/panels/PdfAPanel.tsx`).
 *
 * Every rule has two sentences: `pdfa.rule.<id>` says what the standard asks for (shown when
 * the rule passes) and `pdfa.violation.<id>` says what is wrong (shown with the count when it
 * fails). The identifiers printed beside a violation (a font name, a namespace, a PDF key) are
 * technical details and are not translated.
 */

export const pdfaPart = {
  'pdfa.title': 'PDF/A olarak kaydet',
  'pdfa.intro':
    'Belgeyi uzun süreli arşivleme standardı PDF/A’ya dönüştürür: tüm yazı tipleri gömülür, renkler sRGB’ye çevrilir ve üst veri standart biçimde yazılır. Her şey bu tarayıcıda yapılır; dönüştürme motoru yalnızca bu araç kullanılınca yüklenir. Çıktı, dönüştürmeden hemen sonra kendi denetleyicimizle kontrol edilir; kuralı ihlal eden bir dosya sunulmaz. Bu kontrol veraPDF’in tam doğrulaması değildir.',
  'pdfa.level': 'Düzey',
  'pdfa.level.2b': 'PDF/A-2b (önerilen)',
  'pdfa.level.2bHint': 'PDF 1.7 tabanlı. Saydamlık serbesttir, bu yüzden sayfalar görünüş olarak değişmez.',
  'pdfa.level.1b': 'PDF/A-1b',
  'pdfa.level.1bHint':
    'En eski ve en kısıtlı düzey. Saydamlık kullanan sayfalar görüntüye dönüştürülür: metinleri seçilemez, bağlantıları kaybolur ve dosya çok büyüyebilir.',
  'pdfa.level.3b': 'PDF/A-3b',
  'pdfa.level.3bHint': 'PDF/A-2b gibi, ayrıca gömülü dosyaları (ekleri) korur.',
  'pdfa.done': 'PDF/A dosyası hazır: {name}',
  'pdfa.doneAlready': 'Dosya zaten {level} olarak işaretli ve denetimden geçti; olduğu gibi bırakıldı.',
  'tools.pdfa': 'PDF/A Olarak Kaydet',
  'tools.pdfaDesc': 'Belgeyi PDF/A arşiv biçimine çevirin ve denetleyin',
  'home.tool.pdfa': 'Belgeyi PDF/A-1b, 2b veya 3b arşiv biçimine çevirin; çıktı kurallara karşı denetlenir.',
  'pdfa.command.check': 'PDF/A denetimi',

  'op.progress.pdfa.prepare': 'Belge PDF/A için hazırlanıyor',
  'op.progress.pdfa.convert': 'PDF/A’ya dönüştürülüyor',
  'op.progress.pdfa.verify': 'Çıktı PDF/A kurallarına karşı denetleniyor',

  'op.note.pdfa.converted': 'Belge {level} biçimine dönüştürüldü (Ghostscript).',
  'op.note.pdfa.colour':
    'Renkler sRGB’ye çevrildi ve sRGB çıktı niyeti (OutputIntent) eklendi; tüm yazı tipleri gömüldü.',
  'op.note.pdfa.fontsSubstituted':
    '{count} yazı tipi dosyada gömülü değildi; Ghostscript bunların yerine benzer yazı tipleri gömdü, harf biçimleri özgün yazı tipinden farklı olabilir.',
  'op.note.pdfa.transparencyFlattened':
    'PDF/A-1 saydamlığa izin vermez: saydamlık kullanan sayfalar düzleştirildi; bu sayfalardaki metin ve bağlantılar görüntüye dönüşmüş olabilir.',
  'op.note.pdfa.formsFlattened': '{count} form alanı sayfaya işlendi; artık doldurulabilir değiller.',
  'op.note.pdfa.widgetsRemoved': '{count} form düğmesi ya da imza alanı kaldırıldı.',
  'op.note.pdfa.signatures':
    '{count} dijital imza geçersiz oldu: dosya yeniden yazıldığı için imzalar korunamaz.',
  'op.note.pdfa.actionsRemoved':
    '{count} betik ya da eylem (JavaScript, Launch…) kaldırıldı; PDF/A bunlara izin vermez.',
  'op.note.pdfa.attachmentsRemoved':
    '{count} gömülü dosya kaldırıldı ({names}); {level} ek dosyalara izin vermez. Ekleri korumak için PDF/A-3b seçin.',
  'op.note.pdfa.attachmentsKept': '{count} gömülü dosya korundu.',
  'op.note.pdfa.annotationsRemoved':
    '{count} ek açıklama kaldırıldı ({types}): düzeyin izin vermediği türler ya da çizilemeyen görünümler.',
  'op.note.pdfa.annotationsDropped':
    '{count} ek açıklama çıktıda yok ({types}): Ghostscript gizli ya da görüntülenmeyen ek açıklamaları taşımaz.',
  'op.note.pdfa.printFlagged': '{count} ek açıklamaya PDF/A’nın istediği Print bayrağı eklendi.',
  'op.note.pdfa.appearancesDrawn': '{count} ek açıklama için eksik görünüm akışı çizildi.',
  'op.note.pdfa.encryptionRemoved': 'Şifreleme kaldırıldı; PDF/A şifrelenmiş dosyaya izin vermez.',
  'op.note.pdfa.lost.tags':
    'Etiket yapısı (erişilebilirlik ağacı) korunmadı: çıktı etiketsizdir. PDF/A-1b, 2b ve 3b zaten etiket istemez.',
  'op.note.pdfa.lost.outlines': 'Yer imleri çıktıda yok.',
  'op.note.pdfa.lost.labels': 'Sayfa etiketleri (numaralandırma) çıktıda yok.',
  'op.note.pdfa.lost.layers': 'Katmanlar (isteğe bağlı içerik) çıktıda yok.',
  'op.note.pdfa.producer':
    'Üretici (Producer) alanı artık “{producer}”: Ghostscript bu alanı kendisi yazar, değiştirilemez.',
  'op.note.pdfa.textKept':
    'Örneklenen {pages} sayfada, özgün metnin {percent} kadarı çıktıda aynen çıkarılabiliyor.',
  'op.note.pdfa.textLoss':
    'Metin bazı sayfalarda aynı çıkarılamıyor (özgün sözcüklerin {percent} kadarı bulundu; sayfalar: {pages}). Arama ve kopyalama bu sayfalarda eksik ya da farklı olabilir.',
  'op.note.pdfa.pictureKept':
    'Örneklenen {pages} sayfa önce ve sonra gri tonlamada çizilip karşılaştırıldı; en büyük ortalama fark {difference}.',
  'op.note.pdfa.pictureDiffers':
    'Şu sayfaların görüntüsü özgününden fark ediyor: {pages}. Çıktıyı kaydetmeden önce bu sayfalara bakın.',
  'op.note.pdfa.verified': 'Çıktı {level} için {rules} kurala karşı denetlendi ve hiçbiri ihlal edilmedi.',
  'op.note.pdfa.alreadyCompliant':
    'Dosya zaten {level} olduğunu belirtiyor ve denetlenen kuralların hiçbirini ihlal etmiyor; yeniden yazılmadı.',
  'op.note.pdfa.limits':
    'Bu denetim veraPDF’in tam doğrulaması değildir: yalnızca nesne yapısından ve içerik akışlarından karar verilebilen kurallar bakılır (PDF/A panelinde “bakılmayanlar” listesine bakın).',

  'panel.pdfa': 'PDF/A',
  'pdfa.panel.check': 'Denetle',
  'pdfa.panel.convert': 'PDF/A olarak kaydet…',
  'pdfa.panel.target': 'Denetlenecek düzey',
  'pdfa.panel.target.auto': 'Dosyanın kendi beyanı (yoksa PDF/A-2b)',
  'pdfa.panel.empty':
    'Bu denetim, dosyanın PDF/A olduğunu belirtip belirtmediğine ve denetlenebilen kuralları karşılayıp karşılamadığına bakar. Başlamak için “Denetle”ye basın.',
  'pdfa.panel.summary': '{pages} sayfa · {checked} kural denetlendi · {violations} ihlal',
  'pdfa.panel.page': '{page}. sayfa',
  'pdfa.panel.clause': 'ISO 19005-{part}, madde {clause}',
  'pdfa.panel.more': 've {count} tane daha',
  'pdfa.panel.notChecked': 'Bu denetimin bakmadıkları',
  'pdfa.panel.disclaimer':
    'Bu, veraPDF’in tam doğrulaması değildir. veraPDF’in yüzlerce kuralından yalnızca nesne yapısından ve içerik akışlarından karar verilebilenler denetlenir; temiz bir sonuç sertifika yerine geçmez.',
  'pdfa.group.fail': 'İhlal edilen kurallar',
  'pdfa.group.unchecked': 'Denetlenemeyen kurallar',
  'pdfa.group.pass': 'Geçen kurallar',
  'pdfa.group.na': 'Bu düzeyde geçerli olmayan kurallar',
  'pdfa.verdict.no-claim': 'Dosya PDF/A olduğunu belirtmiyor (XMP’de pdfaid yok).',
  'pdfa.verdict.no-claim.checked': 'Yine de {level} kurallarına göre denetlendi: {count} ihlal bulundu.',
  'pdfa.verdict.claims-and-meets':
    'Dosya {level} olduğunu belirtiyor ve denetlenen kuralların hiçbirini ihlal etmiyor.',
  'pdfa.verdict.claims-with-violations': 'Dosya {level} olduğunu belirtiyor ama {count} kural ihlali var.',
  'pdfa.verdict.unreadable': 'Dosya okunamadı (parola gerekiyor olabilir); denetlenemedi.',

  'pdfa.rule.header': 'Dosya başlığı geçerli (%PDF-1.x satırı ve ikili açıklama satırı)',
  'pdfa.violation.header': 'Dosya başlığı PDF/A’ya uymuyor: PDF sürümü ya da ikili açıklama satırı hatalı',
  'pdfa.rule.trailer': 'Dosya sonu ve /ID geçerli (%%EOF, ardından veri yok, trailer’da /ID)',
  'pdfa.violation.trailer': 'Dosya sonu ya da trailer hatalı: %%EOF eksik, ardından veri var ya da /ID yok',
  'pdfa.rule.encryption': 'Şifreleme yok',
  'pdfa.violation.encryption': 'Dosya şifreli (/Encrypt); PDF/A şifrelemeye izin vermez',
  'pdfa.rule.structure': 'Dosya yapısı sağlam (onarım gerekmedi; parça 1’de nesne ve xref akışı yok)',
  'pdfa.violation.structure':
    'Dosya yapısı uygun değil: çapraz başvuru tablosu onarılmış ya da parça 1’de yasak nesne/xref akışı var',
  'pdfa.rule.streams': 'Akışlarda LZW, harici dosya ve Crypt süzgeci yok',
  'pdfa.violation.streams': 'Yasak akış var: LZW sıkıştırması, harici dosya başvurusu ya da Crypt süzgeci',
  'pdfa.rule.xmp': 'XMP üst veri akışı var ve geçerli',
  'pdfa.violation.xmp': 'XMP üst veri akışı eksik ya da geçersiz',
  'pdfa.rule.xmp-claim': 'XMP’deki PDF/A kimliği (pdfaid:part, pdfaid:conformance) doğru',
  'pdfa.violation.xmp-claim': 'PDF/A kimliği (pdfaid) eksik ya da denetlenen düzeyle çelişiyor',
  'pdfa.rule.xmp-schemas': 'XMP’deki tüm özellikler tanımlı şemalardan geliyor',
  'pdfa.violation.xmp-schemas': 'XMP’de PDF/A uzantı şemasıyla tanımlanmamış ad alanları var',
  'pdfa.rule.xmp-info': 'Info sözlüğü XMP ile uyumlu (yalnızca parça 1)',
  'pdfa.violation.xmp-info': 'Info sözlüğündeki değerler XMP’de yok ya da XMP’dekilerden farklı',
  'pdfa.rule.output-intent': 'Çıktı niyeti (OutputIntent) geçerli bir ICC profili taşıyor',
  'pdfa.violation.output-intent': 'Çıktı niyeti eksik ya da ICC profili geçersiz',
  'pdfa.rule.device-colour':
    'Aygıta bağlı renkler (DeviceRGB, DeviceCMYK, DeviceGray) yalnızca uygun çıktı niyetiyle kullanılıyor',
  'pdfa.violation.device-colour':
    'Aygıta bağlı renk, eşleşen bir çıktı niyeti ya da varsayılan renk uzayı olmadan kullanılıyor',
  'pdfa.rule.transparency': 'Saydamlık kurala uygun',
  'pdfa.violation.transparency':
    'Saydamlık kurala uymuyor: parça 1’de yasak (alfa, karışım kipi, yumuşak maske, grup); parça 2 ve 3’te çıktı niyeti yoksa grubun /CS’si gerekir',
  'pdfa.rule.fonts': 'Görünür metni çizen tüm yazı tipleri dosyaya gömülü',
  'pdfa.violation.fonts': 'Gömülü olmayan ya da eksik tanımlı yazı tipleri var',
  'pdfa.rule.images': 'Görsellerde yasak anahtar yok (/Alternates, /OPI, /Interpolate true)',
  'pdfa.violation.images': 'Görsellerde yasak anahtarlar var',
  'pdfa.rule.graphics-state': 'Grafik durumunda yasak anahtar yok (/TR, /HTP, yarım ton, PostScript)',
  'pdfa.violation.graphics-state': 'Grafik durumunda ya da XObject’lerde yasak anahtarlar var',
  'pdfa.rule.actions': 'Yasak eylem yok (JavaScript, Launch, Sound, Movie, ResetForm…)',
  'pdfa.violation.actions': 'Yasak eylemler ya da betikler var',
  'pdfa.rule.annotations': 'Ek açıklamalar uygun (yasak tür yok, Print bayrağı ve görünüm akışı var)',
  'pdfa.violation.annotations':
    'Ek açıklamalar uygun değil: yasak tür, eksik Print bayrağı ya da eksik görünüm akışı',
  'pdfa.rule.forms': 'Form alanları uygun (NeedAppearances, XFA ve alan eylemi yok)',
  'pdfa.violation.forms': 'Form kuralı ihlali: NeedAppearances true, XFA verisi ya da alan eylemi',
  'pdfa.rule.layers': 'Katmanlar uygun (parça 1’de katman yok)',
  'pdfa.violation.layers':
    'Katman kuralı ihlali: parça 1’de katman var ya da bir yapılandırma /Name taşımıyor ya da /AS içeriyor',
  'pdfa.rule.embedded-files': 'Gömülü dosyalar uygun',
  'pdfa.violation.embedded-files':
    'Gömülü dosya kuralı ihlali: parça 1 ek dosyaya izin vermez, parça 2 yalnızca PDF/A dosyalara izin verir, parça 3’te her dosya /AFRelationship ve ortam türü taşımalı',

  'pdfa.notChecked.fontPrograms':
    'Gömülü yazı tipi programlarının içi (eksik glifler, bozuk yazı tipi dosyaları)',
  'pdfa.notChecked.iccBody': 'ICC profilinin etiketleri (yalnızca başlığı okunur)',
  'pdfa.notChecked.syntax':
    'Dosya sözdiziminin ayrıntıları (satır sonları, sayı biçimleri); ayrıştırıcı bozuk yapıyı onarırsa bu da görünmez',
  'pdfa.notChecked.xmpValues':
    'XMP özelliklerinin değer biçimleri ve parça 2 ile 3’te Info sözlüğüyle tam eşleşme',
  'pdfa.notChecked.embeddedPdf': 'Gömülü dosyaların kendilerinin PDF/A olup olmadığı',
  'pdfa.notChecked.accessibility':
    'A düzeyinin (erişilebilirlik) kuralları: etiketler, mantıksal yapı, Unicode eşlemeleri',
  'pdfa.notChecked.limits':
    'Çok büyük dosyalarda içerik akışlarının bir kısmı atlanır; ilgili kurallar “denetlenemeyen” grubunda görünür',
} as const;
