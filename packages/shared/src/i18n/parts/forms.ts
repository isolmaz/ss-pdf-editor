/**
 * Form v2 (`PLAN.md §5/Phase 3`, §6 A11).
 *
 * The notes here are measurements the operation reports (what was filled, what
 * the engine could not regenerate, which names the data file did not match), so
 * the wording is part of the honesty contract of `PLAN.md §1.2`. The reason keys
 * are the sentences a validation refusal shows.
 *
 * Wired into `tr.ts` by the integration owner (the keys arrive with the ops).
 */

export const formsPart = {
  'op.progress.forms': 'Form alanları işleniyor',

  // The form panel (inventory + inline filling).
  'panel.forms': 'Form alanları',
  'panel.compare': 'Karşılaştırma',
  'panel.accessibility': 'Erişilebilirlik',
  'form.panel.empty': 'Bu belgede form alanı yok.',
  'form.panel.count': '{count} form alanı listelendi.',
  'form.field.readOnly': 'Salt okunur',
  'form.field.required': 'Zorunlu',
  'form.field.checked': 'İşaretli',
  'form.field.unchecked': 'İşaretsiz',
  'form.field.empty': '(boş)',
  'form.kind.text': 'Metin',
  'form.kind.checkbox': 'Onay kutusu',
  'form.kind.dropdown': 'Açılır liste',
  'form.kind.radio': 'Seçenek grubu',
  'form.kind.optionlist': 'Liste',
  'form.kind.button': 'Düğme',
  'form.kind.signature': 'İmza',
  'form.kind.unknown': 'Bilinmeyen',

  'form.note.filled': '{count} alan dolduruldu.',
  'form.note.structure': 'Form alanlarının yapısı, adları ve sırası korundu.',
  'form.note.missing':
    '{count} alan bu belgede bulunamadı; adları raporda listelenir (veri dosyası başka bir belgeye mi ait?).',
  'form.note.appearance':
    'Görünüm akışı yeniden üretilemedi; değerler alanlarda duruyor ama çizilen form eski olabilir.',
  'form.note.appearanceNoto':
    'Görünümler gömülü Noto Sans ile yeniden üretildi — Türkçe karakterler (ş ğ ı İ) doğru çizilir.',
  'form.note.created': '{count} yeni form alanı oluşturuldu.',
  'form.note.createdAppearance':
    'Yeni alanların görünümü gömülü Noto Sans ile çizildi; alanlar tüm okuyucularda düzenlenebilir kalır.',
  'form.note.flagged': '{count} alanın kilit/zorunlu durumu güncellendi.',
  'form.note.flattened': '{count} form alanı sayfa içeriğine gömüldü (düzleştirildi).',
  'form.note.flattenFieldsGone':
    'Düzleştirme alanları kaldırır: değerler sayfanın parçası olur, artık düzenlenemez.',
  'form.note.calculated': '{count} hesaplama alanı güncellendi.',

  'form.dialog.fields.title': 'Form alanlarını doldur',
  'form.dialog.fields.intro':
    'Alan listesi belgeden okunur ve rapora yazılır; düzenlemeler "ad=değer" satırları olarak girilir.',
  'form.dialog.fills': 'Doldurulacak alanlar',
  'form.dialog.fillsHint':
    'Her satır bir atama: ad=değer. Onay kutusu için true/false, çok seçimli liste için virgülle ayırın.',
  'form.dialog.tokenEquals': 'eşittir',
  'form.dialog.calculations': 'Hesaplamalar',
  'form.dialog.calculationsHint':
    'Her satır bir kural: hedef = ifade. Dört işlem, parantez, min(a,b) ve max(a,b) desteklenir.',
  'form.dialog.lock': 'Doldurulan alanları kilitle',
  'form.dialog.lockHint': 'Alanlar salt okunur olur; değerler korunur, sonradan düzenlenemez.',
  'form.dialog.validateOnly': 'Yalnızca doğrula',
  'form.dialog.validateOnlyHint':
    'Açıkken belge değiştirilmez: kurallar ve zorunlu alanlar denetlenir, sonuç rapora yazılır.',
  'form.dialog.create.title': 'Yeni form alanı',
  'form.dialog.create.intro':
    'Alan sayfaya dikdörtgenle yerleştirilir (nokta cinsinden, sol alt köşe orijin).',
  'form.dialog.kind': 'Alan türü',
  'form.dialog.name': 'Alan adı',
  'form.dialog.nameHint': 'Birden fazla sayfa seçilirse ad sayfa numarasıyla çoğaltılır.',
  'form.dialog.x': 'Sol (x)',
  'form.dialog.y': 'Alt (y)',
  'form.dialog.width': 'Genişlik',
  'form.dialog.height': 'Yükseklik',
  'form.dialog.defaultValue': 'Varsayılan değer',
  'form.dialog.options': 'Seçenekler',
  'form.dialog.optionsHint': 'Virgülle ayırın; açılır liste, seçenek grubu ve liste için kullanılır.',
  'form.dialog.fontSize': 'Yazı boyutu',
  'form.dialog.data.title': 'Form verisi',
  'form.dialog.data.intro':
    'Dışa aktarma bir veri dosyası üretir (JSON veya FDF). İçe aktarma, dosyadaki değerleri alanlara yazar.',
  'form.dialog.mode': 'Yön',
  'form.dialog.mode.export': 'Dışa aktar',
  'form.dialog.mode.import': 'İçe aktar',
  'form.dialog.format': 'Biçim',
  'form.dialog.format.json': 'JSON',
  'form.dialog.format.fdf': 'FDF',
  'form.dialog.file': 'Veri dosyası',
  'form.dialog.fileHint': 'Dışa aktarılan .json veya .fdf dosyasını seçin.',
  'form.dialog.flatten': 'İçe aktardıktan sonra düzleştir',
  'form.dialog.flattenHint': 'Alanlar sayfa içeriğine gömülür; artık düzenlenemez.',
  'form.note.inventory': 'Belgede {count} form alanı var.',
  'form.note.valid': 'Bütün değerler alan kurallarına uyuyor.',
  'form.note.refused': '{count} değer alan kurallarına uymadı; adları raporda listelenir.',
  'form.note.exported': '{count} alan değeri veri dosyasına yazıldı.',
  'form.note.exportIsData': 'Üretilen dosya belgenin kendisi değil, form verisidir.',
  'form.note.imported': '{count} alan değeri veri dosyasından uygulandı.',

  'form.reason.readOnly': 'Bu alan salt okunur.',
  'form.reason.required': 'Bu alan zorunlu.',
  'form.reason.maxLength': 'Girilen metin alanın uzunluk sınırından uzun.',
  'form.reason.notAnOption': 'Seçilen değer alanın seçenekleri arasında değil.',
} as const;
