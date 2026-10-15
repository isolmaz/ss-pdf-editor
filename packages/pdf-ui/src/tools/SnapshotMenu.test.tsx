// @vitest-environment happy-dom
/**
 * View snapshot: the pages the viewport shows are composed into one PNG where pdf.js laid them
 * out, then copied or downloaded. Layout and canvas are faked (happy-dom has neither): two page
 * bitmaps at known rectangles in an 800 × 600 container, a recording 2D context and an encoder
 * the test completes by hand.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { SnapshotMenu, type SnapshotMenuProps } from './SnapshotMenu';

const engine = vi.hoisted(() => ({ open: vi.fn() }));
// The copy of the working bytes the capture renders from.
vi.mock('pdf-core/engines/pdfjs-handle', () => ({ openWithPdfjs: engine.open }));

const t = createTranslator('en');
const WORKING = new Uint8Array([7, 7]);
interface FakePages {
  readonly getPageSize: Mock;
  readonly renderPage: Mock;
  readonly destroy: Mock;
}
let viewer: ViewerApi;
/** The document on screen: the capture must not draw from it (it has none of the unsaved marks). */
let live: FakePages;
/** The copy of the working bytes. */
let working: FakePages;
let read: Mock;
const PNG = new Blob(['png'], { type: 'image/png' });

interface PageSpec {
  readonly number: string;
  readonly rect: DOMRect;
}

/** Two pages in view: 300 × 400 bitmaps at (10, 20) and (10, 430). */
const TWO_PAGES_IN_VIEW: readonly PageSpec[] = [
  { number: '1', rect: new DOMRect(10, 20, 300, 400) },
  { number: '2', rect: new DOMRect(10, 430, 300, 400) },
];

function mountViewer(pages: readonly PageSpec[] = TWO_PAGES_IN_VIEW) {
  document.body.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  const root = document.createElement('div');
  root.className = 'pdfViewer';
  root.setAttribute('data-active-viewer', '');
  const canvases: HTMLCanvasElement[] = [];
  for (const spec of pages) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.pageNumber = spec.number;
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 800;
    canvas.getBoundingClientRect = () => spec.rect;
    page.append(canvas);
    root.append(page);
    canvases.push(canvas);
  }
  scroll.append(root);
  document.body.append(scroll);
  return canvases;
}

interface Drawing {
  fillStyle: string;
  readonly fillRect: Mock;
  readonly drawImage: Mock;
}

/** Installs the recording context and an encoder that waits for `finish`. */
function installCanvas() {
  const drawing: Drawing = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    drawing as unknown as CanvasRenderingContext2D,
  );
  const pending: BlobCallback[] = [];
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    pending.push(callback);
  });
  return {
    drawing,
    toBlob,
    // The encoder is reached after the working bytes are read and the pages rendered: let that settle.
    finish: async (blob: Blob | null = PNG) => {
      await act(async () => {
        for (let turn = 0; turn < 200 && pending.length === 0; turn += 1) await Promise.resolve();
      });
      act(() => pending.shift()?.(blob));
    },
  };
}

/** `installCanvas()` and `show()` in one: the pieces a test about the capture itself reads. */
function show_with_canvas() {
  const canvas = installCanvas();
  return { ...canvas, ...show() };
}

function show(overrides: Partial<SnapshotMenuProps> = {}) {
  const onClose = vi.fn();
  const onNotice = vi.fn();
  const props: SnapshotMenuProps = { viewer, read, open: true, onClose, t, onNotice, ...overrides };
  const view = render(<SnapshotMenu {...props} />);
  return {
    onClose,
    onNotice,
    ...view,
    update: (next: Partial<SnapshotMenuProps>) => view.rerender(<SnapshotMenu {...props} {...next} />),
  };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  const fake = (): FakePages => ({
    getPageSize: vi.fn(async () => ({ width: 300, height: 400 })),
    renderPage: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  });
  live = fake();
  working = fake();
  read = vi.fn(async () => WORKING);
  engine.open.mockReset().mockResolvedValue(working);
  viewer = { document: live } as unknown as ViewerApi;
  mountViewer();
  document.documentElement.style.setProperty('--color-pdf-paper', 'rgb(250, 249, 240)');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--color-pdf-paper');
});

describe('what is composed', () => {
  it('shows nothing while closed or without a viewer', async () => {
    installCanvas();
    show({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    show({ viewer: null });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stacks the pages in view where the viewer laid them out, on the theme paper, at 1:1', async () => {
    const canvases = mountViewer();
    const { drawing, finish } = installCanvas();
    const { container } = show();
    await finish();
    const preview = container.querySelector('canvas') as HTMLCanvasElement;
    expect([preview.width, preview.height]).toEqual([300, 810]);
    expect(drawing.fillStyle).toBe('rgb(250, 249, 240)');
    expect(drawing.fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 300, 810);
    // Each page is rendered from the working bytes at the scale it has on screen, into one scratch canvas.
    const scratch = working.renderPage.mock.calls[0]?.[1];
    expect(scratch).toBeInstanceOf(HTMLCanvasElement);
    expect(canvases).not.toContain(scratch);
    expect(
      working.renderPage.mock.calls.map((call) => [call[0], call[1] === scratch, call[2].scale]),
    ).toEqual([
      [0, true, 1],
      [1, true, 1],
    ]);
    expect(working.renderPage.mock.calls[0]?.[2]).toMatchObject({ devicePixelRatio: 1 });
    expect(drawing.drawImage.mock.calls).toEqual([
      [scratch, 0, 0, 300, 400],
      [scratch, 0, 410, 300, 400],
    ]);
  });

  it('scales the composite to the device resolution the viewer painted at', async () => {
    mountViewer();
    vi.stubGlobal('devicePixelRatio', 2);
    const { drawing, finish } = installCanvas();
    const { container } = show();
    await finish();
    const preview = container.querySelector('canvas') as HTMLCanvasElement;
    expect([preview.width, preview.height]).toEqual([600, 1620]);
    expect(drawing.drawImage.mock.calls[1]?.slice(1)).toEqual([0, 820, 600, 800]);
    expect(working.renderPage.mock.calls[1]?.[2]).toMatchObject({ scale: 1, devicePixelRatio: 2 });
  });

  it('falls back to one device pixel per pixel when the window reports no ratio', async () => {
    mountViewer();
    vi.stubGlobal('devicePixelRatio', 0);
    const { finish } = installCanvas();
    const { container } = show();
    await finish();
    const preview = container.querySelector('canvas') as HTMLCanvasElement;
    expect([preview.width, preview.height]).toEqual([300, 810]);
  });

  it('names the file after the first page captured and the moment it was taken', async () => {
    mountViewer([{ number: '4', rect: new DOMRect(0, 0, 100, 100) }]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 2, 4, 5, 6, 7));
    const { finish } = installCanvas();
    show();
    await finish();
    const anchors: HTMLAnchorElement[] = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:snapshot');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    fireEvent.click(button('Download PNG'));
    expect(anchors.map((a) => a.download)).toEqual(['snapshot-4-20260304-050607.png']);
  });

  it('composes once per opening, not on every render of the shell', async () => {
    const { toBlob, finish } = installCanvas();
    const { update } = show();
    await finish();
    update({ onNotice: vi.fn(), onClose: vi.fn() });
    expect(toBlob).toHaveBeenCalledOnce();
  });

  it('lets go of the bitmap memory when the panel closes', async () => {
    const { finish } = installCanvas();
    const { container, update } = show();
    await finish();
    const preview = container.querySelector('canvas') as HTMLCanvasElement;
    update({ open: false });
    expect([preview.width, preview.height]).toEqual([0, 0]);
  });

  it('waits for the encoder before offering anything', async () => {
    const { finish } = installCanvas();
    show();
    expect(screen.getByRole('dialog', { name: 'Snapshot' })).toBeTruthy();
    expect(button('Download PNG').disabled).toBe(true);
    await finish();
    expect(button('Download PNG').disabled).toBe(false);
  });

  it('shows nothing from a capture the reader closed before the encoder finished', async () => {
    const { toBlob, finish } = installCanvas();
    const { onNotice, onClose, update } = show();
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledOnce()); // the encoder is running
    update({ open: false });
    await finish();
    expect(toBlob).toHaveBeenCalledOnce();
    expect(onNotice).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('draws the marks the reader has not saved: the pages come from the working bytes, not from the screen', async () => {
    const { finish } = installCanvas();
    show();
    await finish();
    expect(read).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
    expect(engine.open).toHaveBeenCalledExactlyOnceWith(WORKING, { signal: expect.any(AbortSignal) });
    expect(live.renderPage).not.toHaveBeenCalled();
    expect(working.renderPage).toHaveBeenCalledTimes(2);
    // The copy is freed once the picture is composed.
    expect(working.destroy).toHaveBeenCalledOnce();
  });

  it('captures a protected document from the document on screen, which holds no unsaved mark', async () => {
    engine.open.mockRejectedValue(new ToolError('password-required', { engine: 'pdfjs' }));
    const { finish } = installCanvas();
    show();
    await finish();
    expect(live.renderPage).toHaveBeenCalledTimes(2);
    expect(working.renderPage).not.toHaveBeenCalled();
  });

  it('draws nothing and frees the copy when the reader closed the panel while the pages rendered', async () => {
    const gate = Promise.withResolvers<void>();
    working.renderPage.mockImplementationOnce(() => gate.promise);
    const { toBlob, drawing, onNotice, update } = show_with_canvas();
    await vi.waitFor(() => expect(working.renderPage).toHaveBeenCalledTimes(1));
    update({ open: false });
    await act(async () => {
      gate.resolve();
    });
    await vi.waitFor(() => expect(working.destroy).toHaveBeenCalledOnce());
    expect(drawing.drawImage).not.toHaveBeenCalled();
    expect(toBlob).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('stays quiet when the working bytes fail to read because the reader closed the panel', async () => {
    const gate = Promise.withResolvers<Uint8Array>();
    read.mockImplementationOnce(() => gate.promise);
    const { onNotice, onClose, update } = show();
    update({ open: false });
    await act(async () => {
      gate.reject(new Error('aborted'));
    });
    expect(onNotice).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('when there is nothing to capture', () => {
  it.each([
    ['no page is in the viewport', () => mountViewer([{ number: '1', rect: new DOMRect(0, 700, 300, 400) }])],
    [
      'the viewer markup is not on screen',
      () => {
        document.body.innerHTML = '';
      },
    ],
  ])('reports an unexpected failure and closes when %s', async (_name, arrange) => {
    installCanvas();
    arrange();
    const { onNotice, onClose } = show();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Something unexpected went wrong.');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports it when the browser gives no 2D context', async () => {
    installCanvas();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { onNotice, onClose } = show();
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Something unexpected went wrong.');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports it when the encoder produced no image', async () => {
    const { finish } = installCanvas();
    const { onNotice, onClose } = show();
    await finish(null);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Something unexpected went wrong.');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports it when composing throws', async () => {
    installCanvas();
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {
      throw new Error('encoder exploded');
    });
    const { onNotice, onClose } = show();
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Something unexpected went wrong.');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports the reader’s failure and closes, drawing nothing', async () => {
    read.mockRejectedValue(new ToolError('internal', { engine: 'model' }));
    const { drawing } = installCanvas();
    const { onNotice, onClose } = show();
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalled());
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Something unexpected went wrong.');
    expect(onClose).toHaveBeenCalledOnce();
    expect(drawing.drawImage).not.toHaveBeenCalled();
  });
});

describe('download', () => {
  // The faked clock would stall user-event's own waits, so these clicks are dispatched directly.
  it('saves the PNG under its name, tells the reader and closes; the blob URL is revoked after ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 2, 4, 5, 6, 7));
    const { finish } = installCanvas();
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:snapshot-1');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchors: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    const { onNotice, onClose } = show();
    await finish();
    fireEvent.click(button('Download PNG'));
    expect(created).toHaveBeenCalledExactlyOnceWith(PNG);
    expect(anchors.map((a) => [a.href, a.download])).toEqual([
      ['blob:snapshot-1', 'snapshot-1-20260304-050607.png'],
    ]);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Snapshot saved: snapshot-1-20260304-050607.png');
    expect(onClose).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9_999);
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:snapshot-1');
    // The URL is gone from the panel's books: closing now revokes nothing again.
    cleanup();
    expect(revoked).toHaveBeenCalledOnce();
  });

  it('revokes a blob URL still waiting when the panel unmounts, and cancels its timer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { finish } = installCanvas();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:snapshot-2');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { unmount } = show();
    await finish();
    fireEvent.click(button('Download PNG'));
    unmount();
    expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:snapshot-2');
    vi.advanceTimersByTime(20_000);
    expect(revoked).toHaveBeenCalledOnce();
  });
});

describe('copy to the clipboard', () => {
  class FakeClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  }

  /** user-event installs its own clipboard stub on setup, so the page's clipboard is defined after it. */
  function grantClipboard(write = vi.fn(async () => {})) {
    const user = userEvent.setup();
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    return { user, write };
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('writes the PNG as an image item, tells the reader and closes', async () => {
    const { finish } = installCanvas();
    const { user, write } = grantClipboard();
    const { onNotice, onClose } = show();
    await finish();
    await user.click(button('Copy to clipboard'));
    expect(write).toHaveBeenCalledOnce();
    const items = (write.mock.calls[0] as unknown as [FakeClipboardItem[]])[0];
    expect(items).toHaveLength(1);
    expect(items[0]?.items).toEqual({ 'image/png': PNG });
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Snapshot copied to the clipboard.');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('is disabled until the encoder is done', async () => {
    const { finish } = installCanvas();
    grantClipboard();
    show();
    expect(button('Copy to clipboard').disabled).toBe(true);
    await finish();
    expect(button('Copy to clipboard').disabled).toBe(false);
  });

  it('reports a denied permission as such', async () => {
    const { finish } = installCanvas();
    const { user } = grantClipboard(
      vi.fn(async () => {
        throw new DOMException('blocked', 'NotAllowedError');
      }),
    );
    const { onNotice, onClose } = show();
    await finish();
    await user.click(button('Copy to clipboard'));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('File access was denied.');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['another DOM failure', () => new DOMException('quota', 'QuotaExceededError')],
    ['an ordinary error', () => new Error('clipboard unavailable')],
  ])('reports %s as an unexpected failure', async (_name, make) => {
    const { finish } = installCanvas();
    const { user } = grantClipboard(
      vi.fn(async () => {
        throw make();
      }),
    );
    const { onNotice } = show();
    await finish();
    await user.click(button('Copy to clipboard'));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Something unexpected went wrong.');
  });

  it('is absent where the browser has no clipboard item type', async () => {
    const { finish } = installCanvas();
    vi.stubGlobal('ClipboardItem', undefined);
    show();
    await finish();
    expect(screen.queryByRole('button', { name: 'Copy to clipboard' })).toBeNull();
    expect(button('Download PNG').disabled).toBe(false);
  });

  it('is absent where there is a clipboard item type but no async clipboard', async () => {
    const { finish } = installCanvas();
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
    show();
    await finish();
    expect(screen.queryByRole('button', { name: 'Copy to clipboard' })).toBeNull();
  });
});

describe('closing', () => {
  it('closes on Escape before anything else sees it, and ignores other keys', async () => {
    installCanvas();
    const { onClose } = show();
    const behind = vi.fn();
    document.body.addEventListener('keydown', behind);
    const user = userEvent.setup();
    await user.keyboard('a');
    expect(onClose).not.toHaveBeenCalled();
    expect(behind).toHaveBeenCalledOnce();
    behind.mockClear();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(behind).not.toHaveBeenCalled();
  });

  it('closes on a press outside the panel, not inside it, and not for a press with no element', async () => {
    installCanvas();
    const { onClose } = show();
    const user = userEvent.setup();
    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('dialog') });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    expect(onClose).not.toHaveBeenCalled();
    await user.pointer({ keys: '[MouseLeft>]', target: document.body });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stops listening once closed', async () => {
    installCanvas();
    const { onClose, update } = show();
    update({ open: false });
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
