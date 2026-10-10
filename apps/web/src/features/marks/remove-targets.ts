/**
 * **The one removal intent**: the Delete key, selection controls and comment
 * panels call this and nothing else, so every family shares one journal step.
 *
 * It takes the two paths the contract names, and which one runs is decided by the
 * request alone:
 *
 *  - **pending marks only** — one `setOverlays` call, so the whole batch (across all
 *    three session families) is a *single* journal entry and a single undo step;
 *  - **anything the file already carries** — the frozen base is materialised from the
 *    marks that survive, the persisted ids are removed by the core writer, and the
 *    result is mounted by `applyProducedBytes` with the remaining redaction intents.
 *    Nothing is applied until all of that has succeeded, and every `await` is
 *    followed by a stale check, so a failure or a document change behind the
 *    gesture leaves the original state exactly as it was.
 */

import type { JsonValue } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import {
  isEmptyRemoval,
  planMarkRemoval,
  removalCount,
  withThreadRecords,
} from '../../annotation-interaction';
import { applyProducedBytes, hasEngineEdits, pruneOverlays, removeMarkTargets } from '../../operations';
import { knownExistingAnnotations, orphanSweepInFlight } from '../annotations/annotations-store';
import { isBusy, setBusy, showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';
import type { MarksHost } from './host';
import { currentMarkTargets } from './marks-store';
import { editableOverlays } from './overlays';

/** Remove the marks named by `keys`; `false` means nothing was removed and nothing is in flight. */
export function removeTargets(host: MarksHost, keys: readonly string[]): boolean {
  const { session, t, cancel } = host;
  const request = planMarkRemoval(
    currentMarkTargets(),
    withThreadRecords(keys, knownExistingAnnotations() ?? []),
  );
  if (isEmptyRemoval(request)) return false;
  const tab = session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null || !host.canEdit.current) return false;
  const count = removalCount(request);

  /**
   * A pending-only removal whose document has engine-side edits is not a pure
   * overlay edit either: deletion adds the step a later undo will come back
   * through, and typed form values are not in a step yet. They are captured
   * first so the deletion's own `before` carries them.
   */
  if (request.existing.length === 0 && !hasEngineEdits(handle)) {
    session.setOverlays(
      tab.id,
      pruneOverlays(editableOverlays(tab), request) as unknown as JsonValue,
      'ann.remove',
    );
    showNotice(t('ann.removed', { count }));
    return true;
  }

  /**
   * The lock is taken inside the async block, not here: when the orphan sweep is
   * running, this gesture waits for it (it is about to replace the working
   * version) instead of being refused because the shell is busy with its own
   * housekeeping.
   */
  const inFlight = orphanSweepInFlight();
  if (inFlight === null && (isBusy() || cancel.current !== null)) {
    host.refuseBusy();
    return false;
  }
  void (async () => {
    const controller = new AbortController();
    try {
      if (inFlight !== null) await inFlight;
      if (isBusy() || cancel.current !== null) {
        host.refuseBusy();
        return;
      }
      cancel.current = controller;
      setBusy(true);
      await host.checkpointEngineValues();
      if (controller.signal.aborted) return;
      // Read the tab after the checkpoint: it journals a step of its own, so the
      // version id and the overlay state have both moved on. What must *not* have
      // moved is the document the request was planned against — the tab and the
      // bytes behind it.
      const fresh = session.getSnapshot().tabs.find((item) => item.id === tab.id) ?? null;
      if (
        fresh === null ||
        session.active?.id !== tab.id ||
        fresh.working.produced?.id !== tab.working.produced?.id
      )
        return;
      if (request.existing.length === 0) {
        session.setOverlays(
          fresh.id,
          pruneOverlays(editableOverlays(fresh), request) as unknown as JsonValue,
          'ann.remove',
        );
        showNotice(t('ann.removed', { count }));
        return;
      }
      const outcome = await removeMarkTargets(
        host.contextFor(fresh, handle),
        request,
        { signal: controller.signal },
        [],
        editableOverlays(fresh),
      );
      if (
        controller.signal.aborted ||
        session.active?.id !== tab.id ||
        session.getSnapshot().tabs.find((item) => item.id === tab.id)?.working.id !== fresh.working.id
      )
        return;
      const next = await applyProducedBytes(
        host.contextFor(fresh, handle),
        outcome.bytes,
        outcome.pageCount,
        { key: 'ann.remove', params: { count } },
        outcome.engine,
        outcome.steps,
        { signal: controller.signal },
        outcome.overlays,
      );
      host.setHandle(fresh.id, next);
      showNotice(t('ann.removed', { count }));
    } catch (error) {
      if (controller.signal.aborted) return;
      const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
      showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
    } finally {
      if (cancel.current === controller) {
        cancel.current = null;
        setBusy(false);
      }
    }
  })();
  return true;
}
