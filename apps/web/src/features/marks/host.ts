/** What the mark handlers need from the shell: the pieces it still owns. */

import type { OperationOutcome } from 'pdf-core';
import type { SessionStore } from 'pdf-model';
import type { MessageKey, Translator } from 'pdf-shared';

/** What a writer that changes a file's bytes needs: the session and the translator. */
export interface WriterHost {
  readonly session: SessionStore;
  readonly t: Translator;
}

/** What removing, moving and writing marks needs: the writer's host and the shell's engine checkpoint. */
export interface MarksHost extends WriterHost {
  /** Fold the engine's live form values into the journal; whether anything changed. */
  readonly checkpointEngineValues: () => Promise<boolean>;
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
