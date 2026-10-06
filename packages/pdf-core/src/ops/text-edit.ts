/**
 * Text editing, writer half.
 *
 * One operation performs the whole manoeuvre, in the order the save pipeline
 * requires:
 *
 *   1. **erase** (4c) — MuPDF redaction annotations over the given rectangles,
 *      then `applyRedactions`. The glyph runs inside those boxes leave the
 *      content stream; nothing is painted over them. `black_boxes = false` is the
 *      measured difference between "the content is gone" and "the content is
 *      covered by a bar that advertises the edit and cannot be lifted"
 *     .
 *   2. **insert** (4e) — MuPDF embeds the fonts, draws the replacement lines at
 *      their baselines in one new content stream per page and rewrites the file.
 *   3. **verify** (4f) — the produced bytes are re-opened with **pdf.js**, the
 *      independent reader, and three claims are measured: the erased text is gone
 *      from that page's text content, the new text is present and searchable, and
 *      the page count did not move. Any mismatch throws `verification-failed` and
 *      no bytes are handed back.
 *
 * ## Coordinate spaces — getting this wrong is silent, so it happens once, here
 *
 * Requests speak the app's page space (`PageRect`, `ops/types.ts`): **unrotated
 * PDF user space with a top-left origin** — `x` is the user-space x, `y` counts
 * down from the top edge of the page box. That is the space the viewer's own
 * pointer conversion produces (`PdfViewerPane.pointToPage`: `top - pdfY`, x as
 * pdf.js reports it) and the space the redaction marks already use, so a rectangle
 * drawn on screen and a rectangle sent to this operation are the same numbers.
 *
 * MuPDF does **not** speak that space for annotations: `setRect` takes *page
 * space*, which is the displayed page, its origin at the page box's top-left
 * corner **after `/Rotate`**, `y` growing downward. The spike measured what
 * confusing the two costs: the annotation is accepted, consumed, and removes
 * nothing at all. The conversion is therefore explicit per quarter turn
 * (`userToPageSpace`, derivation in its comment) and never assumes rotation 0.
 *
 * The drawn lines are written in plain user space (bottom-left origin), so a baseline
 * point is flipped **once**, in `topLeftToUserPoint`; the flip appears nowhere else.
 *
 * ## Fonts (4e)
 *
 * Every drawn line is set in a font this operation embeds itself. A font read back
 * out of the document must never be reused: a subset has no usable cmap left
 * (`encodeCharacter` answers glyph id 0 for every character — spike #3, variant A),
 * so each edit round embeds a fresh subset, and the report states that the block
 * was re-rendered with an embedded font. The default face is Noto Sans (OFL,
 * pinned asset): the standard 14 are WinAnsi and WinAnsi cannot spell `ğ ş ı İ`, so
 * a standard face is used only when a line's `fontId` names one *and* WinAnsi can
 * encode that line. Everything else falls back to Noto and is reported
 * as a substitution.
 *
 * `request.fonts` is fetched from **our own origin only**: a URL that
 * resolves elsewhere is refused here rather than becoming a third-party request.
 */

import type { PDFPage as MupdfPage, PDFAnnotation, PDFObject, Quad, Rect } from 'mupdf';
import { ToolError, toToolError } from 'pdf-shared';
import type { TextEditErase, TextEditInsert, TextEditInsertLine, TextEditRequest } from 'pdf-text-engine';
import {
  DOCUMENT_FONT_PREFIX,
  type DocumentFont,
  encodes,
  findFont,
  pageFonts,
  showText,
} from '../engines/doc-fonts';
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
  topLeftRectToUserSpace,
  topLeftToUserPoint,
  type UserBox,
} from '../engines/mupdf';
import {
  addPageResource,
  appendPageContent,
  type EmbeddedFace,
  embedFontFile,
  pdfNumber as num,
  openForWrite,
  pageObjects,
  type StandardFace,
  saveRewrite,
  standardFace,
  type WritableDocument,
} from '../engines/mupdf-write';
import { notoSansBytes } from '../engines/noto';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { PRODUCER_LINE } from './metadata';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export type { TextEditErase, TextEditInsert, TextEditInsertLine, TextEditRequest };

/** One page's planned work, in ascending page order. */
interface PageWork {
  readonly pageIndex: number;
  readonly rects: readonly (readonly [number, number, number, number])[];
  readonly lines: readonly TextEditInsertLine[];
}

/** What the erase stage read out of the page, before anything was removed. */
interface ErasedPage {
  readonly pageIndex: number;
  /** The text each rectangle covered, one entry per rectangle, in document order. */
  readonly covered: readonly string[];
  /** The page's own text before the edit — the baseline of the duplicate test. */
  readonly before: string;
}

interface EraseResult {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly boxes: ReadonlyMap<number, UserBox>;
  readonly erased: readonly ErasedPage[];
  readonly rectCount: number;
}

interface WriteResult {
  readonly bytes: Uint8Array;
  /** Faces embedded *from bytes* (URL or Noto); a standard face is not among them. */
  readonly embeddedFonts: readonly string[];
  /** Every face the drawn lines use, embedded or standard. */
  readonly fonts: readonly string[];
  /** Requested ids that were replaced by {@link NOTO_NAME}. */
  readonly substitutions: readonly string[];
  readonly lineCount: number;
  /** Lines drawn word by word (`words` present), so the report can say so. */
  readonly justifiedLines: number;
}

interface VerificationResult {
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly pageCount: number;
}

/** The face every substitution lands on, under the name the report shows. */
const NOTO_NAME = 'Noto Sans';

/** Share of a glyph quad's box that must lie inside a rectangle to count as erased. */
const HALF_COVERED = 0.5;

/** Report parameters are one line of Turkish interface text; the needles are clipped. */
const MAX_NOTE_TEXT = 160;

/**
 * The standard text faces, by the id shape a font candidate uses. Only the faces that
 * spell text: `Symbol` and `ZapfDingbats` carry symbol encodings, and a text edit
 * must not silently draw dingbats. A candidate whose id is not one of these is never
 * mapped onto one — `request.fonts` decides, and Noto is the honest fallback.
 */
const STANDARD_14_MEMBERS: Readonly<Record<string, string>> = {
  helvetica: 'Helvetica',
  'helvetica-bold': 'Helvetica-Bold',
  'helvetica-oblique': 'Helvetica-Oblique',
  'helvetica-boldoblique': 'Helvetica-BoldOblique',
  'times-roman': 'Times-Roman',
  'times-bold': 'Times-Bold',
  'times-italic': 'Times-Italic',
  'times-bolditalic': 'Times-BoldItalic',
  courier: 'Courier',
  'courier-bold': 'Courier-Bold',
  'courier-oblique': 'Courier-Oblique',
  'courier-boldoblique': 'Courier-BoldOblique',
};

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

/**
 * How far (in points) the replacement's own items may sit from the baseline the plan
 * asked for and still count as "this operation drew that". pdf.js re-derives each
 * item's origin from the text matrix, so a sub-point difference is expected; a line
 * of the *old* text never lands this close to the *new* baseline unless the two
 * coincide, which is precisely the case this tolerance has to accept.
 */
const INSERTED_MATCH_TOLERANCE_PT = 0.75;

export async function applyTextEdit(
  bytes: Uint8Array,
  request: TextEditRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const planned = planRequest(request);

  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);
  const erased = await eraseStage(mupdf, bytes, planned, context);

  throwIfAborted(context.signal);
  const written = await writeStage(erased.bytes, planned, erased.boxes, request.fonts, context);

  throwIfAborted(context.signal);
  const verification = await verifyPages(erased, planned, written.bytes, context);

  const notes: OperationNote[] = [];
  const erasedStrings = verification.removed;
  if (erased.rectCount > 0) {
    notes.push(
      note('lost', 'op.note.textEdit.erased', {
        rects: erased.rectCount,
        pages: erased.erased.length,
        removed: clipList(erasedStrings),
      }),
    );
  }
  if (erasedStrings.length === 0 && erased.rectCount > 0) {
    notes.push(note('warning', 'op.note.textEdit.nothingErased'));
  }
  if (written.lineCount > 0) {
    // The block is re-drawn, never patched: the spike's subset finding is why a
    // second round needs a fresh embed, and the user is told which face carries it.
    notes.push(note('changed', 'op.note.textEdit.rendered', { font: written.fonts.join(', ') }));
  }
  if (written.embeddedFonts.length > 0) {
    notes.push(note('changed', 'op.note.textEdit.fontEmbedded', { font: written.embeddedFonts.join(', ') }));
  }
  if (written.justifiedLines > 0) {
    // The gaps are position-only, so the verification compares characters, not
    // spacing, and the report says which of the two it did (`4f` honesty rule).
    notes.push(note('changed', 'op.note.textEdit.justified', { count: written.justifiedLines }));
  }
  for (const requested of written.substitutions) {
    notes.push(note('lost', 'op.note.textEdit.fontSubstituted', { requested, font: NOTO_NAME }));
  }
  if (erasedStrings.length > 0) {
    notes.push(note('preserved', 'op.note.textEdit.verifiedErased', { removed: clipList(erasedStrings) }));
  }
  if (verification.added.length > 0) {
    notes.push(note('changed', 'op.note.textEdit.verifiedInserted', { added: clipList(verification.added) }));
  }
  notes.push(note('preserved', 'op.note.textEdit.verifiedPages', { pages: verification.pageCount }));
  notes.push(note('preserved', 'op.note.redact.singleRevision'));
  notes.push(note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }));

  const report: OperationReport = {
    engine: 'mupdf',
    steps: [
      'mupdf:open',
      ...(erased.rectCount > 0 ? ['mupdf:redact', 'mupdf:save'] : []),
      'load',
      ...(written.embeddedFonts.length > 0 ? ['text.font'] : []),
      ...(written.lineCount > 0 ? ['text.draw'] : []),
      'save',
      'pdfjs:verify',
    ],
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: written.bytes.byteLength,
    pageCount: erased.pageCount,
    // Both stages rewrite the file: MuPDF cannot save incrementally once redactions
    // are applied, and the draw stage is a full rewrite too, so no pre-edit revision
    // survives in the output.
    incremental: false,
  };
  return { bytes: written.bytes, report };
}

/**
 * The request's work, validated and merged per page: rectangles without an insert
 * are a plain deletion, lines without a rectangle are an insertion into existing
 * space, and both are legal (the model decides which it produces).
 */
function planRequest(request: TextEditRequest): readonly PageWork[] {
  const pages = new Map<
    number,
    { rects: Array<readonly [number, number, number, number]>; lines: TextEditInsertLine[] }
  >();
  const workFor = (
    pageIndex: number,
  ): { rects: Array<readonly [number, number, number, number]>; lines: TextEditInsertLine[] } => {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        pageIndex,
        engineMessage: `page index ${pageIndex} is not a 0-based page number`,
      });
    }
    const existing = pages.get(pageIndex);
    if (existing !== undefined) return existing;
    const created = { rects: [], lines: [] };
    pages.set(pageIndex, created);
    return created;
  };

  for (const erase of request.erase) {
    const page = workFor(erase.pageIndex);
    for (const rect of erase.rects) {
      const [x0, y0, x1, y1] = rect;
      // The measured failure mode of a bad rectangle is the whole page: a NaN
      // coordinate makes MuPDF clamp the annotation to the page box.
      if (!Number.isFinite(x0 + y0 + x1 + y1) || x1 <= x0 || y1 <= y0) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          pageIndex: erase.pageIndex,
          engineMessage: `erase rect [${x0}, ${y0}, ${x1}, ${y1}] is not a positive rectangle`,
        });
      }
      page.rects.push([x0, y0, x1, y1]);
    }
  }

  for (const insert of request.insert) {
    const page = workFor(insert.pageIndex);
    for (const line of insert.lines) {
      // A line with no text draws nothing; a reflow may emit one for spacing.
      if (line.text === '' && (line.words === undefined || line.words.length === 0)) continue;
      requireRange(line.fontSize, 1, 1000, 'fontSize');
      hexColour(line.color);
      for (const word of line.words ?? []) {
        if (!Number.isFinite(word.x)) {
          throw new ToolError('value-out-of-range', {
            engine: 'model',
            pageIndex: insert.pageIndex,
            engineMessage: `word placement for “${clipText(word.text)}” has no finite x`,
          });
        }
      }
      page.lines.push(line);
    }
  }

  const planned = [...pages]
    .sort(([left], [right]) => left - right)
    .map(([pageIndex, page]) => ({ pageIndex, rects: page.rects, lines: page.lines }));
  if (planned.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'text edit request carries neither a rectangle nor a line',
    });
  }
  return planned;
}

/** A numeric field outside its contract is refused, never clamped. */
function requireRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${field} must be between ${min} and ${max}`,
    });
  }
  return value;
}

/** `#rrggbb` → the three channels `rg` takes (`0 … 1`). */
function hexColour(value: string): readonly [number, number, number] {
  if (!HEX_COLOUR.test(value)) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `colour ${value} is not #rrggbb`,
    });
  }
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ];
}

/**
 * Erase stage (`4c`): one MuPDF pass that reads every touched page's box and
 * rotation, records what the rectangles cover, then applies the redactions and
 * writes the file once.
 *
 * The annotations are collected and destroyed **after** the save, exactly as
 * `redact.ts` does: `applyRedactions` consumes them inside the document while the
 * JS wrapper still holds wasm pointers.
 */
async function eraseStage(
  mupdf: Mupdf,
  bytes: Uint8Array,
  planned: readonly PageWork[],
  context: OperationContext,
): Promise<EraseResult> {
  const doc = openPdf(mupdf, bytes);
  const annotations: PDFAnnotation[] = [];
  const boxes = new Map<number, UserBox>();
  const erased: ErasedPage[] = [];
  let rectCount = 0;
  let pageCount = 0;
  let produced: Uint8Array;
  try {
    pageCount = doc.countPages();
    const total = planned.reduce((sum, page) => sum + page.rects.length, 0);

    for (const work of planned) {
      throwIfAborted(context.signal);
      if (work.pageIndex >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          pageIndex: work.pageIndex,
          engineMessage: `page index ${work.pageIndex} outside 0..${pageCount - 1}`,
        });
      }
      const page = doc.loadPage(work.pageIndex);
      try {
        const box = readPageBox(page);
        boxes.set(work.pageIndex, box);
        if (work.rects.length === 0) continue;

        const rotation = readPageRotation(page);
        const rects = work.rects.map((rect) => rectToPageSpace(box, rotation, rect));
        // Read the target text *before* the erase: those strings are the needles
        // the verification stage searches for in the produced file.
        const covered = readCoveredText(page, rects);
        erased.push({ pageIndex: work.pageIndex, covered: covered.perRect, before: covered.pageText });

        for (const rect of rects) {
          // `setRect` only, like the proven path in `ops/redact.ts`. Setting
          // `/QuadPoints` as well looked harmless and was not: it gave the
          // annotation a second geometry for `applyRedactions` to prefer, and the
          // erase then removed nothing while the file kept every original glyph
          // (measured: page 1 still carried the old paragraph after an "erased"
          // run). One geometry, the one the working path uses.
          const annotation = page.createAnnotation('Redact');
          annotation.setRect(rect);
          annotation.update();
          annotations.push(annotation);
          rectCount += 1;
          context.onProgress?.({
            phase: 'textEdit.erase',
            labelKey: 'op.progress.redact',
            done: rectCount,
            total,
          });
        }

        // The document's own fonts the new lines are drawn with, found *before* the
        // erase: removing the last text that used a font can drop it from the page's
        // resources, and the compacting save would then drop the font itself.
        const kept = keptFonts(page.getObject(), work.lines);

        // `black_boxes = false`: the erase is a content operation, not a painted
        // rectangle. Images stay (`REDACT_IMAGE_NONE` — spike case d kept a
        // 460 x 200 image pixel-identical) and so does line art
        // (`REDACT_LINE_ART_NONE`: spike case c survived its table rules, while
        // `REMOVE_IF_TOUCHED` destroyed 4,538 rule pixels of the same cell).
        page.applyRedactions(
          false,
          mupdf.PDFPage.REDACT_IMAGE_NONE,
          mupdf.PDFPage.REDACT_LINE_ART_NONE,
          mupdf.PDFPage.REDACT_TEXT_REMOVE,
        );
        const after = kept.length === 0 ? [] : pageFonts(page.getObject(), { forms: false });
        for (const font of kept) {
          if (!after.some((candidate) => font.names.some((name) => candidate.names.includes(name)))) {
            addPageResource(doc, page.getObject(), 'Font', 'TEKeep', font.ref);
          }
        }
      } finally {
        page.destroy();
      }
    }

    throwIfAborted(context.signal);
    if (rectCount === 0) {
      // Nothing to erase: the input goes on unchanged (insert-only edit), so the
      // engine does not rewrite a file it did not change.
      produced = bytes;
    } else {
      context.onProgress?.({
        phase: 'textEdit.erase',
        labelKey: 'op.progress.redact.save',
        done: 0,
        total: 1,
      });
      produced = savePdf(doc, MUPDF_FULL_SAVE_OPTIONS);
    }
  } catch (error) {
    throw mapMupdfError(error, 'text-edit/erase');
  } finally {
    for (const annotation of annotations) annotation.destroy();
    doc.destroy();
  }
  throwIfAborted(context.signal);
  return { bytes: produced, pageCount, boxes, erased, rectCount };
}

/** One of the document's own fonts, drawn with the codes it already uses. */
interface DocumentFace {
  readonly ref: PDFObject;
  readonly name: string;
  readonly font: DocumentFont;
}

/** A face a line can be drawn with: embedded from bytes, a standard-14 face, or the document's own. */
type LineFace = EmbeddedFace | StandardFace | DocumentFace;

/** The show operator for `text` in `face`. */
function show(face: LineFace, text: string): string {
  return 'font' in face ? showText(face.font, text) : `${face.encode(text)} Tj`;
}

/** The document fonts `lines` name (`doc:<name>`), as the page refers to them now. */
function keptFonts(page: PDFObject, lines: readonly TextEditInsertLine[]): readonly DocumentFont[] {
  const names = new Set(
    lines
      .filter((line) => line.fontId.startsWith(DOCUMENT_FONT_PREFIX))
      .map((line) => line.fontId.slice(DOCUMENT_FONT_PREFIX.length)),
  );
  if (names.size === 0) return [];
  // Page-level fonts only: see `pageFonts` on resolving forms in a document that is
  // about to be redacted.
  const fonts = pageFonts(page, { forms: false });
  return [...names]
    .map((name) => findFont(fonts, name))
    .filter((font): font is DocumentFont => font !== null);
}

/**
 * Insert stage (`4e`): embed, draw, write.
 *
 * The produced bytes depend on the erased ones, never on the working document —
 * the erase step is what makes the block's old text unreachable, and re-saving the
 * original would put it back.
 */
async function writeStage(
  bytes: Uint8Array,
  planned: readonly PageWork[],
  boxes: ReadonlyMap<number, UserBox>,
  fontUrls: Readonly<Record<string, string>>,
  context: OperationContext,
): Promise<WriteResult> {
  const opened = await openForWrite(bytes);
  const { doc } = opened;
  const fonts = new Map<string, LineFace>();
  const embeddedFonts = new Set<string>();
  const substitutions = new Set<string>();
  const pages = planned.filter((page) => page.lines.length > 0);
  const pageList = pageObjects(doc);
  const total = pages.reduce((sum, page) => sum + page.lines.length, 0);
  let lineCount = 0;
  let justifiedLines = 0;

  try {
    for (const work of pages) {
      throwIfAborted(context.signal);
      const page = pageList[work.pageIndex];
      const box = boxes.get(work.pageIndex);
      if (page === undefined || box === undefined) {
        throw new ToolError('internal', {
          engine: 'mupdf',
          pageIndex: work.pageIndex,
          engineMessage: 'page geometry was not read before the write step',
        });
      }
      const resourceKeys = new Map<LineFace, string>();
      const operators: string[] = [];

      for (const line of work.lines) {
        const words = line.words !== undefined && line.words.length > 0 ? line.words : null;
        if (words === null && line.text === '') continue;
        const size = requireRange(line.fontSize, 1, 1000, 'fontSize');
        const [red, green, blue] = hexColour(line.color);
        const font = await lineFont(
          opened,
          page,
          work.pageIndex,
          line,
          fontUrls,
          fonts,
          embeddedFonts,
          substitutions,
          context.signal,
        );
        let key = resourceKeys.get(font);
        if (key === undefined) {
          key = addPageResource(doc, page, 'Font', 'TE', font.ref);
          resourceKeys.set(font, key);
        }

        // One loop for both shapes: a plain line is a single placement at its own
        // baseline start, a justified line is one placement per word (`text` then
        // only describes the line for the report). Drawing each word at its own x
        // is what makes the gaps — no space characters are involved, so the
        // extractor's own space heuristic is the only thing between the words.
        const placements: readonly { readonly text: string; readonly x: number }[] = words ?? [
          { text: line.text, x: line.x },
        ];
        for (const placement of placements) {
          if (placement.text === '') continue;
          const origin = topLeftToUserPoint(box, placement.x, line.y);
          operators.push(
            `q BT ${num(red)} ${num(green)} ${num(blue)} rg /${key} ${num(size)} Tf 1 0 0 1 ${num(origin.x)} ${num(origin.y)} Tm ${show(font, placement.text)} ET Q`,
          );
        }
        if (words !== null) justifiedLines += 1;
        lineCount += 1;
        context.onProgress?.({
          phase: 'textEdit.write',
          labelKey: 'op.progress.textEdit.write',
          done: lineCount,
          total,
        });
      }

      // One content stream per page, so a block does not leave one stream per line behind.
      if (operators.length > 0) appendPageContent(doc, page, operators.join('\n'));
    }

    throwIfAborted(context.signal);
    context.onProgress?.({
      phase: 'textEdit.write',
      labelKey: 'op.progress.textEdit.write',
      done: lineCount,
      total,
    });
    return {
      bytes: saveRewrite(doc, 'text-edit/write'),
      embeddedFonts: [...embeddedFonts],
      fonts: [...new Set([...fonts.values()].map((font) => font.name))],
      substitutions: [...substitutions],
      lineCount,
      justifiedLines,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'text-edit/write');
  } finally {
    doc.destroy();
  }
}

/**
 * The font one line is drawn with — **always one this operation embedded**, never
 * one read back from the document (a subset has no cmap: spike #3 variant A).
 *
 * Resolution order, and the report carries whatever the fallback cost:
 *   0. the id is `doc:<name>` → the page's own font of that name, when it has a code
 *      for every character of the line (`engines/doc-fonts.ts`); nothing is embedded;
 *   1. the id is in `request.fonts` → fetch that file (same origin) and embed it;
 *   2. the id names a standard face and this line's text is WinAnsi-encodable → that
 *      standard face (nothing is embedded; the text stays searchable);
 *   3. otherwise → Noto Sans from the pinned asset, reported as a substitution.
 *
 * Step 2 assigns duplicate work to duplicate ids only: the fan-out is per *face*,
 * so a block of twenty lines in one font embeds it once.
 */
async function lineFont(
  opened: WritableDocument,
  page: PDFObject,
  pageIndex: number,
  line: TextEditInsertLine,
  fontUrls: Readonly<Record<string, string>>,
  fonts: Map<string, LineFace>,
  embeddedFonts: Set<string>,
  substitutions: Set<string>,
  signal: AbortSignal,
): Promise<LineFace> {
  const { mupdf, doc } = opened;
  const requested = line.fontId;
  if (requested.startsWith(DOCUMENT_FONT_PREFIX)) {
    const name = requested.slice(DOCUMENT_FONT_PREFIX.length);
    const key = `doc:${pageIndex}:${name}`;
    let face = fonts.get(key);
    if (face === undefined) {
      const font = findFont(pageFonts(page), name);
      if (font !== null) {
        face = { ref: font.ref, name: font.names[0] ?? name, font };
        fonts.set(key, face);
      }
    }
    const text = line.words?.map((word) => word.text).join(' ') ?? line.text;
    if (face !== undefined && 'font' in face && encodes(face.font, text)) return face;
    substitutions.add(name);
    return notoFace(opened, fonts, embeddedFonts);
  }
  const url = typeof fontUrls[requested] === 'string' ? fontUrls[requested] : undefined;
  if (url !== undefined) {
    const cached = fonts.get(`file:${requested}`);
    if (cached !== undefined) return cached;
    const font = embedFontFile(mupdf, doc, requested, await fetchFontBytes(url, signal));
    fonts.set(`file:${requested}`, font);
    embeddedFonts.add(font.name);
    return font;
  }

  const member =
    STANDARD_14_MEMBERS[
      requested
        .trim()
        .toLowerCase()
        .replaceAll(/[\s_]+/gu, '-')
    ];
  if (member !== undefined) {
    const cached = fonts.get(`standard:${member}`);
    const font = cached ?? standardFace(mupdf, doc, member);
    if (cached === undefined) fonts.set(`standard:${member}`, font);
    if ('canEncode' in font && font.canEncode(line.text)) return font;
    // This line's text needs characters WinAnsi has no code for — `ğ ş ı İ` land
    // here. The substitution is reported rather than drawn as `.notdef` boxes.
    substitutions.add(requested);
  } else {
    substitutions.add(requested);
  }
  return notoFace(opened, fonts, embeddedFonts);
}

/** Noto Sans from the pinned asset, embedded once per document. */
async function notoFace(
  opened: WritableDocument,
  fonts: Map<string, LineFace>,
  embeddedFonts: Set<string>,
): Promise<LineFace> {
  const cached = fonts.get('noto');
  if (cached !== undefined) return cached;
  const noto = embedFontFile(opened.mupdf, opened.doc, NOTO_NAME, await notoSansBytes());
  fonts.set('noto', noto);
  embeddedFonts.add(noto.name);
  return noto;
}

/**
 * Verification (`4f`): re-open the **produced** bytes with pdf.js and measure the
 * three claims. pdf.js is a different engine with a different text pipeline, so a
 * pass here is evidence the file is readable elsewhere, not just inside the writer
 * that produced it. A failure throws — a file that fails its own check is never
 * handed back to the save path.
 */
async function verifyPages(
  erased: EraseResult,
  planned: readonly PageWork[],
  bytes: Uint8Array,
  context: OperationContext,
): Promise<VerificationResult> {
  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  const failures: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const inserted = planned.filter((page) => page.lines.length > 0);
  const total = erased.erased.length + inserted.length;
  let done = 0;

  try {
    if (handle.pageCount !== erased.pageCount) {
      failures.push(`page count changed: ${erased.pageCount} → ${handle.pageCount}`);
    }

    for (const page of erased.erased) {
      throwIfAborted(context.signal);
      const content = await handle.textContent(page.pageIndex);
      const text = searchableText(content.items.map((item) => item.text).join(''));

      // (i) nothing that started inside an erased rectangle may still be there.
      // Positional on purpose: it survives a phrase that legitimately occurs twice
      // on the page, where a plain substring test could not tell the copies apart.
      const box = erased.boxes.get(page.pageIndex);
      const work = planned.find((entry) => entry.pageIndex === page.pageIndex);
      const rects = work?.rects ?? [];
      if (box !== undefined) {
        const userRects = rects.map((rect) => topLeftRectToUserSpace(box, rect));
        /**
         * The replacement is drawn *where the old line was*, so of course it starts
         * inside an erased rectangle — that is what an edit is. The check therefore
         * excludes the text this operation itself drew, and it identifies that text
         * by its own content and baseline rather than by "anything in the rect":
         * anything else inside the rect is leftover glyphs, which is exactly the
         * defect `4c` exists to prevent. Without this the operation failed its own
         * verification on every successful edit (measured: the dialog reported
         * `page 0: text still starts inside an erased rectangle: “ÜSKÜDAR şubesi …”`).
         */
        // A justified line is drawn word by word, and a reader may report each word as
        // an item of its own: every word placement is ours too.
        const ours = (work?.lines ?? []).flatMap((line) => [
          { text: searchableText(line.text), x: line.x, y: line.y },
          ...(line.words ?? []).map((word) => ({ text: searchableText(word.text), x: word.x, y: line.y })),
        ]);
        for (const item of content.items) {
          if (item.text.trim() === '') continue;
          if (!userRects.some((rect) => insideRect(item.x, item.y, rect))) continue;
          const text = searchableText(item.text);
          const isOurs = ours.some(
            (line) =>
              text.length > 0 &&
              line.text.length > 0 &&
              (line.text.includes(text) || text.includes(line.text)) &&
              Math.abs(line.x - item.x) <= INSERTED_MATCH_TOLERANCE_PT &&
              Math.abs(box.height - line.y - item.y) <= INSERTED_MATCH_TOLERANCE_PT,
          );
          if (isOurs) continue;
          failures.push(
            `page ${page.pageIndex}: text still starts inside an erased rectangle: “${clipText(item.text)}”`,
          );
        }
      }

      // (i′) the strings the rectangles covered are gone from the page's text. A
      // needle that also occurred elsewhere on the page may survive once: only the
      // occurrence inside the rectangles had to disappear, so the count is what is
      // compared in that case.
      // The lines this operation drew are subtracted first: a replacement that
      // contains the old text (`2024` → `2024–2025`) puts the needle back on purpose.
      const before = searchableText(page.before);
      const drawn = (work?.lines ?? []).map((line) => searchableText(line.text));
      for (const needle of page.covered) {
        const wanted = searchableText(needle);
        if (wanted === '') continue;
        const occurrencesBefore = countOccurrences(before, wanted);
        const occurrencesAfter = Math.max(
          0,
          countOccurrences(text, wanted) -
            drawn.reduce((sum, line) => sum + countOccurrences(line, wanted), 0),
        );
        if (occurrencesAfter === 0 || (occurrencesBefore > 1 && occurrencesAfter < occurrencesBefore)) {
          removed.push(needle);
        } else {
          failures.push(`page ${page.pageIndex}: erased text is still searchable: “${clipText(needle)}”`);
        }
      }

      done += 1;
      context.onProgress?.({
        phase: 'textEdit.verify',
        labelKey: 'op.progress.textEdit.verify',
        done,
        total,
      });
    }

    // (ii) the new text is in the page's text content, so it can be selected and
    // searched — which is what an embedded subset with a `/ToUnicode` CMap buys.
    for (const page of inserted) {
      throwIfAborted(context.signal);
      const content = await handle.textContent(page.pageIndex);
      const text = searchableText(content.items.map((item) => item.text).join(''));
      for (const line of page.lines) {
        // A justified line is drawn word by word; the extractor is then free to
        // report the words with or without spaces between them, so the claim that
        // is checked (and the claim the report makes) is that its **characters
        // appear in order** — the words concatenated — not that a gap survived.
        const wanted = searchableText(
          line.words !== undefined && line.words.length > 0
            ? line.words.map((word) => word.text).join('')
            : line.text,
        );
        if (wanted === '') continue;
        if (text.includes(wanted)) added.push(line.text);
        else
          failures.push(`page ${page.pageIndex}: inserted text is not extractable: “${clipText(line.text)}”`);
      }
      done += 1;
      context.onProgress?.({
        phase: 'textEdit.verify',
        labelKey: 'op.progress.textEdit.verify',
        done,
        total,
      });
    }

    if (failures.length > 0) {
      throw new ToolError('verification-failed', {
        engine: 'pdfjs',
        engineMessage: failures.join(' · '),
      });
    }
    return { removed, added, pageCount: handle.pageCount };
  } catch (error) {
    // The reader's own failures travel through the shared mapper (the adapter's own
    // vocabulary is private); the checks above already are `ToolError`s and pass
    // through unchanged.
    throw toToolError(error, 'pdfjs');
  } finally {
    await handle.destroy();
  }
}

/**
 * What the page-space rectangles cover, read **before** the erase: one string per
 * rectangle plus the page's own text, which the verifier uses as the baseline for
 * its duplicate test.
 *
 * The glyph rule is `redact.ts`'s — a character counts as covered when half or
 * more of its quad lies inside the rectangle — so "inside the box" means the same
 * thing on both sides of the edit.
 */
function readCoveredText(
  page: MupdfPage,
  rects: readonly Rect[],
): { readonly perRect: readonly string[]; readonly pageText: string } {
  const buffers: string[][] = rects.map(() => []);
  const text = page.toStructuredText('preserve-whitespace');
  try {
    text.walk({
      onChar(c: string, _origin, _font, _size, quad: Quad) {
        if (c.trim() === '') return;
        for (const [index, rect] of rects.entries()) {
          if (coveredShare(quad, rect) < HALF_COVERED) continue;
          const buffer = buffers[index];
          if (buffer !== undefined) buffer.push(c);
        }
      },
    });
    return { perRect: buffers.map((chars) => chars.join('')), pageText: text.asText() };
  } finally {
    text.destroy();
  }
}

/** Share of a glyph quad's box that lies inside the rectangle (0 … 1). */
function coveredShare(quad: Quad, rect: Rect): number {
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

function insideRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
}

/**
 * Text as the verifier compares it: whitespace removed.
 *
 * Two reasons, both measured. pdf.js splits one visual line into several items at
 * font changes and kerning gaps, so `"Mer" + "haba"` is one line in the file; and
 * MuPDF writes the gap between words as a positioned space that a reader may report
 * as nothing at all. Removing whitespace asks the question the check is about —
 * are the *characters* still there — instead of a question about spacing.
 */
function searchableText(value: string): string {
  return value.replace(/\s+/gu, '');
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let total = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return total;
    total += 1;
    from = at + needle.length;
  }
}

/** A list of needles as one report parameter, clipped to a line of interface text. */
function clipList(values: readonly string[]): string {
  const joined = values
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .join(' | ');
  return joined === '' ? '—' : clipText(joined);
}

function clipText(value: string): string {
  return value.length <= MAX_NOTE_TEXT ? value : `${value.slice(0, MAX_NOTE_TEXT - 1)}…`;
}

/**
 * Font bytes from `request.fonts`, **same origin only** (the app makes no
 * third-party request, and a font is not the place to start). The URL is resolved
 * against the document's own origin, so a relative `/fonts/…` path works and an
 * absolute one is checked rather than trusted.
 */
async function fetchFontBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const origin = globalThis.location?.origin;
  if (origin === undefined) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      path: url,
      engineMessage: 'no document origin to resolve the font URL against',
    });
  }
  let resolved: URL;
  try {
    resolved = new URL(url, origin);
  } catch (error) {
    throw new ToolError(
      'font-missing',
      { engine: 'mupdf', path: url, engineMessage: `font URL cannot be resolved: ${url}` },
      { cause: error },
    );
  }
  if (resolved.origin !== origin) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      path: url,
      engineMessage: `font URL leaves the app origin: ${resolved.origin}`,
    });
  }

  let response: Response;
  try {
    response = await fetch(resolved, { signal });
  } catch (error) {
    // An abort is the caller's cancellation, not a missing asset.
    throwIfAborted(signal);
    throw new ToolError(
      'asset-missing',
      {
        engine: 'mupdf',
        path: url,
        engineMessage: `font request failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new ToolError('asset-missing', {
      engine: 'mupdf',
      path: url,
      engineMessage: `font asset responded ${response.status}`,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}
