/**
 * The read side of text editing: **MuPDF structured text →
 * the neutral `PageTextInput`** the model builder consumes, plus the font metric
 * tables the UI and the plan path need.
 *
 * Two engines answer here, each for the one thing only it can say:
 *
 *   - **MuPDF** (`engines/mupdf.ts`) walks the page and reports every glyph's box,
 *     baseline origin, size and face — the same walk the redaction and text-edit
 *     writers rely on;
 *   - **pdf.js** (`engines/pdfjs-handle.ts`) answers one optional fact — the page's
 *     text fill colour — through its operator list. That part is best-effort: a page
 *     read must not fail because a second engine could not be brought up, so the
 *     colour falls back to black and the returned map stays empty (`readTextColors`).
 *
 * ## Space
 *
 * Everything here returns geometry in the app's page space — **unrotated PDF user
 * space with a top-left origin**, `[x0, y0, x1, y1]` ascending, unit = point, `y`
 * counting down (`packages/pdf-text-engine/src/types.ts`, `ops/types.ts > PageRect`).
 * MuPDF reports in *rotated page space* (origin at the page box's top-left corner
 * after `/Rotate`, `y` down), so every value crosses one explicit conversion; the
 * forward table it inverts, and that table in words, are on `toUserX`/`toUserY`.
 *
 * ## Boundaries
 *
 * Both engines get a **disposable copy** of the bytes: MuPDF through
 * `openPdf`, pdf.js through `openWithPdfjs` — the master buffer is never handed to an
 * engine. No third-party origin is contacted: the font files this module
 * fetches are same-origin only, refused otherwise (`loadFontMetrics`).
 */

import type { PDFPage as MupdfPage, PDFDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import {
  type BlockInput,
  type CharInput,
  createFontCatalog,
  type FontCandidate,
  type FontCatalog,
  type FontMetrics,
  type LineInput,
  type PageTextInput,
  type Rect,
} from 'pdf-text-engine';
import { metricsFor } from 'pdf-text-engine/fonts';
import { NOTO_ASSETS } from './assets';
import { loadMupdf, mapMupdfError, openPdf } from './engines/mupdf';
import { openWithPdfjs } from './engines/pdfjs-handle';
import { pageGeometry } from './ops/stamp';
import { type OperationContext, throwIfAborted } from './ops/types';

/**
 * The faces this app can embed, as catalogue entries. The ids, families and weights
 * are the ones `pdf-text-engine`'s own defaults use (`fonts.ts > DEFAULT_FONT_CANDIDATES`),
 * so `matchFont` ranks these faces exactly as it ranks its own and
 * `candidateMatchesFontName` reads the same tokens out of a reported font name.
 *
 * The file paths are not repeated here: they are `assets.ts`'s, so a move of the asset
 * directory cannot leave the catalogue pointing at a path nothing serves.
 */
const TEXT_FACES: readonly FontCandidate[] = [
  { id: 'noto-sans', family: 'sans', bold: false, italic: false, filePath: NOTO_ASSETS.regular },
  { id: 'noto-sans-semibold', family: 'sans', bold: true, italic: false, filePath: NOTO_ASSETS.semiBold },
];

/**
 * The font files this app can embed for a substitution, as served paths (`id → path`).
 * Noto Sans is the face the product already embeds for stamps, the OCR layer and
 * header/footer text, and it covers Turkish — the reason it is here at all, since the
 * standard 14 cannot spell `ş ğ ı İ` (`assets.ts > NOTO_ASSETS`).
 */
export const TEXT_FONT_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  TEXT_FACES.map((face) => [face.id, face.filePath]),
);

/** The same faces as the engine's catalogue entries — what `matchFont` picks from. */
export const TEXT_FONT_CANDIDATES: readonly FontCandidate[] = TEXT_FACES;

/** The page's `/Rotate` as quarter turns (the model's own vocabulary). */
type Rotation = 0 | 90 | 180 | 270;

/** The unrotated page box in PDF user space: `/CropBox`, falling back to `/MediaBox`. */
interface PageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Everything MuPDF answers for one page, before the colour pass. */
interface MeasuredPage {
  readonly box: PageBox;
  readonly rotation: Rotation;
  readonly blocks: readonly BlockInput[];
  /** Per block index, the colour most of its glyphs were drawn with; a block of whitespace only is absent. */
  readonly colors: Readonly<Record<number, string>>;
}

/**
 * One page's text as the model builder wants it (`PageTextInput`).
 *
 * `width`/`height` are the unrotated page box — `/CropBox`, falling back to `/MediaBox`
 * — which is the box the writer's own `readPageBox` uses and the box the viewer's
 * pointer conversion flips about (`PdfViewerPane.pointToPage`). The engine's type
 * comment calls the same number "the MediaBox width"; they are one number for every
 * file that has no CropBox, and where they differ, staying with the reader/writer
 * convention is what keeps the geometry in one space.
 *
 * `colors` is per block: the colour most of the block's glyphs were drawn with, as
 * MuPDF reports it. A block without one gets pdf.js's page-dominant text colour; an
 * **empty** map means no colour was detected and the consumer falls back to black (the
 * UI reports the substitution). Reading the page's one dominant colour for every block
 * turned a red heading black when it was edited.
 */
export async function readPageText(
  bytes: Uint8Array,
  pageIndex: number,
  context: OperationContext,
): Promise<PageTextInput> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);
  const doc = openPdf(mupdf, bytes);
  let page: MeasuredPage;
  try {
    const geometry = readGeometry(doc, pageIndex);
    page = readMupdfPage(doc, pageIndex, geometry.box, geometry.rotation);
  } finally {
    // A wasm document that is never destroyed keeps its objects in the emscripten heap
    // for the life of the tab, and nothing in the app can see that memory (the other
    // half of the disposable-copy rule). `openPdf` hands back one wrapper per document, so one destroy is
    // one release.
    doc.destroy();
  }
  throwIfAborted(context.signal);
  const glyphColors = page.colors;
  // pdf.js is asked only when MuPDF reported no colour for some block; its answer is
  // one colour for the whole page, so a block MuPDF did colour keeps its own.
  const colors =
    Object.keys(glyphColors).length === page.blocks.length
      ? glyphColors
      : { ...(await readTextColors(bytes, pageIndex, context, page.blocks.length)), ...glyphColors };
  throwIfAborted(context.signal);
  return {
    pageIndex,
    width: page.box.width,
    height: page.box.height,
    rotation: page.rotation,
    blocks: page.blocks,
    colors,
  };
}

/**
 * The text of several pages through **one** MuPDF document, for operations that read a
 * whole document (find and replace). Colours are the glyphs' own (`blockColors`); a
 * block MuPDF reported no colour for falls back to black in the model, and pdf.js is
 * not opened per page.
 */
export async function readDocumentText(
  bytes: Uint8Array,
  pages: readonly number[],
  context: OperationContext,
  onPage?: (done: number, total: number) => void,
): Promise<readonly PageTextInput[]> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);
  const doc = openPdf(mupdf, bytes);
  try {
    const read: PageTextInput[] = [];
    for (const pageIndex of pages) {
      throwIfAborted(context.signal);
      const geometry = readGeometry(doc, pageIndex);
      const page = readMupdfPage(doc, pageIndex, geometry.box, geometry.rotation);
      read.push({
        pageIndex,
        width: page.box.width,
        height: page.box.height,
        rotation: page.rotation,
        blocks: page.blocks,
        colors: page.colors,
      });
      onPage?.(read.length, pages.length);
    }
    return read;
  } finally {
    doc.destroy();
  }
}

/**
 * Everything MuPDF answers for one page. Every MuPDF failure — an index outside the
 * document, a damaged page, a box that cannot be read — leaves through
 * `mapMupdfError`, and an abort keeps the shape `throwIfAborted` gave it: a cancelled
 * read is the caller's own cancellation, not an engine fault to be re-labelled.
 */
function readMupdfPage(doc: PDFDocument, pageIndex: number, box: PageBox, rotation: Rotation): MeasuredPage {
  try {
    const page = doc.loadPage(pageIndex);
    try {
      return { box, rotation, ...readBlocks(page, box, rotation) };
    } finally {
      page.destroy();
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    throw mapMupdfError(error, 'readPageText');
  }
}

/** `throwIfAborted`'s error, recognised so the mapping above never rewrites it. */
function isAbort(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The page geometry the text walk needs: the **unrotated** page box and `/Rotate`,
 * read through `pageGeometry` in `ops/stamp.ts` — the implementation the stamp,
 * page-box and redaction writers measure against, so one geometry convention serves the
 * codebase.
 *
 * `getInheritable` fails with `Cannot read properties of null (reading
 * '_fromPDFObjectKeep')` when it is called on the shared `PDFObject.Null`, which has no
 * document. `pageGeometry` only calls it on the page dictionary itself and reads every
 * entry through `resolved()` (`engines/mupdf-write.ts`), so a page without a
 * `/CropBox` falls back to its `/MediaBox` instead.
 */
function readGeometry(doc: PDFDocument, pageIndex: number): { box: PageBox; rotation: Rotation } {
  const count = doc.countPages();
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= count) {
    throw new ToolError('range-invalid', {
      engine: 'mupdf',
      pageIndex,
      engineMessage: `page ${pageIndex} of ${count}`,
    });
  }
  try {
    const geometry = pageGeometry(doc.findPage(pageIndex));
    return { box: geometry.box, rotation: geometry.rotation };
  } catch (error) {
    throw mapMupdfError(error, 'readPageText');
  }
}

/**
 * `preserve-whitespace` — the flag every MuPDF text read in this repo uses
 *. It
 * keeps the characters MuPDF would otherwise fold into gaps, so the model can measure
 * word gaps from glyph origins instead of guessing them, and it drops nothing the page
 * actually drew. The installed build (mupdf 1.28.1) accepts the string verbatim.
 */
const STRUCTURED_TEXT_FLAGS = 'preserve-whitespace';

/**
 * The page's text, block → line → char, in the app's page space.
 *
 * MuPDF reports every callback's geometry in **page space** — the displayed page, its
 * origin at the page box's top-left corner after `/Rotate`, `u` rightwards and `v`
 * downwards — so each character's quad and baseline origin, and the line and block
 * boxes, are converted here and nowhere else.
 *
 * Every block and line the walk reports holds at least one character (MuPDF opens a
 * line with its first glyph; a text object with nothing to draw reports no block at
 * all), and a block of whitespace only still reports its spaces. Characters are emitted
 * **as reported**, whitespace included — the model filters word-gap characters itself,
 * and dropping them here would erase the gaps it measures words by.
 *
 * `colors` is per block index: the colour most of the block's non-whitespace glyphs were
 * drawn with. A block of whitespace only has none, and is absent from the map.
 */
function readBlocks(
  page: MupdfPage,
  box: PageBox,
  rotation: Rotation,
): { readonly blocks: readonly BlockInput[]; readonly colors: Readonly<Record<number, string>> } {
  const blocks: BlockInput[] = [];
  const colors: Record<number, string> = {};
  // The walk is strictly nested begin/end pairs, so each `begin…` starts the state its
  // `end…` hands over.
  let blockQuad: Rect = [0, 0, 0, 0];
  let lines: LineInput[] = [];
  let inks = new Map<string, number>();
  let lineQuad: Rect = [0, 0, 0, 0];
  let chars: CharInput[] = [];
  let baseline = 0;

  const text = page.toStructuredText(STRUCTURED_TEXT_FLAGS);
  try {
    text.walk({
      beginTextBlock(bbox) {
        blockQuad = cornersToUserRect(box, rotation, [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ]);
        lines = [];
        inks = new Map();
      },
      beginLine(bbox) {
        lineQuad = cornersToUserRect(box, rotation, [
          [bbox[0], bbox[1]],
          [bbox[2], bbox[3]],
        ]);
        chars = [];
      },
      // The binding builds every glyph colour as an RGB triple (`colorFromNumber`), although
      // its declared `Color` also allows grey and CMYK shapes.
      onChar(ch, origin, font, size, quad, color: [number, number, number]) {
        const at = pointToUser(box, rotation, origin);
        if (chars.length === 0) baseline = at[1];
        const fill = hexColor(color[0], color[1], color[2]);
        if (ch.trim() !== '') inks.set(fill, (inks.get(fill) ?? 0) + 1);
        chars.push({
          ch,
          quad: cornersToUserRect(box, rotation, [
            [quad[0], quad[1]],
            [quad[2], quad[3]],
            [quad[4], quad[5]],
            [quad[6], quad[7]],
          ]),
          origin: at,
          size,
          fontName: font.getName(),
          color: fill,
        });
      },
      endLine() {
        lines.push({ chars, quad: lineQuad, baseline });
      },
      endTextBlock() {
        const color = dominantColor(inks);
        if (color !== null) colors[blocks.length] = color;
        blocks.push({ quad: blockQuad, lines });
      },
    });
  } finally {
    text.destroy();
  }
  return { blocks, colors };
}

/**
 * Undo MuPDF's displayed-page rotation, retaining user-space x coordinates.
 * toUserY additionally flips PDF user-space y into the model's downward axis.
 * The production-reader probe verifies every glyph at all four quarter turns,
 * including a CropBox offset; block grouping itself may differ by rotation.
 */
function toUserX(box: PageBox, rotation: Rotation, u: number, v: number): number {
  switch (rotation) {
    case 90:
      return box.x + v;
    case 180:
      return box.x + box.width - u;
    case 270:
      return box.x + box.width - v;
    default:
      return box.x + u;
  }
}

/** Inverse page rotation followed by the model's top-left y conversion. */
function toUserY(box: PageBox, rotation: Rotation, u: number, v: number): number {
  switch (rotation) {
    case 90:
      return box.y + box.height - u;
    case 180:
      return box.y + box.height - v;
    case 270:
      return box.y + u;
    default:
      return box.y + v;
  }
}

/** A MuPDF corner in page space: `[u, v]`. */
type Corner = readonly [number, number];

/**
 * The page-space corners of a MuPDF box (`u0 v0 u1 v1`) or glyph quad (upper-left,
 * upper-right, lower-left, lower-right) → the ascending user-space rect they span.
 *
 * Every corner is converted and the result is bounded, which is the only correct
 * answer for a rotated or skewed glyph (under `/Rotate 90` the corner that was
 * upper-left is no longer the smallest `x`), and it keeps the quad's own shape out of
 * the model: the engine's `CharInput.quad` is a box, not a quad.
 */
function cornersToUserRect(box: PageBox, rotation: Rotation, corners: readonly Corner[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [u, v] of corners) {
    const x = toUserX(box, rotation, u, v);
    const y = toUserY(box, rotation, u, v);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

/** A page-space baseline origin → the same point in the app's page space. */
function pointToUser(box: PageBox, rotation: Rotation, [u, v]: Corner): Corner {
  return [toUserX(box, rotation, u, v), toUserY(box, rotation, u, v)];
}

/**
 * The fill colour the initial graphics state carries: black (ISO 32000-2 §8.6.8), which
 * is also the model's colour for a block whose colour is unknown (`#000000`, lower case).
 */
const DEFAULT_COLOR = '#000000';

/**
 * The operators whose arguments carry the **fill** colour. The stroke operators are
 * different ops (`setStrokeRGBColor` and friends) and are deliberately not read: a
 * page's rules, table borders and underlines are not its text.
 */
const FILL_OP_NAMES: readonly string[] = [
  'setFillRGBColor',
  'setFillGray',
  'setFillCMYKColor',
  'setFillColor',
  'setFillColorN',
];

/**
 * Every operator that shows text. All four variants are listed and looked up by name:
 * a build that merged the next-line forms still counts its own, and a name the build
 * does not have simply never matches.
 */
const TEXT_OP_NAMES: readonly string[] = [
  'showText',
  'showSpacedText',
  'nextLineShowText',
  'nextLineSetSpacingShowText',
];

/** `#rrggbb`, either case — what pdf.js produces and what the model accepts. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The page's text fill colour, from **pdf.js** (`openWithPdfjs` → `operatorList`), as a
 * map of block index → `#rrggbb` for every block of the page.
 *
 * The operator list is read as the stream it is: the fill colour in force is
 * remembered at each fill operator, and the colour that the most text operators ran
 * under is the page's colour. Measured on the pinned build (pdf.js 6.3.289): the
 * evaluator rewrites every device-space fill colour through `Util.makeHexColor` before
 * it reaches the list, so the argument that arrives is a single `#rrggbb` **string**
 * (`["#14141f"]`); numeric components are still read, because that shape is pdf.js's to
 * change, and `1`/`3`/`4` of them are DeviceGray/RGB/CMYK.
 *
 * The colour is one value per page repeated for every block index, not a per-block
 * measurement: an operator list carries no geometry, so a block's own ink cannot be
 * tied to an operator. A page whose text uses several colours therefore reports its
 * dominant one, and the caller can see that no per-block colour was available.
 *
 * When pdf.js cannot answer — the engine chunk is not there, the document will not
 * parse in it, the page shows no text at all — this returns an **empty map**, and the
 * caller uses black. That fallback is the point: the colours are a nicety, the page's
 * text is the operation. An abort is not a fallback and is rethrown.
 */
async function readTextColors(
  bytes: Uint8Array,
  pageIndex: number,
  context: OperationContext,
  blockCount: number,
): Promise<Readonly<Record<number, string>>> {
  try {
    const handle = await openWithPdfjs(bytes, { signal: context.signal });
    let color: string | null;
    try {
      const { fnArray, argsArray } = await handle.operatorList(pageIndex);
      const ids = await loadOperatorIds();
      const fillOps = idsOf(ids, FILL_OP_NAMES);
      const textOps = idsOf(ids, TEXT_OP_NAMES);
      let current = DEFAULT_COLOR;
      const counts = new Map<string, number>();
      for (const [index, op] of fnArray.entries()) {
        if (fillOps.has(op)) {
          current = fillColorOf(argsArray[index] ?? []) ?? current;
          continue;
        }
        if (textOps.has(op)) counts.set(current, (counts.get(current) ?? 0) + 1);
      }
      color = dominantColor(counts);
    } finally {
      // The handle owns a pdf.js worker and a full copy of the document.
      await handle.destroy();
    }
    if (color === null) return {};
    const colors: Record<number, string> = {};
    for (let index = 0; index < blockCount; index += 1) colors[index] = color;
    return colors;
  } catch (error) {
    // Documented fallback: no pdf.js, no colour. Cancellation still leaves.
    if (context.signal.aborted || isAbort(error)) throw error;
    return {};
  }
}

/** pdf.js's operator enum by name, or `undefined` for a name this build dropped. */
type OperatorIds = Readonly<Record<string, number | undefined>>;

/**
 * The operator enum of the pdf.js chunk (`import('pdfjs-dist').OPS`, verified on
 * 6.3.289: `setFillRGBColor` 59, `showText` 44). This is the **only** fact this module
 * takes from pdf.js directly; the document conversation itself stays in the adapter
 * (`openWithPdfjs`).
 *
 * The import is dynamic for the reason the adapter's is: pdf.js is a 1.5 MB engine
 * chunk that must not join the shell's first paint. It is read through
 * a shape of our own so that a build which does not export the enum degrades to the
 * colour fallback instead of failing to compile, and a name it does not have leaves a
 * gap instead of matching the wrong operator.
 */
async function loadOperatorIds(): Promise<OperatorIds> {
  const module = (await import('pdfjs-dist')) as unknown as { readonly OPS?: OperatorIds };
  return module.OPS ?? {};
}

/** The ids of the named operators, skipping every name this build does not have. */
function idsOf(ids: OperatorIds, names: readonly string[]): ReadonlySet<number> {
  const found = new Set<number>();
  for (const name of names) {
    const id = ids[name];
    if (typeof id === 'number') found.add(id);
  }
  return found;
}

/**
 * The colour a fill operator's arguments carry, or `null` when they are not a colour a
 * viewer would paint — a pattern name in place of components, an indexed space whose
 * palette we cannot resolve, an empty argument list. A `null` leaves the colour in
 * force unchanged, which is what a viewer does with a paint the operator list does not
 * describe in components.
 */
function fillColorOf(args: readonly unknown[]): string | null {
  const head = args[0];
  if (typeof head === 'string') return HEX_COLOR.test(head) ? head.toLowerCase() : null;

  // pdf.js may hand the components as the argument list itself or as its first entry.
  const values = Array.isArray(head) ? head : args;
  const numbers: number[] = [];
  for (const value of values) {
    if (typeof value !== 'number') return null;
    numbers.push(value);
  }

  const [c0 = 0, c1 = 0, c2 = 0, c3 = 0] = numbers;
  if (numbers.length === 1) return hexColor(c0, c0, c0);
  if (numbers.length === 3) return hexColor(c0, c1, c2);
  if (numbers.length === 4) {
    // DeviceCMYK → DeviceRGB, the conversion a viewer applies without an ICC profile
    // (ISO 32000-2 §8.6.8): r = (1 − c)(1 − k), and so on.
    return hexColor((1 - c0) * (1 - c3), (1 - c1) * (1 - c3), (1 - c2) * (1 - c3));
  }
  return null;
}

/** DeviceRGB components in 0…1 → `#rrggbb`, lower case, rounded per channel. */
function hexColor(r: number, g: number, b: number): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * The colour the most text operators ran under; `null` when the page showed no text.
 * Ties keep the colour seen first, so the answer is deterministic for a page whose
 * text is drawn in equal amounts of two colours.
 */
function dominantColor(counts: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [color, count] of counts) {
    if (count > bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Metric tables for the given served font files (`id → served path`, which is
 * `TEXT_FONT_FILES`).
 *
 * **Same origin only**: the path is resolved against the document's own origin,
 * so a `/fonts/…` path works and an absolute URL that leaves the origin is refused
 * rather than fetched. `ops/text-edit.ts > fetchFontBytes` enforces the same rule for
 * the same asset directory, so the two halves of an edit cannot disagree about where a
 * font may come from.
 *
 * `missing` is computed for the **empty string** and is therefore always empty: a
 * metric table is fetched before any text is chosen, and which code points a *text*
 * lacks is a per-text question the engine answers later —
 * `matchFont(style, text, catalog).missingGlyphs`, or `metricsFor(font, bytes, text)`.
 */
export async function loadFontMetrics(
  files: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, FontMetrics>>> {
  const metrics: Record<string, FontMetrics> = {};
  for (const [id, path] of Object.entries(files)) {
    metrics[id] = await readFontMetrics(await fetchFontProgram(path), path);
  }
  return metrics;
}

/**
 * The metric table of one font programme: MuPDF's font object for the glyph lookups (the
 * engine that will embed the same bytes) and the font header for the vertical metrics
 * (`metricsFor`). MuPDF is already loaded for the text source itself, so this adds no
 * engine to the font path. The only failure that is this function's own is a programme
 * that cannot be read, which would silently produce wrong line breaks if it were allowed
 * through as an empty table.
 */
export async function readFontMetrics(bytes: Uint8Array, path: string): Promise<FontMetrics> {
  const mupdf = await loadMupdf();
  try {
    return metricsFor(new mupdf.Font(path, bytes), bytes);
  } catch (cause) {
    if (cause instanceof ToolError) throw cause;
    throw new ToolError(
      'unsupported',
      {
        engine: 'mupdf',
        path,
        engineMessage: messageOf(cause),
      },
      { cause },
    );
  }
}

/**
 * One font file's bytes, from this origin only (the app makes no third-party
 * request, and a substitution font is not the place to start). The error label is
 * `fonts`, so one grep finds every font-asset failure.
 */
async function fetchFontProgram(path: string): Promise<Uint8Array> {
  const origin = globalThis.location?.origin;
  if (origin === undefined) {
    throw new ToolError('internal', {
      engine: 'fonts',
      path,
      engineMessage: 'no document origin to resolve the font URL against',
    });
  }
  let resolved: URL;
  try {
    resolved = new URL(path, origin);
  } catch (cause) {
    throw new ToolError(
      'font-missing',
      { engine: 'fonts', path, engineMessage: `font URL cannot be resolved: ${path}` },
      { cause },
    );
  }
  if (resolved.origin !== origin) {
    throw new ToolError('internal', {
      engine: 'fonts',
      path,
      engineMessage: `font URL leaves the app origin: ${resolved.origin}`,
    });
  }

  let response: Response;
  try {
    response = await fetch(resolved);
  } catch (cause) {
    throw new ToolError(
      'asset-missing',
      { engine: 'fonts', path, engineMessage: `font request failed: ${messageOf(cause)}` },
      { cause },
    );
  }
  if (!response.ok) {
    throw new ToolError('asset-missing', {
      engine: 'fonts',
      path,
      engineMessage: `font asset responded ${response.status}`,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** The metric tables and catalogue, fetched once for the session. */
export interface TextFontSet {
  readonly catalog: FontCatalog;
  readonly metrics: Readonly<Record<string, FontMetrics>>;
}

let textFonts: Promise<TextFontSet> | null = null;

/**
 * A ready-to-use catalogue + metrics pair for the UI and the plan path: the faces this
 * app can embed (`TEXT_FONT_CANDIDATES`) with a coverage provider wired to their tables,
 * which is what `createFontCatalog(TEXT_FONT_CANDIDATES, provider)` builds.
 *
 * The two files are fetched once per session (as every engine asset is). A failed load
 * is not cached, so a retry once the assets are there works instead of remembering the
 * failure forever.
 */
export async function loadTextFonts(): Promise<TextFontSet> {
  textFonts ??= loadMetricsAndCatalog();
  try {
    return await textFonts;
  } catch (error) {
    textFonts = null;
    throw error;
  }
}

async function loadMetricsAndCatalog(): Promise<TextFontSet> {
  const metrics = await loadFontMetrics(TEXT_FONT_FILES);
  return {
    catalog: createFontCatalog(TEXT_FONT_CANDIDATES, (candidate) => metrics[candidate.id] ?? null),
    metrics,
  };
}

/** An engine's message, for `engineMessage` (diagnostics only). */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
