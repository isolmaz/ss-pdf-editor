// @vitest-environment happy-dom
/** The answers to the file-changed question: what each button runs, and the close it may finish. */

import { SessionStore } from 'pdf-model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keepFile, saveAfterConflict } from './conflict-actions';
import type { SaveOptions } from './save-actions';
import { conflictFound, initialSaveState, saveStore } from './save-store';

let session: SessionStore;
const discardTab = vi.fn();
const saveActive = vi.fn<(id: string, options?: SaveOptions) => Promise<boolean>>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
  saveStore.set(initialSaveState());
  session = new SessionStore();
  saveActive.mockResolvedValue(true);
});

const host = () => ({ session, discardTab, saveActive });

describe('the file-changed answers', () => {
  it('Cancel only closes the question', () => {
    conflictFound('tab-1', {} as FileSystemFileHandle);
    keepFile();
    expect(saveStore.get().conflict).toBeNull();
    expect(saveActive).not.toHaveBeenCalled();
  });

  it('Overwrite and Save as close the question and save again with that answer', async () => {
    const tab = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    const target = {} as FileSystemFileHandle;
    conflictFound(tab.id, target);
    await saveAfterConflict(host(), tab.id, { overwrite: target });
    expect(saveStore.get().conflict).toBeNull();
    expect(saveActive).toHaveBeenLastCalledWith(tab.id, { overwrite: target });
    await saveAfterConflict(host(), tab.id, { saveAs: true });
    expect(saveActive).toHaveBeenLastCalledWith(tab.id, { saveAs: true });
    expect(discardTab).not.toHaveBeenCalled();
  });

  it('finishes the close the Save and close that hit the conflict asked for', async () => {
    const tab = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    saveStore.set({ closeRequest: tab.id });
    const target = {} as FileSystemFileHandle;
    await saveAfterConflict(host(), tab.id, { overwrite: target });
    expect(saveActive).toHaveBeenCalledWith(tab.id, { overwrite: target });
    expect(discardTab).toHaveBeenCalledWith(tab.id);
    expect(saveStore.get().closeRequest).toBeNull();
  });
});
