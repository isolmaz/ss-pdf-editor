/**
 * The scene's drawing as Word drawings: what each item becomes in the XML, read back with an
 * XML parser rather than matched as text.
 */

import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import {
  contentTypesXml,
  corePropertiesXml,
  documentRelsXml,
  PACKAGE_RELS,
  pageSectionXml,
  SHAPE_NAMESPACES,
  wordDocumentXml,
  XML_HEAD,
} from './docx-drawing';
import { sceneItemXml } from './docx-layout-shapes';
import type { PathSegment, SceneImage, SceneRaster, SceneShape, ShapeStroke } from './layout-scene';
import { DocxRegistry } from './layout-scene';

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  SHAPE_NAMESPACES;

function parse(runXml: string): Element {
  const failures: string[] = [];
  const doc = new DOMParser({
    errorHandler: (_level: string, message: string) => failures.push(message),
  } as never).parseFromString(`<root ${NS}>${runXml}</root>`, 'text/xml');
  expect(failures).toEqual([]);
  return doc.documentElement as unknown as Element;
}

const kids = (el: Element): Element[] =>
  Array.from(el.childNodes as ArrayLike<Node>).filter((n) => n.nodeType === 1) as Element[];
const names = (el: Element): string[] => kids(el).map((k) => k.nodeName);
const one = (el: Element, tag: string): Element => {
  const found = el.getElementsByTagName(tag);
  expect(found.length, tag).toBe(1);
  return found[0] as Element;
};
const all = (el: Element, tag: string): Element[] =>
  Array.from(el.getElementsByTagName(tag) as unknown as ArrayLike<Element>);
const num = (el: Element, attr: string): number => Number(el.getAttribute(attr));
const pts = (el: Element): [number, number][] =>
  all(el, 'a:pt').map((p) => [num(p, 'x'), num(p, 'y')] as [number, number]);

const EMU = 12700;
const stroke = (over: Partial<ShapeStroke> = {}): ShapeStroke => ({
  color: 0x112233,
  alpha: 1,
  width: 2,
  dash: [],
  cap: 'butt',
  join: 'miter',
  ...over,
});

const rectSegments = (x0: number, y0: number, x1: number, y1: number): PathSegment[] => [
  { kind: 'move', to: [x0, y0] },
  { kind: 'line', to: [x1, y0] },
  { kind: 'line', to: [x1, y1] },
  { kind: 'line', to: [x0, y1] },
  { kind: 'close' },
];

const shape = (over: Partial<SceneShape> & Pick<SceneShape, 'box' | 'segments'>): SceneShape => ({
  kind: 'shape',
  fill: { color: 0xff0000, alpha: 1, evenOdd: false },
  stroke: null,
  ...over,
});

const rectShape = (box: [number, number, number, number], over: Partial<SceneShape> = {}): SceneShape =>
  shape({ box, segments: rectSegments(...box), ...over });

/** A circle of radius `r` around (cx, cy) as four Béziers, clockwise on screen. */
function circleSegments(cx: number, cy: number, r: number): PathSegment[] {
  const k = 0.5522847498 * r;
  return [
    { kind: 'move', to: [cx + r, cy] },
    { kind: 'curve', c1: [cx + r, cy + k], c2: [cx + k, cy + r], to: [cx, cy + r] },
    { kind: 'curve', c1: [cx - k, cy + r], c2: [cx - r, cy + k], to: [cx - r, cy] },
    { kind: 'curve', c1: [cx - r, cy - k], c2: [cx - k, cy - r], to: [cx, cy - r] },
    { kind: 'curve', c1: [cx + k, cy - r], c2: [cx + r, cy - k], to: [cx + r, cy] },
    { kind: 'close' },
  ];
}

const render = (
  item: SceneShape | SceneImage | SceneRaster,
  scale = 1,
  registry = new DocxRegistry(),
): Element => parse(sceneItemXml(item, scale, registry));

describe('sceneItemXml: the anchor', () => {
  const item = rectShape([10, 20, 110, 70], { stroke: stroke() });

  it('is one run holding an anchor whose children are in the order the schema fixes', () => {
    const root = render(item);
    expect(names(root)).toEqual(['w:r']);
    const run = kids(root)[0] as Element;
    expect(names(run)).toEqual(['mc:AlternateContent']);
    const choice = kids(kids(run)[0] as Element)[0] as Element;
    expect(choice.nodeName).toBe('mc:Choice');
    expect(choice.getAttribute('Requires')).toBe('wps');
    const anchor = one(root, 'wp:anchor');
    expect(names(anchor)).toEqual([
      'wp:simplePos',
      'wp:positionH',
      'wp:positionV',
      'wp:extent',
      'wp:effectExtent',
      'wp:wrapNone',
      'wp:docPr',
      'wp:cNvGraphicFramePr',
      'a:graphic',
    ]);
    expect(one(root, 'a:graphicData').getAttribute('uri')).toBe(
      'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
    );
    expect(names(one(root, 'wps:wsp'))).toEqual(['wps:cNvSpPr', 'wps:spPr', 'wps:bodyPr']);
    expect(root.getElementsByTagName('mc:Fallback').length).toBe(0);
  });

  it('sits behind the text, from the page’s corner, without wrapping', () => {
    const anchor = one(render(item), 'wp:anchor');
    expect(anchor.getAttribute('behindDoc')).toBe('1');
    expect(one(anchor, 'wp:positionH').getAttribute('relativeFrom')).toBe('page');
    expect(one(anchor, 'wp:positionV').getAttribute('relativeFrom')).toBe('page');
  });

  it('places the box and sizes it in EMU, times the page scale', () => {
    const root = render(item, 0.5);
    expect(one(root, 'wp:positionH').textContent).toBe(String(5 * EMU));
    expect(one(root, 'wp:positionV').textContent).toBe(String(10 * EMU));
    const extent = one(root, 'wp:extent');
    expect([num(extent, 'cx'), num(extent, 'cy')]).toEqual([50 * EMU, 25 * EMU]);
    const xfrm = one(root, 'a:xfrm');
    expect([num(one(xfrm, 'a:off'), 'x'), num(one(xfrm, 'a:off'), 'y')]).toEqual([0, 0]);
    expect([num(one(xfrm, 'a:ext'), 'cx'), num(one(xfrm, 'a:ext'), 'cy')]).toEqual([50 * EMU, 25 * EMU]);
    // The stroke width is scaled too.
    expect(one(root, 'a:ln').getAttribute('w')).toBe(String(1 * EMU));
  });

  it('stacks in call order: z rises and drawing ids are unique and rising', () => {
    const registry = new DocxRegistry();
    const roots = [
      render(rectShape([0, 0, 10, 10]), 1, registry),
      render(
        { kind: 'raster', box: [0, 0, 5, 5], data: new Uint8Array([1]), mime: 'image/png' },
        1,
        registry,
      ),
      render(rectShape([0, 0, 20, 20]), 1, registry),
      render(
        { kind: 'image', box: [0, 0, 5, 5], data: new Uint8Array([2]), mime: 'image/jpeg' },
        1,
        registry,
      ),
    ];
    const z = roots.map((r) => num(one(r, 'wp:anchor'), 'relativeHeight'));
    const ids = roots.map((r) => num(one(r, 'wp:docPr'), 'id'));
    for (let i = 1; i < roots.length; i++) {
      expect(z[i] as number).toBeGreaterThan(z[i - 1] as number);
      expect(ids[i] as number).toBeGreaterThan(ids[i - 1] as number);
    }
    expect(new Set(ids).size).toBe(4);
  });
});

describe('sceneItemXml: geometry', () => {
  it('writes an upright rectangle as the preset rectangle, whichever way it starts', () => {
    const horizontalFirst = render(rectShape([0, 0, 40, 30]));
    expect(one(horizontalFirst, 'a:prstGeom').getAttribute('prst')).toBe('rect');
    expect(horizontalFirst.getElementsByTagName('a:custGeom').length).toBe(0);
    const verticalFirst = render(
      shape({
        box: [0, 0, 40, 30],
        segments: [
          { kind: 'move', to: [0, 0] },
          { kind: 'line', to: [0, 30] },
          { kind: 'line', to: [40, 30] },
          { kind: 'line', to: [40, 0] },
          { kind: 'line', to: [0, 0] },
          { kind: 'close' },
        ],
      }),
    );
    expect(one(verticalFirst, 'a:prstGeom').getAttribute('prst')).toBe('rect');
  });

  it('writes anything else as a custom path: a triangle and a tilted square are not rectangles', () => {
    const triangle = render(
      shape({
        box: [0, 0, 40, 30],
        segments: [
          { kind: 'move', to: [0, 30] },
          { kind: 'line', to: [40, 30] },
          { kind: 'line', to: [20, 0] },
          { kind: 'close' },
        ],
      }),
    );
    expect(triangle.getElementsByTagName('a:prstGeom').length).toBe(0);
    expect(pts(one(triangle, 'a:path'))).toEqual([
      [0, 30 * EMU],
      [40 * EMU, 30 * EMU],
      [20 * EMU, 0],
    ]);
    expect(names(one(triangle, 'a:path'))).toEqual(['a:moveTo', 'a:lnTo', 'a:lnTo', 'a:close']);

    const diamond = render(
      shape({
        box: [0, 0, 10, 10],
        segments: [
          { kind: 'move', to: [5, 0] },
          { kind: 'line', to: [10, 5] },
          { kind: 'line', to: [5, 10] },
          { kind: 'line', to: [0, 5] },
          { kind: 'close' },
        ],
      }),
    );
    expect(diamond.getElementsByTagName('a:custGeom').length).toBe(1);
  });

  it('keeps a rectangle that does not fill its box, or is not closed, as a path', () => {
    const open = render(
      shape({
        box: [0, 0, 40, 30],
        segments: rectSegments(0, 0, 40, 30).slice(0, 4),
      }),
    );
    expect(open.getElementsByTagName('a:prstGeom').length).toBe(0);
    const smaller = render(shape({ box: [0, 0, 50, 50], segments: rectSegments(0, 0, 40, 30) }));
    expect(smaller.getElementsByTagName('a:prstGeom').length).toBe(0);
  });

  it('writes a curve as cubicBezTo with its three points relative to the box', () => {
    const root = render(shape({ box: [100, 200, 140, 240], segments: circleSegments(120, 220, 20) }), 0.5);
    const custGeom = one(root, 'a:custGeom');
    expect(names(custGeom)).toEqual(['a:avLst', 'a:gdLst', 'a:ahLst', 'a:cxnLst', 'a:rect', 'a:pathLst']);
    const path = one(custGeom, 'a:path');
    expect([num(path, 'w'), num(path, 'h')]).toEqual([20 * EMU, 20 * EMU]);
    expect(names(path)).toEqual([
      'a:moveTo',
      'a:cubicBezTo',
      'a:cubicBezTo',
      'a:cubicBezTo',
      'a:cubicBezTo',
      'a:close',
    ]);
    const k = 0.5522847498 * 20;
    const half = (v: number): number => Math.round(v * 0.5 * EMU);
    const curves = all(path, 'a:cubicBezTo');
    // The first quarter: from (cx + r, cy) to (cx, cy + r), box origin (100, 200).
    expect(pts(curves[0] as Element)).toEqual([
      [half(40), half(20 + k)],
      [half(20 + k), half(40)],
      [half(20), half(40)],
    ]);
    expect(pts(one(path, 'a:moveTo'))).toEqual([[half(40), half(20)]]);
  });

  it('draws a horizontal rule: a box without height is as thick as the stroke, the line in its middle', () => {
    const root = render(
      shape({
        box: [10, 50, 110, 50],
        segments: [
          { kind: 'move', to: [10, 50] },
          { kind: 'line', to: [110, 50] },
        ],
        fill: null,
        stroke: stroke({ width: 4 }),
      }),
    );
    const extent = one(root, 'wp:extent');
    expect([num(extent, 'cx'), num(extent, 'cy')]).toEqual([100 * EMU, 4 * EMU]);
    expect(one(root, 'wp:positionH').textContent).toBe(String(10 * EMU));
    expect(one(root, 'wp:positionV').textContent).toBe(String(48 * EMU));
    const path = one(root, 'a:path');
    expect([num(path, 'w'), num(path, 'h')]).toEqual([100 * EMU, 4 * EMU]);
    expect(pts(path)).toEqual([
      [0, 2 * EMU],
      [100 * EMU, 2 * EMU],
    ]);
    expect(one(root, 'a:ln').getAttribute('w')).toBe(String(4 * EMU));
  });

  it('draws a vertical rule likewise, and gives a fill-only sliver an extent of at least 1 EMU', () => {
    const vertical = render(
      shape({
        box: [30, 10, 30, 60],
        segments: [
          { kind: 'move', to: [30, 10] },
          { kind: 'line', to: [30, 60] },
        ],
        fill: null,
        stroke: stroke({ width: 2 }),
      }),
    );
    const extent = one(vertical, 'wp:extent');
    expect([num(extent, 'cx'), num(extent, 'cy')]).toEqual([2 * EMU, 50 * EMU]);
    expect(one(vertical, 'wp:positionH').textContent).toBe(String(29 * EMU));
    expect(pts(one(vertical, 'a:path'))).toEqual([
      [1 * EMU, 0],
      [1 * EMU, 50 * EMU],
    ]);

    const sliver = render(rectShape([0, 5, 40, 5]));
    const sliverExtent = one(sliver, 'wp:extent');
    expect([num(sliverExtent, 'cx'), num(sliverExtent, 'cy')]).toEqual([40 * EMU, 1]);
    // A zero-height rectangle is no preset rectangle: it would not draw.
    expect(sliver.getElementsByTagName('a:prstGeom').length).toBe(0);
    expect(one(sliver, 'a:path').getAttribute('h')).toBe('1');
  });
});

describe('sceneItemXml: fill and line', () => {
  it('writes the fill as an RGB colour, with alpha only where it is not opaque', () => {
    const opaque = render(rectShape([0, 0, 10, 10], { fill: { color: 0x0a0b0c, alpha: 1, evenOdd: false } }));
    const solid = one(one(opaque, 'wps:spPr'), 'a:solidFill');
    expect(one(solid, 'a:srgbClr').getAttribute('val')).toBe('0A0B0C');
    expect(solid.getElementsByTagName('a:alpha').length).toBe(0);

    const glass = render(
      rectShape([0, 0, 10, 10], { fill: { color: 0xff8000, alpha: 0.25, evenOdd: false } }),
    );
    const fill = kids(one(glass, 'wps:spPr')).find((k) => k.nodeName === 'a:solidFill') as Element;
    expect(one(fill, 'a:srgbClr').getAttribute('val')).toBe('FF8000');
    expect(one(fill, 'a:alpha').getAttribute('val')).toBe('25000');
  });

  it('writes spPr children in schema order: transform, geometry, fill, line', () => {
    const root = render(rectShape([0, 0, 10, 10], { stroke: stroke() }));
    expect(names(one(root, 'wps:spPr'))).toEqual(['a:xfrm', 'a:prstGeom', 'a:solidFill', 'a:ln']);
  });

  it('writes no fill as noFill and a path that does not fill; no stroke as an empty line and a path that does not stroke', () => {
    const triangle: PathSegment[] = [
      { kind: 'move', to: [0, 10] },
      { kind: 'line', to: [10, 10] },
      { kind: 'line', to: [5, 0] },
      { kind: 'close' },
    ];
    const strokeOnly = render(
      shape({ box: [0, 0, 10, 10], segments: triangle, fill: null, stroke: stroke() }),
    );
    expect(kids(one(strokeOnly, 'wps:spPr')).map((k) => k.nodeName)).toEqual([
      'a:xfrm',
      'a:custGeom',
      'a:noFill',
      'a:ln',
    ]);
    expect(one(strokeOnly, 'a:path').getAttribute('fill')).toBe('none');
    expect(one(strokeOnly, 'a:path').hasAttribute('stroke')).toBe(false);

    const fillOnly = render(shape({ box: [0, 0, 10, 10], segments: triangle, stroke: null }));
    expect(one(fillOnly, 'a:path').getAttribute('stroke')).toBe('0');
    expect(one(fillOnly, 'a:path').hasAttribute('fill')).toBe(false);
    const ln = one(fillOnly, 'a:ln');
    expect(names(ln)).toEqual(['a:noFill']);
    expect(ln.hasAttribute('w')).toBe(false);

    const preset = render(rectShape([0, 0, 10, 10], { fill: null, stroke: stroke() }));
    expect(kids(one(preset, 'wps:spPr')).map((k) => k.nodeName)).toEqual([
      'a:xfrm',
      'a:prstGeom',
      'a:noFill',
      'a:ln',
    ]);
  });

  it('writes the stroke: colour with alpha, width, cap and join', () => {
    const cases = [
      { cap: 'butt', join: 'miter', capXml: 'flat', joinTag: 'a:miter' },
      { cap: 'round', join: 'round', capXml: 'rnd', joinTag: 'a:round' },
      { cap: 'square', join: 'bevel', capXml: 'sq', joinTag: 'a:bevel' },
    ] as const;
    for (const c of cases) {
      const ln = one(
        render(
          rectShape([0, 0, 10, 10], { stroke: stroke({ width: 3, alpha: 0.5, cap: c.cap, join: c.join }) }),
        ),
        'a:ln',
      );
      expect(ln.getAttribute('w')).toBe(String(3 * EMU));
      expect(ln.getAttribute('cap')).toBe(c.capXml);
      expect(one(ln, 'a:srgbClr').getAttribute('val')).toBe('112233');
      expect(one(ln, 'a:alpha').getAttribute('val')).toBe('50000');
      expect(names(ln)).toEqual(['a:solidFill', c.joinTag]);
    }
    expect(one(render(rectShape([0, 0, 10, 10], { stroke: stroke() })), 'a:miter').getAttribute('lim')).toBe(
      '800000',
    );
  });

  it('writes a dash as percentages of the line width, the dash pattern repeated if its length is odd', () => {
    const dashed = one(
      render(rectShape([0, 0, 10, 10], { stroke: stroke({ width: 2, dash: [6, 3, 1, 1] }) })),
      'a:ln',
    );
    expect(names(dashed)).toEqual(['a:solidFill', 'a:custDash', 'a:miter']);
    expect(all(dashed, 'a:ds').map((d) => [num(d, 'd'), num(d, 'sp')])).toEqual([
      [300000, 150000],
      [50000, 50000],
    ]);

    const odd = one(
      render(rectShape([0, 0, 10, 10], { stroke: stroke({ width: 1, dash: [2, 1, 3] }) })),
      'a:ln',
    );
    expect(all(odd, 'a:ds').map((d) => [num(d, 'd'), num(d, 'sp')])).toEqual([
      [200000, 100000],
      [300000, 200000],
      [100000, 300000],
    ]);

    // The dash is measured against the scaled width, so scaling the page keeps its look.
    const scaled = one(
      render(rectShape([0, 0, 10, 10], { stroke: stroke({ width: 2, dash: [6, 3] }) }), 0.5),
      'a:ds',
    );
    expect([num(scaled, 'd'), num(scaled, 'sp')]).toEqual([300000, 150000]);

    expect(
      one(render(rectShape([0, 0, 10, 10], { stroke: stroke() })), 'a:ln').getElementsByTagName('a:custDash')
        .length,
    ).toBe(0);
    expect(
      one(
        render(rectShape([0, 0, 10, 10], { stroke: stroke({ dash: [0, 0] }) })),
        'a:ln',
      ).getElementsByTagName('a:custDash').length,
    ).toBe(0);
  });
});

describe('sceneItemXml: even-odd fills', () => {
  /** Twice the signed area of the polygon through the points (shoelace). */
  const area = (points: [number, number][]): number => {
    let sum = 0;
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length] as [number, number];
      sum += p[0] * q[1] - q[0] * p[1];
    });
    return sum;
  };
  const subpathPoints = (path: Element): [number, number][][] => {
    const out: [number, number][][] = [];
    for (const step of kids(path)) {
      if (step.nodeName === 'a:moveTo') out.push([]);
      else if (step.nodeName === 'a:close') continue;
      const last = out[out.length - 1] as [number, number][];
      // Endpoints only: the last point of each step.
      const own = pts(step);
      if (own.length > 0) last.push(own[own.length - 1] as [number, number]);
    }
    return out;
  };
  const frame = (innerSameWay: boolean): PathSegment[] => [
    ...rectSegments(0, 0, 100, 100),
    ...(innerSameWay
      ? rectSegments(25, 25, 75, 75)
      : [
          { kind: 'move', to: [25, 25] } as PathSegment,
          { kind: 'line', to: [25, 75] } as PathSegment,
          { kind: 'line', to: [75, 75] } as PathSegment,
          { kind: 'line', to: [75, 25] } as PathSegment,
          { kind: 'close' } as PathSegment,
        ]),
  ];
  const evenOdd = { color: 0, alpha: 1, evenOdd: true };

  it('turns a hole round: the inner subpath runs against the outer one, so nonzero leaves it empty', () => {
    // Both written the same way, as a PDF's even-odd frame often is.
    const root = render(shape({ box: [0, 0, 100, 100], segments: frame(true), fill: evenOdd }));
    expect(all(root, 'a:path').length).toBe(1);
    const [outer, inner] = subpathPoints(one(root, 'a:path'));
    expect(Math.sign(area(outer as [number, number][]))).toBe(-Math.sign(area(inner as [number, number][])));
    // Same outline, only the direction changes.
    expect(new Set((inner as [number, number][]).map((p) => p.join()))).toEqual(
      new Set(
        [
          [25, 25],
          [75, 25],
          [75, 75],
          [25, 75],
        ].map(([x, y]) => `${(x as number) * EMU},${(y as number) * EMU}`),
      ),
    );
  });

  it('leaves a hole that already runs against the outer one as it was', () => {
    const asGiven = subpathPoints(
      one(render(shape({ box: [0, 0, 100, 100], segments: frame(false), fill: evenOdd })), 'a:path'),
    );
    const [outer, inner] = asGiven;
    expect(Math.sign(area(outer as [number, number][]))).toBe(-Math.sign(area(inner as [number, number][])));
    // The inner one was not turned twice: it starts where the input started.
    expect((inner as [number, number][])[0]).toEqual([25 * EMU, 25 * EMU]);
  });

  it('does not touch the direction of a nonzero fill', () => {
    const root = render(
      shape({ box: [0, 0, 100, 100], segments: frame(true), fill: { ...evenOdd, evenOdd: false } }),
    );
    const [outer, inner] = subpathPoints(one(root, 'a:path'));
    expect(Math.sign(area(outer as [number, number][]))).toBe(Math.sign(area(inner as [number, number][])));
  });

  it('alternates by depth, and turns a curved hole round with its curves reversed', () => {
    const segments: PathSegment[] = [
      ...rectSegments(0, 0, 100, 100),
      ...circleSegments(50, 50, 30),
      ...circleSegments(50, 50, 10),
    ];
    const root = render(shape({ box: [0, 0, 100, 100], segments, fill: evenOdd }));
    const [outer, ring, island] = subpathPoints(one(root, 'a:path')).map((p) => area(p));
    expect(Math.sign(outer as number)).toBe(-Math.sign(ring as number));
    expect(Math.sign(island as number)).toBe(Math.sign(outer as number));
    // The ring runs from the same start the other way: its first curve now goes up to (50, 20),
    // with its control points swapped end for end.
    const k = 0.5522847498 * 30;
    const e = (v: number): number => Math.round(v * EMU);
    const curves = all(one(root, 'a:path'), 'a:cubicBezTo');
    expect(pts(curves[0] as Element)).toEqual([
      [e(80), e(50 - k)],
      [e(50 + k), e(20)],
      [e(50), e(20)],
    ]);
    expect(pts(one(root, 'a:path').getElementsByTagName('a:moveTo').item(1) as Element)).toEqual([
      [e(80), e(50)],
    ]);
  });

  it('finishes a compound path of thousands of subpaths at once and still finds the hole', () => {
    // A frame with a hole, and 3 998 small squares side by side (outlined glyphs, a map's cells).
    const segments: PathSegment[] = [...frame(true)];
    for (let i = 0; i < 3998; i += 1) {
      const x = 200 + (i % 100) * 4;
      const y = Math.floor(i / 100) * 4;
      segments.push(...rectSegments(x, y, x + 2, y + 2));
    }
    const started = performance.now();
    const root = render(shape({ box: [0, 0, 600, 160], segments, fill: evenOdd }));
    expect(performance.now() - started).toBeLessThan(1000);
    const subpaths = subpathPoints(one(root, 'a:path')).map((p) => Math.sign(area(p)));
    expect(subpaths).toHaveLength(4000);
    const [outer, inner, firstSquare, lastSquare] = [subpaths[0], subpaths[1], subpaths[2], subpaths[3999]];
    expect(inner).toBe(-(outer as number));
    expect(firstSquare).toBe(outer);
    expect(lastSquare).toBe(outer);
  });

  it('leaves subpaths side by side as they are', () => {
    const segments = [...rectSegments(0, 0, 40, 40), ...rectSegments(60, 0, 100, 40)];
    const root = render(shape({ box: [0, 0, 100, 40], segments, fill: evenOdd }));
    const [left, right] = subpathPoints(one(root, 'a:path'));
    expect(Math.sign(area(left as [number, number][]))).toBe(Math.sign(area(right as [number, number][])));
  });
});

describe('sceneItemXml: pictures', () => {
  const png = new Uint8Array([0x89, 0x50]);
  const jpeg = new Uint8Array([0xff, 0xd8]);

  it('anchors an image behind the text with its media registered by type', () => {
    const registry = new DocxRegistry();
    const image: SceneImage = { kind: 'image', box: [10, 20, 110, 70], data: png, mime: 'image/png' };
    const jpegImage: SceneImage = { ...image, data: jpeg, mime: 'image/jpeg' };
    const first = render(image, 0.5, registry);
    const second = render(jpegImage, 1, registry);
    expect(registry.media.map((m) => [m.name, m.rid, m.data])).toEqual([
      ['image1.png', 'rIdImage1', png],
      ['image2.jpeg', 'rIdImage2', jpeg],
    ]);
    expect(one(first, 'a:blip').getAttribute('r:embed')).toBe('rIdImage1');
    expect(one(second, 'a:blip').getAttribute('r:embed')).toBe('rIdImage2');

    const anchor = one(first, 'wp:anchor');
    expect(anchor.getAttribute('behindDoc')).toBe('1');
    expect(names(first)).toEqual(['w:r']);
    const alternate = kids(kids(first)[0] as Element)[0] as Element;
    expect(names(kids(first)[0] as Element)).toEqual(['mc:AlternateContent']);
    expect(names(alternate)).toEqual(['mc:Choice', 'mc:Fallback']);
    expect(names(kids(alternate)[0] as Element)).toEqual(['w:drawing']);
    // A rectangle filled with the picture: a shape, so that it stacks with the page's other shapes.
    expect(one(first, 'a:prstGeom').getAttribute('prst')).toBe('rect');
    expect(one(first, 'a:blipFill').parentNode?.nodeName).toBe('wps:spPr');
    expect(first.getElementsByTagName('pic:pic').length).toBe(0);
    expect(names(anchor)).toEqual([
      'wp:simplePos',
      'wp:positionH',
      'wp:positionV',
      'wp:extent',
      'wp:effectExtent',
      'wp:wrapNone',
      'wp:docPr',
      'wp:cNvGraphicFramePr',
      'a:graphic',
    ]);
    expect(one(anchor, 'wp:positionH').textContent).toBe(String(5 * EMU));
    expect(one(anchor, 'wp:positionV').textContent).toBe(String(10 * EMU));
    expect([num(one(anchor, 'wp:extent'), 'cx'), num(one(anchor, 'wp:extent'), 'cy')]).toEqual([
      50 * EMU,
      25 * EMU,
    ]);
    expect(one(anchor, 'wp:docPr').getAttribute('name')).toBe('Picture 1');
    expect(one(second, 'wp:docPr').getAttribute('name')).toBe('Picture 2');
  });

  it('carries a VML fallback: the same rectangle, filled by the same relationship, at the same z', () => {
    const registry = new DocxRegistry();
    const image: SceneImage = { kind: 'image', box: [10.126, 20, 110, 70.004], data: png, mime: 'image/png' };
    const root = render(image, 0.5, registry);
    const fallback = one(root, 'mc:Fallback');
    expect(fallback.parentNode?.nodeName).toBe('mc:AlternateContent');
    expect(names(fallback)).toEqual(['w:pict']);
    const rect = one(fallback, 'v:rect');
    expect(rect.getAttribute('stroked')).toBe('f');
    // Points at two decimals: 5.063, 10, 49.94, 25.0 (the size is the extent the Choice has).
    expect(rect.getAttribute('style')).toBe(
      `position:absolute;margin-left:5.06pt;margin-top:10pt;width:49.94pt;height:25pt;mso-position-horizontal-relative:page;mso-position-vertical-relative:page;z-index:${num(one(root, 'wp:anchor'), 'relativeHeight')}`,
    );
    const fill = one(rect, 'v:fill');
    expect(fill.getAttribute('type')).toBe('frame');
    expect(fill.getAttribute('r:id')).toBe(one(root, 'a:blip').getAttribute('r:embed'));
    expect(registry.media).toHaveLength(1);
    // A raster is written the same way.
    const raster = render({ kind: 'raster', box: [0, 0, 30, 30], data: png, mime: 'image/png' }, 1, registry);
    expect(one(raster, 'v:fill').getAttribute('r:id')).toBe('rIdImage2');
    expect(one(raster, 'v:rect').getAttribute('style')).toContain('width:30pt;height:30pt;');
  });

  it('names a raster so and takes its z and id from the same registry as shapes', () => {
    const registry = new DocxRegistry();
    const before = render(rectShape([0, 0, 5, 5]), 1, registry);
    const raster = render({ kind: 'raster', box: [0, 0, 30, 30], data: png, mime: 'image/png' }, 1, registry);
    expect(one(raster, 'wp:docPr').getAttribute('name')).toBe('Raster 2');
    expect(num(one(raster, 'wp:docPr'), 'id')).toBe(num(one(before, 'wp:docPr'), 'id') + 1);
    expect(num(one(raster, 'wp:anchor'), 'relativeHeight')).toBeGreaterThan(
      num(one(before, 'wp:anchor'), 'relativeHeight'),
    );
    expect(registry.media).toHaveLength(1);
  });
});

describe('a Word file made of scene items', () => {
  const ONE_PIXEL_PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  );

  it('holds a rectangle, a circle and a picture; the package is well formed and a reader opens it', async () => {
    const registry = new DocxRegistry();
    const items = [
      rectShape([0, 0, 595, 842], { fill: { color: 0xffffff, alpha: 1, evenOdd: false } }),
      shape({
        box: [100, 100, 200, 200],
        segments: circleSegments(150, 150, 50),
        fill: { color: 0x3366cc, alpha: 0.5, evenOdd: false },
        stroke: stroke({ width: 3, cap: 'round', join: 'round', dash: [6, 3] }),
      }),
      { kind: 'image', box: [300, 300, 400, 380], data: ONE_PIXEL_PNG, mime: 'image/png' } as SceneImage,
    ];
    const runs = items.map((item) => sceneItemXml(item, 1, registry)).join('');
    const body = `<w:p><w:r><w:t>text</w:t></w:r>${runs}</w:p>${pageSectionXml(595, 842)}`;
    const files: Record<string, string | Uint8Array> = {
      '[Content_Types].xml': contentTypesXml(['png']),
      '_rels/.rels': PACKAGE_RELS('word/document.xml'),
      'docProps/core.xml': corePropertiesXml('shapes'),
      'word/document.xml': wordDocumentXml(body, SHAPE_NAMESPACES),
      'word/styles.xml': `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`,
      'word/_rels/document.xml.rels': documentRelsXml(registry.media.map((m) => m.name)),
    };
    for (const media of registry.media) files[`word/media/${media.name}`] = media.data;
    const zip = new JSZip();
    for (const [name, data] of Object.entries(files)) zip.file(name, data);
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const opened = await JSZip.loadAsync(bytes);
    expect(await opened.file('word/media/image1.png')?.async('uint8array')).toEqual(ONE_PIXEL_PNG);
    const documentXml = (await opened.file('word/document.xml')?.async('string')) as string;
    const failures: string[] = [];
    const doc = new DOMParser({
      errorHandler: (_l: string, m: string) => failures.push(m),
    } as never).parseFromString(documentXml, 'text/xml');
    expect(failures).toEqual([]);
    const anchors = Array.from(doc.getElementsByTagName('wp:anchor') as unknown as ArrayLike<Element>);
    expect(anchors).toHaveLength(3);
    expect(anchors.map((a) => Number(a.getAttribute('relativeHeight')))).toEqual([1, 2, 3]);
    expect(doc.getElementsByTagName('a:prstGeom').length).toBe(2); // the rectangle and the picture's rectangle
    expect(doc.getElementsByTagName('a:cubicBezTo').length).toBe(4);
    const rels = (await opened.file('word/_rels/document.xml.rels')?.async('string')) as string;
    expect(rels).toContain('Id="rIdImage1"');
    expect(rels).toContain('Target="media/image1.png"');
    expect(doc.getElementsByTagName('a:blip').item(0)?.getAttribute('r:embed')).toBe('rIdImage1');

    const read = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    expect(read.value).toContain('text');
  });
});
