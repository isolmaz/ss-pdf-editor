/** Sanitise the document (`pdf-core/ops/sanitize.ts`). */

export const sanitizePart = {
  'sanitize.title': 'Belgeyi temizle',
  'sanitize.intro':
    'Sayfalarda görünmeyen ama dosyada duran içeriği tek adımda kaldırın: betikler, ekli dosyalar, üst veri, gizli katmanlar ve özel uygulama verisi. Her şey bu tarayıcıda yapılır. Çıktı yeniden okunur ve seçilen her kategorinin gerçekten gittiği doğrulanır. Hiçbir yerden başvurulmayan nesneler her zaman atılır. Dijital imzalar geçersiz olur.',
  'sanitize.remove': 'Kaldırılacaklar',
  'sanitize.removeHint':
    'JavaScript; program başlatma, dosya içe aktarma ve form gönderme eylemlerini de kapsar, belge içinde gezinen bağlantılar kalır. Üst veride üretici satırı kalır. Web bağlantıları ve yorumlar varsayılan olarak kapalıdır: içeriğin parçasıdır, kaldırmak sayfaların görünümünü değiştirir. Gizli katmanlar yalnızca sayfanın aynı görüneceği gösterilebilen yerlerde çıkarılır.',
  'sanitize.opt.javascript': 'JavaScript ve kod çalıştıran eylemler',
  'sanitize.opt.files': 'Ekli dosyalar',
  'sanitize.opt.metadata': 'Belge üst verisi',
  'sanitize.opt.private': 'Özel uygulama verisi',
  'sanitize.opt.thumbnails': 'Küçük resimler',
  'sanitize.opt.layers': 'Gizli katmanlar',
  'sanitize.opt.links': 'Dış bağlantılar',
  'sanitize.opt.comments': 'Yorumlar ve ek açıklamalar',
  'sanitize.forms': 'Form alanları',
  'sanitize.formsHint':
    'Sayfaya işlemek değerleri sayfaya yazar ve alanları siler; kaldırmak alanları siler ve hiçbir şey çizmez.',
  'sanitize.forms.keep': 'Olduğu gibi bırak',
  'sanitize.forms.flatten': 'Sayfaya işle',
  'sanitize.forms.remove': 'Kaldır',
  'sanitize.done': 'Belge temizlendi: {count} öğe kaldırıldı.',
  'tools.sanitize': 'Belgeyi Temizle',
  'tools.sanitizeDesc': 'Betik, ek dosya, üst veri ve gizli içeriği tek adımda kaldırın',
  'home.tool.sanitize':
    'Betikleri, ekli dosyaları, üst veriyi ve gizli katmanları kaldırın; çıktı doğrulanır.',

  'op.progress.sanitize.scan': 'Belge taranıyor ve temizleniyor',
  'op.progress.sanitize.save': 'Dosya yazılıyor',
  'op.progress.sanitize.verify': 'Çıktı yeniden okunarak doğrulanıyor',
  'op.progress.sanitize.render': 'Sayfa görünümü karşılaştırılıyor',

  'op.note.sanitize.removed.javascript': 'Betikler ve etkin eylemler: {found} bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.javascript': 'Betik ya da etkin eylem yok.',
  'op.note.sanitize.removed.files': 'Ekli dosyalar: {found} bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.files': 'Ekli dosya yok.',
  'op.note.sanitize.removed.metadata': 'Üst veri: {found} öğe bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.metadata': 'Kaldırılacak üst veri yok.',
  'op.note.sanitize.removed.private': 'Özel uygulama verisi: {found} bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.private': 'Özel uygulama verisi yok.',
  'op.note.sanitize.removed.thumbnails': 'Küçük resimler: {found} bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.thumbnails': 'Küçük resim yok.',
  'op.note.sanitize.removed.links': 'Dış bağlantılar: {found} bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.links': 'Dış bağlantı yok.',
  'op.note.sanitize.removed.comments': 'Yorumlar: {found} bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.comments': 'Yorum ya da işaretleme yok.',
  'op.note.sanitize.removed.forms': 'Form alanları: {found} bulundu, {removed} kaldırıldı.',
  'op.note.sanitize.none.forms': 'Form alanı yok.',
  'op.note.sanitize.removed.layers':
    'Gizli katmanlar: kapalı katmanlardaki {removed} içerik parçası kaldırıldı, {dropped} katman tanımı silindi.',
  'op.note.sanitize.none.layers': 'Gizli katman içeriği yok.',
  'op.note.sanitize.removed.unused': 'Kullanılmayan nesneler: {found} nesne atıldı.',
  'op.note.sanitize.none.unused': 'Kullanılmayan nesne yok.',
  'op.note.sanitize.layersLeft':
    '{count} gizli katman parçası, güvenle kesilebileceği gösterilemediği için yerinde bırakıldı.',
  'op.note.sanitize.layersUndecided':
    '{count} katman içeriğinin görünürlüğü (görünürlük ifadesi) belirlenemedi; dokunulmadı.',
  'op.note.sanitize.layersUnreadable':
    '{count} içerik akışı okunamadı; içindeki gizli katman içeriği aranamadı.',
  'op.note.sanitize.formsLeft': '{count} form alanı (düğme ya da imza alanı) düzleştirilemediği için kaldı.',
  'op.note.sanitize.signatureBroken':
    'Belgede dijital imza var. Temizleme dosyayı yeniden yazdığı için imza artık geçerli olmayacak.',
  'op.note.sanitize.xfaDropped': 'XFA form tanımı atıldı; AcroForm alanları ayrıca ele alındı.',
  'op.note.sanitize.media':
    '{count} adet 3B ya da zengin ortam ek açıklaması var; bunların kendi betikleri okunmuyor ve değiştirilmedi.',
  'op.note.sanitize.unreadable': '{count} nesne okunamadığı için taranamadı.',
  'op.note.sanitize.rendered':
    'Görünüm doğrulandı: {pages} sayfa, temizlemeden önce ve sonra piksel piksel aynı çizildi.',
  'op.note.sanitize.pictureChanges':
    'Seçimin bir kısmı sayfada görünenleri değiştirdiği için (yorumlar, form alanları, bağlantılar, dosya eki simgeleri) sayfalar önce ve sonra karşılaştırılmadı.',
  'op.note.sanitize.nothing':
    'Seçilen kategorilerin hiçbirinde kaldırılacak bir şey yoktu; dosya değiştirilmedi.',
} as const;
