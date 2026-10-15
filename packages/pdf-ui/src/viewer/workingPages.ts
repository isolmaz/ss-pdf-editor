import { openWithPdfjs } from 'pdf-core/engines/pdfjs-handle';
import type { OperationContext } from 'pdf-core/ops/types';
import { ToolError } from 'pdf-shared';
import type { PrintPageSource } from '../printing/printSource';

/**
 * The pages of the document **as a Save would write it** — for the slices that turn the
 * document into a picture or a sheet (print, snapshot).
 *
 * The viewer's own pdf.js document is not that. A mark the reader drew (a highlight, ink, a
 * shape, a note, a measurement) is the shell's overlay until it is written: it is painted by
 * the shell's layers over the page, never by the engine, so rendering the engine document
 * leaves every one of them out. The shell's reader (`WorkingBytesReader`, the same route a
 * Save and every read-only panel take) writes them into a copy of the bytes; this opens that
 * copy, renders from it, and lets it go. The tab, its working version and its marks are not
 * touched: the copy is thrown away with the pages.
 */

/** The shell's route to the working bytes: the open document with its unsaved marks written in. */
export type WorkingBytesReader = (operation: OperationContext) => Promise<Uint8Array>;

/** Pages to render from, and the release that has to follow them. */
export interface WorkingPages {
  readonly source: Pick<PrintPageSource, 'getPageSize' | 'renderPage'>;
  /** Frees the opened copy. Called from a `finally`, so it never rejects. */
  release(): Promise<void>;
}

/**
 * Read the working bytes and open them for rendering.
 *
 * A protected document is the one case the copy cannot be opened: its bytes are still
 * encrypted and this slice has no password. Such a tab is read-only — it can hold no unsaved
 * mark — so the document on screen (`live`) already is what a Save would write, and it is
 * rendered instead. Every other failure (the marks could not be written, the copy is
 * unreadable) is the caller's to report.
 */
export async function openWorkingPages(
  read: WorkingBytesReader,
  live: Pick<PrintPageSource, 'getPageSize' | 'renderPage'>,
  signal: AbortSignal,
): Promise<WorkingPages> {
  const bytes = await read({ signal });
  try {
    const handle = await openWithPdfjs(bytes, { signal });
    return { source: handle, release: () => handle.destroy().catch(() => undefined) };
  } catch (error) {
    if (
      error instanceof ToolError &&
      (error.code === 'password-required' || error.code === 'wrong-password')
    ) {
      return { source: live, release: () => Promise.resolve() };
    }
    throw error;
  }
}
