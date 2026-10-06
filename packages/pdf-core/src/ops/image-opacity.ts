/**
 * Image opacity (“replace, crop, compress, rotate, **opacity**”).
 *
 * Opacity is the one image action that is **not** an image-stream change: how transparently
 * an image is drawn is a graphics-state fact, so an `/ExtGState` with `/ca` is selected
 * just before the operator that draws it. That is why this lives beside `image-edit.ts`
 * instead of inside it — one module changes what the image *is*, this one changes how the
 * page *paints* it, and mixing them would put a content-stream rewrite behind an action the
 * user reads as “make this picture fainter”.
 *
 * The content stream is rewritten **minimally**: the existing operator sequence is kept
 * byte for byte and the new state is wrapped around the single `Do` that names the image
 * (`q /GS… gs … Do Q`). A page's `/Contents` may be one stream or an array of them, and an
 * array is a single stream split for size, so the decoded parts are concatenated and
 * written back as one — the only rewriting this operation does.
 *
 * When opacity is `1` the state is written as `/ca 1` and the wrapper is still added:
 * “make it fully opaque again” is a real request after an earlier edit, and a silent no-op
 * would leave the previous value in force.
 */

import type { PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  dictionaryIn,
  openForWrite,
  pageContentParts,
  pageObjects,
  pageResources,
  producerKeptNote,
  resolved,
  saveRewrite,
} from '../engines/mupdf-write';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export interface ImageOpacityRequest {
  readonly pageIndex: number;
  /** The `/Resources /XObject` key of the image to paint more faintly. */
  readonly name: string;
  /** `0…1`; 1 restores full opacity. */
  readonly opacity: number;
}

/** A graphics state name that is not already taken on the page. */
function stateName(states: PDFObject, opacity: number): string {
  const base = `GS${Math.round(opacity * 100)}`;
  let candidate = base;
  let suffix = 1;
  while (!states.get(candidate).isNull()) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** The decoded bytes of a page's `/Contents`, one stream or many. */
function contentBytes(page: PDFObject, pageIndex: number, path: string): Uint8Array {
  const parts = pageContentParts(page);
  if (parts === null) {
    throw new ToolError('unsupported', {
      engine: 'mupdf',
      path,
      engineMessage: `page ${pageIndex + 1} has no /Contents stream to wrap the image in`,
    });
  }
  if (parts === 'unreadable') {
    throw new ToolError('unsupported', {
      engine: 'mupdf',
      path,
      engineMessage: `page ${pageIndex + 1}'s /Contents is not a stream this writer can read`,
    });
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
    // A newline between parts: a stream boundary may fall between two operators, and the
    // spec's own example is a newline.
    joined[at] = 0x0a;
    at += 1;
  }
  return joined;
}

/**
 * Wrap every `/<name> Do` in the page's content stream with its own graphics state.
 *
 * The scan runs on **bytes**, never on a decoded string: a content stream can carry
 * binary inside an inline image, and any `latin1` round trip through JavaScript strings
 * maps the 0x80…0x9F range through windows-1252 and corrupts it. The browser also has no
 * `Buffer`, and a module that is nominally DOM-free must not need one (measured: the first
 * version threw `Buffer is not defined` in the browser and nowhere else).
 *
 * The match is deliberately narrow: a `Do` is only accepted when the token before it is
 * exactly the image's resource name, followed by a delimiter. A different image, a form
 * XObject, or a name that merely contains the target (`/Image-1` inside `/Image-10`) is
 * left alone.
 */
function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0x7f;
  return bytes;
}

function wrapDrawing(
  bytes: Uint8Array,
  name: string,
  state: string,
  path: string,
): { readonly bytes: Uint8Array; readonly wrapped: number } {
  const operator = asciiBytes(`/${name} Do`);
  const open = asciiBytes(`q /${state} gs `);
  const close = asciiBytes(' Q');
  /** A byte that ends a PDF token; `Do` must be followed by one of these (or by the end). */
  const isDelimiter = (byte: number | undefined): boolean =>
    byte === undefined ||
    byte === 0x20 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x09 ||
    byte === 0x2f ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x7b ||
    byte === 0x7d ||
    byte === 0x25;

  const parts: Uint8Array[] = [];
  let cursor = 0;
  let wrapped = 0;
  for (;;) {
    let found = -1;
    for (let at = cursor; at + operator.length <= bytes.length; at += 1) {
      let matches = true;
      for (let step = 0; step < operator.length; step += 1) {
        if (bytes[at + step] !== operator[step]) {
          matches = false;
          break;
        }
      }
      if (matches && isDelimiter(bytes[at + operator.length])) {
        found = at;
        break;
      }
    }
    if (found === -1) {
      parts.push(bytes.subarray(cursor));
      break;
    }
    parts.push(bytes.subarray(cursor, found), open, operator, close);
    cursor = found + operator.length;
    wrapped += 1;
  }

  if (wrapped === 0) {
    throw new ToolError('unsupported', {
      engine: 'mupdf',
      path,
      engineMessage: `no "/${name} Do" appears in page ${path}'s content stream`,
    });
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { bytes: out, wrapped };
}

export async function applyImageOpacity(
  bytes: Uint8Array,
  request: ImageOpacityRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (!Number.isFinite(request.opacity) || request.opacity < 0 || request.opacity > 1) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      path: 'request.opacity',
      engineMessage: `opacity must be between 0 and 1, got ${String(request.opacity)}`,
    });
  }

  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const pageCount = pages.length;
    const page = pages[request.pageIndex];
    if (!Number.isInteger(request.pageIndex) || page === undefined) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: 'request.pageIndex',
        engineMessage: `page ${request.pageIndex} is outside 0…${pageCount - 1}`,
      });
    }

    const inherited = resolved(page.getInheritable('Resources'));
    if (inherited === null) {
      throw new ToolError('unsupported', {
        engine: 'mupdf',
        path: 'request.pageIndex',
        engineMessage: `page ${request.pageIndex + 1} has no /Resources`,
      });
    }
    const xObjects = resolved(inherited.get('XObject'));
    if (xObjects === null || xObjects.get(request.name).isNull()) {
      throw new ToolError('selection-empty', {
        engine: 'mupdf',
        path: 'request.name',
        engineMessage: `page ${request.pageIndex + 1} does not name an image "${request.name}"`,
      });
    }

    const steps: string[] = ['load'];
    const notes: OperationNote[] = [];

    context.onProgress?.({ phase: 'opacity', labelKey: 'op.progress.image.opacity', done: 0, total: 1 });

    const states = dictionaryIn(doc, pageResources(doc, page), 'ExtGState');
    const state = stateName(states, request.opacity);
    // `/ca` is the non-stroking alpha and `/CA` the stroking one; both are set so an image
    // drawn with either path is affected the same way.
    states.put(state, doc.addObject({ Type: 'ExtGState', ca: request.opacity, CA: request.opacity }));
    steps.push('extgstate');

    const decoded = contentBytes(page, request.pageIndex, 'request.pageIndex');
    const { bytes: rewritten, wrapped } = wrapDrawing(decoded, request.name, state, 'request.pageIndex');
    page.put('Contents', doc.addStream(rewritten, {}));
    steps.push('contents');
    notes.push(note('changed', 'op.note.image.opacitySet', { name: request.name, opacity: request.opacity }));
    notes.push(note('changed', 'op.note.image.opacityWrapped', { count: wrapped, state }));
    steps.push('producer');

    throwIfAborted(context.signal);
    const out = saveRewrite(doc, 'set image opacity');
    steps.push('save');

    context.onProgress?.({ phase: 'opacity', labelKey: 'op.progress.image.opacity', done: 1, total: 1 });

    const report: OperationReport = {
      engine: 'mupdf',
      steps,
      notes: [...notes, producerKeptNote()],
      inputBytes: bytes.byteLength,
      outputBytes: out.byteLength,
      pageCount,
      // Re-serialised: the incremental fast path is over.
      incremental: false,
    };
    return { bytes: out, report };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'set image opacity');
  } finally {
    doc.destroy();
  }
}
