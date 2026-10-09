/**
 * Save and Export against a real session, with the file system, the picker and the download as
 * the browser boundary: where the bytes go, what the session records, what the user reads, and
 * that the save lock and the busy flag are released on every path.
 */

import { SessionStore, type SessionTab, sha256Hex } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { exportDocument, type SaveHost, saveDocument } from './save-actions';
import { initialSaveState, isSaveLocked, saveLocked, saveStore } from './save-store';

const mocks = vi.hoisted(() => ({ downloadFiles: vi.fn(), ensureWriteAccess: vi.fn() }));
vi.mock('../../operations', () => ({ downloadFiles: mocks.downloadFiles }));
vi.mock('../../recent-handles', () => ({ ensureWriteAccess: mocks.ensureWriteAccess }));

const t = ((key: string, params?: Record<string, string>) =>
  params === undefined ? key : `${key} ${Object.values(params).join(' ')}`) as Translator;
const output = new Uint8Array([4, 5, 6]);
const verification = { state: 'verified', checks: [], declared: [] };
const execution = {
  steps: [{ engine: 'pdfjs', id: 'saveDocument' }],
  appliedSteps: [{ engine: 'mupdf', id: 'rotate' }],
  plan: { incremental: true },
};

/** A file the browser would hand back: reads and writes go through the same bytes. */
function fakeFile(initial: readonly number[] = [1, 2, 3]) {
  let stored: Uint8Array = new Uint8Array(initial);
  const writable = {
    write: vi.fn(async (value: Uint8Array) => {
      pending = value;
    }),
    close: vi.fn(async () => {
      stored = pending;
    }),
    abort: vi.fn(async () => undefined),
  };
  let pending: Uint8Array = stored;
  const file = {
    getFile: vi.fn(async () => new Blob([stored as BlobPart])),
    createWritable: vi.fn(async () => writable),
  };
  return {
    file: file as unknown as FileSystemFileHandle,
    writable,
    createWritable: file.createWritable,
    bytes: () => stored,
    replace: (value: readonly number[]) => {
      stored = new Uint8Array(value);
    },
  };
}

let session: SessionStore;
let cancelRef: { current: AbortController | null };
let refuseBusy: Mock;
let prepareOutput: Mock;
let host: SaveHost;

async function open(name = 'a.pdf', handle?: FileSystemFileHandle): Promise<SessionTab> {
  const bytes = new Uint8Array([1, 2, 3]);
  return session.openDocument({
    name,
    bytes,
    sha256: await sha256Hex(bytes),
    pageCount: 1,
    ...(handle === undefined ? {} : { handle }),
  });
}

function prepared(tab: SessionTab) {
  return {
    tab: session.getSnapshot().tabs.find((item) => item.id === tab.id) ?? tab,
    handle: {},
    bytes: output,
    outputProtection: { encrypted: false },
    execution,
    outputHash: 'output-hash',
    verification,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  session = new SessionStore();
  cancelRef = { current: null };
  refuseBusy = vi.fn();
  prepareOutput = vi.fn();
  host = { session, t, cancelRef, refuseBusy, prepareOutput } as SaveHost;
  mocks.ensureWriteAccess.mockResolvedValue(true);
});

afterEach(() => vi.unstubAllGlobals());

describe('saveDocument', () => {
  it('does nothing for a tab that is gone', async () => {
    await open();
    expect(await saveDocument(host, 'gone')).toBe(false);
    expect(await saveDocument(host, undefined)).toBe(false);
    expect(prepareOutput).not.toHaveBeenCalled();
    expect(refuseBusy).not.toHaveBeenCalled();
  });

  it('is refused while an operation runs, and while another save holds the document', async () => {
    const tab = await open();
    coreStore.set({ busy: true });
    expect(await saveDocument(host, tab.id)).toBe(false);
    coreStore.set({ busy: false });
    saveLocked();
    expect(await saveDocument(host, tab.id)).toBe(false);
    expect(refuseBusy).toHaveBeenCalledTimes(2);
    expect(prepareOutput).not.toHaveBeenCalled();
  });

  it('downloads the prepared bytes when there is no file and no picker, and records the output', async () => {
    const tab = await open('report');
    prepareOutput.mockResolvedValue(prepared(tab));
    vi.stubGlobal('window', {});

    expect(await saveDocument(host, tab.id)).toBe(true);

    expect(mocks.downloadFiles).toHaveBeenCalledWith([
      { name: 'report.pdf', bytes: output, mime: 'application/pdf' },
    ]);
    const saved = session.getSnapshot().tabs[0]?.outputs.at(-1);
    expect(saved).toMatchObject({
      fromWorkingVersion: tab.working.id,
      encrypted: false,
      steps: ['pdfjs:saveDocument'],
      appliedSteps: ['mupdf:rotate'],
      incremental: true,
      verification,
      writtenTo: { fileName: 'report', sha256: 'output-hash' },
    });
    expect(coreStore.get().notice).toContain('save.done report');
    expect(prepareOutput).toHaveBeenCalledWith(tab.id, expect.any(AbortController), []);
  });

  it('downloads under the document name when it already ends in .pdf, even with no window at all', async () => {
    const tab = await open('Report.PDF');
    prepareOutput.mockResolvedValue(prepared(tab));
    expect(await saveDocument(host, tab.id)).toBe(true);
    expect(mocks.downloadFiles.mock.calls[0]?.[0][0].name).toBe('Report.PDF');
  });

  it('takes the document from the file picker and writes there, attaching the file only afterwards', async () => {
    const tab = await open('report');
    const target = fakeFile([]);
    const picker = vi.fn(async () => target.file);
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    prepareOutput.mockResolvedValue(prepared(tab));

    expect(await saveDocument(host, tab.id)).toBe(true);

    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'report.pdf',
      types: [{ description: 'open.pdfFilter', accept: { 'application/pdf': ['.pdf'] } }],
    });
    expect(target.writable.write).toHaveBeenCalledWith(output);
    expect(target.writable.close).toHaveBeenCalled();
    expect(target.bytes()).toEqual(output);
    expect(session.getSnapshot().tabs[0]?.source.handle).toBe(target.file);
    expect(mocks.downloadFiles).not.toHaveBeenCalled();
  });

  it('releases the lock and the busy flag without writing when the picker is cancelled', async () => {
    const tab = await open();
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => {
        throw new DOMException('cancelled', 'AbortError');
      },
    });
    expect(await saveDocument(host, tab.id)).toBe(false);
    expect(isSaveLocked()).toBe(false);
    expect(coreStore.get().busy).toBe(false);
    expect(prepareOutput).not.toHaveBeenCalled();
    expect(mocks.downloadFiles).not.toHaveBeenCalled();
  });

  it('falls back to a download when the picker fails for another reason', async () => {
    const tab = await open();
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    prepareOutput.mockResolvedValue(prepared(tab));
    expect(await saveDocument(host, tab.id)).toBe(true);
    expect(mocks.downloadFiles).toHaveBeenCalledTimes(1);
  });

  it('holds the lock across the picker, so a second Save is refused rather than run twice', async () => {
    const tab = await open();
    const target = fakeFile([]);
    const picked = Promise.withResolvers<FileSystemFileHandle>();
    vi.stubGlobal('window', { showSaveFilePicker: () => picked.promise });
    prepareOutput.mockResolvedValue(prepared(tab));

    const first = saveDocument(host, tab.id);
    expect(isSaveLocked()).toBe(true);
    expect(cancelRef.current).toBeInstanceOf(AbortController);
    expect(await saveDocument(host, tab.id)).toBe(false);
    expect(refuseBusy).toHaveBeenCalledTimes(1);
    picked.resolve(target.file);
    expect(await first).toBe(true);
    expect(isSaveLocked()).toBe(false);
    expect(cancelRef.current).toBeNull();
  });

  it('writes in place to the document file, against the source hash the first time', async () => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    prepareOutput.mockResolvedValue(prepared(tab));

    expect(await saveDocument(host, tab.id)).toBe(true);

    expect(mocks.ensureWriteAccess).toHaveBeenCalledWith(target.file);
    expect(target.bytes()).toEqual(output);
    expect(session.getSnapshot().tabs[0]?.source.handle).toBe(target.file);
  });

  it('measures the next in-place save against what the last one wrote, not the original', async () => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    prepareOutput.mockImplementation(async () => ({ ...prepared(tab), outputHash: await sha256Hex(output) }));
    expect(await saveDocument(host, tab.id)).toBe(true);
    // The original is gone from the disk, but the file is exactly what this editor wrote.
    expect(await saveDocument(host, tab.id)).toBe(true);
    expect(await saveDocument(host, tab.id)).toBe(true);
    target.replace([7, 7, 7]);
    expect(await saveDocument(host, tab.id)).toBe(false);
    expect(coreStore.get().notice).toContain('error.conflict.message');
  });

  it('falls back to the source hash when the last output was never written to a file', async () => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    session.addOutput(tab.id, {
      id: 'earlier',
      fromWorkingVersion: tab.working.id,
      fromState: tab.working.stateId,
      encrypted: false,
      steps: [],
      appliedSteps: [],
      incremental: false,
      verification,
    } as never);
    prepareOutput.mockResolvedValue(prepared(tab));
    expect(await saveDocument(host, tab.id)).toBe(true);
  });

  it('refuses a file that changed on disk since it was opened, writing nothing', async () => {
    const target = fakeFile([9, 9]);
    const tab = await open('a.pdf', target.file);
    prepareOutput.mockResolvedValue(prepared(tab));

    expect(await saveDocument(host, tab.id)).toBe(false);

    expect(coreStore.get().notice).toContain('error.conflict.message');
    expect(target.createWritable).not.toHaveBeenCalled();
    expect(session.getSnapshot().tabs[0]?.outputs).toHaveLength(0);
  });

  it('refuses to write over a file the user would not grant access to', async () => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    mocks.ensureWriteAccess.mockResolvedValue(false);

    expect(await saveDocument(host, tab.id)).toBe(false);

    expect(coreStore.get().notice).toContain('error.permission-denied.message');
    expect(prepareOutput).not.toHaveBeenCalled();
    expect(isSaveLocked()).toBe(false);
  });

  it('judges a Save As destination against its own contents rather than the opened file', async () => {
    const tab = await open();
    const target = fakeFile([5, 5, 5]);
    vi.stubGlobal('window', { showSaveFilePicker: async () => target.file });
    let changed = false;
    prepareOutput.mockImplementation(async () => {
      // Someone else writes the chosen destination while the document is prepared.
      if (changed) target.replace([6]);
      return prepared(tab);
    });
    changed = true;
    expect(await saveDocument(host, tab.id)).toBe(false);
    expect(coreStore.get().notice).toContain('error.conflict.message');
    expect(session.getSnapshot().tabs[0]?.source.handle).toBeUndefined();
  });

  it('leaves the tab dirty and writes nothing when the preparation says no', async () => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    session.setOverlays(tab.id, { annotations: ['edit'] }, 'ann.engineEdit');
    prepareOutput.mockResolvedValue(null);

    expect(await saveDocument(host, tab.id)).toBe(false);

    expect(target.createWritable).not.toHaveBeenCalled();
    expect(session.getSnapshot().tabs[0]?.dirty).toBe(true);
    expect(isSaveLocked()).toBe(false);
  });

  it('writes nothing when the run is cancelled before the file is opened for writing', async () => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    prepareOutput.mockImplementation(async () => {
      cancelRef.current?.abort();
      return prepared(tab);
    });
    expect(await saveDocument(host, tab.id)).toBe(false);
    expect(target.createWritable).not.toHaveBeenCalled();
  });

  it.each([
    ['opened for writing', 'createWritable'],
    ['written', 'write'],
  ])('aborts the write and reports it when the run is cancelled once the file is %s', async (_when, step) => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    prepareOutput.mockResolvedValue(prepared(tab));
    const cancel = () => cancelRef.current?.abort();
    if (step === 'createWritable')
      target.createWritable.mockImplementationOnce(async () => {
        cancel();
        return target.writable;
      });
    else target.writable.write.mockImplementationOnce(async () => cancel());

    expect(await saveDocument(host, tab.id)).toBe(false);

    expect(target.writable.abort).toHaveBeenCalled();
    expect(target.writable.close).not.toHaveBeenCalled();
    expect(coreStore.get().notice).toContain('error.aborted.message');
    expect(session.getSnapshot().tabs[0]?.outputs).toHaveLength(0);
  });

  it('aborts a write that failed, leaves the tab unsaved and says what went wrong', async () => {
    const target = fakeFile();
    const tab = await open('a.pdf', target.file);
    prepareOutput.mockResolvedValue(prepared(tab));
    target.writable.write.mockRejectedValue(new Error('disk full'));
    target.writable.abort.mockRejectedValue(new Error('already closed'));

    expect(await saveDocument(host, tab.id)).toBe(false);

    expect(target.writable.abort).toHaveBeenCalled();
    expect(coreStore.get().notice).toContain('error.internal.message');
    expect(isSaveLocked()).toBe(false);
    expect(coreStore.get().busy).toBe(false);
  });

  it('keeps the controller of a newer operation when it finishes', async () => {
    const tab = await open();
    vi.stubGlobal('window', {});
    const newer = new AbortController();
    prepareOutput.mockImplementation(async () => {
      cancelRef.current = newer;
      return prepared(tab);
    });
    expect(await saveDocument(host, tab.id)).toBe(true);
    expect(cancelRef.current).toBe(newer);
  });
});

describe('exportDocument', () => {
  const anchor = { href: '', download: '', click: vi.fn() };
  const created = 'blob:export';

  beforeEach(() => {
    vi.useFakeTimers();
    anchor.click.mockClear();
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(created);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing for a tab that is gone', async () => {
    await open();
    await exportDocument(host, 'gone');
    await exportDocument(host, undefined);
    expect(prepareOutput).not.toHaveBeenCalled();
  });

  it('is refused while an operation runs', async () => {
    const tab = await open();
    coreStore.set({ busy: true });
    await exportDocument(host, tab.id);
    expect(refuseBusy).toHaveBeenCalledTimes(1);
    expect(prepareOutput).not.toHaveBeenCalled();
  });

  it('downloads the prepared bytes as a new file named after the tab, and explains why it is new', async () => {
    const tab = await open('copy.pdf');
    prepareOutput.mockResolvedValue(prepared(tab));

    await exportDocument(host, tab.id);

    expect(anchor.href).toBe(created);
    expect(anchor.download).toBe('copy.pdf');
    expect(anchor.click).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/pdf');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(output);
    expect(coreStore.get().notice).toContain('export.explained copy.pdf');
    expect(coreStore.get().busy).toBe(false);
    expect(cancelRef.current).toBeNull();
    expect(prepareOutput).toHaveBeenCalledWith(tab.id, expect.any(AbortController));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(created);
  });

  it('reports a saved copy when the document has a file of its own', async () => {
    const tab = await open('copy.pdf', fakeFile().file);
    prepareOutput.mockResolvedValue(prepared(tab));
    await exportDocument(host, tab.id);
    expect(coreStore.get().notice).toContain('save.done copy.pdf');
  });

  it('downloads nothing when the preparation says no', async () => {
    const tab = await open();
    prepareOutput.mockResolvedValue(null);
    await exportDocument(host, tab.id);
    expect(anchor.click).not.toHaveBeenCalled();
    expect(coreStore.get().busy).toBe(false);
  });

  it('says what went wrong and releases the busy flag when the preparation throws', async () => {
    const tab = await open();
    prepareOutput.mockRejectedValue(new Error('engine'));
    await exportDocument(host, tab.id);
    expect(coreStore.get().notice).toContain('error.internal.message');
    expect(coreStore.get().busy).toBe(false);
  });

  it('keeps the controller of a newer operation when it finishes', async () => {
    const tab = await open();
    const newer = new AbortController();
    prepareOutput.mockImplementation(async () => {
      cancelRef.current = newer;
      return null;
    });
    await exportDocument(host, tab.id);
    expect(cancelRef.current).toBe(newer);
  });
});
