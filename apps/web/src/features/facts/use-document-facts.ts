import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { SessionStore, SessionTab } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { inspectProtection, listPdfFonts, verifySignatures } from '../../lazy-ops';
import { materializeBase } from '../../operations';
import { measuredAttachments } from '../attachments/attachments';
import { factsFailed, factsRead, factsReading } from './facts-store';
import { useTrust } from './trust-store';

export interface DocumentFactsInput {
  readonly store: SessionStore;
  readonly t: Translator;
  /** The active tab, or `null` with no document. */
  readonly tab: SessionTab | null;
  /** The engine handle `tab` renders, or `null` until it has one. */
  readonly handle: PdfDocumentHandle | null;
  /** Bumped by the "retry" button: reading the facts starts over. */
  readonly revision: number;
}

/**
 * Keep the document facts in step with the document on screen. The read starts over whenever an
 * operation lands (`tab` carries `working.id`), the handle is swapped, the user imports a trust
 * root or CRL (exactly what changes a verdict) or asks to retry; a read that lands after the
 * next one started is dropped.
 */
export function useDocumentFacts({ store, t, tab, handle, revision }: DocumentFactsInput): void {
  const rootBytes = useTrust((state) => state.rootBytes);
  const listBytes = useTrust((state) => state.listBytes);
  useEffect(() => {
    void revision;
    factsReading();
    if (tab === null || handle === null) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const bytes = await materializeBase({ store, t, tab, handle }, { signal: controller.signal });
        const [fonts, signatures, attachments, protection] = await Promise.all([
          listPdfFonts(bytes, controller.signal),
          verifySignatures(bytes, controller.signal, { roots: rootBytes, crls: listBytes }),
          measuredAttachments(handle, controller.signal),
          inspectProtection(bytes),
        ]);
        if (controller.signal.aborted) return;
        factsRead({
          tabId: tab.id,
          version: tab.working.id,
          fonts,
          signatures,
          attachments,
          // The protection state comes from the engine's own reader, not from a guess: an
          // unencrypted document reports `encrypted: false` and no permissions, which is a
          // fact and not an empty table.
          security: {
            encrypted: protection.encrypted,
            // Only the permissions the document actually **grants** are listed: a table of
            // every bit with a yes/no column would bury the one line the user is looking for.
            permissions: Object.entries(protection.permissions)
              .filter(([, granted]) => granted)
              .map(([name]) => name),
          },
        });
      } catch (error) {
        if (!controller.signal.aborted)
          factsFailed({
            tabId: tab.id,
            version: tab.working.id,
            error: error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' }),
          });
      }
    })();
    return () => controller.abort();
  }, [store, t, tab, handle, rootBytes, listBytes, revision]);
}
