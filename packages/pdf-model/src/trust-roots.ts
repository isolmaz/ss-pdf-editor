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
 * base64 value that does not decode is dropped rather than trusted, and the version field
 * is checked so a future format cannot be misread as this one.
 */

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

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 without `btoa`: this module is DOM-free and runs in Node under `pnpm unit`
 * exactly as it runs in the browser, so the one encoding both agree on is written here
 * rather than taken from whichever host is present.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += ALPHABET[first >> 2];
    out += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    out += second === undefined ? '=' : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    out += third === undefined ? '=' : ALPHABET[third & 0x3f];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (buffer >> bits) & 0xff;
      at += 1;
    }
  }
  return out.subarray(0, at);
}

/** A root from its DER and a label; the id is derived from the DER, so the same
 * certificate imported twice is the same entry rather than two. */
export function trustRootFrom(der: Uint8Array, label: string, addedAt = Date.now()): TrustRoot {
  const encoded = toBase64(der);
  let hash = 0;
  for (const character of encoded) hash = (hash * 31 + character.charCodeAt(0)) % 0xffffffff;
  return { id: `root-${hash.toString(16)}`, label, derBase64: encoded, addedAt };
}

export function toDer(root: TrustRoot): Uint8Array | null {
  return fromBase64(root.derBase64);
}

/** Add, replacing an entry with the same certificate so the list cannot grow duplicates. */
export function addTrustRoot(file: TrustRootsFile, root: TrustRoot): TrustRootsFile {
  return { version: 1, roots: [...file.roots.filter((entry) => entry.id !== root.id), root] };
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
    if (der === null || der.length < 64) continue;
    roots.push({
      id: root.id,
      label: root.label,
      derBase64: root.derBase64,
      addedAt: typeof root.addedAt === 'number' ? root.addedAt : 0,
    });
  }
  return { version: 1, roots };
}

export function serialiseTrustRoots(file: TrustRootsFile): string {
  return JSON.stringify(file);
}
