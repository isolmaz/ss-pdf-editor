/**
 * Redaction.
 *
 * The source project rasterised the touched page at 144 dpi — it lost the text
 * layer, the metadata and the neighbouring content. This
 * implementation erases instead: MuPDF redaction annotations over the marked
 * rectangles, `applyRedactions`, then a full (`garbage`) write.
 *
 * Measured behaviour this file depends on:
 * redaction is **glyph-level** — the glyph run inside the box goes, the
 * surrounding text of the same line stays; `canBeSavedIncrementally()` turns
 * false, so the produced bytes must be a full rewrite and the router must never
 * re-save them incrementally (the /Prev chain would keep the erased revision).
 *
 * Coordinates are **MuPDF page space**: origin top-left, y growing downward, in
 * points. That is the same orientation as the viewer's, so a rectangle drawn on
 * the canvas maps by dividing by the render scale and subtracting the page
 * offset — no y-flip anywhere. It is also the space `page.search()` and
 * `toStructuredText()` report in, which is what makes the verification below a
 * direct comparison; the page's own `/Rotate` is part of it (measured in
 * an early engine spike: an annotation rect stored in PDF user
 * space is accepted silently and removes **nothing**).
 */

import type { PDFAnnotation, PDFDocument, PDFPage, Quad, Rect } from 'mupdf';
import { ToolError } from 'pdf-shared';
import {
  loadMupdf,
  MUPDF_FULL_SAVE_OPTIONS,
  type Mupdf,
  mapMupdfError,
  openPdf,
  readPageBox,
  readPageRotation,
  rectToPageSpace,
  savePdf,
} from '../engines/mupdf';
import { PRODUCER_LINE } from './metadata';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

export interface RedactRect {
  readonly pageIndex: number;
  /** Explicit stored geometry version; legacy mixed-space marks must be redrawn. */
  readonly space: 'app-v1';
  /** PDF user X; Y measured down from the unrotated CropBox top. */
  readonly rect: readonly [number, number, number, number];
}

export interface RedactOptions {
  readonly marks: readonly RedactRect[];
  /** 0 = leave images alone, 1 = remove whole images, 2 = clear the pixels inside the box. */
  readonly imageMethod: 0 | 1 | 2;
  readonly textMethod: 0 | 1;
  readonly cleanMetadata: boolean;
  readonly cleanAttachments: readonly string[];
}

export interface RedactVerification {
  /** True when no text remains inside any mark. */
  readonly marksCleared: boolean;
  /** Page indices where a probe still found content (verification failure). */
  readonly remaining: readonly number[];
}

/**
 * Info keys that can carry document content. They are the same fields the metadata
 * op manages (`ops/metadata.ts` `DocumentMetadata`); `producer` is deliberately
 * absent — the producer line is product policy and survives every cleanup.
 */
const CONTENT_INFO_KEYS = [
  'META_INFO_TITLE',
  'META_INFO_AUTHOR',
  'META_INFO_SUBJECT',
  'META_INFO_KEYWORDS',
  'META_INFO_CREATOR',
] as const satisfies readonly (keyof Mupdf['Document'])[];

/**
 * Line art touched by a mark is removed (`REDACT_LINE_ART_REMOVE_IF_TOUCHED` = 2):
 * a rule that runs through a redacted box would otherwise reveal where the covered
 * content started and ended. `REDACT_LINE_ART_NONE` (0) is the text-replacement
 * setting, where the box must survive — a different operation with a different
 * contract.
 */
const LINE_ART_METHOD_REMOVE_IF_TOUCHED = 2;

export async function redactDocument(
  bytes: Uint8Array,
  options: RedactOptions,
  context: OperationContext,
): Promise<OperationOutcome & { readonly verification: RedactVerification }> {
  throwIfAborted(context.signal);
  if (options.marks.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'mupdf',
      engineMessage: 'redaction needs at least one mark',
    });
  }

  const byPage = groupMarksByPage(options.marks);
  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);

  const doc = openPdf(mupdf, bytes);
  // `applyRedactions` consumes each annotation inside the document, but the JS
  // wrapper still holds a wasm pointer; the spike released them after the save, and
  // the same order is kept here so a failed save cannot leave the annotations
  // dangling.
  const annotations: PDFAnnotation[] = [];
  /** Per page: which of that page's marks covered nothing drawable. */
  const emptyMarks: number[] = [];
  let cleanedAttachments = 0;
  let cleanedMetadata = false;
  let pageCount: number;
  let produced: Uint8Array;
  try {
    pageCount = doc.countPages();
    let done = 0;
    for (const [pageIndex, rects] of byPage) {
      throwIfAborted(context.signal);
      if (pageIndex < 0 || pageIndex >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          pageIndex,
          engineMessage: `page index ${pageIndex} outside 0..${pageCount - 1}`,
        });
      }
      const touched = applyMarks(doc, pageIndex, rects, options, annotations);
      if (!touched) emptyMarks.push(pageIndex);
      done += rects.length;
      context.onProgress?.({
        phase: 'redact',
        labelKey: 'op.progress.redact',
        done,
        total: options.marks.length,
      });
    }
    throwIfAborted(context.signal);

    if (options.cleanMetadata) {
      cleanedMetadata = cleanInfoAndXmp(mupdf, doc);
    }
    for (const name of options.cleanAttachments) {
      if (removeEmbeddedFile(doc, name)) cleanedAttachments += 1;
    }

    context.onProgress?.({ phase: 'redact', labelKey: 'op.progress.redact.save', done: 0, total: 1 });
    produced = savePdf(doc, MUPDF_FULL_SAVE_OPTIONS);
  } catch (error) {
    throw mapMupdfError(error, 'redact');
  } finally {
    for (const annotation of annotations) annotation.destroy();
    doc.destroy();
  }
  throwIfAborted(context.signal);

  const verification = await verifyRedaction(produced, options.marks);
  if (!verification.marksCleared) {
    // A failed check never hands back a file to write: the session stays dirty and
    // the original survives. The page list is in the
    // engine message for the report and the bug report.
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `redaction left text inside marks on page(s) ${verification.remaining.join(', ')}`,
    });
  }
  context.onProgress?.({ phase: 'redact', labelKey: 'op.progress.redact.save', done: 1, total: 1 });

  return {
    bytes: produced,
    verification,
    report: {
      engine: 'mupdf',
      steps: [
        'open',
        'annotate(Redact)',
        'applyRedactions',
        ...(cleanedMetadata ? ['clean(Info+XMP)'] : []),
        ...(cleanedAttachments > 0 ? ['clean(attachments)'] : []),
        'save(garbage=compact,compress,clean)',
        'verify',
      ],
      notes: [
        note('lost', 'op.note.redact.contentErased', {
          marks: options.marks.length,
          pages: byPage.size,
        }),
        // An empty mark erases nothing while the count still claims a redaction:
        // state it instead of letting a clean verification speak for it.
        ...(emptyMarks.length > 0
          ? [note('warning', 'op.note.redact.emptyMarks', { pages: emptyMarks.join(', ') })]
          : []),
        note('preserved', 'op.note.redact.singleRevision'),
        note('preserved', 'op.note.redact.verified'),
        ...(options.imageMethod === 0 ? [note('warning', 'op.note.redact.imagesUntouched')] : []),
        ...(cleanedMetadata ? [note('lost', 'op.note.redact.metadataCleared')] : []),
        ...(cleanedAttachments > 0
          ? [note('lost', 'op.note.redact.attachmentsRemoved', { count: cleanedAttachments })]
          : []),
        note('preserved', 'op.note.redact.producerKept', { producer: PRODUCER_LINE }),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: produced.byteLength,
      // Measured: `canBeSavedIncrementally()` is false once redactions are applied,
      // and an incremental write would keep the pre-redaction revision reachable
      // through `/Prev` (spike #4 §5) — the erased bytes must not travel at all.
      incremental: false,
      pageCount,
    },
  };
}

/**
 * Check that the marks are actually empty in the *produced* bytes — the
 * "targeted occurrence removed" contract of redaction, measured rather than assumed.
 *
 * The probe is a character walk over `toStructuredText()` (spike-verified shape:
 * `onChar(c, origin, font, size, quad)`, quad in page space) and a quad/rect
 * overlap test. `page.search()` cannot be used here: verification knows *where* the
 * content was, not *what* it said. A character counts as remaining when half or
 * more of its quad lies inside the mark; a partially overlapping neighbour is
 * tolerated by design — measured on the spike fixture, the space that ends
 * `"Kimlik: "` keeps its own quad (x 75.33–78.66) against a mark starting at 78.66,
 * i.e. zero overlap, while the erased run that followed it is gone entirely.
 */
export async function verifyRedaction(
  bytes: Uint8Array,
  marks: readonly RedactRect[],
): Promise<RedactVerification> {
  const byPage = groupMarksByPage(marks);
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const pageCount = doc.countPages();
    const remaining: number[] = [];
    for (const [pageIndex, rects] of byPage) {
      if (pageIndex < 0 || pageIndex >= pageCount) {
        remaining.push(pageIndex);
        continue;
      }
      const page = doc.loadPage(pageIndex);
      try {
        // Invert the engine's actual page matrix rather than reusing the writer's
        // quarter-turn conversion. Compare in the stored, unrotated mark space.
        const inverse = mupdf.Matrix.invert(page.getTransform());
        const box = readPageBox(page);
        const top = box.y + box.height;
        const text = page.toStructuredText('preserve-whitespace');
        try {
          let leftover = false;
          text.walk({
            onChar(c: string, _origin, _font, _size, quad: Quad) {
              if (leftover || c.trim().length === 0) return;
              const user = mupdf.Rect.transform(
                [
                  Math.min(quad[0], quad[2], quad[4], quad[6]),
                  Math.min(quad[1], quad[3], quad[5], quad[7]),
                  Math.max(quad[0], quad[2], quad[4], quad[6]),
                  Math.max(quad[1], quad[3], quad[5], quad[7]),
                ],
                inverse,
              );
              const app: Quad = [
                user[0],
                top - user[3],
                user[2],
                top - user[1],
                user[0],
                top - user[1],
                user[2],
                top - user[3],
              ];
              leftover = rects.some((rect) => quadCoverage(app, rect) >= HALF_COVERED);
            },
          });
          if (leftover) remaining.push(pageIndex);
        } finally {
          text.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return { marksCleared: remaining.length === 0, remaining };
  } catch (error) {
    throw mapMupdfError(error, 'verify-redaction');
  } finally {
    doc.destroy();
  }
}

/** Share of a glyph quad's box that lies inside the mark (0 … 1). */
const HALF_COVERED = 0.5;

function quadCoverage(quad: Quad, rect: readonly [number, number, number, number]): number {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const glyphX0 = Math.min(...xs);
  const glyphX1 = Math.max(...xs);
  const glyphY0 = Math.min(...ys);
  const glyphY1 = Math.max(...ys);
  const width = glyphX1 - glyphX0;
  const height = glyphY1 - glyphY0;
  if (width <= 0 || height <= 0) return 0;
  const overlapX = Math.min(glyphX1, rect[2]) - Math.max(glyphX0, rect[0]);
  const overlapY = Math.min(glyphY1, rect[3]) - Math.max(glyphY0, rect[1]);
  if (overlapX <= 0 || overlapY <= 0) return 0;
  return (overlapX * overlapY) / (width * height);
}

/** `pageIndex -> [x0, y0, x1, y1]`, ascending by page so the wasm pages load in order. */
function groupMarksByPage(marks: readonly RedactRect[]): Map<number, Rect[]> {
  const byPage = new Map<number, Rect[]>();
  for (const mark of marks) {
    if (mark.space !== 'app-v1') {
      throw new ToolError('redaction-geometry-unknown', { engine: 'model' });
    }
    if (!Number.isInteger(mark.pageIndex)) {
      throw new ToolError('range-invalid', { engine: 'model' });
    }
    const [x0, y0, x1, y1] = mark.rect;
    if (!Number.isFinite(x0 + y0 + x1 + y1) || x1 <= x0 || y1 <= y0) {
      throw new ToolError('range-invalid', {
        engine: 'mupdf',
        pageIndex: mark.pageIndex,
        engineMessage: `mark rect [${x0}, ${y0}, ${x1}, ${y1}] is not a positive rectangle`,
      });
    }
    const rects = byPage.get(mark.pageIndex);
    if (rects === undefined) byPage.set(mark.pageIndex, [[x0, y0, x1, y1]]);
    else rects.push([x0, y0, x1, y1]);
  }
  return new Map([...byPage].sort(([a], [b]) => a - b));
}

/** One page's marks: annotate, then apply — MuPDF erases everything annotated so far. */
function applyMarks(
  doc: PDFDocument,
  pageIndex: number,
  rects: readonly Rect[],
  options: RedactOptions,
  annotations: PDFAnnotation[],
): boolean {
  let page: PDFPage | null = null;
  try {
    page = doc.loadPage(pageIndex);
    const box = readPageBox(page);
    const rotation = readPageRotation(page);
    for (const rect of rects) {
      const annotation = page.createAnnotation('Redact');
      annotation.setRect(rectToPageSpace(box, rotation, rect));
      annotation.update();
      annotations.push(annotation);
    }
    // A mark that covers no glyph, image or line-art draw erases nothing while
    // looking like it did — the false success redaction must never report. The structured
    // text plus the display list (draw commands) answer "did this rectangle
    // intersect anything drawable", and the answer is reported, not assumed.
    let touched = false;
    const structured = page.toStructuredText('preserve-whitespace');
    try {
      const mupdfRects = rects.map((rect) => rectToPageSpace(box, rotation, rect));
      const check: Rect = [0, 0, 0, 0];
      structured.walk({
        onChar(_c, _origin, _font, _size, quad: Quad) {
          if (touched) return;
          for (const rect of mupdfRects) {
            const xs = [quad[0], quad[2], quad[4], quad[6]];
            const ys = [quad[1], quad[3], quad[5], quad[7]];
            check[0] = Math.min(...xs);
            check[1] = Math.min(...ys);
            check[2] = Math.max(...xs);
            check[3] = Math.max(...ys);
            if (check[0] < rect[2] && check[2] > rect[0] && check[1] < rect[3] && check[3] > rect[1]) {
              touched = true;
              return;
            }
          }
        },
      });
    } finally {
      structured.destroy();
    }
    // A text-only measurement is the honest scope here: a mark over an image or
    // pure line art with `imageMethod 0` would be reported as empty even though
    // the engine removed line art it touched. The warning below states the text
    // contract; the PDF-side graphic coverage read is a documented limit.
    // `black_boxes: false` — the erase is a content operation, not a painted
    // rectangle; painting would leave a black bar that advertises the redaction and
    // cannot be lifted, and redaction wants the content gone, not covered.
    page.applyRedactions(false, options.imageMethod, LINE_ART_METHOD_REMOVE_IF_TOUCHED, options.textMethod);
    return touched;
  } finally {
    page?.destroy();
  }
}

/**
 * Drop the content-bearing Info keys and the XMP packet, then re-stamp the producer
 * line. Returns whether anything was there to clean.
 *
 * MuPDF's metadata API is write-only per key (`setMetaData`), so Info fields are set
 * to an empty string rather than removed — the key stays, its content does not, which
 * is what the redaction contract cares about. XMP lives in the document catalog
 * (`/Root/Metadata`) and can be removed for real.
 */
function cleanInfoAndXmp(mupdf: Mupdf, doc: PDFDocument): boolean {
  const { Document } = mupdf;
  let cleaned = false;
  for (const key of CONTENT_INFO_KEYS) {
    const name = Document[key];
    if ((doc.getMetaData(name) ?? '').length > 0) {
      doc.setMetaData(name, '');
      cleaned = true;
    }
  }
  const root = doc.getTrailer().get('Root');
  const xmp = root.get('Metadata');
  if (!xmp.isNull()) {
    if (xmp.isIndirect()) doc.deleteObject(xmp.asIndirect());
    else root.delete('Metadata');
    cleaned = true;
  }
  // Product policy: the producer line is merged back, never stripped.
  doc.setMetaData(Document.META_INFO_PRODUCER, PRODUCER_LINE);
  return cleaned;
}

/** Remove one embedded file by name; returns whether it existed. */
function removeEmbeddedFile(doc: PDFDocument, name: string): boolean {
  const files = doc.getEmbeddedFiles();
  if (files[name] === undefined) return false;
  doc.deleteEmbeddedFile(name);
  return true;
}
