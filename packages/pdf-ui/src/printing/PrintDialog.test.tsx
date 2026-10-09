// @vitest-environment happy-dom
/**
 * The print dialog on a fake engine document: which pages each range choice selects, what the browser
 * path renders and when the dialog closes, what the produce path hands `buildPrintDocument` and the
 * shell, and the sentences it shows for a refused range, a failed page and a refused imposition.
 * `usePrinting` is the real hook; the imposition is replaced by a recorder, as in its own tests.
 */

import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { PrintDialog, type PrintDialogProps } from './PrintDialog';

const impose = vi.hoisted(() => ({
  calls: [] as Array<{ bytes: Uint8Array; options: Record<string, unknown> }>,
  gate: null as Promise<void> | null,
  failure: null as Error | null,
  progress: [] as Array<{ done?: number; total?: number }>,
}));

vi.mock('pdf-core/ops/impose', () => ({
  buildPrintDocument: async (
    bytes: Uint8Array,
    options: Record<string, unknown>,
    context: { onProgress: (progress: { done?: number; total?: number }) => void },
  ) => {
    impose.calls.push({ bytes, options });
    for (const step of impose.progress) context.onProgress(step);
    await impose.gate;
    if (impose.failure !== null) throw impose.failure;
    return { bytes: new Uint8Array([1, 2, 3]) };
  },
}));

const t = createTranslator('en');

// Every wait here is for a real condition (pages rendered, a job reporting progress, an alert) that
// resolves on its own; the 1 s default of `findBy`/`waitFor` only races a busy machine.
configure({ asyncUtilTimeout: 20000 });

// The tests that choose several options drive a dozen real interactions on a dialog that re-renders its
// whole form each time (about a second alone); a loaded CI core takes several times that.
vi.setConfig({ testTimeout: 30000 });

let user: ReturnType<typeof userEvent.setup>;

interface FakeSource {
  readonly pageCount: number;
  readonly getPageSize: Mock;
  readonly renderPage: Mock;
  readonly saveDocument: Mock;
}

const SAVED = new Uint8Array([9, 9]);

let source: FakeSource;
let blobGate: Promise<void> | null;
let printCalls: number;

beforeEach(() => {
  // No inter-action timer yield: each action is already awaited.
  user = userEvent.setup({ delay: null });
  source = {
    pageCount: 3,
    getPageSize: vi.fn(async () => ({ width: 300, height: 400 })),
    renderPage: vi.fn(async () => undefined),
    saveDocument: vi.fn(async () => SAVED),
  };
  blobGate = null;
  printCalls = 0;
  impose.calls.length = 0;
  impose.gate = null;
  impose.failure = null;
  impose.progress = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => {
    void (async () => {
      await blobGate;
      done(new Blob(['png'], { type: 'image/png' }));
    })();
  });
  let urls = 0;
  URL.createObjectURL = () => `blob:sheet-${++urls}`;
  URL.revokeObjectURL = () => undefined;
  HTMLImageElement.prototype.decode = async () => undefined;
  window.print = () => {
    printCalls += 1;
  };
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
});

function props(overrides: Partial<PrintDialogProps> = {}): PrintDialogProps {
  return {
    t,
    viewer: { document: source } as unknown as ViewerApi,
    open: true,
    onClose: vi.fn(),
    ...overrides,
  };
}

function show(overrides: Partial<PrintDialogProps> = {}) {
  const given = props(overrides);
  const view = render(<PrintDialog {...given} />);
  return { given, view };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const printed = () => source.renderPage.mock.calls.map((call) => call[0]);

/** The viewer DOM `currentViewPages` reads: pages 1–4, of which the scroll box shows 2 and 3. */
function paintViewer() {
  const scroller = document.body.appendChild(document.createElement('div'));
  const rect = (top: number, bottom: number) => () => ({ top, bottom }) as DOMRect;
  scroller.getBoundingClientRect = rect(100, 300);
  const viewer = scroller.appendChild(document.createElement('div'));
  viewer.className = 'pdfViewer';
  viewer.setAttribute('data-active-viewer', '');
  for (const [number, top, bottom] of [
    [1, 0, 100],
    [3, 200, 300],
    [2, 100, 200],
    [4, 300, 400],
  ] as const) {
    const page = viewer.appendChild(document.createElement('div'));
    page.className = 'page';
    page.setAttribute('data-page-number', String(number));
    page.getBoundingClientRect = rect(top, bottom);
  }
  // A page element without a usable number is not a page of the document.
  const stray = viewer.appendChild(document.createElement('div'));
  stray.className = 'page';
  stray.setAttribute('data-page-number', '0');
  stray.getBoundingClientRect = rect(150, 250);
}

describe('PrintDialog shell', () => {
  it('renders nothing while closed', () => {
    show({ open: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the choices with their defaults', () => {
    show();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Print', { selector: '[id]' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All pages' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Fit to page' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '1' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('combobox', { name: 'Two-sided (duplex)' }).textContent).toBe('Single-sided');
    expect((screen.getByRole('spinbutton', { name: 'Margins (mm)' }) as HTMLInputElement).value).toBe('0');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Print').disabled).toBe(false);
  });

  it('cannot print or produce without an engine document, and has no produce action without a place for it', () => {
    show({ viewer: null, onProduced: vi.fn() });
    expect(button('Print').disabled).toBe(true);
    expect(button('Generate Printable PDF').disabled).toBe(true);
    cleanup();
    show();
    expect(screen.queryByRole('button', { name: 'Generate Printable PDF' })).toBeNull();
  });

  it('closes from Cancel and from Escape', async () => {
    const { given } = show();
    await user.click(button('Cancel'));
    expect(given.onClose).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(given.onClose).toHaveBeenCalledTimes(2));
  });
});

describe('PrintDialog printing', () => {
  it('prints every page and closes once the browser has printed', async () => {
    const { given } = show();
    await user.click(button('Print'));
    await waitFor(() => expect(printCalls).toBe(1));
    expect(printed()).toEqual([0, 1, 2]);
    expect(given.onClose).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(given.onClose).toHaveBeenCalledTimes(1);
  });

  it('prints the pages the viewer shows for the current view', async () => {
    paintViewer();
    show();
    await user.click(screen.getByRole('radio', { name: 'Current view' }));
    await user.click(button('Print'));
    await waitFor(() => expect(printCalls).toBe(1));
    expect(printed()).toEqual([1, 2]);
  });

  it('refuses a current view with nothing in it, in the dialog and the shell notice', async () => {
    const onNotice = vi.fn();
    show({ onNotice });
    await user.click(screen.getByRole('radio', { name: 'Current view' }));
    await user.click(button('Print'));
    expect((await screen.findByRole('alert')).textContent).toBe('No pages in the selected range.');
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('No pages in the selected range.');
    expect(source.renderPage).not.toHaveBeenCalled();
    // Choosing again takes the sentence away.
    await user.click(screen.getByRole('radio', { name: 'All pages' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a document without pages the same way, without a notice channel', async () => {
    source = { ...source, pageCount: 0 };
    show({ viewer: { document: source } as unknown as ViewerApi });
    await user.click(button('Print'));
    expect((await screen.findByRole('alert')).textContent).toBe('No pages in the selected range.');
  });

  it('prints a typed range, with Enter as well as the button', async () => {
    show();
    await user.click(screen.getByRole('radio', { name: 'Range' }));
    const field = screen.getByRole('textbox', { name: 'Page range' }) as HTMLInputElement;
    expect(field.placeholder).toBe('e.g. 1-3, 5, 8-10');
    await user.type(field, '3, 1');
    expect(field.value).toBe('3, 1');
    await user.click(button('Print'));
    await waitFor(() => expect(printCalls).toBe(1));
    expect(printed()).toEqual([0, 2]);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });

    await user.clear(field);
    await user.type(field, '2{Enter}');
    await waitFor(() => expect(printCalls).toBe(2));
    expect(printed()).toEqual([0, 2, 1]);
  });

  it('does nothing when Enter is pressed in the range field without an engine document', async () => {
    const onNotice = vi.fn();
    show({ viewer: null, onNotice });
    await user.click(screen.getByRole('radio', { name: 'Range' }));
    await user.type(screen.getByRole('textbox', { name: 'Page range' }), '1{Enter}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(onNotice).not.toHaveBeenCalled();
    expect(printCalls).toBe(0);
  });

  it('ignores other keys in the range field', async () => {
    show();
    await user.click(screen.getByRole('radio', { name: 'Range' }));
    await user.type(screen.getByRole('textbox', { name: 'Page range' }), '2');
    expect(source.renderPage).not.toHaveBeenCalled();
  });

  it('names the unreadable token of a range and tells the shell', async () => {
    const onNotice = vi.fn();
    show({ onNotice });
    await user.click(screen.getByRole('radio', { name: 'Range' }));
    const field = screen.getByRole('textbox', { name: 'Page range' });
    await user.type(field, '1, x');
    await user.click(button('Print'));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read the range: x');
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Could not read the range: x');
    // Editing the field takes the sentence away.
    await user.type(field, 'y');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses an empty range', async () => {
    const onNotice = vi.fn();
    show({ onNotice });
    await user.click(screen.getByRole('radio', { name: 'Range' }));
    await user.click(button('Print'));
    expect((await screen.findByRole('alert')).textContent).toBe('No pages in the selected range.');
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('No pages in the selected range.');
    expect(source.renderPage).not.toHaveBeenCalled();
  });

  it('reports the progress, blocks a second start and keeps the dialog open on Escape while pages render', async () => {
    const gate = Promise.withResolvers<void>();
    blobGate = gate.promise;
    const { given } = show();
    await user.click(button('Print'));
    expect((await screen.findByRole('status')).textContent).toBe('Preparing pages: 0/3');
    expect(button('Print').disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(given.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(printCalls).toBe(1));
  });

  it('cancelling while pages render stops the job and closes', async () => {
    const gate = Promise.withResolvers<void>();
    blobGate = gate.promise;
    const { given } = show();
    await user.click(button('Print'));
    await screen.findByRole('status');
    await user.click(button('Cancel'));
    expect(given.onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve();
    });
    expect(printCalls).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names the page that could not be rendered, in the dialog and the shell notice', async () => {
    source.getPageSize.mockImplementation(async (index: number) => {
      if (index === 1) throw new Error('render failed');
      return { width: 300, height: 400 };
    });
    const onNotice = vi.fn();
    show({ onNotice });
    await user.click(button('Print'));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read the range: 2');
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Could not read the range: 2');
    expect(printCalls).toBe(0);
  });

  it('shows a failed page without a notice channel', async () => {
    source.getPageSize.mockRejectedValue(new Error('render failed'));
    show();
    await user.click(button('Print'));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read the range: 1');
  });
});

describe('PrintDialog producing', () => {
  it('imposes the chosen pages and hands the file to the shell', async () => {
    const onProduced = vi.fn();
    const onNotice = vi.fn();
    show({ onProduced, onNotice });
    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(onProduced).toHaveBeenCalledTimes(1));
    expect(onProduced).toHaveBeenCalledWith({ name: 'print.pdf', bytes: new Uint8Array([1, 2, 3]) });
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Print file ready: print.pdf');
    expect(impose.calls).toHaveLength(1);
    expect(impose.calls[0]?.bytes).toBe(SAVED);
    expect(impose.calls[0]?.options).toEqual({
      pages: [0, 1, 2],
      perSheet: 1,
      booklet: false,
      duplex: 'simplex',
      marginMm: 0,
      paper: 'a4',
      landscape: false,
      cropMarks: false,
      scale: 'fit',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('produces without a notice channel', async () => {
    const onProduced = vi.fn();
    show({ onProduced });
    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(onProduced).toHaveBeenCalledTimes(1));
  });

  it('passes every choice of the form to the imposition', async () => {
    const onProduced = vi.fn();
    show({ onProduced });
    await user.click(screen.getByRole('radio', { name: 'Shrink oversized pages' }));
    await user.click(screen.getByRole('radio', { name: '9' }));
    const margin = screen.getByRole('spinbutton', { name: 'Margins (mm)' }) as HTMLInputElement;
    await user.clear(margin);
    expect(margin.value).toBe('0');
    await user.type(margin, '7');
    expect(margin.value).toBe('7');
    await user.click(screen.getByRole('combobox', { name: 'Two-sided (duplex)' }));
    await user.click(await screen.findByRole('option', { name: 'Flip on long edge' }));
    expect(screen.getByRole('combobox', { name: 'Two-sided (duplex)' }).textContent).toBe(
      'Flip on long edge',
    );
    await user.click(screen.getByRole('combobox', { name: 'Two-sided (duplex)' }));
    await user.click(await screen.findByRole('option', { name: 'Flip on short edge' }));
    expect(screen.getByRole('combobox', { name: 'Two-sided (duplex)' }).textContent).toBe(
      'Flip on short edge',
    );

    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(onProduced).toHaveBeenCalledTimes(1));
    expect(impose.calls[0]?.options).toMatchObject({
      perSheet: 9,
      booklet: false,
      duplex: 'short-edge',
      marginMm: 7,
      scale: 'shrink-to-fit',
    });
  });

  it('a booklet replaces the sheet grid with four pages per sheet', async () => {
    const onProduced = vi.fn();
    show({ onProduced });
    await user.click(screen.getByRole('radio', { name: '16' }));
    expect(screen.getByText(t('print.duplexHint'))).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Booklet (imposition)' }));
    expect(screen.queryByRole('radio', { name: '16' })).toBeNull();
    expect(screen.queryByText(t('print.duplexHint'))).toBeNull();
    expect(screen.getByText(t('print.bookletHint'))).toBeTruthy();
    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(onProduced).toHaveBeenCalledTimes(1));
    expect(impose.calls[0]?.options).toMatchObject({ perSheet: 4, booklet: true });
  });

  it('produces only the typed range, and not at all for a refused one', async () => {
    const onProduced = vi.fn();
    show({ onProduced });
    await user.click(screen.getByRole('radio', { name: 'Range' }));
    await user.type(screen.getByRole('textbox', { name: 'Page range' }), 'q');
    await user.click(button('Generate Printable PDF'));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read the range: q');
    expect(impose.calls).toEqual([]);
    expect(onProduced).not.toHaveBeenCalled();

    await user.clear(screen.getByRole('textbox', { name: 'Page range' }));
    await user.type(screen.getByRole('textbox', { name: 'Page range' }), '2-3');
    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(onProduced).toHaveBeenCalledTimes(1));
    expect(impose.calls[0]?.options).toMatchObject({ pages: [1, 2] });
  });

  it('shows the progress of the imposition and keeps the dialog open on Escape while it runs', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    impose.progress = [{ done: 1, total: 3 }];
    const onProduced = vi.fn();
    const { given } = show({ onProduced });
    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Preparing sheets: 1/3'));
    expect(button('Generate Printable PDF').disabled).toBe(true);
    expect(button('Print').disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(given.onClose).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(onProduced).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('delivers nothing when the job is cancelled before the file is built', async () => {
    const gate = Promise.withResolvers<Uint8Array>();
    source.saveDocument.mockImplementation(() => gate.promise);
    const onProduced = vi.fn();
    const onNotice = vi.fn();
    const { given } = show({ onProduced, onNotice });
    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(source.saveDocument).toHaveBeenCalledTimes(1));
    await user.click(button('Cancel'));
    expect(given.onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve(SAVED);
    });
    expect(impose.calls).toEqual([]);
    expect(onProduced).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('states what a refused imposition got wrong, with its hint, in the dialog and the shell notice', async () => {
    impose.failure = new ToolError('value-out-of-range', { engine: 'pdf-core' });
    const onProduced = vi.fn();
    const onNotice = vi.fn();
    show({ onProduced, onNotice });
    await user.click(button('Generate Printable PDF'));
    const expected = `${t('error.value-out-of-range.message')} ${t('error.value-out-of-range.hint')}`;
    expect((await screen.findByRole('alert')).textContent).toBe(expected);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(expected);
    expect(onProduced).not.toHaveBeenCalled();

    // The next attempt starts clean.
    impose.failure = null;
    await user.click(button('Generate Printable PDF'));
    await waitFor(() => expect(onProduced).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports an unexpected failure with the internal error sentence', async () => {
    impose.failure = new Error('boom');
    show({ onProduced: vi.fn() });
    await user.click(button('Generate Printable PDF'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      `${t('error.internal.message')} ${t('error.internal.hint')}`,
    );
  });
});
