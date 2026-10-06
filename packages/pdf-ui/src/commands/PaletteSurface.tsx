/**
 * The command palette's own module boundary (`PLAN.md §7`).
 *
 * The palette is the only consumer of Kumo's command palette — a base-ui dialog,
 * an autocomplete and their dependency tree — and nothing on the empty state needs
 * it (`local://firstpaint.md`). The shell therefore reaches it through this
 * one-line surface with a dynamic `import()`, the same pattern `PrintSurface.tsx`
 * already uses for the print dialog, so the entry chunk stops carrying a surface
 * that only exists after `Ctrl+K`.
 *
 * The re-export is the whole file: the palette stays where it is and nothing about
 * its own surface changes.
 */

export { CommandPalette, type CommandPaletteProps } from './CommandPalette';
