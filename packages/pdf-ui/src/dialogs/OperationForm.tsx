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
 *  - **Two steps, always shown** (`DialogSteps`): settings, then the report and the one
 *    decision the result asks for. The first button previews; only the second changes
 *    the document.
 */

import { Meter } from '@cloudflare/kumo/components/meter';
import type { Translator } from 'pdf-shared';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { DialogSteps } from './DialogSteps';
import { FieldList, fieldErrors, initialParams } from './fields';
import { OperationReportPanel } from './ReportPanel';
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
   * The frozen input: bytes, document facts, the translator and whatever the tool
   * laid on the page. Deliberately the *run* context — without `signal` and
   * `onProgress`, which the run hook creates and owns — so the form forwards the whole
   * object. A hand-written field list here is how `redactions` was dropped once.
   */
  readonly context: OperationRunContext;
  /** Leaves without applying anything; a running job is cancelled first. */
  readonly onClose: () => void;
  /** Performs `spec.resultKind` with the produced files; the host owns the meaning. */
  readonly onResult: (result: OpRunResult) => void;
  /** The host's own title and description elements (the modal's are its accessible name). */
  readonly renderTitle: (text: string) => ReactNode;
  readonly renderIntro: (text: string) => ReactNode;
  /** Told whenever a run starts or stops, so a modal host can refuse to close mid-run. */
  readonly onRunningChange?: (running: boolean) => void;
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
  const [values, setValues] = useState<DialogParams>(() => ({
    ...initialParams(spec.fields),
    ...(spec.initialValues?.(context) ?? {}),
    ...(context.presets ?? {}),
  }));

  /**
   * Options for the `choice` fields, resolved once from the frozen context. A
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

  const running = status === 'running';
  const done = status === 'done' && result !== null;
  const invalid =
    Object.keys(fieldErrors(t, spec.fields, values, context.pageCount, context.selectedPages.length)).length >
    0;

  useEffect(() => {
    onRunningChange?.(running);
  }, [onRunningChange, running]);

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
  }, []);

  const close = useCallback(() => {
    cancel();
    onClose();
  }, [cancel, onClose]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-2">
        {renderTitle(t(spec.titleKey))}
        <DialogSteps t={t} step={done ? 2 : 1} resultKind={spec.resultKind} />
        {spec.introKey === undefined || done ? null : renderIntro(t(spec.introKey))}
      </div>

      {done ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto pe-1">
            <OperationReportPanel t={t} report={result.report} />
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
                  {progress === null ? t('op.running') : t(progress.labelKey)}
                </p>
                {progress !== null && progress.total !== undefined ? (
                  <Meter
                    label={t('progress.label')}
                    value={progress.done ?? 0}
                    max={progress.total}
                    customValue={t('progress.pages', { done: progress.done ?? 0, total: progress.total })}
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
