import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type SessionStore, type SessionTab, workingBytesKey } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { inspectProtection, listPdfFonts, verifySignatures } from '../../lazy-ops';
import { EMPTY_OVERLAYS, materializeBase } from '../../operations';
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
 * Keep the document facts in step with the document on screen. The read starts over whenever the
 * bytes change (`workingBytesKey`: a produced version landed, or an undo moved to another one),
 * the handle is swapped, the user imports a trust root or CRL (exactly what changes a verdict) or
 * asks to retry; a read that lands after the next one started is dropped.
 *
 * A mark step (draw, erase, undo of a mark) mints a new `working.id` but no new bytes, so it
 * does not read again: the effect depends on the tab's id and bytes key, never on the `tab`
 * object, and takes the tab from the store when it runs. The facts describe the bytes, so they are
 * read without the pending marks (`EMPTY_OVERLAYS`) — which is also what lets one read stay true
 * across every mark step that follows it.
 */
export function useDocumentFacts({ store, t, tab, handle, revision }: DocumentFactsInput): void {
  const rootBytes = useTrust((state) => state.rootBytes);
  const listBytes = useTrust((state) => state.listBytes);
  const tabId = tab?.id ?? null;
  const bytesKey = tab === null ? null : workingBytesKey(tab);
  useEffect(() => {
    void revision;
    void bytesKey;
    factsReading();
    const current = store.getSnapshot().tabs.find((item) => item.id === tabId);
    if (current === undefined || handle === null) return undefined;
    const key = workingBytesKey(current);
    const controller = new AbortController();
    void (async () => {
      try {
        const bytes = await materializeBase(
          { store, t, tab: current, handle },
          { signal: controller.signal },
          undefined,
          EMPTY_OVERLAYS,
        );
        const [fonts, signatures, attachments, protection] = await Promise.allSettled([
          listPdfFonts(bytes, controller.signal),
          verifySignatures(bytes, controller.signal, { roots: rootBytes, crls: listBytes }),
          measuredAttachments(handle, controller.signal),
          inspectProtection(bytes),
        ]);
        if (controller.signal.aborted) return;
        // A write is judged by the signatures and the protection, so the read fails without
        // them. The fonts and the attachments are only shown: a document whose font table
        // cannot be read can still be saved, and the panel says what is missing.
        if (signatures.status === 'rejected') throw signatures.reason;
        if (protection.status === 'rejected') throw protection.reason;
        factsRead({
          tabId: current.id,
          bytesKey: key,
          fonts: fonts.status === 'fulfilled' ? fonts.value : [],
          signatures: signatures.value,
          attachments: attachments.status === 'fulfilled' ? attachments.value : [],
          // The protection state comes from the engine's own reader, not from a guess: an
          // unencrypted document reports `encrypted: false` and no permissions, which is a
          // fact and not an empty table.
          security: {
            encrypted: protection.value.encrypted,
            // Only the permissions the document actually **grants** are listed: a table of
            // every bit with a yes/no column would bury the one line the user is looking for.
            permissions: Object.entries(protection.value.permissions)
              .filter(([, granted]) => granted)
              .map(([name]) => name),
          },
          unread: [
            ...(fonts.status === 'rejected' ? (['fonts'] as const) : []),
            ...(attachments.status === 'rejected' ? (['attachments'] as const) : []),
          ],
        });
      } catch (error) {
        if (!controller.signal.aborted)
          factsFailed({
            tabId: current.id,
            bytesKey: key,
            error: error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' }),
          });
      }
    })();
    return () => controller.abort();
  }, [store, t, tabId, bytesKey, handle, rootBytes, listBytes, revision]);
}
