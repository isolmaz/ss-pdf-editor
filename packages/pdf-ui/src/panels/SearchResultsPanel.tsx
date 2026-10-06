import { type PdfDocumentHandle, type PdfSearchMatch, searchPdfText } from 'pdf-core';
import { type ToolError, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelLoading, PanelMessage } from './PanelParts';

/**
 * Every match of the current query ("Sonuçlar", `PLAN.md §5/Phase 1`), as a flat
 * list of the pages it sits on. The scan runs in `pdf-core` over the text the reader
 * already extracts (no second extractor), page by page, cancellable and yielding to
 * the event loop — a 500-page document fills the list without freezing the dock.
 *
 * Clicking a result owns the destination: the jump happens first, and only then the
 * viewer's find layer is asked to highlight the query, because pdf.js's find
 * controller starts its next match walk from the page the viewer is on. Reversed, the
 * engine's own navigation would carry the user away from the result they clicked.
 */

export interface SearchResultsPanelProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  /** Current page (0-based) — the result it sits on is marked as current. */
  readonly currentPage: number;
  /** 0-based page navigation, shared with the panel's other views. */
  readonly onGoToPage: (pageIndex: number) => void;
  /**
   * The viewer's find layer, when the shell can reach it — `viewerApi.find(query)`
   * highlights every match the viewer has rendered.
   */
  readonly onHighlightQuery?: (query: string) => void;
  /** The shell's notice line (`App.tsx` state) — receives already-translated text. */
  readonly onNotice?: (message: string) => void;
}

/** Typing pause before the scan starts — one scan per settled query, not per key. */
const SEARCH_DEBOUNCE_MS = 250;

/** Queries whose results are kept; a common letter over a long document is big. */
const MEMO_LIMIT = 4;

interface SearchState {
  readonly running: boolean;
  readonly matches: readonly PdfSearchMatch[];
  readonly failure: ToolError | null;
}

const IDLE: SearchState = { running: false, matches: [], failure: null };

export function SearchResultsPanel({
  document,
  t,
  currentPage,
  onGoToPage,
  onHighlightQuery,
  onNotice,
}: SearchResultsPanelProps) {
  const [query, setQuery] = useState('');
  /** The query the results below belong to: the debounced, trimmed input. */
  const [submitted, setSubmitted] = useState('');
  const [state, setState] = useState<SearchState>(IDLE);
  const memo = useRef(new Map<string, readonly PdfSearchMatch[]>());
  const handlers = useRef({ onNotice, t });
  useEffect(() => {
    handlers.current = { onNotice, t };
  });

  const report = useCallback((error: ToolError) => {
    const { onNotice: notify, t: translate } = handlers.current;
    notify?.(translate(error.messageKey));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSubmitted(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (submitted.length === 0) {
      setState(IDLE);
      return undefined;
    }
    const cached = memo.current.get(submitted);
    if (cached !== undefined) {
      setState({ running: false, matches: cached, failure: null });
      return undefined;
    }

    const controller = new AbortController();
    setState((previous) => ({ ...previous, running: true, failure: null }));

    void (async () => {
      try {
        const matches = await searchPdfText(document, submitted, { signal: controller.signal });
        if (controller.signal.aborted) return;
        memo.current.set(submitted, matches);
        if (memo.current.size > MEMO_LIMIT) {
          const oldest = memo.current.keys().next().value;
          if (oldest !== undefined) memo.current.delete(oldest);
        }
        setState({ running: false, matches, failure: null });
      } catch (error) {
        // The abort is this effect's own cleanup, not a failure to report.
        if (controller.signal.aborted) return;
        const failure = toToolError(error, 'ui');
        setState({ running: false, matches: [], failure });
        report(failure);
      }
    })();

    return () => controller.abort();
  }, [submitted, document, report]);

  // The box and the results disagree between a keystroke and the settled query: the
  // header says so instead of claiming a count for text that is no longer there.
  const searching = state.running || query.trim() !== submitted;
  const header =
    submitted.length === 0
      ? ''
      : searching
        ? t('panel.search.running')
        : t('panel.search.count', { count: state.matches.length });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-kumo-line px-2 py-1.5">
        <input
          type="text"
          value={query}
          aria-label={t('viewer.find.label')}
          placeholder={t('viewer.find.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            setSubmitted(event.currentTarget.value.trim());
          }}
          className="h-6 w-full rounded-sm border border-kumo-line bg-kumo-base px-2 text-xs text-kumo-default outline-none focus:ring-1 focus:ring-kumo-focus"
        />
      </div>
      <p className="shrink-0 px-2 py-1 text-[11px] text-kumo-subtle">{header}</p>
      {state.failure !== null ? (
        <PanelMessage text={t(state.failure.messageKey)} />
      ) : query.trim().length === 0 ? (
        <PanelMessage text={t('panel.search.empty')} />
      ) : state.matches.length === 0 ? (
        searching ? (
          <PanelLoading />
        ) : (
          <PanelMessage text={t('panel.search.empty')} />
        )
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label={t('panel.search')}>
          {state.matches.map((match) => {
            const before = match.snippet.slice(0, match.snippetOffset);
            const hit = match.snippet.slice(match.snippetOffset, match.snippetOffset + match.length);
            const after = match.snippet.slice(match.snippetOffset + match.length);
            return (
              <li key={`${match.pageIndex}-${match.index}`}>
                <button
                  type="button"
                  title={t('panel.goToPage', { page: match.pageIndex + 1 })}
                  aria-current={match.pageIndex === currentPage ? 'page' : undefined}
                  onClick={() => {
                    onGoToPage(match.pageIndex);
                    onHighlightQuery?.(submitted);
                  }}
                  className="w-full rounded-sm px-1.5 py-1 text-left text-xs hover:bg-kumo-tint"
                >
                  <span className="mr-1 tabular-nums text-kumo-subtle">{match.pageIndex + 1}</span>
                  <span className="break-words text-kumo-default">
                    {before}
                    <span className="bg-kumo-tint text-kumo-strong">{hit}</span>
                    {after}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
