// @vitest-environment happy-dom
/**
 * What becomes of a produced result: the exact calls the accessibility, scanner and print
 * handlers make into the session, the tab opener, the busy gate and the status line.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import type { ScannedDocument } from 'pdf-ui/scan';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { createResultsActions } from './results-actions';
import { initialResultsState, openPrintDialog, openScanDialog, resultsStore } from './results-store';

const mocks = vi.hoisted(() => ({ applyProducedBytes: vi.fn() }));
vi.mock('../../operations', () => ({ applyProducedBytes: mocks.applyProducedBytes }));

const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`) as unknown as Translator;

const handle = { name: 'handle' } as unknown as PdfDocumentHandle;
const produced = { name: 'produced' } as unknown as PdfDocumentHandle;
const notice = () => coreStore.get().notice;
const busy = () => coreStore.get().busy;

let session: SessionStore;
let tab: SessionTab;
const contextFor = vi.fn((forTab: SessionTab, forHandle: PdfDocumentHandle) => ({
  store: session,
  t,
  tab: forTab,
  handle: forHandle,
}));
const setHandle = vi.fn();
const openProducedTab =
  vi.fn<(name: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<string | null>>();
const openDialog = vi.fn();
const refuseBusy = vi.fn();
const refuseUnappliedRedactions = vi.fn(() => false);
let cancelRef: { current: AbortController | null };

function actions() {
  return createResultsActions({
    session,
    t,
    contextFor: contextFor as never,
    setHandle,
    cancelRef,
    openProducedTab,
    openDialog,
    refuseBusy,
    refuseUnappliedRedactions,
  });
}

const scanned: ScannedDocument = {
  name: 'scan.pdf',
  bytes: new Uint8Array([1, 2]),
  pageCount: 3,
  report: {
    engine: 'mupdf',
    steps: [],
    notes: [],
    inputBytes: 2,
    outputBytes: 2,
    pageCount: 3,
    incremental: false,
  },
  offerOcr: false,
};
const printed = { name: 'booklet.pdf', bytes: new Uint8Array([9]) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  coreStore.set(initialCoreState());
  resultsStore.set(initialResultsState());
  cancelRef = { current: null };
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'hash', pageCount: 4 });
  tab = session.active as SessionTab;
  adoptHandle(tab.id, handle);
  mocks.applyProducedBytes.mockResolvedValue(produced);
  openProducedTab.mockResolvedValue(null);
});
afterEach(() => {
  dropHandle(tab.id);
});

describe('applyAccessibility', () => {
  const outcome = {
    bytes: new Uint8Array([5, 6]),
    notes: [
      { code: 'a', message: 'x' },
      { code: 'b', message: 'y' },
    ] as never,
    steps: ['tagged'],
  };

  it('journals the writer’s bytes on the working version, swaps the handle and counts the notes', async () => {
    await actions().applyAccessibility(outcome);

    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      contextFor.mock.results[0]?.value,
      outcome.bytes,
      4,
      { key: 'a11y.applied', params: { count: 2 } },
      'mupdf',
      ['tagged'],
    );
    expect(contextFor).toHaveBeenCalledWith(tab, handle);
    expect(setHandle).toHaveBeenCalledWith(tab.id, produced);
    expect(notice()).toBe('a11y.applied {"count":2}');
  });

  it('does nothing without an active tab', async () => {
    session.closeTab(tab.id);
    await actions().applyAccessibility(outcome);
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('does nothing when the active tab has no engine handle', async () => {
    dropHandle(tab.id);
    await actions().applyAccessibility(outcome);
    expect(mocks.applyProducedBytes).not.toHaveBeenCalled();
    expect(setHandle).not.toHaveBeenCalled();
  });
});

describe('scanDocument', () => {
  it('opens the scanned pages as a tab, closes the scanner and says how many pages', async () => {
    openScanDialog();
    await expect(actions().scanDocument(scanned)).resolves.toBeUndefined();

    expect(openProducedTab).toHaveBeenCalledWith('scan.pdf', scanned.bytes, expect.any(AbortSignal));
    expect(resultsStore.get().scanOpen).toBe(false);
    expect(notice()).toBe('scan.opened {"count":3,"name":"scan.pdf"}');
    expect(busy()).toBe(false);
    expect(cancelRef.current).toBeNull();
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('appends the stored-copy warning to the success line', async () => {
    openProducedTab.mockResolvedValue('copy not stored');
    await actions().scanDocument(scanned);
    expect(notice()).toBe('scan.opened {"count":3,"name":"scan.pdf"} copy not stored');
  });

  it('offers OCR on the new tab once the busy gate is released', async () => {
    vi.useFakeTimers();
    await actions().scanDocument({ ...scanned, offerOcr: true });

    expect(openDialog).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(openDialog).toHaveBeenCalledWith('ocr');
  });

  it('returns the busy sentence to the dialog while another operation holds the gate', async () => {
    setBusy(true);
    await expect(actions().scanDocument(scanned)).resolves.toBe('op.busy');
    expect(openProducedTab).not.toHaveBeenCalled();
    expect(busy()).toBe(true);
  });

  it('returns the busy sentence while a run owns the abort controller', async () => {
    cancelRef.current = new AbortController();
    await expect(actions().scanDocument(scanned)).resolves.toBe('op.busy');
    expect(openProducedTab).not.toHaveBeenCalled();
  });

  it('returns the failure to the dialog, keeps the scanner open and releases the gate', async () => {
    openScanDialog();
    openProducedTab.mockRejectedValue(new ToolError('file-too-large', { engine: 'model' }));

    const failure = await actions().scanDocument({ ...scanned, offerOcr: true });

    expect(failure).toBe('error.file-too-large.message {} error.file-too-large.hint {}');
    expect(resultsStore.get().scanOpen).toBe(true);
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('says nothing when the run was cancelled while the tab was opening', async () => {
    openProducedTab.mockImplementation(async () => {
      cancelRef.current?.abort();
      throw new ToolError('aborted', { engine: 'model' });
    });
    await expect(actions().scanDocument(scanned)).resolves.toBeUndefined();
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('leaves the gate to whoever took the controller over', async () => {
    openProducedTab.mockImplementation(async () => {
      cancelRef.current = null;
      return null;
    });
    await actions().scanDocument(scanned);
    expect(busy()).toBe(true);
  });
});

describe('printProduced', () => {
  it('opens the imposed file as a tab and closes the dialog without a notice', async () => {
    openPrintDialog();
    await actions().printProduced(printed);

    expect(openProducedTab).toHaveBeenCalledWith('booklet.pdf', printed.bytes, expect.any(AbortSignal));
    expect(resultsStore.get().printOpen).toBe(false);
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
    expect(cancelRef.current).toBeNull();
  });

  it('says the stored-copy warning when there is one', async () => {
    openProducedTab.mockResolvedValue('copy not stored');
    await actions().printProduced(printed);
    expect(notice()).toBe('copy not stored');
  });

  it('refuses with the busy notice while another operation holds the gate', async () => {
    setBusy(true);
    await actions().printProduced(printed);
    expect(refuseBusy).toHaveBeenCalledOnce();
    expect(openProducedTab).not.toHaveBeenCalled();
  });

  it('refuses with the busy notice while a run owns the abort controller', async () => {
    cancelRef.current = new AbortController();
    await actions().printProduced(printed);
    expect(refuseBusy).toHaveBeenCalledOnce();
    expect(openProducedTab).not.toHaveBeenCalled();
  });

  it('opens nothing while a redaction mark is unapplied', async () => {
    refuseUnappliedRedactions.mockReturnValueOnce(true);
    openPrintDialog();
    await actions().printProduced(printed);
    expect(openProducedTab).not.toHaveBeenCalled();
    expect(refuseBusy).not.toHaveBeenCalled();
    expect(resultsStore.get().printOpen).toBe(true);
    expect(busy()).toBe(false);
  });

  it('reports a failure on the notice line, keeps the dialog open and releases the gate', async () => {
    openPrintDialog();
    openProducedTab.mockRejectedValue(new Error('boom'));

    await actions().printProduced(printed);

    expect(notice()).toBe('error.internal.message {}');
    expect(resultsStore.get().printOpen).toBe(true);
    expect(busy()).toBe(false);
  });

  it('says nothing when the run was cancelled while the tab was opening', async () => {
    openProducedTab.mockImplementation(async () => {
      cancelRef.current?.abort();
      throw new ToolError('aborted', { engine: 'model' });
    });
    await actions().printProduced(printed);
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('leaves the gate to whoever took the controller over', async () => {
    openProducedTab.mockImplementation(async () => {
      cancelRef.current = null;
      return null;
    });
    await actions().printProduced(printed);
    expect(busy()).toBe(true);
  });
});
