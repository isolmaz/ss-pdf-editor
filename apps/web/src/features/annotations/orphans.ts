/**
 * Native editors and orphans.
 *
 * Entering select hands the pointer to the common layer, and a restored native gesture must not
 * be left half-open when it does: pdf.js keeps its editor in `annotationStorage` until something
 * commits it, and an entry left there is invisible to every list — so it is committed and taken
 * over, and any entry this app cannot model is materialised into bytes rather than silently kept.
 */

import { workingPageCount } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { applyProducedBytes, materializeBase } from '../../operations';
import type { SaveStepDescription } from '../../save-plan';
import {
  beginOperation,
  endOperation,
  isBusy,
  operationRunning,
  setBusy,
  showNotice,
} from '../core/core-store';
import { documentContext } from '../core/document';
import { handleFor, swapHandle } from '../core/handles';
import { orphanSweepSettled, orphanSweepStarted } from './annotations-store';
import { takeEngineAnnotations } from './engine-takeover';
import type { AnnotationHost } from './host';

/**
 * Restore engine-held annotation records from drafts into controlled session marks. New
 * gestures already belong to the session and never enter native editors.
 *
 * Returns whether the engine still holds entries this app cannot model (a signature or stamp
 * editor it never armed, or a value restored from a draft): those must be materialised into
 * bytes before a common gesture can reach them, and the caller is the only place that knows
 * whether it can afford the write.
 */
export function settleNativeEditors(host: Pick<AnnotationHost, 'session' | 't' | 'viewer'>): boolean {
  const api = host.viewer.current;
  if (api === null) return false;
  takeEngineAnnotations(host, api);
  return api.captureAnnotationEntries().length > 0;
}

/**
 * Write the engine's unmodellable entries into the bytes and mount the result as the working
 * version.
 *
 * This is the only path that reaches those entries at all: they are invisible to every list and
 * tool, and the engine's own `saveDocument()` would write them on the next save anyway — so
 * materialising them turns "silently kept, silently written" into a version the journal, the
 * comment panel and the common layer can all see. The marks this session holds are written by
 * the same pass and the pending lists are then cleared, exactly as a save clears them.
 */
async function materializeOrphanAnnotations(host: AnnotationHost): Promise<void> {
  const { session, t } = host;
  if (isBusy() || operationRunning()) return;
  const tab = session.getSnapshot().tabs.find((item) => item.id === session.active?.id) ?? null;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return;
  const controller = beginOperation();
  setBusy(true);
  try {
    const executed: SaveStepDescription[] = [];
    const bytes = await materializeBase(
      documentContext(session, t, tab, handle),
      { signal: controller.signal },
      executed,
    );
    if (
      controller.signal.aborted ||
      session.active?.id !== tab.id ||
      session.getSnapshot().tabs.find((item) => item.id === tab.id)?.working.id !== tab.working.id
    )
      return;
    const next = await applyProducedBytes(
      documentContext(session, t, tab, handle),
      bytes,
      workingPageCount(tab),
      { key: 'ann.engineEdit' },
      executed[executed.length - 1]?.engine ?? 'pdfjs',
      executed.map((step) => step.id),
      { signal: controller.signal },
    );
    swapHandle(t, tab.id, next);
  } catch (error) {
    if (controller.signal.aborted) return;
    const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
    showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
  } finally {
    if (endOperation(controller)) {
      setBusy(false);
    }
  }
}

/**
 * Run the orphan sweep and keep its promise as the one in flight until it settles. The sweep
 * replaces the working version, so it holds the operation lock while it runs — but a gesture
 * that lands during it is not one to refuse: erasing a mark a moment after the tool was armed
 * is exactly the expected sequence. The removal path waits for the sweep instead
 * (`orphanSweepInFlight`).
 */
export function sweepOrphanAnnotations(host: AnnotationHost): Promise<void> {
  const settle = (): void => orphanSweepSettled(tracked);
  const tracked: Promise<void> = materializeOrphanAnnotations(host).then(settle, settle);
  orphanSweepStarted(tracked);
  return tracked;
}
