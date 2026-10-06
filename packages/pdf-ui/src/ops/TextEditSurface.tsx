/**
 * The text-editing surface's own module boundary (`PLAN.md §7`).
 *
 * The block overlay reads the page's structured text and builds font metric tables
 * (`pdf-core/text-source` → `pdf-text-engine`), and the dialog pulls the writer op
 * with it. That is code nobody needs until the user arms the
 * text tool, so the shell reaches both through `pdf-ui/text-edit` with a dynamic
 * import — the same pattern `pdf-ui/printing` and `pdf-ui/palette` already use.
 *
 * The re-export is the whole file: no behaviour lives here.
 */

export { type TextBlockSelection, TextLayer, type TextLayerProps } from './TextLayer';
export { textEditDialog } from './text-edit';
