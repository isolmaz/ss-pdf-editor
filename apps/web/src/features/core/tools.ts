import type { CanvasToolId } from 'pdf-ui/tools';

/** The four looks the rail's markup button stands for. */
export const MARKUP_TOOLS = ['highlight', 'underline', 'strikeout', 'squiggly'] as const;
export type MarkupTool = (typeof MARKUP_TOOLS)[number];

export function isMarkupTool(tool: CanvasToolId): tool is MarkupTool {
  return (MARKUP_TOOLS as readonly string[]).includes(tool);
}
