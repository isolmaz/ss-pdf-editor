/**
 * A page read as a scene for the "exact layout" Word export (`layout-scene.ts`): its text
 * (`readPageLayout`), its drawing in paint order, and its external links.
 *
 * The drawing comes from one run of the page through a JS device:
 *
 * - **Paths** become `SceneShape`s: the path walked through the CTM (curves kept), the
 *   fill/stroke colour converted to RGB by MuPDF (so CMYK, Lab, Separation … come out as
 *   the reader sees them), the stroke width and dashes scaled by the CTM's average scale
 *   (`sqrt|det|`). A path that is both filled and stroked is two shapes. A dash array of
 *   odd length is doubled (PDF repeats it); the dash phase is not carried. A triangle cap
 *   is drawn `round`, `MiterXPS` is `miter`. A shape's `box` is the box of its points
 *   (control points of curves included), without the stroke's half width.
 * - **Pictures** (`fillImage`) become `SceneImage`s: drawn through their own transform with
 *   the soft mask folded in (`softMasked`), cropped to the clip and the page. JPEG (quality
 *   90) when the result is opaque and photographic (more than 256 colours), PNG otherwise.
 * - **Clips** are a stack. A clip that is an upright rectangle only shrinks the box content
 *   is cut to: a shape inside it stays as it is, a filled rectangle that sticks out is cut to
 *   it, any other shape that sticks out becomes a raster of its visible box. Every other
 *   clip (a curve, a stroked path, text, an image mask), a soft mask, a transparency group
 *   with a blend mode, a tiling pattern, a shading and a stencil image mask puts the
 *   content it covers in a raster *island* — Word has no equivalent. A group's alpha
 *   multiplies into what is drawn inside it. A knockout group with the normal blend mode
 *   stays vector: it is how MuPDF draws a transparent fill+stroke, whose two shapes then
 *   blend where they overlap rather than the stroke replacing the fill.
 * - **Islands** collect the boxes of such content; boxes that overlap or are at most 8 pt
 *   apart become one island, which sits in the paint order at the position of its first
 *   contribution (so shapes drawn later stay on top). Each island is rendered once, at the
 *   end, at 2× (144 dpi, 2000 px at most on the long side) on a transparent ground, with
 *   everything the page draws in that region *except its text*: the page is run through a JS
 *   device that forwards each call to a `DrawDevice` and swallows `fillText`, `strokeText`
 *   and `ignoreText` (`clipText` is forwarded, the text's clip applies to what follows).
 *   Glyphs of a Type 3 font are drawn by MuPDF as paths and pictures, not as text calls, so
 *   they are drawn like any other path.
 * - More than `MAX_SHAPES` shapes and islands on a page (Word turns unusably slow) make the
 *   whole drawing one raster island of its union box.
 *
 * The page-sized background fill is kept (it is part of the look); content that lies
 * entirely outside the page is dropped.
 */

import type { Color, ColorSpace, Image, Matrix, Page, Path, Rect, StrokeState } from 'mupdf';
import type { Mupdf } from '../engines/mupdf';
import type {
  PageScene,
  PathSegment,
  Point,
  SceneImage,
  SceneItem,
  SceneLink,
  SceneRaster,
  SceneShape,
  ShapeFill,
  ShapeStroke,
} from './layout-scene';
import { apply, type Box, borrowed, readPageLayout, rgb, softMasked, transformBox } from './page-layout';

/** More shapes and islands than this on a page and the drawing becomes one raster. */
const MAX_SHAPES = 1500;
/** Content closer than this (points) goes into the same raster island. */
const ISLAND_GAP = 8;
/** Pixels per point of a raster island (144 dpi). */
const RASTER_SCALE = 2;
/** A raster or picture is scaled down to this many pixels on its long side. */
const MAX_SIDE = 2000;
/** A picture with more colours than this is photographic: it goes out as JPEG. */
const FLAT_COLOURS = 256;
const JPEG_QUALITY = 90;
/** Strokes this thin are drawn this wide (a zero width is MuPDF's hairline). */
const MIN_STROKE = 0.25;

const EMPTY: Box = [0, 0, 0, 0];
const EVERYWHERE: Box = [-Infinity, -Infinity, Infinity, Infinity];

function intersect(a: Box, b: Box): Box | null {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

function unite(a: Box, b: Box): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function near(a: Box, b: Box, gap: number): boolean {
  return a[0] <= b[2] + gap && b[0] <= a[2] + gap && a[1] <= b[3] + gap && b[1] <= a[3] + gap;
}

function within(inner: Box, outer: Box): boolean {
  const slack = 0.01;
  return (
    inner[0] >= outer[0] - slack &&
    inner[1] >= outer[1] - slack &&
    inner[2] <= outer[2] + slack &&
    inner[3] <= outer[3] + slack
  );
}

interface PathData {
  readonly segments: PathSegment[];
  /** The box of every point, control points included. */
  readonly box: Box;
  /** The box when the path is one upright rectangle, else `null`. */
  readonly rect: Box | null;
}

/** The path through `matrix`: its segments, the box of its points, and whether it is an upright rectangle. */
function readPath(path: Path, matrix: Matrix): PathData {
  const segments: PathSegment[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let subpaths = 0;
  let curved = false;
  let ring: Point[] = [];
  const grow = (to: Point): void => {
    x0 = Math.min(x0, to[0]);
    y0 = Math.min(y0, to[1]);
    x1 = Math.max(x1, to[0]);
    y1 = Math.max(y1, to[1]);
  };
  path.walk({
    moveTo(x, y) {
      const to = apply(matrix, x, y);
      segments.push({ kind: 'move', to });
      grow(to);
      subpaths += 1;
      ring = [to];
    },
    lineTo(x, y) {
      const to = apply(matrix, x, y);
      segments.push({ kind: 'line', to });
      grow(to);
      ring.push(to);
    },
    curveTo(ax, ay, bx, by, cx, cy) {
      const c1 = apply(matrix, ax, ay);
      const c2 = apply(matrix, bx, by);
      const to = apply(matrix, cx, cy);
      segments.push({ kind: 'curve', c1, c2, to });
      grow(c1);
      grow(c2);
      grow(to);
      curved = true;
    },
    closePath() {
      segments.push({ kind: 'close' });
    },
  });
  if (segments.length === 0) return { segments, box: EMPTY, rect: null };
  const box: Box = [x0, y0, x1, y1];
  let rect: Box | null = null;
  if (subpaths === 1 && !curved) {
    const [first] = ring as [Point];
    const last = ring[ring.length - 1] as Point;
    const corners =
      ring.length === 5 && last[0] === first[0] && last[1] === first[1] ? ring.slice(0, 4) : ring;
    if (corners.length === 4) {
      const same = (a: number, b: number) => Math.abs(a - b) <= 0.001;
      const [p, q, r, s] = corners as [Point, Point, Point, Point];
      const horizontalFirst = same(p[1], q[1]) && same(q[0], r[0]) && same(r[1], s[1]) && same(s[0], p[0]);
      const verticalFirst = same(p[0], q[0]) && same(q[1], r[1]) && same(r[0], s[0]) && same(s[1], p[1]);
      if (horizontalFirst || verticalFirst) rect = box;
    }
  }
  return { segments, box, rect };
}

const cutRectangle = (box: Box): PathSegment[] => [
  { kind: 'move', to: [box[0], box[1]] },
  { kind: 'line', to: [box[2], box[1]] },
  { kind: 'line', to: [box[2], box[3]] },
  { kind: 'line', to: [box[0], box[3]] },
  { kind: 'close' },
];

/** The average scale of a matrix: `sqrt|det|`. */
const averageScale = (m: Matrix): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/**
 * The colour as the engine's binding takes it: one, three or four components (its own check
 * refuses any other count, so a DeviceN colour of two components fails here as it did there).
 */
function drawColor(color: readonly number[]): Color {
  const [first, second, third, fourth] = color;
  if (color.length === 1 && first !== undefined) return [first];
  if (color.length === 3 && first !== undefined && second !== undefined && third !== undefined) {
    return [first, second, third];
  }
  if (
    color.length === 4 &&
    first !== undefined &&
    second !== undefined &&
    third !== undefined &&
    fourth !== undefined
  ) {
    return [first, second, third, fourth];
  }
  throw new RangeError(`a colour of ${color.length} components cannot be drawn`);
}

/** A pixmap's colour of an `r g b` triple, 0xRRGGBB. */
function converted(mupdf: Mupdf, colorspace: ColorSpace, color: readonly number[]): number {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 1, 1], false);
  const path = new mupdf.Path();
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  try {
    pixmap.clear();
    path.moveTo(-1, -1);
    path.lineTo(2, -1);
    path.lineTo(2, 2);
    path.lineTo(-1, 2);
    path.closePath();
    device.fillPath(path, false, mupdf.Matrix.identity, colorspace, drawColor(color), 1);
    device.close();
    const [r, g, b] = pixmap.getPixels() as unknown as [number, number, number];
    return (r << 16) | (g << 8) | b;
  } finally {
    device.destroy();
    path.destroy();
    pixmap.destroy();
  }
}

/** One cap/join name of MuPDF's stroke state in the scene's vocabulary. */
function capOf(mupdf: Mupdf, stroke: StrokeState): ShapeStroke['cap'] {
  const name = mupdf.StrokeState.LINE_CAP[stroke.getLineCap()];
  if (name === 'Round' || name === 'Triangle') return 'round';
  return name === 'Square' ? 'square' : 'butt';
}

function joinOf(mupdf: Mupdf, stroke: StrokeState): ShapeStroke['join'] {
  const name = mupdf.StrokeState.LINE_JOIN[stroke.getLineJoin()];
  if (name === 'Round') return 'round';
  return name === 'Bevel' ? 'bevel' : 'miter';
}

/** The picture as it shows on the page, cropped to `visible`; `null` when MuPDF cannot decode it. */
function pictureOf(
  mupdf: Mupdf,
  image: Image,
  matrix: Matrix,
  full: Box,
  visible: Box,
  alpha: number,
): Pick<SceneImage, 'data' | 'mime'> | null {
  try {
    const fullSide = Math.max(1, full[2] - full[0], full[3] - full[1]);
    const visibleWidth = visible[2] - visible[0];
    const visibleHeight = visible[3] - visible[1];
    const native = Math.max(image.getWidth(), image.getHeight()) / fullSide;
    const scale = Math.max(0.25, Math.min(native, MAX_SIDE / Math.max(visibleWidth, visibleHeight)));
    const width = Math.max(1, Math.round(visibleWidth * scale));
    const height = Math.max(1, Math.round(visibleHeight * scale));
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true);
    try {
      pixmap.clear();
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
      let masked: Image | null = null;
      try {
        masked = softMasked(mupdf, image);
        const place = mupdf.Matrix.concat(
          mupdf.Matrix.translate(-visible[0], -visible[1]),
          mupdf.Matrix.scale(scale, scale),
        );
        device.fillImage(masked ?? image, mupdf.Matrix.concat(matrix, place), alpha);
        device.close();
      } finally {
        masked?.destroy();
        device.destroy();
      }
      // Look at the pixels once: how much of the box is see-through, and whether there are
      // more colours than a flat picture (a logo, a chart) has.
      const pixels = pixmap.getPixels();
      const stride = pixmap.getStride();
      const colours = new Set<number>();
      let seeThrough = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const at = y * stride + x * 4;
          if ((pixels[at + 3] as number) < 250) seeThrough += 1;
          else if (colours.size <= FLAT_COLOURS) {
            colours.add(
              ((pixels[at] as number) << 16) | ((pixels[at + 1] as number) << 8) | (pixels[at + 2] as number),
            );
          }
        }
      }
      const opaque = alpha >= 1 && masked === null && seeThrough <= width * height * 0.01;
      if (opaque && colours.size > FLAT_COLOURS) {
        // MuPDF will not drop an alpha channel itself; the picture is laid on white (its colour is
        // premultiplied, so that is a plain addition).
        const flat = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
        try {
          const from = pixmap.getPixels();
          const to = flat.getPixels();
          const flatStride = flat.getStride();
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              const source = y * stride + x * 4;
              const white = 255 - (from[source + 3] as number);
              const target = y * flatStride + x * 3;
              to[target] = (from[source] as number) + white;
              to[target + 1] = (from[source + 1] as number) + white;
              to[target + 2] = (from[source + 2] as number) + white;
            }
          }
          return { data: flat.asJPEG(JPEG_QUALITY, false), mime: 'image/jpeg' };
        } finally {
          flat.destroy();
        }
      }
      return { data: pixmap.asPNG(), mime: 'image/png' };
    } finally {
      pixmap.destroy();
    }
  } catch {
    // A picture MuPDF cannot decode is left out (as `readPageLayout` does).
    return null;
  }
}

/**
 * The page's drawing inside `box` (page space, points) as a PNG on a transparent ground at
 * 2×: every call the page makes is forwarded to a `DrawDevice`, except the text.
 */
function renderWithoutText(mupdf: Mupdf, page: Page, box: Box): Uint8Array {
  const [px0, py0] = page.getBounds();
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  const scale = Math.min(RASTER_SCALE, MAX_SIDE / Math.max(width, height));
  const pixmap = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [0, 0, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))],
    true,
  );
  try {
    pixmap.clear();
    const draw = new mupdf.DrawDevice(
      mupdf.Matrix.concat(
        mupdf.Matrix.translate(-(box[0] + px0), -(box[1] + py0)),
        mupdf.Matrix.scale(scale, scale),
      ),
      pixmap,
    );
    try {
      const forward = new mupdf.Device({
        fillPath: (path, evenOdd, ctm, colorspace, color, alpha) =>
          draw.fillPath(path, evenOdd, ctm, colorspace, drawColor(color), alpha),
        strokePath: (path, stroke, ctm, colorspace, color, alpha) =>
          draw.strokePath(path, stroke, ctm, colorspace, drawColor(color), alpha),
        clipPath: (path, evenOdd, ctm) => draw.clipPath(path, evenOdd, ctm),
        clipStrokePath: (path, stroke, ctm) => draw.clipStrokePath(path, stroke, ctm),
        clipText: (text, ctm) => draw.clipText(text, ctm),
        clipStrokeText: (text, stroke, ctm) => draw.clipStrokeText(text, stroke, ctm),
        fillShade(shade, ctm, alpha) {
          borrowed(shade);
          draw.fillShade(shade, ctm, alpha);
        },
        fillImage(image, ctm, alpha) {
          borrowed(image);
          draw.fillImage(image, ctm, alpha);
        },
        fillImageMask(image, ctm, colorspace, color, alpha) {
          borrowed(image);
          draw.fillImageMask(image, ctm, colorspace, drawColor(color), alpha);
        },
        clipImageMask(image, ctm) {
          borrowed(image);
          draw.clipImageMask(image, ctm);
        },
        popClip: () => draw.popClip(),
        beginMask: (area, luminosity, colorspace, color) =>
          draw.beginMask(area, luminosity, colorspace, drawColor(color)),
        endMask: () => draw.endMask(),
        beginGroup: (area, colorspace, isolated, knockout, blendmode, alpha) =>
          draw.beginGroup(area, colorspace, isolated, knockout, blendmode, alpha),
        endGroup: () => draw.endGroup(),
        beginTile: (area, view, xstep, ystep, ctm, id, docId) =>
          draw.beginTile(area, view, xstep, ystep, ctm, id, docId),
        endTile: () => draw.endTile(),
        beginLayer: (name) => draw.beginLayer(name),
        endLayer: () => draw.endLayer(),
      });
      try {
        page.run(forward, mupdf.Matrix.identity);
        forward.close();
      } finally {
        forward.destroy();
      }
      draw.close();
    } finally {
      draw.destroy();
    }
    return pixmap.asPNG();
  } finally {
    pixmap.destroy();
  }
}

/** What the drawing is clipped, grouped or masked by at this point of the run. */
interface Frame {
  /** The box content is cut to; page space. */
  readonly box: Box;
  /** Every clip so far is an upright rectangle (and no blend, knockout or soft mask is open). */
  readonly exact: boolean;
  /** The content is not drawn: a soft mask's or a tile's own content. */
  readonly ignore: boolean;
  /** The product of the open groups' alphas. */
  readonly alpha: number;
}

interface Island {
  readonly kind: 'island';
  box: Box;
  absorbed: boolean;
}

type Slot = Island | { readonly kind: 'item'; readonly item: SceneShape | SceneImage };

export function readPageScene(mupdf: Mupdf, page: Page): PageScene {
  const text = readPageLayout(mupdf, page, { images: false });
  const [px0, py0, px1, py1] = page.getBounds();
  const width = px1 - px0;
  const height = py1 - py0;
  const pageBox: Box = [0, 0, width, height];
  const place = (m: Matrix): Matrix => [m[0], m[1], m[2], m[3], m[4] - px0, m[5] - py0];
  const shifted = (r: Rect): Box => [r[0] - px0, r[1] - py0, r[2] - px0, r[3] - py0];

  const frames: Frame[] = [{ box: EVERYWHERE, exact: true, ignore: false, alpha: 1 }];
  const top = (): Frame => frames[frames.length - 1] as Frame;
  const open = (box: Box | null, change: Partial<Pick<Frame, 'exact' | 'ignore' | 'alpha'>>): void => {
    const parent = top();
    frames.push({
      box: box === null ? parent.box : (intersect(parent.box, box) ?? EMPTY),
      exact: change.exact === undefined ? parent.exact : parent.exact && change.exact,
      ignore: change.ignore ?? parent.ignore,
      alpha: change.alpha === undefined ? parent.alpha : parent.alpha * change.alpha,
    });
  };
  const close = (): void => {
    if (frames.length > 1) frames.pop();
  };

  const slots: Slot[] = [];
  let islands: Island[] = [];
  let shapes = 0;
  /** Set once the page has too many items: the box everything drawn since reaches. */
  let everything: Box | null = null;
  /** The reach of each shape or picture: its box plus the strokes' half width. */
  const reaches = new Map<SceneShape | SceneImage, Box>();
  /** Too many items: everything so far, and from now on, is one drawing. */
  const spill = (): void => {
    let union: Box | null = null;
    for (const slot of slots) {
      if (slot.kind === 'island' && slot.absorbed) continue;
      const box = slot.kind === 'island' ? slot.box : (reaches.get(slot.item) as Box);
      union = union === null ? box : unite(union, box);
    }
    everything = union;
    slots.length = 0;
    islands = [];
    reaches.clear();
  };

  /** Reach of what Word cannot draw: it goes into the island that touches it, or a new one. */
  const contribute = (box: Box): void => {
    const visible = intersect(box, pageBox);
    if (visible === null) return;
    if (everything !== null) {
      everything = unite(everything, visible);
      return;
    }
    let union = visible;
    const hit = new Set<Island>();
    let grown = true;
    while (grown) {
      grown = false;
      for (const island of islands) {
        if (!hit.has(island) && near(island.box, union, ISLAND_GAP)) {
          hit.add(island);
          union = unite(union, island.box);
          grown = true;
        }
      }
    }
    if (hit.size === 0) {
      const island: Island = { kind: 'island', box: union, absorbed: false };
      slots.push(island);
      islands.push(island);
    } else {
      const [survivor] = islands.filter((island) => hit.has(island)) as [Island];
      survivor.box = union;
      for (const island of hit) {
        if (island !== survivor) island.absorbed = true;
      }
      islands = islands.filter((island) => !island.absorbed);
    }
    if (shapes + islands.length > MAX_SHAPES) spill();
  };

  const emit = (item: SceneShape | SceneImage, reach: Box): void => {
    if (everything !== null) {
      everything = unite(everything, reach);
      return;
    }
    slots.push({ kind: 'item', item });
    reaches.set(item, reach);
    if (item.kind === 'shape') shapes += 1;
    if (shapes + islands.length > MAX_SHAPES) spill();
  };

  const colours = new Map<string, number>();
  const colorOf = (colorspace: ColorSpace, color: readonly number[]): number => {
    const type = colorspace.getType();
    if ((type === 'Gray' && color.length === 1) || (type === 'RGB' && color.length === 3)) return rgb(color);
    const key = `${colorspace.getName()}|${color.join(',')}`;
    let value = colours.get(key);
    if (value === undefined) {
      value = converted(mupdf, colorspace, color);
      colours.set(key, value);
    }
    return value;
  };

  const strokeOf = (stroke: StrokeState, scale: number, color: number, alpha: number): ShapeStroke => {
    let dash = (stroke.getDashes() ?? []).map((length) => length * scale);
    if (dash.length % 2 === 1) dash = [...dash, ...dash];
    if (dash.every((length) => length <= 0)) dash = [];
    return {
      color,
      alpha,
      width: Math.max(MIN_STROKE, stroke.getLineWidth() * scale),
      dash,
      cap: capOf(mupdf, stroke),
      join: joinOf(mupdf, stroke),
    };
  };

  /** One path with the fill and/or the stroke it is drawn with. */
  const addPath = (
    path: Path,
    ctm: Matrix,
    fill: ShapeFill | null,
    strokeState: StrokeState | null,
    color: number,
    alpha: number,
  ): void => {
    const frame = top();
    if (frame.ignore) return;
    const matrix = place(ctm);
    const data = readPath(path, matrix);
    if (data.segments.length === 0) return;
    const scale = averageScale(matrix);
    const stroke = strokeState === null ? null : strokeOf(strokeState, scale, color, alpha * frame.alpha);
    const half = stroke === null ? 0 : stroke.width / 2;
    const reach: Box = [data.box[0] - half, data.box[1] - half, data.box[2] + half, data.box[3] + half];
    const visible = intersect(reach, frame.box);
    if (visible === null || intersect(visible, pageBox) === null) return;
    const shapeFill = fill === null ? null : { ...fill, alpha: fill.alpha * frame.alpha };
    if (!frame.exact) {
      contribute(visible);
      return;
    }
    if (within(reach, frame.box)) {
      emit({ kind: 'shape', box: data.box, segments: data.segments, fill: shapeFill, stroke }, reach);
      return;
    }
    if (stroke === null && data.rect !== null) {
      const cut = intersect(data.rect, frame.box);
      if (cut !== null)
        emit({ kind: 'shape', box: cut, segments: cutRectangle(cut), fill: shapeFill, stroke }, cut);
      return;
    }
    contribute(visible);
  };

  const device = new mupdf.Device({
    fillPath(path, evenOdd, ctm, colorspace, color, alpha) {
      addPath(path, ctm, { color: colorOf(colorspace, color), alpha, evenOdd }, null, 0, alpha);
    },
    strokePath(path, stroke, ctm, colorspace, color, alpha) {
      addPath(path, ctm, null, stroke, colorOf(colorspace, color), alpha);
    },
    clipPath(path, _evenOdd, ctm) {
      const data = readPath(path, place(ctm));
      open(data.box, { exact: data.rect !== null });
    },
    clipStrokePath(path, stroke, ctm) {
      open(shifted(path.getBounds(stroke, ctm)), { exact: false });
    },
    clipText() {
      open(null, { exact: false });
    },
    clipStrokeText() {
      open(null, { exact: false });
    },
    clipImageMask(image, ctm) {
      borrowed(image);
      open(transformBox([0, 0, 1, 1], place(ctm)), { exact: false });
    },
    popClip: close,
    beginMask(area) {
      open(shifted(area), { exact: false, ignore: true });
    },
    endMask() {
      // The soft mask's own content is over; what follows is drawn under it, until `popClip`.
      const mask = frames.pop();
      if (mask !== undefined) frames.push({ ...mask, ignore: top().ignore });
    },
    beginGroup(area, _colorspace, _isolated, _knockout, blendmode, alpha) {
      // MuPDF wraps a transparent fill+stroke in a knockout group; as vector shapes the two
      // blend where they overlap instead of the stroke replacing the fill there. That is the
      // price of keeping every semi-transparent outlined shape a shape.
      open(shifted(area), { exact: blendmode === 'Normal', alpha });
    },
    endGroup: close,
    beginTile(area, _view, _xstep, _ystep, ctm) {
      const frame = top();
      if (!frame.ignore) {
        // The enclosing clip is the pattern's path; without a finite one, the area (in pattern space).
        contribute(frame.box.every(Number.isFinite) ? frame.box : transformBox(area, place(ctm)));
      }
      open(null, { ignore: true });
      return 0;
    },
    endTile: close,
    fillShade(shade, ctm) {
      borrowed(shade);
      const frame = top();
      if (frame.ignore) return;
      const visible = intersect(transformBox(shade.getBounds(), place(ctm)), frame.box);
      if (visible !== null) contribute(visible);
    },
    fillImageMask(image, ctm) {
      borrowed(image);
      const frame = top();
      if (frame.ignore) return;
      const visible = intersect(transformBox([0, 0, 1, 1], place(ctm)), frame.box);
      if (visible !== null) contribute(visible);
    },
    fillImage(image, ctm, alpha) {
      borrowed(image);
      const frame = top();
      if (frame.ignore) return;
      const matrix = place(ctm);
      const full = transformBox([0, 0, 1, 1], matrix);
      const visible = intersect(full, frame.box);
      if (visible === null || intersect(visible, pageBox) === null) return;
      if (!frame.exact) {
        contribute(visible);
        return;
      }
      const shown = intersect(visible, pageBox) as Box;
      if (everything !== null) {
        everything = unite(everything, shown);
        return;
      }
      const picture = pictureOf(mupdf, image, matrix, full, shown, alpha * frame.alpha);
      if (picture !== null) emit({ kind: 'image', box: shown, ...picture }, shown);
    },
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }

  const raster = (box: Box): SceneRaster | null => {
    const aligned = intersect(
      [Math.floor(box[0]), Math.floor(box[1]), Math.ceil(box[2]), Math.ceil(box[3])],
      pageBox,
    );
    if (aligned === null) return null;
    return { kind: 'raster', box: aligned, data: renderWithoutText(mupdf, page, aligned), mime: 'image/png' };
  };
  const items: SceneItem[] = [];
  const spilled = everything as Box | null;
  if (spilled !== null) {
    const all = raster(spilled);
    if (all !== null) items.push(all);
  } else {
    for (const slot of slots) {
      if (slot.kind === 'item') items.push(slot.item);
      else if (!slot.absorbed) {
        const picture = raster(slot.box);
        if (picture !== null) items.push(picture);
      }
    }
  }

  const links: SceneLink[] = [];
  for (const link of page.getLinks()) {
    try {
      if (link.isExternal()) links.push({ box: shifted(link.getBounds()), uri: link.getURI() });
    } finally {
      link.destroy();
    }
  }

  return { width, height, items, links, text };
}
