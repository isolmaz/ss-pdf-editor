import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { SessionStore, SessionTab } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { inspectXfa, readFormFields } from '../../lazy-ops';
import { EMPTY_OVERLAYS, materializeBase } from '../../operations';
import { formInventoryKey, formInventoryRead, formInventoryReading, useForms } from './forms-store';

export interface FormInventoryInput {
  readonly store: SessionStore;
  readonly t: Translator;
  /** The active tab, or `null` with no document. */
  readonly tab: SessionTab | null;
  /** The engine handle `tab` renders, or `null` until it has one. */
  readonly handle: PdfDocumentHandle | null;
}

/**
 * The form inventory follows the working bytes and the values typed into them (`formInventoryKey`):
 * a stale list would offer to fill a field that no longer exists, or hand Save a value the user
 * has since changed. `readFormFields` is a read, so the cost is one parse of the bytes the
 * viewer already holds. The read starts over when the user asks to retry; one that lands after
 * the next started is dropped.
 *
 * A mark step (draw, erase, undo of a mark) mints a new `working.id` but changes neither, so it
 * does not read again — and does not close Save while it would: the effect depends on the tab's
 * id and the key, never on the `tab` object, and takes the tab from the store when it runs. The
 * fields are read without the pending marks (`EMPTY_OVERLAYS`), which carry none.
 */
export function useFormInventory({ store, t, tab, handle }: FormInventoryInput): void {
  const revision = useForms((state) => state.inspectionRevision);
  const tabId = tab?.id ?? null;
  const key = tab === null ? null : formInventoryKey(tab);
  useEffect(() => {
    void revision;
    void key;
    const current = store.getSnapshot().tabs.find((item) => item.id === tabId);
    if (current === undefined || handle === null) {
      formInventoryReading(null);
      return undefined;
    }
    const controller = new AbortController();
    formInventoryReading(current);
    const readKey = formInventoryKey(current);
    void (async () => {
      try {
        const bytes = await materializeBase(
          { store, t, tab: current, handle },
          { signal: controller.signal },
          undefined,
          EMPTY_OVERLAYS,
        );
        const fields = await readFormFields(bytes, controller.signal);
        // A failed XFA read must not hide the form list: the notice is an extra.
        const xfa = await inspectXfa(bytes).catch(() => null);
        if (!controller.signal.aborted) {
          formInventoryRead({ tabId: current.id, key: readKey, fields, xfa });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          formInventoryRead({
            tabId: current.id,
            key: readKey,
            error: error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' }),
          });
      }
    })();
    return () => controller.abort();
  }, [store, t, tabId, key, handle, revision]);
}
