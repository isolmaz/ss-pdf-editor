/**
 * The text tool's canvas layer.
 *
 * The block model comes from **MuPDF's structured text** (`pdf-core/text-source`),
 * which is the engine that already answers block → line → character with quads and
 * already knows the page's `/Rotate`; segmenting pdf.js's flat text items into
 * blocks would mean inventing the gap thresholds the spike deliberately did not
 * need. The model is then built by the pure
 * `pdf-text-engine` package, so what this layer paints and what the writer erases
 * come from one source of truth.
 *
 * Two honesty rules from `4b` are implemented here rather than left to the writer:
 * a block that cannot be re-rendered is **marked with a red frame** (never skipped
 * silently), and a block that will need a substituted face says so — the product
 * copy is explicit that a subset font does not carry the glyphs for new characters.
 *
 * The layer is an overlay, not a second viewer: it shows block boxes over the pages
 * the viewer has already painted, and a click hands the selection to the app. It
 * never touches the document (state changes go through the model).
 */

import type { OperationContext } from 'pdf-core';
import { readPageText } from 'pdf-core/text-source';
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

/** One translation of a message key without the `t()` shape, for `data-*` and titles. */
function reasonKeyFor(reason: string): string {
  return `textedit.reason.${reason}`;
}

export function TextLayer({ t, viewer, bytes, pageIndex, onSelect, onClose }: TextLayerProps) {
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
        const [source, fonts] = await Promise.all([
          readPageText(bytes, pageIndex, context),
          import('pdf-core/text-source').then((module) => module.loadTextFonts()),
        ]);
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
   * The blocks are placed **at render**, against the page as it is laid out now. They
   * used to be placed once, when the page's text arrived: a zoom, a resize or a scroll
   * afterwards left every box where the page had been, so a click on a paragraph
   * opened the one that used to be there. Both the model and the page rect describe
   * the page as it is displayed, so the mapping is one scale per axis plus the page's
   * offset in the scrolled content.
   */
  const page = viewer.pageRect(pageIndex);
  const container = viewer.containerRect();
  const place = (rect: PaintedBlock['rect']) => {
    if (page === null || modelSize === null) return null;
    const scaleX = page.width / Math.max(1, modelSize.width);
    const scaleY = page.height / Math.max(1, modelSize.height);
    return {
      left: page.x - container.x + rect[0] * scaleX,
      top: page.y - container.y + rect[1] * scaleY,
      width: Math.max(1, (rect[2] - rect[0]) * scaleX),
      height: Math.max(1, (rect[3] - rect[1]) * scaleY),
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
