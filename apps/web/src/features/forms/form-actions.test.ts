// @vitest-environment happy-dom
/**
 * What the user does with a form: the exact calls each gesture makes into pdf-core and the
 * session, what the status line says, and which gate refuses a busy document before anything
 * is read.
 */

import type { FormFieldInfo, OperationOutcome } from 'pdf-core';
import type { FieldCandidate, FormDetection } from 'pdf-core/ops/form-detect';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState, setBusy } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import type { WriteFileAnnotation } from '../marks/host';
import {
  applyFormDetect,
  type FormsHost,
  fillField,
  openXfaForm,
  saveXfaForm,
  startFormDetect,
} from './form-actions';
import {
  candidateRemoved,
  currentDetect,
  detectFinished,
  detectStarted,
  type FormDetect,
  formInventoryRead,
  formsStore,
  initialFormsState,
  xfaFormOpened,
} from './forms-store';

const pdfCore = vi.hoisted(() => ({
  materializeBase: vi.fn(),
  applyProducedBytes: vi.fn(),
  fillFormFields: vi.fn(),
  inspectXfa: vi.fn(),
  detectFormFields: vi.fn(),
  createDetectedFields: vi.fn(),
}));
vi.mock('../../operations', () => ({
  materializeBase: pdfCore.materializeBase,
  applyProducedBytes: pdfCore.applyProducedBytes,
}));
vi.mock('../../lazy-ops', () => ({
  fillFormFields: pdfCore.fillFormFields,
  inspectXfa: pdfCore.inspectXfa,
}));
vi.mock('pdf-core/ops/form-detect', () => ({
  detectFormFields: pdfCore.detectFormFields,
  createDetectedFields: pdfCore.createDetectedFields,
}));

const t = createTranslator('en');
const base = new Uint8Array([1, 2, 3]);
const handle = { name: 'handle' } as never;
const produced = { name: 'produced' } as never;

let store: SessionStore;
let tab: SessionTab;
let host: FormsHost;
let running = false;

function bump(): SessionTab {
  store.applyOperation({
    tabId: tab.id,
    bytes: new Uint8Array([9]),
    pageCount: 1,
    labelKey: 'form.note.filled',
    engine: 'mupdf',
    steps: [],
    overlays: null,
  });
  return store.active as SessionTab;
}

function failure(error: ToolError): string {
  return `${t(error.messageKey)} ${t(error.hintKey)}`;
}

function outcome(changed = 2): OperationOutcome & { readonly changed: number } {
  return { bytes: new Uint8Array([7]), report: { engine: 'mupdf', steps: ['form.fill'] }, changed } as never;
}

function field(name: string, value: FormFieldInfo['value']): FormFieldInfo {
  return {
    name,
    kind: 'text',
    value,
    readOnly: false,
    required: false,
    maxLength: null,
    options: null,
    pageIndex: 0,
  };
}

function candidate(id: string): FieldCandidate {
  return { id, name: id, kind: 'text', pageIndex: 0 } as unknown as FieldCandidate;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  formsStore.set(initialFormsState());
  vi.clearAllMocks();
  running = false;
  store = new SessionStore();
  tab = store.openDocument({ name: 'a.pdf', bytes: base, sha256: 'a', pageCount: 1 });
  adoptHandle(tab.id, handle);
  host = {
    store,
    t,
    contextFor: (opened, engine) => ({ store, t, tab: opened, handle: engine }),
    refuseBusy: vi.fn(),
    setHandle: vi.fn(),
    operationRunning: () => running,
  };
  pdfCore.materializeBase.mockResolvedValue(base);
  pdfCore.applyProducedBytes.mockResolvedValue(produced);
});
afterEach(() => {
  dropHandle(tab.id);
});

describe('openXfaForm', () => {
  it('opens the dialog on the bytes of a dynamic XFA form, with the notice cleared and the document free again', async () => {
    pdfCore.inspectXfa.mockResolvedValue({ kind: 'dynamic' });
    coreStore.set({ notice: 'old' });
    const opening = openXfaForm(host);
    expect(coreStore.get()).toMatchObject({ notice: null, busy: true });
    await opening;
    expect(pdfCore.materializeBase).toHaveBeenCalledWith({ store, t, tab, handle });
    expect(pdfCore.inspectXfa).toHaveBeenCalledWith(base);
    expect(formsStore.get().xfaForm).toEqual({ tab, bytes: base });
    expect(coreStore.get().busy).toBe(false);
  });

  it('does nothing without a document or an engine handle', async () => {
    dropHandle(tab.id);
    await openXfaForm(host);
    store.closeTab(tab.id);
    await openXfaForm(host);
    expect(pdfCore.materializeBase).not.toHaveBeenCalled();
    expect(coreStore.get().busy).toBe(false);
  });

  it('refuses while an operation holds the document, or a cancellable one runs', async () => {
    setBusy(true);
    await openXfaForm(host);
    setBusy(false);
    running = true;
    await openXfaForm(host);
    expect(host.refuseBusy).toHaveBeenCalledTimes(2);
    expect(pdfCore.materializeBase).not.toHaveBeenCalled();
  });

  it('says there is no XFA to fill', async () => {
    pdfCore.inspectXfa.mockResolvedValue(null);
    await openXfaForm(host);
    expect(coreStore.get()).toMatchObject({
      notice: failure(new ToolError('no-xfa', { engine: 'mupdf' })),
      busy: false,
    });
    expect(formsStore.get().xfaForm).toBeNull();
  });

  it('says a static XFA cannot be filled here', async () => {
    pdfCore.inspectXfa.mockResolvedValue({ kind: 'static' });
    await openXfaForm(host);
    expect(coreStore.get().notice).toBe(failure(new ToolError('xfa-static', { engine: 'mupdf' })));
    expect(formsStore.get().xfaForm).toBeNull();
  });

  it('words any other failure as an internal one and frees the document', async () => {
    pdfCore.materializeBase.mockRejectedValue(new Error('boom'));
    await openXfaForm(host);
    expect(coreStore.get()).toMatchObject({
      notice: failure(new ToolError('internal', { engine: 'model' })),
      busy: false,
    });
  });

  it('keeps the dialog shut when the version changed, the tab changed or the tab closed while the bytes were read', async () => {
    pdfCore.inspectXfa.mockResolvedValue({ kind: 'dynamic' });
    pdfCore.materializeBase.mockImplementationOnce(async () => {
      bump();
      return base;
    });
    await openXfaForm(host);

    const second = store.openDocument({ name: 'b.pdf', bytes: base, sha256: 'b', pageCount: 1 });
    adoptHandle(second.id, handle);
    store.setActive(tab.id);
    pdfCore.materializeBase.mockImplementationOnce(async () => {
      store.setActive(second.id);
      return base;
    });
    await openXfaForm(host);

    pdfCore.materializeBase.mockImplementationOnce(async () => {
      store.closeTab(second.id);
      store.closeTab(tab.id);
      return base;
    });
    await openXfaForm(host);
    expect(formsStore.get().xfaForm).toBeNull();
    expect(coreStore.get().busy).toBe(false);
    expect(pdfCore.materializeBase).toHaveBeenCalledTimes(3);
    dropHandle(second.id);
  });
});

describe('saveXfaForm', () => {
  it('makes the verified bytes the next working version, closes the dialog and says how many values were saved', async () => {
    xfaFormOpened({ tab, bytes: base });
    const saved = outcome(3);
    await saveXfaForm(saved, host);
    expect(pdfCore.applyProducedBytes).toHaveBeenCalledWith(
      { store, t, tab, handle },
      saved.bytes,
      1,
      { key: 'xfa.note.dataSaved', params: { count: 3 } },
      'mupdf',
      ['form.fill'],
    );
    expect(host.setHandle).toHaveBeenCalledWith(tab.id, produced);
    expect(formsStore.get().xfaForm).toBeNull();
    expect(coreStore.get().notice).toBe(t('xfa.fill.saved', { count: 3 }));
  });

  it('writes nothing when no form is open or its tab lost its handle', async () => {
    await saveXfaForm(outcome(), host);
    xfaFormOpened({ tab, bytes: base });
    dropHandle(tab.id);
    await saveXfaForm(outcome(), host);
    expect(pdfCore.applyProducedBytes).not.toHaveBeenCalled();
    expect(formsStore.get().xfaForm).not.toBeNull();
  });
});

describe('fillField', () => {
  function inventory(fields: readonly FormFieldInfo[]) {
    formInventoryRead({ tabId: tab.id, version: tab.working.id, fields });
  }

  it('writes one value through the fill operation and makes the produced bytes the working version', async () => {
    inventory([field('Name', 'Ada')]);
    pdfCore.fillFormFields.mockResolvedValue(outcome());
    const filling = fillField('Name', 'Grace', host);
    expect(coreStore.get().busy).toBe(true);
    await filling;
    expect(pdfCore.fillFormFields).toHaveBeenCalledWith(base, [{ name: 'Name', value: 'Grace' }], {
      signal: expect.any(AbortSignal),
    });
    expect(pdfCore.applyProducedBytes).toHaveBeenCalledWith(
      { store, t, tab, handle },
      expect.any(Uint8Array),
      1,
      { key: 'form.note.filled', params: { count: 1 } },
      'mupdf',
      ['form.fill'],
    );
    expect(host.setHandle).toHaveBeenCalledWith(tab.id, produced);
    expect(coreStore.get()).toMatchObject({
      notice: t('op.result.applied', { label: t('panel.forms') }),
      busy: false,
    });
  });

  it('writes a field the inventory does not list, and one with no inventory at all', async () => {
    pdfCore.fillFormFields.mockResolvedValue(outcome());
    await fillField('Other', true, host);
    inventory([field('Name', 'Ada')]);
    await fillField('Other', true, host);
    expect(pdfCore.fillFormFields).toHaveBeenCalledTimes(2);
  });

  it('drops a write that repeats the value the document already holds', async () => {
    inventory([field('Name', 'Ada'), field('Pets', ['cat', 'dog']), field('Empty', null)]);
    await fillField('Name', 'Ada', host);
    await fillField('Pets', 'cat, dog', host);
    await fillField('Empty', '', host);
    expect(pdfCore.materializeBase).not.toHaveBeenCalled();
    expect(coreStore.get().busy).toBe(false);
  });

  it('does nothing without a document or an engine handle', async () => {
    dropHandle(tab.id);
    await fillField('Name', 'x', host);
    store.closeTab(tab.id);
    await fillField('Name', 'x', host);
    expect(pdfCore.materializeBase).not.toHaveBeenCalled();
  });

  it('refuses while an operation holds the document', async () => {
    setBusy(true);
    await fillField('Name', 'x', host);
    expect(host.refuseBusy).toHaveBeenCalledOnce();
    expect(pdfCore.materializeBase).not.toHaveBeenCalled();
  });

  it('says why the write failed and frees the document', async () => {
    const error = new ToolError('write-failed', { engine: 'mupdf' });
    pdfCore.fillFormFields.mockRejectedValue(error);
    await fillField('Name', 'x', host);
    expect(coreStore.get()).toMatchObject({ notice: failure(error), busy: false });
    expect(host.setHandle).not.toHaveBeenCalled();
  });
});

describe('startFormDetect', () => {
  it('opens the forms tab, scans the working bytes and shows the candidates for review', async () => {
    const found = { candidates: [candidate('c1')] } as unknown as FormDetection;
    pdfCore.detectFormFields.mockResolvedValue(found);
    coreStore.set({ rightDock: false, rightTab: 'history' });
    const scanning = startFormDetect(host);
    expect(coreStore.get()).toMatchObject({ rightDock: true, rightTab: 'forms' });
    expect(formsStore.get().formDetect).toMatchObject({ phase: 'scanning', version: tab.working.id });
    await scanning;
    expect(pdfCore.detectFormFields).toHaveBeenCalledWith(base, { signal: expect.any(AbortSignal) });
    expect(formsStore.get().formDetect).toMatchObject({ phase: 'review', detection: found });
    expect(coreStore.get().notice).toBeNull();
  });

  it('says so when the detector finds nothing', async () => {
    pdfCore.detectFormFields.mockResolvedValue({ candidates: [] });
    await startFormDetect(host);
    expect(coreStore.get().notice).toBe(t('formDetect.panel.none'));
  });

  it('shows no review for a version that landed while the detector read the old one', async () => {
    pdfCore.materializeBase.mockImplementationOnce(async () => {
      bump();
      return base;
    });
    pdfCore.detectFormFields.mockResolvedValue({ candidates: [candidate('c1')] });
    await startFormDetect(host);
    expect(currentDetect(store.active)).toBeNull();
    expect(formsStore.get().formDetect).toMatchObject({ phase: 'review', version: tab.working.id });
  });

  it('ends the review and says why when the detector fails', async () => {
    const error = new ToolError('write-failed', { engine: 'mupdf' });
    pdfCore.detectFormFields.mockRejectedValue(error);
    await startFormDetect(host);
    expect(formsStore.get().formDetect).toBeNull();
    expect(coreStore.get().notice).toBe(failure(error));
  });

  it('does nothing without a document or an engine handle', async () => {
    dropHandle(tab.id);
    await startFormDetect(host);
    store.closeTab(tab.id);
    await startFormDetect(host);
    expect(pdfCore.materializeBase).not.toHaveBeenCalled();
    expect(formsStore.get().formDetect).toBeNull();
  });

  it('refuses while an operation holds the document, without opening the panel', async () => {
    setBusy(true);
    await startFormDetect(host);
    expect(host.refuseBusy).toHaveBeenCalledOnce();
    expect(coreStore.get().rightTab).toBe('history');
    expect(formsStore.get().formDetect).toBeNull();
  });
});

describe('applyFormDetect', () => {
  const write = vi.fn<WriteFileAnnotation>(() => true);
  const apply = () => applyFormDetect({ store, t, writeFileAnnotation: write });

  function review(...candidates: string[]) {
    detectStarted(tab.id, tab.working.id);
    detectFinished(tab.id, tab.working.id, {
      candidates: candidates.map(candidate),
    } as unknown as FormDetection);
  }

  it('creates the candidates the user kept as one journaled write, then shows the forms tab', async () => {
    review('c1', 'c2', 'c3');
    candidateRemoved('c2');
    coreStore.set({ rightTab: 'history' });
    apply();

    expect(coreStore.get().rightTab).toBe('forms');
    expect(write).toHaveBeenCalledWith(
      { key: 'formDetect.note.created', params: { count: 2 } },
      expect.any(Function),
      t('formDetect.done', { count: 2 }),
    );
    const created = { bytes: new Uint8Array([5]) };
    pdfCore.createDetectedFields.mockResolvedValue(created);
    const signal = new AbortController().signal;
    const run = write.mock.calls[0]?.[1];
    await expect(run?.(base, signal)).resolves.toBe(created);
    expect(pdfCore.createDetectedFields).toHaveBeenCalledWith(base, [candidate('c1'), candidate('c3')], {
      signal,
    });
  });

  it('writes nothing without a finished review or once every candidate was taken out', () => {
    apply();
    detectStarted(tab.id, tab.working.id);
    apply();
    review('c1');
    candidateRemoved('c1');
    apply();
    formsStore.set({
      formDetect: {
        ...(formsStore.get().formDetect as unknown as FormDetect),
        phase: 'scanning',
        removed: new Set(),
      },
    });
    apply();
    expect(write).not.toHaveBeenCalled();
    expect(coreStore.get().rightTab).toBe('history');
  });
});
