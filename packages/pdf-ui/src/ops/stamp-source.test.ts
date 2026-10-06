/**
 * Whether an added JPEG is embedded as it is or re-encoded upright: the EXIF orientation read
 * in `stamp-source.ts`. A camera file whose EXIF offsets point past its bytes must not stop
 * the picture from being added; it is re-encoded from what the browser decoded.
 */

import { describe, expect, it } from 'vitest';
import { jpegIsTurned } from './stamp-source';

/** SOI, one APP1 "Exif" segment over a little-endian TIFF header, then SOS. */
function jpegWithExif(options: { orientation?: number; ifdOffset?: number }): Blob {
  const entries = options.orientation === undefined ? [] : [options.orientation];
  const tiff = [0x49, 0x49, 0x2a, 0x00, ...le32(options.ifdOffset ?? 8), ...le16(entries.length)];
  for (const value of entries) tiff.push(...le16(0x0112), ...le16(3), ...le32(1), ...le16(value), 0, 0);
  tiff.push(...le32(0));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  return new Blob([
    new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...be16(app1.length + 2), ...app1, 0xff, 0xda, 0x00, 0x02]),
  ]);
}

const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value: number) => [...le16(value & 0xffff), ...le16((value >>> 16) & 0xffff)];
const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];

describe('jpegIsTurned', () => {
  it('reads the orientation tag: 1 is upright, anything else turns or mirrors', async () => {
    expect(await jpegIsTurned(jpegWithExif({ orientation: 1 }))).toBe(false);
    expect(await jpegIsTurned(jpegWithExif({ orientation: 6 }))).toBe(true);
    expect(await jpegIsTurned(jpegWithExif({}))).toBe(false);
  });

  it('re-encodes, rather than fails, when the EXIF offsets point past the bytes', async () => {
    await expect(jpegIsTurned(jpegWithExif({ orientation: 1, ifdOffset: 0x7fff_0000 }))).resolves.toBe(true);
    await expect(jpegIsTurned(jpegWithExif({ orientation: 1, ifdOffset: 30 }))).resolves.toBe(true);
  });
});
