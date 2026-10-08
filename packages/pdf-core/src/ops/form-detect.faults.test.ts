/**
 * `createDetectedFields` reads what it wrote back and refuses to hand over a file whose fields are
 * not where, what and as many as the review asked for; both operations map an engine failure to the
 * error a caller can act on. The real engine writes what it is told to, so these tests wrap it at
 * its loading seam (as `accessibility.faults.test.ts` does): the document being saved is damaged in
 * one chosen way just before the save, or one call of the engine fails, and everything else is real.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFDocument, PDFObject } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Runs on the document being written, just before it is saved. */
  tamper?: (document: PDFDocument) => void;
  /** A method of the document that throws when called. */
  trap?: { readonly method: string; readonly error: unknown };
}
const state: Plan = {};

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
            if (property === state.trap?.method) {
              return () => {
                throw state.trap?.error;
              };
            }
            if (property === 'setMetaData') {
              return (...args: Parameters<PDFDocument['setMetaData']>) => {
                state.tamper?.(target);
                return target.setMetaData(...args);
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

const { createDetectedFields, detectFormFields } = await import('./form-detect');
const mupdf = await import('mupdf');

import type { FieldCandidate } from './form-detect';

beforeEach(() => {
  // The widgets' appearances are drawn with the embedded Noto Sans the shell serves.
  const file = createRequire(import.meta.url).resolve(
    '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
    { paths: [process.cwd()] },
  );
  const font = new Uint8Array(readFileSync(file));
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.tamper = undefined;
  state.trap = undefined;
});

const run = { signal: new AbortController().signal };

function blankPage(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const candidate = (extra: Partial<FieldCandidate> & Pick<FieldCandidate, 'id' | 'name'>): FieldCandidate => ({
  kind: 'text',
  pageIndex: 0,
  rect: [100, 100, 200, 120],
  label: extra.name,
  confidence: 'high',
  source: 'line',
  size: 10,
  ...extra,
});

/** Two text fields and a radio group of two. */
const REVIEWED: readonly FieldCandidate[] = [
  candidate({ id: '1', name: 'A' }),
  candidate({ id: '2', name: 'B', rect: [100, 140, 200, 160] }),
  candidate({
    id: '3',
    name: 'Status',
    kind: 'radio',
    group: 'g',
    option: 'Yes',
    rect: [100, 200, 110, 210],
  }),
  candidate({ id: '4', name: 'Status', kind: 'radio', group: 'g', option: 'No', rect: [100, 220, 110, 230] }),
];

const refused = (engineMessage: string) => ({
  code: 'verification-failed',
  details: { engine: 'mupdf', engineMessage },
});

const fieldsOf = (doc: PDFDocument): PDFObject => doc.getTrailer().get('Root').get('AcroForm').get('Fields');

describe('createDetectedFields read-back', () => {
  it('refuses a file that lost a field', async () => {
    state.tamper = (doc) => fieldsOf(doc).delete(0);
    await expect(createDetectedFields(blankPage(), REVIEWED, run)).rejects.toMatchObject(
      refused('2 fields after, 0 + 3 expected; A: missing'),
    );
  });

  it('refuses a field that reads back as another kind', async () => {
    state.tamper = (doc) => fieldsOf(doc).get(0).put('FT', doc.newName('Btn'));
    await expect(createDetectedFields(blankPage(), REVIEWED, run)).rejects.toMatchObject(
      refused('A: checkbox, expected text'),
    );
  });

  it('refuses a radio group that lost a button', async () => {
    state.tamper = (doc) => fieldsOf(doc).get(2).get('Kids').delete(1);
    await expect(createDetectedFields(blankPage(), REVIEWED, run)).rejects.toMatchObject(
      refused('Status: 1 widgets, expected 2'),
    );
  });

  it('refuses a widget that is not where it was placed', async () => {
    state.tamper = (doc) =>
      fieldsOf(doc)
        .get(1)
        .put('Rect', [100, 700, 200, 720] as never);
    await expect(createDetectedFields(blankPage(), REVIEWED, run)).rejects.toMatchObject(
      refused('B: widget 1 is not where it was placed'),
    );
  });
});

describe('engine failures', () => {
  it('maps a failure of the engine while the pages are read, in detection and in creation', async () => {
    state.trap = { method: 'loadPage', error: new Error('out of memory') };
    await expect(detectFormFields(blankPage(), run)).rejects.toMatchObject({
      code: 'out-of-memory',
      details: { engineMessage: 'form.detect: out of memory' },
    });
    await expect(createDetectedFields(blankPage(), REVIEWED, run)).rejects.toMatchObject({
      code: 'out-of-memory',
      details: { engineMessage: 'form.detect: out of memory' },
    });
  });
});
