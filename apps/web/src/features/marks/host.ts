/** What the mark handlers need from the shell: the pieces it still owns. */

import type { OperationOutcome } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { SessionStore, SessionTab } from 'pdf-model';
import type { MessageKey, Translator } from 'pdf-shared';
import type { DocumentContext } from '../../operations';

/** What a writer that changes a file's bytes needs: the session, the translator and the document plumbing. */
export interface WriterHost {
  readonly session: SessionStore;
  readonly t: Translator;
  /** The context an operation on `tab` runs in. */
  readonly contextFor: (tab: SessionTab, handle: PdfDocumentHandle) => DocumentContext;
  /** Swap `tabId`'s engine handle for the one an operation produced. */
  readonly setHandle: (tabId: string, handle: PdfDocumentHandle) => void;
  /** Say that the document is busy. */
  readonly refuseBusy: () => void;
}

/** What removing, moving and writing marks needs: the writer's host and the gates around an edit. */
export interface MarksHost extends WriterHost {
  /** The controller of the operation holding the document; the progress overlay's Cancel aborts it. */
  readonly cancel: { current: AbortController | null };
  /** `canEdit` for a handler that must not act on the render it was created in. */
  readonly canEdit: { readonly current: boolean };
  /** Fold the engine's live form values into the journal; whether anything changed. */
  readonly checkpointEngineValues: () => Promise<boolean>;
  /** The mark to select once the re-read inventory lists the file annotation a write just added. */
  readonly selectAfterWrite: { current: string | null };
}

/** The shell's write into a file annotation; `false` means it did not start. */
export type WriteFileAnnotation = (
  label: { readonly key: MessageKey; readonly params?: Record<string, string | number> },
  write: (
    base: Uint8Array,
    signal: AbortSignal,
  ) => Promise<OperationOutcome & { readonly annotationId?: string }>,
  done: string,
  selectOnPage?: number,
) => boolean;
