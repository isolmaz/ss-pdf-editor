/**
 * Accessibility: the check report, the tagging
 * writer and the alt-text writes of `ops/accessibility.ts`, and the panel that
 * shows them (`panels/AccessibilityPanel.tsx`).
 *
 * The words only this feature says live here: the operation's progress lines
 * and its write notes (`op.progress.a11y.*`, `op.note.a11y.*`), the sentences the
 * check reports per finding (`op.a11y.check.*`), the two lists that say what was
 * looked at and what was not (`op.a11y.checked.*`, `op.a11y.notChecked.*`), and the
 * panel's own copy (`panel.a11y.*`) — the tag and alt-text actions, the empty and
 * stale states, and the sentence it shows when no language was given.
 *
 * Framework vocabulary stays in the shared parts: `op.progress`, `op.cancel` and
 * the mapped `error.<code>.*` sentences are reused by this operation and are
 * registered where the other operations register them — only the words the
 * accessibility work alone says are here.
 *
 * Nothing here claims conformance: the check lists findings and names what it did
 * not examine, and no key carries a score or a verdict.
 *
 * Every `{param}` is passed by the call site; the list parameters carry the
 * comma joined names the note shows.
 */

export const a11yPart = {
  'op.progress.a11y.check': 'Belge erişilebilirliği denetleniyor',
  'op.progress.a11y.tag': 'Metin blokları sayfalarla eşleştiriliyor',
  'op.progress.a11y.verify': 'Etiketli çıktı doğrulanıyor',
  'op.note.a11y.tagged':
    '{pages}/{total} sayfa etiketlendi: {paragraphs} paragraf, {headings} başlık, {figures} görsel.',
  'op.note.a11y.markInfoSet': '/MarkInfo << /Marked true >> yazıldı.',
  'op.note.a11y.langSet': 'Belge dili /Lang = {lang} olarak yazıldı.',
  'op.note.a11y.langKept': 'Belgenin kendi dili korundu: {lang}.',
  'op.note.a11y.langNoLanguage': 'Dil verilmediği için /Lang yazılmadı; belgenin dili tahmin edilmez.',
  'op.note.a11y.pageNoBlocks': '{page}. sayfa etiketlenmedi: metin katmanı yok.',
  'op.note.a11y.pageUnmatched':
    '{page}. sayfa etiketlenmedi: {blocks} blok, {shows} metin gösterimi eşleşmedi.',
  'op.note.a11y.pageUnreadable': '{page}. sayfa etiketlenmedi: içerik akışı okunamadı ({reason}).',
  'op.note.a11y.pageOverlap': '{page}. sayfada {skipped} aralık çakıştığı için etiketlenmedi.',
  'op.note.a11y.placement':
    '{page}. sayfa: {matched} metin bloğa bağlandı, {ambiguous} yakınlıkla, {unmatched} bağlanamadı.',
  'op.note.a11y.headingGuess':
    'Başlıklar yazı boyutu ve kalınlığa göre tahmin edildi (gövde {body} pt, {count} başlık).',
  'op.note.a11y.orderFromContent':
    'Öğe sırası içerik akışındaki sıradır; görsel okuma sırasıyla karşılaştırılmadı.',
  'op.note.a11y.contentRewritten': '{pages} sayfanın içerik akışı işaretli içerik için yeniden yazıldı.',
  'op.note.a11y.figureNoAlt': '{count} görsel alt metin olmadan etiketlendi.',
  'op.note.a11y.nothingTagged': 'Etiketlenecek içerik bulunamadı; dosya değiştirilmedi.',
  'op.note.a11y.elementLimit': 'Öğe sınırına ({limit}) ulaşıldı; kalan sayfalar etiketlenmedi.',
  'op.note.a11y.formsNotTagged': 'Form alanları ve bağlantılar etiketlenmedi (yalnızca metin ve görseller).',
  'op.note.a11y.textReadFailed': '{page}. sayfanın metni okunamadı; sayfa etiketlenmedi.',
  'op.note.a11y.altSet': '"{name}" görseline alt metin yazıldı ({pages}. sayfalar).',
  'op.note.a11y.altShared':
    '"{name}" tek bir nesne: aynı alt metin {count} sayfada ({pages}) görünür, sayfa başına ayrı yazılamaz.',
  'op.note.a11y.altNotDrawn': '"{name}" sayfa kaynaklarında var ama hiçbir içerik akışı çizmiyor.',
  'op.note.a11y.tooltipSet': '"{name}" alanının açıklaması (/TU) yazıldı: {tooltip}',
  'op.note.a11y.targetMissing': 'İstenen {count} nesne belgede bulunamadı.',
  'op.a11y.check.structTree': 'Yapı ağacı (/StructTreeRoot) yok.',
  'op.a11y.check.structTreeOk': 'Yapı ağacı var ({objects} öğe okundu).',
  'op.a11y.check.structTruncated': 'Yapı ağacı {limit} öğede kesildi; sayılanlar alt sınırdır.',
  'op.a11y.check.markInfo': '/MarkInfo /Marked true yok.',
  'op.a11y.check.markInfoOk': '/MarkInfo << /Marked true >> var.',
  'op.a11y.check.lang': 'Belge dili (/Lang) yok.',
  'op.a11y.check.langOk': 'Belge dili: {lang}.',
  'op.a11y.check.infoTitle': 'Info sözlüğünde başlık (/Title) yok.',
  'op.a11y.check.infoTitleOk': 'Info sözlüğünde başlık var.',
  'op.a11y.check.xmpMissing': 'XMP üst verisi (/Metadata) yok.',
  'op.a11y.check.xmpTitle': 'XMP paketi var ama dc:title yok.',
  'op.a11y.check.xmpTitleOk': 'XMP paketinde dc:title var.',
  'op.a11y.check.imageAlt': '"{name}" görselinin alt metni yok ({pages}. sayfalar).',
  'op.a11y.check.imageAltOk': 'Çizilen {count} görselin tümünde alt metin var.',
  'op.a11y.check.fieldTooltip': '"{name}" alanının açıklaması (/TU) yok.',
  'op.a11y.check.fieldTooltipOk': '{count} form alanının tümünde açıklama var.',
  'op.a11y.check.linkContents': '{page}. sayfadaki bağlantı açıklamasının (/Contents) metni yok.',
  'op.a11y.check.linkContentsOk': '{count} bağlantının tümünde /Contents var.',
  'op.a11y.check.paragraphs': 'Yapı ağacında hiç /P öğesi yok.',
  'op.a11y.check.paragraphsOk': 'Yapı ağacında {count} /P öğesi var.',
  'op.a11y.check.paragraphsUnchecked': 'Yapı ağacı olmadığı için /P aranamadı.',
  'op.a11y.check.pageUnreadable': '{page}. sayfanın içerik akışı çözülemedi; çizilen görseller bilinmiyor.',
  'op.a11y.check.listClipped': '{count} bulgu var; ilk {shown} tanesi listelendi.',
  'op.a11y.check.fieldTreeTruncated': 'Form alanları {limit} alanda kesildi.',
  'op.a11y.check.nestedTooDeep': '{page}. sayfada {depth} düzeyden derin form nesneleri taranmadı.',
  'op.a11y.checked.structTree': 'Yapı ağacı arandı',
  'op.a11y.checked.markInfo': '/MarkInfo /Marked arandı',
  'op.a11y.checked.lang': 'Belge dili arandı',
  'op.a11y.checked.titles': 'Info ve XMP başlığı arandı',
  'op.a11y.checked.imageAlt': 'Çizilen görsellerin alt metni arandı',
  'op.a11y.checked.fieldTooltip': 'Form alanı açıklamaları arandı',
  'op.a11y.checked.linkContents': 'Bağlantı açıklamaları arandı',
  'op.a11y.checked.paragraphs': 'Yapı ağacındaki /P öğeleri arandı',
  'op.a11y.notChecked.readingOrder': 'Okuma sırasının görsel sırayla uyuşup uyuşmadığı denetlenmedi.',
  'op.a11y.notChecked.tables':
    'Tablo, liste ve başlık yapıları (/Table, /TR, /TH, /LI, /Lbl) denetlenmedi; bu araç onları yazmaz.',
  'op.a11y.notChecked.artifacts': 'Süsleme içeriğinin (/Artifact) işaretlenip işaretlenmediği denetlenmedi.',
  'op.a11y.notChecked.fonts': 'Yazı tiplerinin gömülü olması ve Unicode eşlemeleri (ToUnicode) denetlenmedi.',
  'op.a11y.notChecked.annotStructure':
    'Bağlantı ve form alanlarının etiketli yapısı (/Link, /Form, /OBJR) denetlenmedi.',
  'op.a11y.notChecked.altQuality':
    'Alt metnin görseli gerçekten anlatıp anlatmadığı denetlenmedi; yalnızca var/yok okunur.',
  'op.a11y.notChecked.visual':
    'Renk karşıtlığı, yazı boyutu ve hedef boyutu gibi görsel ölçütler denetlenmedi.',
  'op.a11y.notChecked.raster': 'Taranmış sayfalardaki (görüntü içindeki) metin için OCR yapılmadı.',
  'op.a11y.notChecked.xmpXml': 'XMP paketi XML olarak çözümlenmedi; dc:title düz metin olarak aranır.',
  'op.a11y.notChecked.conformance':
    'Bu denetim bir uygunluk değerlendirmesi değildir: PDF/UA veya WCAG uygunluğu iddia edilmez.',
  'panel.a11y': 'Erişilebilirlik',
  'a11y.applied': 'Erişilebilirlik yazımı belgeye uygulandı ({count} not).',
  'panel.a11y.check': 'Denetle',
  'panel.a11y.empty': 'Denetim henüz çalıştırılmadı.',
  'panel.a11y.stale':
    'Bu denetimden sonra belge yazıldı; sonuçlar eski sürümü anlatıyor. Yeniden denetleyin.',
  'panel.a11y.summary': '{pages} sayfa · {problems} bulgu · {unknown} bilinmiyor',
  'panel.a11y.page': '{page}. sayfa',
  'panel.a11y.group.problem': 'Bulunan sorunlar',
  'panel.a11y.group.unchecked': 'Denetlenemedi',
  'panel.a11y.group.ok': 'Denetlendi, sorun bulunmadı',
  'panel.a11y.notChecked': 'Bakılmayanlar',
  'panel.a11y.notes': 'Bu yazma işleminin notları',
  'panel.a11y.tag': 'Belgeyi etiketle',
  'panel.a11y.alt': 'Görsel alt metinleri',
  'panel.a11y.alt.empty': 'Bu belgede çizilen görsel bulunamadı.',
  'panel.a11y.alt.target': '{name} · {pages}. sayfa',
  'panel.a11y.alt.missing': 'alt metin yok',
  'panel.a11y.alt.label': '{name} görselinin alt metni',
  'panel.a11y.alt.save': 'Kaydet',
} as const;
