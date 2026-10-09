/**
 * The text tool's canvas layer.
 *
 * The block model comes from **MuPDF's structured text** (`pdf-core/text-source`),
 * which is the engine that already answers block → line → character with quads and
 * already knows the page's `/Rotate`; segmenting pdf.js's flat text items into
 * blocks would mean inventing gap thresholds the engine already answers. The model is then built by the pure
 * `pdf-text-engine` package, so what this layer paints and what the writer erases
 * come from one source of truth.
 *
 * Two honesty rules are implemented here rather than left to the writer:
 * a block that cannot be re-rendered is **marked with a red frame** (never skipped
 * silently), and a block that will need a substituted face says so — the product
 * copy is explicit that a subset font does not carry the glyphs for new characters.
 *
 * The layer is an overlay, not a second viewer: it shows block boxes over the pages
 * the viewer has already painted, and a click hands the selection to the app. It
 * never touches the document (state changes go through the model).
 */

import type { OperationContext } from 'pdf-core';
import { loadTextFonts, readPageText } from 'pdf-core/text-source';
import type { Translator } from 'pdf-shared';
import { toToolError } from 'pdf-shared';
import type { FontCatalog, FontMetrics, TextBlock, TextPage } from 'pdf-text-engine';
import { buildTextPage, measureEditability } from 'pdf-text-engine';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';

/** The fonts the edit path embeds; loaded once per layer mount. */
export interface TextFontSet {
  readonly catalog: FontCatalog;
  readonly metrics: Readonly<Record<string, FontMetrics>>;
}

export interface TextBlockSelection {
  readonly pageIndex: number;
  readonly block: TextBlock;
  readonly model: TextPage;
  readonly fonts: TextFontSet;
  readonly editable: boolean;
  readonly substitutionRequired: boolean;
  readonly reasonKey: string;
}

export interface TextLayerProps {
  readonly t: Translator;
  readonly viewer: ViewerApi;
  /**
   * The shell's layout revision: it moves each time the pages are laid out again. The blocks are placed while the layer renders,
   * and the viewer answers where a page is through one long-lived object, so nothing else in
   * the props says it has to be placed again.
   */
  readonly layout: number;
  /** The bytes of the working version: the model must describe what the user sees. */
  readonly bytes: Uint8Array;
  readonly pageIndex: number;
  readonly onSelect: (selection: TextBlockSelection) => void;
  readonly onClose: () => void;
}

interface PaintedBlock {
  readonly id: string;
  /** The block's box in the model's page space; placed on screen at every render. */
  readonly rect: readonly [number, number, number, number];
  readonly text: string;
  readonly editable: boolean;
  readonly substitutionRequired: boolean;
  readonly reasonKey: string;
  readonly selection: TextBlockSelection;
}

/**
 * A model rect → the same rect on the page as displayed (`u` right, `v` down from the
 * turned page's top-left corner, points): the forward turn of the one `toUserX` /
 * `toUserY` in `pdf-core/text-source.ts` undo, against the same unrotated page box.
 */
export function displayedBox(
  rect: readonly [number, number, number, number],
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rotation: number,
): readonly [number, number, number, number] {
  const corner = (x: number, y: number): readonly [number, number] => {
    switch (rotation) {
      case 90:
        return [box.y + box.height - y, x - box.x];
      case 180:
        return [box.x + box.width - x, box.y + box.height - y];
      case 270:
        return [y - box.y, box.x + box.width - x];
      default:
        return [x - box.x, y - box.y];
    }
  };
  const [u0, v0] = corner(rect[0], rect[1]);
  const [u1, v1] = corner(rect[2], rect[3]);
  return [Math.min(u0, u1), Math.min(v0, v1), Math.max(u0, u1), Math.max(v0, v1)];
}

/** Where the viewer has laid one page out, as it was at one layout. */
interface PageSurface {
  readonly layout: number;
  readonly page: ReturnType<ViewerApi['pageRect']>;
  readonly view: ReturnType<ViewerApi['pageGeometry']>;
  readonly container: ReturnType<ViewerApi['containerRect']>;
}

/**
 * Read where the viewer has put page `pageIndex` at `layout`. The revision is an argument, and part
 * of what comes back, because the React Compiler memoizes a call on its arguments: `viewer` is the
 * same object across layouts, so without it the first reading would be kept for good.
 */
function surfaceOf(viewer: ViewerApi, pageIndex: number, layout: number): PageSurface {
  return {
    layout,
    page: viewer.pageRect(pageIndex),
    view: viewer.pageGeometry(pageIndex),
    container: viewer.containerRect(),
  };
}

/** One translation of a message key without the `t()` shape, for `data-*` and titles. */
function reasonKeyFor(reason: string): string {
  return `textedit.reason.${reason}`;
}

export function TextLayer({ t, viewer, layout, bytes, pageIndex, onSelect, onClose }: TextLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [painted, setPainted] = useState<readonly PaintedBlock[]>([]);
  /** The model's page size, the space `PaintedBlock.rect` is measured in. */
  const [modelSize, setModelSize] = useState<{ readonly width: number; readonly height: number } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [failureDetail, setFailureDetail] = useState<string | null>(null);

  /**
   * Reading the page is async and the viewer keeps painting underneath it, so the
   * effect re-runs on page change and on a viewer resize; a stale run is dropped by
   * the `cancelled` latch instead of painting boxes against a viewport that moved.
   */
  useEffect(() => {
    let cancelled = false;
    const context: OperationContext = { signal: new AbortController().signal };
    setLoading(true);
    void (async () => {
      try {
        const [source, fonts] = await Promise.all([readPageText(bytes, pageIndex, context), loadTextFonts()]);
        if (cancelled) return;
        const model = buildTextPage(source);
        const report = measureEditability(model);
        const rows: PaintedBlock[] = [];
        for (const block of model.blocks) {
          const info = report.blocks.find((entry) => entry.blockId === block.id);
          const editable = (info?.verdict ?? 'not-editable') !== 'not-editable';
          const substitutionRequired = info?.substitutionRequired ?? true;
          const reasonKey = reasonKeyFor(info?.reason ?? 'no-glyphs');
          rows.push({
            id: block.id,
            rect: [block.rect[0], block.rect[1], block.rect[2], block.rect[3]],
            text: block.text,
            editable,
            substitutionRequired,
            reasonKey,
            selection: {
              pageIndex,
              block,
              model,
              fonts,
              editable,
              substitutionRequired,
              reasonKey,
            },
          });
        }
        setPainted(rows);
        setModelSize({ width: model.width, height: model.height });
        setFailure(null);
        setLoading(false);
      } catch (error) {
        if (cancelled) return;
        setPainted([]);
        setLoading(false);
        // The reader failing is a real failure: say so on the page rather than
        // leaving an empty overlay that looks like "there is no text here". The
        // engine's own message goes to the diagnostic attribute, never to the UI
        // (raw engine text is diagnostics, the dictionary is the text).
        const toolError = toToolError(error);
        setFailure(toolError.code);
        setFailureDetail(toolError.details.engineMessage ?? String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, pageIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const select = useCallback(
    (entry: PaintedBlock) => {
      if (!entry.editable) return;
      onSelect(entry.selection);
    },
    [onSelect],
  );

  /**
   * The blocks are placed **at render**, against the page as it is laid out now. Placed
   * once, when the page's text arrived, a zoom, a resize or a scroll
   * afterwards would leave every box where the page had been, so a click on a paragraph
   * would open whichever one had stood under that spot when the text arrived. The model is the *unrotated* page
   * (`text-source.ts`); the page on screen is turned by its `/Rotate`, so each box is
   * turned the same way (`displayedBox`) before it is scaled onto the page rect —
   * scaled straight across, the boxes of a turned page sat where its text would be
   * without the turn.
   */
  const { page, view, container } = surfaceOf(viewer, pageIndex, layout);
  const place = (rect: PaintedBlock['rect']) => {
    if (page === null || view === null || modelSize === null) return null;
    const box = { x: view.x, y: view.y, width: modelSize.width, height: modelSize.height };
    const shown = displayedBox(rect, box, view.rotation);
    const quarter = view.rotation === 90 || view.rotation === 270;
    const scale = page.width / Math.max(1, quarter ? box.height : box.width);
    return {
      left: page.x - container.x + shown[0] * scale,
      top: page.y - container.y + shown[1] * scale,
      width: Math.max(1, (shown[2] - shown[0]) * scale),
      height: Math.max(1, (shown[3] - shown[1]) * scale),
    };
  };

  return (
    <div
      ref={layerRef}
      data-text-layer="true"
      className="pointer-events-none absolute inset-0 z-10"
      aria-busy={loading}
    >
      {painted.map((entry) => {
        const box = place(entry.rect);
        if (box === null) return null;
        return (
          <button
            key={entry.id}
            type="button"
            data-text-block={entry.id}
            data-editability={
              entry.editable ? (entry.substitutionRequired ? 'substituted' : 'editable') : 'not-editable'
            }
            data-block-rect={JSON.stringify(entry.selection.block.rect)}
            data-block-text={entry.text}
            aria-label={`${entry.text.slice(0, 80)} — ${t(entry.reasonKey as Parameters<Translator>[0])}`}
            title={t(entry.reasonKey as Parameters<Translator>[0])}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => select(entry)}
            className={`pointer-events-auto absolute cursor-text border bg-transparent text-transparent ${
              entry.editable
                ? entry.substitutionRequired
                  ? 'border-kumo-warning/70 hover:bg-kumo-warning/10'
                  : 'border-transparent hover:border-kumo-focus hover:bg-kumo-focus/10'
                : 'border-kumo-danger cursor-not-allowed'
            }`}
            style={{
              left: `${box.left}px`,
              top: `${box.top}px`,
              width: `${box.width}px`,
              height: `${box.height}px`,
            }}
          />
        );
      })}
      {failure === null ? null : (
        <p
          data-text-layer-error={failure}
          data-text-layer-reason={failureDetail ?? ''}
          title={failureDetail ?? undefined}
          className="pointer-events-auto absolute bottom-2 start-2 max-w-[60ch] rounded-sm border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default"
        >
          {t('textedit.readFailed')}
        </p>
      )}
    </div>
  );
}
