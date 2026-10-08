/**
 * The open-font catalog: every file it names is on disk once `pnpm fetch:engines --sync` ran,
 * is a TrueType MuPDF opens, and spells the Turkish letters; and `loadOpenFace` hands the bytes
 * back through a same-origin fetch — or `null` when the face is missing or the network is not there.
 */

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { OPEN_FAMILIES, type OpenFaceStyle, type OpenFamily } from './ocr-font-catalog';

const PUBLIC = new URL('../../../../public', import.meta.url);
const TURKISH = [...'ğĞıİşŞçÇöÖüÜ'];

const diskBytes = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`.${path}`, `${PUBLIC.href}/`)));

const ALL_FACES = OPEN_FAMILIES.flatMap((family) =>
  (Object.entries(family.files) as [OpenFaceStyle, string][]).map(([style, path]) => ({
    family,
    style,
    path,
  })),
);

/** A fresh copy of the loader: it keeps what it fetched for the session, so each test starts empty. */
async function freshLoader(): Promise<typeof import('./ocr-font-catalog').loadOpenFace> {
  vi.resetModules();
  return (await import('./ocr-font-catalog')).loadOpenFace;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('OPEN_FAMILIES', () => {
  it('lists Noto Sans and the nine added families, ten in all, each once', () => {
    expect(OPEN_FAMILIES.map((family) => family.id)).toEqual([
      'noto-sans',
      'roboto',
      'open-sans',
      'montserrat',
      'inter',
      'source-sans-3',
      'poppins',
      'merriweather',
      'noto-serif',
      'roboto-mono',
    ]);
    expect(new Set(OPEN_FAMILIES.map((family) => family.name)).size).toBe(OPEN_FAMILIES.length);
    expect(OPEN_FAMILIES.find((family) => family.id === 'noto-sans')?.name).toBe('Noto Sans');
  });

  it('classifies the families', () => {
    const kind = (id: string) => OPEN_FAMILIES.find((family) => family.id === id)?.kind;
    expect(kind('inter')).toBe('sans');
    expect(kind('merriweather')).toBe('serif');
    expect(kind('noto-serif')).toBe('serif');
    expect(kind('roboto-mono')).toBe('mono');
  });

  it('gives every family the four basic styles and no other', () => {
    for (const family of OPEN_FAMILIES) {
      const { regular, italic, bold, boldItalic, ...others } = family.files;
      expect([regular, italic, bold, boldItalic].every((path) => path?.startsWith('/fonts/'))).toBe(true);
      expect(others).toEqual({});
    }
  });

  it('names no file twice', () => {
    const paths = ALL_FACES.map((face) => face.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('the shipped files', () => {
  it.each(ALL_FACES.map((face) => [`${face.family.id} ${face.style}`, face] as const))(
    '%s is on disk and MuPDF opens it',
    async (_label, { path }) => {
      expect(
        existsSync(new URL(`.${path}`, `${PUBLIC.href}/`)),
        `${path} — run pnpm fetch:engines --sync`,
      ).toBe(true);
      const bytes = diskBytes(path);
      // a TrueType program: sfnt version 0x00010000
      expect([...bytes.subarray(0, 4)]).toEqual([0, 1, 0, 0]);
      const mupdf = await loadMupdf();
      const font = new mupdf.Font(path, bytes);
      expect(font.encodeCharacter('A'.codePointAt(0) ?? 0)).toBeGreaterThan(0);
    },
  );

  it.each(ALL_FACES.map((face) => [`${face.family.id} ${face.style}`, face] as const))(
    '%s spells the Turkish letters',
    async (_label, { path }) => {
      const mupdf = await loadMupdf();
      const font = new mupdf.Font(path, diskBytes(path));
      const missing = TURKISH.filter((letter) => font.encodeCharacter(letter.codePointAt(0) ?? 0) === 0);
      expect(missing).toEqual([]);
    },
  );
});

describe('loadOpenFace', () => {
  /** Serves `public/` the way the origin does: the bytes, or a 404. */
  function serveDisk(): Mock<(url: string) => Promise<Response>> {
    const stub = vi.fn(async (url: string) =>
      existsSync(new URL(`.${url}`, `${PUBLIC.href}/`))
        ? new Response(diskBytes(url).slice())
        : new Response(null, { status: 404 }),
    );
    vi.stubGlobal('fetch', stub);
    return stub;
  }

  it('returns the bytes of the file the catalog names', async () => {
    const loadOpenFace = await freshLoader();
    const stub = serveDisk();
    const roboto = OPEN_FAMILIES.find((family) => family.id === 'roboto');
    if (roboto === undefined) throw new Error('catalog lost Roboto');
    const bytes = await loadOpenFace(roboto, 'boldItalic');
    expect(stub).toHaveBeenCalledWith(roboto.files.boldItalic);
    expect(bytes).toEqual(diskBytes(roboto.files.boldItalic ?? ''));
  });

  it('reads every face of every family', async () => {
    const loadOpenFace = await freshLoader();
    serveDisk();
    for (const { family, style, path } of ALL_FACES) {
      const bytes = await loadOpenFace(family, style);
      expect(bytes?.byteLength, path).toBe(diskBytes(path).byteLength);
    }
  });

  it('keeps what it fetched: the second call is the first call', async () => {
    const loadOpenFace = await freshLoader();
    const stub = serveDisk();
    const inter = OPEN_FAMILIES.find((family) => family.id === 'inter');
    if (inter === undefined) throw new Error('catalog lost Inter');
    const first = loadOpenFace(inter, 'regular');
    expect(loadOpenFace(inter, 'regular')).toBe(first);
    await first;
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('is null for a face the family does not ship, without a request', async () => {
    const loadOpenFace = await freshLoader();
    const stub = serveDisk();
    const regularOnly: OpenFamily = {
      id: 'ghost',
      name: 'Ghost',
      kind: 'sans',
      files: { regular: '/fonts/ghost/Ghost-Regular.ttf' },
    };
    expect(await loadOpenFace(regularOnly, 'italic')).toBeNull();
    expect(await loadOpenFace(regularOnly, 'boldItalic')).toBeNull();
    expect(stub).not.toHaveBeenCalled();
  });

  it('is null when the asset is missing (404), and tries again later', async () => {
    const loadOpenFace = await freshLoader();
    const family: OpenFamily = {
      id: 'ghost',
      name: 'Ghost',
      kind: 'sans',
      files: { regular: '/fonts/ghost/Ghost-Regular.ttf' },
    };
    const stub = serveDisk();
    expect(await loadOpenFace(family, 'regular')).toBeNull();
    expect(await loadOpenFace(family, 'regular')).toBeNull();
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('is null when the network is down, and the next call fetches again', async () => {
    const loadOpenFace = await freshLoader();
    const roboto = OPEN_FAMILIES.find((family) => family.id === 'roboto-mono');
    if (roboto === undefined) throw new Error('catalog lost Roboto Mono');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect(await loadOpenFace(roboto, 'bold')).toBeNull();
    serveDisk();
    const bytes = await loadOpenFace(roboto, 'bold');
    expect(bytes?.byteLength).toBe(diskBytes(roboto.files.bold ?? '').byteLength);
  });
});
