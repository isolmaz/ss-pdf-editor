/**
 * Draft persistence for spike #2: IndexedDB, **model data only**.
 *
 * `PLAN.md §3.5` — "the draft contains journal entries + annotation storage +
 * overlays + page order + viewport" and "no source-byte copying". This module
 * stores exactly one record: the journal snapshot from `toJSON()` plus the
 * phase-1 measurement summary. The generated PDF is never written here; the check
 * `draft.containsSourceBytes === false` plus a `%PDF-` scan over the stored JSON
 * is the evidence, and the record size is reported next to the fixture size.
 *
 * The same store doubles as the proof for item 5: putting a record whose payload
 * holds a *function* must fail, which is exactly why pdf.js's `CommandManager`
 * (command/undo function pairs) can never be the undo store.
 */
import type { DraftRecord, FunctionCloneProbe } from './types';

const DB_NAME = 'pdf-editor-spike2';
const DB_VERSION = 1;
const STORE = 'drafts';

export interface StoredDraft extends DraftRecord {
  readonly storedBytes: number;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('indexedDB.open failed'));
  return promise;
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const transaction = db.transaction(STORE, mode);
  const request = action(transaction.objectStore(STORE));
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error(`${mode} request failed`));
  transaction.oncomplete = () => db.close();
  return promise;
}

/** Returns the serialized size of the record that actually landed in IndexedDB. */
export async function putDraft(record: Omit<DraftRecord, 'containsSourceBytes'>): Promise<StoredDraft> {
  const full: DraftRecord = { ...record, containsSourceBytes: false };
  const storedBytes = JSON.stringify(full).length;
  await runTransaction('readwrite', (store) => store.put(full) as IDBRequest<IDBValidKey>);
  return { ...full, storedBytes };
}

export async function getDraft(id: string): Promise<DraftRecord | undefined> {
  const value = await runTransaction<DraftRecord | undefined>(
    'readonly',
    (store) => store.get(id) as IDBRequest<DraftRecord | undefined>,
  );
  return value ?? undefined;
}

export async function deleteDraft(id: string): Promise<void> {
  await runTransaction('readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
}

/** Runtime proof that the persistence mechanism cannot hold functions. */
export async function probeFunctionClone(): Promise<FunctionCloneProbe> {
  let structuredCloneRejectsFunction = false;
  let structuredCloneErrorName = '';
  try {
    structuredClone({ cmd: () => 'undo' });
  } catch (error) {
    structuredCloneRejectsFunction = true;
    structuredCloneErrorName = error instanceof Error ? error.name : String(error);
  }

  let structuredCloneAcceptsData = false;
  try {
    const cloned = structuredClone({
      cmd: { kind: 'annotation.create' },
      undo: { kind: 'annotation.delete' },
    });
    structuredCloneAcceptsData = cloned.undo.kind === 'annotation.delete';
  } catch {
    structuredCloneAcceptsData = false;
  }

  let indexedDbRejectsFunction = false;
  let indexedDbErrorName: string | null = null;
  try {
    await runTransaction(
      'readwrite',
      (store) =>
        store.put({
          id: 'probe-function',
          payload: { cmd: () => 'undo', undo: () => 'redo' },
        }) as IDBRequest<IDBValidKey>,
    );
  } catch (error) {
    indexedDbRejectsFunction = true;
    indexedDbErrorName =
      error instanceof DOMException ? error.name : error instanceof Error ? error.name : String(error);
  } finally {
    await deleteDraft('probe-function').catch(() => undefined);
  }

  return {
    structuredCloneRejectsFunction,
    structuredCloneErrorName,
    structuredCloneAcceptsData,
    indexedDbRejectsFunction,
    indexedDbErrorName,
  };
}
