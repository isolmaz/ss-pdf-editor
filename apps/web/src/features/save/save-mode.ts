/** What Save does for a tab: the one answer the header's button and the menu and palette entry share. */

/**
 * Write over the tab's file, ask where to write it (no file yet, and the browser can ask), or
 * nothing at all: a browser that cannot write files has no Save — its download is Export (and
 * `Ctrl+S`, which downloads there too).
 */
export function saveModeFor(hasFileHandle: boolean): 'save' | 'saveAs' | 'none' {
  if (hasFileHandle) return 'save';
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
    ? 'saveAs'
    : 'none';
}
