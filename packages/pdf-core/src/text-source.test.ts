/**
 * Font metric tables for the text engine (`text-source.ts > readFontMetrics`), read with
 * the engine that embeds the same bytes (MuPDF) plus the font header.
 *
 * The expected numbers are what `@pdf-lib/fontkit` 1.1.1 — the parser these tables came
 * from before — reported for the same files (measured 2026-10-04, before it was
 * removed): an independent reader, so a change in how advances are scaled or rounded,
 * or in which header table the vertical metrics come from, shows up here as a number.
 * The wrong answers that matter: an advance in em instead of font units, a rounding that
 * moves one glyph by a unit (and with it every line break after it), a covered Turkish
 * letter reported missing, and an unreadable programme let through as an empty table.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { readFontMetrics } from './text-source';

function noto(file: string): Uint8Array {
  const require = createRequire(import.meta.url);
  return new Uint8Array(
    readFileSync(require.resolve(`@expo-google-fonts/noto-sans/${file}`, { paths: [process.cwd()] })),
  );
}

const advances = (metrics: Awaited<ReturnType<typeof readFontMetrics>>, text: string) =>
  Object.fromEntries(
    [...text].map((character) => [character, metrics.glyphAdvance(character.codePointAt(0) ?? 0)]),
  );

describe('readFontMetrics', () => {
  it('reads Noto Sans Regular as fontkit did: header, advances in font units, coverage', async () => {
    const metrics = await readFontMetrics(noto('400Regular/NotoSans_400Regular.ttf'), 'noto-regular');
    expect([metrics.unitsPerEm, metrics.ascender, metrics.descender, metrics.lineGap]).toEqual([
      1000, 1069, -293, 0,
    ]);
    expect(advances(metrics, 'AW şİğıÖ€')).toEqual({
      A: 639,
      W: 930,
      ' ': 260,
      ş: 479,
      İ: 339,
      ğ: 615,
      ı: 258,
      Ö: 781,
      '€': 572,
    });
    for (const character of 'şŞğĞıİöÖüÜçÇ')
      expect(metrics.hasGlyph(character.codePointAt(0) ?? 0)).toBe(true);
    // A code point the face does not cover: no glyph, and the `.notdef` advance.
    expect(metrics.hasGlyph(0x4e00)).toBe(false);
    expect(metrics.glyphAdvance(0x10ffff)).toBe(600);
    expect(metrics.missing).toEqual([]);
  });

  it('reads Noto Sans SemiBold as fontkit did', async () => {
    const metrics = await readFontMetrics(noto('600SemiBold/NotoSans_600SemiBold.ttf'), 'noto-semibold');
    expect([metrics.unitsPerEm, metrics.ascender, metrics.descender, metrics.lineGap]).toEqual([
      1000, 1069, -293, 0,
    ]);
    expect(advances(metrics, 'AW şİğıÖ€')).toEqual({
      A: 672,
      W: 953,
      ' ': 260,
      ş: 493,
      İ: 370,
      ğ: 626,
      ı: 283,
      Ö: 787,
      '€': 572,
    });
    expect(metrics.glyphAdvance(0x10ffff)).toBe(593);
  });

  it('refuses bytes that are not a font programme instead of returning an empty table', async () => {
    const notAFont = new TextEncoder().encode('%PDF-1.7 this is not a font programme at all');
    await expect(readFontMetrics(notAFont, 'broken.ttf')).rejects.toMatchObject({ code: 'unsupported' });
  });
});
