/**
 * Embedded files: what the properties panel lists, and the exact calls the add / remove / read-out
 * handlers and the attachments panel's write make into the engine, the session and the status line.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { createAttachmentActions, measuredAttachments } from './attachments';

const mocks = vi.hoisted(() => ({
  listPdfAttachments: vi.fn(),
  readPdfAttachment: vi.fn(),
  addAttachments: vi.fn(),
  removeAttachments: vi.fn(),
  materializeBase: vi.fn(),
  applyProducedBytes: vi.fn(),
  downloadFiles: vi.fn(),
}));

vi.mock('pdf-core/attachments', () => ({
  listPdfAttachments: mocks.listPdfAttachments,
  readPdfAttachment: mocks.readPdfAttachment,
}));
vi.mock('../../lazy-ops', () => ({
  addAttachments: mocks.addAttachments,
  removeAttachments: mocks.removeAttachments,
}));
vi.mock('../../operations', () => ({
  materializeBase: mocks.materializeBase,
  applyProducedBytes: mocks.applyProducedBytes,
  downloadFiles: mocks.downloadFiles,
}));

const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`) as unknown as Translator;

const handle = { name: 'handle' } as unknown as PdfDocumentHandle;
const produced = { name: 'produced' } as unknown as PdfDocumentHandle;
const base = new Uint8Array([1, 2, 3]);
const report = { engine: 'mupdf', steps: ['step'], incremental: false, notes: [], pageCount: 1 };
const notice = () => coreStore.get().notice;

function file(name: string, content: string, type: string): File {
  return new File([content], name, { type });
}

let session: SessionStore;
let tab: SessionTab;
const contextFor = vi.fn((forTab: SessionTab, forHandle: PdfDocumentHandle) => ({
  store: session,
  t,
  tab: forTab,
  handle: forHandle,
}));
const setHandle = vi.fn();
const applyWriterOutcome = vi.fn(() => Promise.resolve());

function actions() {
  return createAttachmentActions({
    session,
    t,
    contextFor: contextFor as never,
    setHandle,
    applyWriterOutcome,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'hash', pageCount: 4 });
  tab = session.active as SessionTab;
  adoptHandle(tab.id, handle);
  mocks.materializeBase.mockResolvedValue(base);
  mocks.applyProducedBytes.mockResolvedValue(produced);
});
afterEach(() => {
  dropHandle(tab.id);
});

describe('measuredAttachments', () => {
  it('lists each embedded file with the byte length of its payload, unreadable ones as null', async () => {
    const first = { filename: 'a.txt', description: 'first' };
    const second = { filename: 'b.bin', description: '' };
    mocks.listPdfAttachments.mockResolvedValue([first, second]);
    mocks.readPdfAttachment.mockImplementation((_handle: unknown, entry: unknown) =>
      entry === first ? Promise.resolve(new Uint8Array(7)) : Promise.reject(new Error('unreadable')),
    );

    await expect(measuredAttachments(handle, new AbortController().signal)).resolves.toEqual([
      { name: 'a.txt', description: 'first', size: 7 },
      { name: 'b.bin', description: '', size: null },
    ]);
    expect(mocks.listPdfAttachments).toHaveBeenCalledWith(handle);
    expect(mocks.readPdfAttachment).toHaveBeenCalledWith(handle, first);
  });

  it('stops reading payloads once the caller has aborted', async () => {
    const controller = new AbortController();
    mocks.listPdfAttachments.mockResolvedValue([
      { filename: 'a.txt', description: '' },
      { filename: 'b.txt', description: '' },
    ]);
    mocks.readPdfAttachment.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(new Uint8Array(2));
    });

    await expect(measuredAttachments(handle, controller.signal)).resolves.toEqual([
      { name: 'a.txt', description: '', size: 2 },
    ]);
    expect(mocks.readPdfAttachment).toHaveBeenCalledTimes(1);
  });
});

describe('adding files from the properties panel', () => {
  it('embeds the picked files, mounts the produced bytes and says how many were added', async () => {
    mocks.addAttachments.mockResolvedValue({ bytes: new Uint8Array([9]), added: ['a', 'b'], report });

    await actions().addToDocument([file('a.txt', 'hello', 'text/plain'), file('b.bin', 'xy', '')]);

    expect(mocks.materializeBase).toHaveBeenCalledWith({ store: session, t, tab, handle });
    expect(mocks.addAttachments).toHaveBeenCalledWith(
      base,
      [
        { name: 'a.txt', bytes: new TextEncoder().encode('hello'), mime: 'text/plain' },
        { name: 'b.bin', bytes: new TextEncoder().encode('xy'), mime: 'application/octet-stream' },
      ],
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      { store: session, t, tab, handle },
      new Uint8Array([9]),
      4,
      { key: 'props.attach.added', params: { count: 2 } },
      'mupdf',
      ['step'],
    );
    expect(setHandle).toHaveBeenCalledWith(tab.id, produced);
    expect(notice()).toBe('props.attach.added {"count":2}');
    expect(coreStore.get().busy).toBe(false);
  });

  it('holds the busy gate while it works', async () => {
    let release: (value: Uint8Array) => void = () => undefined;
    mocks.materializeBase.mockReturnValue(new Promise<Uint8Array>((resolve) => (release = resolve)));
    mocks.addAttachments.mockResolvedValue({ bytes: base, added: ['a'], report });

    const running = actions().addToDocument([file('a.txt', 'x', 'text/plain')]);
    expect(coreStore.get().busy).toBe(true);
    release(base);
    await running;
    expect(coreStore.get().busy).toBe(false);
  });

  it('does nothing for an empty pick, without a tab, or without a handle', async () => {
    await actions().addToDocument([]);
    dropHandle(tab.id);
    await actions().addToDocument([file('a.txt', 'x', 'text/plain')]);
    adoptHandle(tab.id, handle);
    session.closeTab(tab.id);
    await actions().addToDocument([file('a.txt', 'x', 'text/plain')]);

    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
    expect(coreStore.get().busy).toBe(false);
  });

  it('refuses while another operation holds the document', async () => {
    coreStore.set({ busy: true });
    await actions().addToDocument([file('a.txt', 'x', 'text/plain')]);

    expect(notice()).toBe('op.busy');
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(coreStore.get().busy).toBe(true);
  });

  it('says why a tool failure happened and releases the gate', async () => {
    mocks.addAttachments.mockRejectedValue(new ToolError('write-failed', { engine: 'mupdf' }));
    const failure = new ToolError('write-failed', { engine: 'mupdf' });

    await actions().addToDocument([file('a.txt', 'x', 'text/plain')]);

    expect(notice()).toBe(`${failure.messageKey} ${failure.hintKey}`);
    expect(setHandle).not.toHaveBeenCalled();
    expect(coreStore.get().busy).toBe(false);
  });

  it('reports anything unexpected as an internal failure', async () => {
    mocks.materializeBase.mockRejectedValue(new Error('boom'));
    const internal = new ToolError('internal', { engine: 'model' });

    await actions().addToDocument([file('a.txt', 'x', 'text/plain')]);

    expect(notice()).toBe(`${internal.messageKey} ${internal.hintKey}`);
    expect(coreStore.get().busy).toBe(false);
  });
});

describe('removing a file from the properties panel', () => {
  it('drops the named file, mounts the produced bytes and says how many were removed', async () => {
    mocks.removeAttachments.mockResolvedValue({
      bytes: new Uint8Array([8]),
      removed: ['a.txt'],
      missing: [],
      report,
    });

    await actions().removeFromDocument('a.txt');

    expect(mocks.removeAttachments).toHaveBeenCalledWith(base, ['a.txt'], {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.applyProducedBytes).toHaveBeenCalledWith(
      { store: session, t, tab, handle },
      new Uint8Array([8]),
      4,
      { key: 'props.attach.removed', params: { count: 1 } },
      'mupdf',
      ['step'],
    );
    expect(setHandle).toHaveBeenCalledWith(tab.id, produced);
    expect(notice()).toBe('props.attach.removed {"count":1}');
    expect(coreStore.get().busy).toBe(false);
  });

  it('says so when the named file was not in the document', async () => {
    mocks.removeAttachments.mockResolvedValue({ bytes: base, removed: [], missing: ['gone.txt'], report });

    await actions().removeFromDocument('gone.txt');

    expect(notice()).toBe('props.attach.missing {"count":1}');
  });

  it('does nothing without a tab, and is refused while busy', async () => {
    coreStore.set({ busy: true });
    await actions().removeFromDocument('a.txt');
    expect(notice()).toBe('op.busy');

    coreStore.set({ busy: false, notice: null });
    dropHandle(tab.id);
    await actions().removeFromDocument('a.txt');
    expect(notice()).toBeNull();
    expect(mocks.removeAttachments).not.toHaveBeenCalled();
  });

  it('says why a failure happened and releases the gate', async () => {
    mocks.removeAttachments.mockRejectedValue(new Error('boom'));
    const internal = new ToolError('internal', { engine: 'model' });

    await actions().removeFromDocument('a.txt');

    expect(notice()).toBe(`${internal.messageKey} ${internal.hintKey}`);
    expect(coreStore.get().busy).toBe(false);
  });
});

describe('reading one file out', () => {
  it('downloads the payload of the named file and says which one', async () => {
    const wanted = { filename: 'b.txt', description: '' };
    const payload = new Uint8Array([4, 5]);
    mocks.listPdfAttachments.mockResolvedValue([{ filename: 'a.txt', description: '' }, wanted]);
    mocks.readPdfAttachment.mockResolvedValue(payload);

    await actions().readOut('b.txt');

    expect(mocks.readPdfAttachment).toHaveBeenCalledWith(handle, wanted);
    expect(mocks.downloadFiles).toHaveBeenCalledWith([
      { name: 'b.txt', bytes: payload, mime: 'application/octet-stream' },
    ]);
    expect(notice()).toBe('props.attach.readNamed {"name":"b.txt"}');
    expect(coreStore.get().busy).toBe(false);
  });

  it('reads out even while another operation holds the document', async () => {
    coreStore.set({ busy: true });
    mocks.listPdfAttachments.mockResolvedValue([{ filename: 'a.txt', description: '' }]);
    mocks.readPdfAttachment.mockResolvedValue(new Uint8Array(1));

    await actions().readOut('a.txt');

    expect(mocks.downloadFiles).toHaveBeenCalledTimes(1);
    expect(coreStore.get().busy).toBe(true);
  });

  it('does nothing for a name the document does not carry, or without a handle', async () => {
    mocks.listPdfAttachments.mockResolvedValue([{ filename: 'a.txt', description: '' }]);
    await actions().readOut('missing.txt');
    dropHandle(tab.id);
    await actions().readOut('a.txt');

    expect(mocks.readPdfAttachment).not.toHaveBeenCalled();
    expect(mocks.downloadFiles).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('says why when the list or the payload cannot be read', async () => {
    const internal = new ToolError('internal', { engine: 'model' });
    mocks.listPdfAttachments.mockRejectedValue(new Error('boom'));

    await actions().readOut('a.txt');

    expect(notice()).toBe(`${internal.messageKey} ${internal.hintKey}`);
    expect(mocks.downloadFiles).not.toHaveBeenCalled();
  });
});

describe('the attachments panel’s write', () => {
  it('embeds the picked files through the shared writer pipeline, keeping the browser’s type', async () => {
    const outcome = { bytes: new Uint8Array([9]), added: ['a'], report };
    mocks.addAttachments.mockResolvedValue(outcome);

    await actions().write({ add: [file('a.txt', 'hi', ''), file('b.txt', 'yo', 'text/plain')] });

    expect(mocks.materializeBase).toHaveBeenCalledWith(
      { store: session, t, tab, handle },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.addAttachments).toHaveBeenCalledWith(
      base,
      [
        { name: 'a.txt', bytes: new TextEncoder().encode('hi'), mime: '' },
        { name: 'b.txt', bytes: new TextEncoder().encode('yo'), mime: 'text/plain' },
      ],
      { signal: expect.any(AbortSignal) },
    );
    expect(applyWriterOutcome).toHaveBeenCalledWith(tab, handle, outcome, 'panel.attachments');
    expect(coreStore.get().busy).toBe(false);
  });

  it('drops the named files through the shared writer pipeline', async () => {
    const outcome = { bytes: new Uint8Array([9]), removed: ['a.txt', 'b.txt'], missing: [], report };
    mocks.removeAttachments.mockResolvedValue(outcome);

    await actions().write({ remove: ['a.txt', 'b.txt'] });

    expect(mocks.removeAttachments).toHaveBeenCalledWith(base, ['a.txt', 'b.txt'], {
      signal: expect.any(AbortSignal),
    });
    expect(applyWriterOutcome).toHaveBeenCalledWith(tab, handle, outcome, 'panel.attachments');
  });

  it('writes nothing for an empty request, and releases the gate', async () => {
    await actions().write({});
    await actions().write({ add: [], remove: [] });

    expect(mocks.addAttachments).not.toHaveBeenCalled();
    expect(mocks.removeAttachments).not.toHaveBeenCalled();
    expect(applyWriterOutcome).not.toHaveBeenCalled();
    expect(coreStore.get().busy).toBe(false);
  });

  it('does nothing without a handle, and is refused while busy', async () => {
    coreStore.set({ busy: true });
    await actions().write({ remove: ['a.txt'] });
    expect(notice()).toBe('op.busy');

    coreStore.set({ busy: false, notice: null });
    dropHandle(tab.id);
    await actions().write({ remove: ['a.txt'] });
    expect(mocks.materializeBase).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('says why a failure happened and releases the gate', async () => {
    const failure = new ToolError('write-failed', { engine: 'mupdf' });
    mocks.removeAttachments.mockRejectedValue(failure);

    await actions().write({ remove: ['a.txt'] });

    expect(notice()).toBe(`${failure.messageKey} ${failure.hintKey}`);
    expect(applyWriterOutcome).not.toHaveBeenCalled();
    expect(coreStore.get().busy).toBe(false);
  });
});
