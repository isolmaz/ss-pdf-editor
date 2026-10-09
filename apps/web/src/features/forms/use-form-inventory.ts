import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { SessionStore, SessionTab } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { inspectXfa, readFormFields } from '../../lazy-ops';
import { materializeBase } from '../../operations';
import { formInventoryRead, formInventoryReading, useForms } from './forms-store';

export interface FormInventoryInput {
  readonly store: SessionStore;
  readonly t: Translator;
  /** The active tab, or `null` with no document. */
  readonly tab: SessionTab | null;
  /** The engine handle `tab` renders, or `null` until it has one. */
  readonly handle: PdfDocumentHandle | null;
}

/**
 * The form inventory follows the working version: `working.id` changes when an operation
 * lands, and a stale list would offer to fill a field that no longer exists. `readFormFields`
 * is a read, so the cost is one parse of the bytes the viewer already holds. The read starts
 * over when the user asks to retry; one that lands after the next started is dropped.
 */
export function useFormInventory({ store, t, tab, handle }: FormInventoryInput): void {
  const revision = useForms((state) => state.inspectionRevision);
  // `tab` carries `working.id`: the effect re-runs when an operation lands, which is exactly
  // when the inventory can have changed.
  useEffect(() => {
    void revision;
    if (tab === null || handle === null) {
      formInventoryReading(null);
      return undefined;
    }
    const controller = new AbortController();
    formInventoryReading(tab);
    void (async () => {
      try {
        const bytes = await materializeBase({ store, t, tab, handle }, { signal: controller.signal });
        const fields = await readFormFields(bytes, controller.signal);
        // A failed XFA read must not hide the form list: the notice is an extra.
        const xfa = await inspectXfa(bytes).catch(() => null);
        if (!controller.signal.aborted) {
          formInventoryRead({ tabId: tab.id, version: tab.working.id, fields, xfa });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          formInventoryRead({
            tabId: tab.id,
            version: tab.working.id,
            error: error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' }),
          });
      }
    })();
    return () => controller.abort();
  }, [store, t, tab, handle, revision]);
}
