/** The writer and mark handlers bound to the shell's host. */

import type { OperationOutcome } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { MarkTransform } from 'pdf-core/ops/annotation-transform';
import type { LayerWriteRequest } from 'pdf-core/ops/layer-write';
import type { SessionTab } from 'pdf-model';
import type { MessageKey } from 'pdf-shared';
import { useMemo } from 'react';
import { writeFileAnnotation } from './file-annotation';
import type { MarksHost, WriteFileAnnotation, WriterHost } from './host';
import { removeTargets } from './remove-targets';
import { transformTargets } from './transform-targets';
import { applyWriterOutcome, writeLayers } from './writer';

export interface WriterActions {
  readonly applyWriterOutcome: (
    tab: SessionTab,
    handle: PdfDocumentHandle,
    outcome: OperationOutcome,
    labelKey: MessageKey,
  ) => Promise<void>;
  readonly writeLayers: (request: LayerWriteRequest) => Promise<void>;
}

/** The writer pipeline, rebuilt only when what it runs on changes. */
export function useWriterActions(host: WriterHost): WriterActions {
  const { session, t, contextFor, setHandle, refuseBusy } = host;
  return useMemo(() => {
    const bound: WriterHost = { session, t, contextFor, setHandle, refuseBusy };
    return {
      applyWriterOutcome: (tab, handle, outcome, labelKey) =>
        applyWriterOutcome(bound, tab, handle, outcome, labelKey),
      writeLayers: (request) => writeLayers(bound, request),
    };
  }, [session, t, contextFor, setHandle, refuseBusy]);
}

export interface MarkActions {
  /** Remove the marks named by the keys: one journal step. `false`: nothing was removed. */
  readonly removeTargets: (keys: readonly string[]) => boolean;
  /** Move or rotate the marks named by the keys. `false`: nothing started. */
  readonly transformTargets: (keys: readonly string[], transform: MarkTransform) => boolean;
  readonly writeFileAnnotation: WriteFileAnnotation;
}

/** The mark handlers, rebuilt only when what they run on changes. */
export function useMarkActions(host: MarksHost): MarkActions {
  const { session, t, contextFor, setHandle, refuseBusy, cancel, canEdit, checkpointEngineValues } = host;
  return useMemo(() => {
    const bound: MarksHost = {
      session,
      t,
      contextFor,
      setHandle,
      refuseBusy,
      cancel,
      canEdit,
      checkpointEngineValues,
    };
    return {
      removeTargets: (keys) => removeTargets(bound, keys),
      transformTargets: (keys, transform) => transformTargets(bound, keys, transform),
      writeFileAnnotation: (label, write, done, selectOnPage) =>
        writeFileAnnotation(bound, label, write, done, selectOnPage),
    };
  }, [session, t, contextFor, setHandle, refuseBusy, cancel, canEdit, checkpointEngineValues]);
}
