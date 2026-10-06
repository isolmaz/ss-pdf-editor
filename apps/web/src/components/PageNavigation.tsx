import type { Icon } from '@phosphor-icons/react';
import {
  ArrowClockwise,
  BookOpen,
  CaretLeft,
  CaretRight,
  CornersOut,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Sidebar,
} from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import { Tooltip } from 'pdf-ui/ui';
import { useState } from 'react';

/**
 * Page and view controls, **in the status bar**.
 *
 * They used to float in the viewer's bottom-right corner, over the page itself: at
 * every width they covered text, and below 1024 px a third of a line. In the bar that
 * already reports page and zoom they cover nothing, and the bar keeps one row.
 *
 * "Rotate" turns the **current page** unless pages are selected in the page panel, in
 * which case it turns those — the same rule every page action follows (`runPageAction`).
 */
export interface PageNavigationProps {
  readonly t: Translator;
  readonly currentPage: number;
  readonly pageCount: number;
  readonly onGoToPage: (pageIndex: number) => void;
  readonly zoom: number;
  readonly onZoomChange: (zoom: number | 'page-width') => void;
  /** Absent while the document cannot be edited. */
  readonly onRotate?: () => void;
  readonly onToggleThumbnails: () => void;
  readonly thumbnailsOpen: boolean;
  readonly onToggleReading: () => void;
  readonly readingActive: boolean;
  readonly onToggleFullscreen: () => void;
}

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded text-kumo-default transition-colors hover:bg-kumo-recessed hover:text-kumo-strong focus-visible:outline-2 focus-visible:outline-kumo-focus disabled:opacity-30';
const PRESSED = 'bg-pdf-accent text-pdf-on-accent hover:bg-pdf-accent hover:text-pdf-on-accent';

/** Zoom steps: a quarter at a time, inside the viewer's own 25 %–400 % range. */
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

function IconButton({
  label,
  icon: Glyph,
  onClick,
  disabled,
  pressed,
  mirrored = false,
}: {
  readonly label: string;
  readonly icon: Icon;
  /** A direction glyph (previous/next) that turns over in a right-to-left UI. */
  readonly mirrored?: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        disabled={disabled}
        onClick={onClick}
        className={`${ICON_BUTTON} ${pressed === true ? PRESSED : ''}`}
      >
        <Glyph size={14} className={mirrored ? 'rtl:-scale-x-100' : undefined} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

export function PageNavigation({
  t,
  currentPage,
  pageCount,
  onGoToPage,
  zoom,
  onZoomChange,
  onRotate,
  onToggleThumbnails,
  thumbnailsOpen,
  onToggleReading,
  readingActive,
  onToggleFullscreen,
}: PageNavigationProps) {
  const [pageInput, setPageInput] = useState<string | null>(null);
  const label = (key: MessageKey) => t(key);

  return (
    <fieldset aria-label={t('nav.controls')} className="m-0 flex shrink-0 items-center gap-0.5 border-0 p-0">
      <IconButton
        label={label('nav.prevPage')}
        icon={CaretLeft}
        mirrored
        disabled={currentPage <= 0}
        onClick={() => onGoToPage(currentPage - 1)}
      />
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const page = Number.parseInt(pageInput ?? '', 10);
          if (!Number.isNaN(page) && page >= 1 && page <= pageCount) onGoToPage(page - 1);
          setPageInput(null);
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          aria-label={label('nav.pageNumber')}
          value={pageInput ?? String(currentPage + 1)}
          onChange={(event) => setPageInput(event.target.value)}
          onFocus={(event) => {
            setPageInput(String(currentPage + 1));
            event.currentTarget.select();
          }}
          onBlur={() => setPageInput(null)}
          className="h-5 w-8 rounded-sm border border-kumo-line bg-kumo-base px-0.5 text-center text-xs tabular-nums text-kumo-strong focus:border-pdf-accent focus:outline-hidden"
        />
        <span className="tabular-nums text-kumo-subtle">/ {pageCount}</span>
      </form>
      <IconButton
        label={label('nav.nextPage')}
        icon={CaretRight}
        mirrored
        disabled={currentPage >= pageCount - 1}
        onClick={() => onGoToPage(currentPage + 1)}
      />

      <span aria-hidden="true" className="mx-1 h-4 w-px bg-kumo-line" />

      <IconButton
        label={label('nav.zoomOut')}
        icon={MagnifyingGlassMinus}
        disabled={zoom <= ZOOM_MIN}
        onClick={() => onZoomChange(Math.max(ZOOM_MIN, zoom - ZOOM_STEP))}
      />
      <Tooltip label={label('nav.fitWidth')} side="top">
        <button
          type="button"
          aria-label={`${label('nav.fitWidth')} (${Math.round(zoom * 100)}%)`}
          onClick={() => onZoomChange('page-width')}
          className="min-w-11 rounded px-1 text-xs font-semibold tabular-nums text-kumo-subtle transition-colors hover:bg-kumo-recessed hover:text-kumo-strong focus-visible:outline-2 focus-visible:outline-kumo-focus"
        >
          {Math.round(zoom * 100)}%
        </button>
      </Tooltip>
      <IconButton
        label={label('nav.zoomIn')}
        icon={MagnifyingGlassPlus}
        disabled={zoom >= ZOOM_MAX}
        onClick={() => onZoomChange(Math.min(ZOOM_MAX, zoom + ZOOM_STEP))}
      />

      <span aria-hidden="true" className="mx-1 h-4 w-px bg-kumo-line" />

      {onRotate === undefined ? null : (
        <IconButton label={label('nav.rotate')} icon={ArrowClockwise} onClick={onRotate} />
      )}
      <IconButton
        label={label('nav.togglePages')}
        icon={Sidebar}
        pressed={thumbnailsOpen}
        onClick={onToggleThumbnails}
      />
      <IconButton
        label={label('nav.readingMode')}
        icon={BookOpen}
        pressed={readingActive}
        onClick={onToggleReading}
      />
      <IconButton label={label('nav.fullscreen')} icon={CornersOut} onClick={onToggleFullscreen} />
    </fieldset>
  );
}
