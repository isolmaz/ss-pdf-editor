// @vitest-environment happy-dom
/**
 * The page list: selection by click, modifier-click, keyboard and select-all; reordering by
 * drag, by Alt/Ctrl+arrows and by the "move to" field; the selection toolbar and each
 * thumbnail's quick actions; page labels; and thumbnails that draw lazily, once, on a fresh
 * canvas, without a superseded render ever painting over its replacement. The panel never
 * touches the document: every change leaves as a callback.
 */

import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core';
import type { AnnotationMark } from 'pdf-core/ops/annotations';
import { createTranslator } from 'pdf-shared';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PagesPanel, type PagesPanelProps } from './PagesPanel';

const t = createTranslator('en');

/* ---------------------------------------------------------------------------------------- *
 * The lazy-thumbnail seam: an IntersectionObserver the tests can fire.
 * ---------------------------------------------------------------------------------------- */

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
    FakeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
}

/** Reports `holder` as visible (or not) to every live observer watching it. */
function reveal(holder: Element, isIntersecting = true) {
  const watching = FakeObserver.instances.filter(
    (observer) => !observer.disconnected && observer.targets.includes(holder),
  );
  for (const observer of watching) act(() => observer.callback([{ isIntersecting }]));
  return watching.length;
}

beforeEach(() => {
  FakeObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------------------------------- *
 * The document handle: the part of pdf.js the panel reads, answering on demand.
 * ---------------------------------------------------------------------------------------- */

interface FakeDocument {
  readonly handle: PdfDocumentHandle;
  readonly getPageLabels: Mock;
  readonly getPageSize: Mock;
  readonly renderPage: Mock;
}

function fakeDocument(
  pageCount: number,
  options: {
    labels?: Promise<readonly string[] | null>;
    size?: { width: number; height: number; rotation: number; viewBox: [number, number, number, number] };
    renderPage?: (...args: unknown[]) => Promise<void>;
  } = {},
): FakeDocument {
  const getPageLabels = vi.fn(() => options.labels ?? Promise.resolve(null));
  const getPageSize = vi.fn(
    async () => options.size ?? { width: 200, height: 300, rotation: 0, viewBox: [0, 0, 200, 300] },
  );
  const renderPage = vi.fn(options.renderPage ?? (async () => {}));
  return {
    handle: {
      pageCount,
      fingerprint: null,
      getPageLabels,
      getPageSize,
      renderPage,
    } as unknown as PdfDocumentHandle,
    getPageLabels,
    getPageSize,
    renderPage,
  };
}

/* ---------------------------------------------------------------------------------------- *
 * The panel, hosted the way the shell hosts it: the selection is the host's state.
 * ---------------------------------------------------------------------------------------- */

interface Spies {
  readonly onSelectionChange: Mock;
  readonly onGoToPage: Mock;
  readonly onPageAction: Mock;
}

function Host({
  spies,
  initial,
  ...props
}: Partial<PagesPanelProps> & {
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
    <PagesPanel
      t={t}
      currentPage={0}
      selectedPages={selected}
      onSelectionChange={onSelectionChange}
      onGoToPage={spies.onGoToPage}
      onPageAction={spies.onPageAction}
      editing
      {...props}
    />
  );
}

function show(props: Partial<PagesPanelProps> & { readonly initial?: readonly number[] } = {}) {
  const spies: Spies = { onSelectionChange: vi.fn(), onGoToPage: vi.fn(), onPageAction: vi.fn() };
  const { initial = [], document: given, ...rest } = props;
  const doc = given === undefined ? fakeDocument(5) : null;
  const view = render(
    <Host spies={spies} initial={initial} document={given ?? (doc as FakeDocument).handle} {...rest} />,
  );
  return { ...spies, doc, user: userEvent.setup(), ...view };
}

interface DragInit {
  readonly clientY?: number;
  readonly relatedTarget?: Element | null;
  readonly dataTransfer?: object;
}

const listbox = () => screen.getByRole('listbox', { name: 'Pages' });
const option = (page: number) => screen.getByRole('option', { name: `Go to page ${page}` });
const selectedOptions = () =>
  screen
    .getAllByRole('option')
    .filter((item) => item.getAttribute('aria-selected') === 'true')
    .map((item) => Number(item.getAttribute('data-page-option')) + 1);
const holderOf = (page: number) => option(page).querySelector('[data-thumbnail-page] > div') as HTMLElement;
const gaps = () => [...listbox().querySelectorAll('[data-gap]')];
const activeGaps = () =>
  gaps()
    .filter((gap) => gap.className.includes('bg-pdf-accent'))
    .map((gap) => Number(gap.getAttribute('data-gap')));
const toolbar = (count: number) => screen.getByRole('toolbar', { name: `Selection: ${count} page(s)` });

/* ---------------------------------------------------------------------------------------- */

describe('PagesPanel list', () => {
  it('lists every page as an option, marks the current one and announces the selection', () => {
    show({ currentPage: 2, initial: [1, 3] });
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(option(3).getAttribute('aria-current')).toBe('page');
    expect(option(1).hasAttribute('aria-current')).toBe(false);
    expect(selectedOptions()).toEqual([2, 4]);
    expect(screen.getByText('2 page(s) selected')).toBeTruthy();
    expect(listbox().getAttribute('aria-multiselectable')).toBe('true');
  });

  it('captions each page with its number, and with the file label in front when it differs', async () => {
    const doc = fakeDocument(5, { labels: Promise.resolve(['i', '', '3', '4', 'A-5']) });
    show({ document: doc.handle });
    await waitFor(() => expect(option(1).textContent).toContain('i (1)'));
    expect(option(2).textContent).toBe('2');
    expect(option(3).textContent).toBe('3');
    expect(option(4).textContent).toBe('4');
    expect(option(5).textContent).toBe('A-5 (5)');
  });

  it('captions pages with their numbers while the labels are read, when the file has none, and when reading fails', async () => {
    const pending = Promise.withResolvers<readonly string[] | null>();
    const doc = fakeDocument(2, { labels: pending.promise });
    const first = show({ document: doc.handle });
    expect(option(1).textContent).toBe('1');
    first.unmount();

    const none = fakeDocument(2);
    const second = show({ document: none.handle });
    await waitFor(() => expect(none.getPageLabels).toHaveBeenCalledOnce());
    expect(option(2).textContent).toBe('2');
    second.unmount();

    const broken = fakeDocument(2, { labels: Promise.reject(new Error('unreadable')) });
    show({ document: broken.handle });
    await waitFor(() => expect(broken.getPageLabels).toHaveBeenCalledOnce());
    expect(option(1).textContent).toBe('1');
  });

  it("does not show a previous document's labels once another document is open", async () => {
    const stale = Promise.withResolvers<readonly string[] | null>();
    const first = fakeDocument(2, { labels: stale.promise });
    const second = fakeDocument(2);
    const spies: Spies = { onSelectionChange: vi.fn(), onGoToPage: vi.fn(), onPageAction: vi.fn() };
    const { rerender } = render(<Host spies={spies} initial={[]} document={first.handle} />);
    rerender(<Host spies={spies} initial={[]} document={second.handle} />);
    await waitFor(() => expect(second.getPageLabels).toHaveBeenCalledOnce());
    await act(async () => stale.resolve(['old-1', 'old-2']));
    expect(option(1).textContent).toBe('1');
    expect(option(2).textContent).toBe('2');
  });

  it('keeps one tab stop, on the current page, and moves it with the viewer and with focus', async () => {
    const doc = fakeDocument(4);
    const spies: Spies = { onSelectionChange: vi.fn(), onGoToPage: vi.fn(), onPageAction: vi.fn() };
    const { rerender } = render(<Host spies={spies} initial={[]} document={doc.handle} currentPage={1} />);
    const tabStops = () =>
      screen
        .getAllByRole('option')
        .filter((item) => item.tabIndex === 0)
        .map((item) => item.getAttribute('data-page-option'));
    expect(tabStops()).toEqual(['1']);

    rerender(<Host spies={spies} initial={[]} document={doc.handle} currentPage={3} />);
    expect(tabStops()).toEqual(['3']);

    act(() => option(1).focus());
    expect(tabStops()).toEqual(['0']);
  });

  it('drops a selected page that no longer exists', () => {
    const { onSelectionChange } = show({ initial: [1, 9, 7] });
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([1]);
    expect(selectedOptions()).toEqual([2]);
  });

  it('leaves a selection inside the document alone', () => {
    const { onSelectionChange } = show({ initial: [0, 4] });
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('makes thumbnails draggable with a label when editing, and not when viewing', () => {
    const editing = show();
    expect(option(1).getAttribute('draggable')).toBe('true');
    expect(option(1).getAttribute('title')).toBe('Move page 1');
    editing.unmount();

    show({ editing: false });
    expect(option(1).getAttribute('draggable')).toBe('false');
    expect(option(1).hasAttribute('title')).toBe(false);
  });
});

describe('PagesPanel selecting with the pointer', () => {
  it('selects the clicked page and walks to it', async () => {
    const { user, onSelectionChange, onGoToPage } = show();
    await user.click(option(3));
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(2);
    expect(selectedOptions()).toEqual([3]);
  });

  it('toggles a page with Ctrl or Cmd, without walking anywhere', async () => {
    const { user, onSelectionChange, onGoToPage } = show({ initial: [0] });
    await user.keyboard('{Control>}');
    await user.click(option(3));
    expect(onSelectionChange).toHaveBeenLastCalledWith([0, 2]);
    await user.click(option(1));
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    await user.keyboard('{/Control}{Meta>}');
    await user.click(option(5));
    expect(onSelectionChange).toHaveBeenLastCalledWith([2, 4]);
    await user.keyboard('{/Meta}');
    expect(onGoToPage).not.toHaveBeenCalled();
  });

  it('selects the range from the last page clicked with Shift, in either direction', async () => {
    const { user, onSelectionChange } = show();
    await user.click(option(2));
    await user.keyboard('{Shift>}');
    await user.click(option(4));
    expect(onSelectionChange).toHaveBeenLastCalledWith([1, 2, 3]);
    await user.click(option(1));
    expect(onSelectionChange).toHaveBeenLastCalledWith([0, 1]);
    await user.keyboard('{/Shift}');
  });

  it('takes a Shift-click with no anchor as a plain click', async () => {
    const { user, onSelectionChange, onGoToPage } = show();
    await user.keyboard('{Shift>}');
    await user.click(option(4));
    await user.keyboard('{/Shift}');
    expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('clears the selection when the list itself is clicked, and not when a page is', async () => {
    const { user, onSelectionChange } = show({ initial: [1, 2] });
    await user.click(within(option(1)).getByText('1'));
    expect(onSelectionChange).toHaveBeenLastCalledWith([0]);
    await user.click(listbox());
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(selectedOptions()).toEqual([]);
  });

  it('drops the Shift anchor when the selection is cleared', async () => {
    const { user, onSelectionChange } = show();
    await user.click(option(2));
    await user.click(listbox());
    await user.keyboard('{Shift>}');
    await user.click(option(4));
    await user.keyboard('{/Shift}');
    expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
  });
});

describe('PagesPanel keyboard', () => {
  it('moves focus with the arrow keys, Home and End, and stays inside the document', async () => {
    const { user } = show({ currentPage: 1 });
    act(() => option(2).focus());
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(option(3));
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(option(1));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(option(5));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(option(5));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(option(1));
  });

  it('toggles the focused page with Space, and walks to it with Enter', async () => {
    const { user, onSelectionChange, onGoToPage } = show();
    act(() => option(3).focus());
    await user.keyboard(' ');
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    await user.keyboard('{ArrowDown} ');
    expect(onSelectionChange).toHaveBeenLastCalledWith([2, 3]);
    await user.keyboard(' ');
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    await user.keyboard('{Enter}');
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('takes the legacy Spacebar key as Space', () => {
    const { onSelectionChange } = show();
    act(() => option(2).focus());
    fireEvent.keyDown(option(2), { key: 'Spacebar' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([1]);
  });

  it('ignores a key it has no use for', async () => {
    const { user, onSelectionChange, onGoToPage, onPageAction } = show();
    act(() => option(2).focus());
    await user.keyboard('x{Tab}');
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onGoToPage).not.toHaveBeenCalled();
    expect(onPageAction).not.toHaveBeenCalled();
  });

  it('selects every page with Ctrl+A or Cmd+A and nothing with a bare A', async () => {
    const { user, onSelectionChange } = show();
    act(() => option(1).focus());
    await user.keyboard('a');
    expect(onSelectionChange).not.toHaveBeenCalled();
    await user.keyboard('{Control>}a{/Control}');
    expect(onSelectionChange).toHaveBeenLastCalledWith([0, 1, 2, 3, 4]);
    fireEvent.keyDown(option(1), { key: 'A', metaKey: true });
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
  });

  it('clears the selection with Escape, from a page and from the list itself', async () => {
    const { user, onSelectionChange } = show({ initial: [1, 2] });
    act(() => option(2).focus());
    await user.keyboard('{Escape}');
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);

    fireEvent.click(option(1));
    fireEvent.keyDown(listbox(), { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
    expect(selectedOptions()).toEqual([]);
  });

  it('selects every page with Ctrl+A pressed on the list itself', () => {
    const { onSelectionChange } = show();
    fireEvent.keyDown(listbox(), { key: 'a', ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith([0, 1, 2, 3, 4]);
  });

  it('moves the selection one place with Alt, Ctrl or Cmd and the arrows, keeping it selected', async () => {
    const { user, onPageAction, onSelectionChange } = show({ initial: [2] });
    act(() => option(3).focus());
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([1]);

    await user.keyboard('{Control>}{ArrowDown}{ArrowDown}{/Control}');
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 3 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
    fireEvent.keyDown(option(4), { key: 'ArrowUp', metaKey: true });
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 2 });
  });

  it('moves a block of pages together', async () => {
    const { user, onPageAction, onSelectionChange } = show({ initial: [1, 2] });
    act(() => option(2).focus());
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 2 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([2, 3]);
  });

  it('does not move past either end, and does not move an empty selection', async () => {
    const { user, onPageAction } = show({ initial: [0] });
    act(() => option(1).focus());
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onPageAction).not.toHaveBeenCalled();

    fireEvent.click(listbox());
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onPageAction).not.toHaveBeenCalled();
  });

  it('does not move past the end of the pages that remain', async () => {
    const { user, onPageAction } = show({ initial: [3, 4] });
    act(() => option(4).focus());
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onPageAction).not.toHaveBeenCalled();
  });
});

describe('PagesPanel selection toolbar', () => {
  it('appears only with a selection, and names its size', () => {
    const empty = show();
    expect(screen.queryByRole('toolbar')).toBeNull();
    empty.unmount();

    show({ initial: [0, 1] });
    expect(toolbar(2)).toBeTruthy();
  });

  it('turns the selection into one action each', async () => {
    const onExtract = vi.fn();
    const { user, onPageAction } = show({ initial: [1, 2], onExtract });
    const bar = within(toolbar(2));
    await user.click(bar.getByRole('button', { name: 'Rotate left' }));
    await user.click(bar.getByRole('button', { name: 'Rotate right' }));
    await user.click(bar.getByRole('button', { name: 'Duplicate pages' }));
    await user.click(bar.getByRole('button', { name: 'Delete pages' }));
    await user.click(bar.getByRole('button', { name: 'Extract Pages' }));
    expect(onPageAction.mock.calls).toEqual([
      [{ kind: 'rotate', direction: 'left' }],
      [{ kind: 'rotate', direction: 'right' }],
      [{ kind: 'duplicate' }],
      [{ kind: 'delete' }],
    ]);
    expect(onExtract).toHaveBeenCalledOnce();
  });

  it('moves the selection up or down one place with its buttons', async () => {
    const { user, onPageAction, onSelectionChange } = show({ initial: [2] });
    const bar = within(toolbar(1));
    await user.click(bar.getByRole('button', { name: 'Move up' }));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 1 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([1]);
    await user.click(bar.getByRole('button', { name: 'Move down' }));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'move', toIndex: 2 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
  });

  it('offers no move beyond the first or last place, and no delete of every page', () => {
    const first = show({ initial: [0] });
    expect(within(toolbar(1)).getByRole('button', { name: 'Move up' }).hasAttribute('disabled')).toBe(true);
    expect(within(toolbar(1)).getByRole('button', { name: 'Move down' }).hasAttribute('disabled')).toBe(
      false,
    );
    first.unmount();

    const last = show({ initial: [3, 4] });
    expect(within(toolbar(2)).getByRole('button', { name: 'Move down' }).hasAttribute('disabled')).toBe(true);
    expect(within(toolbar(2)).getByRole('button', { name: 'Move up' }).hasAttribute('disabled')).toBe(false);
    last.unmount();

    show({ initial: [0, 1, 2, 3, 4] });
    expect(within(toolbar(5)).getByRole('button', { name: 'Delete pages' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('disables every action while viewing, and extraction without a dialog', () => {
    const viewing = show({ initial: [1], editing: false, onExtract: () => {} });
    for (const name of [
      'Rotate left',
      'Rotate right',
      'Duplicate pages',
      'Delete pages',
      'Extract Pages',
      'Move up',
      'Move down',
    ]) {
      expect(within(toolbar(1)).getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
    expect(within(toolbar(1)).getByRole('spinbutton').hasAttribute('disabled')).toBe(true);
    viewing.unmount();

    show({ initial: [1] });
    expect(within(toolbar(1)).getByRole('button', { name: 'Extract Pages' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('PagesPanel "move to"', () => {
  const field = () => within(toolbar(1)).getByRole('spinbutton', { name: 'Move to…' }) as HTMLInputElement;
  const submit = () => within(toolbar(1)).getByRole('button', { name: 'Move to…' });

  it('bounds the field by the places that remain', () => {
    show({ initial: [0, 1] });
    const input = within(toolbar(2)).getByRole('spinbutton') as HTMLInputElement;
    expect([input.min, input.max]).toEqual(['1', '4']);
  });

  it('keeps the field at least one wide when every page is selected', () => {
    show({ initial: [0, 1, 2, 3, 4] });
    const input = within(toolbar(5)).getByRole('spinbutton') as HTMLInputElement;
    expect(input.max).toBe('1');
  });

  it('moves the selection to the typed place, keeps it selected and clears the field', async () => {
    const { user, onPageAction, onSelectionChange } = show({ initial: [0] });
    expect(submit().hasAttribute('disabled')).toBe(true);
    await user.type(field(), '3');
    expect(submit().hasAttribute('disabled')).toBe(false);
    await user.click(submit());
    expect(onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 2 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    expect(field().value).toBe('');
  });

  it('submits with Enter in the field', async () => {
    const { user, onPageAction } = show({ initial: [1, 2] });
    await user.type(within(toolbar(2)).getByRole('spinbutton'), '1{Enter}');
    expect(onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 0 });
  });

  it('offers nothing to submit for a blank field', async () => {
    const { user } = show({ initial: [0] });
    await user.type(field(), '   ');
    expect(submit().hasAttribute('disabled')).toBe(true);
  });
});

describe('PagesPanel quick actions on a thumbnail', () => {
  it('rotates or deletes that page alone, without selecting it through the click', async () => {
    const { user, onPageAction, onSelectionChange, onGoToPage } = show({ initial: [0, 1] });
    const card = within(option(4));
    await user.click(card.getByRole('button', { name: 'Rotate right' }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'rotate', direction: 'right', pages: [3] });

    await user.click(card.getByRole('button', { name: 'Rotate left' }));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'rotate', direction: 'left', pages: [3] });

    await user.click(card.getByRole('button', { name: 'Delete pages' }));
    expect(onPageAction).toHaveBeenLastCalledWith({ kind: 'delete', pages: [3] });
    expect(onPageAction).toHaveBeenCalledTimes(3);
    expect(onGoToPage).not.toHaveBeenCalled();
  });

  it('cannot delete the only page', () => {
    show({ document: fakeDocument(1).handle });
    expect(within(option(1)).getByRole('button', { name: 'Delete pages' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('is not there while viewing', () => {
    show({ editing: false });
    expect(within(option(1)).queryByRole('button')).toBeNull();
  });
});

describe('PagesPanel dragging', () => {
  /** Dispatches a drag event carrying the test's own transfer object, pointer height and related target: the DOM would drop or wrap them. */
  const send = (
    name: 'dragStart' | 'dragOver' | 'dragLeave' | 'dragEnd' | 'drop',
    target: Element,
    init: DragInit = {},
  ) => {
    const event = createEvent[name](target);
    for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value });
    return fireEvent(target, event);
  };
  const dnd = {
    dragStart: (target: Element, init?: DragInit) => send('dragStart', target, init),
    dragOver: (target: Element, init?: DragInit) => send('dragOver', target, init),
    dragLeave: (target: Element, init?: DragInit) => send('dragLeave', target, init),
    dragEnd: (target: Element, init?: DragInit) => send('dragEnd', target, init),
    drop: (target: Element, init?: DragInit) => send('drop', target, init),
  };
  const transfer = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' });
  const frame = (page: number) => {
    // The page option occupies y = 100 … 200: its upper half is above y = 150.
    option(page).getBoundingClientRect = () => new DOMRect(0, 100, 100, 100);
  };

  it('refuses to start a drag while viewing', () => {
    show({ editing: false });
    expect(dnd.dragStart(option(1), { dataTransfer: transfer() })).toBe(false);
  });

  it('drags the page under the pointer, selecting it, with its number as the payload', () => {
    const { onSelectionChange } = show({ initial: [3] });
    const data = transfer();
    dnd.dragStart(option(2), { dataTransfer: data });
    expect(onSelectionChange).toHaveBeenLastCalledWith([1]);
    expect(data.effectAllowed).toBe('move');
    expect(data.setData).toHaveBeenCalledExactlyOnceWith('text/plain', '2');
  });

  it('drags the whole selection when a selected page is dragged', () => {
    const { onSelectionChange } = show({ initial: [1, 2] });
    const data = transfer();
    dnd.dragStart(option(3), { dataTransfer: data });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(data.setData).toHaveBeenCalledExactlyOnceWith('text/plain', '2, 3');
  });

  it('shows the gap before or after a page by which half of it the pointer is over', () => {
    show();
    dnd.dragStart(option(1), { dataTransfer: transfer() });
    frame(3);
    const data = transfer();
    expect(dnd.dragOver(option(3), { clientY: 180, dataTransfer: data })).toBe(false);
    expect(data.dropEffect).toBe('move');
    expect(activeGaps()).toEqual([3]);
    dnd.dragOver(option(3), { clientY: 120, dataTransfer: data });
    expect(activeGaps()).toEqual([2]);
  });

  it('ignores a drag over a page when nothing of this list is being dragged', () => {
    show();
    frame(3);
    expect(dnd.dragOver(option(3), { clientY: 180, dataTransfer: transfer() })).toBe(true);
    expect(activeGaps()).toEqual([]);
    expect(dnd.dragOver(listbox(), { dataTransfer: transfer() })).toBe(true);
  });

  it('accepts a drag over the list itself while dragging', () => {
    show();
    dnd.dragStart(option(1), { dataTransfer: transfer() });
    const data = transfer();
    expect(dnd.dragOver(listbox(), { dataTransfer: data })).toBe(false);
    expect(data.dropEffect).toBe('move');
  });

  it('moves the dragged page to the gap it is dropped on, counting the places that remain', () => {
    const { onPageAction, onSelectionChange } = show();
    dnd.dragStart(option(1), { dataTransfer: transfer() });
    frame(4);
    dnd.dragOver(option(4), { clientY: 180, dataTransfer: transfer() });
    expect(dnd.drop(option(4), { dataTransfer: transfer() })).toBe(false);
    expect(onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 3 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([3]);
    expect(activeGaps()).toEqual([]);
  });

  it('moves a dragged block together, and a drop above it lands before the pages that follow', () => {
    const { onPageAction, onSelectionChange } = show({ initial: [3, 4] });
    dnd.dragStart(option(4), { dataTransfer: transfer() });
    frame(1);
    dnd.dragOver(option(1), { clientY: 120, dataTransfer: transfer() });
    dnd.drop(option(1), { dataTransfer: transfer() });
    expect(onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 0 });
    expect(onSelectionChange).toHaveBeenLastCalledWith([0, 1]);
  });

  it('drops on the page itself when no gap was shown', () => {
    const { onPageAction } = show();
    dnd.dragStart(option(5), { dataTransfer: transfer() });
    dnd.drop(option(2), { dataTransfer: transfer() });
    expect(onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 1 });
  });

  it('drops on the list itself at the shown gap, or at the end when none is shown', () => {
    const first = show();
    dnd.dragStart(option(5), { dataTransfer: transfer() });
    frame(2);
    dnd.dragOver(option(2), { clientY: 120, dataTransfer: transfer() });
    dnd.drop(listbox(), { dataTransfer: transfer() });
    expect(first.onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 1 });
    first.unmount();

    const second = show();
    dnd.dragStart(option(1), { dataTransfer: transfer() });
    dnd.drop(listbox(), { dataTransfer: transfer() });
    expect(second.onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'move', toIndex: 4 });
  });

  it('does nothing for a drop that did not start here', () => {
    const { onPageAction } = show();
    dnd.drop(listbox(), { dataTransfer: transfer() });
    dnd.drop(option(2), { dataTransfer: transfer() });
    expect(onPageAction).not.toHaveBeenCalled();
  });

  it('clears the shown gap when the pointer leaves the list, and not when it moves inside it', () => {
    show();
    dnd.dragStart(option(1), { dataTransfer: transfer() });
    frame(3);
    dnd.dragOver(option(3), { clientY: 180, dataTransfer: transfer() });
    dnd.dragLeave(listbox(), { relatedTarget: option(2) });
    expect(activeGaps()).toEqual([3]);
    dnd.dragLeave(listbox(), { relatedTarget: document.body });
    expect(activeGaps()).toEqual([]);
  });

  it('forgets the drag when it ends without a drop, so a later drop moves nothing', () => {
    const { onPageAction } = show();
    dnd.dragStart(option(1), { dataTransfer: transfer() });
    frame(3);
    dnd.dragOver(option(3), { clientY: 180, dataTransfer: transfer() });
    dnd.dragEnd(listbox());
    expect(activeGaps()).toEqual([]);
    dnd.drop(listbox(), { dataTransfer: transfer() });
    expect(onPageAction).not.toHaveBeenCalled();
  });
});

describe('PagesPanel thumbnails', () => {
  const mark = (pageIndex: number, id = `m${pageIndex}`): AnnotationMark => ({
    id,
    kind: 'highlight',
    pageIndex,
    quads: [[10, 10, 100, 30]],
    color: '#ffee00',
    opacity: 0.4,
    contents: '',
    author: '',
    createdAt: '2026-05-01T10:00:00.000Z',
  });

  it('draws nothing until a thumbnail is visible', () => {
    const doc = fakeDocument(3);
    show({ document: doc.handle });
    expect(doc.getPageSize).not.toHaveBeenCalled();
    expect(doc.renderPage).not.toHaveBeenCalled();
    reveal(holderOf(2), false);
    expect(doc.getPageSize).not.toHaveBeenCalled();
  });

  it('draws a visible page once, at the thumbnail width, on a canvas of its own', async () => {
    const doc = fakeDocument(3);
    show({ document: doc.handle });
    reveal(holderOf(2));
    await waitFor(() => expect(holderOf(2).querySelector('canvas')).not.toBeNull());

    expect(doc.getPageSize).toHaveBeenCalledExactlyOnceWith(1, 1);
    const [pageIndex, canvas, renderOptions] = doc.renderPage.mock.calls[0] as [
      number,
      HTMLCanvasElement,
      { scale: number; signal: AbortSignal },
    ];
    expect(pageIndex).toBe(1);
    expect(canvas).toBe(holderOf(2).querySelector('canvas'));
    expect([canvas.width, canvas.height]).toEqual([104, 156]);
    expect(renderOptions.scale).toBe(104 / 200);
    expect(renderOptions.signal.aborted).toBe(false);
    expect((holderOf(2).parentElement as HTMLElement).style.height).toBe('156px');
    expect(holderOf(1).querySelector('canvas')).toBeNull();

    reveal(holderOf(2));
    expect(doc.renderPage).toHaveBeenCalledOnce();
  });

  it('reserves a placeholder height before the page size is known', () => {
    show();
    expect((holderOf(1).parentElement as HTMLElement).style.height).toBe('140px');
  });

  it('draws the page again the next time it is visible after a failed attempt', async () => {
    let attempts = 0;
    const doc = fakeDocument(2, {
      renderPage: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('render aborted');
      },
    });
    show({ document: doc.handle });
    reveal(holderOf(1));
    await waitFor(() => expect(doc.renderPage).toHaveBeenCalledOnce());
    expect(holderOf(1).querySelector('canvas')).toBeNull();

    reveal(holderOf(1));
    await waitFor(() => expect(holderOf(1).querySelector('canvas')).not.toBeNull());
    expect(doc.renderPage).toHaveBeenCalledTimes(2);
  });

  it('draws the session marks of that page over the thumbnail, and only those', async () => {
    const doc = fakeDocument(2);
    show({ document: doc.handle, marks: [mark(0, 'a'), mark(0, 'b'), mark(1, 'c')] });
    const marksOn = (page: number) => option(page).querySelectorAll('[data-thumbnail-marks] > div');
    expect(marksOn(1)).toHaveLength(0);

    reveal(holderOf(1));
    await waitFor(() => expect(marksOn(1)).toHaveLength(2));
    expect(option(1).querySelector('[data-ann]')).toBeNull();
    expect(marksOn(2)).toHaveLength(0);

    reveal(holderOf(2));
    await waitFor(() => expect(marksOn(2)).toHaveLength(1));
  });

  it('draws no mark layer for a page without marks, or one whose geometry cannot be projected', async () => {
    const empty = fakeDocument(1);
    const first = show({ document: empty.handle });
    reveal(holderOf(1));
    await waitFor(() => expect(holderOf(1).querySelector('canvas')).not.toBeNull());
    expect(option(1).querySelector('[data-thumbnail-marks]')).toBeNull();
    first.unmount();

    const flat = fakeDocument(1, { size: { width: 200, height: 300, rotation: 0, viewBox: [0, 0, 0, 0] } });
    show({ document: flat.handle, marks: [mark(0)] });
    reveal(holderOf(1));
    await waitFor(() => expect(holderOf(1).querySelector('canvas')).not.toBeNull());
    expect(option(1).querySelector('[data-thumbnail-marks]')).toBeNull();
  });

  it('turns the marks with a rotated page, including a negative rotation', async () => {
    const doc = fakeDocument(1, {
      size: { width: 300, height: 200, rotation: -90, viewBox: [0, 0, 200, 300] },
    });
    show({ document: doc.handle, marks: [mark(0)] });
    reveal(holderOf(1));
    await waitFor(() => expect(option(1).querySelector('[data-thumbnail-marks]')).not.toBeNull());
  });

  it('never lets a render of a superseded document paint over its replacement', async () => {
    const slow = Promise.withResolvers<void>();
    const first = fakeDocument(2, { renderPage: () => slow.promise });
    const second = fakeDocument(2);
    const spies: Spies = { onSelectionChange: vi.fn(), onGoToPage: vi.fn(), onPageAction: vi.fn() };
    const { rerender } = render(
      <Host spies={spies} initial={[]} document={first.handle} marks={[mark(0)]} />,
    );
    const holder = holderOf(1);
    reveal(holder);
    await waitFor(() => expect(first.renderPage).toHaveBeenCalledOnce());

    rerender(<Host spies={spies} initial={[]} document={second.handle} marks={[mark(0)]} />);
    await act(async () => slow.resolve());
    expect(holder.querySelector('canvas')).toBeNull();
    expect(option(1).querySelector('[data-thumbnail-marks]')).toBeNull();

    reveal(holder);
    await waitFor(() => expect(second.renderPage).toHaveBeenCalledOnce());
    await waitFor(() => expect(holder.querySelectorAll('canvas')).toHaveLength(1));
    expect(holder.querySelector('canvas')).toBe(second.renderPage.mock.calls[0]?.[1]);
  });

  it('forgets what it drew when another document replaces it, until the page is visible again', async () => {
    const first = fakeDocument(1);
    const second = fakeDocument(1);
    const spies: Spies = { onSelectionChange: vi.fn(), onGoToPage: vi.fn(), onPageAction: vi.fn() };
    const { rerender } = render(
      <Host spies={spies} initial={[]} document={first.handle} marks={[mark(0)]} />,
    );
    reveal(holderOf(1));
    await waitFor(() => expect(option(1).querySelector('[data-thumbnail-marks]')).not.toBeNull());

    rerender(<Host spies={spies} initial={[]} document={second.handle} marks={[mark(0)]} />);
    expect(option(1).querySelector('[data-thumbnail-marks]')).toBeNull();
    reveal(holderOf(1));
    await waitFor(() => expect(second.renderPage).toHaveBeenCalledOnce());
  });

  it('starts a fresh thumbnail when the document version changes', async () => {
    const doc = fakeDocument(1);
    const spies: Spies = { onSelectionChange: vi.fn(), onGoToPage: vi.fn(), onPageAction: vi.fn() };
    const { rerender } = render(<Host spies={spies} initial={[]} document={doc.handle} version="a" />);
    reveal(holderOf(1));
    await waitFor(() => expect(holderOf(1).querySelector('canvas')).not.toBeNull());

    rerender(<Host spies={spies} initial={[]} document={doc.handle} version="b" />);
    expect(holderOf(1).querySelector('canvas')).toBeNull();
    reveal(holderOf(1));
    await waitFor(() => expect(doc.renderPage).toHaveBeenCalledTimes(2));
  });

  it('stops watching a thumbnail that is gone', () => {
    const { unmount } = show();
    const watching = FakeObserver.instances.filter((observer) => !observer.disconnected);
    expect(watching.length).toBe(5);
    unmount();
    expect(FakeObserver.instances.every((observer) => observer.disconnected)).toBe(true);
  });
});
