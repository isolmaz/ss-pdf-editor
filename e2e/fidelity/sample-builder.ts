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
  readonly ColorSpace: { readonly DeviceRGB: unknown; readonly DeviceGray: unknown };
  readonly Font: new (name: string, data: Uint8Array) => MuFont;
  readonly Image: new (source: MuPixmap | Uint8Array, mask?: unknown) => unknown;
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
  /** Fill by the even-odd rule (nested subpaths make holes) instead of non-zero winding. */
  readonly evenOdd?: boolean;
  /** `[on, off]` dash lengths of the outline, in points. */
  readonly dash?: readonly [number, number];
  /** Line cap of the outline; butt when omitted. */
  readonly cap?: 'round' | 'square';
}

/** One step of a free-form path, in top-left page space. */
export type PathStep =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

/** How a straight line is stroked. */
export interface LineStyle {
  readonly stroke: Rgb;
  readonly lineWidth?: number;
  /** `[on, off]` dash lengths in points. */
  readonly dash?: readonly [number, number];
  /** Line cap; butt when omitted (round caps turn a `[0, gap]` dash into dots). */
  readonly cap?: 'round' | 'square';
}

/** One text run's options. */
export interface TextOptions {
  /** Stretch the run to exactly this width by widening its spaces (a justified line); a line that would need gaps wider than `MAX_SPACE_STRETCH` em stays left-aligned. */
  readonly justifyTo?: number;
  /** Turn the run by this many degrees, counter-clockwise on the page, about `(x, y)`. */
  readonly rotate?: number;
  /** Fill opacity of the glyphs, 0–1. Opaque when omitted. */
  readonly opacity?: number;
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
    const angle = ((options.rotate ?? 0) * Math.PI) / 180;
    const place =
      options.rotate === undefined
        ? `${num(x)} ${num(this.flip(y))} Td`
        : `${num(Math.cos(angle))} ${num(Math.sin(angle))} ${num(-Math.sin(angle))} ${num(Math.cos(angle))} ${num(x)} ${num(this.flip(y))} Tm`;
    const state = options.opacity === undefined ? '' : `q /${this.owner.opacityName(options.opacity)} gs `;
    const close = options.opacity === undefined ? '' : ' Q';
    const setup = `${state}${rgb(color)} rg BT /${this.owner.fontName(face)} ${num(size)} Tf ${place}`;
    const spaces = [...text].filter((character) => character === ' ').length;
    const extra = (options.justifyTo ?? 0) - this.owner.measure(face, size, text);
    if (options.justifyTo === undefined || spaces === 0 || extra / spaces > size * MAX_SPACE_STRETCH) {
      this.ops.push(`${setup} ${this.owner.glyphHex(face, text)} Tj ET${close}`);
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
    this.ops.push(`${setup} [${parts.join(' ')}] TJ ET${close}`);
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
    const star = style.evenOdd === true ? '*' : '';
    const operator =
      fill !== undefined && stroke !== undefined ? `B${star}` : fill !== undefined ? `f${star}` : 'S';
    const dash = style.dash === undefined ? '' : ` [${num(style.dash[0])} ${num(style.dash[1])}] 0 d`;
    const cap = style.cap === 'round' ? ' 1 J' : style.cap === 'square' ? ' 2 J' : '';
    const colors = [
      fill === undefined ? '' : `${rgb(fill)} rg`,
      stroke === undefined ? '' : `${rgb(stroke)} RG ${num(style.lineWidth ?? 1)} w${dash}${cap}`,
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

  /** An ellipse of radii `rx`, `ry` centred on `(cx, cy)`. */
  ellipse(cx: number, cy: number, rx: number, ry: number, style: ShapeStyle): void {
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    this.path(
      [
        ['M', cx + rx, cy],
        ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
        ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
        ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
        ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
        ['Z'],
      ],
      style,
    );
  }

  /** A closed polygon through `points`. */
  polygon(points: readonly (readonly [number, number])[], style: ShapeStyle): void {
    const [first, ...rest] = points;
    if (first === undefined) throw new Error('a polygon needs points');
    this.path([['M', first[0], first[1]], ...rest.map(([x, y]) => ['L', x, y] as const), ['Z']], style);
  }

  /** A free-form path of lines and cubic Béziers; `['Z']` closes a subpath. */
  path(steps: readonly PathStep[], style: ShapeStyle): void {
    const text = steps
      .map((step) => {
        switch (step[0]) {
          case 'M':
            return `${num(step[1])} ${num(this.flip(step[2]))} m`;
          case 'L':
            return `${num(step[1])} ${num(this.flip(step[2]))} l`;
          case 'C':
            return `${num(step[1])} ${num(this.flip(step[2]))} ${num(step[3])} ${num(this.flip(step[4]))} ${num(step[5])} ${num(this.flip(step[6]))} c`;
          default:
            return 'h';
        }
      })
      .join(' ');
    this.paint(style, text);
  }

  /** A box painted with a two-colour axial gradient (an `sh` shading under a clip), `from` to `to` along `direction`. */
  gradientRect(
    x: number,
    y: number,
    width: number,
    height: number,
    from: Rgb,
    to: Rgb,
    direction: 'horizontal' | 'vertical',
  ): void {
    const coords =
      direction === 'horizontal'
        ? [x, this.flip(y), x + width, this.flip(y)]
        : [x, this.flip(y), x, this.flip(y + height)];
    const name = this.owner.shadingName(coords, from, to);
    this.ops.push(
      `q ${num(x)} ${num(this.flip(y + height))} ${num(width)} ${num(height)} re W n /${name} sh Q`,
    );
  }

  /** A straight stroke from `(x1, y1)` to `(x2, y2)`. */
  line(x1: number, y1: number, x2: number, y2: number, style: LineStyle): void {
    const dash = style.dash === undefined ? '' : ` [${num(style.dash[0])} ${num(style.dash[1])}] 0 d`;
    const cap = style.cap === 'round' ? ' 1 J' : style.cap === 'square' ? ' 2 J' : '';
    this.ops.push(
      `q ${rgb(style.stroke)} RG ${num(style.lineWidth ?? 1)} w${dash}${cap} ${num(x1)} ${num(this.flip(y1))} m ${num(x2)} ${num(this.flip(y2))} l S Q`,
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
  private readonly shadingList: { readonly coords: number[]; readonly from: Rgb; readonly to: Rgb }[] = [];
  private readonly masks = new Map<MuPixmap, MuPixmap>();
  private readonly jpegs = new Set<MuPixmap>();
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

  /** The resource name of an axial shading from `from` to `to` along `coords` (PDF user space), registered; every call adds a new shading (no deduplication). */
  shadingName(coords: number[], from: Rgb, to: Rgb): string {
    this.shadingList.push({ coords, from, to });
    return `Sh${this.shadingList.length - 1}`;
  }

  /** The image-XObject index of a pixmap, added to the document on first use. */
  imageResource(pixmap: MuPixmap): number {
    let index = this.imageIndex.get(pixmap);
    if (index === undefined) {
      const mask = this.masks.get(pixmap);
      const image =
        mask === undefined
          ? new this.mupdf.Image(this.jpegs.has(pixmap) ? pixmap.asJPEG(90) : pixmap)
          : new this.mupdf.Image(pixmap, new this.mupdf.Image(mask));
      this.imageObjects.push(this.doc.addImage(image));
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

  /**
   * Like `pixmap`, but each sample also has an alpha in 0–1: the picture is embedded with a
   * soft mask (`/SMask`), so what is behind it shows through where alpha is below 1.
   */
  maskedPixmap(
    width: number,
    height: number,
    paint: (x: number, y: number) => readonly [Rgb, number],
  ): MuPixmap {
    const alphas = new Float32Array(width * height);
    const color = this.pixmap(width, height, (x, y) => {
      const [value, alpha] = paint(x, y);
      alphas[y * width + x] = alpha;
      return value;
    });
    const mask = new this.mupdf.Pixmap(this.mupdf.ColorSpace.DeviceGray, [0, 0, width, height], false);
    const samples = mask.getPixels();
    const stride = mask.getStride();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1)
        samples[y * stride + x] = Math.round((alphas[y * width + x] ?? 1) * 255);
    }
    this.pixmaps.push(mask);
    this.masks.set(color, mask);
    return color;
  }

  /**
   * Hand a pixmap MuPDF made elsewhere (a rendered snippet) to this document: `save` frees it with
   * the others. With `jpeg` it is embedded as a JPEG (quality 90), as a scanner's output is.
   */
  adopt(pixmap: MuPixmap, jpeg = false): MuPixmap {
    this.pixmaps.push(pixmap);
    if (jpeg) this.jpegs.add(pixmap);
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
      const shading: Record<string, unknown> = {};
      for (const [index, entry] of this.shadingList.entries()) {
        shading[`Sh${index}`] = {
          ShadingType: 2,
          ColorSpace: 'DeviceRGB',
          Coords: entry.coords,
          Function: {
            FunctionType: 2,
            Domain: [0, 1],
            C0: entry.from.map((channel) => channel / 255),
            C1: entry.to.map((channel) => channel / 255),
            N: 1,
          },
          Extend: [true, true],
        };
      }
      const resources = { Font: font, XObject: xobject, ExtGState: extGState, Shading: shading };
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

/** What a poor scan adds to the clean render. Every effect is deterministic (a seeded generator). */
export interface ScanDefects {
  /** The sheet lies this many degrees counter-clockwise on the glass; the corners the page no longer covers are scanner-lid grey. */
  readonly skewDegrees?: number;
  /** Standard deviation of the gaussian sensor noise, in 0–255 sample units. */
  readonly noiseSigma?: number;
  /** 0–1: how much darker the dim corner is than the lit one (uneven illumination). */
  readonly unevenLight?: number;
}

/** A tiny seeded generator (mulberry32), so a noisy scan is the same bytes every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The grey of the scanner lid showing past the page edge. */
const LID: Rgb = [226, 226, 224];

/** Apply `defects` to an RGB pixmap in place. */
function degrade(pixmap: MuPixmap, defects: ScanDefects): void {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const samples = pixmap.getPixels();
  const source = samples.slice();
  const angle = ((defects.skewDegrees ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centreX = width / 2;
  const centreY = height / 2;
  const dim = defects.unevenLight ?? 0;
  const sigma = defects.noiseSigma ?? 0;
  const random = seededRandom(20240607);
  const gaussian = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // the source position this output sample comes from: the output turned back by the skew
      const dx = x - centreX;
      const dy = y - centreY;
      const sx = centreX + dx * cos - dy * sin;
      const sy = centreY + dx * sin + dy * cos;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const light = 1 - dim * (0.6 * (x / width) + 0.4 * (y / height) ** 2);
      const grain = sigma === 0 ? 0 : gaussian() * sigma;
      const at = y * stride + x * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        let value: number = LID[channel] ?? 255;
        if (x0 >= 0 && y0 >= 0 && x0 < width && y0 < height) {
          const fx = sx - x0;
          const fy = sy - y0;
          const x1 = Math.min(x0 + 1, width - 1);
          const y1 = Math.min(y0 + 1, height - 1);
          const row0 = y0 * stride;
          const row1 = y1 * stride;
          const top =
            (source[row0 + x0 * 3 + channel] ?? 0) * (1 - fx) + (source[row0 + x1 * 3 + channel] ?? 0) * fx;
          const bottom =
            (source[row1 + x0 * 3 + channel] ?? 0) * (1 - fx) + (source[row1 + x1 * 3 + channel] ?? 0) * fx;
          value = top * (1 - fy) + bottom * fy;
        }
        samples[at + channel] = Math.max(0, Math.min(255, Math.round(value * light + grain)));
      }
    }
  }
}

/**
 * A scan of a PDF: every page rendered at `dpi` into a JPEG and placed, full-page, in a new
 * document of the same page sizes. There is no text layer in the result and no vector content —
 * what a flatbed scanner (or a "print to image") produces. `defects` make it a poor scan.
 */
export async function rasterizeToImagePdf(
  bytes: Uint8Array,
  dpi: number,
  defects: ScanDefects = {},
): Promise<Uint8Array> {
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
      if (Object.keys(defects).length > 0) degrade(pixmap, defects);
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

/**
 * Page `pageIndex` of a PDF rendered at `dpi` into an RGB pixmap (with `defects` applied), for
 * a sample to embed as a picture. The caller hands it to `SamplePdf.adopt` (or `destroy`s it).
 */
export async function renderPageToPixmap(
  bytes: Uint8Array,
  dpi: number,
  defects: ScanDefects = {},
  pageIndex = 0,
): Promise<MuPixmap> {
  const mupdf = await loadMupdfModule();
  const source = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = source.loadPage(pageIndex);
    try {
      const scale = dpi / 72;
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
        false,
      );
      if (Object.keys(defects).length > 0) degrade(pixmap, defects);
      return pixmap;
    } finally {
      page.destroy();
    }
  } finally {
    source.destroy();
  }
}
