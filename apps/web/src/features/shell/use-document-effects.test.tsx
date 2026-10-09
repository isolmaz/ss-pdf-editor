// @vitest-environment happy-dom
/** What follows the document on screen without drawing anything. */

import { renderHook } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentContext } from '../../operations';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { currentMarkTargets, initialMarksState, marksStore } from '../marks/marks-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { documentTitle, PRODUCT_TITLE, useDocumentEffects } from './use-document-effects';

const hooks = vi.hoisted(() => ({
  useDocumentLanguage: vi.fn(),
  useFormInventory: vi.fn(),
  useStoredTrust: vi.fn(),
  useDocumentFacts: vi.fn(),
  useTextToolBytes: vi.fn(),
  usePublishExistingAnnotations: vi.fn(),
  useSelectionEffects: vi.fn(),
}));
vi.mock('../reading/use-document-language', () => ({ useDocumentLanguage: hooks.useDocumentLanguage }));
vi.mock('../forms/use-form-inventory', () => ({ useFormInventory: hooks.useFormInventory }));
vi.mock('../facts/trust-store', () => ({ useStoredTrust: hooks.useStoredTrust }));
vi.mock('../facts/use-document-facts', () => ({ useDocumentFacts: hooks.useDocumentFacts }));
vi.mock('../selection/use-text-tool-bytes', () => ({ useTextToolBytes: hooks.useTextToolBytes }));
vi.mock('../annotations/use-annotation-actions', () => ({
  usePublishExistingAnnotations: hooks.usePublishExistingAnnotations,
}));
vi.mock('../selection/use-selection', () => ({ useSelectionEffects: hooks.useSelectionEffects }));

const t = createTranslator('en');
const handle = { id: 'h' } as unknown as PdfDocumentHandle;
const contextFor = (tab: SessionTab, h: PdfDocumentHandle): DocumentContext =>
  ({ tab, handle: h }) as unknown as DocumentContext;
let session: SessionStore;

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  marksStore.set(initialMarksState());
  session = new SessionStore();
});

function open(name: string) {
  return session.openDocument({ name, bytes: new Uint8Array([1]), sha256: name, pageCount: 1 });
}

describe('documentTitle', () => {
  it('is the product name with no document', () => {
    expect(documentTitle(null, t)).toBe(PRODUCT_TITLE);
  });

  it('is the document name, and says so when there are unsaved changes', () => {
    const tab = open('contract.pdf');
    expect(documentTitle({ ...tab, dirty: false }, t)).toBe('contract.pdf');
    expect(documentTitle({ ...tab, dirty: true }, t)).toBe(`contract.pdf — ${t('tab.dirty')}`);
  });
});

describe('useDocumentEffects', () => {
  it('names the window after the active document', () => {
    const tab = open('contract.pdf');
    const { rerender } = renderHook(
      ({ current }: { current: SessionTab | null }) =>
        useDocumentEffects({ session, t, tab: current, handle, contextFor }),
      { initialProps: { current: null as SessionTab | null } },
    );
    expect(document.title).toBe(PRODUCT_TITLE);
    rerender({ current: tab });
    expect(document.title).toBe('contract.pdf');
  });

  it('runs the document readers on the tab and handle it is given', () => {
    const tab = open('a.pdf');
    const viewer = { document: handle } as unknown as ViewerApi;
    viewerChanged(viewer);
    renderHook(() => useDocumentEffects({ session, t, tab, handle, contextFor }));
    expect(hooks.useDocumentLanguage).toHaveBeenCalledWith(viewer);
    expect(hooks.useFormInventory).toHaveBeenCalledWith({ store: session, t, tab, handle });
    expect(hooks.useStoredTrust).toHaveBeenCalled();
    expect(hooks.useDocumentFacts).toHaveBeenCalledWith(
      expect.objectContaining({ tab, handle, revision: 0 }),
    );
    expect(hooks.useTextToolBytes).toHaveBeenCalledWith(tab, handle, contextFor, t);
    expect(hooks.usePublishExistingAnnotations).toHaveBeenCalledWith(null);
  });

  it('publishes no targets while the file inventory is unread, and keeps the select tool as the mark mode', () => {
    const tab = open('a.pdf');
    renderHook(() => useDocumentEffects({ session, t, tab, handle, contextFor }));
    expect(currentMarkTargets()).toEqual([]);
    expect(hooks.useSelectionEffects).toHaveBeenLastCalledWith({
      markMode: 'select',
      tabId: tab.id,
      existing: null,
      targets: [],
    });
  });

  it('has no mark mode while another tool is armed, and no tab id with no document', () => {
    selectTool('ink');
    renderHook(() => useDocumentEffects({ session, t, tab: null, handle: null, contextFor }));
    expect(hooks.useSelectionEffects).toHaveBeenLastCalledWith(
      expect.objectContaining({ markMode: null, tabId: undefined }),
    );
  });
});
