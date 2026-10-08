/**
 * What the form writers do when the engine or the asset behind them fails. The real engine
 * writes what it is told to and a real document always has a catalog, so these tests wrap it
 * at its loading seam (the one `structure.faults.test.ts` uses): the trailer of the opened
 * document loses its `/Root`, or the font asset's fetch fails; everything else — the bytes that
 * come out, the second reader — is real.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFDocument } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** The opened document's trailer answers `/Root` with nothing. */
  rootless: boolean;
}
const state: Plan = { rootless: false };

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrapDocument = (document: PDFDocument): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            if (property === 'getTrailer' && state.rootless) {
              return () => {
                const trailer = target.getTrailer();
                return new Proxy(trailer, {
                  get(inner, key) {
                    if (key === 'get')
                      return (name: string) => inner.get(name === 'Root' ? 'NoSuchKey' : name);
                    const value: unknown = Reflect.get(inner, key, inner);
                    return typeof value === 'function' ? value.bind(inner) : value;
                  },
                });
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return proxy;
      };
      const documents = new Proxy(real.PDFDocument, {
        get(target, property) {
          if (property === 'openDocument') {
            return (...args: Parameters<typeof real.PDFDocument.openDocument>) =>
              wrapDocument(real.PDFDocument.openDocument(...args) as PDFDocument);
          }
          return Reflect.get(target, property, target);
        },
      });
      return new Proxy(real, {
        get(target, property) {
          return property === 'PDFDocument' ? documents : Reflect.get(target, property, target);
        },
      });
    },
  };
});

const { applyCalculations, createFormFields, fillFormFields, readFormFields } = await import('./forms');
const { formPdf, widgetBody } = await import('./forms.fixtures');

const run = { signal: new AbortController().signal };
const abortError = (): Error => Object.assign(new Error('stopped'), { name: 'AbortError' });

const form = () =>
  formPdf({
    fields: '[10 0 R 11 0 R]',
    annots: '[10 0 R 11 0 R]',
    extra: {
      10: widgetBody('10 500 110 520', '/FT/Tx/T(a)/V(2)'),
      11: widgetBody('10 470 110 490', '/FT/Tx/T(total)'),
    },
  });

beforeEach(() => {
  state.rootless = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the font asset fails while a value is being written', () => {
  it('keeps the typed value and warns that the drawn form is stale when the font cannot be fetched', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    const out = await fillFormFields(form(), [{ name: 'a', value: 'kept' }], run);
    expect(out.report.notes).toContainEqual({
      kind: 'warning',
      key: 'form.note.appearance',
      params: undefined,
    });
    expect((await readFormFields(out.bytes)).find((field) => field.name === 'a')?.value).toBe('kept');
  });

  it('propagates an abort that arrives while the font is fetched, for a fill and for a calculation', async () => {
    vi.stubGlobal('fetch', async () => {
      throw abortError();
    });
    await expect(fillFormFields(form(), [{ name: 'a', value: 'x' }], run)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      applyCalculations(form(), [{ target: 'total', expression: 'a * 2' }], run),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('keeps the calculated value when the font cannot be fetched', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    const out = await applyCalculations(form(), [{ target: 'total', expression: 'a * 2' }], run);
    expect(out.results).toEqual({ total: '4' });
    expect((await readFormFields(out.bytes)).find((field) => field.name === 'total')?.value).toBe('4');
  });
});

describe('a document whose trailer has no /Root', () => {
  it('lists no fields and refuses to create one', async () => {
    state.rootless = true;
    expect(await readFormFields(form())).toEqual([]);
    const font = new Uint8Array(
      readFileSync(
        createRequire(import.meta.url).resolve(
          '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
          {
            paths: [process.cwd()],
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', async () => new Response(font));
    await expect(
      createFormFields(form(), [{ kind: 'text', name: 'n', pageIndex: 0, rect: [0, 0, 10, 10] }], run),
    ).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engine: 'mupdf', engineMessage: 'no /Root' },
    });
  });
});
