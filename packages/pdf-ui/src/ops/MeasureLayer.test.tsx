// @vitest-environment happy-dom
/**
 * The measurement surface: the overlay that takes the pointer while a tool is armed (a click chain,
 * the live value, snapping, the grid, the marks the session holds) and the settings strip that
 * edits the state the shell owns. The page is a 600 × 800 pt box drawn at 50 % at (100, 50), so a
 * page point is half its pixels away from the page's corner, and the scale is 1:1 in inches so a
 * 72 pt chain reads one inch.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { MeasureMark, MeasureMode, MeasureScale } from 'pdf-core/ops/measure';
import { parseScale, scaleForRatio } from 'pdf-core/ops/measure';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { clientOf, type FakePage, type FakeViewerOptions, fakeViewer } from './layer-viewer.fixtures';
import {
  MeasureLayer,
  type MeasureLayerProps,
  type MeasureReading,
  MeasureSettings,
  type MeasureSettingsProps,
} from './MeasureLayer';

const t = createTranslator('en');
const INCH: MeasureScale = scaleForRatio(1, 'in');

const PAGE: FakePage = {
  rect: { x: 100, y: 50, width: 300, height: 400 },
  box: { x: 0, y: 0, width: 600, height: 800 },
};
/** The viewer's own geometry, plus the page count the grid walks. */
function viewerOf(options: FakeViewerOptions = {}): ViewerApi {
  const pages = options.pages ?? [PAGE, { ...PAGE, rect: { ...PAGE.rect, y: 500 } }];
  return Object.assign(fakeViewer({ ...options, pages }), {
    document: { pageCount: pages.length },
  }) as ViewerApi;
}

const at = (x: number, y: number, pageIndex = 0) => clientOf({ x, y }, pageIndex);

let pointer: UserEvent;
beforeEach(() => {
  pointer = userEvent.setup();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function show(overrides: Partial<MeasureLayerProps> = {}) {
  const callbacks = { onCreate: vi.fn(), onReading: vi.fn(), onStop: vi.fn() };
  const props: MeasureLayerProps = {
    t,
    viewer: viewerOf(),
    layout: 0,
    mode: 'distance',
    scale: INCH,
    marks: [],
    color: '#ff0000',
    opacity: 0.8,
    thickness: 2,
    author: 'Ada',
    ...callbacks,
    ...overrides,
  };
  const view = render(<MeasureLayer {...props} />);
  const rerender = (next: Partial<MeasureLayerProps>) =>
    view.rerender(<MeasureLayer {...props} {...callbacks} {...next} />);
  return { ...callbacks, view, props, rerender };
}

const surface = () => screen.getByRole('application', { name: 'Measure' });
async function clickAt(client: { clientX: number; clientY: number }) {
  await pointer.pointer({ keys: '[MouseLeft]', target: surface(), coords: client });
}
async function moveTo(client: { clientX: number; clientY: number }) {
  await pointer.pointer({ target: surface(), coords: client });
}

const lastReading = (onReading: Mock): MeasureReading | null => onReading.mock.calls.at(-1)?.[0] ?? null;

function markOf(overrides: Partial<MeasureMark> = {}): MeasureMark {
  return {
    id: 'm1',
    pageIndex: 0,
    mode: 'distance',
    points: [
      { x: 100, y: 100 },
      { x: 172, y: 100 },
    ],
    scale: INCH,
    color: '#0000ff',
    opacity: 0.5,
    thickness: 3,
    author: 'Ada',
    contents: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the marks the session holds', () => {
  it('draws a distance as a polyline with its own value at the last point', () => {
    const { view } = show({ mode: null, marks: [markOf()] });
    const mark = within(view.container).getByRole('button', { name: 'Distance' });
    expect(mark.getAttribute('data-measure')).toBe('m1');
    const line = mark.querySelector('polyline') as SVGPolylineElement;
    expect(line.getAttribute('points')).toBe('150,100 186,100');
    expect(line.getAttribute('stroke')).toBe('#0000ff');
    expect(line.getAttribute('stroke-opacity')).toBe('0.5');
    expect(line.getAttribute('stroke-width')).toBe('3');
    const value = within(mark).getByText('1,00 in');
    expect(value.style.left).toBe('186px');
    expect(value.style.top).toBe('86px');
  });

  it('draws an area as a polygon filled at most a quarter opaque, one pixel wide when no thickness is given', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 72, y: 0 },
      { x: 72, y: 72 },
      { x: 0, y: 72 },
    ];
    const { view } = show({
      mode: null,
      marks: [markOf({ mode: 'area', points: square, opacity: 0.9, thickness: undefined })],
    });
    const mark = within(view.container).getByRole('button', { name: 'Area' });
    const polygon = mark.querySelector('polygon') as SVGPolygonElement;
    expect(polygon.getAttribute('points')).toBe('100,50 136,50 136,86 100,86');
    expect(polygon.getAttribute('fill-opacity')).toBe('0.25');
    expect(polygon.getAttribute('stroke-opacity')).toBe('0.9');
    expect(polygon.getAttribute('stroke-width')).toBe('1');
    expect(within(mark).getByText('1,00 in²')).toBeTruthy();
  });

  it('keeps a polyline one pixel wide when the mark has no thickness, and names a perimeter', () => {
    const { view } = show({ mode: null, marks: [markOf({ mode: 'perimeter', thickness: undefined })] });
    const mark = within(view.container).getByRole('button', { name: 'Perimeter' });
    expect((mark.querySelector('polyline') as SVGPolylineElement).getAttribute('stroke-width')).toBe('1');
  });

  it('reads a distance of more than two points as the chain’s length instead of failing', () => {
    const { view } = show({
      mode: null,
      marks: [
        markOf({
          points: [
            { x: 0, y: 0 },
            { x: 72, y: 0 },
            { x: 72, y: 72 },
          ],
        }),
      ],
    });
    expect(within(view.container).getByText('2,00 in')).toBeTruthy();
  });

  it('places a mark on a rotated page through the page’s own rotation and scale', () => {
    const rotated: FakePage = {
      rect: { x: 100, y: 50, width: 400, height: 300 },
      box: { x: 0, y: 0, width: 600, height: 800 },
      rotation: 90,
    };
    const { view } = show({
      mode: null,
      viewer: viewerOf({ pages: [rotated] }),
      marks: [
        markOf({
          points: [
            { x: 100, y: 200 },
            { x: 172, y: 200 },
          ],
        }),
      ],
    });
    expect((view.container.querySelector('polyline') as SVGPolylineElement).getAttribute('points')).toBe(
      '400,100 400,136',
    );
  });

  it('draws nothing for a mark whose page the viewer has not laid out', () => {
    const { view } = show({ mode: null, marks: [markOf({ pageIndex: 5 })] });
    expect(view.container.querySelector('[data-measure]')).toBeNull();
  });

  it('draws nothing for a page that has no area', () => {
    const empty: FakePage = { ...PAGE, box: { x: 0, y: 0, width: 0, height: 800 } };
    const { view } = show({ mode: null, viewer: viewerOf({ pages: [empty] }), marks: [markOf()] });
    expect(view.container.querySelector('[data-measure]')).toBeNull();
  });

  it('draws nothing for a page whose geometry the viewer does not have', () => {
    const viewer = { ...viewerOf(), pageGeometry: () => null } as unknown as ViewerApi;
    const { view } = show({ mode: null, viewer, marks: [markOf()] });
    expect(view.container.querySelector('[data-measure]')).toBeNull();
  });

  it('puts the key on the mark’s label when the dictionary does not carry it', () => {
    const bare = ((key: string) =>
      key === 'tools.measure.distance' ? undefined : t(key as never)) as typeof t;
    const { view } = show({ mode: null, t: bare, marks: [markOf()] });
    expect(within(view.container).getByRole('button', { name: 'tools.measure.distance' })).toBeTruthy();
  });

  it('has no tool surface until a tool is armed', () => {
    show({ mode: null });
    expect(screen.queryByRole('application')).toBeNull();
  });
});

describe('measuring with the tool armed', () => {
  it('reads the live value at the pointer, from the first click', async () => {
    const { onReading } = show();
    await clickAt(at(100, 100));
    expect(lastReading(onReading)).toEqual({
      primary: '0,000 in',
      secondary: null,
      angle: '0,0°',
      points: 2,
    });
    await moveTo(at(172, 100));
    expect(lastReading(onReading)).toEqual({ primary: '1,00 in', secondary: null, angle: '0,0°', points: 2 });
  });

  it('does not republish a reading the pointer has not changed', async () => {
    const { onReading } = show();
    await clickAt(at(100, 100));
    const published = onReading.mock.calls.length;
    await moveTo(at(100, 100));
    expect(onReading).toHaveBeenCalledTimes(published);
  });

  it('reports the boundary beside the area in area mode', async () => {
    const { onReading } = show({ mode: 'area' });
    await clickAt(at(0, 0));
    await moveTo(at(72, 72));
    expect(lastReading(onReading)).toEqual({
      primary: '1,00 in²',
      secondary: '4,00 in',
      angle: '315,0°',
      points: 2,
    });
  });

  it('has no value for a chain the geometry refuses: a second click leaves a distance three points long', async () => {
    const { onReading } = show();
    await clickAt(at(0, 0));
    expect(lastReading(onReading)?.points).toBe(2);
    await clickAt(at(72, 0));
    expect(lastReading(onReading)).toBeNull();
  });

  it('draws the chain dashed, with a dot at every point, in the tool’s colour', async () => {
    const { view } = show();
    await clickAt(at(0, 0));
    await moveTo(at(72, 0));
    const line = view.container.querySelector('polyline[stroke-dasharray="4 3"]') as SVGPolylineElement;
    expect(line.getAttribute('points')).toBe('100,50 136,50');
    expect(line.getAttribute('stroke')).toBe('#ff0000');
    expect(line.getAttribute('stroke-width')).toBe('2');
    expect(
      [...view.container.querySelectorAll('circle')].map((dot) => [
        dot.getAttribute('cx'),
        dot.getAttribute('cy'),
      ]),
    ).toEqual([
      ['100', '50'],
      ['136', '50'],
    ]);
  });

  it('draws no chain while the page it started on is off screen, and again when it is back', async () => {
    let laidOut = true;
    const base = viewerOf();
    const viewer = {
      ...base,
      pageRect: (index: number) => (laidOut ? base.pageRect(index) : null),
    } as unknown as ViewerApi;
    const { view, rerender } = show({ viewer });
    await clickAt(at(0, 0));
    await moveTo(at(72, 0));
    expect(view.container.querySelector('polyline[stroke-dasharray]')).not.toBeNull();
    laidOut = false;
    rerender({ viewer, opacity: 0.5 });
    expect(view.container.querySelector('polyline[stroke-dasharray]')).toBeNull();
    laidOut = true;
    rerender({ viewer, opacity: 0.6 });
    expect(view.container.querySelector('polyline[stroke-dasharray]')).not.toBeNull();
  });

  it('has no value for a chain whose page went off screen when a point is taken back', async () => {
    let laidOut = true;
    const base = viewerOf();
    const viewer = {
      ...base,
      pageRect: (index: number) => (laidOut ? base.pageRect(index) : null),
    } as unknown as ViewerApi;
    const { onReading } = show({ mode: 'perimeter', viewer });
    await clickAt(at(0, 0));
    await clickAt(at(72, 0));
    expect(lastReading(onReading)?.primary).toBe('1,00 in');
    laidOut = false;
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(lastReading(onReading)).toBeNull();
  });

  it('ignores a press that is not the primary button, a press off every page and a page that has no frame', async () => {
    const { onReading } = show();
    await pointer.pointer({ keys: '[MouseRight]', target: surface(), coords: at(100, 100) });
    await clickAt({ clientX: 5, clientY: 5 });
    expect(onReading).not.toHaveBeenCalled();
    cleanup();
    const noGeometry = { ...viewerOf(), pageGeometry: () => null } as unknown as ViewerApi;
    const none = show({ viewer: noGeometry });
    await clickAt(at(100, 100));
    await moveTo(at(120, 100));
    expect(none.onReading).not.toHaveBeenCalled();
  });

  it('ignores a pointer that moves off every page', async () => {
    const { onReading } = show();
    await clickAt(at(0, 0));
    await moveTo({ clientX: 5, clientY: 5 });
    expect(lastReading(onReading)).toEqual({
      primary: '0,000 in',
      secondary: null,
      angle: '0,0°',
      points: 2,
    });
  });

  it('keeps a chain on the page it started on: a press on the next page starts nothing', async () => {
    const { onReading } = show();
    await clickAt(at(0, 0));
    await clickAt(at(72, 0, 1));
    expect(lastReading(onReading)?.points).toBe(2);
  });

  it('drops a chain the moment the tool is disarmed', async () => {
    const { onReading, rerender, view } = show();
    await clickAt(at(0, 0));
    await moveTo(at(72, 0));
    expect(lastReading(onReading)?.primary).toBe('1,00 in');
    rerender({ mode: null });
    expect(lastReading(onReading)).toBeNull();
    expect(view.container.querySelector('circle')).toBeNull();
    rerender({ mode: 'distance' });
    await moveTo(at(0, 0));
    expect(lastReading(onReading)).toBeNull();
  });

  it('clears the reading when the layer goes away', async () => {
    const { onReading, view } = show();
    await clickAt(at(0, 0));
    expect(lastReading(onReading)).not.toBeNull();
    view.unmount();
    expect(lastReading(onReading)).toBeNull();
  });
});

describe('snapping', () => {
  it('locks the pointer onto a vertex of the chain within six points', async () => {
    const { onReading } = show({ mode: 'perimeter', snapPoints: true });
    await clickAt(at(100, 100));
    await clickAt(at(172, 100));
    await moveTo(at(103, 104));
    // The pointer is within six points of the first vertex and lands on it: 72 pt out, 72 pt back.
    expect(lastReading(onReading)).toEqual({ primary: '2,00 in', secondary: null, angle: '0,0°', points: 3 });
    // Thirty points from the last vertex it is just the pointer: 72 pt out, 30 pt along.
    await moveTo(at(172, 130));
    expect(lastReading(onReading)?.primary).toBe('1,42 in');
  });

  it('leaves the pointer alone with no chain to snap to', async () => {
    const { onReading } = show({ snapPoints: true });
    await clickAt(at(100, 100));
    await moveTo(at(172, 100));
    expect(lastReading(onReading)?.primary).toBe('1,00 in');
  });

  it('rounds the pointer to the grid when both the grid and its snapping are on', async () => {
    const { onReading } = show({ grid: true, snapGrid: true, gridSpacing: 50 });
    await clickAt(at(0, 0));
    await moveTo(at(74, 61));
    // (74, 61) snaps to (50, 50) on the 50 pt grid.
    expect(lastReading(onReading)?.primary).toBe('0,982 in');
  });

  it('leaves the pointer off the grid when only one of the two is on, or the spacing is not positive', async () => {
    const { onReading, rerender } = show({ grid: true, snapGrid: false, gridSpacing: 50 });
    await clickAt(at(0, 0));
    await moveTo(at(72, 0));
    expect(lastReading(onReading)?.primary).toBe('1,00 in');
    rerender({ grid: true, snapGrid: true, gridSpacing: 0 });
    await moveTo(at(36, 0));
    expect(lastReading(onReading)?.primary).toBe('0,500 in');
  });
});

describe('finishing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-04T05:06:07.000Z'));
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  });

  const created = (points: readonly { x: number; y: number }[], mode: MeasureMode = 'distance') => ({
    id: '00000000-0000-4000-8000-000000000001',
    pageIndex: 0,
    mode,
    points,
    scale: INCH,
    color: '#ff0000',
    opacity: 0.8,
    thickness: 2,
    author: 'Ada',
    contents: '',
    createdAt: '2026-03-04T05:06:07.000Z',
  });

  it('hands the chain to the app on Enter, and starts a fresh one', async () => {
    const { onCreate, onReading } = show();
    await clickAt(at(0, 0));
    await clickAt(at(72, 0));
    // Two clicks and the pointer's own place make three points, which a distance cannot be.
    await press('{Enter}');
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      created([
        { x: 0, y: 0 },
        { x: 72, y: 0 },
      ]),
    );
    expect(lastReading(onReading)).toBeNull();
    await press('{Enter}');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('hands over an area as the points that were clicked', async () => {
    const { onCreate } = show({ mode: 'area' });
    await clickAt(at(0, 0));
    await clickAt(at(72, 72));
    await press('{Enter}');
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      created(
        [
          { x: 0, y: 0 },
          { x: 72, y: 72 },
        ],
        'area',
      ),
    );
  });

  it('finishes on a double click too', async () => {
    const { onCreate } = show({ mode: 'perimeter' });
    await clickAt(at(0, 0));
    await clickAt(at(72, 0));
    fireEvent.doubleClick(surface());
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      created(
        [
          { x: 0, y: 0 },
          { x: 72, y: 0 },
        ],
        'perimeter',
      ),
    );
  });

  it('writes nothing for a chain of one point', async () => {
    const { onCreate } = show();
    await clickAt(at(0, 0));
    await press('{Backspace}');
    await clickAt(at(0, 0));
    fireEvent.doubleClick(surface());
    // One click is a chain of one point; the double click has nothing to finish.
    expect(onCreate).not.toHaveBeenCalled();
  });
});

/** One key press on the page, which is where the tool's key handler listens (`window`). */
async function press(keys: string) {
  await pointer.keyboard(keys);
}

describe('the keyboard', () => {
  it('clears the chain on the first Escape and ends the tool on the second', async () => {
    const { onStop, onReading } = show();
    await clickAt(at(0, 0));
    await press('{Escape}');
    expect(onStop).not.toHaveBeenCalled();
    expect(lastReading(onReading)).toBeNull();
    await press('{Escape}');
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('takes the last point back on Backspace, and the chain with its only point', async () => {
    const { onReading, view } = show({ mode: 'perimeter' });
    await clickAt(at(0, 0));
    await clickAt(at(72, 0));
    await clickAt(at(72, 72));
    expect(view.container.querySelectorAll('circle')).toHaveLength(4);
    expect(fireEvent.keyDown(window, { key: 'Backspace' })).toBe(false);
    expect(view.container.querySelectorAll('circle')).toHaveLength(3);
    // Two points are left: the first one and the pointer, still where the last click put it.
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(lastReading(onReading)?.primary).toBe('1,41 in');
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(lastReading(onReading)).toBeNull();
  });

  it('leaves Backspace to the page when there is no chain, and every other key too', async () => {
    const { onReading, onStop } = show();
    expect(fireEvent.keyDown(window, { key: 'Backspace' })).toBe(true);
    expect(fireEvent.keyDown(window, { key: 'a' })).toBe(true);
    expect(onReading).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('listens to nothing while no tool is armed', async () => {
    const { onStop } = show({ mode: null });
    await press('{Escape}');
    expect(onStop).not.toHaveBeenCalled();
  });
});

describe('the grid', () => {
  const tiny: FakePage = {
    rect: { x: 100, y: 50, width: 20, height: 20 },
    box: { x: 0, y: 0, width: 20, height: 20 },
  };

  it('draws a line at every multiple of the spacing over each page, horizontals first', () => {
    const { view } = show({ grid: true, gridSpacing: 10, viewer: viewerOf({ pages: [tiny] }) });
    const paths = view.container.querySelectorAll('path');
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute('d')).toBe(
      [
        'M100 50L120 50',
        'M100 60L120 60',
        'M100 70L120 70',
        'M100 50L100 70',
        'M110 50L110 70',
        'M120 50L120 70',
      ].join(' '),
    );
  });

  it('draws no grid unless a tool is armed with it on', () => {
    const off = show({ grid: false, viewer: viewerOf({ pages: [tiny] }) });
    expect(off.view.container.querySelector('path')).toBeNull();
    cleanup();
    const idle = show({ grid: true, mode: null, viewer: viewerOf({ pages: [tiny] }) });
    expect(idle.view.container.querySelector('path')).toBeNull();
  });

  it('skips a page where the lines would be closer than six pixels, and one that is not laid out', () => {
    const second: FakePage = { ...PAGE, hidden: true };
    const { view } = show({ grid: true, gridSpacing: 5, viewer: viewerOf({ pages: [tiny, second, PAGE] }) });
    // 5 pt at 100 % is five pixels (too dense), at 50 % it is two and a half: nothing is drawn.
    expect(view.container.querySelector('path')).toBeNull();
  });

  it('walks a bounded number of pages', () => {
    const pages = Array.from({ length: 30 }, (_, index) => ({
      ...tiny,
      rect: { ...tiny.rect, y: 50 + index * 30 },
    }));
    const { view } = show({ grid: true, gridSpacing: 10, viewer: viewerOf({ pages }) });
    expect(view.container.querySelectorAll('path')).toHaveLength(24);
  });

  it('steps at least one point even when the spacing is smaller', () => {
    const zoomed: FakePage = { ...tiny, rect: { ...tiny.rect, width: 200, height: 200 } };
    const { view } = show({ grid: true, gridSpacing: 0.5, viewer: viewerOf({ pages: [zoomed] }) });
    const d = view.container.querySelector('path')?.getAttribute('d') ?? '';
    // 21 horizontals and 21 verticals, one point apart.
    expect(d.split('M')).toHaveLength(43);
  });
});

describe('MeasureSettings', () => {
  function strip(overrides: Partial<MeasureSettingsProps> = {}) {
    const callbacks = {
      onMode: vi.fn(),
      onScale: vi.fn(),
      onGrid: vi.fn(),
      onGridSpacing: vi.fn(),
      onSnapGrid: vi.fn(),
      onSnapPoints: vi.fn(),
      onColor: vi.fn(),
      onOpacity: vi.fn(),
      onThickness: vi.fn(),
      onAuthor: vi.fn(),
      onStop: vi.fn(),
    };
    const props: MeasureSettingsProps = {
      t,
      mode: 'distance',
      scale: INCH,
      grid: false,
      gridSpacing: 10,
      snapGrid: false,
      snapPoints: false,
      color: '#ff0000',
      opacity: 0.5,
      thickness: 2,
      author: 'Ada',
      reading: null,
      ...callbacks,
      ...overrides,
    };
    render(<MeasureSettings {...props} />);
    return callbacks;
  }

  it('shows the armed mode pressed, switches to another and turns the armed one off', async () => {
    const { onMode } = strip();
    expect(screen.getByRole('button', { name: 'Distance' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Area' }).getAttribute('aria-pressed')).toBe('false');
    await pointer.click(screen.getByRole('button', { name: 'Area' }));
    expect(onMode).toHaveBeenLastCalledWith('area');
    await pointer.click(screen.getByRole('button', { name: 'Distance' }));
    expect(onMode).toHaveBeenLastCalledWith(null);
    await pointer.click(screen.getByRole('button', { name: 'Perimeter' }));
    expect(onMode).toHaveBeenLastCalledWith('perimeter');
  });

  it('reads the scale as it is typed, and keeps the last readable one in force', async () => {
    const { onScale } = strip();
    const field = screen.getByRole('textbox', { name: 'Scale' });
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText('Could not parse scale ratio; previous scale remains active.')).toBeNull();
    await pointer.clear(field);
    await pointer.type(field, '1:50');
    expect(onScale).toHaveBeenLastCalledWith(parseScale('1:50', 'in'));
    expect(field.getAttribute('aria-invalid')).toBe('false');
    const readable = onScale.mock.calls.length;
    await pointer.type(field, 'x');
    expect(onScale).toHaveBeenCalledTimes(readable);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Could not parse scale ratio; previous scale remains active.')).toBeTruthy();
    expect(field.className).toContain('border-kumo-danger');
  });

  it('changes the unit and keeps the ratio', async () => {
    const { onScale } = strip();
    await pointer.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'm');
    expect(onScale).toHaveBeenCalledExactlyOnceWith(scaleForRatio(INCH.ratio, 'm'));
  });

  it('ignores a unit the strip does not offer', () => {
    const { onScale } = strip();
    fireEvent.change(screen.getByRole('combobox', { name: 'Unit' }), { target: { value: 'parsec' } });
    expect(onScale).not.toHaveBeenCalled();
  });

  it('toggles the grid and the two snaps', async () => {
    const { onGrid, onSnapGrid, onSnapPoints } = strip({ snapGrid: true });
    await pointer.click(screen.getByRole('checkbox', { name: 'Grid' }));
    expect(onGrid).toHaveBeenCalledExactlyOnceWith(true);
    await pointer.click(screen.getByRole('checkbox', { name: 'Snap to grid' }));
    expect(onSnapGrid).toHaveBeenCalledExactlyOnceWith(false);
    await pointer.click(screen.getByRole('checkbox', { name: 'Snap to endpoints' }));
    expect(onSnapPoints).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('offers the grid spacings in points and shows the current one, or the default for one it does not offer', async () => {
    const { onGridSpacing } = strip({ gridSpacing: 25 });
    const select = screen.getByRole('combobox', { name: 'Spacing' }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '5 pt',
      '10 pt',
      '20 pt',
      '25 pt',
      '50 pt',
      '100 pt',
    ]);
    expect(select.value).toBe('25');
    await pointer.selectOptions(select, '50');
    expect(onGridSpacing).toHaveBeenCalledExactlyOnceWith(50);
    cleanup();
    strip({ gridSpacing: 7 });
    expect((screen.getByRole('combobox', { name: 'Spacing' }) as HTMLSelectElement).value).toBe('10');
  });

  it('edits the colour, the opacity, the thickness and the author', async () => {
    const { onColor, onOpacity, onThickness, onAuthor } = strip();
    fireEvent.change(screen.getByLabelText('Color'), { target: { value: '#00ff00' } });
    expect(onColor).toHaveBeenCalledExactlyOnceWith('#00ff00');
    fireEvent.change(screen.getByLabelText('Opacity'), { target: { value: '0.75' } });
    expect(onOpacity).toHaveBeenCalledExactlyOnceWith(0.75);
    fireEvent.change(screen.getByLabelText('Thickness'), { target: { value: '5' } });
    expect(onThickness).toHaveBeenCalledExactlyOnceWith(5);
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: 'Grace' } });
    expect(onAuthor).toHaveBeenCalledExactlyOnceWith('Grace');
  });

  it('shows the hint until there is a reading, then the reading with its boundary and angle', () => {
    strip();
    expect(screen.getByRole('status', { name: 'Tool settings' }).textContent).toBe('e.g. 1:100 · 1 cm = 5 m');
    cleanup();
    strip({ reading: { primary: '1,00 in²', secondary: '4,00 in', angle: '45,0°', points: 3 } });
    expect(screen.getByRole('status', { name: 'Tool settings' }).textContent).toBe(
      '1,00 in² · 4,00 in · 45,0°',
    );
    cleanup();
    strip({ reading: { primary: '1,00 in', secondary: null, angle: '0,0°', points: 2 } });
    expect(screen.getByRole('status', { name: 'Tool settings' }).textContent).toBe('1,00 in · 0,0°');
  });

  it('ends the tool from its own button', async () => {
    const { onStop } = strip();
    await pointer.click(screen.getByRole('button', { name: 'Close' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
