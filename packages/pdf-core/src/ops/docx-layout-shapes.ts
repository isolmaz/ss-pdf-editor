/**
 * The drawing of an "exact layout" page (`layout-scene.ts`) as Word drawings: each scene item
 * is one run holding one anchored drawing — a DrawingML shape for a vector path, a picture
 * for an image or a raster. Every drawing is placed from the page's corner, behind the text,
 * with no wrapping; its `relativeHeight` and `wp:docPr` id come from the document's
 * `DocxRegistry`, so calling in paint order keeps the paint order.
 *
 * - A shape is `wps:wsp` in `mc:AlternateContent` (Word 2010+, and what LibreOffice reads);
 *   the document root declares `wps` and `mc` (`SHAPE_NAMESPACES`, which also
 *   declares what the text boxes need).
 * - An upright rectangle is `prstGeom rect` (editable in Word as a rectangle); any other
 *   path is `custGeom`, its points in EMU relative to the shape's box.
 * - A box thinner than the stroke (a horizontal or vertical rule has no height or width) is
 *   widened to the stroke's width around its centre, and the path keeps its place inside: the
 *   rule is drawn where it was.
 * - DrawingML has no fill rule. Even-odd fills with several subpaths are written as one
 *   nonzero path whose subpaths alternate in direction by nesting depth, which is the same
 *   picture for holes (a frame, a ring, a letter's counter). Subpaths that cross each other,
 *   not nest, fill differently from even-odd; that cannot be written in DrawingML.
 */

import { EMU, pageAnchorHeadXml } from './docx-drawing';
import type {
  DocxRegistry,
  PathSegment,
  Point,
  SceneImage,
  SceneItem,
  SceneRaster,
  SceneShape,
  ShapeStroke,
} from './layout-scene';

const WPS_URI = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const EPS = 1e-3;

/** One run holding the drawing of `item`, for the page's anchor paragraph; `scale` brings page points to Word points. */
export function sceneItemXml(item: SceneItem, scale: number, registry: DocxRegistry): string {
  switch (item.kind) {
    case 'shape':
      return shapeRun(item, scale, registry);
    case 'image':
      return pictureRun(item, 'Picture', scale, registry);
    case 'raster':
      return pictureRun(item, 'Raster', scale, registry);
  }
}

/* ------------------------------------------------------------------ *
 * pictures
 * ------------------------------------------------------------------ */

/**
 * A picture is a rectangle filled with the picture, like every other drawing here: LibreOffice
 * keeps a `pic:pic` in front of the shapes of the page whatever their `relativeHeight` (the
 * translucent panels laid over a photo were hidden behind it, SSIM 0.88 → 0.97), while shapes
 * stack among themselves by it.
 */
function pictureRun(
  item: SceneImage | SceneRaster,
  label: string,
  scale: number,
  registry: DocxRegistry,
): string {
  const rid = registry.addMedia(item.data, item.mime === 'image/png' ? 'png' : 'jpeg');
  const relativeHeight = registry.nextZ();
  const id = registry.nextDrawingId();
  const [x0, y0, x1, y1] = item.box;
  const cx = Math.max(1, Math.round((x1 - x0) * scale * EMU));
  const cy = Math.max(1, Math.round((y1 - y0) * scale * EMU));
  return (
    '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' +
    pageAnchorHeadXml(
      id,
      `${label} ${id}`,
      relativeHeight,
      Math.round(x0 * scale * EMU),
      Math.round(y0 * scale * EMU),
      cx,
      cy,
    ) +
    '<wp:cNvGraphicFramePr/>' +
    `<a:graphic><a:graphicData uri="${WPS_URI}"><wps:wsp><wps:cNvSpPr/>` +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    `<a:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>` +
    '<a:ln><a:noFill/></a:ln></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>'
  );
}

/* ------------------------------------------------------------------ *
 * shapes
 * ------------------------------------------------------------------ */

function shapeRun(shape: SceneShape, scale: number, registry: DocxRegistry): string {
  const relativeHeight = registry.nextZ();
  const id = registry.nextDrawingId();
  const k = scale * EMU;
  const strokeEmu = shape.stroke === null ? 0 : Math.round(shape.stroke.width * k);
  const minExtent = Math.max(1, strokeEmu);

  // The box in EMU, widened around its centre where thinner than the stroke.
  const [bx0, by0, bx1, by1] = shape.box;
  const ox = bx0 * k;
  const oy = by0 * k;
  const w = (bx1 - bx0) * k;
  const h = (by1 - by0) * k;
  const growX = w < minExtent ? (minExtent - w) / 2 : 0;
  const growY = h < minExtent ? (minExtent - h) / 2 : 0;
  const cx = Math.max(1, Math.round(w + 2 * growX));
  const cy = Math.max(1, Math.round(h + 2 * growY));
  const x = Math.round(ox - growX);
  const y = Math.round(oy - growY);
  const rect = growX === 0 && growY === 0 && isUprightRectangle(shape);

  const geometry = rect
    ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    : customGeometry(shape, k, ox - growX, oy - growY, cx, cy);

  return (
    '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' +
    pageAnchorHeadXml(id, `Shape ${id}`, relativeHeight, x, y, cx, cy) +
    '<wp:cNvGraphicFramePr/>' +
    `<a:graphic><a:graphicData uri="${WPS_URI}"><wps:wsp><wps:cNvSpPr/>` +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    geometry +
    (shape.fill === null ? '<a:noFill/>' : colorXml(shape.fill.color, shape.fill.alpha)) +
    lineXml(shape.stroke, k) +
    '</wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>' +
    '</wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>'
  );
}

const hex = (color: number): string => (color & 0xffffff).toString(16).padStart(6, '0').toUpperCase();

function colorXml(color: number, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 100000);
  return `<a:solidFill><a:srgbClr val="${hex(color)}">${a < 100000 ? `<a:alpha val="${a}"/>` : ''}</a:srgbClr></a:solidFill>`;
}

const CAPS = { butt: 'flat', round: 'rnd', square: 'sq' } as const;

function lineXml(stroke: ShapeStroke | null, k: number): string {
  if (stroke === null) return '<a:ln><a:noFill/></a:ln>';
  const width = Math.round(stroke.width * k);
  const join =
    stroke.join === 'round'
      ? '<a:round/>'
      : stroke.join === 'bevel'
        ? '<a:bevel/>'
        : '<a:miter lim="800000"/>';
  return (
    `<a:ln w="${width}" cap="${CAPS[stroke.cap]}">` +
    colorXml(stroke.color, stroke.alpha) +
    dashXml(stroke.dash, width, k) +
    join +
    '</a:ln>'
  );
}

/**
 * `a:custDash`: dash and gap lengths as thousandths of a percent of the line width. A PDF
 * dash array of odd length repeats once to pair up. A hairline (width 0) measures against a
 * quarter point, so its dashes keep a size.
 */
function dashXml(dash: readonly number[], widthEmu: number, k: number): string {
  if (!dash.some((length) => length > 0)) return '';
  const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : dash;
  const unit = Math.max(widthEmu, EMU / 4);
  const part = (length: number): number => Math.round(((Math.max(0, length) * k) / unit) * 100000);
  let out = '<a:custDash>';
  for (let i = 0; i < pattern.length; i += 2) {
    out += `<a:ds d="${Math.max(1, part(pattern[i] as number))}" sp="${part(pattern[i + 1] as number)}"/>`;
  }
  return `${out}</a:custDash>`;
}

/* ------------------------------------------------------------------ *
 * geometry
 * ------------------------------------------------------------------ */

/** One move … line/curve … run, open or closed. */
interface Subpath {
  start: Point;
  steps: Exclude<PathSegment, { kind: 'move' } | { kind: 'close' }>[];
  closed: boolean;
}

function subpathsOf(segments: readonly PathSegment[]): Subpath[] {
  const out: Subpath[] = [];
  let current: Subpath | null = null;
  for (const segment of segments) {
    if (segment.kind === 'move') {
      current = { start: segment.to, steps: [], closed: false };
      out.push(current);
    } else if (segment.kind === 'close') {
      if (current !== null) current.closed = true;
    } else {
      if (current === null || current.closed) {
        // A drawing step without a move continues from where the path stands.
        const from: Point = current === null ? segment.to : current.start;
        current = { start: from, steps: [], closed: false };
        out.push(current);
      }
      current.steps.push(segment);
    }
  }
  return out.filter((sub) => sub.steps.length > 0);
}

/** Whether the path is one closed upright rectangle that is the whole box (`prstGeom rect` draws exactly that). */
function isUprightRectangle(shape: SceneShape): boolean {
  const subs = subpathsOf(shape.segments);
  const only = subs[0];
  if (subs.length !== 1 || only === undefined || !only.closed) return false;
  if (only.steps.some((step) => step.kind !== 'line')) return false;
  const corners: Point[] = [only.start, ...only.steps.map((step) => step.to)];
  // The fifth point may return to the start explicitly.
  const last = corners[corners.length - 1] as Point;
  if (
    corners.length === 5 &&
    Math.abs(last[0] - only.start[0]) < EPS &&
    Math.abs(last[1] - only.start[1]) < EPS
  ) {
    corners.pop();
  }
  if (corners.length !== 4) return false;
  const [p0, p1, p2, p3] = corners as [Point, Point, Point, Point];
  const same = (a: number, b: number): boolean => Math.abs(a - b) < EPS;
  const horizontalFirst =
    same(p0[1], p1[1]) && same(p1[0], p2[0]) && same(p2[1], p3[1]) && same(p3[0], p0[0]);
  const verticalFirst = same(p0[0], p1[0]) && same(p1[1], p2[1]) && same(p2[0], p3[0]) && same(p3[1], p0[1]);
  if (!horizontalFirst && !verticalFirst) return false;
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const [x0, y0, x1, y1] = shape.box;
  return (
    same(Math.min(...xs), x0) &&
    same(Math.max(...xs), x1) &&
    same(Math.min(...ys), y0) &&
    same(Math.max(...ys), y1)
  );
}

/** The subpath's outline as a polygon, curves cut into a few chords. */
function polygonOf(sub: Subpath): Point[] {
  const out: Point[] = [sub.start];
  let from = sub.start;
  for (const step of sub.steps) {
    if (step.kind === 'curve') {
      for (let i = 1; i < 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        out.push([
          u * u * u * from[0] +
            3 * u * u * t * step.c1[0] +
            3 * u * t * t * step.c2[0] +
            t * t * t * step.to[0],
          u * u * u * from[1] +
            3 * u * u * t * step.c1[1] +
            3 * u * t * t * step.c2[1] +
            t * t * t * step.to[1],
        ]);
      }
    }
    out.push(step.to);
    from = step.to;
  }
  return out;
}

/** Twice the signed area (shoelace); the sign is the direction. */
function signedArea(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

function contains(polygon: readonly Point[], [px, py]: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as Point;
    const [xj, yj] = polygon[j] as Point;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The same outline walked the other way, from the same start. */
function reversed(sub: Subpath): Subpath {
  const points: Point[] = [sub.start, ...sub.steps.map((step) => step.to)];
  const steps: Subpath['steps'] = [];
  for (let i = sub.steps.length - 1; i >= 0; i--) {
    const step = sub.steps[i] as Subpath['steps'][number];
    const to = points[i] as Point;
    steps.push(
      step.kind === 'curve' ? { kind: 'curve', c1: step.c2, c2: step.c1, to } : { kind: 'line', to },
    );
  }
  return { start: (sub.steps.at(-1) as Subpath['steps'][number]).to, steps, closed: sub.closed };
}

/**
 * The subpaths of an even-odd fill as nonzero ones: a subpath nested inside an odd number of
 * others is a hole, and runs against the direction of the outermost ones, so the winding
 * numbers cancel there.
 */
function nonzeroFromEvenOdd(subs: Subpath[]): Subpath[] {
  if (subs.length < 2) return subs;
  const polygons = subs.map(polygonOf);
  // A point is only tested against the polygons whose box holds it: cheap comparisons first,
  // the walk round every edge only for the few that nest.
  const bounds = polygons.map((polygon) => {
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const [x, y] of polygon) {
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
    }
    return box;
  });
  return subs.map((sub, i) => {
    const area = signedArea(polygons[i] as Point[]);
    if (area === 0) return sub;
    const [px, py] = sub.start;
    let depth = 0;
    for (let j = 0; j < subs.length; j++) {
      const box = bounds[j] as (typeof bounds)[number];
      if (j === i || px < box.x0 || px > box.x1 || py < box.y0 || py > box.y1) continue;
      if (contains(polygons[j] as Point[], sub.start)) depth += 1;
    }
    const wantPositive = depth % 2 === 0;
    return area > 0 === wantPositive ? sub : reversed(sub);
  });
}

function customGeometry(
  shape: SceneShape,
  k: number,
  originX: number,
  originY: number,
  cx: number,
  cy: number,
): string {
  let subs = subpathsOf(shape.segments);
  if (shape.fill?.evenOdd === true) subs = nonzeroFromEvenOdd(subs);
  const pt = ([px, py]: Point): string =>
    `<a:pt x="${Math.round(px * k - originX)}" y="${Math.round(py * k - originY)}"/>`;
  let path = '';
  for (const sub of subs) {
    path += `<a:moveTo>${pt(sub.start)}</a:moveTo>`;
    for (const step of sub.steps) {
      path +=
        step.kind === 'line'
          ? `<a:lnTo>${pt(step.to)}</a:lnTo>`
          : `<a:cubicBezTo>${pt(step.c1)}${pt(step.c2)}${pt(step.to)}</a:cubicBezTo>`;
    }
    if (sub.closed) path += '<a:close/>';
  }
  const attrs = `w="${cx}" h="${cy}"${shape.fill === null ? ' fill="none"' : ''}${shape.stroke === null ? ' stroke="0"' : ''}`;
  return (
    '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>' +
    `<a:pathLst><a:path ${attrs}>${path}</a:path></a:pathLst></a:custGeom>`
  );
}
