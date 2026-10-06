/**
 * Annotations and comments.
 *
 * The keys here are the annotation capability's own sentences: the mark kinds the
 * comment panel and the on-canvas layer name, the note lines the writer's report
 * carries, and the progress labels. They live in their own part because the
 * capability is one unit — a mark kind without its translated name is a blank row
 * in the panel, and the writer's report is the product's honesty contract
 * rather than decoration.
 *
 * Wired into `tr.ts` by the integration owner (the keys arrive with the ops).
 */

export const annotationsPart = {
  // Mark kinds (annotationKindKey in pdf-core; also the layer's accessible names).
  'ann.kind.highlight': 'Vurgu',
  'ann.kind.underline': 'Altı çizili',
  'ann.kind.strikeout': 'Üstü çizili',
  'ann.kind.squiggly': 'Dalgalı çizgi',
  'ann.kind.ink': 'Serbest çizim',
  'ann.kind.shapes': 'Şekil',
  'ann.kind.note': 'Not',

  // The comment panel.
  'panel.comments': 'Notlar',
  'ann.filter': 'Not türü süzgeci',
  'ann.filter.all': 'Tümü',
  'ann.count': '{count} not görüntüleniyor; {pending} tanesi henüz kaydedilmedi.',
  'ann.empty': 'Henüz not eklenmedi. Araç çubuğundan bir araç seçip sayfada işaretleyin.',
  'ann.emptyFilter': 'Bu süzgeçle eşleşen not yok.',
  'ann.page': 's. {page}',
  'ann.noComment': 'Yorum yok',
  'ann.pending': 'kaydedilmedi',
  'ann.engineEdit': 'Form veya not düzenlemesi',
  'ann.inFile': 'dosyada',
  'ann.edit': 'Yorumu düzenle',
  'ann.editCancel': 'Vazgeç',
  'ann.comment': 'Yorum metni',
  'ann.remove': 'Sil',
  'ann.clear': 'Tümünü sil',
  'ann.captured': '{count} not motordan devralındı; kaydettiğinizde dosyaya yazılacak.',

  // Data interchange (`annotation-data.ts`): the review as a file of its own, so a
  // review can move between machines without the PDF carrying it.
  'ann.data.exportJson': 'Yorumları JSON olarak dışa aktar',
  'ann.data.exportFdf': 'Yorumları FDF olarak dışa aktar',
  'ann.data.import': 'Yorumları içe aktar',
  'ann.data.exported': '{count} yorum dışa aktarıldı: {name}',
  'ann.data.imported': '{count} yorum içe aktarıldı.',
  'ann.data.importSkipped': '{count} kayıt okunamadı ve atlandı.',
  'ann.data.empty': 'Dışa aktarılacak yorum bulunmuyor.',

  // Annotation tools (the toolbar's armed state and the layer's own labels).
  'ann.tool.highlight': 'Vurgu',
  'ann.tool.underline': 'Altı çizili',
  'ann.tool.strikeout': 'Üstü çizili',
  'ann.tool.squiggly': 'Dalgalı çizgi',
  'ann.tool.ink': 'Serbest çizim',
  'ann.tool.shapes': 'Dikdörtgen',
  'ann.tool.note': 'Not ekle',
  'ann.tool.color': 'Renk',
  'ann.tool.opacity': 'Saydamlık',
  'ann.tool.thickness': 'Kalınlık',
  'ann.tool.author': 'Yazar',
  'ann.tool.stop': 'Aracı kapat',

  // The active tool's property strip (`tools/ToolProperties.tsx`): what the next
  // mark carries, and what the shared selection can act on. The strip shows only the
  // properties the armed tool actually has — every creator this app runs takes a
  // colour, a thickness and an opacity, so those three are what a mark tool offers.
  'ann.tool.selection': 'Seçim',
  'ann.tool.selection.count': '{count} işaret seçili',
  'ann.tool.selection.none': 'Seçili işaret yok',
  'ann.tool.deleteSelection': 'Seçilenleri sil',
  'ann.tool.rotateSelection': '90° döndür',
  'ann.tool.moveSelection': 'Seçimi taşı',
  'ann.tool.moveUp': 'Yukarı taşı (5 pt)',
  'ann.tool.moveDown': 'Aşağı taşı (5 pt)',
  'ann.tool.moveLeft': 'Sola taşı (5 pt)',
  'ann.tool.moveRight': 'Sağa taşı (5 pt)',
  'ann.tool.clearSelection': 'Seçimi bırak',
  'ann.tool.opacityValue': '{value}%',
  'ann.tool.shape': 'Şekil',
  'ann.tool.shape.square': 'Kare',
  'ann.tool.shape.circle': 'Daire',
  'ann.tool.shape.line': 'Çizgi',

  // The shared selection and removal notices (`useShortcuts.ts`, `App.tsx`).
  'ann.selectAll': 'Tüm işaretleri seç',
  'ann.removed': '{count} işaret silindi.',
  // The transform's own report, and the journal's name for the edit: the shell
  // routes a canvas drag, a nudge, a rotate and a panel row through the same step.
  'ann.transformed': '{count} işaret taşındı veya döndürüldü.',
  'ann.transform': 'İşaretleri düzenle',

  // The writer's report (`writeAnnotations` / `retagTextMarkup` /
  // `writeShapeAnnotations`).
  'op.progress.annotate': 'Notlar yazılıyor',
  'op.progress.annotate.retag': 'Altı çizili ve üstü çizili biçimler düzeltiliyor',
  'op.note.annotate.engine': '{count} not motorun kendi yazıcısıyla eklendi (artımlı güncelleme).',
  'op.note.annotate.incremental': 'Dosya biçimi artımlı kaldı: yalnızca yeni nesneler yazıldı.',
  'op.note.annotate.retagged':
    '{count} notun türü gerçek biçimine çevrildi (altı çizili / üstü çizili / dalgalı).',
  'op.note.annotate.shapes': '{count} şekil açıklaması ve görünüm akışı yazıldı.',
  'op.note.annotate.notes': '{count} not, simgesiyle birlikte yapışkan not olarak yazıldı.',
  'op.note.annotate.highlights': '{count} vurgu işareti çizgi görünümüyle yazıldı.',
  'op.note.annotate.shapesPerspective':
    'Şekillerin görünümü bizim yazıcımızla üretildi; ölçek ve döndürme farklı okuyucularda birkaç nokta oynayabilir.',
  'op.note.annotate.nothing': 'Yazılacak yeni not yok; dosya değişmedi.',
  'op.note.annotate.freetext': '{count} metin kutusu gömülü Noto Sans yazı tipiyle yazıldı.',
  'ann.kind.freetext': 'Metin',
  'ann.tool.fontSize': 'Boyut',
  'ann.tool.markupKind': 'Görünüm',
  'ann.freetext.placeholder': 'Metni yazın…',
  'ann.freetext.editor': 'Sayfaya eklenecek metin',
} as const;
