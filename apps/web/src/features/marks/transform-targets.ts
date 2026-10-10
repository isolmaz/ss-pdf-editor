/** Geometry changes share deletion's frozen-version and engine-delta boundary. */

import type { MarkTransform } from 'pdf-core/ops/annotation-transform';
import { transformPdfAnnotations } from 'pdf-core/ops/annotation-transform';
import type { JsonValue } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { planMarkTransform } from '../../annotation-interaction';
import { applyProducedBytes, hasEngineEdits, materializeBase } from '../../operations';
import type { SaveStepDescription } from '../../save-plan';
import { knownExistingAnnotations } from '../annotations/annotations-store';
import { isBusy, setBusy, showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';
import type { MarksHost } from './host';
import { currentMarkTargets } from './marks-store';
import { editableOverlays } from './overlays';

/** Move or rotate the marks named by `keys`; `false` means nothing started. */
export function transformTargets(
  host: MarksHost,
  keys: readonly string[],
  transform: MarkTransform,
): boolean {
  const { session, t, cancel } = host;
  const tab = session.active;
  const handle = tab === null ? null : (handleFor(tab.id) ?? null);
  if (tab === null || handle === null || knownExistingAnnotations() === null) return false;
  if (isBusy() || cancel.current !== null || !host.canEdit.current) return false;
  if (transform.dx === 0 && transform.dy === 0 && transform.rotation === 0) return false;
  const targets = currentMarkTargets();
  const wanted = new Set(keys);
  const count = targets.filter((target) => wanted.has(target.key)).length;
  if (count === 0) return false;
  const current = editableOverlays(tab);
  const plan = planMarkTransform(current, targets, keys, transform);
  if (plan.existing.length === 0 && !hasEngineEdits(handle)) {
    session.setOverlays(
      tab.id,
      {
        ...current,
        annotations: plan.annotations,
        measures: plan.measures,
        redactions: plan.redactions,
      } as unknown as JsonValue,
      'ann.transform',
    );
    showNotice(t('ann.transformed', { count }));
    return true;
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
      const nextPlan = planMarkTransform(before, targets, keys, transform);
      const after = {
        ...before,
        annotations: nextPlan.annotations,
        measures: nextPlan.measures,
        redactions: nextPlan.redactions,
      };
      if (nextPlan.existing.length === 0) {
        session.setOverlays(fresh.id, after as unknown as JsonValue, 'ann.transform');
      } else {
        // Keep pending marks outside the bytes. Otherwise the untouched PDF
        // version and the transformed overlay would both paint the same mark.
        const context = host.contextFor(fresh, handle);
        const executedSteps: SaveStepDescription[] = [];
        const base = await materializeBase(context, { signal: controller.signal }, executedSteps, {
          ...before,
          annotations: [],
          measures: [],
        });
        const outcome = await transformPdfAnnotations(
          base,
          { targets: nextPlan.existing, transform },
          { signal: controller.signal },
        );
        const next = await applyProducedBytes(
          context,
          outcome.bytes,
          outcome.report.pageCount,
          { key: 'ann.transform' },
          outcome.report.engine,
          [...executedSteps.map((step) => step.id), ...outcome.report.steps],
          { signal: controller.signal },
          after,
        );
        host.setHandle(fresh.id, next);
      }
      showNotice(t('ann.transformed', { count }));
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
