/**
 * Preparing the bytes a Save or an Export writes: what stops it (unread facts or forms, unapplied
 * redaction marks, a declined signature warning, a document that moved on) and the exact calls
 * the checked output is built from.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab, sha256Hex } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { prepareOutput } from './prepare-output';

const mocks = vi.hoisted(() => ({
  handleFor: vi.fn(),
  currentFacts: vi.fn(),
  currentFactsError: vi.fn(),
  currentForms: vi.fn(),
  confirmSignature: vi.fn(),
  editableOverlays: vi.fn(),
  pendingOverlays: vi.fn(),
  materializeBase: vi.fn(),
  hasEngineEdits: vi.fn(),
  verifyForWrite: vi.fn(),
  inspectProtection: vi.fn(),
  verifySignatures: vi.fn(),
  signatureWarning: vi.fn(),
  appliedVersionBytes: vi.fn(),
  planSaveExecution: vi.fn(),
}));

vi.mock('../core/handles', () => ({ handleFor: mocks.handleFor }));
vi.mock('../facts/facts-store', () => ({
  currentFacts: mocks.currentFacts,
  currentFactsError: mocks.currentFactsError,
}));
vi.mock('../facts/signature-prompt', () => ({ confirmSignature: mocks.confirmSignature }));
vi.mock('../forms/forms-store', () => ({ currentForms: mocks.currentForms }));
vi.mock('../marks/overlays', () => ({ editableOverlays: mocks.editableOverlays }));
vi.mock('../../operations', () => ({
  pendingOverlays: mocks.pendingOverlays,
  materializeBase: mocks.materializeBase,
  hasEngineEdits: mocks.hasEngineEdits,
  verifyForWrite: mocks.verifyForWrite,
}));
vi.mock('../../lazy-ops', () => ({
  inspectProtection: mocks.inspectProtection,
  verifySignatures: mocks.verifySignatures,
}));
vi.mock('../../save-plan', () => ({
  signatureWarning: mocks.signatureWarning,
  appliedVersionBytes: mocks.appliedVersionBytes,
  planSaveExecution: mocks.planSaveExecution,
}));

const t = ((key: string) => key) as Translator;
const handle = { raw: 'handle' } as unknown as PdfDocumentHandle;
const base = new Uint8Array([9, 8, 7]);
const verification = { state: 'verified', checks: [], declared: [] };
const execution = { plan: { incremental: false }, steps: [], appliedSteps: [] };

let session: SessionStore;
let tab: SessionTab;

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  session = new SessionStore();
  tab = session.openDocument({
    name: 'a.pdf',
    bytes: new Uint8Array([1, 2, 3]),
    sha256: 'source-hash',
    pageCount: 2,
  });
  mocks.handleFor.mockReturnValue(handle);
  mocks.currentFacts.mockReturnValue({ tabId: tab.id });
  mocks.currentFactsError.mockReturnValue(null);
  mocks.currentForms.mockReturnValue({
    tabId: tab.id,
    version: tab.working.id,
    fields: [{ name: 'city', value: 'Ankara' }],
  });
  mocks.editableOverlays.mockReturnValue({ annotations: ['mark'] });
  mocks.pendingOverlays.mockReturnValue({ redactions: [] });
  mocks.materializeBase.mockImplementation(async (_context, _options, steps: { id: string }[]) => {
    steps.push({ id: 'pdfjs.saveDocument' });
    return base;
  });
  mocks.hasEngineEdits.mockReturnValue(true);
  mocks.inspectProtection.mockResolvedValue({ encrypted: false });
  mocks.planSaveExecution.mockReturnValue(execution);
  mocks.appliedVersionBytes.mockReturnValue(null);
  mocks.signatureWarning.mockResolvedValue(null);
  mocks.confirmSignature.mockResolvedValue(true);
  mocks.verifyForWrite.mockResolvedValue(verification);
});

const prepare = (controller = new AbortController(), steps?: { id: string }[]) =>
  prepareOutput({ session, t }, tab.id, controller, steps as never);

describe('prepareOutput: what stops it', () => {
  it('prepares nothing for a tab that is gone or has no engine handle', async () => {
    expect(await prepareOutput({ session, t }, 'gone', new AbortController())).toBeNull();
    mocks.handleFor.mockReturnValue(undefined);
    expect(await prepare()).toBeNull();
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(coreStore.get().notice).toBeNull();
  });

  it('says the inspection is loading while the facts are not read yet', async () => {
    mocks.currentFacts.mockReturnValue(null);
    expect(await prepare()).toBeNull();
    expect(coreStore.get().notice).toBe('inspection.loading');
    expect(mocks.materializeBase).not.toHaveBeenCalled();
  });

  it('says the inspection is loading while the form inventory is not read yet', async () => {
    mocks.currentForms.mockReturnValue(null);
    expect(await prepare()).toBeNull();
    expect(coreStore.get().notice).toBe('inspection.loading');
  });

  it('says the inspection failed when the facts failed to read', async () => {
    mocks.currentFacts.mockReturnValue(null);
    mocks.currentFactsError.mockReturnValue(new Error('facts'));
    expect(await prepare()).toBeNull();
    expect(coreStore.get().notice).toBe('inspection.failed');
  });

  it('says the inspection failed when the form inventory failed to read', async () => {
    mocks.currentForms.mockReturnValue({ tabId: tab.id, version: tab.working.id, error: new Error('forms') });
    expect(await prepare()).toBeNull();
    expect(coreStore.get().notice).toBe('inspection.failed');
  });

  it('refuses while redaction marks are staged and unapplied, before materializing anything', async () => {
    mocks.pendingOverlays.mockReturnValue({ redactions: [{ id: 'mark' }] });
    expect(await prepare()).toBeNull();
    expect(coreStore.get().notice).toBe('error.pending-redactions.message error.pending-redactions.hint');
    expect(mocks.materializeBase).not.toHaveBeenCalled();
  });

  it('stops when the user declines the signature warning', async () => {
    mocks.signatureWarning.mockResolvedValue({ signatures: ['sig'], fate: 'broken' });
    mocks.confirmSignature.mockResolvedValue(false);
    expect(await prepare()).toBeNull();
    expect(mocks.confirmSignature).toHaveBeenCalledWith(['sig'], false, t);
    expect(mocks.verifyForWrite).not.toHaveBeenCalled();
  });

  it('stops when the run was cancelled while the user was asked', async () => {
    const controller = new AbortController();
    mocks.signatureWarning.mockResolvedValue({ signatures: ['sig'], fate: 'appended' });
    mocks.confirmSignature.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    expect(await prepare(controller)).toBeNull();
    expect(mocks.confirmSignature).toHaveBeenCalledWith(['sig'], true, t);
  });

  it('stops when the document moved on to another version while the user was asked', async () => {
    mocks.signatureWarning.mockResolvedValue({ signatures: ['sig'], fate: 'appended' });
    mocks.confirmSignature.mockImplementation(async () => {
      session.setOverlays(tab.id, { annotations: ['newer'] }, 'ann.engineEdit');
      return true;
    });
    expect(await prepare()).toBeNull();
    expect(mocks.verifyForWrite).not.toHaveBeenCalled();
  });
});

describe('prepareOutput: the checked output', () => {
  it('materializes the version, plans the write and verifies the bytes against this run own steps', async () => {
    const controller = new AbortController();
    const steps: { id: string }[] = [];
    const prepared = await prepare(controller, steps);

    expect(prepared).toEqual({
      tab: session.active,
      handle,
      bytes: base,
      outputProtection: { encrypted: false },
      execution,
      outputHash: await sha256Hex(base),
      verification,
    });
    expect(steps).toEqual([{ id: 'pdfjs.saveDocument' }]);
    expect(mocks.materializeBase).toHaveBeenCalledWith(
      { store: session, t, tab: session.active, handle },
      { signal: controller.signal },
      steps,
      { annotations: ['mark'] },
    );
    expect(mocks.planSaveExecution).toHaveBeenCalledWith({
      tab: session.active,
      engineDirty: true,
      annotations: ['mark'],
      baseBytes: base,
      encryptedOutput: false,
      executedSteps: steps,
    });
    expect(mocks.verifyForWrite).toHaveBeenCalledWith(base, {
      expectedPageCount: 2,
      sourceHandle: handle,
      steps: ['pdfjs.saveDocument'],
      expectedFormFields: [{ name: 'city', value: 'Ankara' }],
      signal: controller.signal,
    });
  });

  it('collects the run steps itself when the caller passes none', async () => {
    expect(await prepare()).not.toBeNull();
    expect(mocks.verifyForWrite).toHaveBeenCalledWith(
      base,
      expect.objectContaining({ steps: ['pdfjs.saveDocument'] }),
    );
  });

  it('judges the opened file and the produced version each against its own bytes', async () => {
    const controller = new AbortController();
    mocks.signatureWarning.mockImplementation(async (_base, _master, _produced, verify) => {
      await verify(new Uint8Array([5]));
      return null;
    });
    mocks.verifySignatures.mockResolvedValue([]);
    mocks.appliedVersionBytes.mockReturnValue(new Uint8Array([4]));

    await prepare(controller);
    expect(mocks.signatureWarning).toHaveBeenCalledWith(
      base,
      tab.source.master,
      null,
      expect.any(Function),
      new Uint8Array([4]),
    );
    expect(mocks.verifySignatures).toHaveBeenCalledWith(new Uint8Array([5]), controller.signal, {
      roots: [],
    });
    expect(mocks.appliedVersionBytes).toHaveBeenCalledWith(session.active, session.snapshotsFor(tab.id));

    const produced = new Uint8Array([6, 6]);
    session.applyOperation({
      tabId: tab.id,
      bytes: produced,
      pageCount: 2,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['rotate'],
      overlays: null,
    });
    mocks.currentForms.mockReturnValue({ tabId: tab.id, version: session.active?.working.id, fields: [] });
    mocks.signatureWarning.mockClear();
    await prepare();
    expect(mocks.signatureWarning.mock.calls[0]?.[2]).toEqual(produced);
  });
});
