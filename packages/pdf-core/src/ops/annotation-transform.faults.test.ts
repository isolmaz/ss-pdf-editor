/**
 * The annotation transform re-opens what it wrote and compares it with what it predicted. The
 * real engine writes what it is told to, so these tests wrap it at its loading seam (the same
 * seam `structure.faults.test.ts` uses): the document being written is damaged in one chosen way
 * just before it is saved, or one call of the engine fails, and everything else — the bytes that
 * come out, the second reader — is real.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { PDFDocument as BuilderDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Runs on the document being written, just before it is saved. */
  tamper?: (document: PDFDocument) => void;
  /** A method of the document that throws when called. */
  trap?: { readonly method: string; readonly error: unknown };
  /** What the n-th `loadMupdf` call (1-based) rejects with. */
  failLoad: Map<number, unknown>;
  loads: number;
}
const state: Plan = { failLoad: new Map(), loads: 0 };

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      state.loads += 1;
      if (state.failLoad.has(state.loads)) throw state.failLoad.get(state.loads);
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

const { transformPdfAnnotations } = await import('./annotation-transform');

afterEach(() => {
  state.tamper = undefined;
  state.trap = undefined;
  state.failLoad = new Map();
  state.loads = 0;
});

const CONTEXT = { signal: new AbortController().signal };
const TARGET_ID = '7R';
const MOVE = { dx: 10, dy: 0, rotation: 0 } as const;

/**
 * One page: a highlight with an appearance (the target), a square beside it (never a target) and a
 * text field with a value. The objects are added in this order, so the highlight is object 7.
 */
function fixture(): Uint8Array {
  const doc = new BuilderDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 500], 0, {}, '0 g 10 10 20 20 re f'));
  const page = doc.findPage(0);
  page.put('Annots', []);
  const attach = (dict: Record<string, unknown>): PDFObject => {
    const ref = doc.addObject(dict);
    page.get('Annots').push(ref);
    return ref;
  };
  const appearance = doc.addStream('0 1 0 rg 0 0 160 30 re f', {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 160, 30],
    Resources: {},
  });
  const target = attach({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [40, 400, 200, 430],
    QuadPoints: [40, 430, 200, 430, 40, 400, 200, 400],
    Contents: doc.newString('target'),
    AP: { N: appearance },
  });
  attach({ Type: 'Annot', Subtype: 'Square', Rect: [250, 400, 330, 460], Contents: doc.newString('keep') });
  const field = attach({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Tx',
    T: doc.newString('customer'),
    V: doc.newString('Ada'),
    Rect: [40, 20, 220, 40],
  });
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', { Fields: [field] });
  if (`${target.asIndirect()}R` !== TARGET_ID) throw new Error(`the target is ${target.asIndirect()}R`);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Run the transform on the fixture and return what it rejected with. */
async function refusal(): Promise<ToolError> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await transformPdfAnnotations(
      fixture(),
      { targets: [{ pageIndex: 0, id: TARGET_ID }], transform: MOVE },
      CONTEXT,
    );
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the transform was accepted');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

/** The refusal a damaged write must produce: `verification-failed`, with this message. */
async function expectVerificationFailure(message: string | RegExp, pageIndex?: number): Promise<void> {
  const error = await refusal();
  expect(error.code).toBe('verification-failed');
  expect(error.details.engine).toBe('mupdf');
  expect(error.details.engineMessage).toMatch(
    message instanceof RegExp ? message : new RegExp(escapeRegExp(message)),
  );
  expect(error.details.pageIndex).toBe(pageIndex);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const annotation = (doc: PDFDocument, position: number): PDFObject =>
  doc.findPage(0).get('Annots').get(position);

describe('the read-back of a transformed file', () => {
  it('passes a file that is exactly what the call wrote', async () => {
    const outcome = await transformPdfAnnotations(
      fixture(),
      { targets: [{ pageIndex: 0, id: TARGET_ID }], transform: MOVE },
      CONTEXT,
    );
    expect(outcome.transformed).toEqual([TARGET_ID]);
    expect(state.loads).toBe(2);
  });

  it.each([
    ['an Error', new Error('xref is gone'), 'xref is gone'],
    ['a plain value', 'plain text', 'plain text'],
  ])(
    'refuses a produced file that does not re-open, whatever the reader threw (%s)',
    async (_kind, thrown, text) => {
      state.failLoad.set(2, thrown);
      await expectVerificationFailure(`produced file does not re-open: ${text}`);
    },
  );

  it('refuses a produced file with another page count', async () => {
    state.tamper = (doc) => doc.insertPage(-1, doc.addPage([0, 0, 10, 10], 0, {}, ''));
    await expectVerificationFailure('produced file has 2 pages, expected 1');
  });

  it('refuses a page whose box changed', async () => {
    state.tamper = (doc) => doc.findPage(0).put('MediaBox', [0, 0, 300, 300]);
    await expectVerificationFailure('page 1 lost content, a box or its rotation', 0);
  });

  it('refuses a page whose annotation list changed', async () => {
    state.tamper = (doc) => doc.findPage(0).get('Annots').delete(1);
    await expectVerificationFailure(
      /page 1 annotation list changed: \[\d+R, \d+R\] vs \[\d+R, \d+R, \d+R\]/,
      0,
    );
  });

  it('refuses a non-target annotation that changed', async () => {
    state.tamper = (doc) => annotation(doc, 1).put('Rect', [0, 0, 1, 1]);
    await expectVerificationFailure(/annotation \d+R on page 1 changed although it was not a target/, 0);
  });

  it('refuses a form that lost its fields', async () => {
    state.tamper = (doc) => doc.getTrailer().get('Root').get('AcroForm').put('Fields', []);
    await expectVerificationFailure('the form or one of its field values changed');
  });

  it('refuses a target that is no longer a dictionary', async () => {
    state.tamper = (doc) => annotation(doc, 0).writeObject(doc.newInteger(5));
    await expectVerificationFailure(`annotation ${TARGET_ID} is not on page 1 after the transform`, 0);
  });

  it('refuses a target that lost its comment', async () => {
    state.tamper = (doc) => annotation(doc, 0).put('Contents', doc.newString('rewritten'));
    await expectVerificationFailure(`annotation ${TARGET_ID} lost its subtype or its comment`, 0);
  });

  it('refuses a target whose rect is not what was written', async () => {
    state.tamper = (doc) => annotation(doc, 0).put('Rect', [0, 0, 5, 5]);
    await expectVerificationFailure(
      `annotation ${TARGET_ID} does not carry the geometry the transform wrote`,
      0,
    );
  });

  it('refuses a target whose quad points changed length', async () => {
    state.tamper = (doc) => annotation(doc, 0).put('QuadPoints', [1, 2, 3, 4]);
    await expectVerificationFailure(
      `annotation ${TARGET_ID} does not carry the geometry the transform wrote`,
      0,
    );
  });

  it('refuses an appearance whose wrapper lost its resources', async () => {
    state.tamper = (doc) => annotation(doc, 0).get('AP').get('N').delete('Resources');
    await expectVerificationFailure(
      /appearance 0 of annotation 7R does not paint the original stream \(null vs \d+R\)/,
      0,
    );
  });

  it('refuses a target that lost its appearance', async () => {
    state.tamper = (doc) => annotation(doc, 0).delete('AP');
    await expectVerificationFailure(`annotation ${TARGET_ID} has 0 appearance streams, expected 1`, 0);
  });

  it('refuses an appearance that does not paint the original stream', async () => {
    state.tamper = (doc) => {
      const dictionary = annotation(doc, 0);
      const original = dictionary.get('AP').get('N').resolve().get('Resources').get('XObject').get('Fm0');
      dictionary.get('AP').put('N', original);
    };
    await expectVerificationFailure(
      /appearance 0 of annotation 7R does not paint the original stream \(null vs \d+R\)/,
      0,
    );
  });

  it('refuses an appearance that is the shared original itself', async () => {
    state.tamper = (doc) => {
      const dictionary = annotation(doc, 0);
      const original = dictionary.get('AP').get('N').resolve().get('Resources').get('XObject').get('Fm0');
      // The original paints itself, so only the "is the original" rule can tell it from a wrapper.
      original.put('Resources', { XObject: { Fm0: original } });
      dictionary.get('AP').put('N', original);
    };
    await expectVerificationFailure(
      'appearance 0 of annotation 7R is the original stream itself, so a shared appearance would have been rewritten',
      0,
    );
  });

  it("refuses a wrapper whose box is not the new rect's size", async () => {
    state.tamper = (doc) => annotation(doc, 0).get('AP').get('N').put('BBox', [0, 0, 1, 1]);
    await expectVerificationFailure(
      /appearance 0 of annotation 7R has BBox \[0,0,1,1\], expected \[0,0,160,30\]/,
      0,
    );
  });
});

describe('an engine failure during the transform', () => {
  it('is mapped to the error a caller can act on and writes nothing', async () => {
    state.trap = { method: 'addStream', error: new Error('out of memory') };
    const error = await refusal();
    expect(error.details.engine).toBe('mupdf');
    expect(error.details.engineMessage).toContain('annotations.transform: out of memory');
    expect(state.loads).toBe(1);
  });
});
