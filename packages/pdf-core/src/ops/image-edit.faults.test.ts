/**
 * The engine failing under the image operations, and the check that reads the written file back.
 * The real engine writes what it is told to, so these tests wrap it at its seams (the ones
 * `forms.faults.test.ts` and `pdfa-prepare.faults.test.ts` use): a method of the opened document
 * throws, and the bytes `saveRewrite` produces can be swapped for a damaged file. The input, the
 * replacement and the second reader are real.
 */

import { ColorSpace, type PDFDocument, Pixmap, PDFDocument as RealDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  trap?: { readonly method: string; readonly error: Error };
  /** Turns the bytes the write produced into the bytes the check reads. */
  damage?: (produced: Uint8Array) => Uint8Array;
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

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (...args: Parameters<typeof actual.saveRewrite>) => {
      const produced = actual.saveRewrite(...args);
      return state.damage === undefined ? produced : state.damage(produced);
    },
  };
});

const { applyImageEdit, listPdfImages, readImageData } = await import('./image-edit');

const run = { signal: new AbortController().signal };

const png = new Uint8Array(new Pixmap(ColorSpace.DeviceRGB, [0, 0, 2, 1], false).asPNG());

function input(): Uint8Array {
  const doc = new RealDocument();
  const image = doc.addStream(new Uint8Array(6), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 2,
    Height: 1,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
  });
  doc.insertPage(0, doc.addPage([0, 0, 10, 10], 0, { XObject: { A: image } }, ''));
  doc.insertPage(1, doc.addPage([0, 0, 10, 10], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The produced file, opened, changed by `edit` and saved again. */
function altered(edit: (doc: RealDocument) => void): (produced: Uint8Array) => Uint8Array {
  return (produced) => {
    const doc = RealDocument.openDocument(produced.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      edit(doc);
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    } finally {
      doc.destroy();
    }
  };
}

const replacement = { replacements: [{ pageIndex: 0, name: 'A', data: png, format: 'png' as const }] };

afterEach(() => {
  state.trap = undefined;
  state.damage = undefined;
});

describe('an engine failure under the image operations', () => {
  const engineFault = new Error('engine fault');
  const aborted = Object.assign(new Error('stopped'), { name: 'AbortError' });

  it('is reported with the step it happened in', async () => {
    state.trap = { method: 'countPages', error: engineFault };
    await expect(listPdfImages(input(), run)).rejects.toMatchObject({
      details: { engine: 'mupdf', engineMessage: 'read images: engine fault' },
    });
    await expect(readImageData(input(), { pageIndex: 0, name: 'A' }, run)).rejects.toMatchObject({
      details: { engineMessage: 'read image data: engine fault' },
    });
    await expect(applyImageEdit(input(), replacement, run)).rejects.toMatchObject({
      details: { engineMessage: 'edit images: engine fault' },
    });
  });

  it('lets an abort through unchanged', async () => {
    state.trap = { method: 'countPages', error: aborted };
    await expect(listPdfImages(input(), run)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(readImageData(input(), { pageIndex: 0, name: 'A' }, run)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(applyImageEdit(input(), replacement, run)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('the check on the written file', () => {
  const failure = (engineMessage: string | RegExp) => ({
    code: 'verification-failed',
    details: {
      engine: 'mupdf',
      engineMessage: typeof engineMessage === 'string' ? engineMessage : expect.stringMatching(engineMessage),
    },
  });

  it('passes a file that keeps the replaced image where the page names it', async () => {
    const out = await applyImageEdit(input(), replacement, run);
    expect(out.report.steps).toEqual(['load', 'producer', 'save', 'verify']);
  });

  it('refuses a file that does not re-open', async () => {
    state.damage = () => new Uint8Array([1, 2, 3]);
    await expect(applyImageEdit(input(), replacement, run)).rejects.toMatchObject(
      failure(/^produced file does not re-open: /),
    );
  });

  it('refuses a file whose page count moved', async () => {
    state.damage = altered((doc) => doc.deletePage(1));
    await expect(applyImageEdit(input(), replacement, run)).rejects.toMatchObject(
      failure('produced file has 1 pages, expected 2'),
    );
  });

  it('refuses a file whose page no longer names the object', async () => {
    state.damage = altered((doc) => doc.findPage(0).get('Resources').get('XObject').delete('A'));
    await expect(applyImageEdit(input(), replacement, run)).rejects.toMatchObject(
      failure('page 1 no longer names an object called "A"'),
    );
  });

  it('refuses a file whose name now points at another object, or at something that is not an image', async () => {
    state.damage = altered((doc) => {
      const other = doc.addStream(new Uint8Array(6), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
      });
      doc.findPage(0).get('Resources').get('XObject').put('A', other);
    });
    await expect(applyImageEdit(input(), replacement, run)).rejects.toMatchObject(
      failure('the object behind "A" is not the replaced image after the write'),
    );
    state.damage = altered((doc) =>
      doc.findPage(0).get('Resources').get('XObject').get('A').put('Subtype', doc.newName('Form')),
    );
    await expect(applyImageEdit(input(), replacement, run)).rejects.toMatchObject(
      failure('the object behind "A" is not the replaced image after the write'),
    );
  });
});
