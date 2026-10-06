/**
 * The CRLs the user imported (“revocation from user-imported CRLs — no online service”).
 *
 * Like the trust roots beside it, an imported list is a **decision the user made**, kept
 * exactly as imported: the CRL's DER (base64), a label to recognise it by and when it arrived.
 * Nothing here interprets it — whether it is signed by the right issuer, still current, or
 * names a certificate is decided by the verifier (`pdf-core/signature-revocation`) at the
 * moment a signature is checked, against the certificate that signature actually carries.
 *
 * A list is stale the day after its `nextUpdate`, and it is the user's to remove: the panel
 * shows the dates beside each entry, and the verifier says when a list it used is past due.
 *
 * The file is untrusted input when it is read back (the same rule as `trust-roots.ts`): a
 * value that does not decode is dropped, and the version field is checked.
 */

import { fromBase64, toBase64 } from './trust-roots';

export interface RevocationList {
  readonly id: string;
  /** What the user sees: the issuer's common name, normally, or the file name. */
  readonly label: string;
  /** The CRL itself, DER, base64. */
  readonly derBase64: string;
  readonly addedAt: number;
  /**
   * What the panel shows beside the label, read from the CRL when it was imported. Display
   * only: the verifier parses the DER itself and never trusts these.
   */
  readonly thisUpdate: string | null;
  readonly nextUpdate: string | null;
  readonly revokedCount: number;
  readonly delta: boolean;
}

/** The display facts an import reads out of a CRL. */
export interface RevocationListSummary {
  readonly thisUpdate: string | null;
  readonly nextUpdate: string | null;
  readonly revokedCount: number;
  readonly delta: boolean;
}

export interface RevocationListsFile {
  readonly version: 1;
  readonly lists: readonly RevocationList[];
}

export const EMPTY_REVOCATION_LISTS: RevocationListsFile = { version: 1, lists: [] };

/** A list from its DER and a label; the id comes from the DER, so one CRL imported twice is one entry. */
export function revocationListFrom(
  der: Uint8Array,
  label: string,
  summary: RevocationListSummary,
  addedAt = Date.now(),
): RevocationList {
  const encoded = toBase64(der);
  let hash = 0;
  for (const character of encoded) hash = (hash * 31 + character.charCodeAt(0)) % 0xffffffff;
  return { id: `crl-${hash.toString(16)}`, label, derBase64: encoded, addedAt, ...summary };
}

export function revocationListDer(list: RevocationList): Uint8Array | null {
  return fromBase64(list.derBase64);
}

export function addRevocationList(file: RevocationListsFile, list: RevocationList): RevocationListsFile {
  return { version: 1, lists: [...file.lists.filter((entry) => entry.id !== list.id), list] };
}

export function removeRevocationList(file: RevocationListsFile, id: string): RevocationListsFile {
  return { version: 1, lists: file.lists.filter((entry) => entry.id !== id) };
}

/** Read a stored file back; whatever does not parse is dropped, never guessed at. */
export function parseRevocationLists(raw: unknown): RevocationListsFile {
  if (typeof raw !== 'object' || raw === null) return EMPTY_REVOCATION_LISTS;
  const candidate = raw as { version?: unknown; lists?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.lists)) return EMPTY_REVOCATION_LISTS;
  const lists: RevocationList[] = [];
  for (const entry of candidate.lists) {
    if (typeof entry !== 'object' || entry === null) continue;
    const list = entry as {
      id?: unknown;
      label?: unknown;
      derBase64?: unknown;
      addedAt?: unknown;
      thisUpdate?: unknown;
      nextUpdate?: unknown;
      revokedCount?: unknown;
      delta?: unknown;
    };
    if (typeof list.id !== 'string' || typeof list.label !== 'string' || typeof list.derBase64 !== 'string')
      continue;
    const der = fromBase64(list.derBase64);
    // A signed CRL, even an empty one, is well over a few dozen bytes of DER.
    if (der === null || der.length < 32) continue;
    lists.push({
      id: list.id,
      label: list.label,
      derBase64: list.derBase64,
      addedAt: typeof list.addedAt === 'number' ? list.addedAt : 0,
      thisUpdate: typeof list.thisUpdate === 'string' ? list.thisUpdate : null,
      nextUpdate: typeof list.nextUpdate === 'string' ? list.nextUpdate : null,
      revokedCount: typeof list.revokedCount === 'number' ? list.revokedCount : 0,
      delta: list.delta === true,
    });
  }
  return { version: 1, lists };
}
