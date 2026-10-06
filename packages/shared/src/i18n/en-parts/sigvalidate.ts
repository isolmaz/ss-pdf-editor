/**
 * Signature validation beyond integrity and trust: revocation from lists already on the
 * device (imported CRLs, and the CRLs and OCSP responses a PDF embeds) and RFC 3161 timestamp
 * tokens (`pdf-core/signature-revocation.ts`, `signature-timestamp.ts`). Nothing is fetched.
 */

export const sigValidatePart = {
  'props.sig.revocation.notRevoked': 'Not revoked',
  'props.sig.revocation.revoked': 'Revoked',
  'props.sig.revocation.revokedAfter': 'Revoked after signing',
  'props.sig.revocation.partial': 'Partly checked: none revoked, no list for some certificates',
  'props.sig.field.timestamp': 'Timestamp',
  'props.sig.rev.title': 'Certificate revocation details',
  'props.sig.rev.role.signer': 'Signer certificate',
  'props.sig.rev.role.intermediate': 'Intermediate certificate',
  'props.sig.rev.role.timestamp': 'Timestamp authority certificate',
  'props.sig.rev.good': '{role} “{subject}”: not revoked ({source}, {date}).',
  'props.sig.rev.revoked': '{role} “{subject}”: revoked on {date} ({reason}).',
  'props.sig.rev.unknown': '{role} “{subject}”: unknown — {why}.',
  'props.sig.rev.src.crl.imported': 'imported CRL',
  'props.sig.rev.src.crl.embedded': 'CRL embedded in the PDF',
  'props.sig.rev.src.ocsp.embedded': 'OCSP response embedded in the PDF',
  'props.sig.rev.src.ocsp.imported': 'OCSP response',
  'props.sig.rev.noteBefore':
    'The list was issued before the signature, so it cannot rule out a later revocation.',
  'props.sig.rev.noteStale': 'The list is past its next-update date ({date}).',
  'props.sig.rev.timingBefore':
    'The revocation is dated at or before the signing time: the signature was made after it.',
  'props.sig.rev.timingAfter':
    'The revocation is dated after the trusted timestamp: the certificate was good when the signature was made.',
  'props.sig.rev.timingAfterClaimed':
    'The revocation is dated after the time the signer claims, but that time is not proven: treat it as revoked.',
  'props.sig.rev.why.noList': 'no CRL or OCSP response for this issuer',
  'props.sig.rev.why.noIssuer': 'the issuer certificate is not available',
  'props.sig.rev.why.invalidList':
    'a list for this issuer failed verification (signature, key usage or validity)',
  'props.sig.rev.why.unsupportedList':
    'the list for this issuer uses a feature this build does not process (indirect CRL or an unsupported critical extension)',
  'props.sig.rev.why.listScope':
    'the list for this issuer does not cover this certificate (delta, partitioned or reason-limited)',
  'props.sig.rev.reason.unspecified': 'no reason given',
  'props.sig.rev.reason.keyCompromise': 'key compromise',
  'props.sig.rev.reason.cACompromise': 'CA compromise',
  'props.sig.rev.reason.affiliationChanged': 'affiliation changed',
  'props.sig.rev.reason.superseded': 'superseded',
  'props.sig.rev.reason.cessationOfOperation': 'cessation of operation',
  'props.sig.rev.reason.certificateHold': 'on hold',
  'props.sig.rev.reason.privilegeWithdrawn': 'privilege withdrawn',
  'props.sig.rev.reason.aACompromise': 'AA compromise',
  'props.sig.ts.status.valid': 'Valid',
  'props.sig.ts.status.invalid': 'Invalid',
  'props.sig.ts.status.unchecked': 'Not checked',
  'props.sig.ts.kind.signature': 'Signature timestamp',
  'props.sig.ts.kind.document': 'Document timestamp',
  'props.sig.ts.detail': '{kind}: {time}, issued by {tsa} ({hash}).',
  'props.sig.ts.tsaUnknown': 'unknown',
  'props.sig.ts.trust.trusted':
    'The time-stamping authority chains to an imported root and none of its certificates is revoked: its time was used to judge this signature.',
  'props.sig.ts.trust.untrusted':
    'The time-stamping authority does not chain to an imported root, or one of its certificates is revoked: the time is shown but not relied on, since anyone can run a timestamp server.',
  'props.sig.ts.reason.malformed': 'The token could not be read as an RFC 3161 timestamp.',
  'props.sig.ts.reason.imprint-mismatch':
    'The hash in the token does not match the data it should stamp: the data may have changed after the timestamp.',
  'props.sig.ts.reason.unsupported-hash': 'The hash algorithm of the token is not supported here.',
  'props.sig.ts.reason.no-tsa-certificate':
    'The token does not carry the certificate of the authority that signed it.',
  'props.sig.ts.reason.digest-mismatch':
    'The signed attributes of the token disagree with its content (messageDigest or contentType).',
  'props.sig.ts.reason.bad-signature':
    "The token's signature could not be verified with the authority's key.",
  'props.sig.ts.reason.unsupported-signature': "The token's signature algorithm is not supported here.",
  'props.sig.ts.reason.tsa-key-usage':
    'The authority certificate does not carry the id-kp-timeStamping extended key usage.',
  'props.sig.ts.reason.tsa-validity':
    'The authority certificate was not valid at the moment the timestamp was issued.',
  'props.sig.validationTime': 'Judged at: {time} — {source}.',
  'props.sig.vt.timestamp': 'trusted timestamp',
  'props.sig.vt.timestamp-untrusted': 'untrusted timestamp',
  'props.sig.vt.signing-time': 'time claimed by the signer, not proven',
  'props.sig.vt.clock': "today's date",
  'props.sig.certValidAtTimestamp':
    'The certificate expired on {date}, but it was valid when the trusted timestamp was issued.',
  'props.sig.reason.timestamp.valid':
    'The timestamp token is valid: its hash, its signature and the authority certificate were verified.',
  'props.sig.reason.timestamp.invalid':
    'The timestamp token could not be verified; the cause is given below.',
  'props.sig.reason.timestamp.unchecked': 'The timestamp token could not be checked by this build.',
  'props.sig.crls.title': 'Imported revocation lists (CRL)',
  'props.sig.crls.empty': 'No CRL imported yet; revocation is read only from lists embedded in the PDF.',
  'props.sig.crls.import': 'Import CRL',
  'props.sig.crls.remove': 'Remove',
  'props.sig.crls.removeNamed': 'Remove CRL {name}',
  'props.sig.crls.item': '{issuer} · issued {thisUpdate} · next {nextUpdate} · {count} revoked',
  'props.sig.crls.noNext': 'not stated',
  'props.sig.crls.expired': 'past its next update',
  'props.sig.crls.delta': 'delta CRL',
  'props.sig.crls.added': '{count} CRL(s) added.',
  'props.sig.crls.none': 'No readable CRL found in the selected files (DER or PEM expected).',
  'props.sig.crls.addedRefused': '{count} CRL(s) added; {refused} file(s) could not be read as a CRL.',
  'props.sig.crls.note':
    "A CRL is only used for certificates its own issuer issued, and only after its signature verifies against that issuer's certificate.",
} as const;
