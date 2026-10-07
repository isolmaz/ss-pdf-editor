/**
 * Tagging and alt-text writing re-open what they produced and check it against what they meant
 * to write. The real engine writes what it is told to, so these tests wrap it at its loading
 * seam: the document the writer saves is damaged in one chosen way just before the save (the
 * producer line is the last thing set), and the bytes that come out are real. Each case proves
 * the damage is refused as `verification-failed` with the reason named, never handed back.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import type { PageTextInput, Rect } from 'pdf-text-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Plan {
  /** Runs on the document being written, just before it is saved. */
  tamper?: (document: PDFDocument) => void;
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

const { setImageAlt, tagDocument } = await import('./accessibility');
const mupdf = await import('mupdf');

afterEach(() => {
  state.tamper = undefined;
  state.failLoad = new Map();
  state.loads = 0;
});

const run = { signal: new AbortController().signal };

/** One 12 pt block whose ink box holds the point (10, 50), where `HELLO` shows its text. */
const HELLO = 'BT /F 12 Tf 10 150 Td (Hello) Tj ET';
const hello: PageTextInput = (() => {
  const chars = [...'Hello'].map((ch, index) => ({
    ch,
    quad: [10 + index * 6, 40, 16 + index * 6, 52] as Rect,
    origin: [10 + index * 6, 49.6] as readonly [number, number],
    size: 12,
    fontName: 'Helvetica',
  }));
  const quad = [10, 40, 40, 52] as Rect;
  return {
    pageIndex: 0,
    width: 200,
    height: 200,
    rotation: 0,
    blocks: [{ quad, lines: [{ chars, quad, baseline: 49.6 }] }],
  };
})();

function page(contents: string, edit?: (doc: PDFDocument, page: PDFObject) => void): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 2, 2], false);
  pixmap.clear(0);
  const resources = { XObject: { Im: doc.addImage(new mupdf.Image(pixmap)) } };
  doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, resources, contents));
  edit?.(doc, doc.findPage(0));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const readPageText = async (): Promise<PageTextInput> => hello;
const tag = (bytes: Uint8Array, context = run) => tagDocument(bytes, context, { pageText: readPageText });
const rootOf = (doc: PDFDocument) => doc.getTrailer().get('Root');

/** The page's decoded content, as text. */
const contentOf = (target: PDFObject): string =>
  Buffer.from(target.get('Contents').readStream().asUint8Array()).toString('latin1');
const replaceContent = (doc: PDFDocument, target: PDFObject, text: string): void => {
  target.put('Contents', doc.addStream(text, {}));
};

const refused = (engineMessage: string | RegExp) => ({
  code: 'verification-failed',
  details: {
    engine: 'mupdf',
    engineMessage: typeof engineMessage === 'string' ? engineMessage : expect.stringMatching(engineMessage),
  },
});

describe('tagDocument verification', () => {
  it('refuses an output without a structure tree', async () => {
    state.tamper = (doc) => rootOf(doc).delete('StructTreeRoot');
    await expect(tag(page(HELLO))).rejects.toMatchObject(refused('the produced file has no /StructTreeRoot'));
  });

  it('refuses an output that is not marked as tagged, whether /MarkInfo says false or is gone', async () => {
    state.tamper = (doc) => rootOf(doc).put('MarkInfo', { Marked: false } as never);
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('the produced file has no /MarkInfo << /Marked true >>'),
    );
    state.tamper = (doc) => rootOf(doc).delete('MarkInfo');
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('the produced file has no /MarkInfo << /Marked true >>'),
    );
  });

  it('refuses an output whose page content cannot be read back', async () => {
    state.tamper = (doc) =>
      doc.findPage(0).put(
        'Contents',
        doc.addRawStream(new Uint8Array([1, 2, 3]), {
          Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
        } as never),
      );
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('page 1 content is unreadable after the write'),
    );
  });

  it('refuses an output that lost the page it tagged', async () => {
    state.tamper = (doc) => doc.deletePage(0);
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('page 1 content is unreadable after the write'),
    );
  });

  it('refuses an output whose page content cannot be tokenized', async () => {
    state.tamper = (doc) => replaceContent(doc, doc.findPage(0), 'q ]');
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('page 1 content cannot be tokenized after the write'),
    );
  });

  it('refuses an output that gained marked content the splice did not write', async () => {
    state.tamper = (doc) => {
      const target = doc.findPage(0);
      replaceContent(doc, target, `${contentOf(target)}\n/Span BMC EMC`);
    };
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('page 1 gained 2 marked-content starts and 2 ends, expected 1'),
    );
    state.tamper = (doc) => {
      const target = doc.findPage(0);
      replaceContent(doc, target, `${contentOf(target)}\nEMC`);
    };
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('page 1 gained 1 marked-content starts and 2 ends, expected 1'),
    );
  });

  it('refuses a structure tree that points at an MCID the content does not carry', async () => {
    state.tamper = (doc) => {
      const target = doc.findPage(0);
      replaceContent(doc, target, contentOf(target).replace('/MCID 0', '/MCID 9'));
    };
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('page 1 structure points at /MCID 0, which is not in its content stream'),
    );
  });

  it('stops for an abort that arrives while the output is being verified', async () => {
    const controller = new AbortController();
    state.tamper = () => controller.abort();
    await expect(tag(page(HELLO), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('reports a file that does not re-open, whatever the engine failed with', async () => {
    state.failLoad = new Map([[2, new Error('engine gone')]]);
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('the tagged file does not re-open: engine gone'),
    );
    state.loads = 0;
    state.failLoad = new Map([[2, 'plain string']]);
    await expect(tag(page(HELLO))).rejects.toMatchObject(
      refused('the tagged file does not re-open: plain string'),
    );
  });
});

describe('setImageAlt verification', () => {
  const withImage = () => page('q 10 0 0 10 0 0 cm /Im Do Q');
  const withField = () =>
    page('q Q', (doc, target) => {
      const field = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('ad'),
        Rect: [0, 0, 5, 5],
        P: target,
      } as never);
      target.put('Annots', [field]);
      rootOf(doc).put('AcroForm', { Fields: [field] } as never);
    });
  const alt = [{ kind: 'image' as const, pageIndex: 0, name: 'Im', alt: 'A logo' }];
  const tooltip = [{ kind: 'field' as const, name: 'ad', tooltip: 'Your name' }];
  const imageOf = (doc: PDFDocument) => doc.findPage(0).get('Resources').get('XObject').get('Im');

  it('refuses an image whose alt text reads back as something else, or not at all', async () => {
    state.tamper = (doc) => imageOf(doc).put('Alt', doc.newString('Another text'));
    await expect(setImageAlt(withImage(), alt, run)).rejects.toMatchObject(
      refused('image "Im" reads back "Another text" instead of "A logo"'),
    );
    state.tamper = (doc) => imageOf(doc).delete('Alt');
    await expect(setImageAlt(withImage(), alt, run)).rejects.toMatchObject(
      refused('image "Im" reads back "" instead of "A logo"'),
    );
  });

  it('refuses an image that is no longer there to read back', async () => {
    state.tamper = (doc) => doc.findPage(0).put('Resources', doc.newDictionary());
    await expect(setImageAlt(withImage(), alt, run)).rejects.toMatchObject(
      refused('image "Im" reads back "" instead of "A logo"'),
    );
  });

  it('refuses a field whose tooltip reads back as something else, or whose field is gone', async () => {
    state.tamper = (doc) => {
      const field = rootOf(doc).get('AcroForm').get('Fields').get(0);
      field.put('TU', doc.newString('Another tooltip'));
    };
    await expect(setImageAlt(withField(), tooltip, run)).rejects.toMatchObject(
      refused('field "ad" reads back "Another tooltip" instead of "Your name"'),
    );
    state.tamper = (doc) => rootOf(doc).get('AcroForm').put('Fields', []);
    await expect(setImageAlt(withField(), tooltip, run)).rejects.toMatchObject(
      refused('field "ad" reads back "" instead of "Your name"'),
    );
  });

  it('reports a file that does not re-open, whatever the engine failed with', async () => {
    state.failLoad = new Map([[2, new Error('engine gone')]]);
    await expect(setImageAlt(withImage(), alt, run)).rejects.toMatchObject(
      refused('the file does not re-open after writing alt text: engine gone'),
    );
    state.loads = 0;
    state.failLoad = new Map([[2, 'plain string']]);
    await expect(setImageAlt(withImage(), alt, run)).rejects.toMatchObject(
      refused('the file does not re-open after writing alt text: plain string'),
    );
  });

  it('maps an engine failure while writing', async () => {
    state.tamper = () => {
      throw new Error('out of memory');
    };
    await expect(setImageAlt(withImage(), alt, run)).rejects.toMatchObject({
      code: 'out-of-memory',
      details: { engineMessage: 'set alt text: out of memory' },
    });
  });
});
