/**
 * Encryption and unlocking.
 */

export const securityPart = {
  'security.title': 'Güvenlik',
  'security.intro':
    'Belge AES-256 ile şifrelenir ve parola olmadan açılamaz. Parola kurtarılamaz, bu yüzden saklayın. Çıktı yeniden açılıp izinleri doğrulandıktan sonra teslim edilir.',
  'security.oldPassword': 'Mevcut parola',
  'security.oldPasswordHint': 'Belge hâlihazırda parolalıysa açma parolası; şifresiz belgelerde boş bırakın.',
  'security.openPassword': 'Açma parolası',
  'security.userPasswordHint': 'Belgeyi açmak için gereken parola; boş bırakılamaz.',
  'security.ownerPassword': 'Sahip parolası',
  'security.ownerPasswordHint': 'Boş bırakılırsa rastgele üretilir.',
  'security.permissions': 'İzinler',
  'security.permissionsHint': 'İşaretlenmeyen izinler okuyucularda kısıtlanır.',
  'security.permission.print': 'Yazdırma',
  'security.permission.copy': 'Kopyalama',
  'security.permission.modify': 'Düzenleme',
  'security.permission.annotate': 'Açıklama ekleme',
  'security.permission.form': 'Form doldurma',
  'security.permission.assemble': 'Sayfa düzenleme',
  'security.permission.accessibility': 'Erişilebilirlik çıkarımı',
  'security.permission.printHq': 'Yüksek kaliteli yazdırma',
  'security.done': 'Belge şifrelendi.',
  'security.unlock.title': 'Parolayı kaldır',
  'security.unlock.intro':
    'Belge, girilen parolayla çözülür ve korumasız kopyası yeni sekmede açılır; özgün dosya değişmez. Parola yalnızca bu işlem için kullanılır, kaydedilmez.',
  'security.unlock.suffix': 'parolasız',
  'security.unlock.password': 'Parola',
  'security.unlock.passwordHint': 'Belgenin açma parolası; yalnızca bu işlem için kullanılır.',
  'password.title': 'Parola gerekli — {name}',
  'password.body':
    'Bu belge parolayla korunuyor. Parola yalnızca bu oturumda belgeyi açmak için kullanılır; hiçbir yere kaydedilmez.',
  'password.label': 'Belgeyi açma parolası',
  'password.open': 'Aç',
  'locked.banner':
    'Parolalı belge: okuyabilir, arayabilir ve yazdırabilirsiniz. Düzenlemek için kilidi açılmış bir kopya oluşturun.',
  'locked.unlockCopy': 'Kilidi açılmış kopya oluştur',
  'locked.done': 'Kilidi açılmış kopya yeni sekmede açıldı; orijinal dosya korumalı kalır.',
} as const;
