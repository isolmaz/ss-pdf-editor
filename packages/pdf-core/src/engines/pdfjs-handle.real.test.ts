/**
 * The pdf.js handle against the real engine and real PDFs built with MuPDF: opening (plain,
 * password-protected, damaged, aborted), the per-page reads (size, text, geometry, operators,
 * labels, outline) and the save. The one thing a Node run does not have is a canvas, so the
 * render tests hand pdf.js a canvas stand-in whose 2D context swallows every drawing call.
 */

import { Font, PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xfaPdf } from '../ops/xfa-form.fixtures';
import { loadPdfjs, openWithPdfjs, type PdfDocumentHandle, warmPdfjs } from './pdfjs-handle';

/** Two pages: "Merhaba" on the first, the second turned a quarter; labels i, ii; a nested outline. */
function document(options: { outline?: boolean; labels?: boolean } = {}): Uint8Array {
  const doc = new PDFDocument();
  const font = doc.addSimpleFont(new Font('Helvetica'));
  doc.insertPage(
    0,
    doc.addPage([0, 0, 300, 400], 0, { Font: { F1: font } }, 'BT /F1 24 Tf 40 300 Td (Merhaba) Tj ET'),
  );
  doc.insertPage(1, doc.addPage([0, 0, 300, 400], 90, {}, ''));
  if (options.labels === true) {
    doc.setPageLabels(0, PDFDocument.PAGE_LABEL_ROMAN_LC, '', 1);
  }
  if (options.outline === true) {
    const root = doc.addObject({ Type: 'Outlines', Count: 5 });
    const notAPage = doc.addObject({});
    const named = doc.addObject({ Dests: {} });
    named.get('Dests').put('second', [doc.findPage(1), 'Fit']);
    doc.getTrailer().get('Root').put('Names', doc.newDictionary());
    doc.getTrailer().get('Root').put('Dests', named.get('Dests'));
    const child = doc.addObject({
      Title: doc.newString('Alt'),
      Dest: [doc.findPage(1), 'Fit'],
      Parent: root,
    });
    const first = doc.addObject({
      Title: doc.newString('Birinci'),
      Dest: [doc.findPage(0), 'Fit'],
      Parent: root,
    });
    first.put('First', child);
    first.put('Last', child);
    child.put('Parent', first);
    const byName = doc.addObject({
      Title: doc.newString('Adlı'),
      Dest: doc.newString('second'),
      Parent: root,
    });
    const unknown = doc.addObject({
      Title: doc.newString('Yok'),
      Dest: doc.newString('nowhere'),
      Parent: root,
    });
    const link = doc.addObject({
      Title: doc.newString('Bağlantı'),
      A: { S: 'URI', URI: doc.newString('https://example.test/') },
      Parent: root,
    });
    const broken = doc.addObject({ Title: doc.newString('Bozuk'), Dest: [notAPage, 'Fit'], Parent: root });
    first.put('Next', byName);
    byName.put('Next', unknown);
    unknown.put('Next', link);
    link.put('Next', broken);
    root.put('First', first);
    root.put('Last', broken);
    doc.getTrailer().get('Root').put('Outlines', root);
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function encrypted(): Uint8Array {
  const doc = PDFDocument.openDocument(document().slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  const bytes = new Uint8Array(
    doc.saveToBuffer('encrypt=aes-256,user-password=gizli,owner-password=sahip').asUint8Array(),
  );
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

async function failureOf(task: Promise<unknown>): Promise<ToolError> {
  try {
    await task;
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

/** A canvas whose 2D context accepts every call pdf.js makes to paint a page and draws nothing. */
function fakeCanvas(onPaint?: (call: string) => void) {
  const target: Record<string | symbol, unknown> = {};
  const context: Record<string | symbol, unknown> = new Proxy(target, {
    get: (own, property) => {
      if (property in own) return own[property];
      if (property === 'canvas') return canvas;
      if (property === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return () => {
        // The handle clears the canvas itself before pdf.js starts; anything else is pdf.js painting.
        if (property !== 'setTransform' && property !== 'clearRect') onPaint?.(String(property));
      };
    },
    set: (own, property, value) => {
      own[property] = value;
      return true;
    },
  });
  const canvas = { width: 0, height: 0, style: { width: '', height: '' }, getContext: () => context };
  return canvas;
}

describe('openWithPdfjs', () => {
  it('opens a document and reports its page count and fingerprint', async () => {
    await withHandle(document(), async (handle) => {
      expect(handle.pageCount).toBe(2);
      expect(handle.fingerprint).toEqual(expect.any(String));
    });
  });

  it('refuses a signal that is already aborted, with the aborted code', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = await failureOf(openWithPdfjs(document(), { signal: controller.signal }));
    expect(failure.code).toBe('aborted');
  });

  it('reports an abort that arrives while the document is loading as aborted', async () => {
    const controller = new AbortController();
    const opening = openWithPdfjs(document(), { signal: controller.signal });
    controller.abort();
    expect((await failureOf(opening)).code).toBe('aborted');
  });

  it('settles with the aborted code, within a short time, when the signal fires while the document loads', async () => {
    // Node runs pdf.js's worker in this thread, so terminating it mid-load rejects a task of the
    // worker's own as an unhandled rejection (a real browser's worker keeps that to itself).
    // The test takes the process listeners over for its duration and checks that this is the only
    // thing that was rejected.
    const previous = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const stray: unknown[] = [];
    const collect = (reason: unknown) => stray.push(reason);
    process.on('unhandledRejection', collect);
    try {
      const controller = new AbortController();
      const failure = await failureOf(
        openWithPdfjs(document(), { signal: controller.signal, onProgress: () => controller.abort() }),
      );
      expect(failure.code).toBe('aborted');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stray.map((reason) => (reason instanceof Error ? reason.message : String(reason)))).toEqual(
        stray.length === 0 ? [] : ['Worker was terminated'],
      );
    } finally {
      process.off('unhandledRejection', collect);
      for (const listener of previous) process.on('unhandledRejection', listener);
    }
  }, 5000);

  it('asks for a password, and says whether it was needed or wrong', async () => {
    const asked: string[] = [];
    const missing = await failureOf(
      openWithPdfjs(encrypted(), { onPasswordRequest: (reason) => asked.push(reason) }),
    );
    expect(missing.code).toBe('password-required');
    expect(asked).toEqual(['needed']);
    const refused: string[] = [];
    const wrong = await failureOf(
      openWithPdfjs(encrypted(), { password: 'yanlis', onPasswordRequest: (reason) => refused.push(reason) }),
    );
    expect(wrong.code).toBe('wrong-password');
    expect(refused).toContain('incorrect');
  });

  it('opens with the right password', async () => {
    const handle = await openWithPdfjs(encrypted(), { password: 'gizli' });
    expect(handle.pageCount).toBe(2);
    await handle.destroy();
  });

  it('reports bytes that are not a PDF as a corrupt document', async () => {
    const failure = await failureOf(openWithPdfjs(new TextEncoder().encode('this is not a pdf at all')));
    expect(failure.code).toBe('corrupt-document');
  });

  it('reports load progress when asked', async () => {
    const seen: Array<[number, number]> = [];
    const handle = await openWithPdfjs(document(), {
      onProgress: (loaded, total) => seen.push([loaded, total]),
    });
    await handle.destroy();
    expect(seen.length).toBeGreaterThan(0);
  });

  it('seeds the annotation storage and lets pdf.js lay out XFA only when asked', async () => {
    const handle = await openWithPdfjs(document(), {
      enableXfa: true,
      annotationStorage: { map: new Map(), hash: '' },
    });
    expect(handle.pageCount).toBe(2);
    await handle.destroy();
  });
});

describe('warmPdfjs', () => {
  it('loads the engine ahead of the first document without complaint', async () => {
    warmPdfjs();
    expect(await loadPdfjs()).toHaveProperty('getDocument');
  });
});

describe('page reads', () => {
  it('measures a page at a scale, with the page turn and with a requested turn', async () => {
    await withHandle(document(), async (handle) => {
      expect(await handle.getPageSize(0, 2)).toEqual({
        width: 600,
        height: 800,
        rotation: 0,
        viewBox: [0, 0, 300, 400],
      });
      const turned = await handle.getPageSize(1, 1);
      expect([turned.width, turned.height, turned.rotation]).toEqual([400, 300, 90]);
      const extra = await handle.getPageSize(0, 1, 90);
      expect([extra.width, extra.height, extra.rotation]).toEqual([400, 300, 90]);
    });
  });

  it('reads page labels, or null when the file has none', async () => {
    await withHandle(document({ labels: true }), async (handle) => {
      expect(await handle.getPageLabels()).toEqual(['i', 'ii']);
    });
    await withHandle(document(), async (handle) => {
      expect(await handle.getPageLabels()).toBeNull();
    });
  });

  it('reads the text of a page as one trimmed line', async () => {
    await withHandle(document(), async (handle) => {
      expect(await handle.getPageText(0)).toBe('Merhaba');
      expect(await handle.getPageText(1)).toBe('');
    });
  });

  it('reads text runs with their geometry and the turn of the page', async () => {
    await withHandle(document(), async (handle) => {
      const first = await handle.textContent(0);
      expect(first.items.map((item) => item.text)).toEqual(['Merhaba']);
      expect(first.items[0]?.x).toBeCloseTo(40, 0);
      expect(first.items[0]?.y).toBeCloseTo(300, 0);
      expect(first.viewport).toEqual({ width: 300, height: 400, rotation: 0 });
      expect((await handle.textContent(1)).viewport.rotation).toBe(90);
    });
  });

  it('reads the operators a page draws', async () => {
    await withHandle(document(), async (handle) => {
      const list = await handle.operatorList(0);
      expect(list.fnArray.length).toBeGreaterThan(0);
      expect(list.argsArray).toHaveLength(list.fnArray.length);
    });
  });

  it('maps an engine failure while reading a page to a tool error', async () => {
    await withHandle(document(), async (handle) => {
      const page = await handle.raw.getPage(1);
      vi.spyOn(page, 'getOperatorList').mockRejectedValue(new Error('operator list failed'));
      vi.spyOn(page, 'getTextContent').mockRejectedValue(new Error('text content failed'));
      const operators = await failureOf(handle.operatorList(0));
      expect(operators.details.engineMessage).toBe('operator list failed');
      const text = await failureOf(handle.textContent(0));
      expect(text.details.engineMessage).toBe('text content failed');
    });
  });
});

describe('outline', () => {
  it('resolves explicit and named destinations to page indices and keeps entries it cannot resolve', async () => {
    await withHandle(document({ outline: true }), async (handle) => {
      const outline = await handle.getOutline();
      expect(outline.map((entry) => [entry.title, entry.pageIndex])).toEqual([
        ['Birinci', 0],
        ['Adlı', 1],
        ['Yok', null],
        ['Bağlantı', null],
        ['Bozuk', null],
      ]);
      expect(outline[0]?.children.map((entry) => [entry.title, entry.pageIndex])).toEqual([['Alt', 1]]);
      expect(outline[1]?.children).toEqual([]);
    });
  });

  it('reads a document without an outline as an empty list', async () => {
    await withHandle(document(), async (handle) => {
      expect(await handle.getOutline()).toEqual([]);
    });
  });
});

describe('saveDocument', () => {
  it('answers the document bytes when nothing was edited', async () => {
    const input = document();
    await withHandle(input, async (handle) => {
      expect(await handle.saveDocument()).toEqual(input);
    });
  });

  it('serialises a value the user typed into a form field', async () => {
    const input = await xfaPdf({ kind: 'static' });
    await withHandle(input, async (handle) => {
      const page = await handle.raw.getPage(1);
      const fields = (await page.getAnnotations()).filter((annotation) => annotation.fieldType === 'Tx');
      const id = fields[0]?.id;
      if (id === undefined) throw new Error('the fixture has no text field');
      handle.raw.annotationStorage.setValue(id, { value: 'Çağrı' });
      const saved = await handle.saveDocument();
      expect(saved.byteLength).toBeGreaterThan(input.byteLength);
    });
  });

  it('maps an engine failure while saving to a tool error', async () => {
    await withHandle(document(), async (handle) => {
      // A value for an annotation the document does not have cannot be serialised.
      handle.raw.annotationStorage.setValue('pdfjs_internal_editor_0', { value: 1 });
      const failure = await failureOf(handle.saveDocument());
      expect(failure.code).toBe('internal');
      expect(failure.details.engine).toBe('pdfjs');
    });
  });
});

describe('renderPage', () => {
  beforeEach(() => {
    // The browser's path object; pdf.js builds one per drawn shape and the stand-in context ignores it.
    vi.stubGlobal(
      'Path2D',
      class {
        moveTo(): void {}
        lineTo(): void {}
        bezierCurveTo(): void {}
        quadraticCurveTo(): void {}
        rect(): void {}
        arc(): void {}
        closePath(): void {}
        addPath(): void {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sizes the canvas to the page at the scale and the pixel ratio, and paints', async () => {
    await withHandle(document(), async (handle) => {
      const canvas = fakeCanvas();
      await handle.renderPage(0, canvas as never, { scale: 1.5, devicePixelRatio: 2, background: '#ffffff' });
      expect([canvas.width, canvas.height]).toEqual([900, 1200]);
      expect([canvas.style.width, canvas.style.height]).toEqual(['450px', '600px']);
    });
  });

  it('takes the pixel ratio of the screen when none is given', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    await withHandle(document(), async (handle) => {
      const canvas = fakeCanvas();
      await handle.renderPage(0, canvas as never, { scale: 1 });
      expect([canvas.width, canvas.height]).toEqual([600, 800]);
      expect([canvas.style.width, canvas.style.height]).toEqual(['300px', '400px']);
    });
  });

  it('turns the page when asked, and takes the device pixel ratio of the screen by default', async () => {
    await withHandle(document(), async (handle) => {
      const canvas = fakeCanvas();
      await handle.renderPage(0, canvas as never, { scale: 1, rotation: 90 });
      expect([canvas.width, canvas.height]).toEqual([400, 300]);
    });
  });

  it('paints on a canvas whose context cannot be reset first', async () => {
    await withHandle(document(), async (handle) => {
      const canvas = { ...fakeCanvas(), getContext: () => null };
      const failure = await failureOf(handle.renderPage(0, canvas as never, { scale: 1 }));
      expect(failure.details.engine).toBe('pdfjs');
    });
  });

  it('refuses a signal that is already aborted', async () => {
    await withHandle(document(), async (handle) => {
      const controller = new AbortController();
      controller.abort();
      const failure = await failureOf(
        handle.renderPage(0, fakeCanvas() as never, { scale: 1, signal: controller.signal }),
      );
      expect(failure.code).toBe('aborted');
    });
  });

  it('cancels the render and reports aborted when the signal fires during it', async () => {
    await withHandle(document(), async (handle) => {
      const controller = new AbortController();
      // The signal fires from inside pdf.js's first paint call, so the abort lands while the
      // render is running — after the task exists and before it can complete.
      let paints = 0;
      const canvas = fakeCanvas(() => {
        paints += 1;
        if (paints === 1) controller.abort();
      });
      const failure = await failureOf(
        handle.renderPage(0, canvas as never, { scale: 1, signal: controller.signal }),
      );
      expect(paints).toBeGreaterThan(0);
      expect(failure.code).toBe('aborted');
      // pdf.js reports the cancelled task it was told to stop, not an error of the handle's own.
      expect(failure.cause).toMatchObject({ name: 'RenderingCancelledException' });
    });
  });
});
