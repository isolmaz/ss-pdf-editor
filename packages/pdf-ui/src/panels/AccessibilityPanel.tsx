/**
 * The accessibility surface (`PLAN.md §5/Phase 4`): a check the user runs, the report it
 * produces, the tag write, and the alt-text list for the images the check found.
 *
 * ## Three different things, three different places
 *
 * The panel exists because "found a problem", "could not check" and "we did not look" are
 * not the same statement, and a report that mixes them is worse than no report:
 *
 *   - **found a problem** — a red group, each row naming the page or the object;
 *   - **could not check** — an amber group: a page whose content stream would not decode,
 *     a structure tree that is not a dictionary, a check that stopped at its own bound.
 *     Rendered as *unknown*, never as clean;
 *   - **we did not look** — its own list at the bottom, from `report.notChecked`, printed
 *     verbatim. Reading order, tables, lists, artifacts, font embedding and conformance
 *     are all untouched by this check, and the panel says so on every run;
 *   - **checked, nothing found** — the quiet group. A check that ran and found nothing
 *     says that, in the same shape as one that found something.
 *
 * There is no score and no percentage anywhere, by construction: `checkAccessibility`
 * does not produce one, and this panel has no place to put one.
 *
 * ## Ownership
 *
 * The panel asks; the shell owns the bytes (`K23`). Reading the working bytes, applying a
 * produced file, journaling it and routing the save all belong to the host — this file
 * calls `read()` for the current revision and hands produced outcomes to `onTagged` /
 * `onAltWritten`. After a write the report on screen describes a file that no longer
 * exists, so the panel marks itself stale instead of pretending otherwise.
 *
 * ## Copy
 *
 * Every sentence is a dictionary key. The keys live in
 * `packages/shared/src/i18n/parts/a11y.ts` and are added by the commit that wires this
 * panel in (`local://a11y-integration.md` lists them with both languages); until then
 * `MessageKey` cannot name the literals, which is what the `key()` seam below is — the
 * same seam `RedactionAuditPanel` documents, not a second dictionary.
 */

import type {
  AccessibilityFinding,
  AccessibilityImage,
  AccessibilityReport,
} from 'pdf-core/ops/accessibility';
import { checkAccessibility, setImageAlt, tagDocument } from 'pdf-core/ops/accessibility';
import type { OperationContext, OperationNote } from 'pdf-core/ops/types';
import type { MessageKey, Translator } from 'pdf-shared';
import { toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelLoading, PanelMessage } from './PanelParts';

/** See the header: the seam that stands in for `parts/a11y.ts` until it is merged. */
const key = (value: string): MessageKey => value as MessageKey;

export interface AccessibilityPanelProps {
  readonly t: Translator;
  /**
   * The current working bytes, from the host's own route (`workingBytes`,
   * `apps/web/src/operations.ts`). A function, never a captured copy: the check must read
   * the revision on screen when the button is pressed (`K14`).
   */
  readonly read: (context: OperationContext) => Promise<Uint8Array>;
  /**
   * BCP-47 language for `/Lang` when the document has none. The document's own language
   * cannot be guessed, so the caller states it (the shell passes the interface locale) and
   * the report names the language it wrote.
   */
  readonly language?: string;
  /** Hand produced bytes to the host, which journals them and routes the save. */
  readonly onTagged?: (outcome: {
    readonly bytes: Uint8Array;
    readonly notes: readonly OperationNote[];
  }) => void;
  readonly onAltWritten?: (outcome: {
    readonly bytes: Uint8Array;
    readonly notes: readonly OperationNote[];
  }) => void;
  /** The shell's notice line; receives already-translated text. */
  readonly onNotice?: (message: string) => void;
}

interface PanelState {
  readonly report: AccessibilityReport | null;
  readonly busy: boolean;
  /** True once a write has happened, so the report on screen is about the old revision. */
  readonly stale: boolean;
  readonly failure: MessageKey | null;
  readonly notes: readonly OperationNote[];
}

const INITIAL: PanelState = { report: null, busy: false, stale: false, failure: null, notes: [] };

/** Tone per finding state, with a heading word for each: colour never carries it alone. */
const GROUP: readonly {
  readonly state: AccessibilityFinding['state'];
  readonly label: MessageKey;
  readonly tone: string;
}[] = [
  { state: 'problem', label: key('panel.a11y.group.problem'), tone: 'text-kumo-danger' },
  { state: 'unchecked', label: key('panel.a11y.group.unchecked'), tone: 'text-kumo-warning' },
  { state: 'ok', label: key('panel.a11y.group.ok'), tone: 'text-kumo-subtle' },
];

export function AccessibilityPanel({
  t,
  read,
  language,
  onTagged,
  onAltWritten,
  onNotice,
}: AccessibilityPanelProps) {
  const [state, setState] = useState<PanelState>(INITIAL);
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

  const run = useCallback(
    async (
      work: (
        context: OperationContext,
      ) => Promise<
        { readonly bytes: Uint8Array; readonly notes: readonly OperationNote[] } | AccessibilityReport
      >,
      kind: 'check' | 'tag' | 'alt',
    ) => {
      const controller = new AbortController();
      const context: OperationContext = { signal: controller.signal };
      setState((current) => ({ ...current, busy: true, failure: null }));
      try {
        const result = await work(context);
        if (!alive.current) return;
        if ('findings' in result) {
          setState({ report: result, busy: false, stale: false, failure: null, notes: [] });
          return;
        }
        if (kind === 'tag') onTagged?.(result);
        else onAltWritten?.(result);
        setState((current) => ({ ...current, busy: false, stale: true, notes: result.notes }));
      } catch (error) {
        if (!alive.current) return;
        const failure = toToolError(error, 'ui');
        setState((current) => ({ ...current, busy: false, failure: failure.messageKey }));
        handlers.current.onNotice?.(handlers.current.t(failure.messageKey));
      } finally {
        controller.abort();
      }
    },
    [onAltWritten, onTagged],
  );

  const check = useCallback(
    () => run(async (context) => checkAccessibility(await read(context), context), 'check'),
    [read, run],
  );

  const tag = useCallback(
    () =>
      run(async (context) => {
        const outcome = await tagDocument(await read(context), context, {
          ...(language === undefined ? {} : { language }),
        });
        return { bytes: outcome.bytes, notes: outcome.report.notes };
      }, 'tag'),
    [language, read, run],
  );

  const writeAlt = useCallback(
    (target: AccessibilityImage, alt: string) =>
      run(async (context) => {
        const outcome = await setImageAlt(
          await read(context),
          [{ kind: 'image', pageIndex: target.pageIndex, name: target.name, alt }],
          context,
        );
        return { bytes: outcome.bytes, notes: outcome.report.notes };
      }, 'alt'),
    [read, run],
  );

  const report = state.report;
  const writing = onTagged !== undefined || onAltWritten !== undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-kumo-line px-2 py-1.5">
        <h3 className="min-w-0 flex-1 text-xs font-semibold text-kumo-default">{t(key('panel.a11y'))}</h3>
        <Button variant="outline" disabled={state.busy} onClick={() => void check()}>
          {t(key('panel.a11y.check'))}
        </Button>
      </div>

      {state.failure !== null ? <PanelMessage text={t(state.failure)} /> : null}
      {state.stale ? <PanelMessage text={t(key('panel.a11y.stale'))} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {state.busy && report === null ? <PanelLoading /> : null}
        {report === null && !state.busy && state.failure === null ? (
          <PanelMessage text={t(key('panel.a11y.empty'))} />
        ) : null}

        {report === null ? null : (
          <>
            <p className="px-1.5 pb-1 text-[11px] text-kumo-subtle" aria-live="polite">
              {t(key('panel.a11y.summary'), {
                pages: report.pageCount,
                problems: report.findings.filter((row) => row.state === 'problem').length,
                unknown: report.findings.filter((row) => row.state === 'unchecked').length,
              })}
            </p>

            {GROUP.map((group) => {
              const rows = report.findings.filter((row) => row.state === group.state);
              if (rows.length === 0) return null;
              return (
                <section key={group.state} className="pb-1">
                  <h4 className={`px-1.5 pb-0.5 text-[11px] font-semibold ${group.tone}`}>
                    {t(group.label)}
                  </h4>
                  <ul className="flex flex-col">
                    {rows.map((row, index) => (
                      <li
                        key={`${row.id}-${String(index)}`}
                        className="flex items-baseline gap-1.5 rounded-sm px-1.5 py-1 text-xs text-kumo-default"
                      >
                        <span className="min-w-0 flex-1 break-words">{t(row.key, row.params)}</span>
                        {row.pageIndex === undefined ? null : (
                          <span className="shrink-0 text-[11px] tabular-nums text-kumo-subtle">
                            {t(key('panel.a11y.page'), { page: row.pageIndex + 1 })}
                          </span>
                        )}
                        {row.where === undefined ? null : (
                          <span className="shrink-0 text-[11px] tabular-nums text-kumo-subtle">
                            {row.where}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            <section className="border-t border-kumo-line pt-1 pb-1">
              <h4 className="px-1.5 pb-0.5 text-[11px] font-semibold text-kumo-subtle">
                {t(key('panel.a11y.notChecked'))}
              </h4>
              <ul className="flex flex-col">
                {report.notChecked.map((entry) => (
                  <li key={entry} className="px-1.5 py-0.5 text-[11px] text-kumo-subtle">
                    {t(entry)}
                  </li>
                ))}
              </ul>
            </section>

            {state.notes.length > 0 ? (
              <section className="border-t border-kumo-line pt-1 pb-1">
                <h4 className="px-1.5 pb-0.5 text-[11px] font-semibold text-kumo-subtle">
                  {t(key('panel.a11y.notes'))}
                </h4>
                <ul className="flex flex-col">
                  {state.notes.map((entry, index) => (
                    <li
                      key={`${entry.key}-${String(index)}`}
                      className="px-1.5 py-0.5 text-[11px] text-kumo-default"
                    >
                      {t(entry.key, entry.params)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="border-t border-kumo-line pt-1.5 pb-1">
              <div className="flex items-center gap-1 px-1.5 pb-1">
                <h4 className="min-w-0 flex-1 text-[11px] font-semibold text-kumo-default">
                  {t(key('panel.a11y.alt'))}
                </h4>
                <Button variant="outline" disabled={!writing || state.busy} onClick={() => void tag()}>
                  {t(key('panel.a11y.tag'))}
                </Button>
              </div>
              {language === undefined ? (
                <p className="px-1.5 pb-1 text-[11px] text-kumo-subtle">{t(key('panel.a11y.noLanguage'))}</p>
              ) : null}
              {report.images.length === 0 ? (
                <p className="px-1.5 text-[11px] text-kumo-subtle">{t(key('panel.a11y.alt.empty'))}</p>
              ) : (
                <ul className="flex flex-col">
                  {report.images.map((image) => (
                    <li key={image.ref} className="flex flex-col gap-1 rounded-sm px-1.5 py-1">
                      <span className="text-[11px] text-kumo-subtle">
                        {t(key('panel.a11y.alt.target'), {
                          name: image.name,
                          pages: image.pages.map((page) => page + 1).join(', '),
                        })}
                        {image.alt === null ? ` · ${t(key('panel.a11y.alt.missing'))}` : ''}
                      </span>
                      <label className="flex items-center gap-1">
                        <span className="sr-only">
                          {t(key('panel.a11y.alt.label'), { name: image.name })}
                        </span>
                        <input
                          // Autocomplete of the current value, so an existing alt text can be
                          // corrected rather than retyped.
                          defaultValue={drafts[image.ref] ?? image.alt ?? ''}
                          disabled={state.busy || onAltWritten === undefined}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDrafts((current) => ({ ...current, [image.ref]: value }));
                          }}
                          className="min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1.5 py-1 text-xs text-kumo-default"
                        />
                        <Button
                          variant="outline"
                          disabled={state.busy || onAltWritten === undefined}
                          onClick={() => {
                            const value = (drafts[image.ref] ?? image.alt ?? '').trim();
                            if (value === '') return;
                            void writeAlt(image, value);
                          }}
                        >
                          {t(key('panel.a11y.alt.save'))}
                        </Button>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
