/**
 * The active canvas tool's property strip — one row, no dialog (`PLAN.md §4.3`).
 *
 * The shell owns the settings and mounts this strip outside the scroll-clipped
 * viewer, so the values a tool is about to use never disappear while switching
 * docks. It shows **only the properties the armed tool actually has**, because a
 * control that cannot reach the engine is worse than no control:
 *
 * - Highlight carries colour, thickness and the shared opacity: the marks this app
 *   creates are drawn by the controlled creators, which take all three, so the row
 *   is the truth for every tool that paints a fill or a stroke.
 * - Note carries the icon colour and the author that the writer puts in `/T`.
 * - Shapes choose their geometry here.
 * - Typed text ("Metin ekle") carries its own colour and size: it is ink on the page,
 *   not a translucent mark, so the marker's colour and opacity would be the wrong truth.
 * - The four text-markup looks share one rail button, and the look is picked here.
 * - Measure keeps its own strip (scale, unit, grid, calibration) in `MeasureLayer`; the
 *   shell shows that strip in this same row instead of this one.
 * - Redaction shows how many areas are marked and the explicit Apply — marking is not
 *   erasing, and the strip says which of the two the next press does.
 * - Every tool opens with one sentence saying what the pointer does now.
 * - The shared selection shows its count and every action the shell exposes for it:
 *   delete, rotate 90°, four directional moves and clear. They are the same intents
 *   the canvas drag, the `Delete` key and a panel row route through, so the strip can
 *   never offer an edit the rest of the app cannot make.
 *
 * Text, links and the hand tool carry no mark properties at all: their rows stay
 * empty rather than showing a control that would do nothing.
 */

import type { Icon } from '@phosphor-icons/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import { Tooltip } from '../components/Tooltip';

/** The canvas tools the shell can arm (`ToolChrome`'s buttons plus the menus). */
export type CanvasToolId =
  | 'select'
  | 'hand'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'ink'
  | 'shapes'
  | 'note'
  | 'redact'
  | 'measure'
  | 'link'
  | 'text'
  | 'freetext';

/** The shape kinds the shape tool draws; the writer maps each to its own appearance. */
export type CanvasShapeKind = 'square' | 'circle' | 'line';

export interface ToolPropertiesProps {
  readonly t: Translator;
  /** The single canonical active tool — never a second, stale copy of it. */
  readonly tool: CanvasToolId;
  readonly color: string;
  readonly opacity: number;
  readonly thickness: number;
  readonly author: string;
  readonly shape: CanvasShapeKind;
  /** Typed text: its colour and its size in points. */
  readonly textColor?: string;
  readonly fontSize?: number;
  readonly onTextColor?: (color: string) => void;
  readonly onFontSize?: (size: number) => void;
  /** Pending redaction areas, and the explicit step that erases them. */
  readonly redactionCount?: number;
  readonly onApplyRedaction?: () => void;
  /** Marks in the shared selection, across every family. */
  readonly selectedCount: number;
  readonly disabled?: boolean;
  readonly onColor: (color: string) => void;
  readonly onOpacity: (opacity: number) => void;
  readonly onThickness: (thickness: number) => void;
  readonly onAuthor: (author: string) => void;
  readonly onShape: (shape: CanvasShapeKind) => void;
  /** Picks another text-markup look; only offered while one of the four is armed. */
  readonly onTool?: (tool: CanvasToolId) => void;
  /** Removes the whole selection as one journalled step. */
  readonly onDeleteSelection?: () => void;
  /** Turns every selected mark 90° clockwise about its own centre. */
  readonly onRotateSelection?: () => void;
  /** Nudges the whole selection by `dx`/`dy` page points, as one journalled step. */
  readonly onMoveSelection?: (dx: number, dy: number) => void;
  readonly onClearSelection?: () => void;
}

/** Typed text size bounds, in points (the writer clamps to the same range). */
export const FONT_SIZE_MIN = 6;
export const FONT_SIZE_MAX = 72;

/** The four text-markup looks the one rail button stands for. */
const MARKUP_LOOKS = [
  { tool: 'highlight', key: 'ann.kind.highlight' },
  { tool: 'underline', key: 'ann.kind.underline' },
  { tool: 'strikeout', key: 'ann.kind.strikeout' },
  { tool: 'squiggly', key: 'ann.kind.squiggly' },
] as const satisfies readonly { readonly tool: CanvasToolId; readonly key: MessageKey }[];

/** What the pointer does now, one sentence per tool; measure has its own strip. */
const TOOL_HINTS: Readonly<Partial<Record<CanvasToolId, MessageKey>>> = {
  select: 'tool.hint.select',
  hand: 'tool.hint.hand',
  text: 'tool.hint.text',
  freetext: 'tool.hint.freetext',
  highlight: 'tool.hint.highlight',
  underline: 'tool.hint.markup',
  strikeout: 'tool.hint.markup',
  squiggly: 'tool.hint.markup',
  ink: 'tool.hint.ink',
  shapes: 'tool.hint.shapes',
  note: 'tool.hint.note',
  link: 'tool.hint.link',
  redact: 'tool.hint.redact',
};

/** Stroke width bounds, in page points. */
export const THICKNESS_MIN = 1;
export const THICKNESS_MAX = 20;

/** Fill/stroke opacity bounds, as the fraction the engine's drawing options take. */
export const OPACITY_MIN = 0.1;
export const OPACITY_MAX = 1;

const OPACITY_STEP = 0.05;

/** How far one press of a directional move button carries the selection, in page points. */
const NUDGE_POINTS = 5;

const PANEL_CLASS =
  'flex h-full min-w-max flex-nowrap items-center gap-1.5 whitespace-nowrap px-1.5 text-[11px] text-kumo-subtle';
const FIELD_CLASS = 'rounded-sm border border-kumo-line bg-kumo-base px-1 text-[11px] text-kumo-default';
const READOUT_CLASS =
  'rounded-sm border border-kumo-line px-1.5 py-0.5 text-[11px] tabular-nums text-kumo-default';
const BUTTON_CLASS =
  'rounded-sm border border-kumo-line px-1.5 py-0.5 text-[11px] text-kumo-default hover:bg-kumo-tint';
/** A button whose whole label is its icon: square, so the four arrows read as one group. */
const ICON_BUTTON_CLASS =
  'flex size-5 items-center justify-center rounded-sm border border-kumo-line text-kumo-default hover:bg-kumo-tint';

/** Which properties the armed tool actually carries. */
interface ToolStyleSpec {
  readonly color: boolean;
  readonly opacity: boolean;
  readonly thickness: boolean;
  readonly author: boolean;
  readonly shape: boolean;
}

const NO_STYLE: ToolStyleSpec = {
  color: false,
  opacity: false,
  thickness: false,
  author: false,
  shape: false,
};

const STROKE_STYLE: ToolStyleSpec = {
  color: true,
  opacity: true,
  thickness: true,
  author: true,
  shape: false,
};

const SHAPE_ORDER: readonly CanvasShapeKind[] = ['square', 'circle', 'line'];

const SHAPE_KEYS = {
  square: 'ann.tool.shape.square',
  circle: 'ann.tool.shape.circle',
  line: 'ann.tool.shape.line',
} as const;

/**
 * The selection's four nudges, in reading order. Page space has `y` **down**, so
 * "up" carries the marks towards the page's top edge — the same direction the arrow
 * points on screen, at every page rotation, because the move is the core's own
 * transform rather than a screen offset.
 */
const NUDGES: readonly {
  readonly key: MessageKey;
  readonly icon: Icon;
  readonly dx: number;
  readonly dy: number;
}[] = [
  { key: 'ann.tool.moveUp', icon: ArrowUp, dx: 0, dy: -NUDGE_POINTS },
  { key: 'ann.tool.moveDown', icon: ArrowDown, dx: 0, dy: NUDGE_POINTS },
  { key: 'ann.tool.moveLeft', icon: ArrowLeft, dx: -NUDGE_POINTS, dy: 0 },
  { key: 'ann.tool.moveRight', icon: ArrowRight, dx: NUDGE_POINTS, dy: 0 },
];

const TOOL_STYLES: Record<CanvasToolId, ToolStyleSpec> = {
  select: NO_STYLE,
  hand: NO_STYLE,
  // Highlight was the one tool the engine's own editor owned, and that editor takes
  // a colour and a thickness and nothing else (`HighlightEditor.typesMap`). The
  // controlled creators draw it now, so the shared opacity control is its truth too.
  highlight: { color: true, opacity: true, thickness: true, author: false, shape: false },
  underline: STROKE_STYLE,
  strikeout: STROKE_STYLE,
  squiggly: STROKE_STYLE,
  ink: STROKE_STYLE,
  shapes: { ...STROKE_STYLE, shape: true },
  // A note is its icon colour plus the `/T` the writer stamps on it.
  note: { color: true, opacity: false, thickness: false, author: true, shape: false },
  redact: NO_STYLE,
  measure: NO_STYLE,
  link: NO_STYLE,
  text: NO_STYLE,
  // Typed text has its own colour and size (below), not the marker's style.
  freetext: { color: false, opacity: false, thickness: false, author: true, shape: false },
};

export function ToolProperties({
  t,
  tool,
  color,
  opacity,
  thickness,
  author,
  shape,
  textColor = '#000000',
  fontSize = 12,
  onTextColor,
  onFontSize,
  redactionCount = 0,
  onApplyRedaction,
  selectedCount,
  disabled,
  onColor,
  onOpacity,
  onThickness,
  onAuthor,
  onShape,
  onTool,
  onDeleteSelection,
  onRotateSelection,
  onMoveSelection,
  onClearSelection,
}: ToolPropertiesProps) {
  const style = TOOL_STYLES[tool];
  // The selection row is the select tool's own readout, and it follows the
  // selection everywhere else: a panel row, a marquee or a canvas click leaves marks
  // selected, and the count is how the user sees what these actions would take.
  const showSelection = selectedCount > 0 || tool === 'select';
  const hint = TOOL_HINTS[tool];
  const markup = MARKUP_LOOKS.some((look) => look.tool === tool);

  return (
    <fieldset className={PANEL_CLASS} aria-label={t('panel.toolSettings')} disabled={disabled}>
      {hint === undefined || selectedCount > 0 ? null : (
        <span className="pr-1 text-kumo-subtle">{t(hint)}</span>
      )}

      {markup && onTool !== undefined ? (
        // One group, four looks: the rail's markup button is pressed for any of them.
        <fieldset
          aria-label={t('ann.tool.markupKind')}
          className="m-0 flex items-center gap-0.5 border-0 p-0"
        >
          {MARKUP_LOOKS.map((look) => (
            <button
              key={look.tool}
              type="button"
              aria-pressed={tool === look.tool}
              onClick={() => onTool(look.tool)}
              className={`${BUTTON_CLASS} ${tool === look.tool ? 'border-kumo-focus bg-kumo-focus/10' : ''}`}
            >
              {t(look.key)}
            </button>
          ))}
        </fieldset>
      ) : null}

      {tool === 'freetext' ? (
        <>
          <label className="flex items-center gap-1">
            {t('ann.tool.color')}
            <input
              type="color"
              value={textColor}
              aria-label={t('ann.tool.color')}
              onChange={(event) => onTextColor?.(event.target.value)}
              className="size-6 rounded-sm border border-kumo-line bg-kumo-base"
            />
          </label>
          <label className="flex items-center gap-1">
            {t('ann.tool.fontSize')}
            <input
              type="number"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={fontSize}
              aria-label={t('ann.tool.fontSize')}
              onChange={(event) => {
                if (event.target.value === '') return;
                const next = Number(event.target.value);
                if (Number.isFinite(next)) {
                  onFontSize?.(Math.min(Math.max(Math.round(next), FONT_SIZE_MIN), FONT_SIZE_MAX));
                }
              }}
              className={`${FIELD_CLASS} w-12`}
            />
            <span>{t('unit.pt')}</span>
          </label>
        </>
      ) : null}

      {tool === 'redact' ? (
        <span className="flex items-center gap-1">
          <output aria-live="polite" className={READOUT_CLASS}>
            {t('tool.redact.pending', { count: redactionCount })}
          </output>
          {onApplyRedaction === undefined ? null : (
            <button
              type="button"
              disabled={redactionCount === 0}
              onClick={onApplyRedaction}
              className={`${BUTTON_CLASS} disabled:opacity-40`}
            >
              {t('tool.redact.apply')}
            </button>
          )}
        </span>
      ) : null}

      {style.color ? (
        <label className="flex items-center gap-1">
          {t('ann.tool.color')}
          <input
            type="color"
            value={color}
            aria-label={t('ann.tool.color')}
            onChange={(event) => onColor(event.target.value)}
            className="size-6 rounded-sm border border-kumo-line bg-kumo-base"
          />
        </label>
      ) : null}

      {style.opacity ? (
        <label className="flex items-center gap-1">
          {t('ann.tool.opacity')}
          <input
            type="range"
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step={OPACITY_STEP}
            value={opacity}
            aria-label={t('ann.tool.opacity')}
            onChange={(event) => onOpacity(Number(event.target.value))}
            className="w-16 accent-kumo-focus"
          />
          <output className={READOUT_CLASS}>
            {t('ann.tool.opacityValue', { value: Math.round(opacity * 100) })}
          </output>
        </label>
      ) : null}

      {style.thickness ? (
        <label className="flex items-center gap-1">
          {t('ann.tool.thickness')}
          <input
            type="number"
            min={THICKNESS_MIN}
            max={THICKNESS_MAX}
            step={1}
            value={thickness}
            aria-label={t('ann.tool.thickness')}
            onChange={(event) => {
              // An empty field is a half-typed number, not a zero: the last valid
              // thickness stays in force rather than snapping the mark to 1 pt.
              if (event.target.value === '') return;
              const next = Number(event.target.value);
              if (Number.isFinite(next)) {
                onThickness(Math.min(Math.max(Math.round(next), THICKNESS_MIN), THICKNESS_MAX));
              }
            }}
            className={`${FIELD_CLASS} w-12`}
          />
          <span>{t('unit.pt')}</span>
        </label>
      ) : null}

      {style.shape ? (
        <label className="flex items-center gap-1">
          {t('ann.tool.shape')}
          <select
            value={shape}
            aria-label={t('ann.tool.shape')}
            onChange={(event) => {
              const next = event.target.value;
              if (next === 'square' || next === 'circle' || next === 'line') onShape(next);
            }}
            className={FIELD_CLASS}
          >
            {SHAPE_ORDER.map((value) => (
              <option key={value} value={value}>
                {t(SHAPE_KEYS[value])}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {style.author ? (
        <label className="flex items-center gap-1">
          {t('ann.tool.author')}
          <input
            type="text"
            value={author}
            aria-label={t('ann.tool.author')}
            onChange={(event) => onAuthor(event.target.value)}
            className={`${FIELD_CLASS} w-24`}
          />
        </label>
      ) : null}

      {showSelection ? (
        <span className="flex items-center gap-1">
          <output aria-live="polite" aria-label={t('ann.tool.selection')} className={READOUT_CLASS}>
            {selectedCount > 0
              ? t('ann.tool.selection.count', { count: selectedCount })
              : t('ann.tool.selection.none')}
          </output>
          {selectedCount > 0 && onDeleteSelection !== undefined ? (
            <button type="button" onClick={onDeleteSelection} className={BUTTON_CLASS}>
              {t('ann.tool.deleteSelection')}
            </button>
          ) : null}
          {selectedCount > 0 && onRotateSelection !== undefined ? (
            // The tip, the accessible name and the visible label are one sentence:
            // the direction is the app's own page-rotation convention, and a chip
            // that said more than the button would only read it twice.
            <Tooltip label={t('ann.tool.rotateSelection')} side="top">
              <button
                type="button"
                aria-label={t('ann.tool.rotateSelection')}
                onClick={onRotateSelection}
                className={BUTTON_CLASS}
              >
                {t('ann.tool.rotateSelection')}
              </button>
            </Tooltip>
          ) : null}
          {selectedCount > 0 && onMoveSelection !== undefined ? (
            // One group, four arrows: a screen reader reads the group's name once and
            // the directions under it, instead of four buttons in a flat row. The
            // nested fieldset is the semantic form of `role="group"`, and it carries
            // the parent's `disabled` down with it.
            <fieldset
              aria-label={t('ann.tool.moveSelection')}
              className="m-0 flex items-center gap-0.5 border-0 p-0"
            >
              {NUDGES.map(({ key, icon: NudgeIcon, dx, dy }) => {
                const label = t(key);
                return (
                  <Tooltip key={key} label={label} side="top">
                    <button
                      type="button"
                      aria-label={label}
                      onClick={() => onMoveSelection(dx, dy)}
                      className={ICON_BUTTON_CLASS}
                    >
                      <NudgeIcon size={12} weight="bold" aria-hidden="true" />
                    </button>
                  </Tooltip>
                );
              })}
            </fieldset>
          ) : null}
          {selectedCount > 0 && onClearSelection !== undefined ? (
            <button type="button" onClick={onClearSelection} className={BUTTON_CLASS}>
              {t('ann.tool.clearSelection')}
            </button>
          ) : null}
        </span>
      ) : null}
    </fieldset>
  );
}
