import type { JournalEntry, JournalOperation, JsonValue } from './journal';
import { JOURNAL_SCHEMA } from './journal';
import type { ProducedDocument } from './operations';

/**
 * Drafts — what a session leaves behind so a closed tab can come back (“the
 * draft returns after closing and reopening the tab”).
 *
 * Two rules shape this module, and both are contracts rather than preferences:
 *
 * - **The draft is model data** (draft-cost gate: a 300 MB document’s draft
 *   writes model data only). Change data — the journal — is what a draft carries.
 * - **The master copy belongs to the source vault, not to the draft.** A source
 *   that lives on the user’s disk through a File System Access handle is referred to
 *   by an opaque `sourceKey`; a handle-less source (file input, drag & drop) gets a
 *   vault entry, written **once** when the document opens, never re-written per
 *   change.
 *
 * The module is DOM-free on purpose: the storage backend arrives as an interface, so
 * the OPFS implementation lives in the browser app and this policy stays testable in
 * Node.
 */

export interface DraftSnapshot extends Omit<ProducedDocument, 'bytes'> {
  readonly key: string;
}

export interface Draft {
  readonly id: string;
  readonly name: string;
  readonly pageCount: number;
  readonly size: number;
  readonly dirty: boolean;
  readonly updatedAt: number;
  /** Points at the vault entry that holds this source’s bytes. */
  readonly sourceKey: string;
  readonly journal: readonly JournalEntry[];
  readonly journalCursor?: number;
  readonly stateId?: string;
  readonly savedState?: string | null;
  readonly overlays?: JsonValue;
  readonly sourcePageCount?: number;
  readonly workingId?: string;
  readonly snapshots?: readonly DraftSnapshot[];
  /**
   * Engine-side edits that are **not** in the bytes yet — form values and annotation
   * changes (`annotationStorage`), which only reach the file when the user saves.
   * Without them a restored tab would look dirty but silently lose the edits.
   */
  readonly engineValues: EngineValuesDraft;
}

/** One engine-side edit: the storage key pdf.js uses (annotation/field id) and its value. */
export interface EngineValue {
  readonly key: string;
  readonly value: Record<string, unknown>;
}

/**
 * The engine-side delta of a draft. `dropped` counts entries that could not be
 * represented (non-JSON values, or bitmaps past the budget) so the restore path can
 * tell the user the truth instead of pretending everything came back.
 */
export interface EngineValuesDraft {
  readonly entries: readonly EngineValue[];
  readonly dropped: number;
}

export const EMPTY_ENGINE_VALUES: EngineValuesDraft = { entries: [], dropped: 0 };

/** Bitmaps (highlight/ink masks) are the only large members; this caps their total. */
export const ENGINE_VALUE_BITMAP_BUDGET = 2 * 1024 * 1024;

const BITMAP_MARKER = '__pdfEditorBitmap';

/** A value the encoder refuses to carry. */
const UNREPRESENTABLE = Symbol('unrepresentable');

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * JSON-safe projection of a storage value. Plain objects and arrays are copied; a
 * `Blob` bitmap becomes a base64 marker while the budget lasts; anything else
 * (functions, cyclic objects, typed arrays) is refused rather than silently mangled.
 */
async function encodeValue(value: unknown, spend: (bytes: number) => boolean, depth = 0): Promise<unknown> {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : UNREPRESENTABLE;
  if (depth > 8) return UNREPRESENTABLE;
  if (isBlob(value)) {
    if (!spend(value.size)) return UNREPRESENTABLE;
    const bytes = new Uint8Array(await value.arrayBuffer());
    return { [BITMAP_MARKER]: toBase64(bytes), type: value.type };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const encoded = await encodeValue(item, spend, depth + 1);
      if (encoded === UNREPRESENTABLE) return UNREPRESENTABLE;
      items.push(encoded);
    }
    return items;
  }
  if (typeof value === 'object') {
    // Only a *plain* object is a record. A typed array, a `Map`, a `Date` or an engine
    // class instance projects into `{0: …, 1: …}` under `Object.entries`, which decodes to
    // an object that is not the value that was stored — a silently wrong restore. Such a
    // value is counted as dropped instead.
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return UNREPRESENTABLE;
    const source = value as Record<string, unknown>;
    if (typeof source.then === 'function') return UNREPRESENTABLE; // never a promise
    const encoded: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(source)) {
      const result = await encodeValue(member, spend, depth + 1);
      if (result === UNREPRESENTABLE) return UNREPRESENTABLE;
      encoded[key] = result;
    }
    return encoded;
  }
  return UNREPRESENTABLE;
}

/** Blob markers come back as blobs, everything else is already a plain value. */
function decodeValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, depth + 1));
  const source = value as Record<string, unknown>;
  const marker = source[BITMAP_MARKER];
  if (typeof marker === 'string') {
    const type = typeof source.type === 'string' ? source.type : 'application/octet-stream';
    return new Blob([fromBase64(marker)], { type });
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(source)) decoded[key] = decodeValue(member, depth + 1);
  return decoded;
}

/**
 * Turns `annotationStorage` entries into a draft payload. Field values are plain
 * objects; annotation edits (highlight, ink, free text) serialize to plain objects as
 * well, so both travel the same way — and an entry that cannot be represented is
 * counted in `dropped` instead of being written as a broken half-value.
 */
export async function encodeEngineValues(
  entries: Iterable<readonly [string, unknown]>,
  budget = ENGINE_VALUE_BITMAP_BUDGET,
): Promise<EngineValuesDraft> {
  let remaining = budget;
  const encoded: EngineValue[] = [];
  let dropped = 0;
  for (const [key, raw] of entries) {
    /**
     * The budget is spent **per entry and only on success**. Charging as we go let an
     * entry that was then refused keep the bytes it had already claimed, so a value that
     * was never written could starve a later one that would have fitted.
     */
    let spent = 0;
    const value = await encodeValue(raw, (bytes) => {
      if (bytes > remaining - spent) return false;
      spent += bytes;
      return true;
    });
    if (value === UNREPRESENTABLE || typeof value !== 'object' || value === null) {
      dropped += 1;
      continue;
    }
    remaining -= spent;
    encoded.push({ key, value: value as Record<string, unknown> });
  }
  return { entries: encoded, dropped };
}

/** The inverse of {@link encodeEngineValues}: the pairs `setValue()` expects. */
export function decodeEngineValues(draft: EngineValuesDraft): Array<[string, Record<string, unknown>]> {
  return draft.entries.map((entry) => [entry.key, decodeValue(entry.value) as Record<string, unknown>]);
}

export interface DraftInventory {
  readonly drafts: readonly Draft[];
  readonly unreadable: readonly string[];
  readonly enumerationFailed?: boolean;
}

/** Storage the app provides: OPFS in the browser, a map in tests. */
export interface DraftStorage {
  writeDraft(draft: Draft): Promise<void>;
  readDrafts(): Promise<readonly Draft[]>;
  readDraftInventory?(): Promise<DraftInventory>;
  deleteDraft(id: string): Promise<void>;
  /** One-shot vault write: `bytes` are only stored when the key is new. */
  putSource(key: string, bytes: Uint8Array): Promise<void>;
  getSource(key: string): Promise<Uint8Array | null>;
  hasSource(key: string): Promise<boolean>;
  deleteSource(key: string): Promise<void>;
  listSources?(): Promise<readonly string[]>;
}

/** Source key for a document: content-addressed hash when available, otherwise document id. */
export function sourceKeyFor(documentId: string, contentHash: string | null): string {
  if (contentHash === null || contentHash === '') return documentId;
  if (contentHash.startsWith('src-') || contentHash.startsWith('fp-')) return contentHash;
  return `src-${contentHash}`;
}

/**
 * The draft record for a tab. `now` is injected so the caller decides the clock —
 * a draft's timestamp is user-visible information, not a side effect of import order.
 */
export function draftFor(input: {
  readonly id: string;
  readonly name: string;
  readonly pageCount: number;
  readonly size: number;
  readonly dirty: boolean;
  readonly sourceKey: string;
  readonly journal: readonly JournalEntry[];
  readonly journalCursor?: number;
  readonly stateId?: string;
  readonly savedState?: string | null;
  readonly overlays?: JsonValue;
  readonly sourcePageCount?: number;
  readonly workingId?: string;
  readonly snapshots?: readonly DraftSnapshot[];
  readonly engineValues?: EngineValuesDraft;
  readonly now: number;
}): Draft {
  return {
    id: input.id,
    name: input.name,
    pageCount: input.pageCount,
    size: input.size,
    dirty: input.dirty,
    updatedAt: input.now,
    sourceKey: input.sourceKey,
    journal: input.journal,
    journalCursor: input.journalCursor ?? input.journal.length,
    ...(input.stateId === undefined ? {} : { stateId: input.stateId }),
    ...(input.savedState === undefined ? {} : { savedState: input.savedState }),
    ...(input.overlays === undefined ? {} : { overlays: input.overlays }),
    ...(input.sourcePageCount === undefined ? {} : { sourcePageCount: input.sourcePageCount }),
    ...(input.workingId === undefined ? {} : { workingId: input.workingId }),
    ...(input.snapshots === undefined ? {} : { snapshots: input.snapshots }),
    engineValues: input.engineValues ?? EMPTY_ENGINE_VALUES,
  };
}

/** Newest first, which is the order a “reopen what I had” list wants. */
export function sortDrafts(drafts: readonly Draft[]): readonly Draft[] {
  return [...drafts].sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * Whether a draft is worth restoring. A clean draft (`dirty: false`) with no journal
 * carries nothing the user did not already have on disk, so it is dropped instead of
 * filling the shell with tabs nobody asked for.
 */
export function isRestorable(draft: Draft): boolean {
  return draft.dirty || draft.journal.length > 0;
}

/** A safe count: a page or byte total has to be a non-negative whole number. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One journal entry, validated as a whole: a half-read entry is not an entry. */
function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<JournalEntry>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) return false;
  if (!isCount(entry.seq) || !isCount(entry.timestamp)) return false;
  if (typeof entry.labelKey !== 'string' || entry.labelKey.length === 0) return false;
  if (entry.engine !== 'model' && entry.engine !== 'pdfjs-editor' && entry.engine !== 'mupdf') return false;
  if (entry.schema !== JOURNAL_SCHEMA) return false;
  const operation = entry.op as Partial<JournalOperation> | undefined;
  return typeof operation === 'object' && operation !== null && typeof operation.kind === 'string';
}

/**
 * The journal, validated as a **unit**.
 *
 * A filtered array is worse than a rejected one: the cursor that was persisted with the
 * journal points into that array, so dropping a malformed entry silently shifts every
 * logical state after it — the restored document would show a different history from the
 * one the user left, and `undo` would step to the wrong version. One bad entry
 * therefore makes the whole draft unreadable, and the caller reports that instead.
 *
 * Returns `null` for “not readable”, never a repaired array.
 */
function parseJournal(entries: unknown, cursor: unknown): { journal: JournalEntry[]; cursor: number } | null {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set<string>();
  let previousSeq = -1;
  for (const entry of list) {
    if (!isJournalEntry(entry)) return null;
    if (seen.has(entry.id)) return null;
    seen.add(entry.id);
    // `append` numbers entries from the length of the array it is pushing into, so a
    // persisted sequence that does not advance by one is a journal this build did not
    // write — and one whose cursor cannot be trusted.
    if (entry.seq !== previousSeq + 1) return null;
    previousSeq = entry.seq;
  }
  const position = cursor === undefined ? list.length : cursor;
  if (!isCount(position) || position > list.length) return null;
  return { journal: list as JournalEntry[], cursor: position };
}

/** JSON round-trip validation: a draft read from storage is untrusted input. */
export function parseDraft(raw: unknown): Draft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<Draft>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return null;
  if (typeof candidate.sourceKey !== 'string') return null;
  if (!isCount(candidate.pageCount) || !isCount(candidate.size)) return null;
  const parsedJournal = parseJournal(candidate.journal, candidate.journalCursor);
  if (parsedJournal === null) return null;
  const rawEngineValues = candidate.engineValues as Partial<EngineValuesDraft> | undefined;
  const engineValues: EngineValuesDraft = {
    entries: Array.isArray(rawEngineValues?.entries)
      ? (rawEngineValues.entries.filter(
          (entry): entry is EngineValue =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as EngineValue).key === 'string' &&
            typeof (entry as EngineValue).value === 'object' &&
            (entry as EngineValue).value !== null,
        ) as EngineValue[])
      : [],
    dropped: typeof rawEngineValues?.dropped === 'number' ? rawEngineValues.dropped : 0,
  };

  const parsedSnapshots: DraftSnapshot[] = [];
  const snapshotIds = new Set<string>();
  const snapshotKeys = new Set<string>();
  for (const item of Array.isArray(candidate.snapshots) ? candidate.snapshots : []) {
    if (typeof item !== 'object' || item === null) return null;
    const snapshot = item as Partial<DraftSnapshot>;
    if (typeof snapshot.id !== 'string' || typeof snapshot.key !== 'string') return null;
    if (typeof snapshot.labelKey !== 'string' || !isCount(snapshot.pageCount) || snapshot.pageCount < 1)
      return null;
    if (!isCount(snapshot.inputBytes)) return null;
    // Two snapshots sharing an id would make `workingId` ambiguous; two sharing a key
    // would make one blob stand for two different versions.
    if (snapshotIds.has(snapshot.id) || snapshotKeys.has(snapshot.key)) return null;
    snapshotIds.add(snapshot.id);
    snapshotKeys.add(snapshot.key);
    parsedSnapshots.push(snapshot as DraftSnapshot);
  }
  // A `workingId` that names no snapshot would restore a tab whose working version cannot
  // be found, which the restore path would then have to guess at.
  if (typeof candidate.workingId === 'string' && !snapshotIds.has(candidate.workingId)) return null;

  return {
    id: candidate.id,
    name: candidate.name,
    pageCount: candidate.pageCount,
    size: candidate.size,
    dirty: candidate.dirty === true,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
    sourceKey: candidate.sourceKey,
    journalCursor: parsedJournal.cursor,
    ...(typeof candidate.stateId === 'string' ? { stateId: candidate.stateId } : {}),
    ...(typeof candidate.savedState === 'string' || candidate.savedState === null
      ? { savedState: candidate.savedState }
      : {}),
    ...(typeof candidate.sourcePageCount === 'number' ? { sourcePageCount: candidate.sourcePageCount } : {}),
    ...(typeof candidate.workingId === 'string' ? { workingId: candidate.workingId } : {}),
    ...(candidate.overlays !== undefined ? { overlays: candidate.overlays } : {}),
    snapshots: parsedSnapshots,
    engineValues,
    journal: parsedJournal.journal,
  };
}
