import type { Icon } from '@phosphor-icons/react';
import {
  ChatCenteredText,
  Cursor,
  EyeSlash,
  HandPalm,
  Highlighter,
  LinkSimple,
  PenNib,
  Ruler,
  Shapes,
  TextAa,
  TextT,
} from '@phosphor-icons/react';
import type { MessageKey, Translator } from 'pdf-shared';
import type { CanvasToolId } from 'pdf-ui/tools';
import { Tooltip } from 'pdf-ui/ui';
import { Fragment } from 'react';

/**
 * The tool rail: **every** canvas tool, in one column beside the document.
 *
 * Two things changed against the floating seven-button rail it replaces, and both were
 * measured defects rather than taste:
 *
 * - It sits **in the layout**, not over the sheet. Floating at the viewer's left edge it
 *   covered the page's own text below 1024 px and took presses meant for the page.
 * - It shows every tool the menus can arm. Underline, strike-through, measure, link and
 *   redaction were menu-only, so arming one from a menu left no pressed button anywhere
 *   and the user could not see which tool owned the pointer.
 *
 * The four text-markup kinds share one button: they are one gesture (select text,
 * release) with four looks, so the strip under the header picks the look and the button
 * is pressed for any of them. Pressing it arms the look used last.
 */

/** The four looks the markup button stands for. */
export const MARKUP_TOOLS = ['highlight', 'underline', 'strikeout', 'squiggly'] as const;
export type MarkupTool = (typeof MARKUP_TOOLS)[number];

export function isMarkupTool(tool: CanvasToolId): tool is MarkupTool {
  return (MARKUP_TOOLS as readonly string[]).includes(tool);
}

/** One rail button: the tool it arms (or the markup group), its icon and its name. */
interface RailSpec {
  readonly id: CanvasToolId | 'markup';
  readonly icon: Icon;
  readonly labelKey: MessageKey;
  /** Writes to the document, so it is disabled without an editable one. */
  readonly mutating: boolean;
  /** Opens a new group: a hairline above it. */
  readonly startsGroup?: boolean;
}

/** The rail, in order. The table is the single source of that order and of the groups. */
const RAIL: readonly RailSpec[] = [
  { id: 'select', icon: Cursor, labelKey: 'toolbar.select', mutating: false },
  { id: 'hand', icon: HandPalm, labelKey: 'toolbar.hand', mutating: false },
  { id: 'text', icon: TextT, labelKey: 'toolbar.text', mutating: true, startsGroup: true },
  { id: 'freetext', icon: TextAa, labelKey: 'toolbar.freetext', mutating: true },
  { id: 'markup', icon: Highlighter, labelKey: 'toolbar.markup', mutating: true, startsGroup: true },
  { id: 'ink', icon: PenNib, labelKey: 'ann.tool.ink', mutating: true },
  { id: 'shapes', icon: Shapes, labelKey: 'toolbar.shape', mutating: true },
  { id: 'note', icon: ChatCenteredText, labelKey: 'toolbar.comment', mutating: true },
  { id: 'link', icon: LinkSimple, labelKey: 'link.tool', mutating: true },
  { id: 'measure', icon: Ruler, labelKey: 'toolbar.measure', mutating: true, startsGroup: true },
  { id: 'redact', icon: EyeSlash, labelKey: 'toolbar.redact', mutating: true },
];

export interface ToolRailProps {
  readonly t: Translator;
  /** The armed tool — the shell's one `CanvasToolId`. */
  readonly activeTool: CanvasToolId;
  /** The markup look the markup button arms: the one used last. */
  readonly markupTool: MarkupTool;
  readonly onSelectTool: (tool: CanvasToolId) => void;
  /** Mutating tools are disabled without an editable document; select and hand never are. */
  readonly canEdit: boolean;
}

/**
 * One button, one state. Armed is a filled brand chip with a hairline of its own ink
 * inside the edge — the rail's only filled element, so "which tool is live" is readable
 * at a glance rather than inferred from a slightly lighter background.
 */
const BUTTON_CLASS =
  'flex size-9 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-kumo-focus disabled:cursor-not-allowed disabled:opacity-40';
const ARMED_CLASS = 'bg-pdf-accent text-pdf-on-accent ring-1 ring-inset ring-pdf-on-accent/30';
const IDLE_CLASS = 'text-kumo-default hover:bg-kumo-recessed hover:text-kumo-strong';

export function ToolRail({ t, activeTool, markupTool, onSelectTool, canEdit }: ToolRailProps) {
  return (
    <nav
      aria-label={t('tools.all')}
      className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain border-r border-kumo-line bg-kumo-base py-2 select-none"
    >
      {RAIL.map((spec) => {
        const armed = spec.id === 'markup' ? isMarkupTool(activeTool) : activeTool === spec.id;
        const label = t(spec.labelKey);
        const Glyph = spec.icon;
        return (
          <Fragment key={spec.id}>
            {spec.startsGroup === true ? (
              <span aria-hidden="true" className="my-1 h-px w-7 shrink-0 bg-kumo-line" />
            ) : null}
            <Tooltip label={label} side="right">
              <button
                type="button"
                aria-label={label}
                aria-pressed={armed}
                disabled={spec.mutating && !canEdit}
                onClick={() => {
                  // A second press on the armed tool puts the pointer back in select,
                  // the same toggle the menus and the palette offer.
                  const target = spec.id === 'markup' ? markupTool : spec.id;
                  onSelectTool(armed && spec.id !== 'select' ? 'select' : target);
                }}
                className={`${BUTTON_CLASS} ${armed ? ARMED_CLASS : IDLE_CLASS}`}
              >
                <Glyph size={18} weight={armed ? 'fill' : 'regular'} aria-hidden="true" />
              </button>
            </Tooltip>
          </Fragment>
        );
      })}
    </nav>
  );
}
