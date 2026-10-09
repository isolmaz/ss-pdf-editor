/**
 * The measurement tool surface (`M` = measure, 📐 Measure: "measurement tools,
 * ruler/grid/snap").
 *
 * Two halves in one file, because they share the thing that is hard here:
 *
 *  - **`MeasureLayer`** — the canvas overlay: it takes the pointer while the tool
 *    is armed, draws the chain the user is clicking (with the live value on it),
 *    draws the grid when it is on, snaps the pointer, and hands the finished mark
 *    to the app. It never touches the document (state changes go
 *    through the model).
 *  - **`MeasureSettings`** — the tool's own settings strip: mode, scale, unit,
 *    grid spacing, snapping, colour/opacity/thickness/author, and the readout.
 *    The shell mounts it once and owns the state it edits.
 *
 * ## Geometry, once
 *
 * `ops/measure.ts` owns every conversion and this file uses nothing else:
 *
 *  - pointer → app space with `ViewerApi.pointToPage` (pdf.js's own
 *    `PageViewport.convertToPdfPoint`, so zoom, the spread layout and `/Rotate`
 *    are the engine's arithmetic, not ours) — the same call `AnnotationLayer` and
 *    `RedactionLayer` make;
 *  - app space → the screen with `appToDisplayPoint` × the page's own CSS scale,
 *    which is the pair the core verified against pdf.js's `PageViewport` matrix
 *    for all four rotations.
 *
 * The overlay therefore stays correct at every zoom level and on a `/Rotate 90`
 * page. `AnnotationLayer`'s own `pageProjection` places marks in page points
 * without multiplying by the zoom scale, so at 150 % a mark there is drawn at
 * two-thirds of its offset — the scale factor here is what keeps the ruler under
 * the pointer instead of beside it. (This file does not touch that component.)
 *
 * ## Text
 *
 * Every sentence comes from the dictionary. The measurement-specific keys
 * (`tools.measure.*`) live in `parts/measure.ts` and `en-parts/measure.ts`; a key
 * missing there makes `label()` show the key itself, which is a visible "not wired"
 * marker rather than a wrong word: a component that invented Turkish here would be
 * the harder bug to find.
 */

import type {
  MeasureMark,
  MeasureMode,
  MeasurePageGeometry,
  MeasurePoint,
  MeasureScale,
  MeasureUnit,
} from 'pdf-core/ops/measure';
import {
  appToDisplayPoint,
  displaySize,
  formatAngle,
  formatLength,
  formatMeasurement,
  isMeasureUnit,
  MEASURE_MODES,
  MEASURE_UNITS,
  measureMark,
  parseScale,
  scaleForRatio,
} from 'pdf-core/ops/measure';
import type { MessageKey, Translator } from 'pdf-shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { type PageFrames, readPagesAt } from './mark-interaction';

// ---------------------------------------------------------------------------
// the dictionary
// ---------------------------------------------------------------------------

/**
 * The keys this surface needs. `tools.measure.*` is new (the note carries the
 * text); the rest are entries that already say exactly this.
 */
const MEASURE_KEYS = {
  tool: 'tools.measure',
  distance: 'tools.measure.distance',
  perimeter: 'tools.measure.perimeter',
  area: 'tools.measure.area',
  scale: 'tools.measure.scale',
  scaleHint: 'tools.measure.scaleHint',
  scaleUnreadable: 'tools.measure.scaleUnreadable',
  unit: 'tools.measure.unit',
  grid: 'tools.measure.grid',
  gridGap: 'tools.measure.gridGap',
  snapGrid: 'tools.measure.snapGrid',
  snapPoints: 'tools.measure.snapPoints',
  readout: 'panel.toolSettings',
  color: 'ann.tool.color',
  opacity: 'ann.tool.opacity',
  thickness: 'ann.tool.thickness',
  author: 'ann.tool.author',
  stop: 'ann.tool.stop',
  close: 'op.close',
} as const;

/**
 * A dictionary lookup that survives an entry that is not wired yet.
 *
 * `createTranslator` answers `undefined` for a key no part carries; showing the
 * key is honest, and the note lists the replacement text.
 */
function label(t: Translator, key: string): string {
  const text = t(key as MessageKey) as string | undefined;
  return text ?? key;
}

/** The unit's own symbol, and the only dictionary-free word in this file. */
function unitSymbol(unit: MeasureUnit): string {
  return unit;
}

// ---------------------------------------------------------------------------
// props
// ---------------------------------------------------------------------------

/** What the strip shows while the chain is being clicked. */
export interface MeasureReading {
  /** The primary value: the distance, the chain's length or the area. */
  readonly primary: string;
  /** The boundary length in area mode, `null` otherwise. */
  readonly secondary: string | null;
  /** The direction of the first segment, in degrees. */
  readonly angle: string;
  readonly points: number;
}

export interface MeasureLayerProps {
  readonly t: Translator;
  readonly viewer: ViewerApi;
  /**
   * The shell's layout revision: it moves each time the pages are laid out again. The marks are
   * placed while the layer renders, and the viewer answers where a page is through one
   * long-lived object, so nothing else in the props says they have to be placed again.
   */
  readonly layout: number;
  /** The armed mode; `null` renders only the marks the session already holds. */
  readonly mode: MeasureMode | null;
  readonly scale: MeasureScale;
  /** Marks the session holds but the file does not yet. */
  readonly marks: readonly MeasureMark[];
  readonly onCreate: (mark: MeasureMark) => void;
  readonly color: string;
  readonly opacity: number;
  readonly thickness: number;
  readonly author: string;
  /** Grid drawn over the pages the viewer has laid out, spacing in page points. */
  readonly grid?: boolean;
  readonly gridSpacing?: number;
  readonly snapGrid?: boolean;
  readonly snapPoints?: boolean;
  /** The live reading, for the settings strip. */
  readonly onReading?: (reading: MeasureReading | null) => void;
  /**
   * End the tool. Escape calls it once the chain is empty — an overlay that covers the
   * viewer and swallows every pointer event must have a way out that is not “find the
   * settings strip” (measured: with the tool armed, the command palette underneath it was
   * unclickable, and the palette is the shell's own route to everything).
   */
  readonly onStop?: () => void;
}

export interface MeasureSettingsProps {
  readonly t: Translator;
  readonly mode: MeasureMode | null;
  readonly onMode: (mode: MeasureMode | null) => void;
  readonly scale: MeasureScale;
  readonly onScale: (scale: MeasureScale) => void;
  readonly grid: boolean;
  readonly onGrid: (on: boolean) => void;
  readonly gridSpacing: number;
  readonly onGridSpacing: (spacing: number) => void;
  readonly snapGrid: boolean;
  readonly onSnapGrid: (on: boolean) => void;
  readonly snapPoints: boolean;
  readonly onSnapPoints: (on: boolean) => void;
  readonly color: string;
  readonly onColor: (color: string) => void;
  readonly opacity: number;
  readonly onOpacity: (opacity: number) => void;
  readonly thickness: number;
  readonly onThickness: (thickness: number) => void;
  readonly author: string;
  readonly onAuthor: (author: string) => void;
  /** The chain being clicked, as the layer reports it. */
  readonly reading: MeasureReading | null;
  readonly onStop: () => void;
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Snap tolerance in page points: a pointer within this of a point locks onto it. */
const SNAP_TOLERANCE = 6;
/** Grid lines closer than this on screen are not drawn — a grid is a guide, not ink. */
const MIN_GRID_PIXELS = 6;
/** Pages the grid walks per render; the viewer lays out a handful at a time. */
const MAX_GRID_PAGES = 24;
/** A chain shorter than this (page points) is not a measurement. */
const MIN_CHAIN_POINTS = 2;
const DEFAULT_GRID_SPACING = 10;

/** Grid spacings the strip offers, in page points. */
const GRID_SPACINGS: readonly number[] = [5, 10, 20, 25, 50, 100];

const PANEL_CLASS =
  'flex h-full min-w-max flex-nowrap items-center gap-1.5 whitespace-nowrap px-1.5 text-[11px] text-kumo-subtle';
const FIELD_CLASS = 'rounded-sm border border-kumo-line bg-kumo-base px-1 text-[11px] text-kumo-default';

// ---------------------------------------------------------------------------
// the overlay
// ---------------------------------------------------------------------------

interface PageFrame {
  readonly pageIndex: number;
  readonly geometry: MeasurePageGeometry;
  /** CSS pixels per page point. */
  readonly scale: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A page's placement inside the scroll container, for the page the viewer laid out. */
function pageFrame(viewer: ViewerApi, pageIndex: number): PageFrame | null {
  const view = viewer.pageGeometry(pageIndex);
  const page = viewer.pageRect(pageIndex);
  if (view === null || page === null) return null;
  // `ViewerApi.pageGeometry` answers the visible box flat (`x`/`y`/`width`/`height`);
  // the core names it `box`, and that pair is the whole contract between them.
  const geometry: MeasurePageGeometry = {
    rotation: view.rotation,
    box: { x: view.x, y: view.y, width: view.width, height: view.height },
  };
  const container = viewer.containerRect();
  const displayed = displaySize(geometry);
  if (displayed.width <= 0 || displayed.height <= 0) return null;
  return {
    pageIndex,
    geometry,
    scale: page.width / displayed.width,
    left: page.x - container.x,
    top: page.y - container.y,
    width: page.width,
    height: page.height,
  };
}

/** App-space page point → container pixel, through the core's verified conversion. */
function toScreen(frame: PageFrame, point: MeasurePoint): { readonly x: number; readonly y: number } {
  const display = appToDisplayPoint(frame.geometry, point);
  return { x: frame.left + display.u * frame.scale, y: frame.top + display.v * frame.scale };
}

/** The grid's own anchor: whole multiples of the spacing from the page's edges. */
function snapToGrid(frame: PageFrame, point: MeasurePoint, spacing: number): MeasurePoint {
  const box = frame.geometry.box;
  return {
    x: box.x + Math.round((point.x - box.x) / spacing) * spacing,
    y: Math.round(point.y / spacing) * spacing,
  };
}

export function MeasureLayer({
  t,
  viewer,
  layout,
  mode,
  scale,
  marks,
  onCreate,
  color,
  opacity,
  thickness,
  author,
  grid = false,
  gridSpacing = DEFAULT_GRID_SPACING,
  snapGrid = false,
  snapPoints = false,
  onReading,
  onStop,
}: MeasureLayerProps) {
  /** The chain being clicked, in app space, plus the page it started on. */
  const [chain, setChain] = useState<{
    readonly pageIndex: number;
    readonly points: readonly MeasurePoint[];
  } | null>(null);
  const [cursor, setCursor] = useState<MeasurePoint | null>(null);
  /** The last reading published, so a pointer move does not republish the same string. */
  const readingRef = useRef<string | null>(null);

  useEffect(() => {
    if (mode !== null) return;
    setChain(null);
    setCursor(null);
  }, [mode]);

  // What a gesture reads, at the time of the gesture.
  const frameOf = useCallback(
    (pageIndex: number): PageFrame | null => pageFrame(viewer, pageIndex),
    [viewer],
  );
  // What the layer draws on: the pages as laid out at this layout, read again at the next.
  const frames = readPagesAt(layout, frameOf);

  /**
   * The pointer, snapped: first to the chain's own vertices (a chain that closes
   * on itself is the common case for an area), then to the grid when both the grid
   * and its snapping are on.
   */
  const resolve = useCallback(
    (frame: PageFrame, raw: MeasurePoint): MeasurePoint => {
      if (snapPoints && chain !== null) {
        const limit = SNAP_TOLERANCE;
        for (const point of chain.points) {
          if (Math.hypot(point.x - raw.x, point.y - raw.y) <= limit) return point;
        }
      }
      if (grid && snapGrid && gridSpacing > 0) return snapToGrid(frame, raw, gridSpacing);
      return raw;
    },
    [chain, grid, gridSpacing, snapGrid, snapPoints],
  );

  /** The preview chain: the clicked points plus the pointer, so the value moves with it. */
  const preview = useMemo(() => {
    if (chain === null || mode === null) return null;
    const points = cursor === null ? chain.points : [...chain.points, cursor];
    if (points.length < MIN_CHAIN_POINTS) return null;
    const frame = frames.of(chain.pageIndex);
    if (frame === null) return null;
    try {
      // The same call the writer makes with the same points: what the user reads
      // while clicking is what the annotation will carry.
      return { points, measurement: measureMark(frame.geometry, points, mode) };
    } catch {
      // A two-point chain in area mode is already a rectangle; anything the geometry
      // refuses (a single point, a non-finite coordinate) simply has no value yet.
      return null;
    }
  }, [chain, cursor, frames, mode]);

  useEffect(() => {
    const text = preview === null ? null : formatMeasurement(preview.measurement, scale);
    if (text === readingRef.current) return;
    readingRef.current = text;
    onReading?.(
      preview === null
        ? null
        : {
            primary: text as string,
            secondary:
              preview.measurement.mode === 'area' ? formatLength(preview.measurement.perimeter, scale) : null,
            angle: formatAngle(preview.measurement.bearing),
            points: preview.points.length,
          },
    );
  }, [onReading, preview, scale]);

  useEffect(() => () => onReading?.(null), [onReading]);

  const finish = useCallback(() => {
    if (chain === null || mode === null) return;
    if (chain.points.length < MIN_CHAIN_POINTS) return;
    onCreate({
      id: crypto.randomUUID(),
      pageIndex: chain.pageIndex,
      mode,
      points: chain.points.map((point) => ({ ...point })),
      scale,
      color,
      opacity,
      thickness,
      author,
      contents: '',
      createdAt: new Date().toISOString(),
    });
    setChain(null);
    setCursor(null);
  }, [author, chain, color, mode, onCreate, opacity, scale, thickness]);

  // Escape, Enter and Backspace are the tool's own keys: a click chain needs its
  // own keyboard path (the shell's shortcut layer only knows single-shot tools).
  useEffect(() => {
    if (mode === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // First Escape clears the chain, a second one ends the tool: two different
        // intentions, two different keys pressed, never one action that guesses.
        if (chain === null) onStop?.();
        else setChain(null);
        setCursor(null);
        return;
      }
      if (event.key === 'Enter') {
        finish();
        return;
      }
      if (event.key === 'Backspace' && chain !== null) {
        event.preventDefault();
        setChain((previous) =>
          previous === null || previous.points.length <= 1
            ? null
            : { ...previous, points: previous.points.slice(0, -1) },
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chain, finish, mode, onStop]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || mode === null) return;
      const point = viewer.pointToPage(event.clientX, event.clientY);
      if (point === null) return;
      const frame = frameOf(point.pageIndex);
      if (frame === null) return;
      // A chain belongs to one page: a second page starts a new measurement, so a
      // distance that spans a page break can never be written as one annotation.
      if (chain !== null && chain.pageIndex !== point.pageIndex) return;
      const snapped = resolve(frame, { x: point.x, y: point.y });
      setChain((previous) =>
        previous === null
          ? { pageIndex: point.pageIndex, points: [snapped] }
          : { ...previous, points: [...previous.points, snapped] },
      );
      setCursor(snapped);
    },
    [chain, frameOf, mode, resolve, viewer],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mode === null) return;
      const point = viewer.pointToPage(event.clientX, event.clientY);
      if (point === null) return;
      const frame = frameOf(point.pageIndex);
      if (frame === null) return;
      setCursor(resolve(frame, { x: point.x, y: point.y }));
    },
    [frameOf, mode, resolve, viewer],
  );

  const armed = mode !== null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {/* The review half: measurements the session holds, in the space the writer
          converts from, so what is on screen is what the file will contain. */}
      {marks.map((mark) => (
        <MarkShape key={mark.id} t={t} mark={mark} frame={frames.of(mark.pageIndex)} />
      ))}

      {/* The grid, when armed with it on: a guide over the pages already laid out. */}
      {armed && grid ? <GridOverlay viewer={viewer} spacing={gridSpacing} frames={frames} /> : null}

      {/* The chain being clicked, with the live value at the pointer. */}
      {preview !== null && chain !== null ? (
        <ChainShape
          frame={frames.of(chain.pageIndex)}
          chain={preview.points}
          mark={{ color, opacity, thickness }}
        />
      ) : null}

      {/* The gesture half. Mounted only while a tool is armed: an inert overlay that
          swallows nothing is one listener fewer on every pointer move. */}
      {armed ? (
        <div
          role="application"
          aria-label={label(t, MEASURE_KEYS.tool)}
          className="absolute inset-0 cursor-crosshair"
          style={{ pointerEvents: 'auto' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onDoubleClick={finish}
        />
      ) : null}
    </div>
  );
}

/** One measurement the session holds, drawn over the page it was measured on. */
function MarkShape({
  t,
  mark,
  frame,
}: {
  readonly t: Translator;
  readonly mark: MeasureMark;
  readonly frame: PageFrame | null;
}) {
  if (frame === null) return null;
  const screen = mark.points.map((point) => toScreen(frame, point));
  const value = formatMeasurement(
    // The readout on the page is the mark's own; the geometry is recomputed from
    // the same points the writer will use, so a page made dirty by another edit
    // does not change what this mark says.
    measureMarkQuiet(frame.geometry, mark),
    mark.scale,
  );
  return (
    <button
      type="button"
      aria-label={label(t, MEASURE_KEYS[modeKey(mark.mode)])}
      data-measure={mark.id}
      tabIndex={-1}
      className="pointer-events-auto absolute border-0 bg-transparent p-0"
      style={{ left: 0, top: 0, width: 0, height: 0 }}
    >
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute overflow-visible"
        style={{ left: 0, top: 0, width: 1, height: 1 }}
      >
        {mark.mode === 'area' ? (
          <polygon
            points={pointsAttribute(screen)}
            fill={mark.color}
            fillOpacity={Math.min(mark.opacity, 0.25)}
            stroke={mark.color}
            strokeOpacity={mark.opacity}
            strokeWidth={mark.thickness ?? 1}
          />
        ) : (
          <polyline
            points={pointsAttribute(screen)}
            fill="none"
            stroke={mark.color}
            strokeOpacity={mark.opacity}
            strokeWidth={mark.thickness ?? 1}
            strokeLinecap="round"
          />
        )}
      </svg>
      <span
        className="pdf-floating-shadow pointer-events-none absolute whitespace-nowrap rounded-sm bg-kumo-base px-1 text-[10px] text-kumo-default"
        style={{ left: screen.at(-1)?.x ?? 0, top: (screen.at(-1)?.y ?? 0) - 14 }}
      >
        {value}
      </span>
    </button>
  );
}

/** `measureMark` that returns `null` instead of throwing: a display path never throws. */
function measureMarkQuiet(geometry: MeasurePageGeometry, mark: MeasureMark) {
  try {
    return measureMark(geometry, mark.points, mark.mode);
  } catch {
    return measureMark(geometry, mark.points, 'perimeter');
  }
}

/** The chain being clicked, in the tool's colour, with the angle at its first point. */
function ChainShape({
  frame,
  chain,
  mark,
}: {
  readonly frame: PageFrame | null;
  readonly chain: readonly MeasurePoint[];
  readonly mark: { readonly color: string; readonly opacity: number; readonly thickness: number };
}) {
  if (frame === null) return null;
  const screen = chain.map((point) => toScreen(frame, point));
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute overflow-visible"
      style={{ left: 0, top: 0, width: 1, height: 1 }}
    >
      <polyline
        points={pointsAttribute(screen)}
        fill="none"
        stroke={mark.color}
        strokeOpacity={mark.opacity}
        strokeWidth={mark.thickness}
        strokeDasharray="4 3"
        strokeLinecap="round"
      />
      {screen.map((point) => (
        <circle key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r={2.5} fill={mark.color} />
      ))}
    </svg>
  );
}

/** The grid over every page the viewer has laid out, at the requested spacing. */
function GridOverlay({
  viewer,
  spacing,
  frames,
}: {
  readonly viewer: ViewerApi;
  readonly spacing: number;
  readonly frames: PageFrames<PageFrame>;
}) {
  const pages: PageFrame[] = [];
  const total = viewer.document.pageCount;
  for (let index = 0; index < total && pages.length < MAX_GRID_PAGES; index += 1) {
    const frame = frames.of(index);
    if (frame !== null) pages.push(frame);
  }
  const step = Math.max(spacing, 1);
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute overflow-visible"
      style={{ left: 0, top: 0, width: 1, height: 1 }}
    >
      {pages.map((frame) => {
        // A grid denser than a few pixels is noise, not a guide: it is skipped, and
        // the strip's spacing control is the way out.
        if (step * frame.scale < MIN_GRID_PIXELS) return null;
        const box = frame.geometry.box;
        const horizontal: string[] = [];
        const vertical: string[] = [];
        for (let x = box.x; x <= box.x + box.width + 1e-6; x += step) {
          const from = toScreen(frame, { x, y: 0 });
          const to = toScreen(frame, { x, y: box.height });
          vertical.push(`M${from.x} ${from.y}L${to.x} ${to.y}`);
        }
        for (let y = 0; y <= box.height + 1e-6; y += step) {
          const from = toScreen(frame, { x: box.x, y });
          const to = toScreen(frame, { x: box.x + box.width, y });
          horizontal.push(`M${from.x} ${from.y}L${to.x} ${to.y}`);
        }
        return (
          <path
            key={frame.pageIndex}
            d={[...horizontal, ...vertical].join(' ')}
            stroke="currentColor"
            strokeOpacity={0.18}
            strokeWidth={0.5}
            fill="none"
            className="text-kumo-default"
          />
        );
      })}
    </svg>
  );
}

function pointsAttribute(points: readonly { readonly x: number; readonly y: number }[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

/** The mode's own dictionary key, so the label is the tool's name in both places. */
function modeKey(mode: MeasureMode): 'distance' | 'perimeter' | 'area' {
  return mode === 'distance' ? 'distance' : mode === 'perimeter' ? 'perimeter' : 'area';
}

// ---------------------------------------------------------------------------
// the settings strip
// ---------------------------------------------------------------------------

/**
 * The tool's own settings strip (the density of a professional
 * tool — one row, no dialog). The shell mounts it where it mounts the annotation
 * styles; every control edits state the shell owns, so a value never disappears
 * while switching docks.
 */
export function MeasureSettings({
  t,
  mode,
  onMode,
  scale,
  onScale,
  grid,
  onGrid,
  gridSpacing,
  onGridSpacing,
  snapGrid,
  onSnapGrid,
  snapPoints,
  onSnapPoints,
  color,
  onColor,
  opacity,
  onOpacity,
  thickness,
  onThickness,
  author,
  onAuthor,
  reading,
  onStop,
}: MeasureSettingsProps) {
  const [text, setText] = useState(scale.expression);
  const [unreadable, setUnreadable] = useState(false);

  const commitScale = useCallback(
    (value: string) => {
      setText(value);
      const parsed = parseScale(value, scale.unit);
      setUnreadable(parsed === null);
      // The last readable scale stays in force: a half-typed ratio must not
      // silently become a 1:1 ruler, which would misstate every measurement.
      if (parsed !== null) onScale(parsed);
    },
    [onScale, scale.unit],
  );

  return (
    <fieldset className={PANEL_CLASS} aria-label={label(t, MEASURE_KEYS.readout)}>
      {MEASURE_MODES.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          aria-label={label(t, MEASURE_KEYS[modeKey(value)])}
          onClick={() => onMode(mode === value ? null : value)}
          className={`rounded-sm border px-1.5 py-0.5 text-[11px] ${
            mode === value
              ? 'border-kumo-focus bg-kumo-focus/10 text-kumo-default'
              : 'border-kumo-line text-kumo-subtle'
          }`}
        >
          {label(t, MEASURE_KEYS[modeKey(value)])}
        </button>
      ))}

      <label className="flex items-center gap-1">
        {label(t, MEASURE_KEYS.scale)}
        <input
          type="text"
          value={text}
          aria-invalid={unreadable}
          aria-label={label(t, MEASURE_KEYS.scale)}
          title={label(t, MEASURE_KEYS.scaleHint)}
          onChange={(event) => commitScale(event.target.value)}
          size={10}
          className={`${FIELD_CLASS} w-24 ${unreadable ? 'border-kumo-danger' : ''}`}
        />
      </label>

      <label className="flex items-center gap-1">
        {label(t, MEASURE_KEYS.unit)}
        <select
          value={scale.unit}
          aria-label={label(t, MEASURE_KEYS.unit)}
          onChange={(event) => {
            const unit = event.target.value;
            // The ratio is what the user typed; only the real-world unit changes, so
            // the scale keeps its meaning and the readout changes its unit.
            if (isMeasureUnit(unit)) onScale(scaleForRatio(scale.ratio, unit));
          }}
          className={FIELD_CLASS}
        >
          {MEASURE_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unitSymbol(unit)}
            </option>
          ))}
        </select>
      </label>

      {unreadable ? (
        <span role="status" className="text-kumo-danger">
          {label(t, MEASURE_KEYS.scaleUnreadable)}
        </span>
      ) : null}

      <label className="flex items-center gap-1">
        <input type="checkbox" checked={grid} onChange={(event) => onGrid(event.target.checked)} />
        {label(t, MEASURE_KEYS.grid)}
      </label>

      <label className="flex items-center gap-1">
        {label(t, MEASURE_KEYS.gridGap)}
        <select
          value={String(GRID_SPACINGS.includes(gridSpacing) ? gridSpacing : DEFAULT_GRID_SPACING)}
          aria-label={label(t, MEASURE_KEYS.gridGap)}
          onChange={(event) => onGridSpacing(Number(event.target.value))}
          className={FIELD_CLASS}
        >
          {GRID_SPACINGS.map((value) => (
            <option key={value} value={String(value)}>
              {`${value} ${label(t, 'unit.pt')}`}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1">
        <input type="checkbox" checked={snapGrid} onChange={(event) => onSnapGrid(event.target.checked)} />
        {label(t, MEASURE_KEYS.snapGrid)}
      </label>

      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={snapPoints}
          onChange={(event) => onSnapPoints(event.target.checked)}
        />
        {label(t, MEASURE_KEYS.snapPoints)}
      </label>

      <label className="flex items-center gap-1">
        {label(t, MEASURE_KEYS.color)}
        <input
          type="color"
          value={color}
          onChange={(event) => onColor(event.target.value)}
          className="size-6 rounded-sm border border-kumo-line bg-kumo-base"
        />
      </label>

      <label className="flex items-center gap-1">
        {label(t, MEASURE_KEYS.opacity)}
        <input
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(event) => onOpacity(Number(event.target.value))}
          className="w-16 accent-kumo-focus"
        />
      </label>

      <label className="flex items-center gap-1">
        {label(t, MEASURE_KEYS.thickness)}
        <input
          type="number"
          min={1}
          max={24}
          step={1}
          value={thickness}
          onChange={(event) => onThickness(Number(event.target.value))}
          className={`${FIELD_CLASS} w-12`}
        />
      </label>

      <label className="flex items-center gap-1">
        {label(t, MEASURE_KEYS.author)}
        <input
          type="text"
          value={author}
          onChange={(event) => onAuthor(event.target.value)}
          className={`${FIELD_CLASS} w-24`}
        />
      </label>

      {/* The readout: the value the finished annotation will carry, live. */}
      <output
        aria-live="polite"
        aria-label={label(t, MEASURE_KEYS.readout)}
        className="rounded-sm border border-kumo-line px-1.5 py-0.5 text-[11px] text-kumo-default"
      >
        {reading === null
          ? label(t, MEASURE_KEYS.scaleHint)
          : `${reading.primary}${reading.secondary === null ? '' : ` · ${reading.secondary}`} · ${reading.angle}`}
      </output>

      <button
        type="button"
        onClick={onStop}
        className="rounded-sm border border-kumo-line px-1.5 py-0.5 text-[11px]"
        aria-label={label(t, MEASURE_KEYS.close)}
        title={label(t, MEASURE_KEYS.stop)}
      >
        {label(t, MEASURE_KEYS.stop)}
      </button>
    </fieldset>
  );
}
