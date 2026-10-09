// @vitest-environment happy-dom
/** What follows the document on screen without drawing anything. */

import { act, cleanup, render, renderHook } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { useEffect, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { existingInventoryRead, formsStore, initialFormsState } from '../forms/forms-store';
import { fileAnnotation } from '../marks/marks-fixtures';
import { currentMarkTargets, initialMarksState, marksStore } from '../marks/marks-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { DocumentEffects, documentTitle, PRODUCT_TITLE, useDocumentEffects } from './use-document-effects';

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
let session: SessionStore;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  marksStore.set(initialMarksState());
  formsStore.set(initialFormsState());
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
        useDocumentEffects({ session, t, tab: current, handle }),
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
    renderHook(() => useDocumentEffects({ session, t, tab, handle }));
    expect(hooks.useDocumentLanguage).toHaveBeenCalledWith(viewer);
    expect(hooks.useFormInventory).toHaveBeenCalledWith({ store: session, t, tab, handle });
    expect(hooks.useStoredTrust).toHaveBeenCalled();
    expect(hooks.useDocumentFacts).toHaveBeenCalledWith(
      expect.objectContaining({ tab, handle, revision: 0 }),
    );
    expect(hooks.useTextToolBytes).toHaveBeenCalledWith(session, tab, handle, t);
    expect(hooks.usePublishExistingAnnotations).toHaveBeenCalledWith(null);
  });

  it('publishes no targets while the file inventory is unread, and keeps the select tool as the mark mode', () => {
    const tab = open('a.pdf');
    renderHook(() => useDocumentEffects({ session, t, tab, handle }));
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
    renderHook(() => useDocumentEffects({ session, t, tab: null, handle: null }));
    expect(hooks.useSelectionEffects).toHaveBeenLastCalledWith(
      expect.objectContaining({ markMode: null, tabId: undefined }),
    );
  });
});

describe('the order the document effects run in', () => {
  /** Each mocked hook registers the effect it stands for, so the log is the commit's effect order. */
  function record(log: string[]): void {
    const passive = (name: string) => () => {
      useEffect(() => {
        log.push(name);
      });
    };
    hooks.useDocumentLanguage.mockImplementation(passive('language'));
    hooks.useFormInventory.mockImplementation(passive('inventory'));
    hooks.useStoredTrust.mockImplementation(passive('trust'));
    hooks.useDocumentFacts.mockImplementation(passive('facts'));
    hooks.useTextToolBytes.mockImplementation(passive('text bytes'));
    hooks.useSelectionEffects.mockImplementation(passive('selection'));
    hooks.usePublishExistingAnnotations.mockImplementation(() => {
      useLayoutEffect(() => {
        log.push('existing annotations');
      });
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const hook of Object.values(hooks)) hook.mockReset();
  });

  it('publishes the file annotations, then the targets, before any passive effect, and keeps the readers in their old order', () => {
    const log: string[] = [];
    record(log);
    marksStore.subscribe(() => log.push('targets'));
    vi.spyOn(document, 'title', 'set').mockImplementation(() => {
      log.push('title');
    });
    const tab = open('a.pdf');
    // A list that differs from the published one: an unchanged list is not published at all.
    existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations: [fileAnnotation('e1')] });
    renderHook(() => useDocumentEffects({ session, t, tab, handle }));
    expect(log).toEqual([
      'existing annotations',
      'targets',
      'language',
      'title',
      'inventory',
      'trust',
      'facts',
      'text bytes',
      'selection',
    ]);
  });

  it('never lets an effect or a handler read targets older than the render that committed', () => {
    const seen: { readonly published: unknown; readonly handed: unknown }[] = [];
    let handed: unknown;
    hooks.useSelectionEffects.mockImplementation((input: { readonly targets: unknown }) => {
      handed = input.targets;
      useEffect(() => {
        seen.push({ published: currentMarkTargets(), handed });
      });
    });
    const tab = open('a.pdf');
    const { rerender } = renderHook(() => useDocumentEffects({ session, t, tab, handle }));
    // The file's annotations being read is a new input of the derivation: the list is rebuilt and published again.
    act(() => {
      viewerChanged({ document: handle, pageGeometry: () => null } as unknown as ViewerApi);
      existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations: [fileAnnotation('e1')] });
    });
    rerender();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const entry of seen) expect(entry.published).toBe(entry.handed);
    expect(seen[0]?.handed).not.toBe(seen[seen.length - 1]?.handed);
  });
});

describe('DocumentEffects', () => {
  it('runs the effects for the active tab and its engine handle, and draws nothing', () => {
    const tab = open('a.pdf');
    adoptHandle(tab.id, handle);
    const { container } = render(<DocumentEffects session={session} tier="desktop" t={t} />);
    expect(container.innerHTML).toBe('');
    expect(hooks.useTextToolBytes).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ id: tab.id }),
      handle,
      t,
    );
    expect(document.title).toBe('a.pdf');
    dropHandle(tab.id);
  });
});
