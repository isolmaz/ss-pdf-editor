/**
 * Source / working / output versioning.
 *
 * Three things stay apart on purpose:
 *  - **source** — the immutable master bytes plus hash; never handed to an engine,
 *    because pdf.js may transfer (detach) a `Uint8Array` it receives;
 *  - **working version** — what the journal currently applies to;
 *  - **output version** — what was actually written where.
 *
 * Undo history is always expressed against the working version, never against
 * "the file on disk".
 */

import { ToolError } from 'pdf-shared';
import type { JsonValue } from './journal';
import type { ProducedDocument } from './operations';

export type Rotation = 0 | 90 | 180 | 270;

export interface SourceDocument {
  readonly id: string;
  readonly name: string;
  /** App-owned master copy. Engines get `copyForEngine()`, never this buffer. */
  readonly master: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly pageCount: number;
  readonly handle?: FileSystemFileHandle;
}

export interface PageBoxOverride {
  readonly media?: readonly [number, number, number, number];
  readonly crop?: readonly [number, number, number, number];
  readonly trim?: readonly [number, number, number, number];
  readonly bleed?: readonly [number, number, number, number];
  readonly art?: readonly [number, number, number, number];
}

export interface PageRef {
  readonly id: string;
  readonly sourceId: string;
  /** 0-based page index inside the source. */
  readonly srcIndex: number;
  /** User rotation, added to the source page rotation. */
  readonly rotation: Rotation;
  readonly boxes?: PageBoxOverride;
}

export interface WorkingVersion {
  readonly id: string;
  /** Stable across undo/redo; unlike id, this identifies document state, not a transition. */
  readonly stateId: string;
  /** Pending, JSON-only canvas edits owned by this version, never by the shell. */
  readonly overlays?: JsonValue;
  readonly fromSources: readonly string[];
  readonly pageOrder: readonly PageRef[];
  /**
   * Bytes produced by the newest applied operation. Absent means "the working
   * version is still the source master" — which is what Export and Save must
   * both respect (the source is never overwritten by a reconstruction).
   */
  readonly produced?: ProducedDocument;
}

/** Page count of what the user is actually looking at, source or produced. */
export function workingPageCount(tab: { source: SourceDocument; working: WorkingVersion }): number {
  return tab.working.produced?.pageCount ?? tab.source.pageCount;
}

export interface OutputVersion {
  readonly id: string;
  readonly fromWorkingVersion: string;
  readonly fromState: string;
  readonly encrypted: boolean;
  readonly appliedSteps: readonly string[];
  readonly steps: readonly string[];
  readonly incremental: boolean;
  /**
   * What verification established for these bytes,
   * stored with the output instead of only announced: the facts that were checked, the
   * facts the operation declared it may change, and every fact this build cannot check.
   *
   * The shape is `verifyForWrite`'s return value (`apps/web/src/operations.ts`), typed
   * with plain strings because the app's fact vocabulary is not `pdf-model`'s concern —
   * this record is data a surface renders, not a contract this module enforces.
   */
  readonly verification?: {
    readonly state: string;
    readonly operation: { readonly kind: string; readonly steps: readonly string[] };
    readonly declared: readonly string[];
    readonly checks: readonly {
      readonly fact: string;
      readonly verdict: string;
      readonly reason?: string;
    }[];
    readonly sampledPages: readonly number[];
  };
  readonly writtenTo?: {
    readonly fileName: string;
    readonly handleId?: string;
    readonly savedAt: number;
    readonly sha256: string;
  };
}

/** Engine-facing copy. The master buffer is never exposed. */
export function copyForEngine(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createSourceDocument(input: {
  name: string;
  master: Uint8Array;
  sha256: string;
  pageCount: number;
  handle?: FileSystemFileHandle;
}): SourceDocument {
  if (input.master.byteLength === 0) {
    throw new ToolError('corrupt-document', { engine: 'model', engineMessage: 'empty source bytes' });
  }
  return {
    id: crypto.randomUUID(),
    name: input.name,
    master: input.master,
    sha256: input.sha256,
    size: input.master.byteLength,
    pageCount: input.pageCount,
    ...(input.handle ? { handle: input.handle } : {}),
  };
}

/** A fresh working version over a single source, in source order. */
export function createWorkingVersion(source: SourceDocument): WorkingVersion {
  const pageOrder: PageRef[] = Array.from({ length: source.pageCount }, (_unused, srcIndex) => ({
    id: crypto.randomUUID(),
    sourceId: source.id,
    srcIndex,
    rotation: 0,
  }));
  return { id: crypto.randomUUID(), stateId: 'source', fromSources: [source.id], pageOrder };
}
