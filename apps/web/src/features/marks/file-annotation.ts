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
import {
  beginOperation,
  endOperation,
  isBusy,
  operationRunning,
  refuseBusy,
  setBusy,
  showNotice,
} from '../core/core-store';
import { canEdit, documentContext } from '../core/document';
import { handleFor, swapHandle } from '../core/handles';
import { selectAfterWrite } from '../selection/selection-store';
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
  const { session, t } = host;
  const tab = session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null) return false;
  if (isBusy() || operationRunning() || !canEdit(session)) {
    refuseBusy(t);
    return false;
  }
  const controller = beginOperation();
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
      const context = documentContext(session, t, fresh, handle);
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
      swapHandle(t, fresh.id, next);
      if (outcome.annotationId !== undefined && selectOnPage !== undefined) {
        selectAfterWrite(markTargetKey('existing', outcome.annotationId, selectOnPage));
      }
      showNotice(done);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
      showNotice(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    } finally {
      if (endOperation(controller)) setBusy(false);
    }
  })();
  return true;
}
