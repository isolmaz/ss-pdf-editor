/**
 * Content writers: the text editor (`ops/text-edit.ts`),
 * link annotations (`ops/link-edit.ts`), the outline (`ops/outline-edit.ts`) and
 * the layer pane's writes (`ops/layer-write.ts`).
 *
 * One part for all four because they are one workflow: a text edit lands in a
 * layer, moves a link's rectangle and renumbers the outline a link points at, and
 * every one of them is a **writer of a file the user already has** — so the notes
 * below are measurements, not reassurance. What was erased
 * is the text the verifier could not find any more; what was inserted is the text
 * it did find; a substitution names both faces; a clamp says the page index the
 * request asked for was not the page index that was written.
 *
 * Framework vocabulary stays in the shared parts: `op.progress.redact`,
 * `op.progress.redact.save`, `op.note.redact.singleRevision` and
 * `op.note.metadata.producerKept` are reused by these operations and are
 * registered with the redaction and metadata keys. Only the words these writers
 * alone say live here.
 *
 * Every `{param}` is passed by the call site; the list parameters carry the comma
 * joined names the report shows (`summarise`, `clipList`), already clipped there.
 */

export const phase4Part = {
  /* ----- progress ----- */

  'op.progress.textEdit.write': 'Yeni metin yazılıyor',
  'op.progress.textEdit.verify': 'Çıktı doğrulanıyor',
  'op.progress.link.remove': 'Bağlantılar kaldırılıyor',
  'op.progress.link.add': 'Bağlantılar ekleniyor',
  'op.progress.outline': 'İçindekiler yazılıyor',
  'op.progress.layer.write': 'Katmanlar yazılıyor',

  /* ----- text edit (ops/text-edit.ts; the erase stage reuses parts/engines.ts) ----- */

  'op.note.textEdit.erased': '{rects} dikdörtgen {pages} sayfada silindi. Silinen metin: {removed}',
  'op.note.textEdit.nothingErased': 'Dikdörtgenlerde silinecek metin bulunamadı; silme yapılmadı.',
  'op.note.textEdit.rendered': 'Metin bloğu yeniden çizildi: {font}',
  'op.note.textEdit.fontEmbedded':
    'Yazı tipi dosyaya gömüldü: {font}. Alt küme yazı tipi sonraki düzenlemede yeniden gömülür.',
  'op.note.textEdit.justified':
    '{count} satır sözcük sözcük yerleştirildi (iki yana yaslı düzen isteği); doğrulama karakter sırasını ölçer, sözcük arası boşlukları ölçmez.',
  'op.note.textEdit.fontSubstituted':
    'İstenen yazı tipi kullanılamadı; metin {font} ile yazıldı (istenen: {requested}).',
  'op.note.textEdit.verifiedErased': 'Doğrulandı: silinen metin çıktıda yok. Aranan: {removed}',
  'op.note.textEdit.verifiedInserted':
    'Doğrulandı: yeni metin çıktıda bulundu ve aranabilir. Aranan: {added}',
  'op.note.textEdit.verifiedPages': 'Doğrulandı: sayfa sayısı değişmedi ({pages}).',

  /* ----- link annotations (ops/link-edit.ts) ----- */

  'op.note.link.nothing': 'Geçerli bağlantı değişikliği yok; belge olduğu gibi bırakıldı.',
  'op.note.link.removeNotFound': '{count} istekte belirtilen bağlantı bulunamadı; bu istekler kaldırılmadı.',
  'op.note.link.removeNotLink': '{count} açıklama bağlantı olmadığı için kaldırılmadı.',
  'op.note.link.targetMissing': 'Hedef sayfası bulunamayan {count} bağlantı eklenmedi.',
  'op.note.link.destinationClamped': '{count} hedef sayfa numarası belgenin aralığına kırpıldı.',
  'op.note.link.uriEncoded': '{count} adres yüzde kodlamalı yazıldı (RFC 3986).',
  'op.note.link.added': '{count} bağlantı eklendi.',
  'op.note.link.removed': '{count} bağlantı kaldırıldı.',

  /* ----- image editing (ops/image-edit.ts) ----- */

  'op.progress.image.read': 'Belgedeki görseller okunuyor',
  'op.progress.image.write': 'Yeni görsel verisi yazılıyor',
  'op.progress.image.opacity': 'Görselin saydamlığı yazılıyor',
  'op.note.image.nothing': 'Değiştirilecek görsel belirtilmedi; belge olduğu gibi bırakıldı.',
  'op.note.image.noneFound': 'İstenen {count} görsel belgede bulunamadı; değişiklik yapılmadı.',
  'op.note.image.notFound': 'İstenen {count} görsel belgede bulunamadı; diğerleri yazıldı.',
  'op.note.image.replaced': '"{name}" görseli {page}. sayfada değiştirildi.',
  'op.note.image.shared':
    '"{name}" görseli {count} sayfada birden kullanılıyor: değişiklik o sayfaların hepsinde görünür.',
  'op.note.image.maskDropped':
    '{count} saydamlık maskesi kaldırıldı: eski maskeler eski pikselleri tanımlar, yeni görsele uygulanamaz.',
  'op.note.image.maskKept': '"{name}" görselinin saydamlık maskesi korundu (istenmişti).',
  'op.note.image.opacitySet': '"{name}" görselinin opaklığı {opacity} olarak ayarlandı.',
  'op.note.image.opacityWrapped':
    'Çizim {count} yerde saydamlık durumuyla sarmalandı ({state}); içerik akışının geri kalanı değişmedi.',
  'op.note.image.filterUnsupported': 'Bu görselin sıkıştırma biçimi bu sürümde çözülemiyor.',
  'op.note.image.bitsUnsupported': 'Bu görsel 8 bit dışı örneklerle yazılmış.',
  'op.note.image.colorSpaceUnsupported': 'Bu görselin renk uzayı bu sürümde çözülemiyor.',
  'op.note.image.decodeFailed': 'Görsel verisi çözülemedi.',
  'op.note.image.notImage': 'Bu nesne bir görsel değil (XObject alt türü görsel değil).',
  'op.note.image.mask': 'Bu nesne bir görüntü maskesi; pikselleri tek başına görsel değil.',
  'op.note.image.degenerate': 'Bu görselin genişlik/yükseklik bilgisi geçersiz.',

  /* ----- digital signature (ops/sign.ts, signature-cms.ts) ----- */

  'op.progress.sign.prepare': 'İmza alanı hazırlanıyor',
  'op.progress.sign.digest': 'İmzalanacak bayt aralığı özetleniyor',
  'op.progress.sign.verify': 'Üretilen imza doğrulanıyor',
  'op.note.sign.fieldCreated': 'Yeni imza alanı oluşturuldu: {name}',
  'op.note.sign.fieldFilled': 'Belgedeki boş imza alanı dolduruldu: {name}',
  'op.note.sign.signed': 'PAdES B-B imzası yazıldı ({digest}, {bytes} bayt CMS).',
  'op.note.sign.byteRange':
    'İmzalanan aralık: {start}–{end} ve {tail} baytlık kuyruk; aradaki baytlar imzanın kendisi.',
  'sign.title': 'Belgeyi imzala (PAdES B-B)',
  'sign.intro':
    'PKCS#12 (.p12/.pfx) dosyanızı ve parolasını seçin. İmza tamamen bu cihazda üretilir; hiçbir şey gönderilmez. Zaman damgası (B-T) bu sürümde yoktur.',
  'sign.field.file': 'PKCS#12 dosyası',
  'sign.field.fileHint':
    'Sertifikanızı ve özel anahtarınızı taşıyan .p12/.pfx dosyası. Dosya cihazdan çıkmaz.',
  'sign.field.password': 'PKCS#12 parolası',
  'sign.field.passwordHint': 'Parola yalnızca anahtarı açmak için kullanılır, hiçbir yerde saklanmaz.',
  'sign.field.name': 'İmza alanı adı (isteğe bağlı)',
  'sign.field.nameHint':
    'Boş bırakılırsa belgedeki boş imza alanı doldurulur; yoksa bu adla yeni alan oluşturulur.',
  'sign.field.digest': 'Özet algoritması',
  'sign.field.digestHint': 'SHA-256 B-B için yaygın olandır; daha uzun özet daha büyük CMS yazar.',
  'sign.digest.sha256': 'SHA-256',
  'sign.digest.sha384': 'SHA-384',
  'sign.digest.sha512': 'SHA-512',
  'sign.field.page': 'Damga sayfası',
  'sign.field.place': 'Damga konumu',
  'sign.place.bottomRight': 'Sağ alt',
  'sign.place.bottomLeft': 'Sol alt',
  'sign.place.topRight': 'Sağ üst',
  'sign.place.topLeft': 'Sol üst',
  'sign.field.reason': 'Gerekçe (isteğe bağlı)',
  'sign.field.location': 'Konum (isteğe bağlı)',
  'sign.field.visible': 'Görünür imza damgası ekle',
  'sign.field.visibleHint': 'Seçilen sayfaya, imzalayanın adını ve tarihi gösteren bir kutu çizilir.',
  'sign.confirm': 'İmzala',
  'sign.done': 'İmza yazıldı ({signer}); dosyayı kaydedin ya da dışa aktarın.',
  'sign.open': 'Belgeyi imzala',

  /* ----- signature status in the shell (the pre-save warning and the badge) ----- */

  'sig.warn.breaks.title': 'Kaydetmek imzayı geçersiz kılacak',
  'sig.warn.breaks.body':
    'Belgede {signer} imzası var ({field}). Bu kayıt dosyayı baştan yazıyor: imzanın kapsadığı baytlar değişeceği için imza doğrulanamaz hale gelir. Devam edilsin mi?',
  'sig.warn.revision.title': 'İmzadan sonra yeni bir sürüm yazılacak',
  'sig.warn.revision.body':
    'Belgede {signer} imzası var ({field}). Bu kayıt dosyaya bir sürüm ekliyor: imza geçerli kalır, ama okuyucular “imzadan sonra değişiklik” gösterecek.',
  'sig.warn.continue': 'Devam et',
  'sig.warn.saveAnyway': 'Yine de kaydet',
  'status.signatures': 'İmza: {count}',
  'status.signatureModified': 'İmzadan sonra {count} değişiklik',
  'status.signatureBroken': 'İmza doğrulanamıyor',

  /* ----- attachments write (ops/attachments-write.ts) ----- */

  'panel.attachments.add': 'Dosya ekle',
  'panel.attachments.remove': 'Eki kaldır',
  /* ----- the document-derived select (`dialog.field.choice`, dialogs/fields.tsx) ----- */

  'dialog.field.choiceEmpty': 'Bu belgede seçilebilecek bir öğe yok.',

  /* ----- image dialog (ops/index.ts id 'image-edit') ----- */

  'image.title': 'Görseli değiştir',
  'image.intro':
    'Belgedeki bir görsel nesnesini seçin ve yerine yeni bir PNG/JPEG koyun. Yerleşim, kırpma ve sayfadaki konum değişmez: yalnızca nesnenin kendi verisi değişir.',
  'image.field.target': 'Görsel',
  'image.field.targetHint': 'Sayfa, nesne adı, piksel boyutu ve dosyadaki biçimi.',
  'image.field.action': 'İşlem',
  'image.action.replace': 'Yeni dosyayla değiştir',
  'image.action.compress': 'Yeniden sıkıştır (JPEG)',
  'image.action.rotate': 'Döndür',
  'image.action.crop': 'Kırp (yüzde)',
  'image.action.opacity': 'Opaklık',
  'image.field.alpha': 'Opaklık (0–1)',
  'image.field.alphaHint': '1 tam opak; 0,5 yarı saydam. Sayfa içeriği değişmez, yalnızca çizim durumu.',
  'image.field.quality': 'JPEG kalitesi',
  'image.field.qualityHint': '0,05–1 arası; yalnızca yeniden sıkıştırmada kullanılır.',
  'image.field.degrees': 'Açı',
  'image.degrees.90': '90° (saat yönü)',
  'image.degrees.180': '180°',
  'image.degrees.270': '270°',
  'image.field.cropTop': 'Üstten kırp (%)',
  'image.field.cropRight': 'Sağdan kırp (%)',
  'image.field.cropBottom': 'Alttan kırp (%)',
  'image.field.cropLeft': 'Soldan kırp (%)',
  'image.field.file': 'Yeni görsel dosyası',
  'image.field.fileHint': 'PNG veya JPEG. Nesnenin sayfadaki yerleşimi korunur.',
  'image.done': 'Görsel değiştirildi.',
  'image.open': 'Görselleri düzenle',
  'image.choice': '{page}. sayfa · {name} · {width}×{height} · {filter} · {kb} KB{mask}{limit}',
  'image.choice.mask': ' · saydamlık',
  'image.choice.limit': ' · yalnızca değiştirilebilir',
  'image.choice.raw': 'sıkıştırılmamış',

  /* ----- link tool + dialog (ops/link-edit.ts, ops/link-add.ts) ----- */

  'link.tool': 'Bağlantı ekle',
  'link.title': 'Bağlantı ekle',
  'link.intro': 'Çizdiğiniz dikdörtgenin hedefini seçin. Bağlantı dosyaya yazılır; metin değişmez.',

  'link.field.kind': 'Hedef türü',
  'link.kind.uri': 'Adres (URL)',
  'link.kind.page': 'Belge içi sayfa',
  'link.field.uri': 'Adres',
  'link.field.uriPlaceholder': 'https://ornek.com',
  'link.field.page': 'Hedef sayfa',
  'link.done': 'Bağlantı eklendi.',

  /* ----- outline dialog (ops/index.ts id 'outline-edit') ----- */

  'outline.title': 'İçindekileri düzenle',
  'panel.outline.edit': 'İçindekileri düzenle',
  'outline.intro':
    'İçindekileri yeniden yazın, bir öğe ekleyin, adını değiştirin veya silin. Değişiklik dosyaya yazılır ve çıktı yeniden okunarak doğrulanır.',
  'outline.field.mode': 'İşlem',
  'outline.mode.replaceAll': 'Tümünü yeniden yaz',
  'outline.mode.addChild': 'Öğe ekle',
  'outline.mode.rename': 'Yeniden adlandır',
  'outline.mode.remove': 'Sil',
  'outline.field.nodes': 'İçindekiler (her satır bir öğe)',
  'outline.field.nodesHint':
    'Biçim: Başlık | sayfa. Sayfa verilmezse öğe hedefsiz yazılır; sayfa numarası 1’den başlar. Boş liste içindekileri tümüyle kaldırır.',
  'outline.field.path': 'Öğe yolu',
  'outline.field.pathHint':
    'Üst düzey için boş bırakın; 1.2 üst düzeydeki birinci öğenin ikinci alt öğesidir.',
  'outline.field.pathPlaceholder': 'örn. 1.2',
  'outline.field.title': 'Başlık',
  'outline.field.page': 'Hedef sayfa',
  'outline.done': 'İçindekiler güncellendi.',

  /* ----- layer panel write (ops/layer-write.ts) ----- */

  'panel.layers.write': 'Katman durumunu kaydet',
  'panel.layers.writeHint': 'Mevcut katman görünürlüğünü PDF belgesine yazar.',

  /* ----- outline (ops/outline-edit.ts) ----- */

  'op.note.outline.nothing': 'Geçerli içindekiler değişikliği yok; belge olduğu gibi bırakıldı.',
  'op.note.outline.cleared': 'İçindekiler tümüyle kaldırıldı; belgede içindekiler kalmadı.',
  'op.note.outline.replaced': 'İçindekiler {count} öğeyle yeniden yazıldı.',
  'op.note.outline.childAdded':
    '"{title}" öğesi içindekilere eklendi; alt ağacıyla birlikte {count} öğe yazıldı.',
  'op.note.outline.renamed': 'İçindekiler öğesi yeniden adlandırıldı: {from} → {to}',
  'op.note.outline.removed': '"{title}" öğesi kaldırıldı; alt ağacıyla birlikte {count} öğe silindi.',
  'op.note.outline.destinationClamped': '{count} hedef sayfa numarası belgenin aralığına kırpıldı.',
  'op.note.outline.nodes': 'İçindekilerdeki öğe sayısı: {before} → {after}',

  /* ----- layers (ops/layer-write.ts) ----- */

  'op.note.layer.nothing': 'Geçerli katman değişikliği yok; belge olduğu gibi bırakıldı.',
  'op.note.layer.orderFlattened': 'Katman sırası düzleştirildi; iç içe gruplar tek düzeyde yazıldı.',
  'op.note.layer.orderUnknown': 'İstenen sırada adı bulunamayan {count} katman atlandı.',
  'op.note.layer.orderAppended': 'Sırada adı geçmeyen {count} katman sıranın sonuna eklendi.',
  'op.note.layer.order': 'Katman sırası yazıldı: {order}',
  'op.note.layer.renamed': 'Katman yeniden adlandırıldı: {from} → {to}',
  'op.note.layer.states': 'Katman görünürlüğü — açık: {on}; kapalı: {off}',
  'op.note.layer.viewOverrides':
    'Görünüm kullanımında katmanın durumunu geçersiz kılan {count} kayıt temizlendi.',
  'op.note.layer.usageKept': 'Katmanların görünüm kullanımı (/AS) girdileri korundu.',
  'op.note.layer.nameMissing': 'Adı belgede bulunamayan {count} katman isteği uygulanmadı.',
} as const;
