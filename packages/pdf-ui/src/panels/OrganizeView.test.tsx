// @vitest-environment happy-dom
/**
 * The organize grid: selection by click, modifier-click, the "select several" mode and the
 * keyboard; reordering by drag, by Alt/Ctrl+arrows (a row for up and down), by the move buttons
 * and the "move to" field; the actions on the selection; the size slider; and closing. Like the
 * page list, the view never touches the document: every change leaves as a callback.
 */

import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core';
import type { AnnotationMark } from 'pdf-core/ops/annotations';
import { createTranslator } from 'pdf-shared';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { OrganizeView, type OrganizeViewProps } from './OrganizeView';

const t = createTranslator('en');

/* The lazy-thumbnail seam: an IntersectionObserver the tests can fire. */

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: (entries: { isIntersecting: boolean }[]) => void,
    readonly options: { rootMargin?: string },
  ) {
    FakeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
}

function reveal(holder: Element, isIntersecting = true) {
  for (const observer of FakeObserver.instances) {
    if (!observer.disconnected && observer.targets.includes(holder)) {
      act(() => observer.callback([{ isIntersecting }]));
    }
  }
}

/** The grid is 700 px wide: with the 200 px size it makes three columns. */
const GRID_WIDTH = 700;
const COLUMNS = 3;

beforeEach(() => {
  FakeObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(GRID_WIDTH);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.dir = '';
});

interface FakeDocument {
  readonly handle: PdfDocumentHandle;
  readonly getPageSize: Mock;
  readonly renderPage: Mock;
}

function fakeDocument(
  pageCount: number,
  labels: Promise<readonly string[] | null> | null = null,
): FakeDocument {
  const getPageSize = vi.fn(async () => ({
    width: 200,
    height: 300,
    rotation: 0,
    viewBox: [0, 0, 200, 300],
  }));
  const renderPage = vi.fn(async () => {});
  return {
    handle: {
      pageCount,
      fingerprint: null,
      getPageLabels: vi.fn(() => labels ?? Promise.resolve(null)),
      getPageSize,
      renderPage,
    } as unknown as PdfDocumentHandle,
    getPageSize,
    renderPage,
  };
}

interface Spies {
  readonly onSelectionChange: Mock;
  readonly onGoToPage: Mock;
  readonly onPageAction: Mock;
  readonly onClose: Mock;
  readonly onExtract: Mock;
  readonly onInsert: Mock;
}

function newSpies(): Spies {
  return {
    onSelectionChange: vi.fn(),
    onGoToPage: vi.fn(),
    onPageAction: vi.fn(),
    onClose: vi.fn(),
    onExtract: vi.fn(),
    onInsert: vi.fn(),
  };
}

function Host({
  spies,
  initial,
  ...props
}: Partial<OrganizeViewProps> & {
  readonly document: PdfDocumentHandle;
  readonly spies: Spies;
  readonly initial: readonly number[];
}) {
  const [selected, setSelected] = useState(initial);
  const onSelectionChange = useCallback(
    (pages: readonly number[]) => {
      spies.onSelectionChange(pages);
      setSelected(pages);
    },
    [spies],
  );
  return (
    <OrganizeView
      t={t}
      currentPage={0}
      selectedPages={selected}
      onSelectionChange={onSelectionChange}
      onGoToPage={spies.onGoToPage}
      onPageAction={spies.onPageAction}
      onClose={spies.onClose}
      onExtract={spies.onExtract}
      onInsert={spies.onInsert}
      editing
      {...props}
    />
  );
}

function show(props: Partial<OrganizeViewProps> & { readonly initial?: readonly number[] } = {}) {
  const spies = newSpies();
  const { initial = [], document: given, ...rest } = props;
  const doc = fakeDocument(7);
  const document = given ?? doc.handle;
  const view = render(<Host spies={spies} initial={initial} document={document} {...rest} />);
  const again = (next: Partial<OrganizeViewProps>) =>
    view.rerender(<Host spies={spies} initial={initial} document={document} {...rest} {...next} />);
  return { ...spies, doc, user: userEvent.setup(), again, ...view };
}

const grid = () => screen.getByRole('listbox', { name: 'Organize pages' });
const card = (page: number) => screen.getByRole('option', { name: `Page ${page}` });
const selectedCards = () =>
  screen
    .getAllByRole('option')
    .filter((item) => item.getAttribute('aria-selected') === 'true')
    .map((item) => Number(item.getAttribute('data-page-option')) + 1);
const holderOf = (page: number) => card(page).querySelector('[data-thumbnail-page] > div') as HTMLElement;
const toolbar = (count: number) => screen.getByRole('toolbar', { name: `Selection: ${count} page(s)` });
const button = (name: string) => screen.getByRole('button', { name });
const isDisabled = (name: string) => button(name).hasAttribute('disabled');
const tabStop = () =>
  screen
    .getAllByRole('option')
    .filter((item) => item.getAttribute('tabindex') === '0')
    .map((item) => Number(item.getAttribute('data-page-option')) + 1);
const live = () => (document.querySelector('[aria-live="polite"]') as HTMLElement).textContent;

describe('OrganizeView grid', () => {
  it('lists every page as an option, marks the current one and says how many are selected', () => {
    show({ currentPage: 2, initial: [1, 3] });
    expect(screen.getAllByRole('option')).toHaveLength(7);
    expect(card(3).getAttribute('aria-current')).toBe('page');
    expect(card(1).hasAttribute('aria-current')).toBe(false);
    expect(selectedCards()).toEqual([2, 4]);
    expect(screen.getByText('2 of 7 page(s) selected')).toBeTruthy();
    expect(grid().getAttribute('aria-multiselectable')).toBe('true');
    expect(grid().getAttribute('aria-describedby')).toBe(screen.getByText(/Select pages, then drag/).id);
  });

  it('opens on the page that was on screen: it holds the one tab stop and the focus', () => {
    show({ currentPage: 4 });
    expect(tabStop()).toEqual([5]);
    expect(document.activeElement).toBe(card(5));
  });

  it('captions each page with its number, and with the file label in front when it differs', async () => {
    const doc = fakeDocument(3, Promise.resolve(['i', '2', 'A-3']));
    show({ document: doc.handle });
    await act(async () => {});
    expect(card(1).textContent).toBe('i (1)');
    expect(card(2).textContent).toBe('2');
    expect(card(3).textContent).toBe('A-3 (3)');
  });

  it('keeps the numbers when the labels cannot be read', async () => {
    const doc = fakeDocument(2, Promise.reject(new Error('no labels')));
    show({ document: doc.handle });
    await act(async () => {});
    expect(card(2).textContent).toBe('2');
  });

  it('leaves the pages after the last one out of the selection when the document gets shorter', () => {
    const view = show({ initial: [1, 6] });
    expect(view.onSelectionChange).not.toHaveBeenCalled();
    view.again({ document: fakeDocument(5).handle });
    expect(view.onSelectionChange).toHaveBeenLastCalledWith([1]);
  });

  it('draws nothing until a card is near the window, and fits a tall page to its cell', async () => {
    const doc = fakeDocument(3);
    show({ document: doc.handle });
    expect(doc.getPageSize).not.toHaveBeenCalled();
    const observer = FakeObserver.instances.find((item) => item.targets.includes(holderOf(2)));
    expect((observer as FakeObserver).options.rootMargin).toBe('240px');
    reveal(holderOf(2));
    await act(async () => {});
    expect(doc.getPageSize).toHaveBeenCalledExactlyOnceWith(1, 1);
    // A 200 × 300 page in a 200 px cell that is at most 280 px tall: 280 / 300 of its size.
    const options = (doc.renderPage.mock.calls[0] as unknown as [number, unknown, { scale: number }])[2];
    expect(options.scale).toBeCloseTo(280 / 300);
    const box = card(2).querySelector('[data-thumbnail-page]') as HTMLElement;
    expect(box.style.width).toBe('187px');
    expect(box.style.height).toBe('280px');
    expect(card(1).querySelector('canvas')).toBeNull();
  });

  it('draws the session marks of a page over its thumbnail', async () => {
    const mark: AnnotationMark = {
      id: 'm',
      kind: 'highlight',
      pageIndex: 1,
      quads: [[10, 10, 100, 30]],
      color: '#ffee00',
      opacity: 0.4,
      contents: '',
      author: '',
      createdAt: '2026-05-01T10:00:00.000Z',
    };
    show({ marks: [mark] });
    reveal(holderOf(2));
    reveal(holderOf(1));
    await act(async () => {});
    expect(card(2).querySelectorAll('[data-thumbnail-marks] > div')).toHaveLength(1);
    expect(card(1).querySelector('[data-thumbnail-marks]')).toBeNull();
  });

  it('draws a page again when the document version changes', async () => {
    const doc = fakeDocument(2);
    const view = show({ document: doc.handle, version: 'a' });
    reveal(holderOf(1));
    await act(async () => {});
    expect(doc.renderPage).toHaveBeenCalledTimes(1);
    view.again({ version: 'b' });
    reveal(holderOf(1));
    await act(async () => {});
    expect(doc.renderPage).toHaveBeenCalledTimes(2);
  });
});

describe('OrganizeView size', () => {
  it('opens on the second size on a narrow screen and the third on a wide one', () => {
    vi.stubGlobal('innerWidth', 375);
    const narrow = show();
    expect(grid().style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(160px, 1fr))');
    narrow.unmount();
    vi.stubGlobal('innerWidth', 1440);
    show();
    expect(grid().style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(216px, 1fr))');
  });

  it('follows the slider: the cells and the thumbnails are drawn at the chosen width', async () => {
    const doc = fakeDocument(2);
    show({ document: doc.handle });
    const slider = screen.getByRole('slider', { name: 'Thumbnail size' });
    expect(slider.getAttribute('max')).toBe('3');
    fireEvent.change(slider, { target: { value: '3' } });
    expect(grid().style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(296px, 1fr))');
    reveal(holderOf(1));
    await act(async () => {});
    // 280 px wide, at most 392 px tall: the page's 1.5 ratio is taller than 1.4, so the height decides.
    const options = (doc.renderPage.mock.calls.at(-1) as unknown as [number, unknown, { scale: number }])[2];
    expect(options.scale).toBeCloseTo(392 / 300);
    fireEvent.change(slider, { target: { value: '0' } });
    expect(grid().style.gridTemplateColumns).toBe('repeat(auto-fill, minmax(112px, 1fr))');
  });
});

describe('OrganizeView selection', () => {
  it('selects the page clicked, Ctrl toggles, Shift takes a range, the grid’s own space clears', () => {
    const { onGoToPage } = show();
    fireEvent.click(card(2));
    expect(selectedCards()).toEqual([2]);
    expect(screen.getByText('1 of 7 page(s) selected')).toBeTruthy();
    fireEvent.click(card(5), { ctrlKey: true });
    expect(selectedCards()).toEqual([2, 5]);
    fireEvent.click(card(2), { metaKey: true });
    expect(selectedCards()).toEqual([5]);
    // The anchor is the page last toggled, even when the toggle took it out.
    fireEvent.click(card(7), { shiftKey: true });
    expect(selectedCards()).toEqual([2, 3, 4, 5, 6, 7]);
    fireEvent.click(grid());
    expect(selectedCards()).toEqual([]);
    // Shift with no anchor is a plain click.
    fireEvent.click(card(4), { shiftKey: true });
    expect(selectedCards()).toEqual([4]);
    // A click selects; it never leaves the view or moves the viewer.
    expect(onGoToPage).not.toHaveBeenCalled();
  });

  it('toggles with a plain tap while "Select several" is on', async () => {
    const { user } = show();
    const mode = button('Select several');
    expect(mode.getAttribute('aria-pressed')).toBe('false');
    await user.click(mode);
    expect(mode.getAttribute('aria-pressed')).toBe('true');
    await user.click(card(1));
    await user.click(card(3));
    expect(selectedCards()).toEqual([1, 3]);
    await user.click(card(1));
    expect(selectedCards()).toEqual([3]);
    await user.click(mode);
    await user.click(card(2));
    expect(selectedCards()).toEqual([2]);
  });

  it('walks the grid with the arrows: a page left and right, a row up and down, and stops at the ends', async () => {
    const { user } = show();
    card(1).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(card(2));
    expect(tabStop()).toEqual([2]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(card(2 + COLUMNS));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(card(7));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(card(4));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(card(3));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(card(1));
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(document.activeElement).toBe(card(1));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(card(7));
    // Walking does not select.
    expect(selectedCards()).toEqual([]);
  });

  it('walks the other way with the left and right arrows in a right-to-left interface', async () => {
    document.documentElement.dir = 'rtl';
    const { user } = show();
    card(3).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(card(2));
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(document.activeElement).toBe(card(4));
  });

  it('selects with Space, takes all with Ctrl+A, and leaves other keys alone', async () => {
    const { user } = show();
    card(2).focus();
    await user.keyboard(' ');
    expect(selectedCards()).toEqual([2]);
    await user.keyboard('{ArrowRight} ');
    expect(selectedCards()).toEqual([2, 3]);
    await user.keyboard(' ');
    expect(selectedCards()).toEqual([2]);
    await user.keyboard('{Control>}a{/Control}');
    expect(selectedCards()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(live()).toBe('7 page(s) selected');
    await user.keyboard('x');
    expect(selectedCards()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('opens the page with Enter or a double click: the viewer goes there and the view closes', async () => {
    const { user, onGoToPage, onClose } = show();
    card(3).focus();
    await user.keyboard('{Enter}');
    expect(onGoToPage).toHaveBeenLastCalledWith(2);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.doubleClick(card(5));
    expect(onGoToPage).toHaveBeenLastCalledWith(4);
    expect(onClose).toHaveBeenCalledTimes(2);
    // Between the cards there is nothing to open.
    fireEvent.doubleClick(grid());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('deletes the selection with Delete or Backspace, but never every page', async () => {
    const { user, onPageAction } = show({ initial: [0, 1] });
    card(2).focus();
    await user.keyboard('{Delete}');
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'delete' });
    await user.keyboard('{Backspace}');
    expect(onPageAction).toHaveBeenCalledTimes(2);
    await user.keyboard('{Control>}a{/Control}{Delete}');
    expect(onPageAction).toHaveBeenCalledTimes(2);
  });

  it('does not delete with nothing selected or while viewing', async () => {
    const empty = show();
    card(1).focus();
    await empty.user.keyboard('{Delete}');
    expect(empty.onPageAction).not.toHaveBeenCalled();
    cleanup();
    const viewing = show({ initial: [0], editing: false });
    card(1).focus();
    await viewing.user.keyboard('{Delete}');
    expect(viewing.onPageAction).not.toHaveBeenCalled();
  });

  it('answers keys only for the cards: the toolbar’s own controls keep theirs', async () => {
    const { user, onPageAction } = show({ initial: [0, 1] });
    const field = screen.getByRole('spinbutton', { name: 'Move to' });
    await user.click(field);
    await user.keyboard('{Delete}{Control>}a{/Control}');
    expect(onPageAction).not.toHaveBeenCalled();
    expect(selectedCards()).toEqual([1, 2]);
  });

  it('announces the selection in a live region', async () => {
    const { user } = show();
    await user.click(card(1));
    expect(live()).toBe('1 page(s) selected');
  });
});

describe('OrganizeView reordering', () => {
  it('moves the selection a page with Alt+arrows, keeps it on the moved page and says where it went', async () => {
    const { user, onPageAction, onSelectionChange } = show({ initial: [1] });
    card(2).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 2 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    // The focus follows the page.
    expect(document.activeElement).toBe(card(3));
    expect(tabStop()).toEqual([3]);
    expect(live()).toBe('Moved to position 3.');
    await user.keyboard('{Control>}{ArrowLeft}{/Control}');
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 1 });
  });

  it('moves a whole row with Alt+Up and Alt+Down, and clamps to the ends', async () => {
    const { user, onPageAction } = show({ initial: [2, 4] });
    card(3).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    // The block's first page moves down a row of three: 2 → 5.
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 2 + COLUMNS });
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onPageAction).toHaveBeenCalledTimes(1);
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 2 });
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 0 });
  });

  it('does nothing at the start, with no selection or while viewing', async () => {
    const { user, onPageAction } = show({ initial: [0] });
    card(1).focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(onPageAction).not.toHaveBeenCalled();
    cleanup();
    const none = show();
    card(2).focus();
    await none.user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(none.onPageAction).not.toHaveBeenCalled();
    cleanup();
    const viewing = show({ initial: [1], editing: false });
    card(2).focus();
    await viewing.user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(viewing.onPageAction).not.toHaveBeenCalled();
  });

  it('moves earlier and later from the toolbar, which stops offering a move at the ends', async () => {
    const { user, onPageAction } = show({ initial: [1] });
    await user.click(button('Move later'));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 2 });
    await user.click(button('Move earlier'));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 1 });
    cleanup();
    show({ initial: [0] });
    expect(isDisabled('Move earlier')).toBe(true);
    cleanup();
    show({ initial: [5, 6] });
    expect(isDisabled('Move later')).toBe(true);
  });

  it('moves to a typed position, clearing the field', async () => {
    const { user, onPageAction, onSelectionChange } = show({ initial: [0, 1] });
    const field = screen.getByRole('spinbutton', { name: 'Move to' }) as HTMLInputElement;
    expect(isDisabled('Move to')).toBe(true);
    expect(field.max).toBe('6');
    await user.type(field, '4');
    await user.click(button('Move to'));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 3 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([3, 4]);
    expect(field.value).toBe('');
  });

  describe('by dragging', () => {
    interface DragInit {
      readonly clientX?: number;
      readonly relatedTarget?: Element | null;
      readonly dataTransfer?: object;
    }
    const send = (
      name: 'dragStart' | 'dragOver' | 'dragLeave' | 'dragEnd' | 'drop',
      target: Element,
      init: DragInit = {},
    ) => {
      const event = createEvent[name](target);
      for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value });
      return fireEvent(target, event);
    };
    const transfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });
    /** The card occupies x = 100 … 200: its first half is left of x = 150. */
    const frame = (page: number) => {
      card(page).getBoundingClientRect = () => new DOMRect(100, 0, 100, 100);
    };
    const indicators = () =>
      [...grid().querySelectorAll('[data-drop]')].map((item) => [
        item.getAttribute('data-drop'),
        Number(item.parentElement?.getAttribute('data-page-option')) + 1,
      ]);

    it('refuses to start a drag while viewing, and ignores one that did not start in a card', () => {
      show({ editing: false });
      expect(send('dragStart', card(1), { dataTransfer: transfer() })).toBe(false);
      expect(card(1).getAttribute('draggable')).toBe('false');
      expect(card(1).hasAttribute('title')).toBe(false);
      cleanup();
      show();
      expect(send('dragStart', grid(), { dataTransfer: transfer() })).toBe(true);
    });

    it('drags the page under the pointer, selecting it, with its number as the payload', () => {
      const { onSelectionChange } = show({ initial: [3] });
      const data = transfer();
      send('dragStart', card(2), { dataTransfer: data });
      expect(onSelectionChange).toHaveBeenLastCalledWith([1]);
      expect(data.effectAllowed).toBe('move');
      expect(data.setData).toHaveBeenCalledExactlyOnceWith('text/plain', '2');
      expect(card(2).className).toContain('opacity-40');
    });

    it('drags the whole selection when a selected page is dragged', () => {
      const { onSelectionChange } = show({ initial: [1, 4] });
      const data = transfer();
      send('dragStart', card(2), { dataTransfer: data });
      expect(onSelectionChange).not.toHaveBeenCalled();
      expect(data.setData).toHaveBeenCalledExactlyOnceWith('text/plain', '2, 5');
      expect(card(5).className).toContain('opacity-40');
      expect(card(3).className).not.toContain('opacity-40');
    });

    it('shows the line on the side of the card the pointer is on, and the other side right to left', () => {
      show();
      send('dragStart', card(1), { dataTransfer: transfer() });
      frame(4);
      send('dragOver', card(4), { clientX: 120, dataTransfer: transfer() });
      expect(indicators()).toEqual([['before', 4]]);
      send('dragOver', card(4), { clientX: 180, dataTransfer: transfer() });
      expect(indicators()).toEqual([['after', 4]]);
      // The same place again changes nothing.
      send('dragOver', card(4), { clientX: 190, dataTransfer: transfer() });
      expect(indicators()).toEqual([['after', 4]]);
      document.documentElement.dir = 'rtl';
      send('dragOver', card(4), { clientX: 180, dataTransfer: transfer() });
      expect(indicators()).toEqual([['before', 4]]);
    });

    it('accepts the drag over the grid’s own space, and leaves a file dragged in alone', () => {
      show();
      expect(send('dragOver', grid(), { dataTransfer: transfer() })).toBe(true);
      send('dragStart', card(1), { dataTransfer: transfer() });
      const data = transfer();
      expect(send('dragOver', grid(), { dataTransfer: data })).toBe(false);
      expect(data.dropEffect).toBe('move');
      expect(indicators()).toEqual([]);
    });

    it('drops the dragged page where the line is, counting the order that remains', () => {
      const { onPageAction, onSelectionChange } = show();
      send('dragStart', card(1), { dataTransfer: transfer() });
      frame(4);
      send('dragOver', card(4), { clientX: 180, dataTransfer: transfer() });
      expect(send('drop', card(4), { dataTransfer: transfer() })).toBe(false);
      // After page 4, with page 1 out of the way: the third place.
      expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 3 });
      expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
      expect(indicators()).toEqual([]);
    });

    it('drops several selected pages as one block before the card', () => {
      const { onPageAction, onSelectionChange } = show({ initial: [4, 5] });
      send('dragStart', card(6), { dataTransfer: transfer() });
      frame(2);
      send('dragOver', card(2), { clientX: 120, dataTransfer: transfer() });
      send('drop', card(2), { dataTransfer: transfer() });
      expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 1 });
      expect(onSelectionChange).toHaveBeenLastCalledWith([1, 2]);
    });

    it('drops on the grid’s own space after the last page', () => {
      const { onPageAction } = show();
      send('dragStart', card(2), { dataTransfer: transfer() });
      send('drop', grid(), { dataTransfer: transfer() });
      expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 6 });
    });

    it('ignores a drop that no drag in the view started', () => {
      const { onPageAction } = show();
      expect(send('drop', grid(), { dataTransfer: transfer() })).toBe(false);
      expect(onPageAction).not.toHaveBeenCalled();
    });

    it('takes the line away when the pointer leaves the grid or the drag ends, and moves nothing', () => {
      const { onPageAction } = show();
      send('dragStart', card(1), { dataTransfer: transfer() });
      frame(3);
      send('dragOver', card(3), { clientX: 120, dataTransfer: transfer() });
      expect(indicators()).toHaveLength(1);
      // Moving between two cards stays inside the grid.
      send('dragLeave', card(3), { relatedTarget: card(2) });
      expect(indicators()).toHaveLength(1);
      send('dragLeave', card(3), { relatedTarget: document.body });
      expect(indicators()).toEqual([]);
      send('dragOver', card(3), { clientX: 120, dataTransfer: transfer() });
      send('dragEnd', card(1));
      expect(indicators()).toEqual([]);
      expect(card(1).className).not.toContain('opacity-40');
      expect(onPageAction).not.toHaveBeenCalled();
    });
  });
});

describe('OrganizeView actions', () => {
  it('names the selection on the toolbar and offers nothing to act on without one', () => {
    show();
    expect(toolbar(0)).toBeTruthy();
    for (const name of [
      'Rotate left',
      'Rotate right',
      'Duplicate pages',
      'Delete pages',
      'Extract pages',
      'Move earlier',
      'Move later',
    ]) {
      expect(isDisabled(name)).toBe(true);
    }
    expect(screen.getByRole('spinbutton', { name: 'Move to' }).hasAttribute('disabled')).toBe(true);
    // Inserting pages needs no selection.
    expect(isDisabled('Insert pages')).toBe(false);
  });

  it('rotates, duplicates and deletes the selection, and opens the extract and insert forms', async () => {
    const { user, onPageAction, onExtract, onInsert } = show({ initial: [1, 2] });
    expect(toolbar(2)).toBeTruthy();
    await user.click(button('Rotate left'));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'rotate', direction: 'left' });
    await user.click(button('Rotate right'));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'rotate', direction: 'right' });
    await user.click(button('Duplicate pages'));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'duplicate' });
    await user.click(button('Delete pages'));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'delete' });
    await user.click(button('Extract pages'));
    expect(onExtract).toHaveBeenCalledTimes(1);
    await user.click(button('Insert pages'));
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('does not offer to delete every page', () => {
    show({ document: fakeDocument(2).handle, initial: [0, 1] });
    expect(isDisabled('Delete pages')).toBe(true);
  });

  it('leaves the extract and insert buttons off when the shell has no form for them', () => {
    show({ initial: [0], onExtract: undefined, onInsert: undefined });
    expect(isDisabled('Extract pages')).toBe(true);
    expect(isDisabled('Insert pages')).toBe(true);
  });

  it('selects while viewing but offers no action', async () => {
    const { user } = show({ editing: false });
    await user.click(card(1));
    expect(selectedCards()).toEqual([1]);
    for (const name of [
      'Rotate left',
      'Rotate right',
      'Duplicate pages',
      'Delete pages',
      'Extract pages',
      'Insert pages',
    ]) {
      expect(isDisabled(name)).toBe(true);
    }
    expect(screen.getByRole('spinbutton', { name: 'Move to' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('OrganizeView closing', () => {
  it('closes with the button and with Escape from a card or from a control', async () => {
    const { user, onClose } = show();
    await user.click(button('Back to document'));
    expect(onClose).toHaveBeenCalledTimes(1);
    card(2).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    button('Select several').focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
    await user.keyboard('a');
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('gives the focus back to what had it before the view opened', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = show();
    expect(document.activeElement).toBe(card(1));
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('does not focus an opener that has left the page', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = show();
    opener.remove();
    view.unmount();
    expect(document.activeElement).toBe(document.body);
  });
});
