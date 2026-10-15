// @vitest-environment happy-dom
/**
 * What the shell knows about a document's forms: every inventory is tagged with the tab and
 * the key of the bytes (and typed values) it was read from and a reader only sees the one that
 * matches the tab it asks about, through a mark step but not through a byte operation or a
 * typed value;
 * the detector's review follows one version and ends with it; the picks and toggles the
 * panels make.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { ExistingAnnotation, FormFieldInfo } from 'pdf-core';
import type { FormDetection } from 'pdf-core/ops/form-detect';
import { type EngineValuesDraft, type JsonValue, SessionStore, type SessionTab } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  candidateRemoved,
  candidateSelected,
  candidatesRestored,
  currentDetect,
  currentForms,
  detectCancelled,
  detectFinished,
  detectOf,
  detectStarted,
  existingAnnotationsOf,
  existingInventoryRead,
  existingInventoryUnknown,
  fieldSelected,
  formInventoryKey,
  formInventoryRead,
  formInventoryReading,
  formsOf,
  formsStore,
  initialFormsState,
  retryInspection,
  toggleXfaDetails,
  useCurrentDetect,
  useCurrentForms,
  useCurrentXfa,
  useExistingAnnotations,
  useForms,
  xfaFormClosed,
  xfaFormOpened,
} from './forms-store';

const bytes = new Uint8Array([1, 2, 3]);
const annotations = [{ id: 'a1' }] as unknown as readonly ExistingAnnotation[];
const fields = [{ name: 'Name' }] as unknown as readonly FormFieldInfo[];
const detection = { candidates: [{ id: 'c1' }, { id: 'c2' }] } as unknown as FormDetection;

function openTab(store = new SessionStore()): SessionTab {
  return store.openDocument({ name: 'a.pdf', bytes, sha256: 'a', pageCount: 1 });
}

/** The tab after an operation landed: a new working version with produced bytes. */
function produce(store: SessionStore, tab: SessionTab): SessionTab {
  store.applyOperation({
    tabId: tab.id,
    bytes: new Uint8Array([4, 5]),
    pageCount: 1,
    labelKey: 'form.note.filled',
    engine: 'mupdf',
    steps: [],
    overlays: null,
  });
  return store.active as SessionTab;
}

beforeEach(() => formsStore.set(initialFormsState()));
afterEach(cleanup);

describe('the initial state', () => {
  it('has read nothing and reviews nothing', () => {
    expect(formsStore.get()).toEqual({
      existingInventory: null,
      formInventory: null,
      inspectionRevision: 0,
      selectedField: null,
      formDetect: null,
      xfaDetailsOpen: false,
      xfaForm: null,
    });
  });
});

describe('the annotations the file carries', () => {
  it('belong to the bytes they were read for, not to the working version', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations });
    expect(existingAnnotationsOf(formsStore.get().existingInventory, tab)).toBe(annotations);

    // An overlay-only step mints a new working id but not new bytes: the inventory stays true.
    store.setOverlays(tab.id, { marks: 1 }, 'form.note.filled');
    const drawn = store.active as SessionTab;
    expect(drawn.working.id).not.toBe(tab.working.id);
    expect(existingAnnotationsOf(formsStore.get().existingInventory, drawn)).toBe(annotations);
    const produced = produce(store, tab);
    expect(existingAnnotationsOf(formsStore.get().existingInventory, produced)).toBeNull();
    existingInventoryRead({ tabId: tab.id, bytesKey: produced.working.produced?.id as string, annotations });
    expect(existingAnnotationsOf(formsStore.get().existingInventory, produced)).toBe(annotations);
  });

  it('are unknown for another tab, with no tab or no inventory, and once the read failed', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const other = openTab(store);
    expect(existingAnnotationsOf(null, tab)).toBeNull();
    existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations });
    const inventory = formsStore.get().existingInventory;
    expect(existingAnnotationsOf(inventory, null)).toBeNull();
    expect(existingAnnotationsOf(inventory, other)).toBeNull();
    existingInventoryUnknown();
    expect(formsStore.get().existingInventory).toBeNull();
  });

  it('are read by a component for the tab it shows', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = renderHook(({ shown }) => useExistingAnnotations(shown), { initialProps: { shown: tab } });
    expect(view.result.current).toBeNull();
    act(() => existingInventoryRead({ tabId: tab.id, bytesKey: 'source', annotations }));
    expect(view.result.current).toBe(annotations);
    view.rerender({ shown: null as never });
    expect(view.result.current).toBeNull();
  });
});

/** What the engine holds for a typed form value, as the session journals it. */
function typed(value: string): EngineValuesDraft {
  return { entries: [{ key: 'pdfjs_internal_id_12R', value: { value } }], dropped: 0 };
}

/** The overlays of a step that carries `values` and, perhaps, a mark. */
function withValues(values: EngineValuesDraft, annotations: readonly object[] = []): JsonValue {
  return { engineValues: values, annotations, measures: [], redactions: [] } as unknown as JsonValue;
}

describe('what a form inventory is keyed to', () => {
  it('is the bytes alone while nothing is typed, whatever marks the overlays carry', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    expect(formInventoryKey(tab)).toBe('source');
    store.setOverlays(tab.id, { annotations: [{ id: 'm1' }], measures: [], redactions: [] }, 'ann.transform');
    expect(formInventoryKey(store.active as SessionTab)).toBe('source');
    const produced = produce(store, tab);
    expect(formInventoryKey(produced)).toBe(produced.working.produced?.id);
  });

  it('adds the typed values to the bytes, and tells another value apart', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    store.setOverlays(tab.id, withValues(typed('Acme')), 'ann.engineEdit');
    expect(formInventoryKey(store.active as SessionTab)).toBe(`source#${JSON.stringify(typed('Acme'))}`);
    store.setOverlays(tab.id, withValues(typed('Acme Ltd')), 'ann.engineEdit');
    expect(formInventoryKey(store.active as SessionTab)).toBe(`source#${JSON.stringify(typed('Acme Ltd'))}`);
  });

  it('serializes one draft once, however often it is asked for', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    store.setOverlays(tab.id, withValues(typed('Acme')), 'ann.engineEdit');
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const keys = [1, 2, 3].map(() => formInventoryKey(store.active as SessionTab));
      expect(new Set(keys).size).toBe(1);
      expect(stringify).toHaveBeenCalledTimes(1);
    } finally {
      stringify.mockRestore();
    }
  });
});

describe('the form inventory', () => {
  it('is only the one read for the current version of the tab asked about', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const other = openTab(store);
    expect(formsOf(null, tab)).toBeNull();

    formInventoryReading(tab);
    expect(currentForms(tab)).toEqual({ tabId: tab.id, key: formInventoryKey(tab) });
    formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields, xfa: null });
    expect(currentForms(tab)?.fields).toBe(fields);
    expect(currentForms(other)).toBeNull();
    expect(currentForms(null)).toBeNull();

    const next = produce(store, tab);
    expect(currentForms(next)).toBeNull();
  });

  it('is cleared when there is nothing to read', () => {
    const tab = openTab();
    formInventoryReading(tab);
    formInventoryReading(null);
    expect(formsStore.get().formInventory).toBeNull();
  });

  it('keeps a failed read with its reason', () => {
    const tab = openTab();
    const error = new ToolError('internal', { engine: 'model' });
    formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), error });
    expect(currentForms(tab)?.error).toBe(error);
  });

  it('is read by a component, which renders again when the version changes', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = renderHook(({ shown }) => useCurrentForms(shown), { initialProps: { shown: tab } });
    expect(view.result.current).toBeNull();
    act(() => formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields }));
    expect(view.result.current?.fields).toBe(fields);
    view.rerender({ shown: produce(store, tab) });
    expect(view.result.current).toBeNull();
  });

  it('is still the inventory of a tab after a mark step, which changes no byte and types no value', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields });

    store.setOverlays(tab.id, { annotations: [{ id: 'm1' }], measures: [], redactions: [] }, 'ann.transform');
    const marked = store.active as SessionTab;
    expect(marked.working.id).not.toBe(tab.working.id);
    expect(currentForms(marked)?.fields).toBe(fields);

    store.setOverlays(tab.id, { annotations: [], measures: [], redactions: [] }, 'ann.transform');
    expect(currentForms(store.active)?.fields).toBe(fields);
    store.undo(tab.id);
    expect(currentForms(store.active)?.fields).toBe(fields);
  });

  it('is read again for another produced version, even one a mark step came after', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields });

    const produced = produce(store, tab);
    expect(currentForms(produced)).toBeNull();
    formInventoryRead({ tabId: tab.id, key: formInventoryKey(produced), fields });
    store.setOverlays(tab.id, { annotations: [{ id: 'm1' }], measures: [], redactions: [] }, 'ann.transform');
    expect(currentForms(store.active)?.fields).toBe(fields);

    store.undo(tab.id);
    store.undo(tab.id);
    expect(currentForms(store.active)).toBeNull();
  });

  it('is read again when a value is typed into a field of the engine, which the bytes do not carry yet', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields });

    const acme = typed('Acme');
    store.setOverlays(tab.id, withValues(acme), 'ann.engineEdit');
    const typing = store.active as SessionTab;
    expect(currentForms(typing)).toBeNull();
    formInventoryRead({ tabId: tab.id, key: formInventoryKey(typing), fields });
    expect(currentForms(typing)?.fields).toBe(fields);

    // A mark drawn after the typing carries the same values over: still the inventory read for them.
    store.setOverlays(tab.id, withValues(acme, [{ id: 'm1' }]), 'ann.transform');
    expect(currentForms(store.active)?.fields).toBe(fields);

    // The next keystroke is another value, and the typing taken back is the earlier state again.
    store.setOverlays(tab.id, withValues(typed('Acme Ltd'), [{ id: 'm1' }]), 'ann.engineEdit');
    expect(currentForms(store.active)).toBeNull();
    store.undo(tab.id);
    expect(currentForms(store.active)?.fields).toBe(fields);
  });

  it('reads the XFA description alone: the inventory starting or ending to be read renders nothing', () => {
    const tab = openTab();
    const xfa = {
      kind: 'static',
      layout: 'array',
      packets: [],
      hasTemplate: true,
      hasDatasets: false,
      fieldCount: 0,
    };
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useCurrentXfa(tab);
    });
    expect(view.result.current).toBeNull();
    const before = renders;
    act(() => formInventoryReading(tab));
    act(() => formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields }));
    expect(renders).toBe(before);
    act(() => formInventoryRead({ tabId: tab.id, key: formInventoryKey(tab), fields, xfa } as never));
    expect(view.result.current).toBe(xfa);
  });

  it('counts the retries', () => {
    retryInspection();
    retryInspection();
    expect(formsStore.get().inspectionRevision).toBe(2);
    const view = renderHook(() => useForms((state) => state.inspectionRevision));
    expect(view.result.current).toBe(2);
  });
});

describe('the panel picks', () => {
  it('remembers the picked field', () => {
    fieldSelected('Name');
    expect(formsStore.get().selectedField).toBe('Name');
  });

  it('opens and closes the XFA details', () => {
    toggleXfaDetails();
    expect(formsStore.get().xfaDetailsOpen).toBe(true);
    toggleXfaDetails();
    expect(formsStore.get().xfaDetailsOpen).toBe(false);
  });

  it('holds the XFA form until it is closed', () => {
    const tab = openTab();
    xfaFormOpened({ tab, bytes });
    expect(formsStore.get().xfaForm).toEqual({ tab, bytes });
    xfaFormClosed();
    expect(formsStore.get().xfaForm).toBeNull();
  });
});

describe('the detector review', () => {
  it('starts scanning one version and becomes a review when the result lands', () => {
    const tab = openTab();
    detectStarted(tab.id, tab.working.id);
    expect(currentDetect(tab)).toEqual({
      tabId: tab.id,
      version: tab.working.id,
      phase: 'scanning',
      detection: null,
      removed: new Set(),
      selectedId: null,
    });
    detectFinished(tab.id, tab.working.id, detection);
    expect(currentDetect(tab)).toMatchObject({ phase: 'review', detection });
  });

  it('drops a result for a review that was cancelled, replaced or already finished', () => {
    const tab = openTab();
    detectFinished(tab.id, tab.working.id, detection);
    expect(formsStore.get().formDetect).toBeNull();

    detectStarted(tab.id, tab.working.id);
    detectCancelled();
    detectFinished(tab.id, tab.working.id, detection);
    expect(formsStore.get().formDetect).toBeNull();

    detectStarted(tab.id, 'older-version');
    detectFinished(tab.id, tab.working.id, detection);
    expect(formsStore.get().formDetect?.phase).toBe('scanning');

    detectStarted('other-tab', tab.working.id);
    detectFinished(tab.id, tab.working.id, detection);
    expect(formsStore.get().formDetect?.phase).toBe('scanning');

    detectStarted(tab.id, tab.working.id);
    detectFinished(tab.id, tab.working.id, detection);
    const finished = formsStore.get().formDetect;
    detectFinished(tab.id, tab.working.id, { candidates: [] } as unknown as FormDetection);
    expect(formsStore.get().formDetect).toBe(finished);
  });

  it('is only the review of the current version of the tab asked about', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const other = openTab(store);
    expect(detectOf(null, tab)).toBeNull();
    detectStarted(tab.id, tab.working.id);
    expect(currentDetect(tab)).not.toBeNull();
    expect(currentDetect(other)).toBeNull();
    expect(currentDetect(null)).toBeNull();
    expect(currentDetect(produce(store, tab))).toBeNull();
  });

  it('selects, removes and restores candidates', () => {
    const tab = openTab();
    detectStarted(tab.id, tab.working.id);
    detectFinished(tab.id, tab.working.id, detection);
    candidateSelected('c2');
    candidateRemoved('c1');
    expect(currentDetect(tab)).toMatchObject({ selectedId: 'c2', removed: new Set(['c1']) });
    candidateRemoved('c2');
    expect(currentDetect(tab)?.removed).toEqual(new Set(['c1', 'c2']));
    candidatesRestored();
    expect(currentDetect(tab)?.removed).toEqual(new Set());
  });

  it('ignores picks when nothing is under review', () => {
    candidateSelected('c1');
    candidateRemoved('c1');
    candidatesRestored();
    expect(formsStore.get().formDetect).toBeNull();
  });

  it('is read by a component, which renders again when the review ends', () => {
    const store = new SessionStore();
    const tab = openTab(store);
    const view = renderHook(() => useCurrentDetect(tab));
    expect(view.result.current).toBeNull();
    act(() => detectStarted(tab.id, tab.working.id));
    expect(view.result.current?.phase).toBe('scanning');
    act(() => detectCancelled());
    expect(view.result.current).toBeNull();
  });
});
