// @vitest-environment happy-dom
/**
 * How a document comes in: the exact calls the open handlers make into the engine, the
 * session, the recovery storage, the recent list, the busy gate and the status line.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { cancelOperation, coreStore, initialCoreState, operationRunning, setBusy } from '../core/core-store';
import { dropHandle, handleFor } from '../core/handles';
import { persistenceStore } from '../persistence/persistence-store';
import { type MemoryStorage, manifest, memoryStorage } from '../persistence/vault.fixtures';
import { createOpenActions, fileInput, openAndFingerprint } from './open-actions';
import { initialOpenState, openStore, selectPages, showStartScreen } from './open-store';

const outside = vi.hoisted(() => ({
  openWithPdfjs: vi.fn(),
  convertToPdf: vi.fn(),
  imagesToPdf: vi.fn(),
  addRecentDocument: vi.fn(),
  putRecentHandle: vi.fn(),
  getRecentHandle: vi.fn(),
  reopenFromHandle: vi.fn(),
}));
vi.mock('pdf-core/engines/pdfjs-handle', () => ({ openWithPdfjs: outside.openWithPdfjs }));
vi.mock('pdf-model', async (original) => ({
  ...(await original<typeof import('pdf-model')>()),
  sha256Hex: vi.fn(async () => 'sha'),
}));
vi.mock('../../lazy-ops', () => ({
  convertToPdf: outside.convertToPdf,
  imagesToPdf: outside.imagesToPdf,
}));
vi.mock('../../recent', () => ({ addRecentDocument: outside.addRecentDocument }));
vi.mock('../../recent-handles', () => ({
  putRecentHandle: outside.putRecentHandle,
  getRecentHandle: outside.getRecentHandle,
  reopenFromHandle: outside.reopenFromHandle,
}));

const MIB = 1024 * 1024;
const t = ((key: string, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key} ${JSON.stringify(params)}`) as unknown as Translator;
const notice = () => coreStore.get().notice;
const busy = () => coreStore.get().busy;

type FakeHandle = PdfDocumentHandle & { readonly destroy: Mock<() => Promise<void>> };

function fakeHandle(pageCount = 3, permissions: unknown = null): FakeHandle {
  return {
    pageCount,
    destroy: vi.fn(async () => undefined),
    raw: { getPermissions: vi.fn(async () => permissions) },
  } as unknown as FakeHandle;
}

function pdfFile(name = 'a.pdf', bytes: Uint8Array = new Uint8Array([1, 2, 3])): File {
  return new File([bytes as BlobPart], name);
}

/** A file whose reported size and read bytes are chosen apart. */
function sizedFile(name: string, size: number, readBytes: number): File {
  return {
    name,
    size,
    arrayBuffer: async () => new ArrayBuffer(readBytes),
  } as unknown as File;
}

let session: SessionStore;
let storage: MemoryStorage;
const setCurrentPage = vi.fn();
const setRedactionMarks = vi.fn();

function actions(tier: 'desktop' | 'mobile' = 'desktop') {
  return createOpenActions({ session, t, tier, setCurrentPage, setRedactionMarks });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(outside)) mock.mockReset();
  coreStore.set(initialCoreState());
  openStore.set(initialOpenState());
  fileInput.current = null;
  session = new SessionStore();
  storage = memoryStorage();
  persistenceStore.set({ draftStorage: storage });
  outside.openWithPdfjs.mockImplementation(async () => fakeHandle());
  outside.putRecentHandle.mockResolvedValue(undefined);
  outside.getRecentHandle.mockResolvedValue(null);
});
afterEach(() => {
  for (const tab of session.getSnapshot().tabs) dropHandle(tab.id);
  vi.unstubAllGlobals();
});

describe('openAndFingerprint', () => {
  it('hands back the handle and the fingerprint when both succeed', async () => {
    const handle = fakeHandle();
    await expect(openAndFingerprint(Promise.resolve(handle), Promise.resolve('abc'))).resolves.toEqual([
      handle,
      'abc',
    ]);
    expect(handle.destroy).not.toHaveBeenCalled();
  });

  it('destroys the handle the fingerprint made useless and throws the fingerprint’s error', async () => {
    const handle = fakeHandle();
    const failure = new Error('hash failed');
    await expect(openAndFingerprint(Promise.resolve(handle), Promise.reject(failure))).rejects.toBe(failure);
    expect(handle.destroy).toHaveBeenCalledOnce();
  });

  it('still throws the fingerprint’s error when the useless handle will not shut down', async () => {
    const handle = fakeHandle();
    handle.destroy.mockRejectedValue(new Error('stuck'));
    const failure = new Error('hash failed');
    await expect(openAndFingerprint(Promise.resolve(handle), Promise.reject(failure))).rejects.toBe(failure);
  });

  it('throws the engine’s error when the engine failed, even if the fingerprint failed too', async () => {
    const engine = new ToolError('password-required', { engine: 'pdfjs' });
    await expect(openAndFingerprint(Promise.reject(engine), Promise.reject(new Error('hash')))).rejects.toBe(
      engine,
    );
  });
});

describe('openFile', () => {
  it('opens the bytes as a tab, stores the recovery copy and resets the viewer', async () => {
    const handle = fakeHandle(5);
    outside.openWithPdfjs.mockResolvedValue(handle);
    selectPages([1, 2]);
    showStartScreen();

    await actions().openFile(pdfFile('contract.pdf'));

    const tab = session.active;
    expect(tab).toMatchObject({ name: 'contract.pdf', source: { sha256: 'sha' } });
    expect(handleFor(tab?.id ?? '')).toBe(handle);
    expect(outside.openWithPdfjs).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), {});
    expect(outside.addRecentDocument).toHaveBeenCalledWith({
      id: tab?.id,
      name: 'contract.pdf',
      sizeBytes: 3,
      pageCount: 5,
    });
    expect([...storage.sources.values()]).toEqual([new Uint8Array([1, 2, 3])]);
    expect(outside.putRecentHandle).not.toHaveBeenCalled();
    expect(setCurrentPage).toHaveBeenCalledWith(0);
    expect(setRedactionMarks).toHaveBeenCalledWith([]);
    expect(openStore.get()).toMatchObject({ showHomeScreen: false, selectedPages: [], opening: false });
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('keeps the file’s handle on the tab and remembers it for reopening', async () => {
    const fileHandle = { name: 'a.pdf' } as FileSystemFileHandle;

    await actions().openFile(pdfFile(), fileHandle);

    expect(session.active?.source.handle).toBe(fileHandle);
    expect(outside.putRecentHandle).toHaveBeenCalledWith(session.active?.id, fileHandle);
  });

  it('opens a protected file with its password, says it is read-only and remembers the password', async () => {
    await actions().openFile(pdfFile(), undefined, 'secret');

    expect(outside.openWithPdfjs).toHaveBeenCalledWith(expect.any(Uint8Array), { password: 'secret' });
    expect(openStore.get().lockedTabs.get(session.active?.id ?? '')).toBe('secret');
    expect(notice()).toBe('locked.banner');
  });

  it('keeps no recovery copy of an encrypted document and marks the session sensitive', async () => {
    outside.openWithPdfjs.mockResolvedValue(fakeHandle(2, [4]));

    await actions().openFile(pdfFile());

    expect(session.active?.sensitive).toBe(true);
    expect(storage.sources.size).toBe(0);
  });

  it('keeps the tab and says the recovery copy was not stored when storage refuses', async () => {
    storage.putSource = async () => {
      throw new Error('full');
    };

    await actions().openFile(pdfFile());

    expect(session.getSnapshot().tabs).toHaveLength(1);
    expect(notice()).toBe('draft.sourceNotStored {"reason":"draft.storageRefused"}');
  });

  it('says the handle could not be remembered the same way', async () => {
    outside.putRecentHandle.mockRejectedValue(new Error('denied'));

    await actions().openFile(pdfFile(), {} as FileSystemFileHandle);

    expect(session.getSnapshot().tabs).toHaveLength(1);
    expect(notice()).toContain('draft.sourceNotStored');
  });

  it('warns about a large document, and appends the storage warning to the same line', async () => {
    outside.openWithPdfjs.mockResolvedValue(fakeHandle(1600));
    storage.putSource = async () => {
      throw new Error('full');
    };

    await actions().openFile(pdfFile());

    expect(notice()).toBe('limit.warn.pages draft.sourceNotStored {"reason":"draft.storageRefused"}');
  });

  it('says editing is off for a document with too many pages for the device', async () => {
    outside.openWithPdfjs.mockResolvedValue(fakeHandle(400));

    await actions('mobile').openFile(pdfFile());

    expect(notice()).toBe('limit.viewingOnly.pages');
    expect(session.getSnapshot().tabs).toHaveLength(1);
  });

  it('says editing is off for a document too heavy for the device', async () => {
    await actions('mobile').openFile(sizedFile('big.pdf', 1, 65 * MIB));

    expect(notice()).toBe('limit.viewingOnly.bytes');
  });

  it('refuses an oversized file before reading it, as a notice', async () => {
    await actions().openFile(sizedFile('huge.pdf', 301 * MIB, 1));

    expect(notice()).toBe('error.file-too-large.message error.file-too-large.hint');
    expect(outside.openWithPdfjs).not.toHaveBeenCalled();
    expect(session.getSnapshot().tabs).toHaveLength(0);
    expect(busy()).toBe(false);
    expect(openStore.get().opening).toBe(false);
  });

  it('destroys the handle and names the file when the document has too many pages', async () => {
    const handle = fakeHandle(2001);
    outside.openWithPdfjs.mockResolvedValue(handle);

    await actions().openFile(pdfFile('long.pdf'));

    expect(handle.destroy).toHaveBeenCalledOnce();
    expect(notice()).toBe('error.page-limit.message error.page-limit.hint');
    expect(session.getSnapshot().tabs).toHaveLength(0);
  });

  it('destroys the handle when the bytes read turn out larger than the limit', async () => {
    const handle = fakeHandle(1);
    outside.openWithPdfjs.mockResolvedValue(handle);

    await actions().openFile(sizedFile('lying.pdf', 1, 301 * MIB));

    expect(handle.destroy).toHaveBeenCalledOnce();
    expect(notice()).toBe('error.file-too-large.message error.file-too-large.hint');
  });

  it('releases the handle and reports the original error when its permissions cannot be read', async () => {
    const handle = fakeHandle();
    handle.raw.getPermissions = vi.fn(async () => {
      throw new Error('boom');
    });
    handle.destroy.mockRejectedValue(new Error('stuck'));
    outside.openWithPdfjs.mockResolvedValue(handle);

    await actions().openFile(pdfFile());

    expect(handle.destroy).toHaveBeenCalledOnce();
    expect(notice()).toBe('error.corrupt-document.message error.corrupt-document.hint');
    expect(session.getSnapshot().tabs).toHaveLength(0);
  });

  it('asks for the password of a protected file, keeping the file and its handle', async () => {
    outside.openWithPdfjs.mockRejectedValue(new ToolError('password-required', { engine: 'pdfjs' }));
    const file = pdfFile();
    const fileHandle = {} as FileSystemFileHandle;

    await actions().openFile(file, fileHandle);

    expect(openStore.get().passwordPrompt).toEqual({ file, handle: fileHandle, incorrect: false });
    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
  });

  it('asks again, saying so, when the password was refused', async () => {
    outside.openWithPdfjs.mockRejectedValue(new ToolError('wrong-password', { engine: 'pdfjs' }));
    const file = pdfFile();

    await actions().openFile(file, undefined, 'nope');

    expect(openStore.get().passwordPrompt).toEqual({ file, incorrect: true });
  });

  it('drops the start-screen tool that waited for the file when the open fails', async () => {
    outside.openWithPdfjs.mockRejectedValue(new ToolError('corrupt-document', { engine: 'pdfjs' }));
    openStore.set({ pendingHomeCommand: 'rotate' });

    await actions().openFile(pdfFile());

    expect(openStore.get().pendingHomeCommand).toBeNull();
    expect(notice()).toBe('error.corrupt-document.message error.corrupt-document.hint');
  });

  it('keeps a start-screen tool waiting while a password is asked for', async () => {
    outside.openWithPdfjs.mockRejectedValue(new ToolError('password-required', { engine: 'pdfjs' }));
    openStore.set({ pendingHomeCommand: 'rotate' });

    await actions().openFile(pdfFile());

    expect(openStore.get().pendingHomeCommand).toBe('rotate');
  });

  it('reports a failure that is not a tool error as a corrupt document', async () => {
    outside.openWithPdfjs.mockRejectedValue(new Error('anything'));

    await actions().openFile(pdfFile());

    expect(notice()).toBe('error.corrupt-document.message error.corrupt-document.hint');
  });

  it('refuses while another operation runs, and drops the waiting start-screen tool', async () => {
    setBusy(true);
    openStore.set({ pendingHomeCommand: 'rotate' });

    await actions().openFile(pdfFile());

    expect(coreStore.get().notice).toBe(t('op.busy'));
    expect(openStore.get().pendingHomeCommand).toBeNull();
    expect(outside.openWithPdfjs).not.toHaveBeenCalled();
    expect(busy()).toBe(true);
  });

  it('clears the previous notice before it starts', async () => {
    coreStore.set({ notice: 'old' });

    await actions().openFile(pdfFile());

    expect(notice()).toBeNull();
  });
});

describe('openProducedTab', () => {
  const bytes = new Uint8Array([9, 9]);

  it('registers the produced bytes as a tab and resolves with no warning', async () => {
    const handle = fakeHandle(2);
    outside.openWithPdfjs.mockResolvedValue(handle);

    await expect(actions().openProducedTab('out.pdf', bytes)).resolves.toBeNull();

    const tab = session.active;
    expect(tab?.name).toBe('out.pdf');
    expect(handleFor(tab?.id ?? '')).toBe(handle);
    expect(outside.addRecentDocument).toHaveBeenCalledWith({
      id: tab?.id,
      name: 'out.pdf',
      sizeBytes: 2,
      pageCount: 2,
    });
    expect(openStore.get().showHomeScreen).toBe(false);
    expect(setCurrentPage).toHaveBeenCalledWith(0);
    expect(notice()).toBeNull();
  });

  it('resolves with the warning, keeping the tab, when the recovery copy cannot be stored', async () => {
    storage.putSource = async () => {
      throw new Error('full');
    };

    await expect(actions().openProducedTab('out.pdf', bytes)).resolves.toBe(
      'draft.sourceNotStored {"reason":"draft.storageRefused"}',
    );
    expect(session.getSnapshot().tabs).toHaveLength(1);
  });

  it('refuses oversized bytes before opening them', async () => {
    await expect(actions().openProducedTab('x.pdf', new Uint8Array(301 * MIB))).rejects.toMatchObject({
      code: 'file-too-large',
    });
    expect(outside.openWithPdfjs).not.toHaveBeenCalled();
  });

  it('leaves no orphan tab behind when the caller was cancelled while the bytes opened', async () => {
    const handle = fakeHandle();
    outside.openWithPdfjs.mockResolvedValue(handle);
    const controller = new AbortController();
    controller.abort();

    await expect(actions().openProducedTab('x.pdf', bytes, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(handle.destroy).toHaveBeenCalledOnce();
    expect(session.getSnapshot().tabs).toHaveLength(0);
  });

  it('opens normally for a caller whose signal is still live', async () => {
    await actions().openProducedTab('x.pdf', bytes, new AbortController().signal);
    expect(session.getSnapshot().tabs).toHaveLength(1);
  });

  it('destroys the handle and names the document when it has too many pages', async () => {
    const handle = fakeHandle(2001);
    outside.openWithPdfjs.mockResolvedValue(handle);

    await expect(actions().openProducedTab('x.pdf', bytes)).rejects.toMatchObject({ code: 'page-limit' });
    expect(handle.destroy).toHaveBeenCalledOnce();
    expect(session.getSnapshot().tabs).toHaveLength(0);
  });
});

describe('convertAndOpen', () => {
  const converted = (notes: readonly { key: string; params?: Record<string, unknown> }[] = []) => ({
    bytes: new Uint8Array([7]),
    report: { notes },
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true });
  });

  it('ignores a file that is neither a convertible document nor a picture', async () => {
    await actions().convertAndOpen(pdfFile('a.xyz'));

    expect(outside.convertToPdf).not.toHaveBeenCalled();
    expect(busy()).toBe(false);
  });

  it('converts a document on A4 portrait with a 15 mm margin and opens it, listing what was approximated', async () => {
    Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true });
    outside.convertToPdf.mockResolvedValue(
      converted([
        { key: 'op.note.convert.done' },
        { key: 'op.note.convert.csvTruncated', params: { rows: 5, total: 9 } },
      ]),
    );

    await actions().convertAndOpen(pdfFile('letter.docx'));

    expect(outside.convertToPdf).toHaveBeenCalledWith(
      {
        name: 'letter.docx',
        bytes: new Uint8Array([1, 2, 3]),
        pageSize: 'a4',
        orientation: 'portrait',
        marginMm: 15,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(session.active?.name).toBe('letter.pdf');
    expect(notice()).toBe(
      'convert.opened {"format":"DOCX"} op.note.convert.csvTruncated {"rows":5,"total":9}',
    );
    expect(busy()).toBe(false);
    expect(operationRunning()).toBe(false);
    expect(openStore.get().opening).toBe(false);
  });

  it('puts a spreadsheet on landscape letter paper in a US locale', async () => {
    outside.convertToPdf.mockResolvedValue(converted());

    await actions().convertAndOpen(pdfFile('sheet.xlsx'));

    expect(outside.convertToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 'letter', orientation: 'landscape' }),
      expect.anything(),
    );
  });

  it('adds the storage warning to the conversion’s line', async () => {
    outside.convertToPdf.mockResolvedValue(converted());
    storage.putSource = async () => {
      throw new Error('full');
    };

    await actions().convertAndOpen(pdfFile('notes.txt'));

    expect(notice()).toBe(
      'convert.opened {"format":"TXT"} draft.sourceNotStored {"reason":"draft.storageRefused"}',
    );
  });

  it('places a picture on a page of the same paper, contained, with its EXIF turn applied', async () => {
    outside.imagesToPdf.mockResolvedValue({ bytes: new Uint8Array([5]) });

    await actions().convertAndOpen(pdfFile('photo.png'));

    expect(outside.imagesToPdf).toHaveBeenCalledWith(
      {
        images: [{ name: 'photo.png', bytes: new Uint8Array([1, 2, 3]) }],
        pageSize: 'letter',
        fit: 'contain',
        marginMm: 0,
        applyExif: true,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(session.active?.name).toBe('photo.pdf');
    expect(notice()).toBe('convert.imageOpened');
    expect(busy()).toBe(false);
  });

  it('puts a picture on A4 outside the US and Canada', async () => {
    Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
    outside.imagesToPdf.mockResolvedValue({ bytes: new Uint8Array([5]) });

    await actions().convertAndOpen(pdfFile('photo.png'));

    expect(outside.imagesToPdf).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 'a4' }),
      expect.anything(),
    );
  });

  it('refuses while another operation runs, and drops the waiting start-screen tool', async () => {
    setBusy(true);
    openStore.set({ pendingHomeCommand: 'rotate' });

    await actions().convertAndOpen(pdfFile('a.docx'));

    expect(coreStore.get().notice).toBe(t('op.busy'));
    expect(openStore.get().pendingHomeCommand).toBeNull();
    expect(outside.convertToPdf).not.toHaveBeenCalled();
  });

  it('refuses while an operation holds the abort controller, leaving it in place', async () => {
    const running = new AbortController();
    coreStore.set({ operation: running });

    await actions().convertAndOpen(pdfFile('a.docx'));

    expect(coreStore.get().notice).toBe(t('op.busy'));
    expect(coreStore.get().operation).toBe(running);
    expect(busy()).toBe(false);
  });

  it('says the format is not supported when the conversion fails', async () => {
    outside.convertToPdf.mockRejectedValue(new Error('bad file'));
    openStore.set({ pendingHomeCommand: 'rotate' });

    await actions().convertAndOpen(pdfFile('a.docx'));

    expect(notice()).toBe('error.unsupported-format.message {}');
    expect(openStore.get().pendingHomeCommand).toBeNull();
    expect(busy()).toBe(false);
  });

  it('says why a tool error stopped the conversion', async () => {
    outside.convertToPdf.mockRejectedValue(new ToolError('corrupt-document', { engine: 'model' }));

    await actions().convertAndOpen(pdfFile('a.docx'));

    expect(notice()).toBe('error.corrupt-document.message {} error.corrupt-document.hint {}');
  });

  it('says nothing when the user cancelled the conversion', async () => {
    outside.convertToPdf.mockImplementation(async () => {
      cancelOperation();
      throw new ToolError('aborted', { engine: 'model' });
    });

    await actions().convertAndOpen(pdfFile('a.docx'));

    expect(notice()).toBeNull();
    expect(busy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('leaves the gate to the run that replaced it', async () => {
    const other = new AbortController();
    outside.convertToPdf.mockImplementation(async () => {
      coreStore.set({ operation: other });
      return converted();
    });

    await actions().convertAndOpen(pdfFile('a.docx'));

    expect(coreStore.get().operation).toBe(other);
    expect(busy()).toBe(true);
  });
});

describe('openFromSurface', () => {
  it('opens a PDF', async () => {
    await actions().openFromSurface(pdfFile('A.PDF'));
    expect(session.active?.name).toBe('A.PDF');
  });

  it('opens a file with an unknown extension as a PDF, so the engine decides', async () => {
    await actions().openFromSurface(pdfFile('scan'));
    expect(session.active?.name).toBe('scan');
  });

  it('converts a Word file rather than refusing it', async () => {
    outside.convertToPdf.mockResolvedValue({ bytes: new Uint8Array([7]), report: { notes: [] } });
    await actions().openFromSurface(pdfFile('a.docx'));
    expect(session.active?.name).toBe('a.pdf');
    expect(outside.openWithPdfjs).toHaveBeenCalledOnce();
  });

  it('converts a picture', async () => {
    outside.imagesToPdf.mockResolvedValue({ bytes: new Uint8Array([7]) });
    await actions().openFromSurface(pdfFile('a.jpg'));
    expect(notice()).toBe('convert.imageOpened');
  });

  it('says which kind of document cannot be converted and drops the waiting tool', async () => {
    openStore.set({ pendingHomeCommand: 'rotate' });

    await actions().openFromSurface(pdfFile('old.doc'));

    expect(notice()).toBe('convert.unsupported {"kind":"DOC"}');
    expect(openStore.get().pendingHomeCommand).toBeNull();
    expect(session.getSnapshot().tabs).toHaveLength(0);
  });

  it('turns an unexpected failure into a notice instead of an unhandled rejection', async () => {
    openStore.set({ pendingHomeCommand: 'rotate' });
    const broken = {
      name: 'a.pdf',
      get size(): number {
        throw new Error('unreadable');
      },
    } as unknown as File;

    await actions().openFromSurface(broken);

    expect(notice()).toBe('error.corrupt-document.message {}');
    expect(openStore.get().pendingHomeCommand).toBeNull();
  });

  it('keeps the file’s handle for in-place save', async () => {
    const fileHandle = {} as FileSystemFileHandle;
    await actions().openFromSurface(pdfFile(), fileHandle);
    expect(session.active?.source.handle).toBe(fileHandle);
  });
});

describe('openFilesFromSurface', () => {
  it('opens each file in its own tab, in order, pairing handles by name', async () => {
    const second = { name: 'b.pdf' } as FileSystemFileHandle;

    await actions().openFilesFromSurface([pdfFile('a.pdf'), pdfFile('b.pdf')], [null, second]);

    expect(session.getSnapshot().tabs.map((tab) => tab.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(session.getSnapshot().tabs.map((tab) => tab.source.handle)).toEqual([undefined, second]);
  });

  it('opens files that come without handles', async () => {
    await actions().openFilesFromSurface([pdfFile('a.pdf')]);
    expect(session.getSnapshot().tabs).toHaveLength(1);
  });
});

describe('openViaPicker', () => {
  it('clicks the hidden input when the browser has no File System Access picker', async () => {
    const click = vi.fn();
    fileInput.current = { click } as unknown as HTMLInputElement;

    await actions().openViaPicker();

    expect(click).toHaveBeenCalledOnce();
  });

  it('does nothing further when there is no input to click either', async () => {
    await expect(actions().openViaPicker()).resolves.toBeUndefined();
  });

  it('offers PDFs and every convertible type, and opens what was picked with its handle', async () => {
    const file = pdfFile('picked.pdf');
    const picked = { getFile: async () => file } as unknown as FileSystemFileHandle;
    const picker = vi.fn(async () => [picked]);
    vi.stubGlobal('showOpenFilePicker', picker);

    await actions().openViaPicker();

    expect(picker).toHaveBeenCalledWith({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [
        { description: 'open.pdfFilter', accept: { 'application/pdf': ['.pdf'] } },
        {
          description: 'open.anyFilter',
          accept: expect.objectContaining({ 'application/pdf': ['.pdf'], 'text/plain': expect.any(Array) }),
        },
      ],
    });
    expect(session.active).toMatchObject({ name: 'picked.pdf', source: { handle: picked } });
  });

  it('opens nothing when the picker returns nothing', async () => {
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(async () => []),
    );

    await actions().openViaPicker();

    expect(session.getSnapshot().tabs).toHaveLength(0);
    expect(notice()).toBeNull();
  });

  it('treats a cancelled picker as a decision: no notice, and the waiting tool is dropped', async () => {
    openStore.set({ pendingHomeCommand: 'rotate' });
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(async () => {
        throw new DOMException('cancelled', 'AbortError');
      }),
    );

    await actions().openViaPicker();

    expect(notice()).toBeNull();
    expect(openStore.get().pendingHomeCommand).toBeNull();
  });

  it('says the picker failed for any other picker error, and drops the waiting tool', async () => {
    openStore.set({ pendingHomeCommand: 'rotate' });
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(async () => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    );

    await actions().openViaPicker();

    expect(notice()).toBe('open.pickerFailed');
    expect(openStore.get().pendingHomeCommand).toBeNull();
  });

  it('treats a picker error that is not a DOMException as a failure too', async () => {
    vi.stubGlobal(
      'showOpenFilePicker',
      vi.fn(async () => {
        throw new Error('weird');
      }),
    );

    await actions().openViaPicker();

    expect(notice()).toBe('open.pickerFailed');
  });
});

describe('selectRecent', () => {
  const item = { id: 'doc-1', name: 'doc.pdf', sizeBytes: 3, openedAt: 1 };
  const click = vi.fn();

  beforeEach(() => {
    fileInput.current = { click } as unknown as HTMLInputElement;
  });

  it('switches to the tab that is already open, by identity, and leaves the start screen', async () => {
    const tab = session.openDocument({
      id: 'doc-1',
      name: 'other.pdf',
      bytes: new Uint8Array(1),
      sha256: 'x',
      pageCount: 1,
    });
    session.openDocument({ name: 'doc.pdf', bytes: new Uint8Array(1), sha256: 'y', pageCount: 1 });

    await actions().selectRecent(item);

    expect(session.active?.id).toBe(tab.id);
    expect(openStore.get().showHomeScreen).toBe(false);
    expect(outside.getRecentHandle).not.toHaveBeenCalled();
  });

  it('reopens the file the entry was opened from', async () => {
    const stored = {} as FileSystemFileHandle;
    const reopened = pdfFile('doc.pdf');
    outside.getRecentHandle.mockResolvedValue(stored);
    outside.reopenFromHandle.mockResolvedValue({ kind: 'file', file: reopened, handle: stored });

    await actions().selectRecent(item);

    expect(outside.reopenFromHandle).toHaveBeenCalledWith(stored);
    expect(session.active).toMatchObject({ name: 'doc.pdf', source: { handle: stored } });
  });

  it('says permission was refused and does not ask again with the picker', async () => {
    outside.getRecentHandle.mockResolvedValue({});
    outside.reopenFromHandle.mockResolvedValue({ kind: 'denied' });

    await actions().selectRecent(item);

    expect(notice()).toBe('home.reopen.denied {"name":"doc.pdf"}');
    expect(click).not.toHaveBeenCalled();
    expect(session.getSnapshot().tabs).toHaveLength(0);
  });

  it('says the file is gone and falls back to the stored recovery copy', async () => {
    outside.getRecentHandle.mockResolvedValue({});
    outside.reopenFromHandle.mockResolvedValue({ kind: 'missing' });
    storage.drafts.set('doc-1', manifest('doc-1', { name: 'doc.pdf', pageCount: 4 }));
    storage.sources.set('src-doc-1', new Uint8Array([4, 5]));

    await actions().selectRecent(item);

    expect(notice()).toBe('home.reopen.missing {"name":"doc.pdf"}');
    expect(session.active).toMatchObject({ id: 'doc-1', name: 'doc.pdf' });
  });

  it('reopens the entry from its recovery copy under the entry’s own identity', async () => {
    const handle = fakeHandle(4);
    outside.openWithPdfjs.mockResolvedValue(handle);
    storage.drafts.set('doc-1', manifest('doc-1', { name: 'doc.pdf', pageCount: 4 }));
    storage.sources.set('src-doc-1', new Uint8Array([4, 5]));
    showStartScreen();

    await actions().selectRecent(item);

    expect(session.active).toMatchObject({ id: 'doc-1', name: 'doc.pdf', source: { sha256: 'sha' } });
    expect(handleFor('doc-1')).toBe(handle);
    expect(openStore.get().showHomeScreen).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it('offers the picker when the draft’s source is gone', async () => {
    storage.drafts.set('doc-1', manifest('doc-1'));

    await actions().selectRecent(item);

    expect(click).toHaveBeenCalledOnce();
    expect(session.getSnapshot().tabs).toHaveLength(0);
  });

  it('offers the picker when no draft belongs to the entry', async () => {
    await actions().selectRecent(item);

    expect(click).toHaveBeenCalledOnce();
  });

  it('says so, then offers the picker, when the recovery copy cannot be read back', async () => {
    storage.readDrafts = async () => {
      throw new ToolError('corrupt-document', { engine: 'model' });
    };

    await actions().selectRecent(item);

    expect(notice()).toBe('error.corrupt-document.message {} error.corrupt-document.hint {}');
    expect(click).toHaveBeenCalledOnce();
  });
});
