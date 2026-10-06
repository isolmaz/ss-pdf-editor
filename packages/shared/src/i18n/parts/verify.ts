/**
 * Output verification: the sentences for the fact table
 * `apps/web/src/operations.ts` returns and for the notice a save ends on.
 *
 * The vocabulary is the point. Three sentences describe three *different* answers —
 * `verify.verified` means a check ran and held, `verify.degraded` means the check did
 * not come back as a preservation claim (a declared size/perf shortcut skipped it, or
 * the operation changed the fact and declared that it may), `verify.unsupported` means
 * this build cannot check that fact at all — and each names the facts it speaks about,
 * because "doğrulandı" without a list is the sentence that let the old verification
 * pass for a check it never ran. A fact the operation is allowed to change is named by
 * `verify.declared`, never left implicit: "no claim" must not read as "preserved".
 *
 * `verify.reason.*` is the short parenthesis a fact carries in those lists. Each key is
 * a reason the engine side can actually produce (`VerificationReason` in
 * `apps/web/src/operations.ts`), so an unlisted reason is a compile error rather than a
 * blank parenthesis.
 */

export const verifyPart = {
  /* the twelve document facts the invariant table speaks about */
  'verify.fact.pageCount': 'sayfa sayısı',
  'verify.fact.pageOrder': 'sayfa sırası',
  'verify.fact.pageContent': 'sayfa içeriği',
  'verify.fact.formFieldCount': 'form alanı sayısı',
  'verify.fact.formFieldValues': 'form alanı değerleri',
  'verify.fact.annotations': 'açıklamalar',
  'verify.fact.outlines': 'içindekiler',
  'verify.fact.pageLabels': 'sayfa etiketleri',
  'verify.fact.textContent': 'metin',
  'verify.fact.rotation': 'döndürme',
  'verify.fact.cropBox': 'kırpma kutusu',
  'verify.fact.signatures': 'imzalar',

  /* one sentence per outcome, each naming the facts it is about */
  'verify.verified': 'Doğrulandı: {facts}.',
  'verify.degraded': 'Sınırlı doğrulandı: {facts}.',
  'verify.unsupported': 'Bu sürümde doğrulanamadı: {facts}.',
  'verify.declared': 'İşlem şunları değiştirebilir: {facts}.',

  /* why a fact did not come back as a preservation claim */
  'verify.reason.budget': 'bellek bütçesi aşıldı',
  'verify.reason.sampled': '{count} sayfa örneklendi',
  'verify.reason.changed': 'işlem bu bilgiyi değiştirebilir',
  'verify.reason.unverified': 'işlem tanınmadı: {steps}',
  'verify.reason.no-reference': 'karşılaştırılacak belge yok',
  'verify.reason.engine-cannot': 'okuyucu bu bilgiyi veremiyor',
  'verify.reason.pending-storage': 'motorun bekleyen açıklama deposu referansla çakışıyor',
  'verify.reason.trust-policy':
    'imza geçerliliği güven politikası gerektirir; kaydetme yolu bunu ayrıca denetler',
} as const;
