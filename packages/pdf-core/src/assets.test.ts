/**
 * Engine URLs name the version of the engine they serve.
 *
 * `/engines/**` is cached as immutable for a year, so the only thing that makes a browser
 * fetch a rebuilt engine is a different URL. These tests hold the version in the URLs to
 * the pins it is derived from, the way a deploy would meet it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { engineVersions } from '../../../tools/fetch-engines.mjs';
import type * as Assets from './assets';
import recorded from './engine-versions.json';

// The unit setup swaps some URLs for installed-package paths; the ones that ship are under test.
const assets = await vi.importActual<typeof Assets>('./assets');

interface Pins {
  engines: Record<string, { files: { path: string; sha256: string; bytes: number }[] }>;
}
const pins = JSON.parse(readFileSync('tools/asset-pins.json', 'utf8')) as Pins;

describe('engine-versions.json', () => {
  it('records the version the pins give each engine the build serves', () => {
    expect(recorded.versions).toEqual(engineVersions(pins));
    expect(Object.keys(recorded.versions)).toEqual(['ghostscript', 'mupdf', 'pdfjs', 'tesseract']);
    for (const version of Object.values(recorded.versions)) expect(version).toMatch(/^v[0-9a-f]{12}$/);
  });

  it("changes an engine's version when one of its pinned bytes changes, and no other engine's", () => {
    const before = engineVersions(pins);
    const changed = structuredClone(pins);
    const file = changed.engines.mupdf?.files[0];
    if (file === undefined) throw new Error('the pins have no mupdf file');
    file.sha256 = `${file.sha256.slice(0, -1)}${file.sha256.endsWith('0') ? '1' : '0'}`;
    const after = engineVersions(changed);
    expect(after.mupdf).not.toBe(before.mupdf);
    expect({ ...after, mupdf: before.mupdf }).toEqual(before);
  });

  it("changes an engine's version when a file is added to it, and not when the pins are reordered", () => {
    const before = engineVersions(pins);
    const added = structuredClone(pins);
    added.engines.pdfjs?.files.push({ path: 'engines/pdfjs/extra.mjs', sha256: 'ab'.repeat(32), bytes: 1 });
    expect(engineVersions(added).pdfjs).not.toBe(before.pdfjs);
    const reordered = structuredClone(pins);
    for (const engine of Object.values(reordered.engines)) engine.files.reverse();
    expect(engineVersions(reordered)).toEqual(before);
  });

  it('gives no version to a font family, which is not served from /engines/', () => {
    expect(Object.keys(engineVersions(pins))).not.toContain('noto');
  });
});

describe('the asset URLs', () => {
  const versions = engineVersions(pins);
  const inDirectory = (engine: string, url: string) =>
    expect(url.startsWith(`/engines/${engine}/${versions[engine]}/`), url).toBe(true);

  it('put every engine file in the version directory of its engine', () => {
    for (const url of Object.values(assets.PDFJS_ASSETS)) inDirectory('pdfjs', url);
    for (const url of Object.values(assets.MUPDF_ASSETS)) inDirectory('mupdf', url);
    for (const url of Object.values(assets.GHOSTSCRIPT_ASSETS)) inDirectory('ghostscript', url);
    for (const url of Object.values(assets.TESSERACT_ASSETS)) inDirectory('tesseract', url);
    expect(assets.MUPDF_ASSETS.js).toBe(`/engines/mupdf/${versions.mupdf}/mupdf.js`);
    expect(assets.PDFJS_ASSETS.cmaps).toBe(`/engines/pdfjs/${versions.pdfjs}/cmaps/`);
    expect(assets.TESSERACT_ASSETS.fastLangPath).toBe(`/engines/tesseract/${versions.tesseract}/lang/fast`);
  });

  it('leave the fonts at their own paths: they are revalidated, not immutable, and carry no version', () => {
    expect(assets.NOTO_ASSETS.regular).toBe('/fonts/noto/NotoSans-Regular.ttf');
    expect(assets.NOTO_ASSETS.semiBold).toBe('/fonts/noto/NotoSans-SemiBold.ttf');
  });

  it('keep the files an engine resolves for itself next to the module it loads them with', () => {
    // mupdf.js imports ./mupdf-wasm.js, which fetches mupdf-wasm.wasm beside it: a query on
    // `js` would not reach either, a directory does.
    const base = `https://editor.test${assets.MUPDF_ASSETS.js}`;
    expect(new URL('mupdf-wasm.js', base).pathname).toBe(`/engines/mupdf/${versions.mupdf}/mupdf-wasm.js`);
    expect(new URL('mupdf-wasm.wasm', base).pathname).toBe(
      `/engines/mupdf/${versions.mupdf}/mupdf-wasm.wasm`,
    );
  });
});

describe('servedEnginePath', () => {
  it('moves a logical /engines/<engine>/<file> path into its version directory', () => {
    expect(assets.servedEnginePath('/engines/pdfjs/pdf.worker.mjs')).toBe(assets.PDFJS_ASSETS.worker);
    expect(assets.servedEnginePath('/engines/mupdf/mupdf.js')).toBe(assets.MUPDF_ASSETS.js);
    expect(assets.servedEnginePath('/engines/tesseract/lang/fast/tur.traineddata.gz')).toBe(
      `${assets.TESSERACT_ASSETS.fastLangPath}/tur.traineddata.gz`,
    );
  });

  it('leaves every other path alone', () => {
    for (const path of ['/editor/', '/fonts/noto/NotoSans-Regular.ttf', '/theme-boot.js']) {
      expect(assets.servedEnginePath(path)).toBe(path);
    }
  });

  it('refuses an engine the pins do not serve, instead of listing a URL nothing can fetch', () => {
    expect(() => assets.servedEnginePath('/engines/nowhere/x.js')).toThrow(/"nowhere" is not an engine/);
  });
});
