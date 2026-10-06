/**
 * Page list of the left dock.
 *
 * Page management: the thumbnails are selectable (click, `Ctrl`/`Cmd`
 * toggle, `Shift` range, `Ctrl+A` while the list owns focus, `Escape`), movable
 * (drag, arrow keys, or an explicit "move to" field) and rotatable/deletable/
 * duplicatable/extractable as a set. Every one of those leaves the panel as a
 * `PageMoveAction` — the panel never touches the document or the engine, and selection is the shell's state
 * (`selectedPages` is a controlled prop), so the list and the commands that act
 * on it cannot disagree about what is selected.
 *
 * Four behaviours are deliberate, each closing a defect the source project had:
 *
 * 1. **Laziness** — a 2000-page document must not start 2000 render tasks when
 *    the dock opens; each item observes itself and only then asks the engine for
 *    its page.
 * 2. **A fresh canvas per attempt, and an observer that stays attached** — a
 *    superseded render task writing into a reused node showed pages upside down,
 *    and disconnecting the observer after its first hit left aborted thumbnails
 *    black forever.
 * 3. **No hover-only affordance** — the source project's per-card toolbar was
 *    `group-hover:flex`, so it was unreachable on touch, and drag reordering had
 *    no keyboard equivalent. Here the selection toolbar is
 *    always in flow when something is selected, and every reorder has two
 *    non-drag equivalents: `Alt`/`Ctrl` + arrows, and the "move to page" field.
 * 4. **One announcement** — the live region reports the selection only; the
 *    action's own sentence is announced by the app when the action lands
 *   , so a click that both selects and moves cannot be
 *    announced twice.
 */

import {
  ArrowBendDownRight,
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowUp,
  Copy,
  Export,
  Trash,
} from '@phosphor-icons/react';
import type { PdfDocumentHandle } from 'pdf-core';
import type { Translator } from 'pdf-shared';
import {
  Fragment,
  type DragEvent as ReactDragEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';

/**
 * What the page list asks the app to do with the selection.
 *
 * Declared here, in the component that knows the page order, because the
 * dependency only ever runs one way: `pdf-ui` is a library the app consumes, so
 * the app widens this union with the members only it can perform (`insert`
 * carries replacement bytes) rather than the panel reaching into `apps/web`.
 *
 * `toIndex` is a 0-based **insertion position into the page order that remains
 * after the selected pages are removed** — the index the moved block lands at,
 * not the index it left. The app clamps it to the remaining page count.
 */
export type PageMoveAction =
  | {
      readonly kind: 'rotate';
      readonly direction: 'left' | 'right';
      /** The pages to act on, when the control names them (a thumbnail's own button); else the selection. */
      readonly pages?: readonly number[];
    }
  | { readonly kind: 'delete'; readonly pages?: readonly number[] }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'move'; readonly toIndex: number };

export interface PagesPanelProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  /** Current page (0-based) — the list follows it. */
  readonly currentPage: number;
  readonly selectedPages: readonly number[];
  readonly onSelectionChange: (pages: readonly number[]) => void;
  readonly onGoToPage: (pageIndex: number) => void;
  readonly onPageAction: (action: PageMoveAction) => void;
  /** False in viewing mode: selection stays available, every action is disabled. */
  readonly editing: boolean;
  /**
   * Opens the extract-pages dialog. Optional: a shell without a dialog host
   * leaves the button disabled instead of shipping a control that does nothing.
   */
  readonly onExtract?: () => void;
  readonly version?: string;
}

/** Thumbnail width; the page's own aspect ratio supplies the height. */
const THUMBNAIL_WIDTH = 104;

/**
 * The drop indicator is a real element between two rows, in flow and always
 * present, so highlighting a gap cannot move the rows under the pointer while a
 * drag is in flight.
 */
const GAP_CLASS = 'my-1 h-0.5 rounded-full';

const INPUT_CLASS =
  'h-6 w-14 rounded-sm border border-kumo-line bg-kumo-base px-1 text-xs text-kumo-default tabular-nums outline-none focus:ring-1 focus:ring-kumo-focus disabled:opacity-50';

export function PagesPanel({
  document,
  t,
  currentPage,
  selectedPages,
  onSelectionChange,
  onGoToPage,
  onPageAction,
  editing,
  onExtract,
  version,
}: PagesPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const moveToId = useId();
  /** The roving tab stop: exactly one option carries `tabIndex={0}`. */
  const [focusPage, setFocusPage] = useState(currentPage);
  /** Anchor of a `Shift` range — the last page clicked or toggled. */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [dragPages, setDragPages] = useState<readonly number[] | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const [moveTo, setMoveTo] = useState('');

  const pageCount = document.pageCount;
  const pages = useMemo(() => Array.from({ length: pageCount }, (_unused, page) => page), [pageCount]);
  // Sorted, and deduplicated by the set below: every calculation here (ranges,
  // move targets) is order-dependent.
  const selection = useMemo(() => [...selectedPages].sort((a, b) => a - b), [selectedPages]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const firstSelected = selection[0] ?? 0;
  /** How many positions exist once the selection is taken out of the document. */
  const remaining = pageCount - selection.length;

  // The roving tab stop follows the viewer, so tabbing into the dock lands on the
  // page the reader is looking at.
  useEffect(() => {
    setFocusPage(currentPage);
  }, [currentPage]);

  // A page that no longer exists (a delete landed) must not stay selected: the
  // indices are the shell's, and it cannot know the page count changed.
  useEffect(() => {
    if (selection.some((page) => page >= pageCount)) {
      onSelectionChange(selection.filter((page) => page < pageCount));
    }
  }, [pageCount, selection, onSelectionChange]);

  const applySelection = useCallback(
    (next: readonly number[]) => {
      onSelectionChange([...new Set(next)].sort((a, b) => a - b));
    },
    [onSelectionChange],
  );

  const focusItem = useCallback((page: number) => {
    listRef.current?.querySelector<HTMLElement>(`[data-page-option="${page}"]`)?.focus();
  }, []);

  /**
   * Move `moving` to `toIndex` and keep the highlight on those pages. The shell's
   * selection is index-based, so an action without the new indices would leave the
   * outline on whichever pages slid into the old positions.
   */
  const moveSelection = useCallback(
    (toIndex: number, moving: readonly number[]) => {
      onPageAction({ kind: 'move', toIndex });
      onSelectionChange(Array.from({ length: moving.length }, (_unused, offset) => toIndex + offset));
    },
    [onPageAction, onSelectionChange],
  );

  /** One position up or down; the block swaps with exactly one neighbour. */
  const moveBy = useCallback(
    (direction: -1 | 1) => {
      if (selection.length === 0) return;
      const toIndex = firstSelected + direction;
      if (toIndex < 0 || toIndex > remaining) return;
      moveSelection(toIndex, selection);
    },
    [firstSelected, moveSelection, remaining, selection],
  );

  /** Clicking the list's own space — never a thumbnail — clears the selection. */
  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (target !== null && target.closest('[data-page-option]') !== null) return;
    setAnchor(null);
    applySelection([]);
  };

  const selectPage = (page: number, event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.shiftKey && anchor !== null) {
      const from = Math.min(anchor, page);
      const to = Math.max(anchor, page);
      applySelection(Array.from({ length: to - from + 1 }, (_unused, offset) => from + offset));
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      setAnchor(page);
      applySelection(selected.has(page) ? selection.filter((item) => item !== page) : [...selection, page]);
      return;
    }
    setAnchor(page);
    setFocusPage(page);
    applySelection([page]);
    onGoToPage(page);
  };

  /**
   * Keys arrive from the focused option — the only tab stop the list has — and the
   * listbox carries the same handler because `Escape`, `Ctrl+A` and the page moves
   * belong to the list as a whole. `preventDefault` is how the option says "handled",
   * so the listbox can leave a bubbled key alone instead of applying it twice
   * (`Alt`+`ArrowUp` twice would move a page by two).
   */
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { key, altKey, ctrlKey, metaKey } = event;

    if (key === 'Escape') {
      event.preventDefault();
      setAnchor(null);
      applySelection([]);
      return;
    }

    // Scoped to the panel on purpose: the handler is on the listbox, so this only
    // fires while the page list owns focus and the shell's own Ctrl+A stays intact.
    if ((ctrlKey || metaKey) && (key === 'a' || key === 'A')) {
      event.preventDefault();
      applySelection(pages);
      return;
    }

    if ((altKey || ctrlKey || metaKey) && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      moveBy(key === 'ArrowUp' ? -1 : 1);
      return;
    }

    switch (key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        event.preventDefault();
        const next = Math.min(pageCount - 1, Math.max(0, focusPage + (key === 'ArrowDown' ? 1 : -1)));
        setFocusPage(next);
        focusItem(next);
        return;
      }
      case 'Home':
      case 'End': {
        event.preventDefault();
        const next = key === 'Home' ? 0 : pageCount - 1;
        setFocusPage(next);
        focusItem(next);
        return;
      }
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        setAnchor(focusPage);
        applySelection(
          selected.has(focusPage)
            ? selection.filter((page) => page !== focusPage)
            : [...selection, focusPage],
        );
        return;
      }
      case 'Enter': {
        event.preventDefault();
        onGoToPage(focusPage);
        return;
      }
      default:
        return;
    }
  };

  const startDrag = (page: number, event: ReactDragEvent<HTMLDivElement>) => {
    if (!editing) {
      event.preventDefault();
      return;
    }
    // Dragging an unselected page drags that page: the drag is a selection gesture
    // first, which is what a user pointing at one thumbnail expects.
    const dragging = selected.has(page) ? selection : [page];
    if (!selected.has(page)) {
      setAnchor(page);
      applySelection([page]);
    }
    setDragPages(dragging);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload; the text is also what a
    // drop into another application should read.
    event.dataTransfer.setData('text/plain', dragging.map((index) => index + 1).join(', '));
  };

  /** Which gap the pointer is over: the half of the row decides before/after. */
  const dragOverPage = (page: number, event: ReactDragEvent<HTMLDivElement>) => {
    if (dragPages === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDropGap(event.clientY > rect.top + rect.height / 2 ? page + 1 : page);
  };

  const dropOnGap = (gap: number) => {
    const dragging = dragPages;
    setDragPages(null);
    setDropGap(null);
    if (dragging === null || dragging.length === 0) return;
    // The gap counts pages in the current order; the action counts positions in the
    // order that remains, so the dragged pages before the gap are subtracted.
    const before = dragging.filter((page) => page < gap).length;
    moveSelection(Math.max(0, Math.min(gap - before, remaining)), dragging);
  };

  const submitMoveTo = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = Number.parseInt(moveTo, 10);
    if (!Number.isFinite(value) || selection.length === 0) return;
    setMoveTo('');
    moveSelection(Math.max(0, Math.min(value - 1, remaining)), selection);
  };

  const gapClass = (active: boolean) => `${GAP_CLASS} ${active ? 'bg-pdf-accent' : 'bg-transparent'}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        Selection changes only: an action's own sentence is announced by the app
        when it lands, and two regions reporting one click is two interruptions.
      */}
      <p aria-live="polite" className="sr-only">
        {t('pages.selected', { count: selection.length })}
      </p>

      {selection.length > 0 ? (
        <div
          role="toolbar"
          aria-label={t('panel.pages.selection', { count: selection.length })}
          className="flex shrink-0 flex-col gap-1 border-b border-kumo-line bg-kumo-tint px-1.5 py-1"
        >
          <div className="flex flex-wrap items-center gap-1">
            <Button
              shape="square"
              variant="secondary"
              icon={ArrowCounterClockwise}
              disabled={!editing}
              aria-label={t('pages.rotate.left')}
              title={t('pages.rotate.left')}
              onClick={() => onPageAction({ kind: 'rotate', direction: 'left' })}
            />
            <Button
              shape="square"
              variant="secondary"
              icon={ArrowClockwise}
              disabled={!editing}
              aria-label={t('pages.rotate.right')}
              title={t('pages.rotate.right')}
              onClick={() => onPageAction({ kind: 'rotate', direction: 'right' })}
            />
            <Button
              shape="square"
              variant="secondary"
              icon={Copy}
              disabled={!editing}
              aria-label={t('pages.duplicate')}
              title={t('pages.duplicate')}
              onClick={() => onPageAction({ kind: 'duplicate' })}
            />
            <Button
              shape="square"
              variant="secondary-destructive"
              icon={Trash}
              // Deleting the last remaining pages is refused by the app
              // (`pages.delete.lastPage`), so the button never offers it.
              disabled={!editing || selection.length >= pageCount}
              aria-label={t('pages.delete')}
              title={t('pages.delete')}
              onClick={() => onPageAction({ kind: 'delete' })}
            />
            <Button
              shape="square"
              variant="secondary"
              icon={Export}
              disabled={!editing || onExtract === undefined}
              aria-label={t('pages.extract.title')}
              title={t('pages.extract.title')}
              onClick={() => onExtract?.()}
            />
            <Button
              shape="square"
              variant="secondary"
              icon={ArrowUp}
              disabled={!editing || firstSelected === 0}
              aria-label={t('pages.moveUp')}
              title={t('pages.moveUp')}
              onClick={() => moveBy(-1)}
            />
            <Button
              shape="square"
              variant="secondary"
              icon={ArrowDown}
              disabled={!editing || firstSelected + 1 > remaining}
              aria-label={t('pages.moveDown')}
              title={t('pages.moveDown')}
              onClick={() => moveBy(1)}
            />
          </div>
          {/*
            The touch and keyboard path to a reorder: drag is the pointer shortcut,
            this field is the one that works with a finger, a stylus or a keyboard
            alone.
          */}
          <form className="flex items-center gap-1" onSubmit={submitMoveTo}>
            <label className="text-xs text-kumo-subtle" htmlFor={moveToId}>
              {t('pages.moveTo')}
            </label>
            <input
              id={moveToId}
              type="number"
              min={1}
              max={Math.max(1, remaining + 1)}
              className={INPUT_CLASS}
              value={moveTo}
              disabled={!editing}
              onChange={(event) => setMoveTo(event.target.value)}
            />
            <Button
              type="submit"
              shape="square"
              variant="secondary"
              icon={ArrowBendDownRight}
              disabled={!editing || moveTo.trim() === ''}
              aria-label={t('pages.moveTo')}
              title={t('pages.moveTo')}
            />
          </form>
        </div>
      ) : null}

      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t('panel.pages')}
        className="min-h-0 flex-1 overflow-y-auto p-2"
        onClick={onBackdropClick}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return;
          onListKeyDown(event);
        }}
        onDragOver={(event) => {
          if (dragPages === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropGap(null);
        }}
        onDragEnd={() => {
          setDragPages(null);
          setDropGap(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dropOnGap(dropGap ?? pageCount);
        }}
      >
        {pages.map((page) => {
          const isSelected = selected.has(page);
          const isActive = page === currentPage;
          return (
            <Fragment key={page}>
              <div data-gap={page} aria-hidden="true" className={gapClass(dropGap === page)} />
              <div
                role="option"
                data-page-option={page}
                // The browser verification scripts
                // select thumbnails by this attribute; it stays a stable hook.
                data-thumb={page}
                aria-selected={isSelected}
                aria-current={isActive ? 'page' : undefined}
                aria-label={t('panel.goToPage', { page: page + 1 })}
                tabIndex={page === focusPage ? 0 : -1}
                draggable={editing}
                title={editing ? t('pages.dragHandle', { page: page + 1 }) : undefined}
                onClick={(event) => selectPage(page, event)}
                onKeyDown={onListKeyDown}
                onFocus={() => setFocusPage(page)}
                onDragStart={(event) => startDrag(page, event)}
                onDragOver={(event) => dragOverPage(page, event)}
                onDrop={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  dropOnGap(dropGap ?? page);
                }}
                className={`group relative block w-full cursor-pointer rounded-sm border p-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus ${
                  isSelected
                    ? 'border-pdf-accent bg-kumo-tint'
                    : isActive
                      ? 'border-kumo-strong/60 bg-kumo-recessed/60 font-medium'
                      : 'border-kumo-line hover:border-kumo-subtle'
                }`}
              >
                {/* Floating quick-action pill on hover (Image #2) */}
                {editing ? (
                  <div className="pointer-events-none absolute right-1.5 top-1.5 z-20 hidden group-hover:flex group-focus-within:flex flex-col items-center gap-0.5 rounded-md border border-kumo-line/80 bg-kumo-base/95 p-0.5 shadow-md backdrop-blur-xs">
                    <button
                      type="button"
                      title={t('context.rotateCW')}
                      aria-label={t('pages.rotate.right')}
                      onClick={(e) => {
                        e.stopPropagation();
                        // The page travels with the action: the selection set here is not
                        // committed yet when the action runs, so it would act on the old one.
                        onSelectionChange([page]);
                        onPageAction({ kind: 'rotate', direction: 'right', pages: [page] });
                      }}
                      className="pointer-events-auto flex size-6 items-center justify-center rounded text-kumo-default hover:bg-kumo-recessed hover:text-kumo-strong transition-colors"
                    >
                      <ArrowClockwise size={13} weight="bold" />
                    </button>
                    <button
                      type="button"
                      title={t('context.rotateCCW')}
                      aria-label={t('pages.rotate.left')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectionChange([page]);
                        onPageAction({ kind: 'rotate', direction: 'left', pages: [page] });
                      }}
                      className="pointer-events-auto flex size-6 items-center justify-center rounded text-kumo-default hover:bg-kumo-recessed hover:text-kumo-strong transition-colors"
                    >
                      <ArrowCounterClockwise size={13} weight="bold" />
                    </button>
                    <button
                      type="button"
                      title={t('pages.delete')}
                      aria-label={t('pages.delete')}
                      disabled={pageCount <= 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectionChange([page]);
                        onPageAction({ kind: 'delete', pages: [page] });
                      }}
                      className="pointer-events-auto flex size-6 items-center justify-center rounded text-kumo-default hover:bg-kumo-recessed hover:text-kumo-danger disabled:opacity-30 transition-colors"
                    >
                      <Trash size={13} weight="bold" />
                    </button>
                  </div>
                ) : null}

                <PageThumbnail
                  key={`${page}-${version ?? ''}`}
                  document={document}
                  pageIndex={page}
                  version={version}
                />
                <span
                  className={`mt-1 block text-xs tabular-nums ${
                    isSelected || isActive ? 'font-medium text-kumo-strong' : 'text-kumo-subtle'
                  }`}
                >
                  {page + 1}
                </span>
              </div>
            </Fragment>
          );
        })}
        <div data-gap={pageCount} aria-hidden="true" className={gapClass(dropGap === pageCount)} />
      </div>
    </div>
  );
}

/**
 * One page's canvas, drawn the first time the item becomes visible and never
 * eagerly: the whole point of the observer is that a 2000-page document costs
 * 2000 cheap placeholders, not 2000 render tasks.
 */
function PageThumbnail({
  document,
  pageIndex,
  version,
}: {
  document: PdfDocumentHandle;
  pageIndex: number;
  version?: string;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const paintedRef = useRef(false);
  const [height, setHeight] = useState<number | null>(null);

  const lastKeyRef = useRef<string>('');
  const currentKey = `${document.raw.numPages}-${version ?? ''}`;
  if (lastKeyRef.current !== currentKey) {
    lastKeyRef.current = currentKey;
    paintedRef.current = false;
  }

  /**
   * Each attempt owns a **fresh canvas**. Reusing the element across tab switches
   * let a superseded render task (aborted, or still finishing after the panel
   * remounted) write into the same node as its replacement: the result was a
   * page drawn upside down.
   */
  const draw = useCallback(
    async (signal: AbortSignal) => {
      const holder = holderRef.current;
      if (holder === null) return;
      const page = await document.getPageSize(pageIndex, 1);
      const scale = THUMBNAIL_WIDTH / page.width;
      setHeight(Math.round(page.height * scale));
      // `document` here is the PDF handle prop, not the global: reach for the DOM explicitly.
      const canvas = globalThis.document.createElement('canvas');
      canvas.className = 'max-w-full';
      canvas.width = THUMBNAIL_WIDTH;
      canvas.height = Math.round(page.height * scale);
      await document.renderPage(pageIndex, canvas, { scale, signal });
      if (signal.aborted) return;
      holder.replaceChildren(canvas);
      paintedRef.current = true;
    },
    [document, pageIndex],
  );

  useEffect(() => {
    const holder = holderRef.current;
    if (holder === null) return undefined;
    const controller = new AbortController();
    // Lazy, and **staying** lazy: the observer is not disconnected after the first
    // hit, so a thumbnail whose first attempt was aborted is drawn when it next
    // becomes visible instead of staying blank forever.
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || paintedRef.current) return;
        void draw(controller.signal).catch(() => undefined);
      },
      { rootMargin: '120px' },
    );
    observer.observe(holder);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [draw]);

  return (
    <div
      ref={holderRef}
      className="flex justify-center bg-pdf-paper"
      style={height === null ? { height: 140 } : { height }}
    />
  );
}
