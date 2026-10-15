/**
 * The look each annotation tool draws with, and how it is remembered between visits.
 *
 * Every tool has its own style: a ruler, a highlighter and a pen are different marks, and
 * choosing the pen's colour must not repaint the marker. The styles persist in `localStorage`
 * like the interface mode (`interface-mode.ts`): a blocked or full store costs the memory, never
 * the application, and a stored value that is not valid for its field falls back to the default.
 */

/** The tools that carry a style of their own. */
export const STYLED_TOOLS = [
  'highlight',
  'underline',
  'strikeout',
  'squiggly',
  'ink',
  'shapes',
  'note',
  'freetext',
  'measure',
] as const;

export type StyledTool = (typeof STYLED_TOOLS)[number];

export interface ToolStyle {
  /** The mark's colour; for typed text, the text's colour. */
  readonly color: string;
  readonly opacity: number;
  /** Stroke width in page points. */
  readonly thickness: number;
  /** Typed text size in points. */
  readonly fontSize: number;
}

export type ToolStyles = Readonly<Record<StyledTool, ToolStyle>>;

const MARKER: ToolStyle = { color: '#ffd400', opacity: 0.4, thickness: 2, fontSize: 12 };
const SOLID: ToolStyle = { ...MARKER, opacity: 1 };

/** The styles a first visit starts with: translucent marker, solid ink and shapes, black text. */
export function defaultToolStyles(): ToolStyles {
  return {
    highlight: MARKER,
    underline: { ...SOLID, color: '#1d4ed8' },
    strikeout: { ...SOLID, color: '#dc2626' },
    squiggly: { ...SOLID, color: '#dc2626' },
    ink: { ...SOLID, color: '#1f2937' },
    shapes: { ...SOLID, color: '#dc2626' },
    note: SOLID,
    freetext: { ...SOLID, color: '#000000' },
    measure: MARKER,
  };
}

/** The tool's own style, or the marker's for a tool that has none (its controls are not shown). */
export function styledToolOf(tool: string): StyledTool {
  return (STYLED_TOOLS as readonly string[]).includes(tool) ? (tool as StyledTool) : 'highlight';
}

const STORAGE_KEY = 'pdf_editor_annotation_styles_v1';

/** One tool's stored style over its default, field by field: a field outside the bounds the controls clamp to is not one the user chose. */
function readStyle(defaults: ToolStyle, stored: unknown): ToolStyle {
  const own = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, unknown>;
  const number = (key: 'opacity' | 'thickness' | 'fontSize', min: number, max: number): number => {
    const value = own[key];
    return typeof value === 'number' && value >= min && value <= max ? value : defaults[key];
  };
  return {
    color: typeof own.color === 'string' && /^#[0-9a-f]{6}$/i.test(own.color) ? own.color : defaults.color,
    opacity: number('opacity', 0.1, 1),
    thickness: number('thickness', 1, 20),
    fontSize: number('fontSize', 6, 72),
  };
}

/** The stored styles laid over the defaults; a missing or invalid field keeps its default. */
export function readStoredStyles(): ToolStyles {
  const defaults = defaultToolStyles();
  try {
    const stored = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY) ?? 'null') as Record<
      string,
      unknown
    > | null;
    return Object.fromEntries(
      STYLED_TOOLS.map((tool) => [tool, readStyle(defaults[tool], stored?.[tool])]),
    ) as ToolStyles;
  } catch {
    // A blocked store or text that is not JSON costs the remembered styles, not the application.
    return defaults;
  }
}

/** Persist the styles. */
export function storeStyles(styles: ToolStyles): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(styles));
  } catch {
    // The session keeps the styles in memory; only persistence is lost.
  }
}
