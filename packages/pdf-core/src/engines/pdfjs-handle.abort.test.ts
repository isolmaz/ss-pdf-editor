/**
 * The handle's open sequence against a scripted pdf.js loading task (the third-party boundary),
 * for what the real engine does not do on demand: a task whose `destroy` rejects, an abort that
 * lands in the gap between the parse settling and the open continuing, a document without
 * fingerprints, and marked-content items in a text layer (pdf.js emits those only when asked).
 */

import { describe, expect, it, vi } from 'vitest';

interface FakeDocument {
  numPages: number;
  fingerprints?: string[];
  getPage: (number: number) => Promise<unknown>;
}

const state = vi.hoisted(() => ({
  destroyCalls: 0,
  destroyFails: false,
  /** Runs when the loading task's promise settles, before the open continues. */
  onSettled: undefined as undefined | (() => void),
  failLoad: undefined as unknown,
  document: undefined as unknown,
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  VerbosityLevel: { WARNINGS: 1 },
  getDocument: () => {
    const promise =
      state.failLoad === undefined ? Promise.resolve(state.document) : Promise.reject(state.failLoad);
    promise.then(
      () => state.onSettled?.(),
      () => undefined,
    );
    return {
      promise,
      onPassword: undefined,
      onProgress: undefined,
      destroy: async () => {
        state.destroyCalls += 1;
        if (state.destroyFails) throw new Error('destroy failed');
      },
    };
  },
}));

const { openWithPdfjs } = await import('./pdfjs-handle');

function fake(document: Partial<FakeDocument> = {}): FakeDocument {
  return { numPages: 1, getPage: async () => ({}), ...document };
}

describe('openWithPdfjs against a scripted loading task', () => {
  it('opens a document that carries no fingerprints with a null fingerprint', async () => {
    state.document = fake();
    state.failLoad = undefined;
    state.onSettled = undefined;
    const handle = await openWithPdfjs(new Uint8Array([1]));
    expect(handle.fingerprint).toBeNull();
    expect(handle.pageCount).toBe(1);
  });

  it('settles as aborted, destroying the task, when the abort lands as the parse settles', async () => {
    const controller = new AbortController();
    state.document = fake({ fingerprints: ['abc'] });
    state.failLoad = undefined;
    state.destroyCalls = 0;
    state.destroyFails = false;
    state.onSettled = () => controller.abort();
    await expect(openWithPdfjs(new Uint8Array([1]), { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(state.destroyCalls).toBeGreaterThanOrEqual(1);
  });

  it('still reports the abort when the task cannot be destroyed', async () => {
    const controller = new AbortController();
    state.document = fake();
    state.destroyCalls = 0;
    state.destroyFails = true;
    state.onSettled = () => controller.abort();
    await expect(openWithPdfjs(new Uint8Array([1]), { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(state.destroyCalls).toBeGreaterThanOrEqual(1);
  });

  it('still reports the load failure when the failed task cannot be destroyed', async () => {
    state.failLoad = Object.assign(new Error('bad file'), { name: 'InvalidPDFException' });
    state.destroyFails = true;
    state.onSettled = undefined;
    await expect(openWithPdfjs(new Uint8Array([1]))).rejects.toMatchObject({ code: 'corrupt-document' });
    state.failLoad = undefined;
  });

  it('settles an abort that fires while the parse is still pending, even if the task cannot be destroyed', async () => {
    const controller = new AbortController();
    state.failLoad = undefined;
    state.destroyFails = true;
    state.onSettled = undefined;
    // The scripted task resolves with a value that never settles, so only the abort can end the open.
    state.document = new Promise(() => undefined);
    const opening = openWithPdfjs(new Uint8Array([1]), { signal: controller.signal });
    controller.abort();
    await expect(opening).rejects.toMatchObject({ code: 'aborted' });
    state.destroyFails = false;
  });
});

describe('text reads over marked-content items', () => {
  it('skips items without text in the page text and in the text runs', async () => {
    const page = {
      getViewport: () => ({ width: 10, height: 10, rotation: 0, viewBox: [0, 0, 10, 10] }),
      getTextContent: async () => ({
        items: [
          {
            str: 'a',
            transform: [1, 0, 0, 1, 2, 3],
            width: 1,
            height: 1,
            fontName: 'f',
            dir: 'ltr',
            hasEOL: false,
          },
          { type: 'beginMarkedContent', id: 'x' },
          {
            str: 'b',
            transform: [1, 0, 0, 1, 4, 5],
            width: 1,
            height: 1,
            fontName: 'f',
            dir: 'ltr',
            hasEOL: true,
          },
        ],
        styles: {},
      }),
    };
    state.failLoad = undefined;
    state.onSettled = undefined;
    state.destroyFails = false;
    state.document = fake({ fingerprints: ['id'], getPage: async () => page });
    const handle = await openWithPdfjs(new Uint8Array([1]));
    expect(await handle.getPageText(0)).toBe('a b');
    const runs = await handle.textContent(0);
    expect(runs.items.map((item) => [item.text, item.x, item.y])).toEqual([
      ['a', 2, 3],
      ['b', 4, 5],
    ]);
  });
});
