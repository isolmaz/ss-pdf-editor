/**
 * The root of the editor chunk: every surface that only an open document shows. Nothing on the home
 * path imports this module by value; `editor-store.ts` reaches it through one dynamic `import()`,
 * so the layout, the tool strip and everything they bring (the viewer, the mark layers, the dock
 * panels, the operation writers, their icons) leave the first-paint graph.
 */

export { EditorSurface, type EditorSurfaceProps } from './EditorSurface';
export { ToolStrip, type ToolStripProps } from './ToolStrip';
