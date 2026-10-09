// @vitest-environment happy-dom
/**
 * What the export dialog's choice starts, where the context menu opens, and how the working
 * bytes are read: the exact calls made into the shell's opener, the PDF download and the
 * materialiser.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { OperationContext } from 'pdf-core/ops/types';
import { SessionStore, type SessionTab } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptHandle, dropHandle } from '../core/handles';
import { editableOverlays } from '../marks/overlays';
import { createCurrentBytes, createExportChoice, showContextMenu } from './export-actions';
import { exportStore, initialExportState } from './export-store';

const mocks = vi.hoisted(() => ({ materializeBase: vi.fn() }));
vi.mock('../../operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../operations')>()),
  materializeBase: mocks.materializeBase,
}));

beforeEach(() => {
  vi.clearAllMocks();
  exportStore.set(initialExportState());
});

describe('createExportChoice', () => {
  const openDialog = vi.fn();
  const exportActive = vi.fn(() => Promise.resolve());
  const choose = createExportChoice({ openDialog, exportActive });

  it('downloads the PDF itself for the PDF choice and opens no form', () => {
    choose({ kind: 'pdf' });
    expect(exportActive).toHaveBeenCalledTimes(1);
    expect(openDialog).not.toHaveBeenCalled();
  });

  it.each([
    ['high' as const, { mode: 'raster', dpi: 110, quality: 0.5 }],
    ['medium' as const, { mode: 'structure', stripMetadata: true }],
    ['low' as const, { mode: 'structure', stripMetadata: false }],
    [undefined, { mode: 'structure', stripMetadata: false }],
  ])('opens the Optimize form filled for the %s compression level', (compressionLevel, presets) => {
    choose(
      compressionLevel === undefined ? { kind: 'compressed' } : { kind: 'compressed', compressionLevel },
    );
    expect(openDialog).toHaveBeenCalledWith('compress', presets);
    expect(exportActive).not.toHaveBeenCalled();
  });

  it('opens the images form starting from the format the dialog chose', () => {
    choose({ kind: 'images', imageFormat: 'jpg' });
    expect(openDialog).toHaveBeenLastCalledWith('export-images', { format: 'jpeg' });
    choose({ kind: 'images', imageFormat: 'png' });
    expect(openDialog).toHaveBeenLastCalledWith('export-images', { format: 'png' });
    choose({ kind: 'images' });
    expect(openDialog).toHaveBeenLastCalledWith('export-images', { format: 'png' });
  });

  it('opens the text form with no starting values', () => {
    choose({ kind: 'text' });
    expect(openDialog).toHaveBeenCalledWith('export-text');
  });

  it('opens the office form with the layout only while Word is the format', () => {
    choose({ kind: 'office', officeFormat: 'docx', officeLayout: 'flow' });
    expect(openDialog).toHaveBeenLastCalledWith('export-office', { format: 'docx', layout: 'flow' });
    choose({ kind: 'office' });
    expect(openDialog).toHaveBeenLastCalledWith('export-office', { format: 'docx', layout: 'layout' });
    choose({ kind: 'office', officeFormat: 'xlsx', officeLayout: 'page-images' });
    expect(openDialog).toHaveBeenLastCalledWith('export-office', { format: 'xlsx' });
    choose({ kind: 'office', officeFormat: 'csv' });
    expect(openDialog).toHaveBeenLastCalledWith('export-office', { format: 'csv' });
  });
});

describe('showContextMenu', () => {
  afterEach(() => vi.restoreAllMocks());

  it('swallows the browser menu and opens ours at the pointer with the trimmed selection', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '  some words \n' } as Selection);
    const preventDefault = vi.fn();
    showContextMenu({ preventDefault, clientX: 40, clientY: 60 });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(exportStore.get().contextMenu).toEqual({
      x: 40,
      y: 60,
      hasSelection: true,
      selectedText: 'some words',
    });
  });

  it('records no selection when the browser has none', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(null);
    showContextMenu({ preventDefault: vi.fn(), clientX: 1, clientY: 2 });
    expect(exportStore.get().contextMenu).toEqual({ x: 1, y: 2, hasSelection: false, selectedText: '' });
  });

  it('records no selection when the selected text is only whitespace', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '   ' } as Selection);
    showContextMenu({ preventDefault: vi.fn(), clientX: 5, clientY: 6 });
    expect(exportStore.get().contextMenu).toEqual({ x: 5, y: 6, hasSelection: false, selectedText: '' });
  });
});

describe('createCurrentBytes', () => {
  const handle = { name: 'handle' } as unknown as PdfDocumentHandle;
  const operation: OperationContext = { signal: new AbortController().signal };
  let session: SessionStore;
  let tab: SessionTab;
  const contextFor = vi.fn((forTab: SessionTab, forHandle: PdfDocumentHandle) => ({
    tab: forTab,
    handle: forHandle,
  }));

  beforeEach(() => {
    session = new SessionStore();
  });
  afterEach(() => dropHandle(tab?.id ?? ''));

  function open() {
    session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'hash', pageCount: 2 });
    tab = session.active as SessionTab;
  }

  it('materialises the live tab on its live handle, with the pending overlays', async () => {
    open();
    adoptHandle(tab.id, handle);
    const bytes = new Uint8Array([9]);
    mocks.materializeBase.mockResolvedValue(bytes);

    const read = createCurrentBytes({ session, contextFor: contextFor as never });

    await expect(read(operation)).resolves.toBe(bytes);
    expect(contextFor).toHaveBeenCalledWith(tab, handle);
    expect(mocks.materializeBase).toHaveBeenCalledWith(
      { tab, handle },
      operation,
      undefined,
      editableOverlays(tab),
    );
  });

  it('refuses when no document is open', async () => {
    tab = undefined as never;
    const read = createCurrentBytes({ session, contextFor: contextFor as never });
    await expect(read(operation)).rejects.toMatchObject({ code: 'selection-empty' });
    await expect(read(operation)).rejects.toBeInstanceOf(ToolError);
    expect(mocks.materializeBase).not.toHaveBeenCalled();
  });

  it('refuses when the open document has no engine handle', async () => {
    open();
    const read = createCurrentBytes({ session, contextFor: contextFor as never });
    await expect(read(operation)).rejects.toMatchObject({ code: 'selection-empty' });
    expect(mocks.materializeBase).not.toHaveBeenCalled();
  });
});
