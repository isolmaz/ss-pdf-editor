/**
 * The tag editor re-opens what it wrote and compares it with what the edits must produce, and it
 * maps engine failures to the error a caller can act on. The real engine writes what it is told
 * to, so these tests wrap it at its loading seam (the same seam `accessibility.faults.test.ts`
 * uses): the document being written is damaged in one chosen way just before it is saved, or one
 * call of the engine fails, and everything else — the bytes that come out, the second reader — is
 * real.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
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

const { editStructure, readPageLayout, readStructure, readTagCandidates } = await import('./structure');
const { walkNodes } = await import('./structure-model');
const { pageContent } = await import('./accessibility');
const { buildTagged, tagged } = await import('./tagged.fixtures');
const { untaggedFixture } = await import('./ua.fixtures');

afterEach(() => {
  state.tamper = undefined;
  state.trap = undefined;
  state.failLoad = new Map();
  state.loads = 0;
});

const run = { signal: new AbortController().signal };
const abortError = (): Error => Object.assign(new Error('stopped'), { name: 'AbortError' });

const refused = (engineMessage: string | RegExp) => ({
  code: 'verification-failed',
  details: {
    engine: 'mupdf',
    engineMessage: typeof engineMessage === 'string' ? engineMessage : expect.stringMatching(engineMessage),
  },
});

/** Document(P#0, P#1) on one page. */
const two = () =>
  buildTagged({
    pages: [{ content: `${tagged('P', 0, '1 1 5 5 re f')}${tagged('P', 1, '9 9 5 5 re f')}` }],
    tree: [
      {
        s: 'Document',
        pg: 0,
        k: [
          { s: 'P', k: [0] },
          { s: 'P', k: [1] },
        ],
      },
    ],
  });

async function keyOfP(bytes: Uint8Array, nth: number): Promise<string> {
  const keys: string[] = [];
  walkNodes((await readStructure(bytes, run)).model, (node) => {
    if (node.role === 'P') keys.push(node.key);
  });
  return keys[nth] as string;
}

const objectOf = (doc: PDFDocument, key: string): PDFObject =>
  doc.newIndirect(Number(key.slice(1))).resolve();

describe('engine failures while reading', () => {
  it('maps a failure of the engine, and lets an abort through, in each reader', async () => {
    const tagged1 = (await two()).bytes;
    const untagged = await untaggedFixture();
    const readers: readonly [string, () => Promise<unknown>][] = [
      ['read structure', () => readStructure(tagged1, run)],
      ['read page layout', () => readPageLayout(tagged1, 0, run)],
      ['read tag candidates', () => readTagCandidates(untagged, run)],
    ];
    for (const [context, read] of readers) {
      state.trap = { method: 'countPages', error: new Error('out of memory') };
      await expect(read()).rejects.toMatchObject({
        code: 'out-of-memory',
        details: { engineMessage: `${context}: out of memory` },
      });
      state.trap = { method: 'countPages', error: abortError() };
      await expect(read()).rejects.toMatchObject({ name: 'AbortError' });
    }
  });
});

describe('engine failures while writing', () => {
  it('maps a failure while the edit is applied, and one while the file is saved', async () => {
    const built = await two();
    const key = await keyOfP(built.bytes, 0);
    state.loads = 0;
    state.trap = { method: 'newName', error: new Error('out of memory') };
    await expect(editStructure(built.bytes, [{ op: 'role', key, role: 'H1' }], run)).rejects.toMatchObject({
      code: 'out-of-memory',
      details: { engineMessage: 'edit structure: out of memory' },
    });
    state.trap = undefined;
    state.tamper = () => {
      throw new Error('out of memory');
    };
    await expect(editStructure(built.bytes, [{ op: 'role', key, role: 'H1' }], run)).rejects.toMatchObject({
      code: 'out-of-memory',
      details: { engineMessage: 'edit structure: out of memory' },
    });
  });
});

describe('editStructure verification', () => {
  it('refuses an output whose tree reads back differently from the edit', async () => {
    const built = await two();
    const key = await keyOfP(built.bytes, 0);
    state.loads = 0;
    state.tamper = (doc) => objectOf(doc, key).put('S', doc.newName('Span'));
    await expect(editStructure(built.bytes, [{ op: 'role', key, role: 'H1' }], run)).rejects.toMatchObject(
      refused(/^the structure tree reads back differently from the edit \(\d+ vs \d+ characters\)$/),
    );
  });

  it('reports a file that does not re-open, whatever the engine failed with', async () => {
    const built = await two();
    const key = await keyOfP(built.bytes, 0);
    const edits = [{ op: 'role' as const, key, role: 'H1' }];
    state.loads = 0;
    state.failLoad = new Map([[2, new Error('engine gone')]]);
    await expect(editStructure(built.bytes, edits, run)).rejects.toMatchObject(
      refused('the edited file does not re-open: engine gone'),
    );
    state.loads = 0;
    state.failLoad = new Map([[2, 'plain string']]);
    await expect(editStructure(built.bytes, edits, run)).rejects.toMatchObject(
      refused('the edited file does not re-open: plain string'),
    );
  });

  describe('after an artifact edit', () => {
    const edit = async () => {
      const built = await two();
      return { bytes: built.bytes, edits: [{ op: 'artifact' as const, key: await keyOfP(built.bytes, 1) }] };
    };
    const replaceContent = (doc: PDFDocument, text: string): void => {
      doc.findPage(0).put('Contents', doc.addStream(text, {}));
    };

    it('refuses a page whose content cannot be read back, or that is gone', async () => {
      const { bytes, edits } = await edit();
      state.tamper = (doc) =>
        doc.findPage(0).put(
          'Contents',
          doc.addRawStream(new Uint8Array([1, 2, 3]), {
            Filter: 'FlateDecode',
            DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
          } as never),
        );
      await expect(editStructure(bytes, edits, run)).rejects.toMatchObject(
        refused('page 1 content is unreadable after the write'),
      );
      state.tamper = (doc) => replaceContent(doc, 'q ]');
      await expect(editStructure(bytes, edits, run)).rejects.toMatchObject(
        refused('page 1 content is unreadable after the write'),
      );

      // Every element on the page goes with the artifact, so the tree is unchanged by losing it.
      const lone = await buildTagged({
        pages: [{ content: tagged('P', 0, '1 1 5 5 re f') }],
        tree: [{ s: 'Document', pg: 0, k: [{ s: 'P', k: [0] }] }],
      });
      state.tamper = (doc) => doc.deletePage(0);
      await expect(
        editStructure(lone.bytes, [{ op: 'artifact', key: await keyOfP(lone.bytes, 0) }], run),
      ).rejects.toMatchObject(refused('page 1 content is unreadable after the write'));
    });

    it('refuses a page left with unbalanced marked content', async () => {
      const { bytes, edits } = await edit();
      state.tamper = (doc) => {
        const text = Buffer.from(pageContent(doc.findPage(0))?.bytes ?? []).toString('latin1');
        replaceContent(doc, `${text}\nEMC`);
      };
      await expect(editStructure(bytes, edits, run)).rejects.toMatchObject(
        refused('page 1 has unbalanced marked content after the write'),
      );
    });

    it('refuses a page that still marks the id of the artifact', async () => {
      const { bytes, edits } = await edit();
      state.tamper = (doc) => replaceContent(doc, tagged('P', 1, '9 9 5 5 re f'));
      await expect(editStructure(bytes, edits, run)).rejects.toMatchObject(
        refused('page 1 still marks /MCID 1 after it was made an artifact'),
      );
    });

    it('stops for an abort that arrives while the pages are verified', async () => {
      const { bytes, edits } = await edit();
      const controller = new AbortController();
      state.tamper = () => controller.abort();
      await expect(editStructure(bytes, edits, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });
});
