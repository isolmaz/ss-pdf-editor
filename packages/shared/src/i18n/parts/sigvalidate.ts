/**
 * Signature validation beyond integrity and trust: revocation from lists already on the
 * device (imported CRLs, and the CRLs and OCSP responses a PDF embeds) and RFC 3161 timestamp
 * tokens (`pdf-core/signature-revocation.ts`, `signature-timestamp.ts`). Nothing is fetched.
 */

export const sigValidatePart = {
  'props.sig.revocation.notRevoked': 'İptal edilmemiş',
  'props.sig.revocation.notRevokedOutdated':
    'İptal listesinde yok, ancak listeler bunu dışlamak için fazla eski',
  'props.sig.revocation.revoked': 'İptal edilmiş',
  'props.sig.revocation.revokedAfter': 'İmzadan sonra iptal edilmiş',
  'props.sig.revocation.partial': 'Kısmen denetlendi: iptal edilmiş yok, bazı sertifikalar için liste yok',
  'props.sig.field.timestamp': 'Zaman damgası',
  'props.sig.rev.title': 'Sertifika iptal ayrıntıları',
  'props.sig.rev.role.signer': 'İmzalayan sertifika',
  'props.sig.rev.role.intermediate': 'Ara sertifika',
  'props.sig.rev.role.timestamp': 'Zaman damgası yetkilisi sertifikası',
  'props.sig.rev.good': '{role} “{subject}”: iptal edilmemiş ({source}, {date}).',
  'props.sig.rev.revoked': '{role} “{subject}”: {date} tarihinde iptal edilmiş ({reason}).',
  'props.sig.rev.unknown': '{role} “{subject}”: bilinmiyor — {why}.',
  'props.sig.rev.src.crl.imported': 'içe aktarılan CRL',
  'props.sig.rev.src.crl.embedded': 'PDF içindeki CRL',
  'props.sig.rev.src.ocsp.embedded': 'PDF içindeki OCSP yanıtı',
  'props.sig.rev.src.ocsp.imported': 'OCSP yanıtı',
  'props.sig.rev.noteBefore': 'Liste imzadan önce yayımlanmış; sonradan olan bir iptali dışlayamaz.',
  'props.sig.rev.noteStale': 'Listenin bir sonraki güncelleme tarihi ({date}) geçmiş.',
  'props.sig.rev.timingBefore': 'İptal, imza zamanından önce ya da aynı anda: imza iptalden sonra atılmış.',
  'props.sig.rev.timingAfter':
    'İptal, güvenilen zaman damgasından sonra: imza atıldığında sertifika geçerliydi.',
  'props.sig.rev.timingAfterClaimed':
    'İptal tarihi imzalayanın beyan ettiği zamandan sonra, ama bu zaman kanıtlanmış değil: iptal edilmiş sayın.',
  'props.sig.rev.why.noList': 'bu yayımcı için CRL ya da OCSP yanıtı yok',
  'props.sig.rev.why.noIssuer': 'yayımcı sertifikası elde yok',
  'props.sig.rev.why.invalidList':
    'bu yayımcının listesi doğrulanamadı (imza, anahtar kullanımı ya da geçerlilik)',
  'props.sig.rev.why.unsupportedList':
    'bu yayımcının listesi bu sürümün işlemediği bir özellik kullanıyor (dolaylı CRL ya da desteklenmeyen kritik uzantı)',
  'props.sig.rev.why.listScope':
    'bu yayımcının listesi bu sertifikayı kapsamıyor (delta, bölümlenmiş ya da neden sınırlı)',
  'props.sig.rev.reason.unspecified': 'neden belirtilmemiş',
  'props.sig.rev.reason.keyCompromise': 'anahtar ele geçirildi',
  'props.sig.rev.reason.cACompromise': 'CA ele geçirildi',
  'props.sig.rev.reason.affiliationChanged': 'bağlılık değişti',
  'props.sig.rev.reason.superseded': 'yenisiyle değiştirildi',
  'props.sig.rev.reason.cessationOfOperation': 'faaliyet sona erdi',
  'props.sig.rev.reason.certificateHold': 'askıya alındı',
  'props.sig.rev.reason.privilegeWithdrawn': 'yetki geri alındı',
  'props.sig.rev.reason.aACompromise': 'AA ele geçirildi',
  'props.sig.ts.status.valid': 'Geçerli',
  'props.sig.ts.status.invalid': 'Geçersiz',
  'props.sig.ts.status.unchecked': 'Denetlenmedi',
  'props.sig.ts.kind.signature': 'İmza zaman damgası',
  'props.sig.ts.kind.document': 'Belge zaman damgası',
  'props.sig.ts.detail': '{kind}: {time}, damgayı vuran: {tsa} ({hash}).',
  'props.sig.ts.tsaUnknown': 'bilinmiyor',
  'props.sig.ts.trust.trusted':
    'Damga yetkilisi içe aktarılan bir köke bağlanıyor ve sertifikaları iptal edilmemiş: zamanı bu imzayı değerlendirmek için kullanıldı.',
  'props.sig.ts.trust.untrusted':
    'Damga yetkilisi içe aktarılan bir köke bağlanmıyor ya da bir sertifikası iptal edilmiş: zaman gösterilir ama güvenilmez; herkes kendi damga sunucusunu kurabilir.',
  'props.sig.ts.reason.malformed': 'Belirteç bir RFC 3161 zaman damgası olarak okunamadı.',
  'props.sig.ts.reason.imprint-mismatch':
    'Belirteçteki özet, damgalanması gereken verinin özetiyle uyuşmuyor: veri damgadan sonra değişmiş olabilir.',
  'props.sig.ts.reason.unsupported-hash': 'Belirtecin özet algoritması bu ortamda desteklenmiyor.',
  'props.sig.ts.reason.no-tsa-certificate':
    'Belirteç, kendisini imzalayan damga yetkilisinin sertifikasını taşımıyor.',
  'props.sig.ts.reason.digest-mismatch':
    'Belirtecin imzalı öznitelikleri içeriğiyle tutarsız (messageDigest ya da contentType).',
  'props.sig.ts.reason.bad-signature': 'Belirtecin imzası damga yetkilisinin anahtarıyla doğrulanamadı.',
  'props.sig.ts.reason.unsupported-signature': 'Belirtecin imza algoritması bu ortamda desteklenmiyor.',
  'props.sig.ts.reason.tsa-key-usage':
    'Damga yetkilisi sertifikası id-kp-timeStamping genişletilmiş anahtar kullanımını taşımıyor.',
  'props.sig.ts.reason.tsa-validity': 'Damga yetkilisi sertifikası, damganın vurulduğu anda geçerli değildi.',
  'props.sig.validationTime': 'Değerlendirme zamanı: {time} — {source}.',
  'props.sig.vt.timestamp': 'güvenilen zaman damgası',
  'props.sig.vt.timestamp-untrusted': 'güvenilmeyen zaman damgası',
  'props.sig.vt.signing-time': 'imzalayanın beyan ettiği zaman, kanıtlanmamış',
  'props.sig.vt.clock': 'bugünün tarihi',
  'props.sig.certValidAtTimestamp':
    'Sertifikanın süresi {date} tarihinde dolmuş, ancak güvenilen zaman damgasının vurulduğu anda geçerliydi.',
  'props.sig.reason.timestamp.valid':
    'Zaman damgası belirteci geçerli: özet, belirteç imzası ve damga yetkilisi sertifikası doğrulandı.',
  'props.sig.reason.timestamp.invalid':
    'Zaman damgası belirteci doğrulanamadı; nedeni aşağıda belirtilmiştir.',
  'props.sig.reason.timestamp.unchecked': 'Zaman damgası belirteci bu sürümle denetlenemedi.',
  'props.sig.crls.title': 'İçe aktarılan iptal listeleri (CRL)',
  'props.sig.crls.empty':
    'Henüz CRL aktarılmadı; iptal bilgisi yalnızca PDF içine gömülü listelerden okunur.',
  'props.sig.crls.import': 'CRL aktar',
  'props.sig.crls.remove': 'Kaldır',
  'props.sig.crls.removeNamed': '{name} CRL’sini kaldır',
  'props.sig.crls.item': '{issuer} · yayım {thisUpdate} · sonraki {nextUpdate} · {count} iptal',
  'props.sig.crls.noNext': 'belirtilmemiş',
  'props.sig.crls.expired': 'sonraki güncelleme tarihi geçmiş',
  'props.sig.crls.delta': 'delta CRL',
  'props.sig.crls.added': '{count} CRL eklendi.',
  'props.sig.crls.none': 'Seçilen dosyalarda okunabilir bir CRL yok (DER ya da PEM olmalı).',
  'props.sig.crls.addedRefused': '{count} CRL eklendi; {refused} dosya CRL olarak okunamadı.',
  'props.sig.crls.note':
    'Bir CRL yalnızca kendi yayımcısının verdiği sertifikalar için ve imzası o yayımcının sertifikasıyla doğrulandıktan sonra kullanılır.',
} as const;
