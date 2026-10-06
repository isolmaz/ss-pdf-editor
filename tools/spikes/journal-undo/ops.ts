/**
 * Operation vocabulary and the apply/revert implementations for spike #2.
 *
 * Every entry carries **data only** (`PLAN.md §9/K12`, §3.2 rule 1), and both
 * directions are computed from the payload alone — `applyEntry` is the inverse of
 * `revertEntry` with no hidden state. That is what makes the journal replayable
 * onto a *fresh* engine after a reload.
 *
 * The same two functions drive:
 *  - `EngineTarget` — the real pdf.js `annotationStorage` plus the page model, and
 *  - `ModelTarget` — a pure in-memory replay used as the independent oracle.
 */
import type { JournalEntry, JsonValue } from 'pdf-model';

/**
 * pdf.js only treats a storage entry as a *new annotation on save* when the key
 * starts with this prefix (`pdfjs_internal_editor_`, `build/pdf.mjs:55`,
 * consumed by `getNewAnnotationsMap`, `build/pdf.worker.mjs:1711-1723`).
 */
export const ANNOTATION_KEY_PREFIX = 'pdfjs_internal_editor_';

export function annotationKey(): string {
  return `${ANNOTATION_KEY_PREFIX}${crypto.randomUUID()}`;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface PageState {
  readonly id: string;
  readonly srcIndex: number;
  rotation: Rotation;
}

export type OpKind =
  | 'annotation.create'
  | 'annotation.update'
  | 'annotation.delete'
  | 'page.rotate'
  | 'page.reorder';

/**
 * The only interface the operations touch. `EngineTarget` writes into pdf.js,
 * `ModelTarget` into a plain Map — identical code path, so a digest mismatch can
 * only come from the journal, never from a second implementation of the ops.
 */
export interface OpTarget {
  readonly pages: PageState[];
  getAnnotation(key: string): JsonValue | undefined;
  setAnnotation(key: string, value: JsonValue): void;
  removeAnnotation(key: string): void;
  /** Engine side only: pdf.js keeps stamp pixels in its `ImageManager`. */
  ensureRaster(value: JsonValue): Promise<void>;
  dropRaster(value: JsonValue): void;
}

export interface CanonicalView {
  readonly pages: readonly { id: string; srcIndex: number; rotation: number }[];
  readonly annotations: readonly { key: string; value: JsonValue }[];
}

/** Deterministic JSON (object keys sorted) so a digest is stable across engines. */
export function stableStringify(value: JsonValue | undefined): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export async function digestView(view: CanonicalView): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(view as unknown as JsonValue));
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** First difference between two states, so a mismatch is diagnosable. */
export function firstDifference(left: CanonicalView, right: CanonicalView): string | null {
  const leftPages = stableStringify(left.pages as unknown as JsonValue);
  const rightPages = stableStringify(right.pages as unknown as JsonValue);
  if (leftPages !== rightPages) return `pages: ${leftPages.slice(0, 160)} != ${rightPages.slice(0, 160)}`;
  const size = Math.max(left.annotations.length, right.annotations.length);
  for (let index = 0; index < size; index += 1) {
    const a = left.annotations[index];
    const b = right.annotations[index];
    if (stableStringify(a as unknown as JsonValue) !== stableStringify(b as unknown as JsonValue)) {
      return `annotations[${index}]: ${stableStringify(a as unknown as JsonValue).slice(0, 160)} != ${stableStringify(
        b as unknown as JsonValue,
      ).slice(0, 160)}`;
    }
  }
  return null;
}

function payloadOf(entry: JournalEntry): Record<string, JsonValue> {
  const payload = entry.op.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${entry.op.kind}: payload is not an object`);
  }
  return payload;
}

function expectString(payload: Record<string, JsonValue>, field: string, kind: string): string {
  const value = payload[field];
  if (typeof value !== 'string') throw new Error(`${kind}: payload.${field} is not a string`);
  return value;
}

function expectNumber(payload: Record<string, JsonValue>, field: string, kind: string): number {
  const value = payload[field];
  if (typeof value !== 'number') throw new Error(`${kind}: payload.${field} is not a number`);
  return value;
}

function expectObject(payload: Record<string, JsonValue>, field: string, kind: string): JsonValue {
  const value = payload[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${kind}: payload.${field} is not an object`);
  }
  return value;
}

function asRotation(value: number): Rotation {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  throw new Error(`rotation ${value} is not a multiple of 90`);
}

/** Merge a partial patch over a stored value (both directions use this). */
function mergePatch(current: JsonValue | undefined, patch: JsonValue): JsonValue {
  const base =
    current !== undefined && current !== null && typeof current === 'object' && !Array.isArray(current)
      ? current
      : {};
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('annotation patch is not an object');
  }
  return { ...base, ...patch };
}

function pageById(target: OpTarget, pageId: string): PageState {
  const page = target.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`page ${pageId} is not in the working version`);
  return page;
}

function movePage(target: OpTarget, from: number, to: number): void {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= target.pages.length ||
    to < 0 ||
    to >= target.pages.length
  ) {
    throw new Error(`page reorder ${from} -> ${to} is out of range`);
  }
  const removed = target.pages.splice(from, 1);
  const moved = removed[0];
  if (!moved) throw new Error(`page reorder ${from} -> ${to} moved nothing`);
  target.pages.splice(to, 0, moved);
}

export async function applyEntry(target: OpTarget, entry: JournalEntry): Promise<void> {
  const payload = payloadOf(entry);
  const kind = entry.op.kind;
  switch (kind) {
    case 'annotation.create': {
      const value = expectObject(payload, 'value', kind);
      target.setAnnotation(expectString(payload, 'key', kind), value);
      await target.ensureRaster(value);
      return;
    }
    case 'annotation.update': {
      const key = expectString(payload, 'key', kind);
      target.setAnnotation(key, mergePatch(target.getAnnotation(key), expectObject(payload, 'after', kind)));
      return;
    }
    case 'annotation.delete': {
      const value = expectObject(payload, 'value', kind);
      target.removeAnnotation(expectString(payload, 'key', kind));
      target.dropRaster(value);
      return;
    }
    case 'page.rotate': {
      pageById(target, expectString(payload, 'pageId', kind)).rotation = asRotation(
        expectNumber(payload, 'to', kind),
      );
      return;
    }
    case 'page.reorder': {
      movePage(target, expectNumber(payload, 'from', kind), expectNumber(payload, 'to', kind));
      return;
    }
    default:
      throw new Error(`unknown op kind: ${kind}`);
  }
}

export async function revertEntry(target: OpTarget, entry: JournalEntry): Promise<void> {
  const payload = payloadOf(entry);
  const kind = entry.op.kind;
  switch (kind) {
    case 'annotation.create': {
      const value = expectObject(payload, 'value', kind);
      target.removeAnnotation(expectString(payload, 'key', kind));
      target.dropRaster(value);
      return;
    }
    case 'annotation.update': {
      const key = expectString(payload, 'key', kind);
      target.setAnnotation(key, mergePatch(target.getAnnotation(key), expectObject(payload, 'before', kind)));
      return;
    }
    case 'annotation.delete': {
      const value = expectObject(payload, 'value', kind);
      target.setAnnotation(expectString(payload, 'key', kind), value);
      await target.ensureRaster(value);
      return;
    }
    case 'page.rotate': {
      pageById(target, expectString(payload, 'pageId', kind)).rotation = asRotation(
        expectNumber(payload, 'from', kind),
      );
      return;
    }
    case 'page.reorder': {
      movePage(target, expectNumber(payload, 'to', kind), expectNumber(payload, 'from', kind));
      return;
    }
    default:
      throw new Error(`unknown op kind: ${kind}`);
  }
}

/** Apply the first `count` entries of a journal snapshot onto a target. */
export async function replayPrefix(
  target: OpTarget,
  entries: readonly JournalEntry[],
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index];
    if (!entry) throw new Error(`journal prefix replay ran past entry ${index}`);
    await applyEntry(target, entry);
  }
}

/**
 * The pure oracle: journal-only replay with no engine involved. A digest over
 * this state is what the live engine state is compared against after every undo
 * and redo step.
 */
export class ModelTarget implements OpTarget {
  readonly pages: PageState[];
  #annotations = new Map<string, JsonValue>();

  constructor(pages: readonly PageState[]) {
    this.pages = pages.map((page) => ({ ...page }));
  }

  getAnnotation(key: string): JsonValue | undefined {
    return this.#annotations.get(key);
  }

  setAnnotation(key: string, value: JsonValue): void {
    this.#annotations.set(key, value);
  }

  removeAnnotation(key: string): void {
    this.#annotations.delete(key);
  }

  async ensureRaster(): Promise<void> {
    // The pure model tracks data only; the raster side channel is engine-only.
  }

  dropRaster(): void {
    // See ensureRaster.
  }

  view(): CanonicalView {
    return {
      pages: this.pages.map((page) => ({ id: page.id, srcIndex: page.srcIndex, rotation: page.rotation })),
      annotations: [...this.#annotations.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => ({ key, value })),
    };
  }
}

export function basePages(pageCount: number): PageState[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    id: `p${index}`,
    srcIndex: index,
    rotation: 0 as Rotation,
  }));
}
