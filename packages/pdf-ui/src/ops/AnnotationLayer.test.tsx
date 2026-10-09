// @vitest-environment happy-dom
/**
 * The annotation layer: what it draws for the marks the session holds (every kind, turned and
 * unturned), and what each armed tool creates from a real pointer gesture. The page is a
 * 600 × 800 pt box drawn at 50 % at (100, 50) (a second one at (100, 500)), so a page point is
 * half its pixels away from the page's corner.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { AnnotationKind, AnnotationMark } from 'pdf-core/ops/annotations';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import {
  AnnotationLayer,
  type AnnotationLayerProps,
  type AnnotationTool,
  markVisual,
  selectionBoxes,
} from './AnnotationLayer';
import { clientOf, type FakePage, fakeViewer } from './layer-viewer.fixtures';
import { markPageFrameOf } from './mark-interaction';

const t = createTranslator('en');

let page: HTMLElement;
/** What `document.elementFromPoint` answers: the element under the pointer. */
let under: Element | null;
/** Where the pointer events of a gesture are dispatched: the page, or a link on it. */
let gestureTarget: Element;
let pointerUser: UserEvent;

beforeEach(() => {
  page = document.createElement('div');
  page.className = 'page';
  document.body.append(page);
  under = page;
  gestureTarget = page;
  document.elementFromPoint = () => under;
  pointerUser = userEvent.setup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
  document.body.replaceChildren();
});

function markOf(id: string, kind: AnnotationKind, overrides: Partial<AnnotationMark> = {}): AnnotationMark {
  return {
    id,
    kind,
    pageIndex: 0,
    quads: [],
    color: '#ff0000',
    opacity: 0.5,
    contents: '',
    author: 'Ada',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function show(overrides: Partial<AnnotationLayerProps> = {}) {
  const onCreate = vi.fn();
  const onDone = vi.fn();
  const onRegion = vi.fn();
  const props: AnnotationLayerProps = {
    t,
    tool: null,
    viewer: fakeViewer(),
    layout: 0,
    marks: [],
    onCreate,
    onDone,
    onRegion,
    color: '#ff0000',
    opacity: 0.5,
    thickness: 3,
    author: 'Ada',
    ...overrides,
  };
  const view = render(<AnnotationLayer {...props} />);
  const rerender = (next: Partial<AnnotationLayerProps>) =>
    view.rerender(<AnnotationLayer {...props} {...next} />);
  return { onCreate, onDone, onRegion, view, props, rerender, content: view.container };
}

type Client = { clientX: number; clientY: number };
const at = (x: number, y: number, pageIndex = 0): Client => clientOf({ x, y }, pageIndex);
const user = () => pointerUser;

async function press(coords: Client, target: Element = gestureTarget) {
  await user().pointer({ keys: '[MouseLeft>]', target, coords });
}
async function release(coords: Client, target: Element = gestureTarget) {
  await user().pointer({ keys: '[/MouseLeft]', target, coords });
}
async function moveTo(coords: Client, target: Element = gestureTarget) {
  await user().pointer({ target, coords });
}
async function drag(from: Client, ...through: Client[]) {
  await press(from);
  for (const point of through.slice(0, -1)) await moveTo(point);
  const last = through[through.length - 1] as Client;
  await moveTo(last);
  await release(last);
}

const ann = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-ann="${id}"]`) as HTMLElement;
const parts = (root: HTMLElement, id: string) => [...ann(root, id).children] as HTMLElement[];
const _polyline = (root: HTMLElement) => root.querySelector('polyline');
const pointsOf = (element: Element | null): number[][] =>
  (element?.getAttribute('points') ?? '').split(' ').map((pair) => pair.split(',').map(Number));

/** A text selection the browser made: happy-dom has no layout, so the client rects are given. */
function selectText(rects: readonly { left: number; top: number; right: number; bottom: number }[]) {
  const removeAllRanges = vi.fn();
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({
      getClientRects: () =>
        rects.map((rect) => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top })),
    }),
    removeAllRanges,
  } as unknown as Selection);
  return removeAllRanges;
}
/** The client rectangle of a page-point box. */
function rectOf(x0: number, y0: number, x1: number, y1: number, pageIndex = 0) {
  const first = at(x0, y0, pageIndex);
  const second = at(x1, y1, pageIndex);
  return { left: first.clientX, top: first.clientY, right: second.clientX, bottom: second.clientY };
}

/**
 * A link on the page, under the pointer: the gesture's events now reach it, as a real press on a
 * link does, so the click that follows the release is dispatched on it.
 */
function linkOnPage() {
  const link = document.createElement('a');
  link.href = '#target';
  page.append(link);
  under = link;
  gestureTarget = link;
  const opened = vi.fn();
  link.addEventListener('click', opened);
  return { link, opened };
}

/** A viewer whose pages can be taken off screen between the press and the render that follows. */
function switchable(pages?: readonly FakePage[]) {
  const base = fakeViewer(pages === undefined ? {} : { pages });
  const state = { hidden: false, noGeometry: false };
  const viewer = {
    ...base,
    pageRect: (pageIndex: number) => (state.hidden ? null : base.pageRect(pageIndex)),
    pageGeometry: (pageIndex: number) => (state.noGeometry ? null : base.pageGeometry(pageIndex)),
  } as ViewerApi;
  return { viewer, state };
}

describe('the armed tool is announced', () => {
  it.each<[AnnotationTool, string]>([
    ['highlight', 'Highlight'],
    ['underline', 'Underline'],
    ['strikeout', 'Strikeout'],
    ['squiggly', 'Squiggly'],
    ['ink', 'Freehand drawing'],
    ['shapes', 'Shape'],
    ['note', 'Note'],
    ['freetext', 'Text'],
    ['link', 'Add link'],
  ])('%s is named for assistive tech', (tool, label) => {
    show({ tool });
    expect(screen.getByText(label).getAttribute('aria-live')).toBe('polite');
  });

  it('says nothing while no tool is armed', () => {
    const { content } = show();
    expect(content.querySelector('[aria-live]')).toBeNull();
  });
});

describe('what the layer draws for held marks', () => {
  it('paints a highlight as a multiplied tint over its line box, in the root without a z-index', () => {
    const { content } = show({ marks: [markOf('h', 'highlight', { quads: [[100, 100, 200, 200]] })] });
    const [blended, layer] = [...content.children] as HTMLElement[];
    expect(blended?.className).not.toContain('z-20');
    expect(layer?.className).toContain('z-20');
    expect(blended?.contains(ann(content, 'h'))).toBe(true);
    const [box] = parts(content, 'h');
    expect(box?.style.left).toBe('150px');
    expect(box?.style.top).toBe('100px');
    expect(box?.style.width).toBe('50px');
    expect(box?.style.height).toBe('50px');
    expect(box?.style.background).toBe('#ff0000');
    expect(box?.style.opacity).toBe('0.5');
    expect(box?.style.mixBlendMode).toBe('multiply');
  });

  it('draws underline, strikeout and squiggly as bars at their own height in the line', () => {
    const quads = [[100, 100, 200, 200]] as const;
    const { content } = show({
      marks: [
        markOf('u', 'underline', { quads, thickness: 4 }),
        markOf('s', 'strikeout', { quads }),
        markOf('q', 'squiggly', { quads, opacity: 0.9 }),
      ],
    });
    const [underline] = parts(content, 'u');
    expect([underline?.style.height, underline?.style.marginTop, underline?.style.opacity]).toEqual([
      '2px',
      '50px',
      '0.6',
    ]);
    const [strike] = parts(content, 's');
    expect([strike?.style.height, strike?.style.marginTop, strike?.style.opacity]).toEqual([
      '1px',
      '25px',
      '0.6',
    ]);
    const [squiggle] = parts(content, 'q');
    expect([squiggle?.style.height, squiggle?.style.marginTop, squiggle?.style.opacity]).toEqual([
      '1.5px',
      '50px',
      '0.9',
    ]);
    expect(squiggle?.style.background).toContain('repeating-linear-gradient');
  });

  it('draws a note filled even at a low opacity, from its own rect', () => {
    const { content } = show({
      marks: [markOf('n', 'note', { rect: [100, 100, 124, 124], opacity: 0.1 })],
    });
    const [note] = parts(content, 'n');
    expect([note?.style.left, note?.style.top, note?.style.width, note?.style.height]).toEqual([
      '150px',
      '100px',
      '12px',
      '12px',
    ]);
    expect(note?.style.opacity).toBe('0.35');
    expect(note?.style.background).toBe('#ff0000');
  });

  it('draws a mark with no geometry at all as an empty identity node', () => {
    const { content } = show({ marks: [markOf('empty', 'underline')] });
    expect(ann(content, 'empty').children).toHaveLength(0);
  });

  it('draws a square and a circle as bordered boxes and a line as the stored diagonal', () => {
    const rect = [100, 100, 300, 200] as const;
    const { content } = show({
      marks: [
        markOf('sq', 'shapes', { rect, shape: 'square', thickness: 4, opacity: 2 }),
        markOf('ci', 'shapes', { rect, shape: 'circle' }),
        markOf('li', 'shapes', { rect, shape: 'line' }),
        markOf('plain', 'shapes', { quads: [[100, 100, 300, 200]] }),
      ],
    });
    const [square] = parts(content, 'sq');
    expect([square?.style.left, square?.style.top, square?.style.width, square?.style.height]).toEqual([
      '150px',
      '100px',
      '100px',
      '50px',
    ]);
    expect(square?.style.border).toBe('2px solid #ff0000');
    expect(square?.style.opacity).toBe('1');
    expect(square?.style.borderRadius).toBe('');
    const [circle] = parts(content, 'ci');
    expect(circle?.style.borderRadius).toBe('50%');
    expect(circle?.style.border).toBe('1px solid #ff0000');
    const [line] = parts(content, 'li');
    const segment = line?.querySelector('line');
    expect(['x1', 'y1', 'x2', 'y2', 'stroke-width'].map((name) => segment?.getAttribute(name))).toEqual([
      '150',
      '100',
      '250',
      '150',
      '1',
    ]);
    const [fallback] = parts(content, 'plain');
    expect(fallback?.style.width).toBe('100px');
  });

  it('draws a shape that carries no geometry as nothing', () => {
    const { content } = show({ marks: [markOf('none', 'shapes', { shape: 'square' })] });
    expect(ann(content, 'none').children).toHaveLength(0);
  });

  it('draws ink as one continuous polyline in page pixels, as thick as its scaled stroke', () => {
    const { content } = show({
      marks: [
        markOf('i', 'ink', { strokes: [[100, 100, 300, 100, 300, 300]], thickness: 6, opacity: 3 }),
        markOf('thin', 'ink', { strokes: [[0, 0, 10, 10]] }),
        markOf('blank', 'ink'),
      ],
    });
    const [svg] = parts(content, 'i');
    const line = svg?.querySelector('polyline');
    expect(pointsOf(line ?? null)).toEqual([
      [150, 100],
      [250, 100],
      [250, 200],
    ]);
    expect(line?.getAttribute('stroke-width')).toBe('3');
    expect(line?.getAttribute('stroke-opacity')).toBe('1');
    expect(svg?.style.mixBlendMode).toBe('');
    expect(parts(content, 'thin')[0]?.querySelector('polyline')?.getAttribute('stroke-width')).toBe('1');
    expect(ann(content, 'blank').children).toHaveLength(0);
  });

  it('draws a freehand highlight as a multiplied stroke and a stroke-less one as its line boxes', () => {
    const { content } = show({
      marks: [
        markOf('hs', 'highlight', { strokes: [[100, 100, 200, 200]], quads: [[100, 100, 200, 200]] }),
        markOf('hq', 'highlight', { strokes: [], quads: [[100, 300, 200, 400]] }),
      ],
    });
    const [svg] = parts(content, 'hs');
    expect(svg?.tagName.toLowerCase()).toBe('svg');
    expect(svg?.style.mixBlendMode).toBe('multiply');
    const [box] = parts(content, 'hq');
    expect(box?.tagName.toLowerCase()).toBe('span');
    expect(box?.style.top).toBe('200px');
  });

  it("draws typed text at its box in the writer's face and size, with a floored size", () => {
    const { content } = show({
      marks: [
        markOf('f', 'freetext', { rect: [100, 100, 300, 160], contents: 'Hello', fontSize: 20, opacity: 1 }),
        markOf('small', 'freetext', { quads: [[100, 300, 200, 340]], contents: 'tiny', fontSize: 1 }),
        markOf('default', 'freetext', { rect: [100, 400, 200, 440], contents: 'plain' }),
        markOf('nobox', 'freetext', { contents: 'lost' }),
      ],
    });
    const text = ann(content, 'f').firstElementChild as HTMLElement;
    expect(text.textContent).toBe('Hello');
    expect([text.style.left, text.style.top, text.style.width, text.style.height]).toEqual([
      '150px',
      '100px',
      '100px',
      '30px',
    ]);
    expect(text.style.fontSize).toBe('10px');
    expect(text.style.lineHeight).toBe('1.25');
    expect(text.style.padding).toBe('1px');
    expect(text.style.fontFamily).toContain('Pdf Noto Sans');
    expect(text.style.transform).toBe('');
    expect((ann(content, 'small').firstElementChild as HTMLElement).style.fontSize).toBe('3px');
    expect((ann(content, 'default').firstElementChild as HTMLElement).style.fontSize).toBe('6px');
    expect(ann(content, 'nobox').children).toHaveLength(0);
  });

  it('turns typed text by its own rotation about its centre', () => {
    const { content } = show({
      marks: [markOf('f', 'freetext', { rect: [100, 100, 300, 160], contents: 'Hello', rotation: 90 })],
    });
    const text = ann(content, 'f').firstElementChild as HTMLElement;
    expect(text.style.transform).toBe('rotate(90deg)');
    expect([text.style.left, text.style.width]).toEqual(['150px', '100px']);
  });

  it("adds the page's own /Rotate to typed text and leaves a full turn upright", () => {
    const turned: FakePage = {
      rect: { x: 100, y: 50, width: 400, height: 300 },
      box: { x: 0, y: 0, width: 600, height: 800 },
      rotation: 90,
    };
    const { content } = show({
      viewer: fakeViewer({ pages: [turned] }),
      marks: [
        markOf('a', 'freetext', { rect: [100, 100, 300, 160], contents: 'A' }),
        markOf('b', 'freetext', { rect: [100, 100, 300, 160], contents: 'B', rotation: 270 }),
      ],
    });
    expect((ann(content, 'a').firstElementChild as HTMLElement).style.transform).toBe('rotate(90deg)');
    expect((ann(content, 'b').firstElementChild as HTMLElement).style.transform).toBe('');
  });

  it("turns every visual clockwise about the mark's own centre", () => {
    const quads = [[100, 100, 200, 200]] as const;
    const { content } = show({
      marks: [
        markOf('h', 'highlight', { quads, rotation: 90 }),
        markOf('u', 'underline', { quads, rotation: 180 }),
        markOf('s', 'strikeout', { quads, rotation: 270 }),
        markOf('q', 'squiggly', { quads, rotation: 90 }),
        markOf('n', 'note', { quads, rotation: 90 }),
        markOf('sq', 'shapes', { rect: [100, 100, 200, 200], shape: 'square', rotation: 90 }),
      ],
    });
    // The mark's centre is (150, 150) pt → (175, 125) px.
    expect(parts(content, 'h')[0]?.style.transform).toBe('rotate(90deg)');
    expect(parts(content, 'h')[0]?.style.transformOrigin).toBe('25px 25px');
    expect(parts(content, 'u')[0]?.style.transform).toBe('rotate(180deg)');
    expect(parts(content, 'u')[0]?.style.transformOrigin).toBe('25px -25px');
    expect(parts(content, 's')[0]?.style.transform).toBe('rotate(270deg)');
    expect(parts(content, 's')[0]?.style.transformOrigin).toBe('25px 0px');
    expect(parts(content, 'q')[0]?.style.transformOrigin).toBe('25px -25px');
    expect(parts(content, 'n')[0]?.style.transformOrigin).toBe('25px 25px');
    expect(parts(content, 'sq')[0]?.style.transform).toBe('rotate(90deg)');
    expect(parts(content, 'sq')[0]?.style.transformOrigin).toBe('25px 25px');
  });

  it("turns ink and a line's own corners, not the box around them", () => {
    const { content } = show({
      marks: [
        markOf('i', 'ink', { strokes: [[100, 100, 300, 100]], rotation: 90 }),
        markOf('l', 'shapes', { rect: [100, 100, 300, 100], shape: 'line', rotation: 90 }),
      ],
    });
    // About the centre (200, 100): (100,100) → (200, 0), (300,100) → (200, 200) in page points.
    const ink = pointsOf(parts(content, 'i')[0]?.querySelector('polyline') ?? null);
    expect(ink[0]?.[0]).toBeCloseTo(200, 6);
    expect(ink[0]?.[1]).toBeCloseTo(50, 6);
    expect(ink[1]?.[0]).toBeCloseTo(200, 6);
    expect(ink[1]?.[1]).toBeCloseTo(150, 6);
    const segment = parts(content, 'l')[0]?.querySelector('line');
    expect(Number(segment?.getAttribute('x1'))).toBeCloseTo(200, 6);
    expect(Number(segment?.getAttribute('y1'))).toBeCloseTo(50, 6);
    expect(Number(segment?.getAttribute('x2'))).toBeCloseTo(200, 6);
    expect(Number(segment?.getAttribute('y2'))).toBeCloseTo(150, 6);
  });

  it('does not turn a mark whose rotation is zero or that has no geometry to turn about', () => {
    const { content } = show({
      marks: [
        markOf('zero', 'highlight', { quads: [[100, 100, 200, 200]], rotation: 0 }),
        markOf('nothing', 'highlight', { rotation: 90 }),
        markOf('strokes', 'ink', { strokes: [[100, 100, 200, 200]], rotation: 90 }),
      ],
    });
    expect(parts(content, 'zero')[0]?.style.transform).toBe('');
    expect(ann(content, 'nothing').children).toHaveLength(0);
    expect(parts(content, 'strokes')).toHaveLength(1);
  });

  it('draws marks on a page that is not on screen as nothing, and the others in place', () => {
    const { viewer, state } = switchable();
    state.hidden = true;
    const { content } = show({
      viewer,
      marks: [
        markOf('a', 'underline', { quads: [[0, 0, 10, 10]] }),
        markOf('b', 'underline', { quads: [[0, 0, 10, 10]] }),
      ],
    });
    expect(content.querySelector('[data-ann]')).toBeNull();
  });

  it('measures each page once however many marks it holds', () => {
    const viewer = fakeViewer();
    const rects = vi.spyOn(viewer, 'pageRect');
    show({
      viewer,
      marks: [
        markOf('a', 'underline', { quads: [[0, 0, 10, 10]] }),
        markOf('b', 'underline', { quads: [[20, 0, 30, 10]] }),
        markOf('c', 'underline', { pageIndex: 1, quads: [[20, 0, 30, 10]] }),
      ],
    });
    expect(rects.mock.calls.map(([index]) => index)).toEqual([0, 1]);
  });

  it('exports the same visual for a thumbnail, without the identity attribute', () => {
    const viewer = fakeViewer();
    const frame = markPageFrameOf(viewer, 0);
    if (frame === null) throw new Error('the fake page has a frame');
    const { container } = render(
      <>
        {markVisual(markOf('copy', 'underline', { quads: [[100, 100, 200, 200]] }), frame, false)}
        {markVisual(markOf('copy', 'freetext', { rect: [100, 100, 200, 200], contents: 'x' }), frame, false)}
      </>,
    );
    expect(container.querySelector('[data-ann]')).toBeNull();
    expect(container.querySelectorAll('span')).toHaveLength(1);
    expect(container.textContent).toBe('x');
  });
});

describe('what a selection measures', () => {
  it('has nothing to measure without a selection, a collapsed one or one with no ranges', () => {
    const viewer = fakeViewer();
    vi.spyOn(window, 'getSelection').mockReturnValueOnce(null);
    expect(selectionBoxes(viewer)).toEqual([]);
    vi.spyOn(window, 'getSelection').mockReturnValueOnce({ isCollapsed: true, rangeCount: 1 } as Selection);
    expect(selectionBoxes(viewer)).toEqual([]);
    vi.spyOn(window, 'getSelection').mockReturnValueOnce({ isCollapsed: false, rangeCount: 0 } as Selection);
    expect(selectionBoxes(viewer)).toEqual([]);
  });

  it('skips empty rects and rects off the pages or across a page break', () => {
    selectText([
      { left: 120, top: 100, right: 120, bottom: 120 },
      { left: 120, top: 100, right: 160, bottom: 100 },
      { left: 5, top: 5, right: 20, bottom: 20 },
      { left: 120, top: 440, right: 160, bottom: 520 },
    ]);
    expect(selectionBoxes(fakeViewer())).toEqual([]);
  });

  it('merges the spans of one line, keeps lines apart and splits per page', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: (index: number) => ({
        getClientRects: () =>
          (index === 0
            ? [rectOf(300, 300, 400, 320), rectOf(100, 100, 200, 120), rectOf(200, 102, 300, 122)]
            : [rectOf(100, 100, 200, 120, 1), rectOf(100, 130, 150, 150)]
          ).map((rect) => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top })),
      }),
      removeAllRanges: vi.fn(),
    } as unknown as Selection);
    expect(selectionBoxes(fakeViewer())).toEqual([
      {
        pageIndex: 0,
        boxes: [
          [100, 100, 300, 122],
          [100, 130, 150, 150],
          [300, 300, 400, 320],
        ],
      },
      { pageIndex: 1, boxes: [[100, 100, 200, 120]] },
    ]);
  });

  it('orders boxes that start on the same height from left to right', () => {
    selectText([rectOf(300, 100, 400, 120), rectOf(100, 100, 200, 120)]);
    expect(selectionBoxes(fakeViewer())).toEqual([{ pageIndex: 0, boxes: [[100, 100, 400, 120]] }]);
  });
});

describe('text marks', () => {
  it('marks the words already selected the moment the tool is armed', () => {
    const removeAllRanges = selectText([rectOf(100, 100, 300, 120), rectOf(100, 100, 200, 120, 1)]);
    const { onCreate, onDone, rerender } = show();
    rerender({ tool: 'underline' });
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate).toHaveBeenNthCalledWith(1, {
      id: expect.any(String),
      kind: 'underline',
      pageIndex: 0,
      quads: [[100, 100, 300, 120]],
      color: '#ff0000',
      opacity: 0.5,
      contents: '',
      author: 'Ada',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/u),
      thickness: 3,
    });
    expect(onCreate.mock.calls[1]?.[0]).toMatchObject({ pageIndex: 1, quads: [[100, 100, 200, 120]] });
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });

  it('marks nothing on arming when the selection is empty, or when the tool is not a text tool', () => {
    const { onCreate, rerender } = show();
    rerender({ tool: 'strikeout' });
    selectText([rectOf(100, 100, 300, 120)]);
    rerender({ tool: 'ink' });
    rerender({ tool: null });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('marks the selection when a press and release land on the page, once per page', async () => {
    const { onCreate, onDone } = show({ tool: 'squiggly' });
    await press(at(100, 100));
    const removeAllRanges = selectText([rectOf(100, 100, 300, 120), rectOf(100, 100, 200, 120, 1)]);
    await release(at(300, 120));
    expect(onCreate.mock.calls.map(([mark]) => [mark.kind, mark.pageIndex, mark.quads])).toEqual([
      ['squiggly', 0, [[100, 100, 300, 120]]],
      ['squiggly', 1, [[100, 100, 200, 120]]],
    ]);
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
  });

  it('lets the browser select: a text tool does not cancel the press', () => {
    show({ tool: 'underline' });
    expect(fireEvent.pointerDown(page, { ...at(100, 100), button: 0, pointerId: 1 })).toBe(true);
  });

  it('marks nothing when the release finds no selection or lands off the page', async () => {
    const { onCreate } = show({ tool: 'underline' });
    await release(at(100, 100));
    selectText([rectOf(100, 100, 300, 120)]);
    const chrome = document.createElement('div');
    document.body.append(chrome);
    under = chrome;
    await release(at(100, 100), chrome);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('does nothing for a release when the armed tool is not a text tool', async () => {
    const { onCreate } = show({ tool: 'note' });
    selectText([rectOf(100, 100, 300, 120)]);
    await release(at(100, 100));
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('the marker (highlight)', () => {
  it("marks the browser's selection when the press produced one, and cancels the link click it began on", async () => {
    const { link, opened } = linkOnPage();
    const { onCreate, onDone } = show({ tool: 'highlight' });
    await press(at(100, 100));
    const removeAllRanges = selectText([rectOf(100, 100, 300, 120)]);
    await release(at(300, 120));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      kind: 'highlight',
      quads: [[100, 100, 300, 120]],
    });
    expect(onCreate.mock.calls[0]?.[0].strokes).toBeUndefined();
    expect(removeAllRanges).toHaveBeenCalled();
    // The marker stays armed for the next stroke.
    expect(onDone).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('marks the selection of a double click on a word, which never moved, without touching any link', async () => {
    const link = document.createElement('a');
    link.href = '#target';
    document.body.append(link);
    const { onCreate } = show({ tool: 'highlight' });
    await press(at(100, 100));
    selectText([rectOf(100, 100, 160, 120)]);
    await release(at(100, 100));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ kind: 'highlight', quads: [[100, 100, 160, 120]] });
    expect(fireEvent.click(link)).toBe(true);
  });

  it('draws a freehand stroke multiplied while it is dragged, and writes it as one flat run', async () => {
    const { onCreate, content } = show({ tool: 'highlight' });
    await press(at(100, 100));
    await moveTo(at(200, 100));
    const [blended] = [...content.children] as HTMLElement[];
    const live = blended?.querySelector('svg');
    expect(live?.style.mixBlendMode).toBe('multiply');
    expect(pointsOf(live?.querySelector('polyline') ?? null)).toEqual([
      [150, 100],
      [200, 100],
    ]);
    expect(content.children[1]?.querySelector('polyline')).toBeNull();
    await moveTo(at(200, 200));
    await release(at(200, 200));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      kind: 'highlight',
      pageIndex: 0,
      quads: [[100, 100, 200, 200]],
      strokes: [[100, 100, 200, 100, 200, 200]],
      thickness: 3,
    });
    expect(content.querySelector('polyline')).toBeNull();
  });

  it('writes nothing for a press that never moved and found no selection', async () => {
    const { onCreate } = show({ tool: 'highlight' });
    await press(at(100, 100));
    await release(at(100, 100));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('does not ask the browser to capture the pointer, which would end the text selection', async () => {
    const capture = vi.fn();
    HTMLElement.prototype.setPointerCapture = capture;
    show({ tool: 'highlight' });
    await press(at(100, 100));
    await release(at(100, 100));
    expect(capture).not.toHaveBeenCalled();
  });

  it('cancels the link click after a freehand stroke that began on a link', async () => {
    const { opened } = linkOnPage();
    show({ tool: 'highlight' });
    await drag(at(100, 100), at(200, 200));
    expect(opened).not.toHaveBeenCalled();
  });
});

describe('pointer ownership', () => {
  it('draws nothing from a press that is not the primary button, off every page or over chrome', async () => {
    const { onCreate } = show({ tool: 'shapes' });
    await user().pointer([
      { keys: '[MouseRight>]', target: page, coords: at(100, 100) },
      { target: page, coords: at(300, 300) },
      { keys: '[/MouseRight]', target: page, coords: at(300, 300) },
    ]);
    await drag({ clientX: 5, clientY: 5 }, { clientX: 6, clientY: 6 }, { clientX: 60, clientY: 60 });
    const chrome = document.createElement('div');
    document.body.append(chrome);
    under = chrome;
    await drag(at(100, 100), at(300, 300));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('ignores a second pointer while a gesture is in flight, and a move or end from a stranger', async () => {
    const { onCreate } = show({ tool: 'shapes' });
    await press(at(100, 100));
    fireEvent.pointerDown(page, { ...at(500, 500), button: 0, pointerId: 9 });
    fireEvent.pointerMove(page, { ...at(550, 550), pointerId: 9 });
    fireEvent.pointerUp(page, { ...at(550, 550), pointerId: 9 });
    await moveTo(at(300, 300));
    await release(at(300, 300));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ quads: [[100, 100, 300, 300]] });
  });

  it('ignores moves outside the page, and moves onto another page than the press began on', async () => {
    const { onCreate } = show({ tool: 'shapes' });
    await press(at(100, 100));
    await moveTo(at(300, 300));
    await moveTo({ clientX: 700, clientY: 700 });
    await moveTo(at(500, 500, 1));
    await release(at(500, 500, 1));
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ pageIndex: 0, quads: [[100, 100, 300, 300]] });
  });

  it('lets go of a focused field when the tool takes the press, and cancels the press', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    show({ tool: 'ink' });
    expect(document.activeElement).toBe(field);
    expect(fireEvent.pointerDown(page, { ...at(100, 100), button: 0, pointerId: 1 })).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps drawing when the browser refuses to capture the pointer', async () => {
    HTMLElement.prototype.setPointerCapture = () => {
      throw new Error('no such pointer');
    };
    const { onCreate } = show({ tool: 'ink' });
    await drag(at(100, 100), at(200, 200));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('asks the browser to keep the pointer for a drag', async () => {
    const capture = vi.fn();
    HTMLElement.prototype.setPointerCapture = capture;
    show({ tool: 'ink' });
    await press(at(100, 100));
    expect(capture).toHaveBeenCalledWith(1);
  });
});

describe('ink', () => {
  it('draws the live stroke and writes one flat run with its bounding box, leaving the pen armed', async () => {
    const { onCreate, onDone, content } = show({ tool: 'ink' });
    await press(at(100, 100));
    await moveTo(at(300, 100));
    await moveTo(at(300, 300));
    const live = content.children[1]?.querySelector('polyline');
    expect(pointsOf(live ?? null)).toEqual([
      [150, 100],
      [250, 100],
      [250, 200],
    ]);
    expect(live?.getAttribute('stroke-width')).toBe('1.5');
    expect(live?.getAttribute('stroke-opacity')).toBe('0.5');
    expect(content.children[1]?.querySelector('svg')?.style.mixBlendMode).toBe('');
    await release(at(300, 300));
    expect(onCreate).toHaveBeenCalledWith({
      id: expect.any(String),
      kind: 'ink',
      pageIndex: 0,
      quads: [[100, 100, 300, 300]],
      color: '#ff0000',
      opacity: 0.5,
      contents: '',
      author: 'Ada',
      createdAt: expect.any(String),
      thickness: 3,
      strokes: [[100, 100, 300, 100, 300, 300]],
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(content.querySelector('polyline')).toBeNull();
  });

  it('finds the bounding box of a stroke that goes up and to the left', async () => {
    const { onCreate } = show({ tool: 'ink' });
    await drag(at(300, 300), at(100, 200), at(200, 100));
    expect(onCreate.mock.calls[0]?.[0].quads).toEqual([[100, 100, 300, 300]]);
  });

  it('writes nothing for a dot', async () => {
    const { onCreate } = show({ tool: 'ink' });
    await press(at(100, 100));
    await release(at(100, 100));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('draws nothing while the page is off screen, and keeps the stroke', async () => {
    const { viewer, state } = switchable();
    const { onCreate, content } = show({ tool: 'ink', viewer });
    await press(at(100, 100));
    state.hidden = true;
    await moveTo(at(200, 200));
    expect(content.querySelector('polyline')).toBeNull();
    state.hidden = false;
    await release(at(200, 200));
    expect(onCreate.mock.calls[0]?.[0].strokes).toEqual([[100, 100, 200, 200]]);
  });

  it('writes the stroke with callbacks the parent replaced mid-gesture', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = show({ tool: 'ink', onCreate: first });
    await press(at(100, 100));
    await moveTo(at(200, 200));
    rerender({ tool: 'ink', onCreate: second });
    await release(at(200, 200));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('abandoned gestures', () => {
  it("drops the drag when the pointer is cancelled, and ignores another pointer's cancel", async () => {
    const { onCreate, content } = show({ tool: 'ink' });
    await press(at(100, 100));
    await moveTo(at(200, 200));
    fireEvent.pointerCancel(page, { pointerId: 4 });
    expect(content.querySelector('polyline')).not.toBeNull();
    fireEvent.pointerCancel(page, { pointerId: 1 });
    expect(content.querySelector('polyline')).toBeNull();
    await release(at(200, 200));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('drops the drag when the window loses focus', async () => {
    const { onCreate, content } = show({ tool: 'shapes' });
    await press(at(100, 100));
    await moveTo(at(300, 300));
    expect(content.querySelector('span[aria-hidden]')).not.toBeNull();
    fireEvent.blur(window);
    expect(content.querySelector('span[aria-hidden]')).toBeNull();
    await release(at(300, 300));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('drops the drag when the tool is disarmed', async () => {
    const { onCreate, content, rerender } = show({ tool: 'ink' });
    await press(at(100, 100));
    await moveTo(at(200, 200));
    rerender({ tool: null });
    expect(content.querySelector('polyline')).toBeNull();
    await release(at(200, 200));
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('shapes and the link tool', () => {
  it('shows the rectangle while it is dragged, once it is large enough to see', async () => {
    const { content } = show({ tool: 'shapes' });
    await press(at(100, 100));
    expect(content.querySelector('span[aria-hidden]')).toBeNull();
    await moveTo(at(300, 200));
    const preview = content.querySelector<HTMLElement>('span[aria-hidden]');
    expect([preview?.style.left, preview?.style.top, preview?.style.width, preview?.style.height]).toEqual([
      '150px',
      '100px',
      '100px',
      '50px',
    ]);
    expect(preview?.style.opacity).toBe('0.35');
    expect(preview?.style.background).toBe('#ff0000');
  });

  it('shows a thin rectangle that is long enough on one side, and none for a page that left the screen', async () => {
    const { viewer, state } = switchable();
    const { content } = show({ tool: 'shapes', viewer, opacity: 0.2 });
    await press(at(100, 100));
    await moveTo(at(300, 101));
    expect(content.querySelector<HTMLElement>('span[aria-hidden]')?.style.opacity).toBe('0.2');
    state.hidden = true;
    await moveTo(at(300, 150));
    expect(content.querySelector('span[aria-hidden]')).toBeNull();
  });

  it.each<[AnnotationLayerProps['shape'], Record<string, unknown>]>([
    [undefined, { shape: 'square' }],
    ['circle', { shape: 'circle' }],
    ['line', { shape: 'line', strokes: [[100, 100, 300, 200]] }],
  ])('draws a %s from a drag and disarms the tool', async (shape, extra) => {
    const { onCreate, onDone } = show({ tool: 'shapes', ...(shape === undefined ? {} : { shape }) });
    await drag(at(300, 200), at(100, 100));
    expect(onCreate).toHaveBeenCalledWith({
      id: expect.any(String),
      kind: 'shapes',
      pageIndex: 0,
      quads: [[100, 100, 300, 200]],
      color: '#ff0000',
      opacity: 0.5,
      contents: '',
      author: 'Ada',
      createdAt: expect.any(String),
      thickness: 3,
      ...extra,
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('draws a shape without a done callback', async () => {
    const { onCreate } = show({ tool: 'shapes', onDone: undefined });
    await drag(at(100, 100), at(300, 300));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("draws nothing when a text tool is dragged: the browser's selection is the gesture", async () => {
    const { onCreate, content } = show({ tool: 'underline' });
    await press(at(100, 100));
    await moveTo(at(300, 300));
    expect(content.querySelector('span[aria-hidden]')).toBeNull();
    await release(at(300, 300));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('treats a drag under three points on either side as a click', async () => {
    const { onCreate, onRegion } = show({ tool: 'shapes' });
    await drag(at(100, 100), at(101, 101));
    await drag(at(100, 100), at(300, 101));
    await drag(at(100, 100), at(101, 300));
    expect(onCreate).not.toHaveBeenCalled();
    expect(onRegion).not.toHaveBeenCalled();
  });

  it("hands the link tool's rectangle to the shell instead of creating a mark", async () => {
    const { onCreate, onRegion, onDone } = show({ tool: 'link' });
    await drag(at(300, 200), at(100, 100));
    expect(onRegion).toHaveBeenCalledWith({ pageIndex: 0, rect: [100, 100, 300, 200] });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('lets the link tool run without handlers', async () => {
    const { onCreate } = show({ tool: 'link', onRegion: undefined, onDone: undefined });
    await drag(at(100, 100), at(300, 200));
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('notes', () => {
  it('places a note centred on the click, disarms the tool and cancels the press', async () => {
    const { onCreate, onDone } = show({ tool: 'note' });
    expect(fireEvent.pointerDown(page, { ...at(300, 300), button: 0, pointerId: 1 })).toBe(false);
    expect(onCreate).toHaveBeenCalledWith({
      id: expect.any(String),
      kind: 'note',
      pageIndex: 0,
      quads: [],
      color: '#ff0000',
      opacity: 0.5,
      contents: '',
      author: 'Ada',
      createdAt: expect.any(String),
      thickness: 3,
      rect: [288, 288, 312, 312],
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('keeps a note inside the page at every edge', async () => {
    const { onCreate } = show({ tool: 'note' });
    await click(at(2, 2));
    await click(at(599, 799));
    await click(at(590, 5));
    await click(at(5, 790));
    expect(onCreate.mock.calls.map(([mark]) => mark.rect)).toEqual([
      [0, 0, 24, 24],
      [576, 776, 600, 800],
      [576, 0, 600, 24],
      [0, 776, 24, 800],
    ]);
  });

  it("places an unclamped note when the page's geometry is unknown", async () => {
    const { viewer, state } = switchable();
    state.noGeometry = true;
    const { onCreate } = show({ tool: 'note', viewer });
    await click(at(300, 300));
    expect(onCreate.mock.calls[0]?.[0].rect).toEqual([300, 300, 324, 324]);
  });

  it('places a note without a done callback, and cancels the link click it began on', async () => {
    const { link, opened } = linkOnPage();
    const { onCreate } = show({ tool: 'note', onDone: undefined });
    await click(at(300, 300));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

async function click(coords: Client) {
  await press(coords);
  await release(coords);
}

describe('clicks that belong to a link', () => {
  it.each<[AnnotationTool]>([['shapes'], ['link'], ['ink']])(
    'swallows the click that follows a %s gesture drawn over a link, once',
    async (tool) => {
      const { link, opened } = linkOnPage();
      show({ tool });
      await drag(at(100, 100), at(300, 300));
      expect(opened).not.toHaveBeenCalled();
      expect(fireEvent.click(link)).toBe(true);
      expect(opened).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves the link's click alone when the gesture produced nothing", async () => {
    const { opened } = linkOnPage();
    show({ tool: 'shapes' });
    await drag(at(100, 100), at(101, 101));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('leaves clicks alone when the gesture did not start on a link', async () => {
    const link = document.createElement('a');
    link.href = '#target';
    document.body.append(link);
    show({ tool: 'shapes' });
    await drag(at(100, 100), at(300, 300));
    expect(fireEvent.click(link)).toBe(true);
  });
});

describe('typed text', () => {
  const editor = () =>
    screen.getByRole('textbox', { name: 'Text to add to the page' }) as HTMLTextAreaElement;

  it('opens a focused box at the click, as wide as the page allows up to 220 points', async () => {
    show({ tool: 'freetext', fontSize: 20, textColor: '#0000ff' });
    await click(at(100, 100));
    const field = editor();
    expect(document.activeElement).toBe(field);
    expect(field.placeholder).toBe('Type your text…');
    expect([field.style.left, field.style.top, field.style.width]).toEqual(['150px', '100px', '110px']);
    expect(field.style.minHeight).toBe('14.5px');
    expect(field.style.color).toBe('#0000ff');
    expect(field.style.fontSize).toBe('10px');
    expect(field.style.padding).toBe('1px');
  });

  it("narrows the box near the page's right edge, but never below 40 points", async () => {
    show({ tool: 'freetext' });
    await click(at(500, 100));
    expect(editor().style.width).toBe('50px');
    fireEvent.keyDown(editor(), { key: 'Escape' });
    await click(at(590, 100));
    expect(editor().style.width).toBe('20px');
  });

  it('offers the full width when the page cannot be measured at the press', async () => {
    const { viewer } = switchable();
    const base = viewer.pageRect.bind(viewer);
    const rect = vi.spyOn(viewer, 'pageRect');
    rect.mockReturnValueOnce(null);
    rect.mockImplementation(base);
    show({ tool: 'freetext', viewer });
    await click(at(590, 100));
    expect(editor().style.width).toBe('110px');
  });

  it('commits what was typed when the field loses focus, and disarms the tool', async () => {
    const { onCreate, onDone } = show({ tool: 'freetext', fontSize: 12, textColor: '#0000ff' });
    await click(at(100, 100));
    await user().keyboard('Hello  ');
    await user().tab();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      id: expect.any(String),
      kind: 'freetext',
      pageIndex: 0,
      quads: [],
      color: '#0000ff',
      opacity: 1,
      contents: 'Hello',
      author: 'Ada',
      createdAt: expect.any(String),
      thickness: 3,
      fontSize: 12,
      rect: [100, 100, 320, 119],
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('sizes the box by the lines the text measured, and clamps the font size', async () => {
    const { onCreate } = show({ tool: 'freetext', fontSize: 500 });
    await click(at(100, 100));
    const field = editor();
    Object.defineProperty(field, 'scrollHeight', { value: 200, configurable: true });
    await user().keyboard('tall');
    await user().tab();
    // 200 px / 0.5 = 400 pt; (400 - 4) / (200 × 1.25) = 1.58 → 2 lines of 250 pt + padding.
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ fontSize: 200 });
    const rect = onCreate.mock.calls[0]?.[0].rect as number[];
    expect((rect[3] as number) - (rect[1] as number)).toBe(504);
  });

  it('grows the field with its text as it is typed', async () => {
    show({ tool: 'freetext' });
    await click(at(100, 100));
    const field = editor();
    Object.defineProperty(field, 'scrollHeight', { value: 42, configurable: true });
    await user().keyboard('x');
    expect(field.style.height).toBe('42px');
  });

  it('commits with Ctrl+Enter and with Cmd+Enter, and keeps a plain Enter and other keys for the text', async () => {
    const { onCreate } = show({ tool: 'freetext' });
    await click(at(100, 100));
    await user().keyboard('one{Enter}two');
    expect(onCreate).not.toHaveBeenCalled();
    expect(editor().value).toBe('one\ntwo');
    await user().keyboard('{Control>}{Enter}{/Control}');
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0].contents).toBe('one\ntwo');
    await click(at(100, 300));
    await user().keyboard('three{Meta>}{Enter}{/Meta}');
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]?.[0].contents).toBe('three');
  });

  it('discards the box on Escape, without a mark, and says it is done', async () => {
    const { onCreate, onDone } = show({ tool: 'freetext' });
    await click(at(100, 100));
    await user().keyboard('typed{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('discards the box on Escape when no done callback was given', async () => {
    show({ tool: 'freetext', onDone: undefined });
    await click(at(100, 100));
    await user().keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('creates no mark from an empty or blank box', async () => {
    const { onCreate, onDone } = show({ tool: 'freetext' });
    await click(at(100, 100));
    await user().keyboard('  {Enter}  ');
    await user().tab();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('commits the open box with a press elsewhere instead of opening a second one', async () => {
    const { onCreate } = show({ tool: 'freetext' });
    await click(at(100, 100));
    await user().keyboard('first');
    await click(at(300, 300));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0].contents).toBe('first');
    expect(screen.queryByRole('textbox')).toBeNull();
    await click(at(300, 300));
    expect(editor().style.left).toBe('250px');
  });

  it('keeps a press inside the open box for the box', async () => {
    show({ tool: 'freetext' });
    await click(at(100, 100));
    const field = editor();
    under = field;
    await press(at(100, 100), field);
    await release(at(100, 100), field);
    expect(editor()).toBe(field);
  });

  it('drops an uncommitted box when the tool is disarmed', async () => {
    const { onCreate, rerender } = show({ tool: 'freetext' });
    await click(at(100, 100));
    await user().keyboard('typed');
    rerender({ tool: 'ink' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('creates no mark when the page left the screen before the field lost focus', async () => {
    const { viewer, state } = switchable();
    const { onCreate } = show({ tool: 'freetext', viewer });
    await click(at(100, 100));
    await user().keyboard('lost');
    state.hidden = true;
    await user().tab();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('removes the field when the page is no longer on screen', async () => {
    const { viewer, state } = switchable();
    const { rerender } = show({ tool: 'freetext', viewer });
    await click(at(100, 100));
    state.hidden = true;
    rerender({ tool: 'freetext', viewer });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('cancels the link click when the box was opened over a link', async () => {
    const { opened } = linkOnPage();
    show({ tool: 'freetext' });
    await click(at(100, 100));
    expect(opened).not.toHaveBeenCalled();
  });

  it('stores the box upright on a turned page, as the counter-turn in its own rotation', async () => {
    const turned: FakePage = {
      rect: { x: 100, y: 50, width: 400, height: 300 },
      box: { x: 0, y: 0, width: 600, height: 800 },
      rotation: 90,
    };
    const { onCreate } = show({ tool: 'freetext', viewer: fakeViewer({ pages: [turned] }) });
    await click(clientOf({ x: 100, y: 100 }, 0, [turned]));
    const width = Number.parseFloat(editor().style.width) / 0.5;
    await user().keyboard('turned');
    await user().tab();
    const mark = onCreate.mock.calls[0]?.[0] as AnnotationMark;
    expect(mark.rotation).toBe(270);
    const rect = mark.rect as readonly number[];
    expect((rect[2] as number) - (rect[0] as number)).toBeCloseTo(width, 6);
    expect((rect[3] as number) - (rect[1] as number)).toBeCloseTo(19, 6);
  });
});
