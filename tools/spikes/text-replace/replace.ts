/**
 * Erase + re-write for spike #3 (throwaway, `PLAN.md §9/K21`).
 *
 * Two MuPDF paths, exactly the two the product would use (`PLAN.md §5/4c`):
 *   1. erase   — a `Redact` annotation over the region + `applyRedactions()`
 *                (`K14`'s "MuPDF full rewrite" branch; `black_boxes = false` so the
 *                background stays, and image/line-art policies are explicit).
 *   2. re-write — our own content stream appended to the page (a "writer step"),
 *                because MuPDF.js has no insert-text-at-a-point API: the text is
 *                emitted as `Tm`/`Tj` with glyph ids from the font we embed.
 */
import type { Mupdf, PdfDoc, PdfFont, PdfObjectT, PdfPage } from './engine';
import type { GLine, Mat6, Rect4, Vec2 } from './textmodel';
import { mapPoint, mapVector, measuredLineWidth, unit } from './textmodel';

export interface EraseOptions {
  readonly imageMethod: number;
  readonly lineArtMethod: number;
  readonly textMethod: number;
  readonly blackBoxes?: boolean;
}

export interface EraseResult {
  readonly annotRect: Rect4;
  readonly annotQuads: number;
}

/**
 * MuPDF annotation geometry is in **rotated page space** (origin top-left, y down),
 * the same space as structured text — `pdf_set_annot_rect` applies the page
 * transform internally. Measured in this spike: passing PDF user space instead
 * silently redacts empty space (the annot is consumed and nothing is removed).
 */
export function eraseRegion(
  doc: PdfDoc,
  pageIndex: number,
  pageRect: Rect4,
  options: EraseOptions,
): EraseResult {
  const page = doc.loadPage(pageIndex);
  const annot = page.createAnnotation('Redact');
  annot.setRect(pageRect);
  // fz_quad order is ul, ur, ll, lr — in page space "upper" means the smaller y.
  annot.setQuadPoints([
    [pageRect[0], pageRect[1], pageRect[2], pageRect[1], pageRect[0], pageRect[3], pageRect[2], pageRect[3]],
  ]);
  // Read the stored rect back *before* applying: `applyRedactions` consumes the
  // annotation, after which the object is no longer bound to the page.
  const annotRect = annot.getRect() as Rect4;
  page.applyRedactions(
    options.blackBoxes ?? false,
    options.imageMethod,
    options.lineArtMethod,
    options.textMethod,
  );
  return { annotRect, annotQuads: 1 };
}

export interface Placement {
  /** baseline origin of the first line, page space */
  readonly origin: Vec2;
  /** unit writing direction, page space */
  readonly dir: Vec2;
  /** unit "next line" direction, page space */
  readonly down: Vec2;
  readonly size: number;
  /** baseline-to-baseline distance in page units */
  readonly leading: number;
  /** widest original line, page units — the wrap width */
  readonly maxWidth: number;
  readonly color: [number, number, number];
  readonly lines: number;
}

/** Derive the insertion geometry from the lines that are about to be erased. */
export function placementFromLines(lines: readonly GLine[], fallbackLeading: number): Placement | null {
  if (lines.length === 0) return null;
  const first = lines[0];
  const firstChar = first?.chars[0];
  if (!first || !firstChar) return null;
  const ul: Vec2 = [firstChar.quad[0] ?? 0, firstChar.quad[1] ?? 0];
  const ll: Vec2 = [firstChar.quad[4] ?? 0, firstChar.quad[5] ?? 0];
  const down = unit([ll[0] - ul[0], ll[1] - ul[1]]);
  const sorted = [...lines].sort((a, b) => {
    const oa = a.chars[0]?.origin ?? [0, 0];
    const ob = b.chars[0]?.origin ?? [0, 0];
    return (oa[0] - ob[0]) * down[0] + (oa[1] - ob[1]) * down[1];
  });
  const originLine = sorted[0];
  const secondLine = sorted[1];
  const firstOrigin = originLine?.chars[0]?.origin ?? [0, 0];
  const secondOrigin = secondLine?.chars[0]?.origin ?? null;
  const leading =
    secondOrigin === null
      ? fallbackLeading
      : Math.abs((secondOrigin[0] - firstOrigin[0]) * down[0] + (secondOrigin[1] - firstOrigin[1]) * down[1]);
  return {
    origin: originLine?.chars[0]?.origin ?? [0, 0],
    dir: originLine?.dir ?? [1, 0],
    down,
    size: firstChar.size,
    leading: leading > 0 ? leading : fallbackLeading,
    maxWidth: Math.max(...lines.map((line) => measuredLineWidth(line))),
    color: [0.13, 0.13, 0.16],
    lines: lines.length,
  };
}

export interface FontChoice {
  readonly font: PdfFont;
  /** when set, the content stream references this existing resource instead of re-embedding */
  readonly existingResource?: string;
}

export interface WriteResult {
  readonly lines: readonly string[];
  readonly wrapped: number;
  readonly overflowed: boolean;
  readonly missingChars: readonly string[];
  readonly fontResource: string;
  readonly embeddedNewFont: boolean;
  readonly streamBytes: number;
  readonly textMatrix: Mat6;
}

function firstFreeResourceName(fonts: PdfObjectT): string {
  for (let index = 0; index < 64; index += 1) {
    const candidate = `SpikeText${index}`;
    if (fonts.get(candidate).isNull()) return candidate;
  }
  throw new Error('no free font resource name');
}

function resourceDictionary(doc: PdfDoc, page: PdfPage): PdfObjectT {
  const pageObj = page.getObject();
  let resources = pageObj.get('Resources');
  if (!resources.isNull()) return resources;
  const inherited = pageObj.getInheritable('Resources');
  resources = doc.newDictionary();
  if (!inherited.isNull()) {
    inherited.forEach((value, key) => {
      if (typeof key === 'string') resources.put(key, value);
    });
  }
  pageObj.put('Resources', resources);
  return resources;
}

function appendContentStream(mupdf: Mupdf, doc: PdfDoc, page: PdfPage, content: string): number {
  const pageObj = page.getObject();
  const buffer = new mupdf.Buffer(content);
  const stream = doc.addStream(buffer, null);
  buffer.destroy();
  const contents = pageObj.get('Contents');
  if (contents.isNull()) {
    pageObj.put('Contents', stream);
  } else if (contents.isArray()) {
    contents.push(stream);
  } else {
    const array = doc.newArray();
    array.push(contents);
    array.push(stream);
    pageObj.put('Contents', array);
  }
  return content.length;
}

/** Ad-hoc content stream: one text object, one `Tm`/`Tj` pair per line. */
function buildContentStream(
  resource: string,
  size: number,
  color: [number, number, number],
  matrix: Mat6,
  hexLines: readonly string[],
  leadingPdf: number,
  downPdf: Vec2,
): string {
  const parts = ['q', 'BT', `/${resource} ${size} Tf`, `${color[0]} ${color[1]} ${color[2]} rg`];
  hexLines.forEach((hex, index) => {
    const x = matrix[4] + downPdf[0] * leadingPdf * index;
    const y = matrix[5] + downPdf[1] * leadingPdf * index;
    parts.push(`${matrix[0]} ${matrix[1]} ${matrix[2]} ${matrix[3]} ${x} ${y} Tm`, `${hex} Tj`);
  });
  parts.push('ET', 'Q', '');
  return parts.join('\n');
}

export interface WrapOptions {
  /** maximum line width in page units */
  readonly maxWidth: number;
  /** maximum lines the block box can hold */
  readonly maxLines: number;
  /** page units per glyph advance unit (calibrated once per run) */
  readonly advanceScale: number;
}

function wrapText(
  font: PdfFont,
  text: string,
  size: number,
  options: WrapOptions,
): { lines: string[]; missingChars: string[] } {
  const missing: string[] = [];
  const width = (value: string): number => {
    let total = 0;
    for (const char of value) {
      const gid = font.encodeCharacter(char);
      if (gid === 0 && !missing.includes(char)) missing.push(char);
      total += font.advanceGlyph(gid, 0) * options.advanceScale * size;
    }
    return total;
  };
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (current !== '' && width(candidate) > options.maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return { lines, missingChars: [...missing] };
}

function encodeHex(font: PdfFont, value: string): string {
  let hex = '';
  for (const char of value) {
    const gid = font.encodeCharacter(char);
    hex += gid.toString(16).padStart(4, '0');
  }
  return `<${hex}>`;
}

export function writeTextBlock(
  mupdf: Mupdf,
  doc: PdfDoc,
  pageIndex: number,
  placement: Placement,
  text: string,
  choice: FontChoice,
  wrap: WrapOptions,
): WriteResult {
  const page = doc.loadPage(pageIndex);
  const inverse = mupdf.Matrix.invert(page.getTransform()) as Mat6;
  const originPdf = mapPoint(inverse, placement.origin);
  const dirPdf = unit(mapVector(inverse, placement.dir));
  const downPdf = unit(mapVector(inverse, placement.down));
  const leadingPdf = placement.leading * Math.hypot(...mapVector(inverse, placement.down));

  const { lines, missingChars } = wrapText(choice.font, text, placement.size, wrap);
  // `Tm` is a pure rotation: the glyph scale comes from `Tf`, and the text
  // rendering matrix is the product of the two (scaling both gives size² ).
  const matrix: Mat6 = [dirPdf[0], dirPdf[1], -dirPdf[1], dirPdf[0], originPdf[0], originPdf[1]];

  let resource = choice.existingResource ?? '';
  let embeddedNewFont = false;
  if (resource === '') {
    const resources = resourceDictionary(doc, page);
    let fonts = resources.get('Font');
    if (!fonts.isDictionary()) {
      fonts = doc.newDictionary();
      resources.put('Font', fonts);
    }
    resource = firstFreeResourceName(fonts);
    fonts.put(resource, doc.addFont(choice.font));
    embeddedNewFont = true;
  }

  const hexLines = lines.map((line) => encodeHex(choice.font, line));
  const content = buildContentStream(
    resource,
    placement.size,
    placement.color,
    matrix,
    hexLines,
    leadingPdf,
    downPdf,
  );
  const streamBytes = appendContentStream(mupdf, doc, page, content);

  return {
    lines,
    wrapped: lines.length,
    overflowed: lines.length > wrap.maxLines,
    missingChars,
    fontResource: resource,
    embeddedNewFont,
    streamBytes,
    textMatrix: matrix,
  };
}

/** Glyph-advance calibration: MuPDF's `advanceGlyph` unit against a measured line width. */
export function calibrateAdvance(
  font: PdfFont,
  line: GLine,
): { advanceScale: number; measured: number; advanceSum: number } {
  let advanceSum = 0;
  for (const char of line.chars) {
    advanceSum += font.advanceGlyph(font.encodeCharacter(char.c), 0);
  }
  const measured = measuredLineWidth(line);
  const size = line.chars[0]?.size ?? 1;
  if (advanceSum <= 0 || measured <= 0) return { advanceScale: 1, measured, advanceSum };
  return { advanceScale: measured / (advanceSum * size), measured, advanceSum };
}
