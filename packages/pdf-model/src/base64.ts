/**
 * base64, the one implementation `pdf-model` has.
 *
 * It is written here rather than taken from `btoa`/`atob`: this package is DOM-free and runs
 * in Node under `pnpm unit` exactly as it runs in the browser, so the one encoding both agree
 * on cannot depend on whichever host is present. Trust roots, revocation lists and the
 * bitmaps a draft carries all go through it.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    // In range: the loop runs while `index < bytes.length`.
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    out += ALPHABET[first >> 2];
    out += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    out += second === undefined ? '=' : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    out += third === undefined ? '=' : ALPHABET[third & 0x3f];
  }
  return out;
}

/**
 * Decode base64, ignoring everything outside the alphabet (line breaks, PEM indentation,
 * `=` padding), so every character that reaches the decoder has a value. The result is a
 * `Uint8Array` over its own `ArrayBuffer`, which is what a `Blob` accepts.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    buffer = (buffer << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (buffer >> bits) & 0xff;
      at += 1;
    }
  }
  return out.subarray(0, at);
}
