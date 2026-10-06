/**
 * The PDF/UA view of the accessibility panel: one row per rule of `ops/pdfua.ts`, each with
 * its verdict, the places that fail, why the rule exists and how to fix it — and the
 * quick fixes that can be applied from here.
 *
 * ## What it refuses to be
 *
 * It is not a score and not a certificate. The summary counts rules by verdict, the
 * disclaimer above them says what a pass does and does not mean, and the manual rules
 * (reading order, alt-text quality, colour contrast, language of passages) are rows of their
 * own so the list can never be read as having looked at them. The "declare PDF/UA" button
 * is enabled only when every automated rule passes, and the operation re-checks before it
 * writes.
 *
 * ## Ownership
 *
 * Like the report view, the panel asks and the shell owns the bytes: `read()` gives the
 * working revision, a produced file goes out through `onWritten`, and the shell journals it.
 * The panel is re-mounted for every revision (`key={working.id}`), so the check re-runs by
 * itself after every fix — what is on screen is always about the file being shown.
 *
 * Every sentence is a dictionary key (`ua.*` and, per rule, `ua.rule.<id>.*`); `key()` is the
 * same `MessageKey` seam the other accessibility views use.
 */

import { ArrowSquareOut, CaretDown, CaretRight } from '@phosphor-icons/react';
import type { PdfUaReport, UaFix, UaInstance, UaRule, UaState } from 'pdf-core/ops/pdfua';
import { checkPdfUa, fixPdfUa, ruleKey } from 'pdf-core/ops/pdfua';
import type { OperationContext, OperationNote } from 'pdf-core/ops/types';
import type { MessageKey, Translator } from 'pdf-shared';
import { toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';

const key = (value: string): MessageKey => value as MessageKey;

export interface WrittenOutcome {
  readonly bytes: Uint8Array;
  readonly notes: readonly OperationNote[];
  readonly steps: readonly string[];
}

export interface PdfUaViewProps {
  readonly t: Translator;
  readonly read: (context: OperationContext) => Promise<Uint8Array>;
  /** The interface language, offered as the default for the document language. Never guessed. */
  readonly language?: string;
  /** The document can be changed (not a read-only session). */
  readonly canEdit: boolean;
  readonly onGoToPage?: (pageIndex: number) => void;
  /** Open a structure element in the tags view. */
  readonly onOpenElement?: (key: string, pageIndex: number | null) => void;
  readonly onWritten?: (outcome: WrittenOutcome) => void;
  readonly onNotice?: (message: string) => void;
}

type Filter = 'all' | 'fail' | 'manual';

/** Verdict → tone and the glyph that carries it besides the colour. */
const STATE: Readonly<Record<UaState, { readonly tone: string; readonly mark: string }>> = {
  pass: { tone: 'text-kumo-subtle', mark: '✓' },
  fail: { tone: 'text-kumo-danger', mark: '✕' },
  manual: { tone: 'text-kumo-warning', mark: '?' },
  na: { tone: 'text-kumo-subtle', mark: '–' },
  unchecked: { tone: 'text-kumo-warning', mark: '!' },
};

/** Rules whose passing row quotes a fact (`{lang}`, `{figures}`), one `…ok` sentence each. */
const OK_DETAIL: ReadonlySet<string> = new Set([
  'lang',
  'struct-tree',
  'figure-alt',
  'link-tagged',
  'link-alt',
  'form-tooltip',
  'font-embedded',
  'font-unicode',
  'table-structure',
  'list-structure',
  'annot-tagged',
  'form-tagged',
  'bookmarks',
]);

const GROUP_ORDER = [
  'document',
  'structure',
  'content',
  'graphics',
  'tables',
  'lists',
  'links',
  'forms',
  'fonts',
  'navigation',
] as const;

export function PdfUaView({
  t,
  read,
  language,
  canEdit,
  onGoToPage,
  onOpenElement,
  onWritten,
  onNotice,
}: PdfUaViewProps) {
  const [report, setReport] = useState<PdfUaReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<MessageKey | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
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
    setBusy(true);
    setFailure(null);
    try {
      const context: OperationContext = { signal: controller.signal };
      const result = await checkPdfUa(await read(context), context);
      if (!alive.current) return;
      setReport(result);
      // Failing rules open by themselves: that is what the user came to read.
      setOpen(new Set(result.rules.filter((rule) => rule.state === 'fail').map((rule) => rule.id)));
    } catch (error) {
      if (!alive.current) return;
      const mapped = toToolError(error, 'ui');
      setFailure(mapped.messageKey);
      handlers.current.onNotice?.(handlers.current.t(mapped.messageKey));
    } finally {
      controller.abort();
      if (alive.current) setBusy(false);
    }
  }, [read]);

  useEffect(() => {
    void check();
  }, [check]);

  const fix = useCallback(
    async (fixes: readonly UaFix[]) => {
      const controller = new AbortController();
      setBusy(true);
      setFailure(null);
      try {
        const context: OperationContext = { signal: controller.signal };
        const outcome = await fixPdfUa(await read(context), fixes, context);
        if (!alive.current) return;
        onWritten?.({ bytes: outcome.bytes, notes: outcome.report.notes, steps: outcome.report.steps });
      } catch (error) {
        if (!alive.current) return;
        const mapped = toToolError(error, 'ui');
        setFailure(mapped.messageKey);
        handlers.current.onNotice?.(handlers.current.t(mapped.messageKey));
      } finally {
        controller.abort();
        if (alive.current) setBusy(false);
      }
    },
    [onWritten, read],
  );

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const draft = (id: string, fallback: string): string => drafts[id] ?? fallback;
  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }));

  const visible = (rule: UaRule): boolean =>
    filter === 'all'
      ? true
      : filter === 'fail'
        ? rule.state === 'fail' || rule.state === 'unchecked'
        : rule.manual;

  const instanceRow = (rule: UaRule, instance: UaInstance, index: number) => {
    const params = {
      page: instance.pageIndex === undefined ? '' : instance.pageIndex + 1,
      // The rule's own values (`{title}` of the Info-only title) first, the instance's over them.
      ...(rule.params ?? {}),
      ...(instance.params ?? {}),
    };
    const inlineId = `${rule.id}:${String(instance.objectNumber ?? instance.fieldName ?? index)}`;
    return (
      <li key={`${inlineId}-${String(index)}`} className="flex flex-col gap-1 py-1">
        <div className="flex items-baseline gap-1.5">
          <span className="min-w-0 flex-1 break-words text-[11px] text-kumo-default">
            {t(
              // A rule that could not be checked says why in one shared sentence per reason,
              // whatever the rule: the reasons are the same for all of them.
              rule.state === 'unchecked' && instance.reason !== undefined
                ? key(`ua.unchecked.${instance.reason}`)
                : ruleKey.detail(rule.id, instance.reason),
              params,
            )}
          </span>
          {instance.pageIndex === undefined ? null : (
            <button
              type="button"
              onClick={() => onGoToPage?.(instance.pageIndex as number)}
              className="shrink-0 rounded-sm border border-kumo-line px-1 text-[10px] text-kumo-default tabular-nums hover:bg-kumo-recessed"
            >
              {t(key('ua.page'), { page: instance.pageIndex + 1 })}
            </button>
          )}
          {instance.nodeKey === undefined ? null : (
            <button
              type="button"
              aria-label={t(key('ua.openElement'))}
              title={t(key('ua.openElement'))}
              onClick={() => onOpenElement?.(instance.nodeKey as string, instance.pageIndex ?? null)}
              className="flex shrink-0 items-center rounded-sm border border-kumo-line p-0.5 text-kumo-default hover:bg-kumo-recessed"
            >
              <ArrowSquareOut size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        {instance.where === undefined ? null : (
          <span className="text-[10px] text-kumo-subtle tabular-nums">{instance.where}</span>
        )}
        {rule.fix === 'link-contents' && instance.objectNumber !== undefined ? (
          <InlineFix
            t={t}
            label={t(key('ua.fix.contents.label'))}
            value={draft(inlineId, '')}
            disabled={busy || !canEdit}
            onChange={(value) => setDraft(inlineId, value)}
            onSave={() =>
              void fix([
                {
                  kind: 'link-contents',
                  objectNumber: instance.objectNumber as number,
                  text: draft(inlineId, ''),
                },
              ])
            }
          />
        ) : null}
        {rule.fix === 'field-tooltip' && instance.fieldName !== undefined ? (
          <InlineFix
            t={t}
            label={t(key('ua.fix.tooltip.label'), { name: instance.fieldName })}
            value={draft(inlineId, '')}
            disabled={busy || !canEdit}
            onChange={(value) => setDraft(inlineId, value)}
            onSave={() =>
              void fix([
                { kind: 'field-tooltip', name: instance.fieldName as string, text: draft(inlineId, '') },
              ])
            }
          />
        ) : null}
      </li>
    );
  };

  const fixControls = (rule: UaRule, current: PdfUaReport) => {
    // Fixes of a single failing instance (a link's description, a field's tooltip) sit on
    // the instance's own row; everything else is offered once, on the rule.
    if (rule.fix === undefined || rule.fix === 'link-contents' || rule.fix === 'field-tooltip') return null;
    if (rule.state === 'pass' || rule.state === 'na') return null;
    const disabled = busy || !canEdit;
    switch (rule.fix) {
      case 'title': {
        const id = 'title';
        return (
          <InlineFix
            t={t}
            label={t(key('ua.fix.title.label'))}
            value={draft(id, current.title ?? '')}
            disabled={disabled}
            onChange={(value) => setDraft(id, value)}
            onSave={() => void fix([{ kind: 'title', title: draft(id, current.title ?? '') }])}
            saveLabel={t(key('ua.fix.title.save'))}
          />
        );
      }
      case 'lang': {
        const id = 'lang';
        const fallback = current.lang ?? language ?? '';
        return (
          <div className="flex flex-col gap-1">
            <InlineFix
              t={t}
              label={t(key('ua.fix.lang.label'))}
              value={draft(id, fallback)}
              disabled={disabled}
              onChange={(value) => setDraft(id, value)}
              onSave={() => void fix([{ kind: 'lang', lang: draft(id, fallback) }])}
              saveLabel={t(key('ua.fix.lang.save'))}
            />
            <p className="text-[10px] text-kumo-subtle">{t(key('ua.fix.lang.hint'))}</p>
          </div>
        );
      }
      case 'display-title':
      case 'tabs':
      case 'marked':
      case 'artifact-paths':
      case 'tag-annots': {
        const kind = rule.fix;
        if ((kind === 'marked' || kind === 'tag-annots') && !current.tagged) return null;
        if (kind === 'artifact-paths' && rule.state !== 'fail') return null;
        return (
          <div className="flex flex-col gap-1">
            <div>
              <Button variant="outline" disabled={disabled} onClick={() => void fix([{ kind }])}>
                {t(key(`ua.fix.${kind}`))}
              </Button>
            </div>
            {kind === 'artifact-paths' || kind === 'tag-annots' ? (
              <p className="text-[10px] text-kumo-subtle">{t(key(`ua.fix.${kind}.hint`))}</p>
            ) : null}
          </div>
        );
      }
      case 'mark-pdfua': {
        const allowed = current.automatedPass && current.declaredPart === null;
        return (
          <div className="flex flex-col gap-1">
            <div>
              <Button
                variant="outline"
                disabled={disabled || !allowed}
                onClick={() => void fix([{ kind: 'mark-pdfua' }])}
              >
                {t(key('ua.fix.mark-pdfua'))}
              </Button>
            </div>
            <p className="text-[10px] text-kumo-subtle">
              {t(key(allowed ? 'ua.fix.mark-pdfua.ready' : 'ua.fix.mark-pdfua.blocked'))}
            </p>
          </div>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-kumo-line px-2 py-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-kumo-subtle">
          <span className="sr-only">{t(key('ua.filter.label'))}</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            aria-label={t(key('ua.filter.label'))}
            className="min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1 py-0.5 text-xs text-kumo-default"
          >
            <option value="all">{t(key('ua.filter.all'))}</option>
            <option value="fail">{t(key('ua.filter.fail'))}</option>
            <option value="manual">{t(key('ua.filter.manual'))}</option>
          </select>
        </label>
        <Button variant="outline" disabled={busy} onClick={() => void check()}>
          {t(key('ua.check'))}
        </Button>
      </div>

      {failure !== null ? <PanelMessage text={t(failure)} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {busy && report === null ? <PanelLoading /> : null}
        {report === null ? null : (
          <>
            <p className="px-1.5 pb-1 text-[11px] text-kumo-default" aria-live="polite" data-ua-summary="">
              {t(key('ua.summary'), { ...report.summary })}
            </p>
            <p className="px-1.5 pb-1 text-[11px] text-kumo-subtle">
              {report.declaredPart === null
                ? t(key('ua.declared.no'))
                : t(key('ua.declared.yes'), { part: report.declaredPart })}
            </p>
            <p className="px-1.5 pb-1.5 text-[10px] text-kumo-subtle">{t(key('ua.disclaimer'))}</p>

            {GROUP_ORDER.map((group) => {
              const rules = report.rules.filter((rule) => rule.group === group && visible(rule));
              if (rules.length === 0) return null;
              return (
                <section key={group} className="pb-1">
                  <h4 className="px-1.5 pb-0.5 text-[11px] font-semibold text-kumo-strong">
                    {t(ruleKey.group(group))}
                  </h4>
                  <ul className="flex flex-col">
                    {rules.map((rule) => {
                      const expanded = open.has(rule.id);
                      const tone = STATE[rule.state];
                      return (
                        <li
                          key={rule.id}
                          data-ua-rule={rule.id}
                          data-ua-state={rule.state}
                          className="border-t border-kumo-line first:border-t-0"
                        >
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => toggle(rule.id)}
                            className="flex w-full items-start gap-1.5 rounded-sm px-1.5 py-1 text-left hover:bg-kumo-recessed"
                          >
                            {expanded ? (
                              <CaretDown size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                            ) : (
                              <CaretRight size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="min-w-0 flex-1 text-xs break-words text-kumo-default">
                              {t(ruleKey.name(rule.id))}
                            </span>
                            <span className={`shrink-0 text-[11px] font-semibold ${tone.tone}`}>
                              <span aria-hidden="true">{tone.mark} </span>
                              {t(key(`ua.state.${rule.state}`))}
                              {rule.count > 0 && rule.state === 'fail' ? ` (${String(rule.count)})` : ''}
                            </span>
                          </button>
                          {expanded ? (
                            <div className="flex flex-col gap-1.5 px-5 pb-2 text-[11px]">
                              <p className="text-kumo-subtle">{t(ruleKey.why(rule.id))}</p>
                              {rule.state === 'pass' && OK_DETAIL.has(rule.id) ? (
                                <p className="text-kumo-default">
                                  {t(key(`ua.rule.${rule.id}.ok`), rule.params ?? {})}
                                </p>
                              ) : null}
                              {rule.instances.length > 0 ? (
                                <ul className="flex flex-col divide-y divide-kumo-line">
                                  {rule.instances.map((instance, index) =>
                                    instanceRow(rule, instance, index),
                                  )}
                                </ul>
                              ) : null}
                              {rule.count > rule.instances.length ? (
                                <p className="text-kumo-subtle">
                                  {t(key('ua.instances.more'), { count: rule.count - rule.instances.length })}
                                </p>
                              ) : null}
                              {rule.state === 'fail' ||
                              rule.state === 'manual' ||
                              rule.state === 'unchecked' ? (
                                <p className="text-kumo-default">
                                  <span className="font-semibold">{t(key('ua.fixHow'))} </span>
                                  {t(ruleKey.fix(rule.id))}
                                </p>
                              ) : null}
                              {fixControls(rule, report)}
                              <p className="text-[10px] text-kumo-subtle">
                                {t(key('ua.reference'), { matterhorn: rule.matterhorn, iso: rule.iso })}
                              </p>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

interface InlineFixProps {
  readonly t: Translator;
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onSave: () => void;
  readonly saveLabel?: string;
}

/** A one-line input with its save button: the shape every text-valued quick fix takes. */
function InlineFix({ t, label, value, disabled, onChange, onSave, saveLabel }: InlineFixProps) {
  return (
    <label className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      <input
        value={value}
        placeholder={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1.5 py-1 text-xs text-kumo-default"
      />
      <Button variant="outline" disabled={disabled || value.trim() === ''} onClick={onSave}>
        {saveLabel ?? t(key('ua.fix.save'))}
      </Button>
    </label>
  );
}
