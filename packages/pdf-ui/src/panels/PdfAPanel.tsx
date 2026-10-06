/**
 * The PDF/A surface: does the open document claim PDF/A, and which of the rules this build can
 * test does it break? Plus the way into "Save as PDF/A".
 *
 * The result keeps four things apart, because a report that mixes them misleads:
 *
 *   - **broken** rules, each with its count, the ISO clause and the first few places;
 *   - rules that **could not be checked** on this file (a size budget ended them): unknown,
 *     never shown as passing;
 *   - rules that **pass**, and rules that **do not apply** to the level;
 *   - what this check **never looks at**, printed on every run together with the statement
 *     that this is not a full veraPDF validation.
 *
 * There is no score. The panel asks and the shell owns the bytes: `read` returns the current
 * revision when the button is pressed, and the panel is remounted when the document changes,
 * so the result on screen is always about the file on screen.
 */

import {
  checkPdfA,
  PDFA_CLAUSES,
  type PdfACheckReport,
  type PdfAPart,
  type PdfARuleId,
  type PdfARuleResult,
} from 'pdf-core/ops/pdfa-check';
import type { OperationContext } from 'pdf-core/ops/types';
import type { MessageKey, Translator } from 'pdf-shared';
import { toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';

export interface PdfAPanelProps {
  readonly t: Translator;
  /** The current working bytes, read when the button is pressed. */
  readonly read: (context: OperationContext) => Promise<Uint8Array>;
  /** Open the "Save as PDF/A" dialog. */
  readonly onConvert?: () => void;
  /** The shell's notice line; receives already-translated text. */
  readonly onNotice?: (message: string) => void;
}

type Target = 'auto' | '1' | '2' | '3';

const FIELD_CLASS = 'rounded-sm border border-kumo-line bg-kumo-base px-1.5 py-1 text-xs text-kumo-default';

const ruleKey = (id: PdfARuleId): MessageKey => `pdfa.rule.${id}`;
const violationKey = (id: PdfARuleId): MessageKey => `pdfa.violation.${id}`;

/** `PDF/A-2b`, from the part and conformance letter as the file or the checker states them. */
function levelName(part: string | number | null, conformance: string | null): string {
  return `PDF/A-${part ?? '?'}${(conformance ?? '').toLowerCase()}`;
}

function clauseOf(rule: PdfARuleResult, part: PdfAPart): string {
  return PDFA_CLAUSES[rule.id][part === 1 ? 'one' : 'two'];
}

interface PanelState {
  readonly report: PdfACheckReport | null;
  readonly busy: boolean;
  readonly failure: MessageKey | null;
}

const INITIAL: PanelState = { report: null, busy: false, failure: null };

export function PdfAPanel({ t, read, onConvert, onNotice }: PdfAPanelProps) {
  const [state, setState] = useState<PanelState>(INITIAL);
  const [target, setTarget] = useState<Target>('auto');
  const alive = useRef(true);
  const handlers = useRef({ onNotice, t });
  handlers.current = { onNotice, t };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    const controller = new AbortController();
    const context: OperationContext = { signal: controller.signal };
    setState((current) => ({ ...current, busy: true, failure: null }));
    try {
      const bytes = await read(context);
      const report = await checkPdfA(
        bytes,
        target === 'auto' ? {} : { part: Number(target) as PdfAPart },
        controller.signal,
      );
      if (alive.current) setState({ report, busy: false, failure: null });
    } catch (error) {
      if (!alive.current) return;
      const failure = toToolError(error, 'ui');
      setState((current) => ({ ...current, busy: false, failure: failure.messageKey }));
      handlers.current.onNotice?.(handlers.current.t(failure.messageKey));
    } finally {
      controller.abort();
    }
  }, [read, target]);

  const report = state.report;
  const rows = (wanted: PdfARuleResult['state']) =>
    report?.rules.filter((rule) => rule.state === wanted) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-kumo-line px-2 py-1.5">
        <h3 className="min-w-0 flex-1 text-xs font-semibold text-kumo-default">{t('panel.pdfa')}</h3>
        <Button variant="outline" disabled={state.busy} onClick={() => void check()}>
          {t('pdfa.panel.check')}
        </Button>
        {onConvert === undefined ? null : (
          <Button variant="outline" disabled={state.busy} onClick={onConvert}>
            {t('pdfa.panel.convert')}
          </Button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-kumo-line px-2 py-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-kumo-subtle">
          <span className="shrink-0">{t('pdfa.panel.target')}</span>
          <select
            value={target}
            disabled={state.busy}
            onChange={(event) => setTarget(event.target.value as Target)}
            className={`${FIELD_CLASS} min-w-0 flex-1`}
          >
            <option value="auto">{t('pdfa.panel.target.auto')}</option>
            <option value="1">PDF/A-1b</option>
            <option value="2">PDF/A-2b</option>
            <option value="3">PDF/A-3b</option>
          </select>
        </label>
      </div>

      {state.failure !== null ? <PanelMessage text={t(state.failure)} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {state.busy && report === null ? <PanelLoading /> : null}
        {report === null && !state.busy && state.failure === null ? (
          <PanelMessage text={t('pdfa.panel.empty')} />
        ) : null}

        {report === null ? null : (
          <>
            <p className="px-1.5 pb-0.5 text-xs font-semibold text-kumo-default" aria-live="polite">
              {report.verdict === 'unreadable'
                ? t('pdfa.verdict.unreadable')
                : report.verdict === 'no-claim'
                  ? t('pdfa.verdict.no-claim')
                  : report.verdict === 'claims-and-meets'
                    ? t('pdfa.verdict.claims-and-meets', {
                        level: levelName(report.claim?.part ?? null, report.claim?.conformance ?? null),
                      })
                    : t('pdfa.verdict.claims-with-violations', {
                        level: levelName(report.claim?.part ?? null, report.claim?.conformance ?? null),
                        count: report.violations,
                      })}
            </p>
            {report.verdict === 'no-claim' ? (
              <p className="px-1.5 pb-0.5 text-xs text-kumo-default">
                {t('pdfa.verdict.no-claim.checked', {
                  level: levelName(report.target.part, report.target.conformance),
                  count: report.violations,
                })}
              </p>
            ) : null}
            {report.verdict === 'unreadable' ? null : (
              <p className="px-1.5 pb-1 text-[11px] text-kumo-subtle">
                {t('pdfa.panel.summary', {
                  pages: report.pageCount,
                  checked: report.checked.length,
                  violations: report.violations,
                })}
              </p>
            )}

            {(
              [
                ['fail', 'pdfa.group.fail', 'text-kumo-danger'],
                ['unchecked', 'pdfa.group.unchecked', 'text-kumo-warning'],
                ['pass', 'pdfa.group.pass', 'text-kumo-subtle'],
                ['na', 'pdfa.group.na', 'text-kumo-subtle'],
              ] as const
            ).map(([state, label, tone]) => {
              const group = rows(state);
              if (group.length === 0) return null;
              return (
                <section key={state} className="pb-1">
                  <h4 className={`px-1.5 pb-0.5 text-[11px] font-semibold ${tone}`}>
                    {t(label)} ({group.length})
                  </h4>
                  <ul className="flex flex-col">
                    {group.map((rule) => (
                      <li key={rule.id} className="rounded-sm px-1.5 py-1 text-xs text-kumo-default">
                        <p className="break-words">
                          {state === 'fail' ? (
                            <>
                              <span className="font-semibold tabular-nums">{rule.count}×</span>{' '}
                              {t(violationKey(rule.id))}
                            </>
                          ) : (
                            t(ruleKey(rule.id))
                          )}
                        </p>
                        {state === 'fail' ? (
                          <>
                            <p className="text-[11px] text-kumo-subtle">
                              {t('pdfa.panel.clause', {
                                part: report.target.part === 1 ? 1 : 2,
                                clause: clauseOf(rule, report.target.part),
                              })}
                            </p>
                            <ul className="flex flex-col gap-0.5 pt-0.5">
                              {rule.samples.map((sample, index) => (
                                <li
                                  // The samples are an ordered, never-reordered list.
                                  // biome-ignore lint/suspicious/noArrayIndexKey: stable display order
                                  key={index}
                                  className="flex items-baseline gap-1.5 text-[11px] text-kumo-subtle"
                                >
                                  {sample.pageIndex === undefined ? null : (
                                    <span className="shrink-0 tabular-nums">
                                      {t('pdfa.panel.page', { page: sample.pageIndex + 1 })}
                                    </span>
                                  )}
                                  {sample.detail === undefined ? null : (
                                    <code className="min-w-0 break-words font-mono">{sample.detail}</code>
                                  )}
                                </li>
                              ))}
                              {rule.count > rule.samples.length ? (
                                <li className="text-[11px] text-kumo-subtle">
                                  {t('pdfa.panel.more', { count: rule.count - rule.samples.length })}
                                </li>
                              ) : null}
                            </ul>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            <section className="border-t border-kumo-line pt-1 pb-1">
              <h4 className="px-1.5 pb-0.5 text-[11px] font-semibold text-kumo-subtle">
                {t('pdfa.panel.notChecked')}
              </h4>
              <ul className="flex flex-col">
                {report.notChecked.map((entry) => (
                  <li key={entry} className="px-1.5 py-0.5 text-[11px] text-kumo-subtle">
                    {t(entry as MessageKey)}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        <p className="border-t border-kumo-line px-1.5 py-1.5 text-[11px] text-kumo-subtle">
          {t('pdfa.panel.disclaimer')}
        </p>
      </div>
    </div>
  );
}
