/**
 * The attachment list as pdf.js reports it. A real file (written by the attachment writer) gives
 * the normal path; payload shapes and failures that a real engine of this version does not
 * produce are injected at the `raw` document seam.
 */

import { PDFDocument } from 'mupdf';
import { isToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { listPdfAttachments, type PdfAttachment, readPdfAttachment } from './attachments';
import type { PdfDocumentHandle } from './engines/pdfjs-handle';
import { openWithPdfjs } from './engines/pdfjs-handle';

const encode = (value: string) => new TextEncoder().encode(value);

function withAttachment(): Uint8Array {
  const doc = new PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  const pairs = doc.newArray();
  pairs.push(doc.newString('a.txt'));
  pairs.push(doc.addEmbeddedFile('a.txt', 'text/plain', encode('payload'), new Date(0), new Date(0)));
  const embedded = doc.newDictionary();
  embedded.put('Names', pairs);
  const names = doc.newDictionary();
  names.put('EmbeddedFiles', embedded);
  doc.getTrailer().get('Root').put('Names', names);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function withoutAttachments(): Uint8Array {
  const doc = new PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function withHandle<T>(bytes: Uint8Array, use: (handle: PdfDocumentHandle) => Promise<T>): Promise<T> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await use(handle);
  } finally {
    await handle.destroy();
  }
}

/** The same handle, its engine document answering `getAttachments` / `getAttachmentContent` as told. */
function engineSays(
  handle: PdfDocumentHandle,
  answers: {
    readonly getAttachments?: () => Promise<unknown>;
    readonly getAttachmentContent?: (id: string) => Promise<unknown>;
  },
): PdfDocumentHandle {
  const raw = new Proxy(handle.raw, {
    get(target, property) {
      if (property === 'getAttachments' && answers.getAttachments !== undefined)
        return answers.getAttachments;
      if (property === 'getAttachmentContent' && answers.getAttachmentContent !== undefined) {
        return answers.getAttachmentContent;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...handle, raw };
}

describe('listPdfAttachments', () => {
  it('lists a real attachment with its name, description and payload', async () => {
    await withHandle(withAttachment(), async (handle) => {
      const list = await listPdfAttachments(handle);
      expect(list).toHaveLength(1);
      expect(list[0]?.filename).toBe('a.txt');
      expect(list[0]?.description).toBe('');
      const [first] = list;
      if (first === undefined) throw new Error('no attachment listed');
      expect(new TextDecoder().decode(await readPdfAttachment(handle, first))).toBe('payload');
    });
  });

  it('lists a document without attachments as an empty list', async () => {
    expect(await withHandle(withoutAttachments(), listPdfAttachments)).toEqual([]);
  });

  it('reads an engine that has no table at all as an empty list', async () => {
    await withHandle(withoutAttachments(), async (real) => {
      expect(await listPdfAttachments(engineSays(real, { getAttachments: async () => null }))).toEqual([]);
      expect(await listPdfAttachments(engineSays(real, { getAttachments: async () => undefined }))).toEqual(
        [],
      );
    });
  });

  it('reads every payload shape an engine version hands out, and names a nameless file by its id', async () => {
    await withHandle(withoutAttachments(), async (real) => {
      const table = new Map<string, unknown>([
        ['bytes', { filename: 'b.bin', description: 'd', content: new Uint8Array([1, 2, 3]) }],
        ['buffer', { filename: 'c.bin', content: new Uint8Array([4, 5]).buffer }],
        ['binary', { filename: '', description: 7, content: 'A\u0141\u00ff' }],
        ['stream-missing', { filename: 'd.bin', content: 42 }],
      ]);
      const list = await listPdfAttachments(engineSays(real, { getAttachments: async () => table }));
      expect(list.map((entry) => [entry.id, entry.filename, entry.description])).toEqual([
        ['bytes', 'b.bin', 'd'],
        ['buffer', 'c.bin', ''],
        ['binary', 'binary', ''],
        ['stream-missing', 'd.bin', ''],
      ]);
      expect(Array.from(list[0]?.content ?? [])).toEqual([1, 2, 3]);
      expect(Array.from(list[1]?.content ?? [])).toEqual([4, 5]);
      // A binary string keeps the low byte of each character.
      expect(Array.from(list[2]?.content ?? [])).toEqual([0x41, 0x41, 0xff]);
      expect(list[3]?.content).toBeNull();
    });
  });

  it('maps an engine failure to a tool error', async () => {
    await withHandle(withoutAttachments(), async (real) => {
      const failure = await listPdfAttachments(
        engineSays(real, {
          getAttachments: async () => {
            throw new Error('name tree is damaged');
          },
        }),
      ).catch((error: unknown) => error);
      expect(isToolError(failure) && failure.code).toBe('internal');
      expect(isToolError(failure) && failure.details.engineMessage).toBe('name tree is damaged');
    });
  });
});

describe('readPdfAttachment', () => {
  const entry = (content: PdfAttachment['content']): PdfAttachment => ({
    id: 'x',
    filename: 'x.bin',
    description: '',
    content,
  });

  it('returns the payload the list already carried without asking the engine', async () => {
    await withHandle(withoutAttachments(), async (real) => {
      const carried = new Uint8Array([9, 9]);
      const handle = engineSays(real, {
        getAttachmentContent: async () => {
          throw new Error('must not be asked');
        },
      });
      expect(await readPdfAttachment(handle, entry(carried))).toBe(carried);
    });
  });

  it('fetches the payload from the engine when the list did not carry it', async () => {
    await withHandle(withoutAttachments(), async (real) => {
      const handle = engineSays(real, { getAttachmentContent: async (id) => encode(`content of ${id}`) });
      expect(new TextDecoder().decode(await readPdfAttachment(handle, entry(null)))).toBe('content of x');
    });
  });

  it('answers corrupt-document, naming the file, when the stream is missing', async () => {
    await withHandle(withoutAttachments(), async (real) => {
      const handle = engineSays(real, { getAttachmentContent: async () => null });
      const failure = await readPdfAttachment(handle, entry(null)).catch((error: unknown) => error);
      expect(isToolError(failure) && failure.code).toBe('corrupt-document');
      expect(isToolError(failure) && failure.details.path).toBe('x.bin');
    });
  });

  it('maps an engine failure while reading the payload to a tool error', async () => {
    await withHandle(withoutAttachments(), async (real) => {
      const handle = engineSays(real, {
        getAttachmentContent: async () => {
          throw new Error('stream cannot be inflated');
        },
      });
      const failure = await readPdfAttachment(handle, entry(null)).catch((error: unknown) => error);
      expect(isToolError(failure) && failure.details.engineMessage).toBe('stream cannot be inflated');
    });
  });
});
