/**
 * The page as the "exact layout" Word writer sees it (`docxLayout: 'layout'`).
 *
 * A page is read once into a scene: its drawing in paint order (vector shapes, pictures,
 * and rasters of what Word cannot draw), its links, and its text as MuPDF's structured-text
 * walker gives it (`page-layout.ts`). The writer then rebuilds the page in Word with the
 * same geometry: shapes as Word shapes, pictures anchored where they were, and the text in
 * positioned text boxes on top. Everything is in page space: points, origin at the page's
 * top-left corner, y down, `/Rotate` and the crop box applied (as `PageLayout`).
 */

import type { Box, PageLayout } from './page-layout';

export type Point = readonly [number, number];

/** One step of a path, in page space. */
export type PathSegment =
  | { readonly kind: 'move'; readonly to: Point }
  | { readonly kind: 'line'; readonly to: Point }
  | { readonly kind: 'curve'; readonly c1: Point; readonly c2: Point; readonly to: Point }
  | { readonly kind: 'close' };

export interface ShapeFill {
  /** 0xRRGGBB. */
  readonly color: number;
  /** 0..1. */
  readonly alpha: number;
  readonly evenOdd: boolean;
}

export interface ShapeStroke {
  readonly color: number;
  readonly alpha: number;
  /** Line width in points, after the transform (the average scale of the CTM). */
  readonly width: number;
  /** Dash lengths in points; empty for a solid line. */
  readonly dash: readonly number[];
  readonly cap: 'butt' | 'round' | 'square';
  readonly join: 'miter' | 'round' | 'bevel';
}

/** A vector path Word can draw itself: a solid fill and/or a solid stroke. */
export interface SceneShape {
  readonly kind: 'shape';
  readonly box: Box;
  readonly segments: readonly PathSegment[];
  readonly fill: ShapeFill | null;
  readonly stroke: ShapeStroke | null;
}

/** A picture as it shows on the page (transform, soft mask and clip applied), upright in its box. */
export interface SceneImage {
  readonly kind: 'image';
  readonly box: Box;
  readonly data: Uint8Array;
  readonly mime: 'image/png' | 'image/jpeg';
}

/**
 * A region drawn as a picture because Word has no equivalent (a shading, a non-rectangular
 * clip, a blend or soft-mask group, a path count too large to be shapes). Rendered with the
 * page's text left out, so the text boxes on top are the only text.
 */
export interface SceneRaster {
  readonly kind: 'raster';
  readonly box: Box;
  readonly data: Uint8Array;
  readonly mime: 'image/png' | 'image/jpeg';
}

export type SceneItem = SceneShape | SceneImage | SceneRaster;

export interface SceneLink {
  readonly box: Box;
  /** An external URI (`https:`, `mailto:` …). Links inside the document are not carried. */
  readonly uri: string;
}

export interface PageScene {
  readonly width: number;
  readonly height: number;
  /** The drawing in paint order, bottom first; the page-sized background included. */
  readonly items: readonly SceneItem[];
  readonly links: readonly SceneLink[];
  /** The characters, lines and blocks (`readPageLayout`). */
  readonly text: PageLayout;
}

/* ------------------------------------------------------------------ *
 * text boxes
 * ------------------------------------------------------------------ */

export interface TextRun {
  readonly text: string;
  /** Word font name (`wordFontName`). */
  readonly font: string;
  /** Points. */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly color: number;
  /** The external link the run belongs to, if any. */
  readonly link: string | null;
  /** A remark on the run (OCR: a word the engine was unsure of); the writer shows it as a comment. */
  readonly note?: string;
  /** Where the PDF puts each character of `text`, so the writer can space them alike (`fitLine`). */
  readonly fit?: RunFit | undefined;
}

/** The PDF's geometry of a run's characters, one entry per `text` code point. */
export interface RunFit {
  /** Natural advance in em of each character in the face Word will draw. */
  readonly advances: readonly number[];
  /** Where the PDF's character starts, page points from the left (`NaN`: a space the PDF has no position for). */
  readonly starts: readonly number[];
  /** Where the PDF's character ends (`NaN` as above). */
  readonly ends: readonly number[];
  /** Glyph width ÷ natural width (`w:w`, 1 = none). */
  readonly hscale: number;
}

export interface TextLine {
  readonly runs: readonly TextRun[];
}

export interface TextParagraph {
  readonly align: 'left' | 'center' | 'right' | 'both';
  /** Baseline to baseline, in points; Word's exact line spacing. */
  readonly lineHeight: number;
  /** The lines as the PDF breaks them; the writer joins them with line breaks. */
  readonly lines: readonly TextLine[];
}

/** A positioned text box: a group of paragraphs that sit together on the page. */
export interface TextBox {
  /** The box in page space, points. */
  readonly box: Box;
  /** Degrees clockwise; 0 for upright text. */
  readonly rotation: number;
  readonly paragraphs: readonly TextParagraph[];
}

/* ------------------------------------------------------------------ *
 * the package being written
 * ------------------------------------------------------------------ */

/**
 * What the writers of one document share: relationship ids for media and links, drawing ids
 * (`wp:docPr`, unique in the document) and the stacking order (`relativeHeight`, larger is
 * on top). One per document.
 */
export class DocxRegistry {
  readonly media: { readonly name: string; readonly rid: string; readonly data: Uint8Array }[] = [];
  readonly links: { readonly rid: string; readonly uri: string }[] = [];
  private drawings = 0;
  private stack: number;

  /** `base`: the stacking position below the first `nextZ` (0 for the first to be 1). */
  constructor(base = 0) {
    this.stack = base;
  }

  /** Adds a picture under `word/media/` and returns its relationship id. */
  addMedia(data: Uint8Array, extension: 'png' | 'jpeg'): string {
    const n = this.media.length + 1;
    const rid = `rIdImage${n}`;
    this.media.push({ name: `image${n}.${extension}`, rid, data });
    return rid;
  }

  /** The relationship id of an external link, one per distinct URI. */
  addLink(uri: string): string {
    const found = this.links.find((link) => link.uri === uri);
    if (found !== undefined) return found.rid;
    const rid = `rIdLink${this.links.length + 1}`;
    this.links.push({ rid, uri });
    return rid;
  }

  /** The next `wp:docPr` id. */
  nextDrawingId(): number {
    this.drawings += 1;
    return this.drawings;
  }

  /** The next stacking position: each call is above every earlier one. */
  nextZ(): number {
    this.stack += 1;
    return this.stack;
  }
}
