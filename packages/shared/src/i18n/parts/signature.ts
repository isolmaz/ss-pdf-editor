/**
 * Simple signatures (drawn, typed or from a picture), initials, and pictures placed on the
 * page — all written as `/Stamp` annotations (`pdf-core/ops/image-stamp.ts`).
 */

export const signaturePart = {
  'sig.dialog.title': 'İmza ekle',
  'sig.dialog.intro':
    'İmzanızı çizin, yazın ya da bir fotoğrafından alın; sonra sayfada yerleştireceğiniz yere tıklayın.',
  'sig.notCertified':
    'Bu, sertifikalı bir dijital imza değil, sayfaya eklenen bir görseldir. Belgenin imzadan sonra değişmediğini kanıtlamak için “Sertifikayla imzala”yı kullanın.',
  'sig.role': 'Tür',
  'sig.role.signature': 'İmza',
  'sig.role.initials': 'Paraf',
  'sig.tab.draw': 'Çiz',
  'sig.tab.type': 'Yaz',
  'sig.tab.upload': 'Görselden',
  'sig.draw.area': 'İmza çizim alanı',
  'sig.draw.hint': 'Fare, kalem ya da parmağınızla çizin.',
  'sig.draw.clear': 'Temizle',
  'sig.draw.undo': 'Son çizgiyi geri al',
  'sig.type.label': 'Ad soyad',
  'sig.type.placeholder': 'Adınızı yazın',
  'sig.type.font': 'Yazı stili',
  'sig.upload.choose': 'İmza görseli seç',
  'sig.upload.hint':
    'Beyaz kâğıda atılmış imzanın fotoğrafı ya da taraması. Açık renkli arka plan saydam yapılır.',
  'sig.upload.threshold': 'Arka plan temizleme',
  'sig.upload.failed': 'Görsel okunamadı: {name}',
  'sig.color': 'Mürekkep rengi',
  'sig.color.black': 'Siyah',
  'sig.color.blue': 'Mavi',
  'sig.color.navy': 'Lacivert',
  'sig.remember': 'Bu cihazda hatırla',
  'sig.remember.hint':
    'Yalnızca bu tarayıcıda saklanır, hiçbir yere gönderilmez; istediğiniz zaman silebilirsiniz.',
  'sig.saved': 'Kayıtlı imzalar',
  'sig.saved.use': 'Kullan: {label}',
  'sig.saved.delete': 'Kayıtlı imzayı sil: {label}',
  'sig.preview': 'Önizleme',
  'sig.empty': 'Önce bir imza çizin, yazın ya da görsel seçin.',
  'sig.place': 'Yerleştir',
  'sig.cancel': 'Vazgeç',
  'sig.placing': 'Yerleştirmek için sayfada bir yere tıklayın. Esc ile vazgeçin.',
  'sig.placed': '{kind} sayfaya eklendi. Taşımak, döndürmek ya da köşesinden boyutlandırmak için seçin.',
  'sig.command': 'İmza ekle (çiz, yaz, görsel)',

  'img.add.title': 'Görsel ekle',
  'img.add.choose': 'Görsel seç',
  'img.add.failed': 'Görsel okunamadı: {name}. PNG, JPEG, WebP, GIF ya da BMP seçin.',
  'img.add.label': 'Görsel',

  'stamp.resize': 'Boyutlandır',
  'stamp.resized': 'Boyut değiştirildi.',
  'stamp.notResizable': 'Yalnızca görseller ve imzalar köşesinden boyutlandırılabilir.',
  'tool.hint.stamp': 'Yerleştirmek için sayfaya tıklayın; Esc ile vazgeçin.',
  'op.note.stamp.added': '{kind} damga notu olarak eklendi.',
  'op.note.stamp.resized': 'Damga notunun boyutu değiştirildi; görsel yeniden kodlanmadı.',

  'home.tool.signature': 'Çizerek, yazarak ya da fotoğraftan imza ve paraf ekleyin.',
  'home.tool.imageAdd': 'Sayfaya görsel ekleyin; taşıyın, döndürün ve boyutlandırın.',
} as const;
