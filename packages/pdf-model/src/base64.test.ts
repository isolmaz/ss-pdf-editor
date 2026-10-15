/**
 * `base64.ts`: the one DOM-free base64 trust roots, revocation lists and draft bitmaps share.
 * Its answer is checked against Node's own base64, so a disagreement with what a browser's
 * `btoa`/`atob` would give is a failure here.
 */

import { describe, expect, it } from 'vitest';
import { fromBase64, toBase64 } from './base64';

function bytesOf(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 13 + seed) & 0xff);
}

describe('base64', () => {
  it('encodes and decodes every length remainder exactly as Node does', () => {
    for (let length = 0; length <= 6; length += 1) {
      const bytes = bytesOf(length * 17 + 1, length);
      const encoded = toBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
      expect([...fromBase64(encoded)]).toEqual([...bytes]);
    }
    const every = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(toBase64(every)).toBe(Buffer.from(every).toString('base64'));
    expect([...fromBase64(toBase64(every))]).toEqual([...every]);
  });

  it('round-trips a payload far larger than any one chunk', () => {
    const bitmap = bytesOf(7, 300_001);
    const encoded = toBase64(bitmap);
    expect(encoded).toBe(Buffer.from(bitmap).toString('base64'));
    expect(fromBase64(encoded)).toEqual(bitmap);
  });

  it('decodes a PEM body: line breaks, indentation and padding are not data', () => {
    const bytes = bytesOf(5, 100);
    const wrapped = Buffer.from(bytes)
      .toString('base64')
      .replace(/.{1,64}/g, (line) => `  ${line}\r\n`);
    expect([...fromBase64(wrapped)]).toEqual([...bytes]);
    expect([...fromBase64('QQ==')]).toEqual([0x41]);
    expect(fromBase64('').length).toBe(0);
  });

  it('hands back bytes a Blob can take: a view over an ArrayBuffer of its own', () => {
    const decoded = fromBase64('AQID');
    expect(decoded.buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Blob([decoded]).size).toBe(3);
  });
});
