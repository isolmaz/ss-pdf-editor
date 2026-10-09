/**
 * The language a PDF declares for itself.
 */

/**
 * The primary language subtag of a catalog `/Lang` ("de-DE" → "de"), or `null` when the
 * value is not a language tag (an empty string, "x-unknown"). The primary subtag is what
 * a voice is matched on: a German document is read by any local German voice, not only by
 * one of the same region.
 */
export function primaryLanguage(declared: string): string | null {
  return /^([a-z]{2,3})(?:[-_]|$)/i.exec(declared.trim())?.[1]?.toLowerCase() ?? null;
}

/**
 * The primary language of the document `info` dictionary pdf.js reports (`info.Language` is
 * the catalog's `/Lang`), or `null` when the dictionary is absent or declares none.
 */
export function declaredLanguage(info: unknown): string | null {
  const declared = (info as { readonly Language?: unknown } | null)?.Language;
  return typeof declared === 'string' ? primaryLanguage(declared) : null;
}
