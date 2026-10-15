/**
 * Reader-extended forms: the usage-rights signature a rewrite invalidates.
 *
 * Acrobat "Reader Extensions" adds a `/Perms /UR3` (older files `/UR`) signature that covers
 * the file's bytes and tells Adobe Reader the form may be filled and saved. A rewrite changes
 * those bytes, so the signature no longer verifies and Reader answers with "This document
 * enabled extended features … but has been changed since it was created". The entry is
 * removed instead of left to fail; `/DocMDP` (the author's certification signature) is a
 * different entry and is not touched here — a rewrite that invalidates it is the signing
 * code's business.
 *
 * Shared by `forms.ts` and `xfa.ts` and importing neither, so both can use it.
 */

import type { PDFDocument } from 'mupdf';
import { resolved } from '../engines/mupdf-write';

const USAGE_RIGHTS_KEYS = ['UR3', 'UR'] as const;

/**
 * Remove `/Perms /UR3` and `/Perms /UR` from the catalog; `/Perms` goes too when nothing
 * else is left in it. Returns whether anything was removed. Call it only on a document that
 * is about to be saved as a rewrite — an incremental update keeps the signed bytes intact.
 */
export function dropUsageRights(doc: PDFDocument): boolean {
  const catalog = resolved(doc.getTrailer().get('Root'));
  const perms = catalog === null ? null : resolved(catalog.get('Perms'));
  if (catalog === null || perms === null || !perms.isDictionary()) return false;
  let removed = false;
  for (const key of USAGE_RIGHTS_KEYS) {
    if (perms.get(key).isNull()) continue;
    perms.delete(key);
    removed = true;
  }
  if (removed) {
    let remaining = 0;
    perms.forEach(() => {
      remaining += 1;
    });
    if (remaining === 0) catalog.delete('Perms');
  }
  return removed;
}
