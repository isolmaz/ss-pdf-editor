/**
 * PDF/UA denetimi ve etiket düzenleyicisi (`ops/pdfua.ts`, `ops/structure.ts`,
 * `panels/PdfUaView.tsx`, `panels/TagsView.tsx`, `panels/ReadingOrderLayer.tsx`).
 *
 * Anahtar aileleri:
 *   - `ua.rule.<id>.name | why | fix` — kuralın ne denetlediği, neden önemli olduğu, nasıl giderileceği;
 *   - `ua.rule.<id>.detail[.<reason>]` — başarısız tek bir yer için cümle;
 *   - `ua.rule.<id>.ok` — geçen kuralın bulduğunu söyleyen cümle;
 *   - `ua.unchecked.<reason>` — bir kuralın neden denetlenemediği (tüm kurallar için ortak);
 *   - `ua.*` — panelin kendi metinleri ve hızlı düzeltmeler;
 *   - `op.note.ua.*` / `op.note.tags.*` / `op.progress.*` — yazım notları ve ilerleme satırları;
 *   - `tags.*` — etiket görünümü ve hata cümleleri (`tags.err.<StructEditError reason>`).
 *
 * Denetim Matterhorn Protokolü örnek alınarak yapılmıştır ve bunu söyler; hiçbir anahtar
 * uygunluk iddia etmez, renk karşıtlığının ölçülmediği açıkça belirtilir.
 */

export const uatagsPart = {
  'a11y.view.report': 'Rapor',
  'a11y.view.ua': 'PDF/UA',
  'a11y.view.tags': 'Etiketler',

  'op.progress.tags.write': 'Yapı değişiklikleri yazılıyor',
  'op.progress.tags.verify': 'Yapı doğrulanıyor',
  'op.progress.ua.check': 'PDF/UA kuralları denetleniyor',
  'op.progress.ua.fix': 'PDF/UA düzeltmeleri uygulanıyor',

  'op.note.tags.reordered': '{count} öğe taşındı.',
  'op.note.tags.retagged': '{count} öğeye yeni tür verildi.',
  'op.note.tags.altSet': '{count} öğe için alternatif metin yazıldı.',
  'op.note.tags.altCleared': '{count} öğeden alternatif metin kaldırıldı.',
  'op.note.tags.scopeSet': '{count} başlık hücresine kapsam yazıldı.',
  'op.note.tags.grouped': '{count} grup oluşturuldu.',
  'op.note.tags.unwrapped': '{count} sarmalayıcı öğe çözüldü.',
  'op.note.tags.artifact': '{count} öğe artefakt yapıldı ({sequences} içerik dizisi yeniden yazıldı).',
  'op.note.tags.contentRewritten': '{pages} sayfanın içerik akışı yeniden yazıldı.',
  'op.note.tags.parentTreeCleared': 'Üst ağaçtan {count} kayıt kaldırıldı.',
  'op.note.tags.contentPartlyMissing':
    '{count} işaretli içerik dizisi sayfa içeriğinde bulunamadı; öğeler yine de kaldırıldı.',

  'op.note.ua.titleSet': 'Belge başlığı yazıldı: {title}',
  'op.note.ua.xmpCreated': 'Başlığı taşımak için bir XMP paketi oluşturuldu.',
  'op.note.ua.displayTitleSet': 'DisplayDocTitle true olarak ayarlandı.',
  'op.note.ua.langSet': 'Belge dili {lang} olarak ayarlandı.',
  'op.note.ua.tabsSet': '{count} sayfada sekme sırası yapıya göre ayarlandı.',
  'op.note.ua.markedSet': 'Dosya etiketli olarak işaretlendi (/Marked true).',
  'op.note.ua.markedNoTree': 'İşaretlenmedi: işaretin anlatacağı bir yapı ağacı dosyada yok.',
  'op.note.ua.pathsMarked': '{pages} sayfada {count} çizim yolu artefakt olarak işaretlendi.',
  'op.note.ua.pathsNone': 'İşaretsiz çizim yolu bulunamadı.',
  'op.note.ua.contentsSet': 'Bağlantı açıklaması yazıldı: {text}',
  'op.note.ua.tooltipSet': '{name} alanının araç ipucu yazıldı: {tooltip}',
  'op.note.ua.annotsTagged':
    '{count} ek açıklama yapı ağacına alındı (belgenin sonunda Link, Form veya Annot öğeleri olarak).',
  'op.note.ua.annotsNone': 'Etiketsiz ek açıklama bulunamadı.',
  'op.note.ua.annotsNoTree': 'Ek açıklamalar etiketlenmedi: dosyada yapı ağacı yok.',
  'op.note.ua.annotsTreeShape':
    'Ek açıklamalar etiketlenmedi: bu dosyanın üst ağacı, bu düzenleyicinin genişletmediği bir düzende.',
  'op.note.ua.targetMissing': '{count} hedef nesne belgede bulunamadı.',
  'op.note.ua.uaMarked': 'PDF/UA-1 XMP üst verisinde bildirildi.',
  'op.note.ua.uaKept': 'Dosya zaten PDF/UA-{part} bildiriyor; olduğu gibi bırakıldı.',
  'op.note.ua.markRefused': 'PDF/UA bildirilmedi: {count} otomatik kural hâlâ başarısız ya da denetlenemedi.',
  'op.note.ua.manualRemain':
    'Okuma sırası, açıklamaların kalitesi ve dil değişiklikleri hâlâ bir kişinin doğrulamasını bekliyor.',

  /* ---- PDF/UA görünümü ---- */
  'ua.check': 'Yeniden denetle',
  'ua.filter.label': 'Göster',
  'ua.filter.all': 'Tüm kurallar',
  'ua.filter.fail': 'Başarısız ve denetlenemeyen',
  'ua.filter.manual': 'Kişi gerektiren',
  'ua.summary':
    '{pass} geçti, {fail} başarısız, {manual} kişi gerektiriyor, {na} uygulanamaz, {unchecked} denetlenemedi.',
  'ua.declared.yes': 'Dosya PDF/UA-{part} bildiriyor.',
  'ua.declared.no': 'Dosya PDF/UA uygunluğu bildirmiyor.',
  'ua.disclaimer':
    'Matterhorn Protokolü örnek alınarak yapılmış otomatik bir denetimdir. Uygunluğu kanıtlayamaz: okuma sırası, açıklamaların kalitesi ve dil değişiklikleri bir kişinin gözünden geçmelidir; renk karşıtlığı ise hiç ölçülmez.',
  'ua.state.pass': 'Geçti',
  'ua.state.fail': 'Başarısız',
  'ua.state.manual': 'Elle denetle',
  'ua.state.na': 'Uygulanamaz',
  'ua.state.unchecked': 'Denetlenemedi',
  'ua.page': 'Sayfa {page}',
  'ua.openElement': 'Bu öğeyi Etiketler görünümünde aç',
  'ua.instances.more': '… ve {count} tane daha.',
  'ua.fixHow': 'Nasıl düzeltilir:',
  'ua.reference': 'Matterhorn denetim grubu {matterhorn} · ISO 14289-1 madde {iso}',

  'ua.unchecked.untagged': 'Denetlenemedi: dosyada yapı ağacı yok.',
  'ua.unchecked.truncated': 'Denetlenemedi: belge, bu denetimin dolaşabileceğinden büyük.',
  'ua.unchecked.unreadable': 'Denetlenemedi: dosyanın bu bölümü okunamadı.',

  'ua.fix.save': 'Kaydet',
  'ua.fix.contents.label': 'Bu bağlantının açıklaması',
  'ua.fix.tooltip.label': '{name} için araç ipucu',
  'ua.fix.title.label': 'Belge başlığı',
  'ua.fix.title.save': 'Başlığı yaz',
  'ua.fix.lang.label': 'Dil etiketi',
  'ua.fix.lang.save': 'Dili yaz',
  'ua.fix.lang.hint': 'Örneğin tr-TR, en-US veya de-DE.',
  'ua.fix.display-title': 'Başlığı pencere çubuğunda göster',
  'ua.fix.tabs': 'Sekme sırasını yapıya göre ayarla',
  'ua.fix.marked': 'Dosyayı etiketli olarak işaretle',
  'ua.fix.artifact-paths': 'Çizilen çizgileri ve arka planları artefakt olarak işaretle',
  'ua.fix.artifact-paths.hint':
    'İşaretsiz yol çizimlerini artefakt işaretleriyle sarar. Metne ve görsellere dokunulmaz.',
  'ua.fix.tag-annots': 'Bağlantıları, alanları ve ek açıklamaları yapı ağacına al',
  'ua.fix.tag-annots.hint':
    'Her biri için belgenin sonuna bir Link, Form veya Annot öğesi ekler. Onları Etiketler görünümünde taşıyın.',
  'ua.fix.mark-pdfua': 'PDF/UA-1 bildir',
  'ua.fix.mark-pdfua.ready': 'Tüm otomatik kurallar geçiyor. Bildirmek, kişi gerektiren kuralları onaylamaz.',
  'ua.fix.mark-pdfua.blocked': 'Bir otomatik kural başarısızken ya da denetlenemezken sunulmaz.',

  'ua.group.document': 'Belge',
  'ua.group.structure': 'Yapı',
  'ua.group.content': 'İçerik işaretleme',
  'ua.group.graphics': 'Grafikler',
  'ua.group.tables': 'Tablolar',
  'ua.group.lists': 'Listeler',
  'ua.group.links': 'Bağlantılar',
  'ua.group.forms': 'Formlar ve ek açıklamalar',
  'ua.group.fonts': 'Yazı tipleri ve metin',
  'ua.group.navigation': 'Gezinme',

  /* ---- kurallar ---- */
  'ua.rule.marked.name': 'Dosya etiketli olarak işaretli',
  'ua.rule.marked.why':
    '/MarkInfo /Marked true, okuyucuya dosyanın bir yapı ağacı olduğunu söyler. Bu olmadan yardımcı teknolojiler etiketleri yok sayar.',
  'ua.rule.marked.fix':
    'Hızlı düzeltmeyle /Marked true yazın. Yalnızca dosyada yapı ağacı varsa anlamlıdır; önce belgeyi etiketleyin.',
  'ua.rule.marked.detail': '/MarkInfo << /Marked true >> eksik.',

  'ua.rule.title.name': 'Belge başlığı (XMP içinde dc:title)',
  'ua.rule.title.why':
    'PDF/UA başlığın XMP üst verisinde olmasını ister. Okuyucular dosya adı yerine bunu seslendirir.',
  'ua.rule.title.fix': 'Aşağıya bir başlık girin. XMP paketine ve Info sözlüğüne yazılır.',
  'ua.rule.title.detail.none': 'Belgenin başlığı yok.',
  'ua.rule.title.detail.info-only': 'Başlık yalnızca Info sözlüğünde ({title}); XMP paketinde dc:title yok.',
  'ua.rule.title.detail.info-only-no-xmp':
    'Başlık yalnızca Info sözlüğünde ({title}); dosyada XMP paketi yok.',

  'ua.rule.display-title.name': 'Pencere başlığı gösteriyor (DisplayDocTitle)',
  'ua.rule.display-title.why':
    '/ViewerPreferences /DisplayDocTitle true, görüntüleyicinin dosya adı yerine başlığı göstermesini sağlar.',
  'ua.rule.display-title.fix': 'DisplayDocTitle değerini aşağıdaki hızlı düzeltmeyle ayarlayın.',
  'ua.rule.display-title.detail': '/DisplayDocTitle true değil.',

  'ua.rule.lang.name': 'Belge dili (/Lang)',
  'ua.rule.lang.why':
    'Ekran okuyucu telaffuzunu dile göre seçer. Etiket eksik ya da geçersizse tahmin yürütür.',
  'ua.rule.lang.fix': 'Aşağıya tr-TR veya en-US gibi bir dil etiketi girin.',
  'ua.rule.lang.detail.missing': 'Katalogda /Lang girdisi yok.',
  'ua.rule.lang.detail.invalid': '"{lang}" geçerli bir dil etiketi değil.',
  'ua.rule.lang.ok': 'Dil: {lang}.',

  'ua.rule.pdfua-id.name': 'XMP içinde PDF/UA tanımlayıcısı',
  'ua.rule.pdfua-id.why': 'Uygun bir dosya, XMP üst verisinde pdfuaid:part = 1 bildirir.',
  'ua.rule.pdfua-id.fix':
    'Hızlı düzeltme bunu bildirir, ancak yalnızca tüm otomatik kurallar geçtiğinde. Kişi gerektiren kurallar sizin sorumluluğunuzda kalır.',
  'ua.rule.pdfua-id.detail.none': 'pdfuaid:part bildirilmemiş.',
  'ua.rule.pdfua-id.detail.other': 'pdfuaid:part değeri {part}, 1 değil.',

  'ua.rule.encryption.name': 'Şifreleme ekran okuyuculara izin veriyor',
  'ua.rule.encryption.why':
    'İzinleri erişilebilirlik için metne erişimi yasaklayan bir dosya, yardımcı teknolojiler tarafından okunamaz.',
  'ua.rule.encryption.fix': 'Erişilebilirlik izni açık olarak ya da şifresiz yeniden kaydedin.',
  'ua.rule.encryption.detail': 'İzinler erişilebilirlik için içeriğe erişimi yasaklıyor (bit 10).',

  'ua.rule.xfa.name': 'XFA formu yok',
  'ua.rule.xfa.why': 'XFA formları dinamiktir ve PDF/UA ile uyumlu hâle getirilemez.',
  'ua.rule.xfa.fix': 'Formu standart bir AcroForm’a dönüştürün.',
  'ua.rule.xfa.detail': 'AcroForm bir XFA girdisi taşıyor.',

  'ua.rule.struct-tree.name': 'Yapı ağacı (/StructTreeRoot)',
  'ua.rule.struct-tree.why':
    'Etiketler okuyucuya yapıyı ve okuma sırasını verir. Etiketsiz bir dosyada ikisi de yoktur.',
  'ua.rule.struct-tree.fix':
    'Belgeyi Rapor görünümündeki etiketle düğmesiyle ya da Etiketler görünümünde etiketleyin.',
  'ua.rule.struct-tree.detail.none': 'Dosyada yapı ağacı yok.',
  'ua.rule.struct-tree.detail.unreadable': 'Yapı ağacı okunamadı.',
  'ua.rule.struct-tree.ok': '{elements} yapı öğesi.',

  'ua.rule.role-map.name': 'Özel türler standart türlere eşleniyor',
  'ua.rule.role-map.why':
    'Standart kümenin dışındaki bir tür, /RoleMap onu bir standart türe eşlemedikçe okuyucu için bir şey ifade etmez.',
  'ua.rule.role-map.fix':
    'Öğeye Etiketler görünümünde standart bir tür verin ya da özel türü /RoleMap’e ekleyin.',
  'ua.rule.role-map.detail.remapped': '{role} standart türü {to} türüne yeniden eşlenmiş.',
  'ua.rule.role-map.detail.unresolved':
    '{role}, {to} türüne eşleniyor; bu tür hiçbir zaman standart bir türe varmıyor.',
  'ua.rule.role-map.detail.unmapped': '{role} türü standart değil ve /RoleMap içinde de yok.',

  'ua.rule.artifact-nesting.name': 'Artefakt ve etiketli içerik karışmıyor',
  'ua.rule.artifact-nesting.why':
    'İçerik ya etiketlidir ya artefakttır. İkisi birden olan bir dizi öngörülemez biçimde okunur.',
  'ua.rule.artifact-nesting.fix':
    'İçeriği Etiketler görünümünde yeniden etiketleyin ya da belgeyi baştan etiketleyin.',
  'ua.rule.artifact-nesting.detail':
    '{page}. sayfa: {count} işaretli içerik dizisi artefaktı ve etiketli içeriği iç içe geçiriyor.',

  'ua.rule.headings.name': 'Başlık düzeyleri',
  'ua.rule.headings.why':
    'Başlıklar ekran okuyucu kullanıcısının sayfada atlamasını ve ana hatları anlamasını sağlar. Düzeyler atlanmamalıdır.',
  'ua.rule.headings.fix':
    'Başlık türlerini Etiketler görünümünde değiştirin: önce H1, hiçbir düzey atlanmadan ve H ile H1–H6 karışmadan.',
  'ua.rule.headings.detail.mixed': 'Belge numarasız H ile H1–H6’yı karıştırıyor.',
  'ua.rule.headings.detail.first': 'İlk başlık H1 değil, H{level}.',
  'ua.rule.headings.detail.skip': 'Bir başlık H{from} düzeyinden H{to} düzeyine atlıyor.',

  'ua.rule.reading-order.name': 'Okuma sırası mantıklı',
  'ua.rule.reading-order.why':
    'Okuyucunun izlediği sıranın sayfanın anlamına uyup uymadığına yalnızca bir kişi karar verebilir.',
  'ua.rule.reading-order.fix':
    'Etiketler görünümünü açın: sayfadaki numaralar sıradır. Sürükle-bırak ya da ok düğmeleriyle yeniden sıralayın.',
  'ua.rule.reading-order.detail.untagged': 'Dosyada etiket yok; sıra yalnızca içeriğin çizildiği sıradır.',

  'ua.rule.tagged-content.name': 'Tüm içerik etiketli ya da artefakt',
  'ua.rule.tagged-content.why':
    'İkisi de olmayan içerik yardımcı teknolojilere görünmez ya da gelişigüzel sırayla okunur.',
  'ua.rule.tagged-content.fix':
    'Belgeyi etiketleyin, ardından çizgi ve arka plan gibi süsleri artefakt olarak işaretleyin. Aşağıdaki hızlı düzeltme çizim yollarını halleder.',
  'ua.rule.tagged-content.detail':
    '{page}. sayfa: {count} işaretsiz öğe ({text} metin, {paths} yol, {images} görsel).',
  'ua.rule.tagged-content.detail.unreadable': '{page}. sayfa: içerik akışı okunamadı.',

  'ua.rule.mcid-references.name': 'Ağaç ve içerik birbirine başvuruyor',
  'ua.rule.mcid-references.why':
    'Bir sayfadaki her işaretli içerik kimliği ağaçta bulunmalı, ağaç da sayfada olmayan kimliklere başvurmamalıdır. Aksi hâlde okuyucu bağlantıyı kaybeder.',
  'ua.rule.mcid-references.fix':
    'Belgeyi Rapor görünümündeki etiketle düğmesiyle baştan etiketleyin. Etiketler görünümündeki düzenlemeler başvuruları tutarlı tutar.',
  'ua.rule.mcid-references.detail.no-parent-tree': 'Yapı ağacında /ParentTree yok.',
  'ua.rule.mcid-references.detail.orphan':
    '{page}. sayfa: {count} işaretli içerik kimliğine ağaç başvurmuyor.',
  'ua.rule.mcid-references.detail.dangling':
    '{page}. sayfa: ağaç, sayfada bulunmayan {count} işaretli içerik kimliğine başvuruyor.',
  'ua.rule.mcid-references.detail.duplicate':
    '{page}. sayfa: {count} işaretli içerik kimliğine birden fazla kez başvurulmuş.',
  'ua.rule.mcid-references.detail.no-struct-parents':
    '{page}. sayfada /StructParents yok, oysa ağaç sayfanın içeriğine başvuruyor.',

  'ua.rule.image-only.name': 'Sayfalar yalnızca bir resim değil',
  'ua.rule.image-only.why':
    'Tek bir görselden oluşan sayfada okuyucuya verilecek metin yoktur. Önce metin tanıma gerekir.',
  'ua.rule.image-only.fix': 'Araçlardan OCR çalıştırın, ardından belgeyi etiketleyin.',
  'ua.rule.image-only.detail': '{page}. sayfa metinsiz tek bir büyük görsel.',

  'ua.rule.figure-alt.name': 'Şekillerin alternatif metni var',
  'ua.rule.figure-alt.why':
    'Okuyucu, görselin yerine şeklin alternatif metnini seslendirir. Olmadığında resim atlanır ya da "grafik" diye okunur.',
  'ua.rule.figure-alt.fix':
    'Şekli Etiketler görünümünde seçip bir açıklama yazın; yalnızca süsse artefakt olarak işaretleyin.',
  'ua.rule.figure-alt.detail': 'Bir {role} öğesinin alternatif metni yok.',
  'ua.rule.figure-alt.ok': '{figures} şeklin tamamı açıklanmış.',

  'ua.rule.alt-quality.name': 'Alternatif metin anlamlı',
  'ua.rule.alt-quality.why':
    'Bir program açıklamanın var olduğunu görebilir; görselin ne gösterdiğini anlatıp anlatmadığını göremez.',
  'ua.rule.alt-quality.fix': 'Her açıklamayı okuyun ve görselin gösterdiğini aktardığından emin olun.',

  'ua.rule.contrast.name': 'Renk karşıtlığı',
  'ua.rule.contrast.why':
    'Karşıtlık sayfanın yapısına değil görünümüne aittir. Bu denetim onu ölçmez; burada geçmiş görünmek onun hakkında hiçbir şey söylemez.',
  'ua.rule.contrast.fix':
    'Karşıtlığı, bunun için yapılmış bir araçla, çizilmiş sayfa üzerinde WCAG oranlarına göre denetleyin.',

  'ua.rule.table-structure.name': 'Tablo yapısı',
  'ua.rule.table-structure.why':
    'Okuyucunun satır ve sütunları seslendirebilmesi için tablo Table, TR, TH ya da TD (isteğe bağlı THead, TBody, TFoot) biçiminde olmalıdır.',
  'ua.rule.table-structure.fix':
    'İç içe yerleşimi Etiketler görünümünde düzeltin: hücreleri satırlara, satırları tabloya sürükleyin.',
  'ua.rule.table-structure.detail.cell-outside-row': 'Bir {role} hücresi TR içinde değil.',
  'ua.rule.table-structure.detail.row-outside-table': 'Bir TR; Table, THead, TBody veya TFoot içinde değil.',
  'ua.rule.table-structure.detail.row-child': 'Bir TR içinde {role} var; yalnızca TH ve TD olabilir.',
  'ua.rule.table-structure.detail.part-child': 'Bir tablo bölümünün içinde {role} var; yalnızca TR olabilir.',
  'ua.rule.table-structure.detail.table-child':
    'Bir Table içinde {role} var; yalnızca TR, THead, TBody, TFoot ve Caption olabilir.',
  'ua.rule.table-structure.ok': '{tables} tablonun yapısı doğru.',

  'ua.rule.table-headers.name': 'Tabloların başlık hücreleri var',
  'ua.rule.table-headers.why':
    'Başlık hücreleri olmadan okuyucu bir hücrenin hangi sütuna ya da satıra ait olduğunu söyleyemez.',
  'ua.rule.table-headers.fix':
    'İlk satırın ya da sütunun hücrelerini Etiketler görünümünde TH olarak yeniden etiketleyin.',
  'ua.rule.table-headers.detail': 'Bu tabloda hiç TH hücresi yok.',

  'ua.rule.table-scope.name': 'Başlık hücreleri neyin başlığı olduğunu söylüyor',
  'ua.rule.table-scope.why':
    'Okuyucunun hangi başlığın hangi hücreye ait olduğunu bilmesi için TH’nin kapsamı (Row, Column, Both) ya da veri hücrelerinin /Headers girdisi olmalıdır.',
  'ua.rule.table-scope.fix': 'TH hücresini Etiketler görünümünde seçip kapsamını ayarlayın.',
  'ua.rule.table-scope.detail':
    'Bu tablonun {count} başlık hücresinin ne kapsamı ne de veri hücrelerinin başvurduğu bir kimliği var.',

  'ua.rule.table-regular.name': 'Düzensiz tablolar başlıklarını belirtiyor',
  'ua.rule.table-regular.why':
    'Birleştirmeleri ızgarayı bozan bir tabloda okuyucu başlıkları çıkaramaz; her veri hücresinin açık bir /Headers girdisi olmalıdır.',
  'ua.rule.table-regular.fix':
    'Kaynak belgede hücreleri birleştirip bölerek ızgarayı düzenli yapın ya da her veri hücresini başlıklarına bağlayın.',
  'ua.rule.table-regular.detail': 'Bu tablo düzensiz ve {count} veri hücresinin /Headers girdisi yok.',

  'ua.rule.list-structure.name': 'Liste yapısı',
  'ua.rule.list-structure.why':
    'L, LI, Lbl ve LBody, okuyucunun "5 maddelik liste" diyebilmesini ve maddeler arasında gezebilmesini sağlar.',
  'ua.rule.list-structure.fix':
    'Etiketler görünümünde maddeleri seçip Liste yap’ı kullanın ya da iç içe yerleşimi sürükleyerek düzeltin.',
  'ua.rule.list-structure.detail.list-child': 'Bir L içinde {role} var; yalnızca LI olabilir.',
  'ua.rule.list-structure.detail.item-outside-list': 'Bir LI, L içinde değil.',
  'ua.rule.list-structure.detail.item-child': 'Bir LI içinde {role} var; yalnızca Lbl ve LBody olabilir.',
  'ua.rule.list-structure.detail.no-body': 'Bir LI’nin LBody öğesi yok.',
  'ua.rule.list-structure.detail.part-outside-item': 'Bir {role} öğesi LI içinde değil.',
  'ua.rule.list-structure.ok': '{lists} listenin yapısı doğru.',

  'ua.rule.link-tagged.name': 'Bağlantılar etiketli',
  'ua.rule.link-tagged.why':
    'Bir bağlantı ek açıklaması, ona işaret eden bir Link öğesinin içinde olmalıdır; böylece okuyucu onu okuma sırasında seslendirip etkinleştirebilir.',
  'ua.rule.link-tagged.fix':
    'Aşağıdaki hızlı düzeltmeyle her bağlantıya bir Link öğesi verin, sonra Etiketler görünümünde okuma sırasındaki yerine taşıyın.',
  'ua.rule.link-tagged.detail.untagged': 'Bağlantı ek açıklaması yapı ağacında değil.',
  'ua.rule.link-tagged.detail.wrong-element': 'Bağlantı, Link değil bir {role} öğesinin içinde.',
  'ua.rule.link-tagged.detail.no-annotation': 'Bir Link öğesi hiçbir bağlantı ek açıklamasına başvurmuyor.',
  'ua.rule.link-tagged.ok': '{links} bağlantı etiketli.',

  'ua.rule.link-alt.name': 'Bağlantıların açıklaması var',
  'ua.rule.link-alt.why':
    'Bir bağlantının /Contents girdisi (ya da öğesinin alternatif metni), görünür metin yokken ya da belirsizken okuyucunun seslendirdiği şeydir.',
  'ua.rule.link-alt.fix': 'Aşağıya bu bağlantı için bir açıklama yazın.',
  'ua.rule.link-alt.detail': 'Bu bağlantının açıklaması yok.',
  'ua.rule.link-alt.ok': '{links} bağlantının açıklaması var.',

  'ua.rule.annot-tagged.name': 'Ek açıklamalar etiketli ve açıklamalı',
  'ua.rule.annot-tagged.why':
    'Yapı ağacının dışındaki bir ek açıklamayı okuyucu atlar; metni olmayanın da seslendirilecek bir şeyi yoktur.',
  'ua.rule.annot-tagged.fix':
    'Aşağıdaki hızlı düzeltmeyle her ek açıklamaya bir Annot öğesi verin. Metni (/Contents) olmayanlara bir metin ekleyin.',
  'ua.rule.annot-tagged.detail.untagged': 'Bir {subtype} ek açıklaması yapı ağacında değil.',
  'ua.rule.annot-tagged.detail.wrong-element': 'Ek açıklama, Annot değil bir {role} öğesinin içinde.',
  'ua.rule.annot-tagged.detail.no-contents': 'Bir {subtype} ek açıklamasının /Contents girdisi yok.',
  'ua.rule.annot-tagged.ok': '{annotations} ek açıklama etiketli.',

  'ua.rule.form-tagged.name': 'Form alanları etiketli',
  'ua.rule.form-tagged.why':
    'Bir alan, ona işaret eden bir Form öğesinin içinde olmalıdır; böylece okuyucu onu okuma sırasında bulur.',
  'ua.rule.form-tagged.fix':
    'Aşağıdaki hızlı düzeltmeyle her alana bir Form öğesi verin, sonra Etiketler görünümünde okuma sırasındaki yerine taşıyın.',
  'ua.rule.form-tagged.detail.untagged': 'Form alanı yapı ağacında değil.',
  'ua.rule.form-tagged.detail.wrong-element': 'Alan, Form değil bir {role} öğesinin içinde.',
  'ua.rule.form-tagged.ok': '{widgets} form alanı etiketli.',

  'ua.rule.form-tooltip.name': 'Form alanlarının araç ipucu var',
  'ua.rule.form-tooltip.why':
    'Alanın /TU girdisi, okuyucunun etiket olarak seslendirdiği şeydir. Olmadığında alan "düzenleme, boş" diye okunur.',
  'ua.rule.form-tooltip.fix': 'Aşağıya bu alan için bir araç ipucu yazın.',
  'ua.rule.form-tooltip.detail': 'Bu alanın araç ipucu yok.',
  'ua.rule.form-tooltip.ok': '{fields} alanın araç ipucu var.',

  'ua.rule.tab-order.name': 'Sekme sırası yapıyı izliyor',
  'ua.rule.tab-order.why':
    '/Tabs /S, bağlantı ve alan içeren sayfalarda Sekme tuşunun yapı sırasında ilerlemesini sağlar.',
  'ua.rule.tab-order.fix': 'Bu sayfalarda /Tabs /S ayarlamak için aşağıdaki hızlı düzeltmeyi kullanın.',
  'ua.rule.tab-order.detail': '{page}. sayfada ek açıklamalar var ama /Tabs /S yok.',

  'ua.rule.font-embedded.name': 'Yazı tipleri gömülü',
  'ua.rule.font-embedded.why':
    'Gömülü olmayan bir yazı tipi okuyucu tarafından başkasıyla değiştirilebilir; bu da karakterleri ve düzeni bozar.',
  'ua.rule.font-embedded.fix': 'Kaynak belgeyi dışa aktarırken yazı tiplerini gömün.',
  'ua.rule.font-embedded.detail': '{font} yazı tipi gömülü değil ({pages} sayfada kullanılıyor).',
  'ua.rule.font-embedded.ok': '{fonts} yazı tipinin tamamı gömülü.',

  'ua.rule.font-unicode.name': 'Yazı tipleri Unicode’a eşleniyor',
  'ua.rule.font-unicode.why':
    'Okuyucu metni yazı tipinin ToUnicode eşlemesi ya da standart bir kodlama üzerinden çıkarır. Bunlar yoksa metin anlamsız okunur.',
  'ua.rule.font-unicode.fix':
    'ToUnicode eşlemesi olan bir yazı tipiyle (Unicode’lu OpenType ya da TrueType) yeniden dışa aktarın.',
  'ua.rule.font-unicode.detail.bad-map':
    '{font} yazı tipi: ToUnicode eşlemesi geçersiz ya da U+0000 veya U+FFFE’ye eşliyor ({pages} sayfada kullanılıyor).',
  'ua.rule.font-unicode.detail.no-map':
    '{font} yazı tipinin ToUnicode eşlemesi de standart kodlaması da yok ({pages} sayfada kullanılıyor).',
  'ua.rule.font-unicode.ok': '{fonts} yazı tipi Unicode’a eşleniyor.',

  'ua.rule.char-mapping.name': 'Karakterlerin Unicode değeri var',
  'ua.rule.char-mapping.why': 'Okuyucunun eşleyemediği karakterler U+FFFD yedek karakteri olarak çıkar.',
  'ua.rule.char-mapping.fix':
    'ToUnicode eşlemesi taşıyan yazı tipleriyle yeniden dışa aktarın; taranmış sayfa için OCR gerekir.',
  'ua.rule.char-mapping.detail': '{page}. sayfa: {count} karakter Unicode’a eşlenemiyor.',

  'ua.rule.lang-parts.name': 'Dil değişiklikleri işaretli',
  'ua.rule.lang-parts.why':
    'Başka dildeki bir bölümün doğru telaffuz edilmesi için öğesinde /Lang bulunmalıdır. Bir program bir bölümün hangi dilde olduğunu bilemez.',
  'ua.rule.lang-parts.fix':
    'Başka dildeki bölümleri arayın. Etiketler görünümü henüz bir öğenin dilini düzenlemiyor.',

  'ua.rule.bookmarks.name': 'Uzun belgelerde yer imi var',
  'ua.rule.bookmarks.why': '20 sayfadan uzun bir belgede okuyucu yer imleriyle gezinir.',
  'ua.rule.bookmarks.fix': 'Ana hat aracıyla yer imi ekleyin.',
  'ua.rule.bookmarks.detail': 'Belge {pages} sayfa ve hiç yer imi yok.',
  'ua.rule.bookmarks.ok': 'Belgede yer imleri var.',

  /* ---- etiket görünümü ---- */
  'tags.scope.label': 'Göster',
  'tags.scope.page': '{page}. sayfa',
  'tags.scope.all': 'Tüm belge',
  'tags.toolbar': 'Yeniden sırala',
  'tags.up': 'Yukarı taşı',
  'tags.down': 'Aşağı taşı',
  'tags.outdent': 'Üst öğenin dışına taşı',
  'tags.indent': 'Önceki öğenin içine taşı',
  'tags.tree.label': 'Yapı ağacı',
  'tags.empty': 'Bu sayfada gösterilecek öğe yok.',
  'tags.expand': 'Aç',
  'tags.collapse': 'Daralt',
  'tags.mappedTo': 'Standart tür: {role}',
  'tags.noAlt': 'Alternatif metin yok',
  'tags.noAlt.short': 'alt yok',
  'tags.moreRows': '{count} satır daha gizli. Görünümü tek sayfaya daraltın.',
  'tags.select.hint':
    'Türünü, açıklamasını ya da konumunu değiştirmek için bir öğe seçin. Ctrl veya Shift birden çok öğe seçer. Alt ile ok tuşları öğeyi taşır.',
  'tags.type': 'Tür',
  'tags.artifact': 'Artefakt',
  'tags.artifact.help': 'Artefakt olarak işaretle: okuma sırasından çıkar',
  'tags.alt.label': 'Alternatif metin',
  'tags.alt.set': 'Yaz',
  'tags.scope.th': 'Kapsam',
  'tags.scope.none': 'Ayarlanmamış',
  'tags.scope.column': 'Sütun',
  'tags.scope.row': 'Satır',
  'tags.scope.both': 'Her ikisi',
  'tags.group': 'Şunun içine grupla',
  'tags.group.role': 'Yeni grubun türü',
  'tags.unwrap': 'Çöz',
  'tags.makeList': 'Liste yap',
  'tags.multi': '{count} öğe seçili.',
  'tags.draft.none': 'Henüz değişiklik yok.',
  'tags.draft.count': '{count} değişiklik henüz uygulanmadı.',
  'tags.undo': 'Geri al',
  'tags.discard': 'Vazgeç',
  'tags.apply': 'Belgeye uygula',

  'tags.untagged.title': 'Bu dosyada etiket yok.',
  'tags.untagged.explain':
    'Okuyucu, içeriğin çizildiği sıraya başvurur. Aşağıda o sıra, sayfa sayfa gösteriliyor. Türleri ya da sırayı değiştirin, ardından belgeyi etiketleyin.',
  'tags.untagged.page': '{page}. sayfa / {count}',
  'tags.untagged.noBlocks': 'Bu sayfada etiketlenecek bir şey yok.',
  'tags.untagged.list': 'Okuma sırasındaki içerik blokları',
  'tags.untagged.figure': '[görsel]',
  'tags.untagged.skipped': 'Bu sayfadaki {count} blok etiketlenemiyor.',
  'tags.untagged.artifactPaths': 'Çizilen çizgileri ve arka planları artefakt olarak işaretle',
  'tags.untagged.language': 'Dosyada dil yoksa {lang} yazılır.',
  'tags.untagged.apply': 'Belgeyi etiketle',

  'tags.overlay.item': '{number}: {role}',

  'tags.err.missing': 'Bu öğe artık yok.',
  'tags.err.not-editable': 'Bu öğe burada değiştirilemez.',
  'tags.err.cycle': 'Bir öğe kendi içine taşınamaz.',
  'tags.err.not-siblings': 'Yalnızca aynı üst öğeye sahip öğeler gruplanabilir.',
  'tags.err.role': 'Bu, standart bir yapı türü değil.',
  'tags.err.alt': 'Boş açıklama yazılmaz.',
  'tags.err.has-content': 'Bu öğe sayfa içeriği taşıyor, bu yüzden çözülemez.',
  'tags.err.interactive': 'Bu öğe bir bağlantı, alan ya da ek açıklama taşıyor ve artefakt yapılamaz.',
  'tags.err.in-stream': 'Bu öğenin içeriği, bu düzenleyicinin yeniden yazmadığı bir form nesnesinin içinde.',
  'tags.err.duplicate-key': 'Bu grup zaten var.',
  'tags.err.root': 'Belge öğesi taşınamaz, gruplanamaz ya da kaldırılamaz.',
} as const;
