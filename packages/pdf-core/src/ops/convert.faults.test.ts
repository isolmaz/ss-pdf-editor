/**
 * The engine answering outside what a document can make it answer: a destination that is not a
 * number, an outline entry with no target or no text, a layout with no pages, and a written file
 * whose page count is not the laid-out one. The real engine does none of this for a real file, so
 * the tests wrap it at its seams (the loading seam of `forms.faults.test.ts` and the writer seam of
 * `layer-write.faults.test.ts`): what a source document reports can be replaced, and the bytes
 * `saveRewrite` produces can be swapped. The input, the layout and the writer are real.
 */

import type { Document as MupdfDocument } from 'mupdf';
import { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** What `resolveLinkDestination` answers for every link and entry. */
  destination?: { readonly x: number; readonly y: number };
  /** Outline entries the source reports instead of its own. */
  outline?: readonly { readonly title?: string; readonly uri?: string; readonly down?: unknown }[];
  /** What `resolveLink` answers for an outline entry's uri. */
  entryPage?: number;
  pageCount?: number;
  damaged?: Uint8Array;
}
const state: Plan = {};

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: async () => {
      const real = await import('mupdf');
      const wrap = (document: MupdfDocument): MupdfDocument => {
        const proxy: MupdfDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'resolveLinkDestination' && state.destination !== undefined) {
              return () => ({ chapter: 0, page: 0, type: 'XYZ', ...state.destination });
            }
            if (property === 'resolveLink' && state.entryPage !== undefined) {
              return (link: unknown) =>
                typeof link === 'string' ? state.entryPage : target.resolveLink(link as never);
            }
            if (property === 'loadOutline' && state.outline !== undefined) return () => state.outline;
            if (property === 'countPages' && state.pageCount !== undefined) return () => state.pageCount;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return proxy;
      };
      const documents = new Proxy(real.Document, {
        get(target, property) {
          if (property === 'openDocument') {
            return (...args: Parameters<typeof real.Document.openDocument>) =>
              wrap(real.Document.openDocument(...args));
          }
          return Reflect.get(target, property, target);
        },
      });
      return new Proxy(real, {
        get(target, property) {
          return property === 'Document' ? documents : Reflect.get(target, property, target);
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
      return state.damaged ?? produced;
    },
  };
});

const { convertToPdf } = await import('./convert');

const run = { signal: new AbortController().signal };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const html = (body: string) => encode(`<!doctype html><html><body>${body}</body></html>`);
const request = (bytes: Uint8Array, name = 'a.html') => ({
  name,
  bytes,
  pageSize: 'a4' as const,
  orientation: 'portrait' as const,
  marginMm: 15,
});

/** The outline and links of a produced file, read with the real engine. */
function readBack(bytes: Uint8Array) {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return {
      outline: (doc.loadOutline() ?? []).map((item) => ({
        title: item.title,
        hasTarget: item.uri !== undefined || item.page !== undefined,
        children: item.down?.length ?? 0,
      })),
      links: doc
        .loadPage(0)
        .getLinks()
        .map((link) => doc.resolveLink(link)),
    };
  } finally {
    doc.destroy();
  }
}

afterEach(() => {
  for (const key of Object.keys(state)) delete state[key as keyof Plan];
});

describe('a destination that is not a number', () => {
  it('is written as a link to the page without a position', async () => {
    state.destination = { x: Number.NaN, y: Number.NaN };
    const out = await convertToPdf(request(html('<p><a href="#t">go</a></p><p id="t">Target</p>')), run);
    expect(readBack(out.bytes).links).toEqual([0]);
    expect(out.report.steps).toContain('convert.links');
  });
});

describe('an outline the engine reports', () => {
  it('keeps an entry with no target, titles one with no text as a dash, and drops no child', async () => {
    state.entryPage = 0;
    state.destination = { x: Number.NaN, y: 10 };
    state.outline = [
      { title: '   ' },
      { uri: 'chapter', down: [{ title: 'Child', uri: 'child' }] },
      { title: 'Elsewhere', uri: 'gone' },
    ];
    const out = await convertToPdf(request(html('<p>Text</p>')), run);
    expect(readBack(out.bytes).outline).toEqual([
      { title: '—', hasTarget: false, children: 0 },
      { title: '—', hasTarget: true, children: 1 },
      { title: 'Elsewhere', hasTarget: true, children: 0 },
    ]);
  });

  it('is written without a destination for an entry whose target is not a page', async () => {
    state.entryPage = -1;
    state.outline = [{ title: 'Lost', uri: 'gone' }];
    const out = await convertToPdf(request(html('<p>Text</p>')), run);
    expect(readBack(out.bytes).outline).toEqual([{ title: 'Lost', hasTarget: false, children: 0 }]);
  });
});

describe('a layout with no pages', () => {
  it('is refused as nothing to lay out, naming the file', async () => {
    state.pageCount = 0;
    await expect(convertToPdf(request(html('<p>Text</p>'), 'empty.html'), run)).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engine: 'mupdf', path: 'empty.html', engineMessage: 'nothing to lay out' },
    });
  });
});

describe('the read-back of the written file', () => {
  it('refuses a file that holds a different number of pages than were laid out', async () => {
    const other = new PDFDocument();
    other.insertPage(0, other.addPage([0, 0, 100, 100], 0, {}, ''));
    other.insertPage(1, other.addPage([0, 0, 100, 100], 0, {}, ''));
    state.damaged = new Uint8Array(other.saveToBuffer('').asUint8Array());
    other.destroy();
    await expect(convertToPdf(request(html('<p>Text</p>')), run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engine: 'mupdf', engineMessage: 'converted 1 pages but the file holds 2' },
    });
  });
});
