/**
 * One operation's settings, run and result — the whole of what a capability shows,
 * **whichever surface hosts it**.
 *
 * Both hosts — the modal dialog and the tools panel's inline runner — render this
 * component, so a capability behaves the same way in both (destructive confirmation,
 * cancelled state, diagnostic), down to the button labels.
 *
 * Decisions worth naming:
 *
 *  - **A destructive spec asks twice.** The second step is a
 *    `role="alert"` sentence with the way out focused first: a keyboard user who
 *    confirms by muscle memory must not land on irreversible content loss.
 *  - **The confirm button is disabled while the fields are wrong.** `fieldErrors`
 *    is the same function the field list renders from, so an unparsable page range
 *    cannot be submitted by any route.
 *  - **A clean result is delivered at once.** The document keeps an undo step for what a
 *    run applies, so a report screen in front of that step is a second button and nothing
 *    more. `resultNeedsReview` (`review.ts`) says which results must still be read first —
 *    anything lost, warned about or approximated — and for those the form shows the
 *    report and waits for the one decision it asks for; "close" discards.
 *  - **A delivery the host did not take falls back to the review.** `onResult` resolves when
 *    the host is done; a form that is still mounted then (another operation held the
 *    document, the write failed) shows the report and its button, so the result is not lost.
 */

import { Meter } from '@cloudflare/kumo/components/meter';
import { progressCounts, progressLabel, type Translator } from 'pdf-shared';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { FieldList, fieldErrors, initialParams } from './fields';
import { OperationReportPanel } from './ReportPanel';
import { resultNeedsReview } from './review';
import {
  type DialogParams,
  type FieldValue,
  type OperationDialogSpec,
  type OpRunResult,
  RESULT_ACTIONS,
} from './types';
import { type OperationRunContext, useOperationRun } from './useOperationRun';

export interface OperationFormProps {
  readonly t: Translator;
  readonly spec: OperationDialogSpec;
  /**
   * The run input: bytes, document facts, the translator and whatever the tool
   * laid on the page. Deliberately the *run* context — without `signal` and
   * `onProgress`, which the run hook creates and owns — so the form forwards the whole
   * object. A hand-written field list here is how `redactions` was dropped once.
   */
  readonly context: OperationRunContext;
  /** Leaves without applying anything; a running job is cancelled first. */
  readonly onClose: () => void;
  /**
   * Performs `spec.resultKind` with the produced files; the host owns the meaning. It
   * returns when the delivery is over and must not reject: the form reads the end of the
   * promise, not its outcome, and a host that took the result has closed the form by then.
   */
  readonly onResult: (result: OpRunResult) => void | Promise<void>;
  /** The host's own title and description elements (the modal's are its accessible name). */
  readonly renderTitle: (text: string) => ReactNode;
  readonly renderIntro: (text: string) => ReactNode;
  /** Told whenever a run starts or stops, so a modal host can refuse to close mid-run. */
  readonly onRunningChange?: (running: boolean) => void;
}

/**
 * The values the opener and the context decide for the fields, over the spec's own defaults:
 * what the spec seeds from the context, then the opener's presets.
 */
function contextValues(spec: OperationDialogSpec, context: OperationRunContext): DialogParams {
  const values: Record<string, FieldValue> = {};
  // A scope that defaults to the selection would open on its own error when nothing is
  // selected (the Page menu runs with no selection); the page on screen is the same
  // fallback the page actions use.
  for (const field of spec.fields) {
    if (field.kind === 'pageScope' && field.default === 'selection') {
      values[field.id] = context.selectedPages.length === 0 ? 'current' : 'selection';
    }
  }
  return { ...values, ...(spec.initialValues?.(context) ?? {}), ...(context.presets ?? {}) };
}

export function OperationForm({
  t,
  spec,
  context,
  onClose,
  onResult,
  renderTitle,
  renderIntro,
  onRunningChange,
}: OperationFormProps) {
  const seeded = useMemo(() => contextValues(spec, context), [spec, context]);
  const [values, setValues] = useState<DialogParams>(() => ({ ...initialParams(spec.fields), ...seeded }));
  /** The fields the user has changed: the context no longer decides what they hold. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [seen, setSeen] = useState(seeded);
  // The form stays open while the reader moves on (another page, another selection, another
  // preset): a field the user has not touched follows what it was seeded from.
  if (seeded !== seen) {
    setSeen(seeded);
    const moved = Object.entries(seeded).filter(
      ([id, value]) => !touched.has(id) && !Object.is(seen[id], value),
    );
    if (moved.length > 0) setValues((previous) => ({ ...previous, ...Object.fromEntries(moved) }));
  }

  /**
   * Options for the `choice` fields, resolved from the context. A
   * document-derived list (the images of the open file) is read at open time, never
   * while the form is up: a list that could shift under the user would let them pick a
   * target the run no longer finds.
   */
  const choices = useMemo(() => {
    const resolved: Record<string, readonly { readonly value: string; readonly label: string }[]> = {};
    for (const field of spec.fields) {
      if (field.kind !== 'choice') continue;
      resolved[field.id] = field.options(context);
    }
    return resolved;
  }, [context, spec.fields]);
  const [confirming, setConfirming] = useState(false);
  const { status, progress, result, error, run, cancel } = useOperationRun();
  const footerRef = useRef<HTMLDivElement | null>(null);
  /** The host ended its delivery and this form is still on screen: the result was not taken. */
  const [undelivered, setUndelivered] = useState(false);
  const deliveredRef = useRef<OpRunResult | null>(null);

  const running = status === 'running';
  const done = status === 'done' && result !== null;
  const reviewing = done && (undelivered || resultNeedsReview(result));
  const delivering = done && !reviewing;
  const invalid =
    Object.keys(fieldErrors(t, spec.fields, values, context.pageCount, context.selectedPages.length)).length >
    0;

  useEffect(() => {
    onRunningChange?.(running || delivering);
  }, [onRunningChange, running, delivering]);

  useEffect(() => {
    if (!delivering || deliveredRef.current === result) return;
    deliveredRef.current = result;
    void Promise.resolve(onResult(result))
      .catch(() => undefined)
      .then(() => setUndelivered(true));
  }, [delivering, result, onResult]);

  // The destructive step is the only place the form moves focus on its own: the
  // consequence has just been announced, and the next Enter must not be the one that
  // deletes content. The footer's first button is the way out in both steps.
  useEffect(() => {
    if (!confirming) return;
    footerRef.current?.querySelector('button')?.focus();
  }, [confirming]);

  const start = useCallback(() => {
    setConfirming(false);
    run(spec, values, context);
  }, [context, run, spec, values]);

  const change = useCallback((id: string, value: FieldValue) => {
    setValues((previous) => ({ ...previous, [id]: value }));
    setTouched((previous) => new Set(previous).add(id));
  }, []);

  const close = useCallback(() => {
    cancel();
    onClose();
  }, [cancel, onClose]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-2">
        {renderTitle(t(spec.titleKey))}
        {spec.introKey === undefined || done ? null : renderIntro(t(spec.introKey))}
      </div>

      {delivering ? (
        <p role="status" aria-live="polite" className="text-xs text-kumo-subtle">
          {t('op.running')}
        </p>
      ) : reviewing ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto pe-1">
            <OperationReportPanel t={t} report={result.report} title={t('dialog.review')} />
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line/40 pt-2">
            <Button variant="outline" onClick={close}>
              {t('op.close')}
            </Button>
            <Button variant="primary" onClick={() => onResult(result)}>
              {t(RESULT_ACTIONS[result.deliver ?? spec.resultKind])}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1">
            {running ? null : (
              // The form stays mounted through failure and cancellation: the fields
              // are the retry, so the button that just failed runs again once the
              // values are adjusted.
              <FieldList
                t={t}
                fields={spec.fields}
                values={values}
                onChange={change}
                choices={choices}
                pageCount={context.pageCount}
                currentPage={context.currentPage}
                selectedCount={context.selectedPages.length}
              />
            )}

            {running ? (
              <div className="flex flex-col gap-1.5">
                {/* The live region carries the phase sentence; the meter carries the
                    numbers, so a phase change is announced without the bar itself
                    re-announcing every tick. */}
                <p role="status" aria-live="polite" className="text-xs text-kumo-subtle">
                  {progress === null ? t('op.running') : progressLabel(t, progress)}
                </p>
                {progress !== null && progress.total !== undefined ? (
                  <Meter
                    label={t('progress.label')}
                    value={progress.done ?? 0}
                    max={progress.total}
                    customValue={t('progress.pages', {
                      done: progressCounts(progress).done,
                      total: progress.total,
                    })}
                    // A width animation on every progress tick is exactly the kind of
                    // movement `prefers-reduced-motion` exists to refuse.
                    indicatorClassName="transition-none"
                  />
                ) : null}
              </div>
            ) : null}

            {error === null ? null : (
              <div
                role="alert"
                className="flex flex-col gap-0.5 rounded-sm border border-kumo-line bg-kumo-tint px-2 py-1.5"
              >
                <p className="text-xs text-kumo-danger">{error.message}</p>
                <p className="text-xs text-kumo-subtle">{error.hint}</p>
                {error.diagnostic === null ? null : (
                  <p
                    data-dialog-diagnostic={error.diagnostic}
                    title={error.diagnostic}
                    className="max-w-[60ch] break-words text-[11px] text-kumo-subtle/70"
                  />
                )}
              </div>
            )}

            {status === 'cancelled' ? (
              <p role="status" className="text-xs text-kumo-subtle">
                {t('op.cancelled')}
              </p>
            ) : null}

            {confirming ? (
              <p
                role="alert"
                className="rounded-sm border border-kumo-line bg-kumo-tint px-2 py-1.5 text-xs text-kumo-strong"
              >
                {t('op.result.confirmDestructive')}
              </p>
            ) : null}
          </div>

          <div ref={footerRef} className="flex shrink-0 justify-end gap-2 border-t border-kumo-line/40 pt-2">
            <Button variant="outline" onClick={close}>
              {t('op.cancel')}
            </Button>
            {running ? (
              <Button variant="outline" onClick={cancel}>
                {t('progress.cancel')}
              </Button>
            ) : confirming ? (
              <Button variant="destructive" onClick={start}>
                {t('dialog.confirm.continue')}
              </Button>
            ) : (
              <Button
                // Two steps, two weights of danger: the first click only asks the
                // question, the second one answers it.
                variant={spec.destructive === true ? 'secondary-destructive' : 'primary'}
                disabled={invalid}
                onClick={() => {
                  if (spec.destructive === true) setConfirming(true);
                  else start();
                }}
              >
                {t(spec.confirmKey)}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
