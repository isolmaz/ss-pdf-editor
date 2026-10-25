/**
 * The trust roots the user imported (“certificate validation against
 * user-imported trust roots (no online service)”).
 *
 * A trust root is a **decision the user made**, not a fact this app can discover: there is
 * no built-in CA list, because shipping one would silently vouch for certificates the user
 * never chose, and there is no network to fetch revocation. What is stored here is
 * therefore exactly what was imported: the certificate's DER, a label to recognise it by,
 * and when it arrived.
 *
 * The file is untrusted input when it is read back (`drafts.ts` follows the same rule): a
 * base64 value that decodes to almost nothing is dropped rather than trusted, and the
 * version field is checked so a future format cannot be misread as this one.
 */

import { fromBase64, toBase64 } from './base64';
import { sha256Hex } from './digest';

export interface TrustRoot {
  readonly id: string;
  /** A label the user can recognise — the certificate's common name, normally. */
  readonly label: string;
  /** The certificate itself, base64. */
  readonly derBase64: string;
  readonly addedAt: number;
}

export interface TrustRootsFile {
  readonly version: 1;
  readonly roots: readonly TrustRoot[];
}

export const EMPTY_TRUST_ROOTS: TrustRootsFile = { version: 1, roots: [] };

/** A root from its DER and a label; the id is the SHA-256 of the DER, so the same
 * certificate imported twice is the same entry rather than two, and two certificates never
 * share one. */
export async function trustRootFrom(
  der: Uint8Array,
  label: string,
  addedAt = Date.now(),
): Promise<TrustRoot> {
  return { id: `root-${await sha256Hex(der)}`, label, derBase64: toBase64(der), addedAt };
}

export function toDer(root: TrustRoot): Uint8Array {
  return fromBase64(root.derBase64);
}

/**
 * Add, replacing an entry with the same certificate so the list cannot grow duplicates. The
 * certificate is what makes two entries the same, not the id: an entry stored under an earlier
 * kind of id is still recognised.
 */
export function addTrustRoot(file: TrustRootsFile, root: TrustRoot): TrustRootsFile {
  return { version: 1, roots: [...file.roots.filter((entry) => entry.derBase64 !== root.derBase64), root] };
}

export function removeTrustRoot(file: TrustRootsFile, id: string): TrustRootsFile {
  return { version: 1, roots: file.roots.filter((entry) => entry.id !== id) };
}

/** Read a stored list back; anything that does not parse is dropped, never guessed at. */
export function parseTrustRoots(raw: unknown): TrustRootsFile {
  if (typeof raw !== 'object' || raw === null) return EMPTY_TRUST_ROOTS;
  const candidate = raw as { version?: unknown; roots?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.roots)) return EMPTY_TRUST_ROOTS;
  const roots: TrustRoot[] = [];
  for (const entry of candidate.roots) {
    if (typeof entry !== 'object' || entry === null) continue;
    const root = entry as { id?: unknown; label?: unknown; derBase64?: unknown; addedAt?: unknown };
    if (typeof root.id !== 'string' || typeof root.label !== 'string' || typeof root.derBase64 !== 'string')
      continue;
    const der = fromBase64(root.derBase64);
    // A certificate is at least a few hundred bytes of DER; a value that decodes to almost
    // nothing is a corrupted entry, not a root.
    if (der.length < 64) continue;
    roots.push({
      id: root.id,
      label: root.label,
      derBase64: root.derBase64,
      addedAt: typeof root.addedAt === 'number' ? root.addedAt : 0,
    });
  }
  return { version: 1, roots };
}
