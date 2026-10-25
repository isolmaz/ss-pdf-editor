/**
 * Full-document text search: every match of a query, page by
 * page, over the text the reader already extracts.
 *
 * There is no second extractor here: the pages come from the adapter's
 * `getPageText()`, the same call copy and the viewer's own search rest on. What this
 * module adds is the loop around it — the extracted text of a page is kept, so a
 * second query walks the document from cache instead of the engine, the scan hands
 * the event loop back every few pages so a 500-page document cannot freeze the UI,
 * and cancellation is an `AbortSignal` that ends the scan with the contract's
 * `aborted` code.
 */

import { ToolError, toToolError } from 'pdf-shared';
import { foldToken, sameToken } from './case-fold';
import type { PdfDocumentHandle } from './engines/pdfjs-handle';

export interface PdfSearchMatch {
  /** 0-based page the match sits on. */
  readonly pageIndex: number;
  /** Offset of the match inside the page's extracted text. */
  readonly index: number;
  readonly length: number;
  /** Text around the match, with `…` where it was clipped — what the row shows. */
  readonly snippet: string;
  /** Offset of the match inside {@link snippet}. */
  readonly snippetOffset: number;
}

export interface PdfSearchOptions {
  readonly signal?: AbortSignal;
  /** Pages scanned so far, for a progress line. */
  readonly onProgress?: (pagesDone: number, pageCount: number) => void;
}

/** Context kept on each side of a match in a snippet. */
const SNIPPET_CONTEXT = 32;

/**
 * Pages between two yields to the event loop. An uncached page already yields on the
 * engine call that extracts it; the count covers the cached pages of a second query,
 * where the whole scan would otherwise run inside a single task.
 */
const PAGES_PER_TURN = 32;

/** Extracted page text, per document — released with the handle that owns it. */
const pageTexts = new WeakMap<PdfDocumentHandle, Map<number, string>>();

async function cachedPageText(document: PdfDocumentHandle, pageIndex: number): Promise<string> {
  let cache = pageTexts.get(document);
  if (cache === undefined) {
    cache = new Map();
    pageTexts.set(document, cache);
  }
  const cached = cache.get(pageIndex);
  if (cached !== undefined) return cached;

  const text = await document.getPageText(pageIndex);
  cache.set(pageIndex, text);
  return text;
}

/**
 * The text as folded characters (code points, compared with `sameToken`), and where each one
 * starts in the original text, so a match is reported at an offset of the page's own text.
 */
function tokenize(text: string): { readonly tokens: readonly string[]; readonly starts: readonly number[] } {
  const tokens: string[] = [];
  const starts: number[] = [];
  let at = 0;
  for (const character of text) {
    tokens.push(foldToken(character, false));
    starts.push(at);
    at += character.length;
  }
  starts.push(at);
  return { tokens, starts };
}

function aborted(): ToolError {
  return new ToolError('aborted', { engine: 'pdfjs', engineMessage: 'signal aborted' });
}

function snippetOf(pageIndex: number, text: string, index: number, length: number): PdfSearchMatch {
  const start = Math.max(0, index - SNIPPET_CONTEXT);
  const end = Math.min(text.length, index + length + SNIPPET_CONTEXT);
  const leading = start > 0 ? '…' : '';
  const trailing = end < text.length ? '…' : '';
  return {
    pageIndex,
    index,
    length,
    snippet: `${leading}${text.slice(start, end)}${trailing}`,
    snippetOffset: index - start + leading.length,
  };
}

/**
 * Every match of `query`, in document order, non-overlapping (a repeated term does
 * not match its own tail). An empty query has no matches by definition.
 */
export async function searchPdfText(
  document: PdfDocumentHandle,
  query: string,
  options: PdfSearchOptions = {},
): Promise<readonly PdfSearchMatch[]> {
  const needle = tokenize(query).tokens;
  if (needle.length === 0) return [];

  const { signal, onProgress } = options;
  const pageCount = document.pageCount;
  const matches: PdfSearchMatch[] = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    if (signal?.aborted === true) throw aborted();

    let text: string;
    try {
      text = await cachedPageText(document, pageIndex);
    } catch (error) {
      throw toToolError(error, 'pdfjs');
    }

    const { tokens, starts } = tokenize(text);
    let at = 0;
    while (at + needle.length <= tokens.length) {
      if (needle.every((token, offset) => sameToken(token, tokens[at + offset]))) {
        const end = at + needle.length;
        matches.push(
          snippetOf(pageIndex, text, starts[at] as number, (starts[end] as number) - (starts[at] as number)),
        );
        at = end;
      } else at += 1;
    }
    onProgress?.(pageIndex + 1, pageCount);

    if ((pageIndex + 1) % PAGES_PER_TURN === 0) {
      // One turn of the event loop between batches, so a long scan can never freeze
      // the panel's own input — the next iteration's abort check ends an aborted
      // scan. The executor form is what typechecks: the repository's `lib` is
      // ES2023, `Promise.withResolvers` is ES2024 (`pdf-ui` carries its own
      // declaration for the same reason).
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }
  return matches;
}
