/**
 * Redaction audit (`PLAN.md §5/Phase 3`, §9/K16) — the sentences of the object-level
 * report `packages/pdf-core/src/ops/redact-audit.ts` produces and of its panel.
 *
 * Three rules hold these strings together. A `clean.*` key is a claim about the *file*
 * ("nothing of this kind is in it"), so it may only be used by a check that actually
 * looked — and each claim says what was looked at, because a raw byte scan does not see
 * inside a compressed stream (`audit.compressed`). No sentence here may name document
 * content: a finding reports how many occurrences there are and where they sit, never
 * what they say (`audit.residual` counts the user's own search terms by their position
 * in that list). And a check that could not run says so instead of reporting clean
 * (`audit.orphans.skipped`).
 */

export const auditPart = {
  'audit.title': 'Karartma denetimi',
  'audit.findings': 'Denetim bulguları',
  'audit.summary': 'Dosya {objects} nesne ve {revisions} revizyondan oluşuyor; boyut {bytes}.',
  'audit.rerun': 'Yeniden çalıştır',
  'audit.empty': 'Henüz denetim raporu yok. Karartılmış belge denetlendiğinde sonuç burada listelenir.',
  'audit.loading': 'Denetim raporu hazırlanıyor…',
  'audit.group.content': 'İçerik',
  'audit.group.warning': 'Uyarı',
  'audit.group.info': 'Bilgi',

  /* content: the erased bytes themselves may still be in the file */
  'audit.residual': '{term}. aranan metin ham baytlarda {count} yerde bulundu.',
  'audit.clean.text': 'Aranan {terms} terimin hiçbiri ham baytlarda bulunamadı.',
  'audit.clean.textRest': 'Kalan {terms} aranan terim ham baytlarda bulunamadı.',
  'audit.revision': 'Dosyada {revisions} revizyon var; {chains} tanesi /Prev zinciriyle önceki sürüme bağlı.',
  'audit.clean.revisions': 'Dosya tek revizyon taşıyor; önceki sürüme bağlantı yok.',
  'audit.orphan': 'Dosyada başvurulmayan {count} nesne tanımı var.',
  'audit.clean.orphans': 'Başvurulmayan nesne tanımı yok.',

  /* warning: structure that can carry content, and the checks the scan had to skip */
  'audit.orphans.skipped':
    'Dosyada {streams} nesne akışı (/ObjStm) var; başvuru grafiği ham baytlardan okunamadığı için başvurulmayan nesne denetimi yapılamadı.',
  'audit.compressed':
    'Dosyada {count} sıkıştırılmış akış (FlateDecode) var; tarama bu akışların içini açmaz.',
  'audit.clean.compressed': 'Sıkıştırılmış akış yok; tarama dosyayı ham bayt olarak görebiliyor.',
  'audit.metadata': 'Info üst verisi dosyada duruyor ({count} kayıt).',
  'audit.clean.metadata': 'Info üst verisi yok.',
  'audit.xmp': 'XMP üst veri paketi dosyada duruyor ({count} paket).',
  'audit.clean.xmp': 'XMP üst verisi yok.',
  'audit.attachment': 'Dosyada {count} ek (gömülü dosya) var.',
  'audit.clean.attachments': 'Gömülü dosya (ek) yok.',
  'audit.annotation': 'Dosyada {count} açıklama dizisi (/Annots) kaydı var; dizi boş olabilir.',
  'audit.clean.annotations': 'Açıklama dizisi (/Annots) kaydı yok.',
  'audit.javascript': 'Dosyada {count} JavaScript kaydı var.',
  'audit.clean.javascript': 'JavaScript yok.',

  /* info: the file's shape */
  'audit.names': 'Dosyada ad ağacı (/Names) kaydı var ({count}).',
  'audit.clean.names': 'Ad ağacı (/Names) kaydı yok.',

  /*
   * The notice the audit ends on (`R06`). It reports what the scan *covered* — the
   * terms it was given — because a clean report over zero terms says nothing about
   * the document, and reading it as "the redaction is complete" is the failure this
   * sentence exists to prevent.
   */
  'audit.notice.terms': 'Karartma denetimi {count} terim üzerinde çalıştı; sonuç panelde.',
  'audit.notice.residual':
    'Karartma denetimi {count} bulgu bildirdi: silinen metin dosyada kalmış olabilir. Sonuç panelde.',

  /* progress: the find that fills the mark list before an audit exists */
  'op.progress.redact.find': 'Metin aranıyor',
} as const;
