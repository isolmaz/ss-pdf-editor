/**
 * OPFS-backed draft storage: the browser half of
 * `pdf-model/drafts`, which stays DOM-free.
 *
 * Layout inside the origin's private file system:
 *
 *   /pdf-editor/drafts/<id>.json   — model data: name, size, dirty flag, journal
 *   /pdf-editor/sources/<key>.pdf  — the master copy of a handle-less source,
 *                                    written once per source, never per change
 *
 * Drafts of documents the user opened through a File System Access handle keep that
 * handle in the session and only need the model data here, so the vault stays small.
 */

import type { Draft, DraftInventory, DraftStorage } from 'pdf-model';
import { parseDraft } from 'pdf-model';

const ROOT = 'pdf-editor';
const DRAFTS = 'drafts';
const SOURCES = 'sources';

/**
 * One small file in the app's own OPFS directory. The trust roots (`pdf-model/trust-roots`)
 * and the licence-free settings that will follow live here: they are *settings*, not
 * drafts, so they are not pruned with the source paths and they carry their own version.
 */
export async function readAppFile(name: string): Promise<unknown> {
  const bytes = await readFile(ROOT, name);
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function writeAppFile(name: string, value: unknown): Promise<void> {
  await writeFile(ROOT, name, JSON.stringify(value));
}

async function directory(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle(ROOT, { create: true });
  return app.getDirectoryHandle(name, { create: true });
}

async function writeFile(path: string, name: string, data: string | Uint8Array): Promise<void> {
  const target = await directory(path);
  const handle = await target.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  } catch (error) {
    // A writable that rejects leaves its swap file and its exclusive lock behind, and the
    // file keeps its previous contents — which is why the caller must see the failure
    // rather than a success. The abort is best-effort: it must never replace the error
    // that explains what actually went wrong.
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function fileSize(path: string, name: string): Promise<number | null> {
  try {
    const target = await directory(path);
    const handle = await target.getFileHandle(name);
    return (await handle.getFile()).size;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function readFile(path: string, name: string): Promise<Uint8Array | null> {
  try {
    const target = await directory(path);
    const handle = await target.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function removeFile(path: string, name: string): Promise<void> {
  try {
    const target = await directory(path);
    await target.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
  }
}

async function entries(path: string): Promise<string[]> {
  const names: string[] = [];
  const target = await directory(path);
  for await (const [name] of target.entries()) names.push(name);
  return names;
}

export function createOpfsDraftStorage(): DraftStorage {
  return {
    async writeDraft(draft: Draft): Promise<void> {
      await writeFile(DRAFTS, `${draft.id}.json`, JSON.stringify(draft));
    },

    async readDraftInventory(): Promise<DraftInventory> {
      let names: string[];
      try {
        names = await entries(DRAFTS);
      } catch {
        return { drafts: [], unreadable: [], enumerationFailed: true };
      }
      const drafts: Draft[] = [];
      const unreadable: string[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        // One unreadable file is *reported*, never fatal: a read that throws here would
        // abort the whole inventory and make every remaining draft look absent, which is
        // exactly the state a cleanup pass must not mistake for “nothing is referenced”.
        try {
          const bytes = await readFile(DRAFTS, name);
          if (bytes === null) {
            unreadable.push(name);
            continue;
          }
          const parsed = parseDraft(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
          if (parsed !== null) drafts.push(parsed);
          else unreadable.push(name);
        } catch {
          unreadable.push(name);
        }
      }
      return { drafts, unreadable };
    },

    async readDrafts(): Promise<readonly Draft[]> {
      const inventory = await (this.readDraftInventory?.() ?? { drafts: [] });
      return inventory.drafts;
    },

    async deleteDraft(id: string): Promise<void> {
      await removeFile(DRAFTS, `${id}.json`);
    },

    async listSources(): Promise<readonly string[]> {
      try {
        const names = await entries(SOURCES);
        return names.filter((name) => name.endsWith('.pdf')).map((name) => name.replace(/\.pdf$/, ''));
      } catch {
        return [];
      }
    },

    async putSource(key: string, bytes: Uint8Array): Promise<void> {
      // The vault is write-once per key: `sourceKeyFor()` derives the key from the
      // document fingerprint, so an identical document never writes twice — which is
      // also why comparing the *size* is enough here (a hash-keyed entry with the same
      // length is the same document). Reading the stored copy to compare byte lengths
      // meant pulling the whole vault entry into memory on every open — 130 MB of I/O
      // for a 130 MB document, on the path the user waits for.
      const existing = await fileSize(SOURCES, `${key}.pdf`);
      if (existing === bytes.byteLength) return;
      await writeFile(SOURCES, `${key}.pdf`, bytes);
    },

    async getSource(key: string): Promise<Uint8Array | null> {
      return readFile(SOURCES, `${key}.pdf`);
    },

    async hasSource(key: string): Promise<boolean> {
      return (await fileSize(SOURCES, `${key}.pdf`)) !== null;
    },

    async deleteSource(key: string): Promise<void> {
      await removeFile(SOURCES, `${key}.pdf`);
    },
  };
}
