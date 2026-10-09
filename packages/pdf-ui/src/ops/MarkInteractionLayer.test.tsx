// @vitest-environment happy-dom
/**
 * The common mark surface: what a press, a drag and a marquee over the page select and move,
 * what the layer draws for the selection, and how a picture is resized. The page is a
 * 600 × 800 pt box drawn at 50 % at (100, 50) (a second one at (100, 500)), so a page point
 * is half its pixels away from the page's corner.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { clientOf, type FakePage, fakeViewer, TWO_PAGES } from './layer-viewer.fixtures';
import { MarkInteractionLayer, type MarkInteractionLayerProps, scaledBox } from './MarkInteractionLayer';
import type { MarkTarget } from './mark-interaction';

function mark(overrides: Partial<MarkTarget> & Pick<MarkTarget, 'id'>): MarkTarget {
  return {
    key: `annotation:${overrides.id}`,
    family: 'annotation',
    pageIndex: 0,
    boxes: [],
    label: overrides.id,
    ...overrides,
  };
}

const a = mark({ id: 'a', boxes: [[100, 100, 200, 200]] });
const b = mark({ id: 'b', boxes: [[300, 300, 400, 400]] });
const picture = mark({ id: 'pic', boxes: [[100, 600, 300, 700]], resizable: true });
const redaction = mark({
  id: 'r',
  key: 'redaction:r',
  family: 'redaction',
  boxes: [[50, 500, 150, 600]],
});
const nothing = mark({ id: 'ghost' });
const A = 'annotation:a';
const B = 'annotation:b';

let page: HTMLElement;
/** What `document.elementFromPoint` answers: the element under the pointer. */
let under: Element | null;

beforeEach(() => {
  page = document.createElement('div');
  page.className = 'page';
  document.body.append(page);
  under = page;
  document.elementFromPoint = () => under;
  pointerUser = userEvent.setup();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  Reflect.deleteProperty(document, 'caretPositionFromPoint');
  Reflect.deleteProperty(document, 'caretRangeFromPoint');
});

function show(overrides: Partial<MarkInteractionLayerProps> = {}) {
  const callbacks = {
    onSelectionChange: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
  };
  const props: MarkInteractionLayerProps = {
    viewer: fakeViewer(),
    mode: 'select',
    targets: [a, b, picture, redaction],
    selectedKeys: [],
    resizeLabel: 'Resize the picture',
    ...callbacks,
    ...overrides,
  };
  const view = render(<MarkInteractionLayer {...props} />);
  return { ...callbacks, view, props, root: view.container.firstElementChild as HTMLElement };
}

type Client = { clientX: number; clientY: number };
const at = (x: number, y: number, pageIndex = 0): Client => clientOf({ x, y }, pageIndex);
/** One user per test: the pointer's pressed buttons are its own state. */
let pointerUser: ReturnType<typeof userEvent.setup>;
const user = () => pointerUser;

async function press(coords: Client, target: Element = page) {
  await user().pointer({ keys: '[MouseLeft>]', target, coords });
}
async function release(coords: Client, target: Element = page) {
  await user().pointer({ keys: '[/MouseLeft]', target, coords });
}
async function moveTo(coords: Client, target: Element = page) {
  await user().pointer({ target, coords });
}
async function drag(from: Client, to: Client) {
  const u = user();
  await u.pointer([
    { keys: '[MouseLeft>]', target: page, coords: from },
    { target: page, coords: to },
    { keys: '[/MouseLeft]', target: page, coords: to },
  ]);
}
async function click(coords: Client) {
  await user().pointer([
    { keys: '[MouseLeft>]', target: page, coords },
    { keys: '[/MouseLeft]', target: page, coords },
  ]);
}

const marquee = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-mark-marquee]') as HTMLElement;
const previews = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-mark-move-preview]')];
const selections = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-mark-selection]')];
const handle = (root: HTMLElement, corner: string) =>
  root.querySelector<HTMLButtonElement>(`[data-mark-resize="${corner}"]`) as HTMLButtonElement;

describe('what the layer draws', () => {
  it('draws a redaction mark as the area it will erase, whatever tool is armed', () => {
    const { root } = show({ mode: null });
    const boxes = [...root.querySelectorAll<HTMLElement>('[data-mark-family="redaction"]')];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.getAttribute('data-mark-key')).toBe('redaction:r');
    expect(boxes[0]?.style.cssText).toBe('left: 125px; top: 300px; width: 50px; height: 50px;');
  });

  it('draws no redaction box for a page the viewer has not put on screen, or for a box with no area', () => {
    const hidden: readonly FakePage[] = [
      { ...(TWO_PAGES[0] as FakePage), hidden: true },
      TWO_PAGES[1] as FakePage,
    ];
    const empty = mark({ id: 'e', key: 'redaction:e', family: 'redaction', boxes: [[10, 10, 10, 10]] });
    expect(
      show({ viewer: fakeViewer({ pages: hidden }), mode: null }).root.querySelector('[data-mark-family]'),
    ).toBeNull();
    cleanup();
    expect(show({ targets: [empty], mode: null }).root.querySelector('[data-mark-family]')).toBeNull();
  });

  it('outlines every selected mark around its own bounds, and only the selected ones', () => {
    const { root } = show({ selectedKeys: [A] });
    expect(selections(root).map((node) => node.getAttribute('data-mark-key'))).toEqual([A]);
    // Bounds (100,100)-(200,200) pt = (150,100)-(200,150) px, with a 2 px ring on every side.
    expect(selections(root)[0]?.style.cssText).toBe('left: 148px; top: 98px; width: 54px; height: 54px;');
    expect(selections(root)[0]?.getAttribute('data-mark-selection')).toBe('annotation');
  });

  it('gives a hairline mark an outline the user can see', () => {
    const line = mark({ id: 'line', boxes: [[100, 100, 100, 100]] });
    const { root } = show({ targets: [line], selectedKeys: [line.key] });
    expect(selections(root)[0]?.style.cssText).toBe('left: 148px; top: 98px; width: 6px; height: 6px;');
  });

  it('outlines nothing for a selected mark that paints nothing or sits on a page that is not on screen', () => {
    const hidden: readonly FakePage[] = [
      { ...(TWO_PAGES[0] as FakePage), hidden: true },
      TWO_PAGES[1] as FakePage,
    ];
    expect(
      show({ targets: [nothing], selectedKeys: [nothing.key] }).root.querySelector('[data-mark-selection]'),
    ).toBeNull();
    cleanup();
    expect(
      show({ viewer: fakeViewer({ pages: hidden }), selectedKeys: [A] }).root.querySelector(
        '[data-mark-selection]',
      ),
    ).toBeNull();
  });

  it('measures a page once for all the marks on it', () => {
    const viewer = fakeViewer();
    const pageRect = vi.spyOn(viewer, 'pageRect');
    show({ viewer, targets: [a, b], selectedKeys: [A, B] });
    expect(pageRect).toHaveBeenCalledTimes(1);
  });
});

describe('selecting by a press', () => {
  it('selects the mark under the pointer and suppresses the text selection underneath', async () => {
    const { onSelectionChange } = show();
    const removeAllRanges = vi.spyOn(window.getSelection() as Selection, 'removeAllRanges');
    await click(at(150, 150));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A]);
    expect(removeAllRanges).toHaveBeenCalled();
  });

  it('takes the press away from the page it selected on', () => {
    show();
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...at(150, 150),
    });
    act(() => {
      page.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
  });

  it('selects the topmost of the marks under the pointer', async () => {
    const under1 = mark({ id: 'under', boxes: [[100, 100, 200, 200]] });
    const over = mark({ id: 'over', boxes: [[100, 100, 200, 200]] });
    const { onSelectionChange } = show({ targets: [under1, over] });
    await click(at(150, 150));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([over.key]);
  });

  it('hits within 4 px of a mark at any zoom, and not beyond', async () => {
    const { onSelectionChange } = show();
    // 4 px at 50 % is 8 pt: a press 8 pt left of the box's edge still hits it, 9 pt does not.
    await click(at(92, 150));
    expect(onSelectionChange).toHaveBeenCalledWith([A]);
    onSelectionChange.mockClear();
    await click(at(91, 150));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('uses the four-pixel slop as it is when the page is not on screen to measure', async () => {
    const pages: readonly FakePage[] = [TWO_PAGES[0] as FakePage, TWO_PAGES[1] as FakePage];
    const viewer = fakeViewer({ pages });
    const real = viewer.pageRect.bind(viewer);
    // The first frame (the slop) finds no page element; the layer then falls back to the pixel slop.
    let calls = 0;
    viewer.pageRect = (index: number) => (calls++ === 0 ? null : real(index));
    const { onSelectionChange } = show({ viewer });
    await click(at(150, 150));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A]);
  });

  it('keeps the selection as it is for a press on a mark that is already selected', async () => {
    const { onSelectionChange } = show({ selectedKeys: [A, B] });
    await click(at(150, 150));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('adds to the selection with a modifier, and removes the mark already in it', async () => {
    const { onSelectionChange } = show({ selectedKeys: [A] });
    const u = user();
    await u.keyboard('{Shift>}');
    await u.pointer([
      { keys: '[MouseLeft>]', target: page, coords: at(350, 350) },
      { keys: '[/MouseLeft]', target: page, coords: at(350, 350) },
    ]);
    expect(onSelectionChange).toHaveBeenLastCalledWith([A, B]);
    await u.pointer([
      { keys: '[MouseLeft>]', target: page, coords: at(150, 150) },
      { keys: '[/MouseLeft]', target: page, coords: at(150, 150) },
    ]);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    await u.keyboard('{/Shift}');
  });

  it.each([
    ['Ctrl', '{Control>}', '{/Control}'],
    ['Meta', '{Meta>}', '{/Meta}'],
  ])('treats %s as the same modifier', async (_name, down, up) => {
    const { onSelectionChange } = show({ selectedKeys: [A] });
    const u = user();
    await u.keyboard(down);
    await u.pointer([
      { keys: '[MouseLeft>]', target: page, coords: at(350, 350) },
      { keys: '[/MouseLeft]', target: page, coords: at(350, 350) },
    ]);
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
    await u.keyboard(up);
  });

  it('lets go of the input that held the keyboard when it takes the press', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    show();
    await click(at(150, 150));
    expect(document.activeElement).not.toBe(field);
  });

  it('clears the selection on an empty click, and keeps it on a modifier-click', async () => {
    const { onSelectionChange } = show({ selectedKeys: [A] });
    await click(at(500, 700));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([]);
    onSelectionChange.mockClear();
    const u = user();
    await u.keyboard('{Shift>}');
    await u.pointer([
      { keys: '[MouseLeft>]', target: page, coords: at(500, 700) },
      { keys: '[/MouseLeft]', target: page, coords: at(500, 700) },
    ]);
    await u.keyboard('{/Shift}');
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe('who owns the pointer', () => {
  it('takes no press while no tool is armed, or while the layer is disabled', async () => {
    for (const overrides of [{ mode: null }, { disabled: true }] as const) {
      const { onSelectionChange } = show(overrides);
      await click(at(150, 150));
      expect(onSelectionChange).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('ignores the buttons other than the primary one', async () => {
    const { onSelectionChange } = show();
    await user().pointer([
      { keys: '[MouseRight>]', target: page, coords: at(150, 150) },
      { keys: '[/MouseRight]', target: page, coords: at(150, 150) },
    ]);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('leaves the gutter between the pages alone', async () => {
    const { onSelectionChange } = show({ selectedKeys: [A] });
    await click({ clientX: 50, clientY: 475 });
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it.each([
    ['a form field', '<input>', 'input'],
    ['a button', '<button type="button">x</button>', 'button'],
    ['the chrome outside the pages', null, null],
  ])('leaves %s to itself', async (_name, markup, selector) => {
    const { onSelectionChange } = show({ selectedKeys: [A] });
    if (markup === null) under = document.body;
    else {
      page.innerHTML = markup;
      under = page.querySelector(selector as string);
    }
    await click(at(150, 150));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('does not start a second gesture while one is in flight, and ignores another pointer’s events', async () => {
    const { onMove } = show({ selectedKeys: [A] });
    await press(at(150, 150));
    // A press by a second pointer is the gesture's own business, not a new gesture.
    fireEvent(
      page,
      new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2, ...at(350, 350) }),
    );
    fireEvent(page, new PointerEvent('pointermove', { bubbles: true, pointerId: 2, ...at(450, 450) }));
    fireEvent(page, new PointerEvent('pointerup', { bubbles: true, pointerId: 2, ...at(450, 450) }));
    expect(onMove).not.toHaveBeenCalled();
    await moveTo(at(250, 250));
    await release(at(250, 250));
    expect(onMove).toHaveBeenCalledExactlyOnceWith([A], 100, 100);
  });
});

describe('moving marks', () => {
  it('carries the selection by the distance the pointer travelled, in page points, as one move', async () => {
    const { onMove, onSelectionChange } = show({ selectedKeys: [A] });
    await drag(at(150, 150), at(350, 350));
    expect(onMove).toHaveBeenCalledExactlyOnceWith([A], 200, 200);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('selects the mark it grabs when it is not selected, and carries it', async () => {
    const { onMove, onSelectionChange } = show();
    await drag(at(350, 350), at(400, 300));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([B]);
    expect(onMove).toHaveBeenCalledExactlyOnceWith([B], 50, -50);
  });

  it('previews every moving mark as a dashed outline at its new place while the pointer is down', async () => {
    const { root } = show({ selectedKeys: [A, B] });
    await press(at(150, 150));
    await moveTo(at(250, 250));
    // Both marks are carried by (100, 100) pt = (50, 50) px; each outline straddles its box by 1 px.
    expect(previews(root).map((node) => node.style.cssText)).toEqual([
      'left: 199px; top: 149px; width: 50px; height: 50px;',
      'left: 299px; top: 249px; width: 50px; height: 50px;',
    ]);
    await moveTo(at(260, 250));
    expect(previews(root)).toHaveLength(2);
    expect(previews(root)[0]?.style.left).toBe('204px');
  });

  it('draws a hairline mark’s preview at least 2 px across', async () => {
    const line = mark({ id: 'line', boxes: [[100, 100, 100, 100]] });
    const { root } = show({ targets: [line], selectedKeys: [line.key] });
    await press(at(100, 100));
    await moveTo(at(200, 100));
    expect(previews(root)[0]?.style.width).toBe('2px');
    expect(previews(root)[0]?.style.height).toBe('2px');
  });

  it('leaves the outlines standing after the drop until the shell draws the new geometry', async () => {
    const { root, view, props } = show({ selectedKeys: [A] });
    await drag(at(150, 150), at(350, 350));
    expect(previews(root)).toHaveLength(1);
    view.rerender(<MarkInteractionLayer {...props} />);
    expect(previews(root)).toHaveLength(0);
  });

  it('keeps the preview of a drag in progress through a render', async () => {
    const { root, view, props } = show({ selectedKeys: [A] });
    await press(at(150, 150));
    await moveTo(at(350, 350));
    view.rerender(<MarkInteractionLayer {...props} />);
    expect(previews(root)).toHaveLength(1);
  });

  it('is a click, not a move, until the pointer has travelled 3 px', async () => {
    const { onMove, root } = show({ selectedKeys: [A] });
    await press(at(150, 150));
    await moveTo({ clientX: 177, clientY: 126 });
    expect(previews(root)).toHaveLength(0);
    await release({ clientX: 177, clientY: 126 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('commits nothing when the drag ends where it began, and clears the outline', async () => {
    const { onMove, root } = show({ selectedKeys: [A] });
    await press(at(150, 150));
    await moveTo(at(350, 350));
    await moveTo(at(150, 150));
    await release(at(150, 150));
    expect(onMove).not.toHaveBeenCalled();
    expect(previews(root)).toHaveLength(0);
  });

  it('only selects when the surface cannot commit a move', async () => {
    const { onSelectionChange, root } = show({ onMove: undefined });
    await drag(at(150, 150), at(350, 350));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A]);
    expect(previews(root)).toHaveLength(0);
  });

  it('measures the travel from the content origin of the moment, so a scroll during the drag is part of it', async () => {
    const viewer = fakeViewer();
    const { onMove } = show({ viewer, selectedKeys: [A] });
    await press(at(150, 150));
    // The content scrolled 20 px up under the pointer: the same client point is now 40 pt further down.
    viewer.containerRect = () => ({ x: 0, y: -20, width: 1000, height: 1000 });
    // The pointer also moved 4 px right (8 pt); the scroll alone adds the 40 pt down.
    await moveTo(at(158, 150));
    await release(at(158, 150));
    expect(onMove).toHaveBeenCalledExactlyOnceWith([A], 8, 40);
  });

  it('does not move a mark whose page is not on screen, though it is selected by the press', async () => {
    const viewer = fakeViewer();
    const real = viewer.pageRect.bind(viewer);
    // The hit test finds the page; only the layer's own frame lookups after it find none.
    let measured = 0;
    viewer.pageRect = (index: number) => (measured++ < 1 ? real(index) : null);
    const { onMove, onSelectionChange } = show({ viewer });
    await drag(at(150, 150), at(350, 350));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A]);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('carries only the selected marks it can measure', async () => {
    const { onMove } = show({ targets: [a, nothing], selectedKeys: [A, nothing.key, 'annotation:gone'] });
    await drag(at(150, 150), at(250, 150));
    expect(onMove).toHaveBeenCalledExactlyOnceWith([A, nothing.key, 'annotation:gone'], 100, 0);
  });

  it('skips a selected mark on a page that is not on screen, and measures a page once for its marks', async () => {
    const second = mark({ id: 'second', pageIndex: 1, boxes: [[100, 100, 200, 200]] });
    const third = mark({ id: 'third', pageIndex: 1, boxes: [[300, 100, 400, 200]] });
    const hiddenThird: readonly FakePage[] = [
      TWO_PAGES[0] as FakePage,
      { ...(TWO_PAGES[1] as FakePage), hidden: true },
    ];
    const { root } = show({
      viewer: fakeViewer({ pages: hiddenThird }),
      targets: [a, second, third],
      selectedKeys: [A, second.key, third.key],
    });
    await press(at(150, 150));
    await moveTo(at(250, 150));
    expect(previews(root)).toHaveLength(1);
  });

  it('moves marks of two pages together, each previewed on its own page', async () => {
    const second = mark({ id: 'second', pageIndex: 1, boxes: [[100, 100, 200, 200]] });
    const third = mark({ id: 'third', pageIndex: 1, boxes: [[300, 100, 400, 200]] });
    const { root, onMove } = show({
      targets: [a, second, third],
      selectedKeys: [A, second.key, third.key],
    });
    await press(at(150, 150));
    await moveTo(at(250, 150));
    expect(previews(root).map((node) => node.style.top)).toEqual(['99px', '549px', '549px']);
    await release(at(250, 150));
    expect(onMove).toHaveBeenCalledExactlyOnceWith([A, second.key, third.key], 100, 0);
  });
});

describe('abandoning a gesture', () => {
  const startMove = async () => {
    const shown = show({ selectedKeys: [A] });
    await press(at(150, 150));
    await moveTo(at(350, 350));
    expect(previews(shown.root)).toHaveLength(1);
    return shown;
  };

  it('discards a move on pointercancel, and the release that follows commits nothing', async () => {
    const { onMove, root } = await startMove();
    fireEvent(window, new PointerEvent('pointercancel', { pointerId: 1 }));
    expect(previews(root)).toHaveLength(0);
    await release(at(350, 350));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('ignores a cancel of another pointer', async () => {
    const { onMove, root } = await startMove();
    fireEvent(window, new PointerEvent('pointercancel', { pointerId: 9 }));
    expect(previews(root)).toHaveLength(1);
    await release(at(350, 350));
    expect(onMove).toHaveBeenCalledOnce();
  });

  it('discards a move when the pointer capture is lost', async () => {
    const { onMove, root } = await startMove();
    fireEvent(root, new Event('lostpointercapture'));
    expect(previews(root)).toHaveLength(0);
    await release(at(350, 350));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('discards a move when the window loses focus', async () => {
    const { onMove, root } = await startMove();
    fireEvent(window, new Event('blur'));
    expect(previews(root)).toHaveLength(0);
    await release(at(350, 350));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('discards a marquee the same way and hides its band', async () => {
    const { onSelectionChange, root } = show();
    await press(at(400, 500));
    await moveTo(at(200, 300));
    expect(marquee(root).style.display).toBe('block');
    fireEvent(window, new Event('blur'));
    expect(marquee(root).style.display).toBe('none');
    await release(at(200, 300));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('does nothing when no gesture is in flight', () => {
    const { onMove, onSelectionChange } = show();
    fireEvent(window, new Event('blur'));
    fireEvent(window, new PointerEvent('pointercancel', { pointerId: 1 }));
    expect(onMove).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('discards a gesture in flight when the layer is disabled', async () => {
    const { onMove, root, view, props } = await startMove();
    view.rerender(<MarkInteractionLayer {...props} disabled />);
    expect(previews(root)).toHaveLength(0);
    await release(at(350, 350));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('stops listening once it is removed', async () => {
    const { onSelectionChange, view } = show();
    view.unmount();
    await click(at(150, 150));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe('the marquee', () => {
  it('draws a band between the press and the pointer, in content pixels, and hides it at the release', async () => {
    const { root } = show();
    await press(at(400, 500));
    expect(marquee(root).style.display).toBe('none');
    await moveTo(at(200, 300));
    expect(marquee(root).style.cssText).toBe(
      'display: block; left: 200px; top: 200px; width: 100px; height: 100px;',
    );
    await release(at(200, 300));
    expect(marquee(root).style.display).toBe('none');
  });

  it('selects every mark its rectangle overlaps, in one change', async () => {
    const { onSelectionChange } = show();
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
  });

  it('selects nothing when it covers no mark', async () => {
    const { onSelectionChange } = show({ selectedKeys: [A] });
    await drag(at(450, 100), at(550, 200));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('adds to the selection with a modifier, once for a mark already in it', async () => {
    const { onSelectionChange } = show({ selectedKeys: [B] });
    const u = user();
    await u.keyboard('{Shift>}');
    await u.pointer([
      { keys: '[MouseLeft>]', target: page, coords: at(50, 50) },
      { target: page, coords: at(450, 450) },
      { keys: '[/MouseLeft]', target: page, coords: at(450, 450) },
    ]);
    await u.keyboard('{/Shift}');
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([B, A]);
  });

  it('is measured on each page a mark lives on, skipping a page that is not on screen', async () => {
    const second = mark({ id: 'second', pageIndex: 1, boxes: [[100, 100, 200, 200]] });
    const hiddenSecond: readonly FakePage[] = [
      TWO_PAGES[0] as FakePage,
      { ...(TWO_PAGES[1] as FakePage), hidden: true },
    ];
    const { onSelectionChange } = show({
      viewer: fakeViewer({ pages: hiddenSecond }),
      targets: [a, second, picture],
    });
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A]);
  });

  it('reaches marks on both pages when one press crosses the gutter', async () => {
    const second = mark({ id: 'second', pageIndex: 1, boxes: [[100, 100, 200, 200]] });
    const { onSelectionChange } = show({ targets: [a, second] });
    await drag(at(50, 50), at(450, 300, 1));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, second.key]);
  });

  it('lets go of the input that held the keyboard when it starts', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    show();
    await press(at(500, 700));
    expect(document.activeElement).not.toBe(field);
  });

  it('ignores another pointer’s moves', async () => {
    const { root } = show();
    await press(at(400, 500));
    fireEvent(page, new PointerEvent('pointermove', { bubbles: true, pointerId: 4, ...at(200, 300) }));
    expect(marquee(root).style.display).toBe('none');
  });
});

describe('text and links stay the page’s own', () => {
  const textRun = (text: string) => {
    page.innerHTML = `<div class="textLayer"><span>${text}</span></div>`;
    return page.querySelector('span') as HTMLElement;
  };

  it('does not start a marquee on the words of the text layer', async () => {
    const { onSelectionChange, root } = show();
    under = textRun('hello');
    await drag(at(400, 500), at(200, 300));
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(marquee(root).style.display).toBe('none');
  });

  it('starts a marquee on a text layer run that holds only blanks', async () => {
    const { onSelectionChange } = show();
    under = textRun('   ');
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
  });

  it('starts a marquee between the runs, on the layer’s own box', async () => {
    const { onSelectionChange } = show();
    textRun('hello');
    under = page.querySelector('.textLayer');
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
  });

  it('asks the browser first: a caret inside a run’s painted box is the text’s', async () => {
    const { onSelectionChange } = show();
    const run = textRun('hello');
    run.getBoundingClientRect = () => new DOMRect(300, 300, 100, 20);
    const caret = (x: number) => ({ offsetNode: run.firstChild, offset: x });
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => caret(0) });
    await drag({ clientX: 350, clientY: 310 }, { clientX: 380, clientY: 312 });
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('starts a marquee where the browser’s caret is outside the run’s painted box', async () => {
    const { onSelectionChange } = show();
    const run = textRun('hello');
    run.getBoundingClientRect = () => new DOMRect(300, 300, 10, 10);
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: run.firstChild, offset: 0 }),
    });
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
  });

  it('falls back to the older range API when the standard one is missing', async () => {
    const { onSelectionChange } = show();
    const run = textRun('hello');
    run.getBoundingClientRect = () => new DOMRect(0, 0, 2000, 2000);
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => ({ startContainer: run.firstChild }),
    });
    await drag(at(400, 500), at(200, 300));
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('asks the element under the pointer when the caret is not in a text node', async () => {
    const { onSelectionChange } = show();
    textRun('hello');
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: page, offset: 0 }),
    });
    under = page;
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
  });

  it('asks the element under the pointer when the caret is in blank text or in text outside any run', async () => {
    const { onSelectionChange } = show();
    page.append(document.createTextNode('free text'));
    const caretIn = (node: Node) => ({ offsetNode: node, offset: 0 });
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => caretIn(page.lastChild as Node),
    });
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
    onSelectionChange.mockClear();
    page.replaceChildren(document.createTextNode('   '));
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A, B]);
  });

  it('starts nothing where no element answers under the pointer', async () => {
    const { onSelectionChange, root } = show();
    under = null;
    await drag(at(50, 50), at(450, 450));
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(marquee(root).style.display).toBe('none');
  });

  it('does not start a marquee on a link nobody handled, and lets its click through', async () => {
    const { onSelectionChange } = show();
    page.innerHTML = '<a href="https://example.com/">link</a>';
    under = page.querySelector('a');
    await drag(at(400, 500), at(200, 300));
    expect(onSelectionChange).not.toHaveBeenCalled();
    const link = new MouseEvent('click', { bubbles: true, cancelable: true });
    under?.dispatchEvent(link);
    expect(link.defaultPrevented).toBe(false);
  });

  it('selects the mark under a link and cancels the click that follows, once', async () => {
    const { onSelectionChange } = show();
    page.innerHTML = '<a href="https://example.com/">link</a>';
    under = page.querySelector('a');
    const navigations = vi.fn();
    under?.addEventListener('click', navigations);
    // The click the browser sends after the press never reaches the link.
    await click(at(150, 150));
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A]);
    expect(navigations).not.toHaveBeenCalled();
    // The suppression is spent: the next click navigates.
    const second = new MouseEvent('click', { bubbles: true, cancelable: true });
    under?.dispatchEvent(second);
    expect(navigations).toHaveBeenCalledOnce();
    expect(second.defaultPrevented).toBe(false);
  });

  it('forgets a pending click suppression when the next press is not for a mark', async () => {
    show();
    page.innerHTML = '<a href="https://example.com/">link</a>';
    under = page.querySelector('a');
    await click(at(150, 150));
    await click(at(500, 700));
    const next = new MouseEvent('click', { bubbles: true, cancelable: true });
    under?.dispatchEvent(next);
    expect(next.defaultPrevented).toBe(false);
  });
});

describe('scaledBox', () => {
  const box = [100, 100, 300, 200] as const;

  it('grows about the anchor toward the held corner, keeping the aspect', () => {
    expect(scaledBox(box, { x: 100, y: 100 }, { x: 300, y: 200 }, 1.5)).toEqual([100, 100, 400, 250]);
    expect(scaledBox(box, { x: 300, y: 200 }, { x: 100, y: 100 }, 0.5)).toEqual([200, 150, 300, 200]);
  });

  it('never leaves the short side under 8 points', () => {
    expect(scaledBox(box, { x: 100, y: 100 }, { x: 300, y: 200 }, 0.01)).toEqual([100, 100, 116, 108]);
  });

  it('takes a corner level with the anchor as the positive direction', () => {
    expect(scaledBox(box, { x: 100, y: 100 }, { x: 100, y: 100 }, 1)).toEqual([100, 100, 300, 200]);
  });

  it('rounds the float noise of a projection to a thousandth of a point', () => {
    expect(scaledBox([0, 0, 300, 300], { x: 0, y: 0 }, { x: 1, y: 1 }, 1 / 3)).toEqual([0, 0, 100, 100]);
    expect(scaledBox([0, 0, 1000, 1000], { x: 0, y: 0 }, { x: 1, y: 1 }, 1.0000004)).toEqual([
      0, 0, 1000, 1000,
    ]);
  });
});

describe('resizing a picture', () => {
  const picked = (overrides: Partial<MarkInteractionLayerProps> = {}) =>
    show({ selectedKeys: [picture.key], ...overrides });

  it('offers four labelled corner handles on a single selected picture', () => {
    const { root } = picked();
    const corners = ['nw', 'ne', 'sw', 'se'];
    expect(corners.map((corner) => handle(root, corner).getAttribute('aria-label'))).toEqual(
      Array(4).fill('Resize the picture'),
    );
    // The picture (100,600)-(300,700) pt is (150,350)-(250,400) px; each 12 px handle is centred on a corner.
    expect(handle(root, 'nw').style.cssText).toContain('left: 144px; top: 344px;');
    expect(handle(root, 'se').style.cssText).toContain('left: 244px; top: 394px;');
    expect(handle(root, 'ne').style.cursor).toBe('nesw-resize');
  });

  it.each([
    ['no resize callback', { onResize: undefined, selectedKeys: [picture.key] }],
    ['two marks selected', { selectedKeys: [picture.key, A] }],
    ['a mark that is not resizable', { selectedKeys: [A] }],
    ['the layer disabled', { disabled: true }],
    ['no tool armed', { mode: null }],
    ['a picture that paints nothing', { targets: [{ ...picture, boxes: [] }] }],
    [
      'a picture on a page that is not on screen',
      { viewer: fakeViewer({ pages: [{ ...(TWO_PAGES[0] as FakePage), hidden: true }] }) },
    ],
  ] as const)('offers no handle with %s', (_name, overrides) => {
    const { root } = picked(overrides as Partial<MarkInteractionLayerProps>);
    expect(root.querySelector('[data-mark-resize]')).toBeNull();
  });

  it('grows by a twentieth about the opposite corner on an arrow key, and shrinks on the other arrows', async () => {
    const { root, onResize } = picked();
    handle(root, 'se').focus();
    const u = user();
    await u.keyboard('{ArrowRight}');
    expect(onResize).toHaveBeenLastCalledWith(picture.key, [100, 600, 310, 705]);
    await u.keyboard('{ArrowUp}');
    expect(onResize).toHaveBeenLastCalledWith(picture.key, [100, 600, 310, 705]);
    await u.keyboard('{ArrowLeft}');
    expect(onResize).toHaveBeenLastCalledWith(picture.key, [100, 600, 290, 695]);
    await u.keyboard('{ArrowDown}');
    expect(onResize).toHaveBeenLastCalledWith(picture.key, [100, 600, 290, 695]);
    expect(onResize).toHaveBeenCalledTimes(4);
    handle(root, 'nw').focus();
    await u.keyboard('{ArrowRight}');
    expect(onResize).toHaveBeenLastCalledWith(picture.key, [90, 595, 300, 700]);
  });

  it('ignores every other key', async () => {
    const { root, onResize } = picked();
    handle(root, 'se').focus();
    await user().keyboard('a{Enter}{Tab}');
    expect(onResize).not.toHaveBeenCalled();
  });

  it('keeps the arrow keys from reaching the page’s own shortcuts', () => {
    const { root } = picked();
    const key = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    const reached = vi.fn();
    window.addEventListener('keydown', reached);
    act(() => {
      handle(root, 'se').dispatchEvent(key);
    });
    window.removeEventListener('keydown', reached);
    expect(key.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
  });

  it('scales the picture about the opposite corner as the pointer drags a handle, and commits once', async () => {
    const { root, onResize } = picked();
    const grip = handle(root, 'se');
    under = grip;
    const u = user();
    await u.pointer([
      { keys: '[MouseLeft>]', target: grip, coords: { clientX: 250, clientY: 400 } },
      // The corner moves to page point (500, 800): 400 pt across from the anchor, twice the width (200 px).
      { target: grip, coords: { clientX: 350, clientY: 450 } },
    ]);
    expect(previews(root)).toHaveLength(0);
    const outline = root.querySelector<HTMLElement>('span.border-dashed');
    expect(outline?.style.cssText).toBe('left: 149px; top: 349px; width: 200px; height: 100px;');
    await u.pointer({ keys: '[/MouseLeft]', target: grip, coords: { clientX: 350, clientY: 450 } });
    expect(onResize).toHaveBeenCalledExactlyOnceWith(picture.key, [100, 600, 500, 800]);
  });

  it('reuses one outline through a drag, and replaces whatever else stood in the preview', async () => {
    const { root } = picked();
    const grip = handle(root, 'se');
    under = grip;
    const preview = root.querySelector('div:not([class])') as HTMLElement;
    preview.append(document.createElement('i'), document.createElement('i'));
    const u = user();
    await u.pointer([
      { keys: '[MouseLeft>]', target: grip, coords: { clientX: 250, clientY: 400 } },
      { target: grip, coords: { clientX: 300, clientY: 425 } },
    ]);
    const first = preview.firstElementChild;
    expect(preview.childElementCount).toBe(1);
    await u.pointer({ target: grip, coords: { clientX: 320, clientY: 430 } });
    expect(preview.firstElementChild).toBe(first);
  });

  it('commits nothing when the handle is released without a move, and clears the preview', async () => {
    const { root, onResize } = picked();
    const grip = handle(root, 'se');
    under = grip;
    await user().pointer([
      { keys: '[MouseLeft>]', target: grip, coords: { clientX: 250, clientY: 400 } },
      { keys: '[/MouseLeft]', target: grip, coords: { clientX: 250, clientY: 400 } },
    ]);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('ignores the secondary button and another pointer on a handle', async () => {
    const { root, onResize } = picked();
    const grip = handle(root, 'se');
    under = grip;
    const u = user();
    await u.pointer([
      { keys: '[MouseRight>]', target: grip, coords: { clientX: 250, clientY: 400 } },
      { target: grip, coords: { clientX: 350, clientY: 450 } },
      { keys: '[/MouseRight]', target: grip, coords: { clientX: 350, clientY: 450 } },
    ]);
    expect(onResize).not.toHaveBeenCalled();
    await u.pointer({ keys: '[MouseLeft>]', target: grip, coords: { clientX: 250, clientY: 400 } });
    fireEvent(
      grip,
      new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 350, clientY: 450 }),
    );
    fireEvent(
      grip,
      new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: 350, clientY: 450 }),
    );
    expect(onResize).not.toHaveBeenCalled();
    expect(root.querySelector('span.border-dashed')).toBeNull();
  });

  it('drops the drag when the pointer is cancelled', async () => {
    const { root, onResize } = picked();
    const grip = handle(root, 'se');
    under = grip;
    const u = user();
    await u.pointer([
      { keys: '[MouseLeft>]', target: grip, coords: { clientX: 250, clientY: 400 } },
      { target: grip, coords: { clientX: 350, clientY: 450 } },
    ]);
    fireEvent(grip, new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    expect(root.querySelector('span.border-dashed')).toBeNull();
    await u.pointer({ keys: '[/MouseLeft]', target: grip, coords: { clientX: 350, clientY: 450 } });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('keeps a handle press from also starting a gesture on the page', async () => {
    const { root, onSelectionChange } = picked();
    const grip = handle(root, 'se');
    under = grip;
    await user().pointer({ keys: '[MouseLeft>]', target: grip, coords: { clientX: 250, clientY: 400 } });
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('does not clear the outline of a resize in flight when it renders', async () => {
    const { root, view, props } = picked();
    const grip = handle(root, 'se');
    under = grip;
    await user().pointer([
      { keys: '[MouseLeft>]', target: grip, coords: { clientX: 250, clientY: 400 } },
      { target: grip, coords: { clientX: 350, clientY: 450 } },
    ]);
    view.rerender(<MarkInteractionLayer {...props} />);
    expect(root.querySelector('span.border-dashed')).not.toBeNull();
  });
});

describe('a viewer the layer reads at press time', () => {
  it('uses the viewer of the latest render, not the first', async () => {
    const first = fakeViewer();
    const { onSelectionChange, view, props } = show({ viewer: first });
    const moved: readonly FakePage[] = [
      { ...(TWO_PAGES[0] as FakePage), rect: { x: 100, y: 250, width: 300, height: 400 } },
      TWO_PAGES[1] as FakePage,
    ];
    view.rerender(<MarkInteractionLayer {...props} viewer={fakeViewer({ pages: moved })} />);
    await click({ clientX: 175, clientY: 325 });
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([A]);
  });

  it('types its viewer as the viewer’s own API', () => {
    const viewer: ViewerApi = fakeViewer();
    expect(viewer.getZoom).toBeUndefined();
  });
});
