/**
 * The paths of the text source that a healthy document never reaches, driven through the
 * engines' own loading seams: pdf.js answers the colour question wrongly or not at all
 * (an unopenable document, an operator list with colour shapes it never produces today, a
 * build whose operator enum lost a name), and MuPDF fails on a page. The page bytes are
 * real; only the engine answer is chosen. Each case proves the documented outcome — the
 * black fallback for a colour that cannot be read, a cancellation that is never turned into
 * a fallback, an engine failure that leaves as a `ToolError` — instead of a crash or a
 * silently wrong colour.
 */

import type { PDFDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageOperatorList, PdfDocumentHandle, PdfOpenOptions } from './engines/pdfjs-handle';

type OpenWithPdfjs = (bytes: Uint8Array, options?: PdfOpenOptions) => Promise<PdfDocumentHandle>;
type DocumentFault = Partial<Record<'loadPage' | 'findPage', (...args: unknown[]) => unknown>>;

const state: {
  open: OpenWithPdfjs | null;
  /** `undefined`: the real enum; `null`: a build without the enum; otherwise the names to drop. */
  dropOps: null | readonly string[] | undefined;
  document: DocumentFault | undefined;
} = { open: null, dropOps: undefined, document: undefined };

vi.mock('./engines/pdfjs-handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engines/pdfjs-handle')>();
  return {
    ...actual,
    openWithPdfjs: (bytes: Uint8Array, options?: PdfOpenOptions) =>
      (state.open ?? actual.openWithPdfjs)(bytes, options),
  };
});

vi.mock('pdfjs-dist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdfjs-dist')>();
  const module = { ...actual };
  Object.defineProperty(module, 'OPS', {
    enumerable: true,
    get: () => {
      if (state.dropOps === undefined) return actual.OPS;
      if (state.dropOps === null) return undefined;
      return Object.fromEntries(
        Object.entries(actual.OPS).filter(([name]) => !state.dropOps?.includes(name)),
      );
    },
  });
  return module;
});

vi.mock('./engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrap = (document: PDFDocument): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            const override = state.document?.[property as keyof DocumentFault];
            if (override !== undefined) return override;
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
              wrap(real.PDFDocument.openDocument(...args) as PDFDocument);
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

const { loadMupdf } = await import('./engines/mupdf');
const { openWithPdfjs } =
  await vi.importActual<typeof import('./engines/pdfjs-handle')>('./engines/pdfjs-handle');
const { OPS } = await vi.importActual<typeof import('pdfjs-dist')>('pdfjs-dist');
const { readPageText } = await import('./text-source');

const run = { signal: new AbortController().signal };

afterEach(() => {
  state.open = null;
  state.dropOps = undefined;
  state.document = undefined;
});

/** One page: a block of text drawn red, and a block of blue whitespace that MuPDF cannot colour. */
async function bytesWithUncolouredBlock(): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const helvetica = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  const content = [
    '1 0 0 rg BT /F 12 Tf 10 180 Td (Word) Tj ET',
    '0 0 1 rg BT /F 12 Tf 10 100 Td (   ) Tj ET',
  ].join('\n');
  doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, { Font: { F: helvetica } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** pdf.js opens the real document, but its operator list is the given one. */
function withOperatorList(list: PageOperatorList, destroyed?: () => void): OpenWithPdfjs {
  return async (bytes, options) => {
    const handle = await openWithPdfjs(bytes, options);
    return {
      ...handle,
      operatorList: async () => list,
      destroy: async () => {
        destroyed?.();
        await handle.destroy();
      },
    };
  };
}

/** The colours of the page when pdf.js reports `ops` with `args`: the spaces block is index 1. */
async function colorsFor(
  ops: readonly number[],
  args: readonly unknown[][],
): Promise<Record<number, string>> {
  state.open = withOperatorList({ fnArray: [...ops], argsArray: args.map((entry) => [...entry]) });
  return { ...(await readPageText(await bytesWithUncolouredBlock(), 0, run)).colors };
}

describe('the pdf.js colour pass', () => {
  it.each<[string, unknown[], string]>([
    ['a hex string, lower-cased', ['#AbCdEf'], '#abcdef'],
    ['grey components', [0.5], '#808080'],
    ['RGB components', [1, 0, 0], '#ff0000'],
    ['components as the first entry', [[0, 1, 0]], '#00ff00'],
    ['CMYK components converted without a profile', [0, 0, 1, 0.5], '#808000'],
    ['out-of-range components clamped per channel', [2, -1, 0.5], '#ff0080'],
  ])('reads %s as the fill colour', async (_name, fill, expected) => {
    const colors = await colorsFor([OPS.setFillRGBColor, OPS.showText], [fill, []]);
    expect(colors).toEqual({ 0: '#ff0000', 1: expected });
  });

  it.each<[string, unknown[]]>([
    ['a string that is not a hex colour (a pattern name)', ['P1']],
    ['a short hex string', ['#12']],
    ['two components', [1, 0]],
    ['five components', [1, 0, 0, 0, 0]],
    ['a component that is not a number', [1, 'x', 0]],
    ['no arguments', []],
  ])('keeps the colour in force when a fill carries %s', async (_name, fill) => {
    const colors = await colorsFor([OPS.setFillRGBColor, OPS.showText], [fill, []]);
    expect(colors[1]).toBe('#000000');
  });

  it('keeps the colour in force when a fill operator has no argument entry at all', async () => {
    const colors = await colorsFor([OPS.setFillRGBColor, OPS.showText], []);
    expect(colors[1]).toBe('#000000');
  });

  it('counts only text operators, under the colour in force, and prefers the colour with more of them', async () => {
    const colors = await colorsFor(
      [
        OPS.save,
        OPS.setFillRGBColor,
        OPS.showText,
        OPS.setFillRGBColor,
        OPS.showSpacedText,
        OPS.nextLineShowText,
        OPS.restore,
      ],
      [[], ['#ff0000'], [], ['#0000ff'], [], [], []],
    );
    expect(colors[1]).toBe('#0000ff');
  });

  it('keeps the first colour when two colours ran under equally many text operators', async () => {
    const colors = await colorsFor(
      [OPS.setFillRGBColor, OPS.showText, OPS.setFillRGBColor, OPS.showText],
      [['#00ff00'], [], ['#0000ff'], []],
    );
    expect(colors[1]).toBe('#00ff00');
  });

  it('reports no colour for a page whose operator list shows no text, leaving the blocks to black', async () => {
    expect(await colorsFor([OPS.setFillRGBColor], [['#00ff00']])).toEqual({ 0: '#ff0000' });
  });

  it('reports no page colour when the operator enum lacks the build', async () => {
    state.dropOps = null;
    const page = await readPageText(await bytesWithUncolouredBlock(), 0, run);
    expect(page.colors).toEqual({ 0: '#ff0000' });
  });

  it('never matches an operator name the build dropped: fills are ignored, text still counts as black', async () => {
    state.dropOps = ['setFillRGBColor'];
    const page = await readPageText(await bytesWithUncolouredBlock(), 0, run);
    expect(page.colors).toEqual({ 0: '#ff0000', 1: '#000000' });
  });

  it('falls back to no colour, and releases the handle, when pdf.js cannot read the operator list', async () => {
    let destroyed = 0;
    const open = withOperatorList({ fnArray: [], argsArray: [] }, () => {
      destroyed += 1;
    });
    state.open = async (bytes, options) => {
      const handle = await open(bytes, options);
      return {
        ...handle,
        operatorList: async () => {
          throw new Error('operator list failed');
        },
      };
    };
    const page = await readPageText(await bytesWithUncolouredBlock(), 0, run);
    expect(page.colors).toEqual({ 0: '#ff0000' });
    expect(destroyed).toBe(1);
  });

  it('falls back to no colour when pdf.js cannot open the document', async () => {
    state.open = async () => {
      throw new Error('pdf.js is not available');
    };
    const page = await readPageText(await bytesWithUncolouredBlock(), 0, run);
    expect(page.colors).toEqual({ 0: '#ff0000' });
    expect(page.blocks).toHaveLength(2);
  });

  it('rethrows a cancellation that arrives while pdf.js is opening instead of falling back', async () => {
    const controller = new AbortController();
    const failure = new Error('pdf.js open interrupted');
    state.open = async () => {
      controller.abort();
      throw failure;
    };
    await expect(
      readPageText(await bytesWithUncolouredBlock(), 0, { signal: controller.signal }),
    ).rejects.toBe(failure);
  });

  it('rethrows an AbortError from pdf.js even when the caller never cancelled', async () => {
    const failure = new Error('worker aborted');
    failure.name = 'AbortError';
    state.open = async () => {
      throw failure;
    };
    await expect(readPageText(await bytesWithUncolouredBlock(), 0, run)).rejects.toBe(failure);
  });
});

describe('MuPDF failures on a page', () => {
  it('maps an engine failure while loading the page to a ToolError carrying the cause', async () => {
    const cause = new Error('damaged page tree');
    state.document = {
      loadPage: () => {
        throw cause;
      },
    };
    const failure = await readPageText(await bytesWithUncolouredBlock(), 0, run).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      details: { engine: 'mupdf', engineMessage: 'readPageText: damaged page tree' },
    });
    expect((failure as ToolError).cause).toBe(cause);
  });

  it('lets an AbortError from the page read leave unchanged, not as an engine fault', async () => {
    const abort = new Error('aborted inside the engine');
    abort.name = 'AbortError';
    state.document = {
      loadPage: () => {
        throw abort;
      },
    };
    await expect(readPageText(await bytesWithUncolouredBlock(), 0, run)).rejects.toBe(abort);
  });

  it('maps an engine failure while locating the page object to a ToolError', async () => {
    state.document = {
      findPage: () => {
        throw new Error('page object is not a dictionary');
      },
    };
    const failure = await readPageText(await bytesWithUncolouredBlock(), 0, run).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      details: { engine: 'mupdf', engineMessage: 'readPageText: page object is not a dictionary' },
    });
  });
});
