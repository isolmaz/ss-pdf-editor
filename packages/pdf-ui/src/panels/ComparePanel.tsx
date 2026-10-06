/**
 * Document comparison (`PLAN.md §5/Phase 4` — "document comparison, text and
 * rendered pixels"): two documents, one row per page, and the method stated per row.
 *
 * The panel is the second half of `ops/compare.ts`; it holds no engine logic and no
 * comparison algorithm. What it owns:
 *
 *  - **Picking the other document.** An `<input type="file">` behind a button, the
 *    pattern the attachments panel uses; the bytes stay in this component's state and
 *    are handed to the operation, never written anywhere.
 *  - **Two runs, one table.** Text and rendered pixels answer different questions, so
 *    they are two buttons; their results land in the same table, each row carrying the
 *    method it came from. A row is never the average of two methods.
 *  - **The method statement.** Every row says "Metin" or "Görüntü pikseli (40 dpi)";
 *    a comparison whose method is implied is a comparison the user cannot trust.
 *  - **The bounds, out loud.** A page-count difference and a hit comparison bound
 *    (`truncated`) are stated above the table, never folded into a silent row.
 *
 * Routing stays outside: jumping to a page is the shell's callback, the document bytes
 * come from the shell's one route to bytes (`readDocument`), and nothing here writes
 * to the file or the journal — a comparison changes nothing.
 *
 * **Dictionary seam.** The `compare.*` keys below are literals of the integration note
 * (`local://compare-integration.md`) and are not merged into
 * `packages/shared/src/i18n` yet, so `MessageKey` cannot name them; `as MessageKey` is
 * that seam, exactly as `RedactionAuditPanel` documents its own. No user-facing text is
 * written in this file.
 */

import { MagnifyingGlass, X } from '@phosphor-icons/react';
import type { ComparePageStatus, TextComparison, VisualComparison } from 'pdf-core/ops/compare';
import { compareText, compareVisual } from 'pdf-core/ops/compare';
import type { OperationProgress } from 'pdf-core/ops/types';
import { type MessageKey, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { PanelMessage } from './PanelParts';

export interface ComparePanelProps {
  readonly t: Translator;
  /**
   * The left side: the open document's working bytes. The shell passes the same
   * `workingBytes` route every other operation uses, so an annotation drawn a moment
   * ago is part of the comparison.
   */
  readonly readDocument: () => Promise<Uint8Array>;
  /** Jump the viewer to a page (0-based) — the callback the pages panel already takes. */
  readonly onGoToPage?: (pageIndex: number) => void;
  /** The shell's notice line; receives already-translated text. */
  readonly onNotice?: (message: string) => void;
  /** The host is not taking work right now (no document, viewing tier, busy). */
  readonly disabled?: boolean;
}

type CompareMethod = 'text' | 'pixels';
type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

interface Failure {
  readonly message: string;
  readonly hint: string;
  readonly diagnostic: string | null;
}

interface RunState {
  readonly status: RunStatus;
  readonly progress: OperationProgress | null;
  readonly failure: Failure | null;
}

const IDLE: RunState = { status: 'idle', progress: null, failure: null };

/** The statuses the table names, one dictionary key each. */
const STATUS_KEYS: Record<ComparePageStatus, MessageKey> = {
  identical: 'compare.status.identical' as MessageKey,
  changed: 'compare.status.changed' as MessageKey,
  added: 'compare.status.added' as MessageKey,
  removed: 'compare.status.removed' as MessageKey,
  unavailable: 'compare.status.unavailable' as MessageKey,
};

/** Why a comparison was bounded or a page could not be compared, in the user's language. */
const REASON_KEYS: Record<string, MessageKey> = {
  'line-matrix': 'compare.reason.lineMatrix' as MessageKey,
  'word-matrix': 'compare.reason.wordMatrix' as MessageKey,
  'line-list': 'compare.reason.lineList' as MessageKey,
  'raster-cap': 'compare.reason.rasterCap' as MessageKey,
  'page-too-large': 'compare.reason.pageTooLarge' as MessageKey,
  'page-size-mismatch': 'compare.reason.pageSizeMismatch' as MessageKey,
};

/** The status's own tone, so the table is readable without relying on colour alone. */
const STATUS_TONE: Record<ComparePageStatus, string> = {
  identical: 'text-kumo-subtle',
  changed: 'text-kumo-default font-semibold',
  added: 'text-kumo-default',
  removed: 'text-kumo-default',
  unavailable: 'text-kumo-warning',
};

const ROW_CLASS = 'border-t border-kumo-line align-top';
const CELL_CLASS = 'px-1.5 py-1 text-[11px] tabular-nums';

/** One rendered row: a method's answer for one page position. */
interface CompareRow {
  readonly key: string;
  readonly method: CompareMethod;
  readonly pageIndex: number;
  readonly status: ComparePageStatus;
  readonly truncated: boolean;
  /** The movement counts, or the rendered difference — already translated. */
  readonly detail: string;
}

function textRows(result: TextComparison, t: Translator): CompareRow[] {
  return result.pages.map((page) => ({
    key: `text-${String(page.pageIndex)}`,
    method: 'text' as const,
    pageIndex: page.pageIndex,
    status: page.status,
    truncated: page.truncated,
    detail:
      page.status === 'identical'
        ? t('compare.detail.noChanges' as MessageKey)
        : t('compare.detail.lines' as MessageKey, {
            changed: page.changed,
            added: page.added,
            removed: page.removed,
            lines: page.lines.length,
          }),
  }));
}

function pixelRows(result: VisualComparison, t: Translator): CompareRow[] {
  return result.pages.map((page) => {
    // Three different answers, three different details. A page only one document has was
    // never compared, and an unavailable page was not rendered at all — neither may be
    // dressed up as "0.00 % difference".
    const detail =
      page.status === 'added' || page.status === 'removed'
        ? t('compare.detail.pageOnly' as MessageKey)
        : page.status === 'unavailable'
          ? t(REASON_KEYS[page.reason ?? ''] ?? ('compare.reason.unknown' as MessageKey))
          : `${page.differencePercent.toFixed(2)}% · ${String(page.differingTiles)}/${String(page.tileCount)}${
              page.reason === undefined ? '' : ` · ${t(REASON_KEYS[page.reason] as MessageKey)}`
            }`;
    return {
      key: `pixels-${String(page.pageIndex)}`,
      method: 'pixels' as const,
      pageIndex: page.pageIndex,
      status: page.status,
      truncated: page.status === 'unavailable',
      detail,
    };
  });
}

export function ComparePanel({ t, readDocument, onGoToPage, onNotice, disabled }: ComparePanelProps) {
  const [other, setOther] = useState<{ readonly name: string; readonly bytes: Uint8Array } | null>(null);
  const [text, setText] = useState<TextComparison | null>(null);
  const [pixels, setPixels] = useState<VisualComparison | null>(null);
  const [run, setRun] = useState<RunState>(IDLE);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // The shell re-renders this panel on every notice with a fresh translator, so the
  // runner reads both through a ref: a running comparison must not restart because a
  // notice appeared.
  const handlers = useRef({ t, onNotice });
  useEffect(() => {
    handlers.current = { t, onNotice };
  });

  // A comparison left running with no surface able to cancel it is exactly the leak
  // `useOperationRun` exists to prevent in the dialogs.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const start = useCallback(
    (method: CompareMethod, second: { readonly name: string; readonly bytes: Uint8Array }) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setRun({ status: 'running', progress: null, failure: null });

      const context = {
        signal: controller.signal,
        onProgress: (progress: OperationProgress) => {
          if (controller.signal.aborted) return;
          setRun({ status: 'running', progress, failure: null });
        },
      };

      void (async () => {
        try {
          const left = await readDocument();
          if (controller.signal.aborted) return;
          if (method === 'text') {
            const result = await compareText(left, second.bytes, context);
            if (controller.signal.aborted) return;
            setText(result);
          } else {
            const result = await compareVisual(left, second.bytes, context, {
              // The DOM half of the seam: `compare.ts` is DOM-free, so the surface the
              // adapter renders into is created here, in the UI layer.
              createCanvas: () => document.createElement('canvas'),
            });
            if (controller.signal.aborted) return;
            setPixels(result);
          }
          setRun({ status: 'done', progress: null, failure: null });
        } catch (error) {
          if (controllerRef.current !== controller) return;
          if (controller.signal.aborted) {
            setRun({ status: 'cancelled', progress: null, failure: null });
            return;
          }
          const failure = toToolError(error);
          const { t: translate, onNotice: notify } = handlers.current;
          const message = translate(failure.messageKey);
          const detail: Failure = {
            message,
            hint: translate(failure.hintKey),
            diagnostic: failure.details.engineMessage ?? null,
          };
          setRun({ status: 'error', progress: null, failure: detail });
          notify?.(message);
        }
      })();
    },
    [readDocument],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setRun({ status: 'cancelled', progress: null, failure: null });
  }, []);

  const running = run.status === 'running';
  const rows: CompareRow[] = [
    ...(text === null ? [] : textRows(text, t)),
    ...(pixels === null ? [] : pixelRows(pixels, t)),
  ].sort((a, b) =>
    a.pageIndex === b.pageIndex ? a.method.localeCompare(b.method) : a.pageIndex - b.pageIndex,
  );

  // Both methods read the page counts from the same two documents, so whichever ran
  // is the truth about them.
  const counts = text ?? pixels;
  const mismatch = counts?.pageCountDelta ?? 0;
  const leftPageCount = counts?.leftPageCount ?? 0;
  const rightPageCount = counts?.rightPageCount ?? 0;
  const truncationReasons = [
    ...new Set([...(text?.truncationReasons ?? []), ...(pixels?.truncationReasons ?? [])]),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-kumo-line px-2 py-1.5">
        <h3 className="text-xs font-semibold text-kumo-default">{t('compare.title' as MessageKey)}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={pickerRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            data-compare-picker=""
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Picking the same file twice in a row has to fire again.
              event.target.value = '';
              if (file === undefined) return;
              void (async () => {
                const bytes = new Uint8Array(await file.arrayBuffer());
                setOther({ name: file.name, bytes });
                setText(null);
                setPixels(null);
                setRun(IDLE);
              })();
            }}
          />
          <Button
            size="sm"
            variant="outline"
            icon={MagnifyingGlass}
            disabled={disabled === true || running}
            onClick={() => pickerRef.current?.click()}
          >
            {t('compare.pick' as MessageKey)}
          </Button>
          {other === null ? null : (
            <span className="min-w-0 flex-1 truncate text-[11px] text-kumo-subtle" title={other.name}>
              {t('compare.picked' as MessageKey, { name: other.name })}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            disabled={disabled === true || running || other === null}
            onClick={() => other !== null && start('text', other)}
          >
            {t('compare.runText' as MessageKey)}
          </Button>
          <Button
            size="sm"
            disabled={disabled === true || running || other === null}
            onClick={() => other !== null && start('pixels', other)}
          >
            {t('compare.runPixels' as MessageKey)}
          </Button>
          {running ? (
            <Button size="sm" variant="outline" icon={X} onClick={cancel}>
              {t('op.cancel')}
            </Button>
          ) : null}
        </div>
        {/* The live region exists before it has anything to say (`DESIGN.md`). */}
        <p aria-live="polite" className="min-h-[1.1rem] text-[11px] tabular-nums text-kumo-subtle">
          {running && run.progress !== null
            ? t('op.progress', {
                label: t(run.progress.labelKey),
                done: run.progress.done ?? 0,
                total: run.progress.total ?? 0,
              })
            : ''}
        </p>
      </div>

      {run.failure !== null ? (
        <p
          className="shrink-0 border-b border-kumo-line px-2 py-1.5 text-[11px] text-kumo-danger"
          data-compare-failure={run.failure.diagnostic ?? ''}
        >
          {run.failure.message} {run.failure.hint}
        </p>
      ) : null}

      {other === null && rows.length === 0 ? (
        <PanelMessage text={t('compare.empty' as MessageKey)} />
      ) : rows.length === 0 ? (
        <PanelMessage
          text={running ? t('compare.running' as MessageKey) : t('compare.noResult' as MessageKey)}
        />
      ) : (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <p className="px-2 py-1 text-[11px] text-kumo-subtle">
            {t('compare.pageCounts' as MessageKey, {
              left: leftPageCount,
              right: rightPageCount,
            })}
            {mismatch === 0 ? null : (
              <span className="ml-1 text-kumo-warning">
                {t('compare.mismatch' as MessageKey, { delta: mismatch })}
              </span>
            )}
          </p>
          {truncationReasons.length === 0 ? null : (
            <p className="px-2 pb-1 text-[11px] text-kumo-warning">
              {t('compare.truncated' as MessageKey, {
                reasons: truncationReasons
                  .map((reason) => t(REASON_KEYS[reason] ?? ('compare.reason.unknown' as MessageKey)))
                  .join(', '),
              })}
            </p>
          )}
          <table className="w-full border-collapse">
            <caption className="sr-only">{t('compare.table' as MessageKey)}</caption>
            <thead>
              <tr className="text-left text-[11px] text-kumo-subtle">
                <th scope="col" className={CELL_CLASS}>
                  {t('compare.column.page' as MessageKey)}
                </th>
                <th scope="col" className={CELL_CLASS}>
                  {t('compare.column.method' as MessageKey)}
                </th>
                <th scope="col" className={CELL_CLASS}>
                  {t('compare.column.status' as MessageKey)}
                </th>
                <th scope="col" className={CELL_CLASS}>
                  {t('compare.column.detail' as MessageKey)}
                </th>
                <th scope="col" className={CELL_CLASS}>
                  <span className="sr-only">{t('compare.column.jump' as MessageKey)}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className={ROW_CLASS}
                  data-compare-row={`${row.method}:${String(row.pageIndex + 1)}`}
                >
                  <th scope="row" className={`${CELL_CLASS} text-left text-kumo-default`}>
                    {row.pageIndex + 1}
                  </th>
                  <td className={`${CELL_CLASS} text-kumo-subtle`}>
                    {row.method === 'text'
                      ? t('compare.method.text' as MessageKey)
                      : t('compare.method.pixels' as MessageKey, { dpi: pixels?.dpi ?? 0 })}
                  </td>
                  <td className={`${CELL_CLASS} ${STATUS_TONE[row.status]}`}>{t(STATUS_KEYS[row.status])}</td>
                  <td className={`${CELL_CLASS} text-kumo-default`}>
                    {row.detail}
                    {row.truncated ? <span className="text-kumo-warning"> *</span> : null}
                  </td>
                  <td className={CELL_CLASS}>
                    <Button
                      size="sm"
                      variant="outline"
                      // A page only the right document has has nowhere to jump on the left.
                      disabled={onGoToPage === undefined || row.pageIndex >= leftPageCount}
                      onClick={() => onGoToPage?.(row.pageIndex)}
                    >
                      {t('compare.jump' as MessageKey)}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-2 py-1 text-[11px] text-kumo-subtle">{t('compare.truncatedRow' as MessageKey)}</p>
        </div>
      )}
    </div>
  );
}
