/**
 * The checks that follow a sanitise exist for an engine that writes or reads back the wrong
 * file; the real engine does not, so these tests wrap it at its loading seam. The bytes are
 * real: an open is either left alone, answered from other real bytes (the file the check should
 * have read) or given a method that fails. Each case proves the wrong answer is refused with the
 * reason named, or the engine's failure reaches the caller as a `ToolError` with its message.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SanitizeOptions } from './sanitize';

type Method = (document: PDFDocument, ...args: unknown[]) => unknown;
type Fault = Partial<Record<string, Method>>;
interface Step {
  /** Open these bytes instead of the ones asked for. */
  readonly bytes?: Uint8Array;
  /** Methods of the opened document that answer differently. */
  readonly fault?: Fault;
}

/** What the operation opens, in order: `undefined` leaves that open untouched. */
const state: { plan: (Step | undefined)[]; opened: number } = { plan: [], opened: 0 };

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrapDocument = (document: PDFDocument, fault: Fault): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            const override = fault[String(property)];
            if (override !== undefined) return (...args: unknown[]) => override(target, ...args);
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return proxy;
      };
      const documents = new Proxy(real.PDFDocument, {
        get(target, property) {
          if (property === 'openDocument') {
            return (...args: Parameters<typeof real.PDFDocument.openDocument>) => {
              const step = state.plan[state.opened];
              state.opened += 1;
              const opened = real.PDFDocument.openDocument(step?.bytes?.slice() ?? args[0], args[1]);
              return step?.fault === undefined ? opened : wrapDocument(opened as PDFDocument, step.fault);
            };
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

const { sanitizeDocument } = await import('./sanitize');
const mupdf = await import('mupdf');

const run = { signal: new AbortController().signal };
const NONE: SanitizeOptions = {
  javascript: false,
  files: false,
  metadata: false,
  privateData: false,
  thumbnails: false,
  links: false,
  comments: false,
  forms: 'keep',
  layers: false,
};
const THUMBS: SanitizeOptions = { ...NONE, thumbnails: true };

beforeEach(() => {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  const font = new Uint8Array(readFileSync(file));
  vi.stubGlobal('fetch', async () => new Response(font));
});

afterEach(() => {
  vi.unstubAllGlobals();
  state.plan = [];
  state.opened = 0;
});

interface Shape {
  readonly pages?: number;
  readonly thumb?: boolean;
  readonly orphan?: boolean;
  readonly square?: string;
  readonly field?: boolean;
  readonly incremental?: boolean;
}

/** A small real document: pages, optionally a thumbnail, an orphan object, a text field, revisions. */
function document(shape: Shape = {}): Uint8Array {
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < (shape.pages ?? 1); index += 1) {
    const page = doc.addPage([0, 0, 300, 400], 0, {}, `${shape.square ?? '1 0 0'} rg 20 20 100 100 re f`);
    doc.insertPage(-1, page);
    if (index === 0 && shape.thumb === true) {
      page.put(
        'Thumb',
        doc.addStream('THUMB', { Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }),
      );
    }
    if (index === 0 && shape.field === true) {
      const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
      const da = doc.newString('/Helv 12 Tf 0 g');
      const field = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('name'),
        V: doc.newString('FIELDVALUE'),
        DA: da,
        Rect: [20, 300, 200, 330],
        P: page,
        F: 4,
      });
      page.put('Annots', [field]);
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [field], DR: { Font: { Helv: font } }, DA: da });
    }
  }
  if (shape.orphan === true) doc.addObject({ Orphan: doc.newString('ORPHAN') });
  let bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  if (shape.incremental === true) {
    const update = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as PDFDocument;
    update.getTrailer().get('Root').put('Lang', update.newString('en'));
    bytes = new Uint8Array(update.saveToBuffer('incremental').asUint8Array());
    update.destroy();
  }
  return bytes;
}

const failure = (engineMessage: string | RegExp) => ({
  code: 'verification-failed',
  details: {
    engine: 'mupdf',
    engineMessage: typeof engineMessage === 'string' ? engineMessage : expect.stringMatching(engineMessage),
  },
});

const boom: Method = () => {
  throw new Error('engine exploded');
};

describe('sanitizeDocument verification', () => {
  // Opens with forms kept: 0 the XFA check, 1 the sweep that removes, 2 the read-back,
  // 3 the picture before, 4 the picture after.
  it('refuses an output with another number of pages', async () => {
    state.plan = [undefined, undefined, { bytes: document({ pages: 2 }) }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject(
      failure('sanitize: page count 1 became 2'),
    );
  });

  it('refuses an output that still has an earlier revision', async () => {
    state.plan = [undefined, undefined, { bytes: document({ incremental: true }) }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject(
      failure('sanitize: 2 revisions remain in the output'),
    );
  });

  it('refuses an output in which a selected category is still found', async () => {
    state.plan = [undefined, undefined, { bytes: document({ thumb: true }) }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject(
      failure('sanitize: 1 thumbnails items remain in the output'),
    );
  });

  it('refuses an output in which an unused object is still found', async () => {
    state.plan = [undefined, undefined, { bytes: document({ orphan: true }) }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject(
      failure('sanitize: 1 unused objects remain in the output'),
    );
  });

  it('refuses an output whose page draws differently from the input', async () => {
    state.plan = [undefined, undefined, undefined, undefined, { bytes: document({ square: '0 0 1' }) }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject(
      failure('sanitize: page 1 renders differently after sanitising'),
    );
  });

  it('returns the result, without the "compared" note, when no page can be drawn', async () => {
    const cannotDraw: Fault = {
      loadPage: () => {
        throw new Error('cannot draw');
      },
    };
    state.plan = [undefined, undefined, undefined, { fault: cannotDraw }, { fault: cannotDraw }];
    const out = await sanitizeDocument(document({ thumb: true }), THUMBS, run);
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).not.toContain('op.note.sanitize.rendered');
    expect(keys).not.toContain('op.note.sanitize.pictureChanges');
    expect(out.counts.find((entry) => entry.category === 'thumbnails')).toEqual({
      category: 'thumbnails',
      found: 1,
      removed: 1,
      left: 0,
    });
    expect(out.report.steps).not.toContain('render');
  });

  it('compares nothing for a page it could draw only in the output', async () => {
    const cannotDraw: Fault = {
      loadPage: () => {
        throw new Error('cannot draw');
      },
    };
    state.plan = [undefined, undefined, undefined, undefined, { fault: cannotDraw }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject(
      failure('sanitize: page 1 renders differently after sanitising'),
    );
  });
});

describe('sanitizeDocument form verification', () => {
  // Forms removed, opens: 0 XFA check, 1 field count, 2 the sweep that removes, 3 the read-back,
  // 4 the fields of the output, 5 the sweep of the input.
  it('refuses an output that still has form fields after a removal', async () => {
    state.plan = [undefined, undefined, undefined, undefined, { bytes: document({ field: true }) }];
    await expect(
      sanitizeDocument(document({ field: true }), { ...NONE, forms: 'remove' }, run),
    ).rejects.toMatchObject(failure('sanitize: 1 form fields remain'));
  });

  // Forms flattened, opens: 0 XFA check, 1 the XFA drop, 2 field list, 3 the flatten, 4 the sweep that
  // removes, 5 the read-back, 6 the fields of the output.
  it('refuses an output with a field that was not flattened', async () => {
    state.plan = [
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { bytes: document({ field: true }) },
    ];
    await expect(
      sanitizeDocument(document({ field: true }), { ...NONE, forms: 'flatten' }, run),
    ).rejects.toMatchObject(failure('sanitize: 1 fields were not flattened'));
  });
});

describe('sanitizeDocument engine failures', () => {
  it('reports a failure of the sweep that removes, as the engine said it', async () => {
    state.plan = [undefined, { fault: { countPages: boom } }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: expect.stringContaining('sanitize: engine exploded') },
    });
  });

  it('reports a failure of the read-back, and one of the sweep of the input', async () => {
    state.plan = [undefined, undefined, { fault: { countPages: boom } }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: expect.stringContaining('sanitize verify: engine exploded') },
    });
    // Forms removed: the input is swept last (open 5), to report what it held.
    state.opened = 0;
    state.plan = [undefined, undefined, undefined, undefined, undefined, { fault: { countPages: boom } }];
    await expect(
      sanitizeDocument(document({ field: true }), { ...NONE, forms: 'remove' }, run),
    ).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: expect.stringContaining('sanitize input: engine exploded') },
    });
  });

  it('lets an abort and a ToolError of the engine through unchanged, in each of the three sweeps', async () => {
    const aborted = Object.assign(new Error('stopped'), { name: 'AbortError' });
    const refused = new ToolError('wrong-password', { engine: 'mupdf' });
    for (const failure of [aborted, refused]) {
      const raise: Method = () => {
        throw failure;
      };
      for (const [plan, options, shape] of [
        [[undefined, { fault: { countPages: raise } }], THUMBS, { thumb: true }],
        [[undefined, undefined, { fault: { countPages: raise } }], THUMBS, { thumb: true }],
        [
          [undefined, undefined, undefined, undefined, undefined, { fault: { countPages: raise } }],
          { ...NONE, forms: 'remove' } satisfies SanitizeOptions,
          { field: true },
        ],
      ] as const) {
        state.opened = 0;
        state.plan = [...plan];
        await expect(sanitizeDocument(document(shape), options, run)).rejects.toBe(failure);
      }
    }
  });

  it('reports a failure of the XFA check and of the XFA drop, as the engine said it', async () => {
    state.plan = [{ fault: { getTrailer: boom } }];
    await expect(sanitizeDocument(document({ thumb: true }), THUMBS, run)).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: expect.stringContaining('sanitize.xfa: engine exploded') },
    });
    state.opened = 0;
    state.plan = [undefined, { fault: { getTrailer: boom } }];
    await expect(
      sanitizeDocument(document({ field: true }), { ...NONE, forms: 'flatten' }, run),
    ).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: expect.stringContaining('sanitize.xfa: engine exploded') },
    });
  });

  it('reports an unreadable object the sweep met, in the note with its count', async () => {
    const source = document({ thumb: true });
    // Open 1 is the sweep that removes: object 1 cannot be read there.
    state.plan = [
      undefined,
      {
        fault: {
          newIndirect: (target, ...args) => {
            const number = (args as [number])[0];
            if (number === 1) throw new Error('cannot read object');
            return target.newIndirect(number);
          },
        },
      },
    ];
    const out = await sanitizeDocument(source, THUMBS, run);
    const warning = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.unreadable');
    // One object is unreadable; the walk and the reachability pass both meet it, and it is counted once.
    expect(warning?.params).toEqual({ count: 1 });
  });
});
