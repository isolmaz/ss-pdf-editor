/**
 * Reading mode, step 1: the current page as reading-order blocks (`PLAN.md §5/Phase 1`).
 *
 * The text comes from the **engine-side extraction the rest of the reader already
 * uses**: the pdf.js adapter's `PdfDocumentHandle` (`pdf-core/engines/pdfjs-handle.ts`).
 * `getPageText()` — the string search and copy read — collapses the runs to a single
 * line of text, so this hook walks the same `PDFPageProxy#getTextContent()` call
 * through the handle's document and keeps the per-run transforms, which is what the
 * line/block grouping in `./text.ts` needs. No second extractor lives here: the engine
 * parses, this module positions.
 */

import type { PdfDocumentHandle } from 'pdf-core';
import { type MessageKey, ToolError } from 'pdf-shared';
import { useEffect, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { buildReadingBlocks, type ReadingBlock, type ReadingTextItem, toReadingTextItem } from './text';

/**
 * The viewer payload the reading pane consumes: `ViewerApi` (zoom, find, navigation)
 * plus the pdf-core document handle the text comes from.
 *
 * `ViewerApi` carries no document today, so the field is optional here and the hook
 * reports the gap instead of guessing (see {@link NO_TEXT_SOURCE}). Integration: add
 * `document: PdfDocumentHandle` to the object `PdfViewerPane` hands to `onReady` and
 * to `ViewerApi` — one line each, and no other file has to change.
 */
export type ReadingViewer = ViewerApi & { readonly document?: PdfDocumentHandle };

/**
 * Every failure is a dictionary key, never an engine message (`AGENTS.md > Errors`).
 * This one means the viewer handed us no text source at all — a wiring gap, not a
 * document problem, so it must not be reported as "no text on this page".
 */
const NO_TEXT_SOURCE: MessageKey = 'error.internal.message';

/** The adapter's own code for a cancelled load (`pdf-core` maps `AbortException` to it). */
function aborted(): ToolError {
  return new ToolError('aborted', { engine: 'pdfjs', engineMessage: 'signal aborted' });
}

export interface ReadingText {
  readonly blocks: readonly ReadingBlock[];
  readonly loading: boolean;
  /** Dictionary key of the failure; `null` while the page reads fine. */
  readonly error: MessageKey | null;
}

/**
 * Page text as blocks. `pageNumber` is 0-based, like everywhere else in the viewer.
 *
 * `signal` is the caller's cancellation for the whole reading session: the effect
 * aborts its own controller when the page or the document changes, when the signal
 * fires, and on unmount, so a page the user has left is never applied to the pane.
 */
export function useReadingText(
  viewer: ReadingViewer | null,
  pageNumber: number,
  signal?: AbortSignal,
): ReadingText {
  const [state, setState] = useState<ReadingText>({ blocks: [], loading: true, error: null });

  useEffect(() => {
    if (viewer === null) {
      // No viewer yet: the document is still opening, which is a wait, not a failure.
      setState({ blocks: [], loading: true, error: null });
      return undefined;
    }
    const source = viewer.document;
    if (source === undefined) {
      setState({ blocks: [], loading: false, error: NO_TEXT_SOURCE });
      return undefined;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort);
    if (signal?.aborted === true) abort();
    setState({ blocks: [], loading: true, error: null });

    void (async () => {
      try {
        const blocks = await readPageBlocks(source, pageNumber, controller.signal);
        if (!controller.signal.aborted) setState({ blocks, loading: false, error: null });
      } catch (error) {
        // An abort is the caller's own page change or close, not a failure to report.
        if (controller.signal.aborted) return;
        setState({
          blocks: [],
          loading: false,
          error: error instanceof ToolError ? error.messageKey : 'error.internal.message',
        });
      }
    })();

    return () => {
      signal?.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [viewer, pageNumber, signal]);

  return state;
}

/**
 * One page of engine text → blocks. pdf.js exposes no cancellation parameter on
 * `getTextContent()`, so the signal is honoured around the engine call and the
 * caller's controller is what keeps an abandoned result out of the pane.
 */
async function readPageBlocks(
  source: PdfDocumentHandle,
  pageIndex: number,
  signal: AbortSignal,
): Promise<ReadingBlock[]> {
  if (signal.aborted) throw aborted();
  const page = await source.raw.getPage(pageIndex + 1);
  if (signal.aborted) throw aborted();
  const content = await page.getTextContent();
  if (signal.aborted) throw aborted();

  const runs: ReadingTextItem[] = [];
  for (const item of content.items) {
    // Marked-content markers carry structure, not text.
    if (!('str' in item)) continue;
    const run = toReadingTextItem(item);
    if (run !== null) runs.push(run);
  }
  return buildReadingBlocks(runs);
}
