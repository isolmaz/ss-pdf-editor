/**
 * What the PDF/A conversion does when Ghostscript hands back something other than a good file,
 * and when the read-back fails. The real engine converts what it is given, so these tests wrap it
 * at its seams: Ghostscript's reply is replaced (nothing, a file that is not PDF/A, one that is
 * only partly checkable) or made to convert a different input (another page count, another
 * page), and one answer of the reopened output (its `/Producer`) is changed or made to throw.
 * The prepared bytes, the checker and the comparison run on real files.
 */

import type { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Replaces what Ghostscript returns. */
  reply?: {
    readonly output: Uint8Array;
    readonly exitCode: number;
    readonly warnings: { text: string; count: number }[];
  };
  /** Ghostscript converts these bytes instead of the prepared file. */
  convertInstead?: Uint8Array;
  /** What `getMetaData('info:Producer')` does on the reopened documents. */
  producer?: { readonly value: string | undefined } | { readonly error: Error };
}
const state: Plan = {};

vi.mock('../engines/ghostscript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/ghostscript')>();
  return {
    ...actual,
    convertWithGhostscript: async (
      request: Parameters<typeof actual.convertWithGhostscript>[0],
      options: Parameters<typeof actual.convertWithGhostscript>[1],
    ) => {
      if (state.reply !== undefined) return { ...state.reply, pageCount: 1 };
      const input = state.convertInstead === undefined ? request.input : state.convertInstead.slice();
      return await actual.convertWithGhostscript({ ...request, input }, options);
    },
  };
});

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
            if (property === 'getMetaData' && state.producer !== undefined) {
              const producer = state.producer;
              return (key: string) => {
                if (key !== 'info:Producer') return target.getMetaData(key);
                if ('error' in producer) throw producer.error;
                return producer.value;
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

const { convertToPdfA } = await import('./pdfa');
const { plain, withUnreadableContent } = await import('./pdfa.fixtures');

const run = { signal: new AbortController().signal };
const SENTENCE = 'Quarterly results were published today';

afterEach(() => {
  state.reply = undefined;
  state.convertInstead = undefined;
  state.producer = undefined;
});

describe('convertToPdfA when Ghostscript fails', () => {
  it('reports an empty output with the exit code and the engine warnings', async () => {
    state.reply = {
      output: new Uint8Array(0),
      exitCode: 3,
      warnings: [
        { text: 'first', count: 1 },
        { text: 'second', count: 2 },
      ],
    };
    await expect(convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run)).rejects.toMatchObject({
      code: 'pdfa-failed',
      details: { engine: 'ghostscript', engineMessage: 'no output (exit 3); first | second' },
    });
  });

  it('refuses an output that does not claim the part, naming what the checker found', async () => {
    state.reply = { output: plain({ text: SENTENCE }), exitCode: 0, warnings: [] };
    await expect(convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run)).rejects.toMatchObject({
      code: 'pdfa-not-compliant',
      details: { engine: 'ghostscript', engineMessage: expect.stringMatching(/^no-claim: /) },
    });
  });

  it('refuses an output that meets the part but could not be fully checked, naming the rules not run', async () => {
    const compliant = await convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run);
    state.reply = { output: await withUnreadableContent(compliant.bytes), exitCode: 0, warnings: [] };
    await expect(convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run)).rejects.toMatchObject({
      code: 'pdfa-not-compliant',
      details: { engineMessage: expect.stringMatching(/^claims-and-meets: .*\(not run: .*fonts/) },
    });
  });

  it('refuses an output whose page count differs from the input', async () => {
    state.convertInstead = plain({ text: SENTENCE, pages: 2 });
    await expect(convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engine: 'ghostscript', engineMessage: 'page count 1 became 2' },
    });
  });

  it('warns about the text and the picture of a page that came out different', async () => {
    state.convertInstead = plain({
      text: 'Completely unrelated words appear here instead',
      size: [300, 400],
    });
    const outcome = await convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run);
    const notes = new Map(outcome.report.notes.map((entry) => [entry.key, entry.params]));
    expect(notes.get('op.note.pdfa.textLoss')).toEqual({ percent: '0 %', pages: '1' });
    expect(notes.get('op.note.pdfa.pictureDiffers')).toEqual({ pages: '1' });
    expect(notes.has('op.note.pdfa.pictureKept')).toBe(false);
    expect(outcome.measures.pictureDiffers).toEqual([0]);
  });
});

describe('convertToPdfA reading the output back', () => {
  it('leaves out the producer note when the output names none or a blank one', async () => {
    for (const value of [undefined, '   ']) {
      state.producer = { value };
      const outcome = await convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run);
      expect(outcome.report.notes.map((entry) => entry.key)).not.toContain('op.note.pdfa.producer');
    }
  });

  it('maps an engine failure of the read-back to an error that names the step', async () => {
    state.producer = { error: new Error('engine fault') };
    await expect(convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run)).rejects.toMatchObject({
      details: { engine: 'mupdf', engineMessage: 'pdfa verify: engine fault' },
    });
  });

  it('lets an abort during the read-back through unchanged', async () => {
    state.producer = { error: Object.assign(new Error('stopped'), { name: 'AbortError' }) };
    await expect(convertToPdfA(plain({ text: SENTENCE }), { part: 2 }, run)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
