/**
 * The file handles behind the recent list, so a recent entry reopens its file directly.
 *
 * A `FileSystemFileHandle` (Chromium's File System Access API) is a *reference* to a file
 * the user picked, not its bytes, and it survives in IndexedDB because it is structured-
 * cloneable. Opening it again needs the user's permission once more — the browser asks, on
 * the click that reopens the entry — so storing it grants nothing by itself. No document
 * byte is ever written here; the recent list itself stays metadata in `localStorage`
 * (`recent.ts`).
 *
 * Kept out of a sensitive session (a password-protected document): its tab saves nothing,
 * and a handle that reopens it is something saved.
 *
 * Every call tolerates a missing or failing IndexedDB (private windows, Firefox/Safari
 * without the API): the recent entry then falls back to the file picker, as it always did.
 */

const DB_NAME = 'pdf-editor-recent';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (db === null) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Remember the handle a recent entry was opened from. */
export async function putRecentHandle(id: string, handle: FileSystemFileHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, id));
}

/** The handle stored for a recent entry, or `null`. */
export async function getRecentHandle(id: string): Promise<FileSystemFileHandle | null> {
  const value = await withStore('readonly', (store) => store.get(id) as IDBRequest<unknown>);
  return typeof FileSystemFileHandle !== 'undefined' && value instanceof FileSystemFileHandle ? value : null;
}

/** Forget every handle whose recent entry is gone (removed, cleared or pushed off the list). */
export async function pruneRecentHandles(keep: ReadonlySet<string>): Promise<void> {
  const keys = await withStore('readonly', (store) => store.getAllKeys());
  if (keys === null) return;
  for (const key of keys) {
    if (typeof key === 'string' && !keep.has(key)) {
      await withStore('readwrite', (store) => store.delete(key));
    }
  }
}

export type HandleReopen =
  | { readonly kind: 'file'; readonly file: File; readonly handle: FileSystemFileHandle }
  | { readonly kind: 'denied' }
  | { readonly kind: 'missing' };

/**
 * Read the file behind a stored handle, asking for permission when the browser no longer
 * holds it. Must run inside the click that reopens the entry: `requestPermission` needs a
 * user gesture. `missing` covers a file that was moved, renamed or deleted since.
 */
export async function reopenFromHandle(handle: FileSystemFileHandle): Promise<HandleReopen> {
  try {
    const descriptor = { mode: 'read' } as const;
    let state = (await handle.queryPermission?.(descriptor)) ?? 'granted';
    if (state === 'prompt') state = (await handle.requestPermission?.(descriptor)) ?? 'denied';
    if (state !== 'granted') return { kind: 'denied' };
    return { kind: 'file', file: await handle.getFile(), handle };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') return { kind: 'denied' };
    return { kind: 'missing' };
  }
}
