/**
 * The organize view: every page of the document as a large thumbnail in a responsive grid,
 * over the whole editor area, for putting a document in order at a glance.
 *
 * It is the page list's bigger sibling and says the same things in the same way: selection is
 * the shell's state (`selectedPages` is a controlled prop), every change leaves as a
 * `PageMoveAction` the app journals, and the panel never touches the document. What it adds is
 * the grid: a thumbnail size, arrow keys that walk rows as well as columns, and a drop
 * indicator between two cards instead of between two rows.
 *
 * Three behaviours are deliberate:
 *
 * 1. **One renderer, drawn on demand** — the thumbnails are the page list's own
 *    `PageThumbnail`: a card costs one placeholder until it scrolls near the window, and gives
 *    its canvas up when it leaves, so a 1000-page document is a thousand cheap boxes.
 * 2. **Events are delegated** — the grid listens once and finds the card under the event, so a
 *    card's props are values only (selected, current, dimmed, drop side) and a selection change
 *    redraws the cards it changed, not a thousand closures.
 * 3. **Drag is the pointer shortcut, never the only way** — a keyboard reorders with `Alt`/`Ctrl`
 *    and the arrows, a finger with the move buttons, the "move to" field and the "select
 *    several" mode (a touch screen has no `Ctrl`).
 */

import {
  ArrowBendDownRight,
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Export,
  FilePlus,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { PdfDocumentHandle } from 'pdf-core';
import type { AnnotationMark } from 'pdf-core/ops/annotations';
import type { Translator } from 'pdf-shared';
import {
  memo,
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
import type { PageMoveAction } from './PagesPanel';
import { PageThumbnail } from './PageThumbnail';
import { NO_MARKS, pageCaption, useMarksByPage, usePageLabels } from './page-info';
import { arrowDelta, clickSelection, dropIndex, gridColumns, shiftIndex } from './page-select';

export interface OrganizeViewProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  /** The page on screen (0-based): the view opens on it and marks it. */
  readonly currentPage: number;
  readonly selectedPages: readonly number[];
  readonly onSelectionChange: (pages: readonly number[]) => void;
  readonly onGoToPage: (pageIndex: number) => void;
  readonly onPageAction: (action: PageMoveAction) => void;
  /** Back to the document. */
  readonly onClose: () => void;
  /** False in viewing mode: selection stays available, every action is disabled. */
  readonly editing: boolean;
  /** Open the extract-pages and insert-pages forms; absent leaves the button disabled. */
  readonly onExtract?: () => void;
  readonly onInsert?: () => void;
  /** Changes with the working version, so a rotated page is drawn again. */
  readonly version?: string;
  readonly marks?: readonly AnnotationMark[];
}

/** The thumbnail widths the size slider steps through. */
export const THUMBNAIL_SIZES: readonly number[] = [96, 144, 200, 280];
/** A card's padding and border, around its thumbnail. */
const CARD_CHROME = 16;
/** The grid's own padding and gap, which `gridColumns` needs to count the columns it will make. */
const GRID_PADDING = 12;
const GRID_GAP = 8;
/** Below this width the view opens on the second size, so a phone shows two columns. */
const NARROW = 640;
/** How much taller than wide a page may be drawn before its card stops growing. */
const TALLEST = 1.4;

const INPUT_CLASS =
  'h-6 w-14 rounded-sm border border-kumo-line bg-kumo-base px-1 text-xs text-kumo-default tabular-nums outline-none focus:ring-1 focus:ring-kumo-focus disabled:opacity-50';

const SELECTION = 'border-pdf-accent bg-kumo-tint';
const CURRENT = 'border-kumo-strong/60 bg-kumo-recessed/60';
const OTHER = 'border-kumo-line hover:border-kumo-subtle';

/** The page index of the card an event happened in, or `null` for the grid's own space. */
function cardPage(target: EventTarget | null): number | null {
  const card = (target as Element | null)?.closest<HTMLElement>('[data-page-option]');
  return card === null || card === undefined ? null : Number(card.dataset.pageOption);
}

function isRtl(): boolean {
  return globalThis.document.documentElement.dir === 'rtl';
}

interface CardProps {
  readonly document: PdfDocumentHandle;
  readonly page: number;
  readonly caption: string;
  readonly label: string;
  readonly hint: string | undefined;
  readonly selected: boolean;
  readonly current: boolean;
  readonly focusable: boolean;
  readonly dragging: boolean;
  readonly drop: 'before' | 'after' | null;
  readonly draggable: boolean;
  readonly size: number;
  readonly version: string | undefined;
  readonly marks: readonly AnnotationMark[];
}

const OrganizeCard = memo(function OrganizeCard({
  document,
  page,
  caption,
  label,
  hint,
  selected,
  current,
  focusable,
  dragging,
  drop,
  draggable,
  size,
  version,
  marks,
}: CardProps) {
  return (
    <div
      role="option"
      data-page-option={page}
      aria-selected={selected}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      tabIndex={focusable ? 0 : -1}
      draggable={draggable}
      title={hint}
      className={`relative cursor-pointer rounded-md border p-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus ${
        selected ? SELECTION : current ? CURRENT : OTHER
      } ${dragging ? 'opacity-40' : ''}`}
    >
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute start-2 top-2 z-10 flex size-5 items-center justify-center rounded-full bg-pdf-accent text-pdf-on-accent"
        >
          <Check size={12} weight="bold" />
        </span>
      ) : null}
      <PageThumbnail
        key={`${page}-${version ?? ''}`}
        document={document}
        pageIndex={page}
        marks={marks}
        width={size}
        maxHeight={Math.round(size * TALLEST)}
        rootMargin="240px"
      />
      <span
        className={`mt-1 block text-xs tabular-nums ${
          selected || current ? 'font-medium text-kumo-strong' : 'text-kumo-subtle'
        }`}
      >
        {caption}
      </span>
      {drop === null ? null : (
        <span
          aria-hidden="true"
          data-drop={drop}
          className={`pointer-events-none absolute inset-y-0 z-20 w-1 rounded-full bg-pdf-accent ${
            drop === 'before' ? '-start-1.5' : '-end-1.5'
          }`}
        />
      )}
    </div>
  );
});

export function OrganizeView({
  document,
  t,
  currentPage,
  selectedPages,
  onSelectionChange,
  onGoToPage,
  onPageAction,
  onClose,
  editing,
  onExtract,
  onInsert,
  version,
  marks,
}: OrganizeViewProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const labels = usePageLabels(document);
  const marksByPage = useMarksByPage(marks);
  const moveToId = useId();
  const sizeId = useId();
  const helpId = useId();
  /** The roving tab stop: exactly one card carries `tabIndex={0}`. */
  const [focusPage, setFocusPage] = useState(currentPage);
  /** Anchor of a `Shift` range — the last page clicked or toggled. */
  const [anchor, setAnchor] = useState<number | null>(null);
  /** The "select several" mode: a tap toggles a page, as `Ctrl` does for a mouse. */
  const [several, setSeveral] = useState(false);
  const [step, setStep] = useState(() => (globalThis.innerWidth < NARROW ? 1 : 2));
  const [dragPages, setDragPages] = useState<readonly number[] | null>(null);
  const [dropTarget, setDropTarget] = useState<{ readonly page: number; readonly after: boolean } | null>(
    null,
  );
  const [moveTo, setMoveTo] = useState('');
  const [announcement, setAnnouncement] = useState('');

  const size = THUMBNAIL_SIZES[step] as number;
  const pageCount = document.pageCount;
  const pages = useMemo(() => Array.from({ length: pageCount }, (_unused, page) => page), [pageCount]);
  const selection = useMemo(() => [...selectedPages].sort((a, b) => a - b), [selectedPages]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const dragged = useMemo(() => new Set(dragPages ?? []), [dragPages]);
  const firstSelected = selection[0] ?? 0;
  /** How many positions exist once the selection is taken out of the document. */
  const remaining = pageCount - selection.length;
  const focusStop = Math.min(focusPage, pageCount - 1);

  // The view opens on the page the reader was looking at, and gives the focus back to whatever
  // had it when it closes (a menu, the palette's caller), which a keyboard user would
  // otherwise lose along with the grid. Only at mount: the page on screen when the view opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const opener = globalThis.document.activeElement as HTMLElement | null;
    const card = listRef.current?.querySelector<HTMLElement>(`[data-page-option="${currentPage}"]`);
    card?.scrollIntoView({ block: 'center' });
    card?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);

  // While a change is being made every button is off, and a button that is off drops the focus
  // it had onto the page: Escape, the arrows and the tab order would all start from nowhere.
  // When the view can be edited again the focus goes back to where it was. A button that was
  // off may be a new element by then, so it is found again by its name.
  const rootRef = useRef<HTMLElement | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!editing || globalThis.document.activeElement !== globalThis.document.body) return;
    const last = lastFocus.current;
    const label = last?.getAttribute('aria-label');
    (last?.isConnected
      ? last
      : rootRef.current?.querySelector<HTMLElement>(`[aria-label="${label}"]`)
    )?.focus();
  }, [editing]);

  // A page that no longer exists (a delete landed, an undo shortened the document) must not
  // stay selected: the indices are the shell's, and it cannot know the page count changed.
  useEffect(() => {
    if (selection.some((page) => page >= pageCount)) {
      onSelectionChange(selection.filter((page) => page < pageCount));
    }
  }, [pageCount, selection, onSelectionChange]);

  const applySelection = useCallback(
    (next: readonly number[]) => {
      const sorted = [...new Set(next)].sort((a, b) => a - b);
      onSelectionChange(sorted);
      setAnnouncement(t('pages.selected', { count: sorted.length }));
    },
    [onSelectionChange, t],
  );

  const focusCard = useCallback((page: number) => {
    listRef.current?.querySelector<HTMLElement>(`[data-page-option="${page}"]`)?.focus();
  }, []);

  /** How many cards the grid has in a row right now. */
  const columns = () =>
    gridColumns((listRef.current as HTMLElement).clientWidth, size + CARD_CHROME, GRID_GAP, GRID_PADDING);

  /**
   * Move `moving` to `toIndex` and keep the highlight on those pages. The shell's selection is
   * index-based, so an action without the new indices would leave the outline on whichever
   * pages slid into the old positions.
   */
  const moveSelection = (toIndex: number, moving: readonly number[]) => {
    onPageAction({ kind: 'move', toIndex });
    onSelectionChange(Array.from({ length: moving.length }, (_unused, offset) => toIndex + offset));
    setAnnouncement(t('organize.movedTo', { position: toIndex + 1 }));
  };

  /** The block moves `delta` places: one for an arrow, a row for up and down. */
  const moveBy = (delta: number) => {
    const to = shiftIndex(firstSelected, delta, remaining);
    if (!editing || selection.length === 0 || to === null) return;
    moveSelection(to, selection);
    setFocusPage(to);
    focusCard(to);
  };

  const openPage = (page: number) => {
    onGoToPage(page);
    onClose();
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const page = cardPage(event.target);
    if (page === null) {
      // The grid's own space, never a card, clears the selection.
      setAnchor(null);
      applySelection([]);
      return;
    }
    const next = clickSelection({
      selection,
      anchor,
      page,
      shift: event.shiftKey,
      toggle: event.ctrlKey || event.metaKey || several,
    });
    setAnchor(next.anchor);
    setFocusPage(page);
    applySelection(next.selection);
  };

  /**
   * Keys arrive from the focused card, the only thing in the grid that takes focus. `Escape`
   * belongs to the whole view and is handled where it is mounted; a key in the toolbar's own
   * controls never reaches the grid.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const page = cardPage(event.target) as number;
    const { key, altKey, ctrlKey, metaKey } = event;
    const accel = ctrlKey || metaKey;

    if (accel && (key === 'a' || key === 'A')) {
      event.preventDefault();
      applySelection(pages);
      return;
    }

    const delta = arrowDelta(key, columns(), isRtl());
    if (delta !== null) {
      event.preventDefault();
      if (altKey || accel) {
        moveBy(delta);
        return;
      }
      const next = Math.min(pageCount - 1, Math.max(0, focusStop + delta));
      setFocusPage(next);
      focusCard(next);
      return;
    }

    switch (key) {
      case 'Home':
      case 'End': {
        event.preventDefault();
        const next = key === 'Home' ? 0 : pageCount - 1;
        setFocusPage(next);
        focusCard(next);
        return;
      }
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        setAnchor(page);
        applySelection(selected.has(page) ? selection.filter((item) => item !== page) : [...selection, page]);
        return;
      }
      case 'Enter': {
        event.preventDefault();
        openPage(page);
        return;
      }
      case 'Delete':
      case 'Backspace': {
        // The selected pages, never every page; with nothing selected the key does nothing.
        event.preventDefault();
        if (editing && selection.length > 0 && selection.length < pageCount) onPageAction({ kind: 'delete' });
        return;
      }
      default:
        return;
    }
  };

  const onDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    const page = cardPage(event.target);
    if (page === null) return;
    if (!editing) {
      event.preventDefault();
      return;
    }
    // Dragging an unselected page drags that page: the drag is a selection gesture
    // first, which is what a user pointing at one thumbnail expects.
    const moving = selected.has(page) ? selection : [page];
    if (!selected.has(page)) {
      setAnchor(page);
      applySelection([page]);
    }
    setDragPages(moving);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag without payload; the text is also what a
    // drop into another application should read.
    event.dataTransfer.setData('text/plain', moving.map((index) => index + 1).join(', '));
  };

  /** Which side of a card the pointer is on decides before or after it. */
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    // A file dragged in from outside is not a reorder: the shell's own drop zone has it.
    if (dragPages === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const page = cardPage(event.target);
    if (page === null) return;
    const rect = event.currentTarget
      .querySelector(`[data-page-option="${page}"]`)
      ?.getBoundingClientRect() as DOMRect;
    const right = event.clientX > rect.left + rect.width / 2;
    const after = right !== isRtl();
    setDropTarget((previous) =>
      previous?.page === page && previous.after === after ? previous : { page, after },
    );
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const moving = dragPages;
    const gap = dropTarget === null ? pageCount : dropTarget.page + (dropTarget.after ? 1 : 0);
    setDragPages(null);
    setDropTarget(null);
    if (moving === null) return;
    moveSelection(dropIndex(moving, gap, remaining), moving);
  };

  const submitMoveTo = (event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The field's own `min`/`max` hold the value inside 1…remaining + 1 (the browser refuses to
    // submit anything else), and the button is off while the field is empty.
    setMoveTo('');
    moveSelection(Number.parseInt(moveTo, 10) - 1, selection);
  };

  const none = selection.length === 0;
  const act = (action: PageMoveAction) => () => onPageAction(action);

  return (
    <section
      ref={rootRef}
      aria-label={t('tools.group.pages')}
      data-organize-view=""
      // The shell's Ctrl+A and Delete are about marks on the page; here they are about pages.
      data-owns-select-keys=""
      className="absolute inset-0 z-40 flex min-h-0 flex-col bg-kumo-canvas"
      onFocus={(event) => {
        lastFocus.current = event.target as HTMLElement;
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
    >
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-kumo-line px-3 py-2">
        <div className="me-auto min-w-0">
          <h2 className="truncate text-sm font-medium text-kumo-strong">{t('tools.group.pages')}</h2>
          <p className="text-xs text-kumo-subtle tabular-nums">
            {t('organize.status', { selected: selection.length, total: pageCount })}
          </p>
        </div>
        <Button
          variant={several ? 'primary' : 'secondary'}
          aria-pressed={several}
          icon={Check}
          onClick={() => setSeveral((on) => !on)}
        >
          {t('organize.selectMode')}
        </Button>
        <label htmlFor={sizeId} className="flex items-center gap-2 text-xs text-kumo-subtle">
          {t('organize.size')}
          <input
            id={sizeId}
            type="range"
            min={0}
            max={THUMBNAIL_SIZES.length - 1}
            step={1}
            value={step}
            className="w-24 accent-pdf-accent"
            onChange={(event) => setStep(Number(event.target.value))}
          />
        </label>
        <Button variant="primary" icon={X} onClick={onClose}>
          {t('organize.close')}
        </Button>
      </header>

      <div
        role="toolbar"
        aria-label={t('panel.pages.selection', { count: selection.length })}
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-kumo-line bg-kumo-tint px-3 py-1"
      >
        <Button
          shape="square"
          icon={ArrowCounterClockwise}
          disabled={!editing || none}
          aria-label={t('pages.rotate.left')}
          title={t('pages.rotate.left')}
          onClick={act({ kind: 'rotate', direction: 'left' })}
        />
        <Button
          shape="square"
          icon={ArrowClockwise}
          disabled={!editing || none}
          aria-label={t('pages.rotate.right')}
          title={t('pages.rotate.right')}
          onClick={act({ kind: 'rotate', direction: 'right' })}
        />
        <Button
          shape="square"
          icon={Copy}
          disabled={!editing || none}
          aria-label={t('pages.duplicate')}
          title={t('pages.duplicate')}
          onClick={act({ kind: 'duplicate' })}
        />
        <Button
          shape="square"
          variant="secondary-destructive"
          icon={Trash}
          // Deleting every page would leave no document, so the button never offers it.
          disabled={!editing || none || selection.length >= pageCount}
          aria-label={t('pages.delete')}
          title={t('pages.delete')}
          onClick={act({ kind: 'delete' })}
        />
        <Button
          shape="square"
          icon={Export}
          disabled={!editing || none || onExtract === undefined}
          aria-label={t('pages.extract.title')}
          title={t('pages.extract.title')}
          onClick={() => onExtract?.()}
        />
        <Button
          shape="square"
          icon={FilePlus}
          disabled={!editing || onInsert === undefined}
          aria-label={t('insert.title')}
          title={t('insert.title')}
          onClick={() => onInsert?.()}
        />
        <Button
          shape="square"
          icon={ArrowLeft}
          className="rtl:-scale-x-100"
          disabled={!editing || none || firstSelected === 0}
          aria-label={t('organize.moveEarlier')}
          title={t('organize.moveEarlier')}
          onClick={() => moveBy(-1)}
        />
        <Button
          shape="square"
          icon={ArrowRight}
          className="rtl:-scale-x-100"
          disabled={!editing || none || firstSelected + 1 > remaining}
          aria-label={t('organize.moveLater')}
          title={t('organize.moveLater')}
          onClick={() => moveBy(1)}
        />
        {/* The touch and keyboard path to a far reorder, beside the drag the pointer has. */}
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
            disabled={!editing || none}
            onChange={(event) => setMoveTo(event.target.value)}
          />
          <Button
            type="submit"
            shape="square"
            icon={ArrowBendDownRight}
            disabled={!editing || none || moveTo.trim() === ''}
            aria-label={t('pages.moveTo')}
            title={t('pages.moveTo')}
          />
        </form>
      </div>

      <p id={helpId} className="hidden shrink-0 px-3 pt-2 text-xs text-kumo-subtle sm:block">
        {t('organize.help')}
      </p>

      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label={t('tools.group.pages')}
        aria-describedby={helpId}
        className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size + CARD_CHROME}px, 1fr))` }}
        onClick={onClick}
        onDoubleClick={(event) => {
          const page = cardPage(event.target);
          if (page !== null) openPage(page);
        }}
        onKeyDown={onKeyDown}
        onFocus={(event) => setFocusPage(cardPage(event.target) as number)}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDragEnd={() => {
          setDragPages(null);
          setDropTarget(null);
        }}
        onDrop={onDrop}
      >
        {pages.map((page) => (
          <OrganizeCard
            key={page}
            document={document}
            page={page}
            caption={pageCaption(labels?.[page], page)}
            label={t('organize.page', { page: page + 1 })}
            hint={editing ? t('pages.dragHandle', { page: page + 1 }) : undefined}
            selected={selected.has(page)}
            current={page === currentPage}
            focusable={page === focusStop}
            dragging={dragged.has(page)}
            drop={dropTarget?.page === page ? (dropTarget.after ? 'after' : 'before') : null}
            draggable={editing}
            size={size}
            version={version}
            marks={marksByPage.get(page) ?? NO_MARKS}
          />
        ))}
      </div>
    </section>
  );
}
