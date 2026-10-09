/**
 * One write into a file annotation that is not a geometry edit of the selection: a
 * placed picture, a resized one. The same boundary as `transformTargets` — engine
 * values checkpointed, the version checked after every `await`, pending marks kept
 * out of the bytes and handed back as the remaining overlays — so the stamp is one
 * journal step that undo takes back whole.
 */

import { ToolError } from 'pdf-shared';
import { markTargetKey } from 'pdf-ui/tools';
import { applyProducedBytes, materializeBase } from '../../operations';
import type { SaveStepDescription } from '../../save-plan';
import { isBusy, setBusy, showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';
import type { MarksHost, WriteFileAnnotation } from './host';
import { editableOverlays } from './overlays';

/** `false` means the write did not start (no document, or the document is busy or read-only). */
export function writeFileAnnotation(
  host: MarksHost,
  label: Parameters<WriteFileAnnotation>[0],
  write: Parameters<WriteFileAnnotation>[1],
  done: string,
  selectOnPage?: number,
): boolean {
  const { session, t, cancel } = host;
  const tab = session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return false;
  if (isBusy() || cancel.current !== null || !host.canEdit.current) {
    host.refuseBusy();
    return false;
  }
  const controller = new AbortController();
  cancel.current = controller;
  setBusy(true);
  void (async () => {
    try {
      await host.checkpointEngineValues();
      const fresh = session.active;
      if (
        controller.signal.aborted ||
        fresh?.id !== tab.id ||
        fresh.working.produced?.id !== tab.working.produced?.id
      )
        return;
      const before = editableOverlays(fresh);
      const context = host.contextFor(fresh, handle);
      const executedSteps: SaveStepDescription[] = [];
      const base = await materializeBase(context, { signal: controller.signal }, executedSteps, {
        ...before,
        annotations: [],
        measures: [],
      });
      const outcome = await write(base, controller.signal);
      const next = await applyProducedBytes(
        context,
        outcome.bytes,
        outcome.report.pageCount,
        label,
        outcome.report.engine,
        [...executedSteps.map((step) => step.id), ...outcome.report.steps],
        { signal: controller.signal },
        before,
      );
      host.setHandle(fresh.id, next);
      if (outcome.annotationId !== undefined && selectOnPage !== undefined) {
        host.selectAfterWrite.current = markTargetKey('existing', outcome.annotationId, selectOnPage);
      }
      showNotice(done);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
      showNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    } finally {
      if (cancel.current === controller) {
        cancel.current = null;
        setBusy(false);
      }
    }
  })();
  return true;
}
