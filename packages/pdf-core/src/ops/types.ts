/**
 * The operation contract every Phase 2 capability runs through
 * (`PLAN.md §3.3`, §5/Phase 2, `REPORT.md §3`).
 *
 * One shape for all 18 capabilities: bytes in → bytes (or files) out, with
 * progress, cancellation and an honest report of what changed. The save router
 * and the UI never talk to an engine directly — they call an operation.
 *
 * Why the report is part of the result and not optional (`PLAN.md §1.2`):
 * "which operation loses what is stated in the UI beforehand" is a product
 * contract, so a capability that cannot describe its own losses cannot be
 * wired in. Notes are i18n keys, which makes an untranslated note a compile
 * error instead of an English string in the interface.
 */

import { type MessageKey, ToolError } from 'pdf-shared';

/** Engines that can produce bytes. Kept as a union so the save report can name them. */
export type OperationEngine = 'pdfjs' | 'mupdf' | 'tesseract' | 'model';

export interface OperationProgress {
  /** Stable step id, used as the progress bar's key (e.g. `render`, `ocr`). */
  readonly phase: string;
  /** i18n key of the sentence shown next to the bar. */
  readonly labelKey: MessageKey;
  readonly done?: number;
  readonly total?: number;
}

export interface OperationContext {
  /** Every long operation is cancellable (`PLAN.md §3.4`). */
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: OperationProgress) => void;
}

export type OperationNoteKind = 'lost' | 'preserved' | 'changed' | 'warning';

export interface OperationNote {
  readonly kind: OperationNoteKind;
  readonly key: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface OperationReport {
  readonly engine: OperationEngine;
  /** Engine steps that actually ran, in order (`PLAN.md §3.3` step 3). */
  readonly steps: readonly string[];
  readonly notes: readonly OperationNote[];
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly pageCount: number;
  /**
   * Whether the file *format* stayed incremental. Any non-incremental writer
   * ends the fast path and must say so in the report (`PLAN.md §3.3` rule 3).
   */
  readonly incremental: boolean;
}

export interface OperationOutcome {
  readonly bytes: Uint8Array;
  readonly report: OperationReport;
}

/** A produced file that is not the working document (split parts, images, text). */
export interface OutputFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/**
 * A rectangle on one page in **unrotated user space** with a top-left origin —
 * the space `RedactRect` already uses and the space every overlay and the pointer
 * conversion speak (`[x0, y0, x1, y1]`, ascending).
 *
 * Shared by the annotation writer, the page-box operations and the redaction
 * marks so one coordinate rule cannot drift between three callers.
 */
export interface PageRect {
  readonly pageIndex: number;
  readonly rect: readonly [number, number, number, number];
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('operation aborted');
    error.name = 'AbortError';
    throw error;
  }
}

/**
 * One constructor for report notes. `kind` carries the honesty contract:
 * `lost` = the user must be told, `preserved` = the deliberate guarantee,
 * `changed` = the operation altered it, `warning` = an advisory.
 */
export function note(
  kind: OperationNoteKind,
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
): OperationNote {
  return params === undefined ? { kind, key } : { kind, key, params };
}

/** Human-readable byte size for report params (`1.2 MB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Body of an operation whose engine work has not landed yet. During the Phase 2
 * build the op files exist with their final signatures so parallel work cannot
 * drift; a capability that is still a stub fails loudly (and is caught by the
 * Phase 2 verification script) instead of quietly producing an unchanged file.
 */
export function notImplemented(operation: string): never {
  throw new ToolError('unsupported', {
    engine: 'model',
    engineMessage: `operation not implemented: ${operation}`,
  });
}
