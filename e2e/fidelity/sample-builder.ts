/**
 * A small page-drawing helper for the fidelity samples: it writes real PDF content streams with
 * MuPDF, in the **top-left, y-down page space** a designer thinks in (points; `y` of a text run
 * is its baseline), and takes care of everything a hand-written file would get wrong.
 *
 *  - Text is real, selectable text. Each face is a TrueType file embedded by MuPDF as a Type0 /
 *    Identity-H font with a `ToUnicode` map (`doc.addFont`), and the content stream carries glyph
 *    ids as hex strings (`font.encodeCharacter`). Turkish letters (ç ğ ı İ ö ş ü) therefore
 *    extract exactly as typed. A character the face has no glyph for throws, so a sample can
 *    never silently lose a letter.
 *  - The faces are the Noto Sans weights of `@expo-google-fonts/noto-sans`, a dependency of the
 *    repository root. LibreOffice bundles Noto Sans too, so a converted DOCX renders with the
 *    very face the PDF drew.
 *  - Justified lines are one `TJ` array whose kerning numbers widen the space glyphs. A composite
 *    font has no word spacing (`Tw` only acts on one-byte code 32), so this is the only honest way
 *    to get a justified line that still extracts as one line.
 *  - Nothing is random or dated: the same calls always give the same bytes.
 *
 * `mupdf` is a dependency of `packages/pdf-core`, not of the repository root, so it is loaded
 * through that workspace's manifest (the way `tool-fixture.ts` does) and described by the minimal
 * structural types below.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** An A4 page in points (210 × 297 mm). */
export const A4 = { width: 595.28, height: 841.89 } as const;

/** Red, green, blue, each 0–255. */
export type Rgb = readonly [number, number, number];

/** The embedded faces: every one a Noto Sans weight that LibreOffice also bundles. */
export type FontFace = 'regular' | 'italic' | 'semibold' | 'bold' | 'boldItalic';

/** Where each face sits in the `@expo-google-fonts/noto-sans` package, and the name it is embedded under. */
const FACES: Readonly<Record<FontFace, { readonly file: string; readonly name: string }>> = {
  regular: { file: '400Regular/NotoSans_400Regular.ttf', name: 'NotoSans-Regular' },
  italic: { file: '400Regular_Italic/NotoSans_400Regular_Italic.ttf', name: 'NotoSans-Italic' },
  semibold: { file: '600SemiBold/NotoSans_600SemiBold.ttf', name: 'NotoSans-SemiBold' },
  bold: { file: '700Bold/NotoSans_700Bold.ttf', name: 'NotoSans-Bold' },
  boldItalic: { file: '700Bold_Italic/NotoSans_700Bold_Italic.ttf', name: 'NotoSans-BoldItalic' },
};

// ---------------------------------------------------------------------------
// the slice of MuPDF this file uses (the root does not declare `mupdf`)
// ---------------------------------------------------------------------------

/** A MuPDF font: glyph lookup and advances. */
interface MuFont {
  encodeCharacter(codePoint: number): number;
  /** The advance of glyph `gid` in em (1 = the font size). */
  advanceGlyph(gid: number, wmode?: number): number;
  destroy(): void;
}

/** A MuPDF pixmap: a raw sample buffer MuPDF owns. */
export interface MuPixmap {
  getPixels(): Uint8ClampedArray;
  getStride(): number;
  getWidth(): number;
  getHeight(): number;
  asJPEG(quality: number): Uint8Array;
  destroy(): void;
}

/** A PDF object a resource dictionary may hold. */
interface MuPdfObject {
  destroy(): void;
}

/** A buffer MuPDF owns. */
interface MuBuffer {
  asUint8Array(): Uint8Array;
  destroy(): void;
}

/** A structured-text page. */
interface MuStructuredText {
  asText(): string;
  destroy(): void;
}

/** A loaded page. */
interface MuPage {
  getBounds(): number[];
  toPixmap(matrix: number[], colorspace: unknown, alpha: boolean, showExtras: boolean): MuPixmap;
  toStructuredText(options?: string): MuStructuredText;
  createLink(bbox: number[], uri: string): { destroy(): void };
  destroy(): void;
}

/** An opened document. */
interface MuDocument {
  countPages(): number;
  loadPage(index: number): MuPage;
  destroy(): void;
}

/** A document being written. */
interface MuPdfDocument extends MuDocument {
  addFont(font: MuFont): MuPdfObject;
  addImage(image: unknown): MuPdfObject;
  addPage(mediabox: number[], rotate: number, resources: unknown, contents: string): MuPdfObject;
  insertPage(at: number, page: MuPdfObject): void;
  setLanguage(lang: string): void;
  subsetFonts(): void;
  saveToBuffer(options: string): MuBuffer;
}

/** The module's surface used here. */
interface MuModule {
  readonly Matrix: { scale(x: number, y: number): number[] };
  readonly ColorSpace: { readonly DeviceRGB: unknown };
  readonly Font: new (name: string, data: Uint8Array) => MuFont;
  readonly Image: new (source: MuPixmap | Uint8Array) => unknown;
  readonly Pixmap: new (colorspace: unknown, bbox: number[], alpha: boolean) => MuPixmap;
  readonly Document: {
    openDocument(bytes: Uint8Array, magic: string): MuDocument;
  };
  readonly PDFDocument: new () => MuPdfDocument;
}

/** The root declares neither `mupdf` nor (for resolution) any path to it: borrow `pdf-core`'s. */
const coreRequire = createRequire(new URL('../../packages/pdf-core/package.json', import.meta.url));
/** The root does declare the font package. */
const rootRequire = createRequire(new URL('../../package.json', import.meta.url));

let mupdfModule: Promise<MuModule> | null = null;

/** The MuPDF module, loaded once (the memo keeps the failed attempt out: a rejection is dropped). */
export function loadMupdfModule(): Promise<MuModule> {
  if (mupdfModule === null) {
    mupdfModule = (import(pathToFileURL(coreRequire.resolve('mupdf')).href) as Promise<MuModule>).catch(
      (error: unknown) => {
        mupdfModule = null;
        throw error;
      },
    );
  }
  return mupdfModule;
}

const fontBytes = new Map<FontFace, Uint8Array>();

/** A face's TrueType bytes, read once from the installed font package. */
function faceBytes(face: FontFace): Uint8Array {
  let bytes = fontBytes.get(face);
  if (bytes === undefined) {
    const root = dirname(rootRequire.resolve('@expo-google-fonts/noto-sans/package.json'));
    bytes = new Uint8Array(readFileSync(join(root, FACES[face].file)));
    fontBytes.set(face, bytes);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// content-stream arithmetic
// ---------------------------------------------------------------------------

/** A number the way a content stream wants it: at most three decimals, no exponent. */
function num(value: number): string {
  const text = value.toFixed(3);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** `r g b` in 0…1. */
function rgb(color: Rgb): string {
  return color.map((channel) => num(channel / 255)).join(' ');
}

/** The Bézier constant for a quarter circle. */
const KAPPA = 0.5522847498;

/**
 * The widest extra gap, in em, a justified line may add to each space. Past it the line is left
 * ragged: a gap wider than about 0.8 em is where MuPDF's text extraction starts a new line, so a
 * wider stretch would split one printed line into one extracted line per word.
 */
const MAX_SPACE_STRETCH = 0.45;

/** How a shape is painted. At least one of `fill` / `stroke` is expected. */
export interface ShapeStyle {
  readonly fill?: Rgb;
  readonly stroke?: Rgb;
  /** Stroke width in points; 1 when omitted. */
  readonly lineWidth?: number;
  /** Fill and stroke opacity, 0–1 (an `ExtGState` `ca`/`CA`). Opaque when omitted. */
  readonly opacity?: number;
}

/** How a straight line is stroked. */
export interface LineStyle {
  readonly stroke: Rgb;
  readonly lineWidth?: number;
  /** `[on, off]` dash lengths in points. */
  readonly dash?: readonly [number, number];
}

/** One text run's options. */
export interface TextOptions {
  /** Stretch the run to exactly this width by widening its spaces (a justified line); a line that would need gaps wider than `MAX_SPACE_STRETCH` em stays left-aligned. */
  readonly justifyTo?: number;
}

/** One page being drawn; `SamplePdf.save` turns it into a real page. */
export class PageBuilder {
  readonly width: number;
  readonly height: number;
  /** Content-stream operators, in paint order. */
  readonly ops: string[] = [];
  /** Hyperlinks, in top-left page space: `[x0, y0, x1, y1]`. */
  readonly links: { readonly rect: number[]; readonly uri: string }[] = [];

  constructor(
    private readonly owner: SamplePdf,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
  }

  /** PDF user-space y (from the bottom) of a top-left y. */
  private flip(y: number): number {
    return this.height - y;
  }

  /**
   * One line of text: `(x, y)` is the left end of the baseline. `color` fills the glyphs.
   * With `justifyTo`, the run is stretched to that width through its spaces.
   */
  text(
    x: number,
    y: number,
    size: number,
    face: FontFace,
    color: Rgb,
    text: string,
    options: TextOptions = {},
  ): void {
    const setup = `${rgb(color)} rg BT /${this.owner.fontName(face)} ${num(size)} Tf ${num(x)} ${num(this.flip(y))} Td`;
    const spaces = [...text].filter((character) => character === ' ').length;
    const extra = (options.justifyTo ?? 0) - this.owner.measure(face, size, text);
    if (options.justifyTo === undefined || spaces === 0 || extra / spaces > size * MAX_SPACE_STRETCH) {
      this.ops.push(`${setup} ${this.owner.glyphHex(face, text)} Tj ET`);
      return;
    }
    // A TJ number is subtracted from the pen position, in thousandths of the font size.
    const adjust = num((-extra / spaces / size) * 1000);
    const words = text.split(' ');
    const parts = words.map((word, index) =>
      index < words.length - 1
        ? `${this.owner.glyphHex(face, `${word} `)} ${adjust}`
        : this.owner.glyphHex(face, word),
    );
    this.ops.push(`${setup} [${parts.join(' ')}] TJ ET`);
  }

  /** A run whose **right** end sits at `xRight`. */
  textRight(xRight: number, y: number, size: number, face: FontFace, color: Rgb, text: string): void {
    this.text(xRight - this.owner.measure(face, size, text), y, size, face, color, text);
  }

  /** A run centred on `xCenter`. */
  textCentered(xCenter: number, y: number, size: number, face: FontFace, color: Rgb, text: string): void {
    this.text(xCenter - this.owner.measure(face, size, text) / 2, y, size, face, color, text);
  }

  /**
   * A paragraph wrapped to `width`, one `text` run per line, `leading` apart. With `justify`
   * every line but the last is stretched to the full width. Returns the baseline of the line
   * *after* the last one (where the next block may start).
   */
  paragraph(
    x: number,
    y: number,
    width: number,
    size: number,
    leading: number,
    face: FontFace,
    color: Rgb,
    text: string,
    options: { readonly justify?: boolean } = {},
  ): number {
    const lines = this.owner.wrap(face, size, width, text);
    let baseline = y;
    for (const [index, line] of lines.entries()) {
      const last = index === lines.length - 1;
      this.text(
        x,
        baseline,
        size,
        face,
        color,
        line,
        options.justify === true && !last ? { justifyTo: width } : {},
      );
      baseline += leading;
    }
    return baseline;
  }

  /** Close the current path and paint it as `style` says. */
  private paint(style: ShapeStyle, path: string): void {
    const { fill, stroke } = style;
    const operator = fill !== undefined && stroke !== undefined ? 'B' : fill !== undefined ? 'f' : 'S';
    const colors = [
      fill === undefined ? '' : `${rgb(fill)} rg`,
      stroke === undefined ? '' : `${rgb(stroke)} RG ${num(style.lineWidth ?? 1)} w`,
    ]
      .filter((part) => part !== '')
      .join(' ');
    if (style.opacity === undefined) {
      this.ops.push(`q ${colors} ${path} ${operator} Q`);
      return;
    }
    this.ops.push(`q /${this.owner.opacityName(style.opacity)} gs ${colors} ${path} ${operator} Q`);
  }

  /** A rectangle with its top-left corner at `(x, y)`. */
  rect(x: number, y: number, width: number, height: number, style: ShapeStyle): void {
    this.paint(style, `${num(x)} ${num(this.flip(y + height))} ${num(width)} ${num(height)} re`);
  }

  /** A rectangle with quarter-circle corners of `radius`. */
  roundRect(x: number, y: number, width: number, height: number, radius: number, style: ShapeStyle): void {
    const r = Math.min(radius, width / 2, height / 2);
    const k = r * KAPPA;
    const left = x;
    const right = x + width;
    const top = this.flip(y);
    const bottom = this.flip(y + height);
    const path = [
      `${num(left + r)} ${num(top)} m`,
      `${num(right - r)} ${num(top)} l`,
      `${num(right - r + k)} ${num(top)} ${num(right)} ${num(top - r + k)} ${num(right)} ${num(top - r)} c`,
      `${num(right)} ${num(bottom + r)} l`,
      `${num(right)} ${num(bottom + r - k)} ${num(right - r + k)} ${num(bottom)} ${num(right - r)} ${num(bottom)} c`,
      `${num(left + r)} ${num(bottom)} l`,
      `${num(left + r - k)} ${num(bottom)} ${num(left)} ${num(bottom + r - k)} ${num(left)} ${num(bottom + r)} c`,
      `${num(left)} ${num(top - r)} l`,
      `${num(left)} ${num(top - r + k)} ${num(left + r - k)} ${num(top)} ${num(left + r)} ${num(top)} c`,
      'h',
    ].join(' ');
    this.paint(style, path);
  }

  /** A circle of `radius` centred on `(cx, cy)`. */
  circle(cx: number, cy: number, radius: number, style: ShapeStyle): void {
    this.roundRect(cx - radius, cy - radius, radius * 2, radius * 2, radius, style);
  }

  /** A straight stroke from `(x1, y1)` to `(x2, y2)`. */
  line(x1: number, y1: number, x2: number, y2: number, style: LineStyle): void {
    const dash = style.dash === undefined ? '' : ` [${num(style.dash[0])} ${num(style.dash[1])}] 0 d`;
    this.ops.push(
      `q ${rgb(style.stroke)} RG ${num(style.lineWidth ?? 1)} w${dash} ${num(x1)} ${num(this.flip(y1))} m ${num(x2)} ${num(this.flip(y2))} l S Q`,
    );
  }

  /** A raster picture stretched over the box with top-left `(x, y)`. */
  image(x: number, y: number, width: number, height: number, pixmap: MuPixmap): void {
    const index = this.owner.imageResource(pixmap);
    this.ops.push(
      `q ${num(width)} 0 0 ${num(height)} ${num(x)} ${num(this.flip(y + height))} cm /Im${index} Do Q`,
    );
  }

  /** A real `/Link` annotation with a `/URI` action over the box with top-left `(x, y)`. */
  link(x: number, y: number, width: number, height: number, uri: string): void {
    this.links.push({ rect: [x, y, x + width, y + height], uri });
  }
}

/** A document being built: pages drawn with `PageBuilder`, then `save`. */
export class SamplePdf {
  private readonly pages: PageBuilder[] = [];
  private readonly fontFaces: {
    readonly face: FontFace;
    readonly font: MuFont;
    readonly object: MuPdfObject;
  }[] = [];
  private readonly pixmaps: MuPixmap[] = [];
  private readonly imageObjects: MuPdfObject[] = [];
  private readonly imageIndex = new Map<MuPixmap, number>();
  private readonly opacityList: number[] = [];
  private readonly advances = new Map<string, number>();

  private constructor(
    private readonly mupdf: MuModule,
    private readonly doc: MuPdfDocument,
  ) {}

  /** A new, empty document. */
  static async create(): Promise<SamplePdf> {
    const mupdf = await loadMupdfModule();
    return new SamplePdf(mupdf, new mupdf.PDFDocument());
  }

  /** Append a page; A4 portrait when no size is given. */
  addPage(width: number = A4.width, height: number = A4.height): PageBuilder {
    const page = new PageBuilder(this, width, height);
    this.pages.push(page);
    return page;
  }

  /** The face's MuPDF font, embedded in the document on first use. */
  private fontOf(face: FontFace): { readonly font: MuFont; readonly index: number } {
    let index = this.fontFaces.findIndex((entry) => entry.face === face);
    if (index < 0) {
      const font = new this.mupdf.Font(FACES[face].name, faceBytes(face));
      this.fontFaces.push({ face, font, object: this.doc.addFont(font) });
      index = this.fontFaces.length - 1;
    }
    const entry = this.fontFaces[index];
    if (entry === undefined) throw new Error('unreachable: font entry missing');
    return { font: entry.font, index };
  }

  /** The resource name of an embedded face. */
  fontName(face: FontFace): string {
    return `F${this.fontOf(face).index}`;
  }

  /** The resource name of an opacity state, registered on first use. */
  opacityName(opacity: number): string {
    let index = this.opacityList.indexOf(opacity);
    if (index < 0) {
      this.opacityList.push(opacity);
      index = this.opacityList.length - 1;
    }
    return `GS${index}`;
  }

  /** The image-XObject index of a pixmap, added to the document on first use. */
  imageResource(pixmap: MuPixmap): number {
    let index = this.imageIndex.get(pixmap);
    if (index === undefined) {
      this.imageObjects.push(this.doc.addImage(new this.mupdf.Image(pixmap)));
      index = this.imageObjects.length - 1;
      this.imageIndex.set(pixmap, index);
    }
    return index;
  }

  /** Glyph ids of `text` as one hex string `<0123…>`; throws on a character the face lacks. */
  glyphHex(face: FontFace, text: string): string {
    const { font } = this.fontOf(face);
    let hex = '';
    for (const character of text) {
      const codePoint = character.codePointAt(0) as number;
      const gid = font.encodeCharacter(codePoint);
      if (gid === 0) {
        throw new Error(
          `${FACES[face].name} has no glyph for U+${codePoint.toString(16).toUpperCase()} in "${text}"`,
        );
      }
      hex += gid.toString(16).padStart(4, '0');
    }
    return `<${hex}>`;
  }

  /** The advance of `text` at `size` points, in points. */
  measure(face: FontFace, size: number, text: string): number {
    const { font } = this.fontOf(face);
    let total = 0;
    for (const character of text) {
      const key = `${face}:${character}`;
      let advance = this.advances.get(key);
      if (advance === undefined) {
        advance = font.advanceGlyph(font.encodeCharacter(character.codePointAt(0) as number));
        this.advances.set(key, advance);
      }
      total += advance;
    }
    return total * size;
  }

  /** `text` broken greedily at spaces into lines no wider than `width` at `size`. */
  wrap(face: FontFace, size: number, width: number, text: string): string[] {
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (current !== '' && this.measure(face, size, candidate) > width) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current !== '') lines.push(current);
    return lines;
  }

  /**
   * An RGB picture of `width` × `height` samples, each from `paint(x, y)`. The pixmap lives as
   * long as the document and is freed by `save`.
   */
  pixmap(width: number, height: number, paint: (x: number, y: number) => Rgb): MuPixmap {
    const pixmap = new this.mupdf.Pixmap(this.mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
    const samples = pixmap.getPixels();
    const stride = pixmap.getStride();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [red, green, blue] = paint(x, y);
        const at = y * stride + x * 3;
        samples[at] = red;
        samples[at + 1] = green;
        samples[at + 2] = blue;
      }
    }
    this.pixmaps.push(pixmap);
    return pixmap;
  }

  /** The finished file; the builder is spent afterwards. */
  save(): Uint8Array {
    try {
      const font: Record<string, MuPdfObject> = {};
      for (const [index, entry] of this.fontFaces.entries()) font[`F${index}`] = entry.object;
      const xobject: Record<string, MuPdfObject> = {};
      for (const [index, object] of this.imageObjects.entries()) xobject[`Im${index}`] = object;
      const extGState: Record<string, unknown> = {};
      for (const [index, opacity] of this.opacityList.entries()) {
        extGState[`GS${index}`] = { Type: 'ExtGState', ca: opacity, CA: opacity };
      }
      const resources = { Font: font, XObject: xobject, ExtGState: extGState };
      for (const [index, page] of this.pages.entries()) {
        const object = this.doc.addPage(
          [0, 0, page.width, page.height],
          0,
          resources,
          `${page.ops.join('\n')}\n`,
        );
        this.doc.insertPage(index, object);
      }
      for (const [index, page] of this.pages.entries()) {
        if (page.links.length === 0) continue;
        const loaded = this.doc.loadPage(index);
        for (const link of page.links) loaded.createLink(link.rect, link.uri);
        loaded.destroy();
      }
      this.doc.setLanguage('tr-TR');
      this.doc.subsetFonts();
      return copyOut(this.doc.saveToBuffer('garbage=compact,compress'));
    } finally {
      for (const pixmap of this.pixmaps) pixmap.destroy();
      for (const entry of this.fontFaces) entry.font.destroy();
      this.doc.destroy();
    }
  }
}

/** The bytes of a MuPDF-owned buffer, copied out before it is freed. */
function copyOut(buffer: MuBuffer): Uint8Array {
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

/**
 * The text of every page, in MuPDF's reading order (content-stream order, lines top to bottom
 * within a block), one string per page: trailing blanks trimmed, blocks kept apart by an empty line.
 */
export async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await loadMupdfModule();
  const doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  try {
    const texts: string[] = [];
    for (let index = 0; index < doc.countPages(); index += 1) {
      const page = doc.loadPage(index);
      const structured = page.toStructuredText();
      texts.push(
        structured
          .asText()
          .split('\n')
          .map((line) => line.trimEnd())
          .join('\n')
          .trim(),
      );
      structured.destroy();
      page.destroy();
    }
    return texts;
  } finally {
    doc.destroy();
  }
}

/**
 * A scan of a PDF: every page rendered at `dpi` into a JPEG and placed, full-page, in a new
 * document of the same page sizes. There is no text layer in the result and no vector content —
 * what a flatbed scanner (or a "print to image") produces.
 */
export async function rasterizeToImagePdf(bytes: Uint8Array, dpi: number): Promise<Uint8Array> {
  const mupdf = await loadMupdfModule();
  const source = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  const scan = new mupdf.PDFDocument();
  try {
    const scale = dpi / 72;
    for (let index = 0; index < source.countPages(); index += 1) {
      const page = source.loadPage(index);
      const [left = 0, top = 0, right = 0, bottom = 0] = page.getBounds();
      const width = right - left;
      const height = bottom - top;
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        false,
      );
      const image = scan.addImage(new mupdf.Image(pixmap.asJPEG(90)));
      pixmap.destroy();
      page.destroy();
      const object = scan.addPage(
        [0, 0, width, height],
        0,
        { XObject: { Im0: image } },
        `q ${num(width)} 0 0 ${num(height)} 0 0 cm /Im0 Do Q\n`,
      );
      scan.insertPage(index, object);
    }
    return copyOut(scan.saveToBuffer('garbage=compact,compress'));
  } finally {
    scan.destroy();
    source.destroy();
  }
}
