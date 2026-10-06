/**
 * Document properties panel: font inventory, embedded files, security summary and the
 * four-state signature status. Turkish, like every other part; merged into `tr.ts` by the integration
 * owner, never imported from it.
 *
 * The signature keys never collapse into one "valid" badge: integrity, trust, revocation evidence and
 * post-signing modification are four separate statements, and the two that this build
 * cannot answer say **why** in their own sentence (no network, no imported trust
 * roots) instead of hiding behind a single badge.
 */

export const propsPart = {
  'props.title': 'Belge bilgileri',
  'props.font.title': 'Yazı tipleri',
  'props.font.empty': 'Belgede yazı tipi kaynağı bulunamadı.',
  'props.font.pages': '{count} sayfa',
  'props.font.embedded': 'Gömülü',
  'props.font.notEmbedded': 'Gömülü değil',
  'props.font.subset': 'Alt küme',
  'props.font.encoding': 'Kodlama: {encoding}',
  'props.attach.title': 'Ek dosyalar',
  'props.attach.add': 'Dosya ekle',
  'props.attach.empty': 'Belgede ek dosya yok.',
  'props.attach.noSize': 'Boyut okunamadı',
  'props.attach.read': 'Aç',
  'props.attach.readNamed': '{name} ekini aç',
  'props.attach.remove': 'Kaldır',
  'props.attach.removeNamed': '{name} ekini kaldır',
  'props.attach.added': '{count} ek dosya eklendi.',
  'props.attach.removed': '{count} ek dosya kaldırıldı.',
  'props.attach.missing': '{count} ek dosya belgede bulunamadı.',
  'props.security.title': 'Güvenlik',
  'props.security.empty': 'Güvenlik bilgisi okunamadı.',
  'props.security.encrypted': 'Şifreli',
  'props.security.plain': 'Şifresiz',
  'props.security.permissions': 'İzinler',
  'props.security.noPermissions': 'Kısıtlama bildirilmemiş.',
  'props.security.note': 'İzinler belgenin kendi bildirdiği değerlerdir; parola olmadan doğrulanamaz.',
  'props.sig.title': 'İmzalar',
  'props.sig.empty': 'Belgede imza alanı yok.',
  'props.sig.unnamed': 'Adsız imza',
  'props.sig.signer': 'İmzalayan: {name}',
  'props.sig.signerUnknown': 'sertifikadan okunamadı',
  'props.sig.signedAt': 'İmza tarihi: {date}',
  'props.sig.dateUnknown': 'belirtilmemiş',
  'props.sig.field.integrity': 'Kriptografik bütünlük',
  'props.sig.field.trust': 'Sertifika güveni',
  'props.sig.field.revocation': 'İptal kanıtı',
  'props.sig.field.coverage': 'İmza sonrası değişiklik',
  'props.sig.integrity.valid': 'Geçerli',
  'props.sig.integrity.invalid': 'Geçersiz',
  'props.sig.integrity.unchecked': 'Denetlenmedi',
  'props.sig.trust.trusted': 'İçe aktarılan kökle doğrulandı',
  'props.sig.trust.untrusted': 'Zincir içe aktarılan bir köke ulaşmadı',
  'props.sig.trust.selfSigned': 'Kendinden imzalı',
  'props.sig.trust.notChecked': 'Denetlenmedi',
  'props.sig.trust.indeterminate': 'Doğrulanamadı',
  'props.sig.trustReason.noRoots': 'İçe aktarılmış bir güven kökü yok, karşılaştıracak bir şey bulunmuyor.',
  'props.sig.trustReason.noIssuer': 'Sertifikayı imzaladığını bildiren bir sertifika bulunamadı.',
  'props.sig.trustReason.unsupportedSignature':
    'Sertifika, bu sürümün doğrulayamadığı bir imza algoritması veya eğri ile imzalanmış.',
  'props.sig.trustReason.unsupportedCriticalExtension':
    'Sertifika, bu doğrulayıcının işlemediği kritik bir uzantı taşıyor; RFC 5280 §4.2 bunun yok sayılmasına izin vermez.',
  'props.sig.trustReason.malformed': 'Sertifika ya da imza değeri çözümlenemedi.',
  'props.sig.trustReason.signatureMismatch':
    'Aday üst sertifikanın anahtarı, altındaki sertifikanın imzasını doğrulamıyor.',
  'props.sig.trustReason.validity':
    'Zincirdeki bir sertifika denetim anında geçerli değil (süresi dolmuş ya da henüz başlamamış).',
  'props.sig.trustReason.notACa': 'Üst sertifikanın cA ayarlı bir basicConstraints uzantısı yok.',
  'props.sig.trustReason.keyUsage': 'Üst sertifikanın keyUsage uzantısı keyCertSign bitini ayarlamıyor.',
  'props.sig.trustReason.pathLength': 'Üst sertifikanın pathLenConstraint sınırı aşılıyor.',
  'props.sig.trustReason.nameConstraint':
    'Alt sertifikanın adları izin verilen alt ağacın dışında ya da dışlanan alt ağacın içinde.',
  'props.sig.revocation.indeterminate': 'Belirlenemedi',
  'props.sig.revocation.note':
    'İptal kanıtı yalnızca bu cihazda zaten bulunan listelerden okunur: aşağıda içe aktardığınız CRL’ler ile PDF içine gömülü CRL ve OCSP yanıtları. Hiçbir şey ağdan çekilmez; bir yayımcı için liste yoksa sonuç "belirlenemedi" olur.',
  'props.sig.trust.note':
    'Sertifika güveni yalnızca kullanıcının içe aktardığı güven kökleriyle denetlenir: zincir, sertifika imzaları WebCrypto ile doğrulanarak köke kadar yürünür. Hiç kök aktarılmadıysa sonuç "denetlenmedi" olur — bu bir hüküm değil, kanıt yokluğudur.',
  'props.sig.chain': 'Zincir: {path}',
  'props.sig.roots.title': 'İçe aktarılan güven kökleri',
  'props.sig.roots.empty':
    'Henüz güven kökü aktarılmadı; sertifika güveni bu yüzden "denetlenmedi" olarak gösteriliyor.',
  'props.sig.roots.import': 'Sertifika aktar',
  'props.sig.roots.remove': 'Kaldır',
  'props.sig.roots.added': '{count} güven kökü eklendi.',
  'props.sig.roots.none': 'Seçilen dosyalarda okunabilir bir sertifika yok.',
  'props.sig.roots.addedRefused': '{count} güven kökü eklendi; {refused} dosya sertifika olarak okunamadı.',
  'props.sig.certValidUntil': 'Sertifika geçerlilik sonu: {date}',
  'props.sig.certExpired': 'Sertifikanın süresi {date} tarihinde dolmuş.',
  'props.sig.certNotYet': 'Sertifika {date} tarihine kadar geçerli değil.',
  'props.sig.coverage.whole': 'Tüm belge kapsanıyor',
  'props.sig.coverage.partial': 'Belgenin bir bölümü kapsanıyor',
  'props.sig.coverage.unknown': 'Belirlenemedi',
  'props.sig.changes': 'İmzadan sonra {count} artımlı güncelleme',
  'props.sig.changesNone': 'İmzadan sonra artımlı güncelleme yok',
  'props.sig.reason.valid':
    'İmzanın kapsadığı baytların özeti CMS yapısındaki messageDigest ile eşleşiyor ve imza değeri sertifikanın açık anahtarıyla doğrulandı.',
  'props.sig.reason.invalid':
    'Ya kapsanan baytların özeti messageDigest ile eşleşmiyor ya da imza değeri sertifikanın açık anahtarıyla doğrulanamadı: belge imzalandıktan sonra değişmiş olabilir.',
  'props.sig.reason.unchecked.layout':
    'İmza sözlüğü dosyanın baytlarında bulunamadı ya da /ByteRange ile /Contents eşleşmedi; yerel denetim yapılamadı.',
  'props.sig.reason.unchecked.subFilter':
    'Bu imza biçimi, bayt aralığı üzerinden doğrudan doğrulanabilen bir CMS imzası değil; denetlenmedi.',
  'props.sig.reason.unchecked.digest':
    'İmzanın kullandığı özet algoritması bu ortamda bulunmuyor; denetlenmedi.',
  'props.sig.reason.unchecked.webCrypto':
    'Bu bağlamda WebCrypto kullanılamadığı için özet hesaplanamadı; denetlenmedi.',
  'props.sig.reason.unchecked.der':
    'CMS yapısında messageDigest özniteliği bulunamadı; yerel denetim yapılamadı.',
  'props.live.fonts': 'Yazı tipi listesi güncellendi: {count}',
  'props.live.attachments': 'Ek dosya listesi güncellendi: {count}',
  'props.live.signatures': 'İmza listesi güncellendi: {count}',
  'op.progress.attach.add': 'Ek dosyalar yazılıyor',
  'op.progress.attach.remove': 'Ek dosyalar kaldırılıyor',
  'op.note.attach.nothing': 'Değişiklik yok; belge olduğu gibi bırakıldı.',
  'op.note.attach.added': '{count} ek dosya eklendi.',
  'op.note.attach.replaced': 'Aynı adlı eski ek kaldırıldı: {name}',
  'op.note.attach.removed': '{count} ek dosya kaldırıldı.',
  'op.note.attach.missing': '{count} ad bulunamadı; bunlar kaldırılmadı.',
} as const;
