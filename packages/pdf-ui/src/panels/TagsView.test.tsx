// @vitest-environment happy-dom
/**
 * The tags view: the structure tree of a tagged file (or the drawing order of an untagged one)
 * as a list the user reorders, retags and describes, with nothing written until Apply. The
 * readers and writers have their own suites, so they answer here with what their contracts
 * describe; the structure model's edits are the real ones, so the tree on screen is what the
 * file will read back as.
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
import type { PageLayout, StructureView, TagCandidate, TagCandidatePage } from 'pdf-core/ops/structure';
import { EMPTY_MODEL, type StructNode, type StructureModel } from 'pdf-core/ops/structure-model';
import { el, mcid, modelOf } from 'pdf-core/ops/structure-model.fixtures';
import type { OperationNote } from 'pdf-core/ops/types';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readingOrderStore } from './reading-order-store';
import { TagsView, type TagsViewProps } from './TagsView';

const engine = vi.hoisted(() => ({
  readStructure: vi.fn(),
  readTagCandidates: vi.fn(),
  readPageLayout: vi.fn(),
  editStructure: vi.fn(),
  tagDocument: vi.fn(),
  fixPdfUa: vi.fn(),
}));
vi.mock('pdf-core/ops/structure', () => ({
  readStructure: engine.readStructure,
  readTagCandidates: engine.readTagCandidates,
  readPageLayout: engine.readPageLayout,
  editStructure: engine.editStructure,
}));
vi.mock('pdf-core/ops/accessibility', () => ({ tagDocument: engine.tagDocument }));
vi.mock('pdf-core/ops/pdfua', () => ({ fixPdfUa: engine.fixPdfUa }));

const t = createTranslator('en');
const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  for (const fn of Object.values(engine)) fn.mockReset();
  readingOrderStore.clear();
  readingOrderStore.setPages([]);
  readingOrderStore.takeFocus();
});
afterEach(cleanup);

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// Document → Sect a (H1, P, P), Sect b (a Figure without a description, one with, Table → TR → TH),
// Sect c on page two (P).
const h1 = el('h1', 'H1', [mcid(0)]);
const p1 = el('p1', 'P', [mcid(1)]);
const p2 = el('p2', 'P', [mcid(2)]);
const sectA = el('a', 'Sect', [h1, p1, p2]);
const fig = el('fig', 'Figure', [mcid(3)]);
const logo = el('logo', 'Figure', [mcid(4)], { alt: 'Company logo' });
const th = el('th', 'TH', [mcid(5)]);
const table = el('table', 'Table', [el('tr', 'TR', [th])]);
const sectB = el('b', 'Sect', [fig, logo, table]);
const p3 = el('p3', 'P', [mcid(0, 1)], { pageIndex: 1 });
const sectC = el('c', 'Sect', [p3], { pageIndex: 1 });
const doc = el('doc', 'Document', [sectA, sectB, sectC]);
const MAIN = modelOf(doc);

const layoutOf = (
  pageIndex: number,
  items: PageLayout['items'] = [],
  overrides: Partial<PageLayout> = {},
): PageLayout => ({
  pageIndex,
  width: 300,
  height: 400,
  rotation: 0,
  items,
  textFailed: false,
  unreadable: false,
  ...overrides,
});

const MAIN_LAYOUTS: Record<number, PageLayout> = {
  0: layoutOf(0, [
    { mcid: 0, rect: [10, 10, 50, 20], text: 'Annual report' },
    { mcid: 1, rect: [10, 30, 60, 40], text: 'First paragraph' },
    { mcid: 2, rect: null, text: '' },
    { mcid: 3, rect: [10, 60, 40, 90], text: '' },
    { mcid: 4, rect: [60, 60, 90, 90], text: '' },
    { mcid: 5, rect: [10, 100, 40, 110], text: 'Quarter' },
  ]),
  1: layoutOf(1, [{ mcid: 0, rect: [5, 5, 95, 15], text: 'Page two text' }]),
};

interface MountOptions extends Partial<TagsViewProps> {
  readonly pageCount?: number;
  /** Layouts by page; a page without one is read as an empty page. */
  readonly layouts?: Record<number, PageLayout | Error>;
}

function stubTagged(model: StructureModel, options: MountOptions = {}) {
  const view: StructureView = { pageCount: options.pageCount ?? 2, model };
  engine.readStructure.mockResolvedValue(view);
  engine.readPageLayout.mockImplementation(async (_bytes: Uint8Array, pageIndex: number) => {
    const found = options.layouts?.[pageIndex] ?? layoutOf(pageIndex);
    if (found instanceof Error) throw found;
    return found;
  });
}

async function mountTagged(model: StructureModel, options: MountOptions = {}) {
  stubTagged(model, options);
  const { pageCount: _pageCount, layouts: _layouts, ...overrides } = options;
  const read = vi.fn(async () => BYTES);
  const onWritten = vi.fn();
  const onNotice = vi.fn();
  const onGoToPage = vi.fn();
  const props: TagsViewProps = {
    t,
    read,
    language: 'en',
    currentPage: 0,
    canEdit: true,
    onWritten,
    onNotice,
    onGoToPage,
    ...overrides,
  };
  const view = render(<TagsView {...props} />);
  await screen.findByRole('tree', { name: 'Structure tree' });
  return { ...view, props, read, onWritten, onNotice, onGoToPage, user: userEvent.setup() };
}

const row = (key: string) => document.querySelector(`[data-tag-key="${key}"]`) as HTMLElement;
const rowKeys = () =>
  [...document.querySelectorAll('[data-tag-key]')].map((entry) => entry.getAttribute('data-tag-key'));
const selectedKeys = () => readingOrderStore.snapshot().selectedKeys;
const button = (name: string) => screen.getByRole('button', { name });
const typeSelect = () => screen.getByRole('combobox', { name: 'Type' }) as HTMLSelectElement;
const draftText = () => document.querySelector('[data-tags-draft]')?.textContent;
const numberOf = (key: string) => row(key).querySelector('.tabular-nums')?.textContent;

/** A DataTransfer that carries what `setData` was given, which the drop reads back. */
function transfer(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    effectAllowed: 'uninitialized',
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? '',
  };
}

/** Drag-over or drop at a height inside the row; happy-dom's drag events do not take `clientY` themselves. */
function dragAt(type: 'dragOver' | 'drop', target: Element, clientY: number, dataTransfer = transfer()) {
  const event = createEvent[type](target, { dataTransfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(target, event);
}

/** What a drag start leaves in the browser's `effectAllowed`, read where the event ends its way. */
function startDrag(target: Element, dataTransfer = transfer()) {
  let allowed: string | undefined;
  const read = (event: Event) => {
    allowed = (event as DragEvent).dataTransfer?.effectAllowed;
  };
  document.addEventListener('dragstart', read);
  fireEvent.dragStart(target, { dataTransfer });
  document.removeEventListener('dragstart', read);
  return { data: dataTransfer.data, allowed };
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

describe('TagsView: reading the file', () => {
  it('shows a skeleton until the file is read, then the tree of a tagged one', async () => {
    const { promise, resolve } = Promise.withResolvers<Uint8Array>();
    stubTagged(MAIN);
    render(<TagsView t={t} read={() => promise} language="en" currentPage={0} canEdit />);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('tree')).toBeNull();

    await act(async () => resolve(BYTES));
    await screen.findByRole('tree', { name: 'Structure tree' });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(engine.readStructure).toHaveBeenCalledWith(
      BYTES,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.querySelector('[data-tags-mode]')?.getAttribute('data-tags-mode')).toBe('tagged');
  });

  it('says what failed and tells the shell when the file cannot be read', async () => {
    engine.readStructure.mockRejectedValue(new ToolError('internal', { engine: 'mupdf' }));
    const onNotice = vi.fn();
    render(
      <TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit onNotice={onNotice} />,
    );
    const failure = new ToolError('internal', { engine: 'mupdf' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
  });

  it('shows a failed read even when the shell takes no notices', async () => {
    engine.readStructure.mockRejectedValue(new Error('boom'));
    render(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('ignores the answer to a read that a newer one replaced: the structure it found', async () => {
    const stale = Promise.withResolvers<StructureView>();
    engine.readStructure.mockReturnValueOnce(stale.promise).mockResolvedValue({ pageCount: 2, model: MAIN });
    engine.readPageLayout.mockResolvedValue(layoutOf(0));
    engine.readTagCandidates.mockResolvedValue({ pages: [], notes: [], bodySize: 12 });
    const first = render(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
    first.rerender(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
    await screen.findByRole('tree', { name: 'Structure tree' });
    await act(async () => stale.resolve({ pageCount: 1, model: EMPTY_MODEL }));
    expect(screen.getByRole('tree', { name: 'Structure tree' })).toBeTruthy();
    expect(screen.queryByText('This file has no tags.')).toBeNull();
    expect(engine.readTagCandidates).not.toHaveBeenCalled();
  });

  it('ignores the answer to a read that a newer one replaced: the candidates it found', async () => {
    const stale = Promise.withResolvers<{ pages: TagCandidatePage[]; notes: []; bodySize: number }>();
    engine.readStructure.mockResolvedValue({ pageCount: 2, model: EMPTY_MODEL });
    engine.readTagCandidates.mockReturnValueOnce(stale.promise).mockResolvedValue({
      pages: [{ ...PAGE_ZERO, candidates: [candidate('fresh')] }],
      notes: [],
      bodySize: 12,
    });
    const first = render(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
    await waitFor(() => expect(engine.readTagCandidates).toHaveBeenCalledOnce());
    first.rerender(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
    await waitFor(() => expect(planIds()).toEqual(['fresh']));
    await act(async () =>
      stale.resolve({ pages: [{ ...PAGE_ZERO, candidates: [candidate('stale')] }], notes: [], bodySize: 12 }),
    );
    expect(planIds()).toEqual(['fresh']);
  });

  it('ignores the failure of a read that a newer one replaced', async () => {
    const stale = Promise.withResolvers<StructureView>();
    engine.readStructure.mockReturnValueOnce(stale.promise).mockResolvedValue({ pageCount: 2, model: MAIN });
    engine.readPageLayout.mockResolvedValue(layoutOf(0));
    const onNotice = vi.fn();
    const first = render(
      <TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit onNotice={onNotice} />,
    );
    first.rerender(
      <TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit onNotice={onNotice} />,
    );
    await screen.findByRole('tree', { name: 'Structure tree' });
    await act(async () => stale.reject(new Error('late')));
    expect(screen.getByRole('tree', { name: 'Structure tree' })).toBeTruthy();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('clears the boxes when the view closes before the read answers', async () => {
    readingOrderStore.setPages([{ pageIndex: 0, width: 1, height: 1, rotation: 0, items: [] }]);
    const pending = Promise.withResolvers<Uint8Array>();
    const view = render(
      <TagsView t={t} read={() => pending.promise} language="en" currentPage={0} canEdit />,
    );
    view.unmount();
    expect(readingOrderStore.snapshot().pages).toEqual([]);
  });

  it('reads the candidates when the structure tree is absent, and again when it cannot be entered', async () => {
    engine.readTagCandidates.mockResolvedValue({ pages: [], notes: [], bodySize: 12 });
    for (const model of [EMPTY_MODEL, { ...EMPTY_MODEL, present: true, readable: false }]) {
      engine.readStructure.mockResolvedValue({ pageCount: 1, model });
      const view = render(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
      expect(await screen.findByText('This file has no tags.')).toBeTruthy();
      view.unmount();
    }
    expect(engine.readTagCandidates).toHaveBeenCalledTimes(2);
    expect(engine.readTagCandidates).toHaveBeenCalledWith(
      BYTES,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

/* ------------------------------------------------------------------ *
 * The tree
 * ------------------------------------------------------------------ */

describe('TagsView: the tree of a tagged file', () => {
  it('lists the elements of the page on screen with their level, type and text, and the whole document on request', async () => {
    const { user } = await mountTagged(MAIN, { layouts: MAIN_LAYOUTS });
    expect(rowKeys()).toEqual(['doc', 'a', 'h1', 'p1', 'p2', 'b', 'fig', 'logo', 'table', 'tr', 'th']);
    expect(row('doc').getAttribute('aria-level')).toBe('1');
    expect(row('h1').getAttribute('aria-level')).toBe('3');
    expect(row('h1').getAttribute('data-tag-role')).toBe('H1');
    expect(row('a').getAttribute('aria-expanded')).toBe('true');
    expect(row('h1').hasAttribute('aria-expanded')).toBe(false);
    expect(await within(row('h1')).findByText('Annual report')).toBeTruthy();
    expect(within(row('p1')).getByText('First paragraph')).toBeTruthy();
    // No text of its own: the alternative text names it, or nothing does.
    expect(within(row('logo')).getByText('Company logo')).toBeTruthy();
    expect(row('p2').querySelector('.truncate')?.textContent).toBe('');

    const scope = screen.getByRole('combobox', { name: 'Show' }) as HTMLSelectElement;
    expect(scope.value).toBe('page');
    expect(within(scope).getByRole('option', { name: 'Page 1' })).toBeTruthy();
    await user.selectOptions(scope, 'Whole document');
    expect(rowKeys()).toEqual([
      'doc',
      'a',
      'h1',
      'p1',
      'p2',
      'b',
      'fig',
      'logo',
      'table',
      'tr',
      'th',
      'c',
      'p3',
    ]);
  });

  it('shows a one-page document whole, and says so when the page has no element', async () => {
    await mountTagged(MAIN, { pageCount: 1 });
    expect((screen.getByRole('combobox', { name: 'Show' }) as HTMLSelectElement).value).toBe('all');
    expect(rowKeys()).toContain('p3');
    cleanup();

    await mountTagged(modelOf(el('only', 'Document', [el('x', 'P', [mcid(0)])])), { currentPage: 1 });
    expect(rowKeys()).toEqual([]);
    expect(screen.getByText('No elements to show on this page.')).toBeTruthy();
  });

  it('keeps an element that owns no content in every page view', async () => {
    const model = modelOf(
      el('doc', 'Document', [
        el('x', 'P', [mcid(0)]),
        el('empty', 'Div', []),
        el('y', 'P', [mcid(0, 1)], { pageIndex: 1 }),
      ]),
    );
    await mountTagged(model);
    expect(rowKeys()).toEqual(['doc', 'x', 'empty']);
    cleanup();
    await mountTagged(model, { currentPage: 1 });
    expect(rowKeys()).toEqual(['doc', 'empty', 'y']);
  });

  it('numbers the elements that own content on the page, and badges types the file does not define', async () => {
    const odd = modelOf(
      el('doc', 'Document', [
        el('mapped', 'Custom', [mcid(0)], { standard: 'P' }),
        el('unmapped', 'Weird', [mcid(1)], { standard: null }),
        el('untyped', '', [mcid(2)], { standard: null }),
      ]),
    );
    await mountTagged(odd);
    expect(numberOf('doc')).toBe('0');
    expect(numberOf('mapped')).toBe('1');
    expect(numberOf('untyped')).toBe('3');
    expect(within(row('mapped')).getByText('Custom').getAttribute('title')).toBe('Standard type: P');
    expect(within(row('unmapped')).getByText('Weird').getAttribute('title')).toBeNull();
    expect(within(row('untyped')).getByText('?').className).toContain('text-kumo-danger');
  });

  it('flags the pictures and formulas that have no alternative text', async () => {
    const model = modelOf(
      el('doc', 'Document', [
        el('bare', 'Figure', [mcid(0)]),
        el('described', 'Figure', [mcid(1)], { alt: 'Logo' }),
        el('spoken', 'Formula', [mcid(2)], { actualText: 'x squared' }),
        el('math', 'Formula', [mcid(3)]),
        el('plain', 'P', [mcid(4)]),
      ]),
    );
    await mountTagged(model);
    expect(within(row('bare')).getByText('no alt').getAttribute('title')).toBe('No alternative text');
    expect(within(row('math')).getByText('no alt')).toBeTruthy();
    for (const key of ['described', 'spoken', 'plain'])
      expect(within(row(key)).queryByText('no alt')).toBeNull();
  });

  it('folds and unfolds a branch with its caret without selecting it', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(within(row('a')).getByRole('button', { name: 'Collapse' }));
    expect(rowKeys()).toEqual(['doc', 'a', 'b', 'fig', 'logo', 'table', 'tr', 'th']);
    expect(row('a').getAttribute('aria-expanded')).toBe('false');
    expect(row('a').getAttribute('aria-selected')).toBe('false');
    expect(selectedKeys()).toEqual([]);
    await user.click(within(row('a')).getByRole('button', { name: 'Expand' }));
    expect(rowKeys()).toContain('h1');
    expect(row('h1').hasAttribute('aria-expanded')).toBe(false);
  });

  it('starts a big tree folded below its second level and cuts it at 800 rows, saying so', async () => {
    const leaves = Array.from({ length: 804 }, (_, index) =>
      el(`s${String(index)}`, 'P', [], { pageIndex: null }),
    );
    const nested = el('nest', 'Div', [el('deep', 'Span', [el('deeper', 'P', [])])]);
    const model = { ...modelOf(el('doc', 'Document', [nested, ...leaves])), nodeCount: 900 };
    await mountTagged(model, { pageCount: 1 });
    // doc (0) and nest (1) are open; deep (2) has kids, so it is folded; its child is not listed.
    expect(row('nest').getAttribute('aria-expanded')).toBe('true');
    expect(row('deep').getAttribute('aria-expanded')).toBe('false');
    expect(row('deeper')).toBeNull();
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(800);
    expect(screen.getByText('7 more rows are hidden. Narrow the view to one page.')).toBeTruthy();
  });

  it('leaves a small tree open and shows no cut notice', async () => {
    await mountTagged(MAIN);
    expect(screen.queryByText(/more rows are hidden/)).toBeNull();
    expect(row('th')).not.toBeNull();
  });
});

describe('TagsView: the boxes on the page', () => {
  it("publishes the draft order as numbered boxes per page, a box being the union of an element's content", async () => {
    const model = modelOf(
      el('doc', 'Document', [
        el('first', 'H1', [mcid(0)]),
        el('two', 'P', [mcid(1), mcid(2), mcid(9)]),
        el('none', 'P', [mcid(3)]),
        el('late', 'P', [mcid(4), mcid(5, 1)]),
      ]),
    );
    await mountTagged(model, {
      layouts: {
        0: layoutOf(0, [
          { mcid: 0, rect: [10, 10, 50, 20], text: 'Title' },
          { mcid: 1, rect: [0, 30, 10, 40], text: 'one' },
          { mcid: 2, rect: [5, 35, 30, 60], text: 'two' },
          { mcid: 3, rect: null, text: '' },
          { mcid: 4, rect: [1, 2, 3, 4], text: 'late' },
        ]),
        1: layoutOf(1, [{ mcid: 5, rect: [7, 8, 9, 10], text: 'p2' }], {
          rotation: 90,
          width: 200,
          height: 100,
        }),
      },
    });
    await waitFor(() => expect(readingOrderStore.snapshot().pages).toHaveLength(2));
    expect(readingOrderStore.snapshot().pages).toEqual([
      {
        pageIndex: 0,
        width: 300,
        height: 400,
        rotation: 0,
        items: [
          { key: 'first', number: 1, role: 'H1', rect: [10, 10, 50, 20] },
          // Two boxes, and a content id the layout does not know, make one box.
          { key: 'two', number: 2, role: 'P', rect: [0, 30, 30, 60] },
          // 'none' is number 3 but has no box to draw.
          { key: 'late', number: 4, role: 'P', rect: [1, 2, 3, 4] },
        ],
      },
      {
        pageIndex: 1,
        width: 200,
        height: 100,
        rotation: 90,
        items: [{ key: 'late', number: 1, role: 'P', rect: [7, 8, 9, 10] }],
      },
    ]);
  });

  it('clears the boxes when the view closes', async () => {
    const { unmount } = await mountTagged(MAIN, { layouts: MAIN_LAYOUTS });
    await waitFor(() => expect(readingOrderStore.snapshot().pages.length).toBeGreaterThan(0));
    unmount();
    expect(readingOrderStore.snapshot().pages).toEqual([]);
  });

  it("reads the layouts of the pages around the one on screen, and of the selected element's page", async () => {
    const { user } = await mountTagged(MAIN, { pageCount: 6, currentPage: 4, layouts: MAIN_LAYOUTS });
    await waitFor(() => expect(engine.readPageLayout).toHaveBeenCalledTimes(3));
    expect(engine.readPageLayout.mock.calls.map((call) => call[1])).toEqual([3, 4, 5]);
    expect(engine.readPageLayout).toHaveBeenCalledWith(BYTES, 3, { signal: expect.any(AbortSignal) });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Whole document');
    await user.click(row('p3'));
    await waitFor(() => expect(engine.readPageLayout).toHaveBeenCalledTimes(4));
    expect(engine.readPageLayout.mock.calls.map((call) => call[1])).toEqual([3, 4, 5, 1]);
  });

  it('asks again only for pages it has not read when the page on screen changes', async () => {
    const { rerender, props } = await mountTagged(MAIN, {
      pageCount: 3,
      currentPage: 0,
      layouts: MAIN_LAYOUTS,
    });
    await waitFor(() => expect(engine.readPageLayout).toHaveBeenCalledTimes(2));
    rerender(<TagsView {...props} currentPage={1} />);
    await waitFor(() => expect(engine.readPageLayout).toHaveBeenCalledTimes(3));
    expect(engine.readPageLayout.mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
  });

  it('lists the rows of a page whose layout cannot be read, and does not ask for it again', async () => {
    const { rerender, props } = await mountTagged(MAIN, {
      pageCount: 3,
      layouts: { 0: new Error('unreadable'), 1: MAIN_LAYOUTS[1] as PageLayout },
    });
    await waitFor(() =>
      expect(readingOrderStore.snapshot().pages.map((page) => page.pageIndex)).toEqual([1]),
    );
    expect(rowKeys()).toContain('h1');
    expect(within(row('h1')).queryByText('Annual report')).toBeNull();
    rerender(<TagsView {...props} currentPage={1} />);
    await waitFor(() => expect(engine.readPageLayout).toHaveBeenCalledTimes(3));
    expect(engine.readPageLayout.mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
  });

  it('stops reading layouts when the view closes while one is pending', async () => {
    const pending = Promise.withResolvers<PageLayout>();
    stubTagged(MAIN);
    engine.readPageLayout.mockReturnValue(pending.promise);
    const view = render(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
    await waitFor(() => expect(engine.readPageLayout).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.resolve(layoutOf(0)));
    expect(engine.readPageLayout).toHaveBeenCalledOnce();
  });

  it('stops reading layouts when the view closes while one fails', async () => {
    const pending = Promise.withResolvers<PageLayout>();
    stubTagged(MAIN);
    engine.readPageLayout.mockReturnValue(pending.promise);
    const view = render(<TagsView t={t} read={async () => BYTES} language="en" currentPage={0} canEdit />);
    await waitFor(() => expect(engine.readPageLayout).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.reject(new Error('gone')));
    expect(engine.readPageLayout).toHaveBeenCalledOnce();
  });
});

/* ------------------------------------------------------------------ *
 * Selecting and moving through the tree
 * ------------------------------------------------------------------ */

describe('TagsView: selecting', () => {
  it('selects a row on click and goes to its page when that is not the one on screen', async () => {
    const { user, onGoToPage } = await mountTagged(MAIN);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'Whole document');
    await user.click(row('p1'));
    expect(selectedKeys()).toEqual(['p1']);
    expect(row('p1').getAttribute('aria-selected')).toBe('true');
    expect(onGoToPage).not.toHaveBeenCalled();

    await user.click(row('p3'));
    expect(selectedKeys()).toEqual(['p3']);
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('goes to the first page an element with no page of its own has content on, and nowhere when it has none', async () => {
    const model = modelOf(
      el('doc', 'Document', [
        el('wrapper', 'Sect', [el('inner', 'P', [mcid(0, 2)], { pageIndex: 2 })], { pageIndex: null }),
        el('hollow', 'Div', [], { pageIndex: null }),
      ]),
    );
    const { user, onGoToPage } = await mountTagged(model, { pageCount: 1 });
    await user.click(row('hollow'));
    expect(onGoToPage).not.toHaveBeenCalled();
    await user.click(row('wrapper'));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('selects without a shell that follows pages', async () => {
    const { user } = await mountTagged(MAIN, { onGoToPage: undefined, pageCount: 1 });
    await user.click(row('p3'));
    expect(selectedKeys()).toEqual(['p3']);
  });

  it('adds and removes rows with Ctrl, and selects the siblings between two rows with Shift', async () => {
    const { user } = await mountTagged(MAIN, { pageCount: 1 });
    await user.click(row('h1'));
    await user.keyboard('{Control>}');
    await user.click(row('p2'));
    expect(selectedKeys()).toEqual(['h1', 'p2']);
    await user.click(row('h1'));
    expect(selectedKeys()).toEqual(['p2']);
    await user.keyboard('{/Control}');

    await user.click(row('h1'));
    await user.keyboard('{Shift>}');
    await user.click(row('p2'));
    await user.keyboard('{/Shift}');
    expect(selectedKeys()).toEqual(['h1', 'p1', 'p2']);
    expect(screen.getByText('3 elements selected.')).toBeTruthy();

    // Across branches only the siblings of the row clicked are taken: a, b and c are the document's.
    await user.click(row('a'));
    await user.keyboard('{Shift>}');
    await user.click(row('c'));
    await user.keyboard('{/Shift}');
    expect(selectedKeys()).toEqual(['a', 'b', 'c']);
    await user.click(row('h1'));
    await user.keyboard('{Shift>}');
    await user.click(row('b'));
    await user.keyboard('{/Shift}');
    expect(selectedKeys()).toEqual(['b']);
  });

  it('treats Shift as a plain click when nothing is selected', async () => {
    const { user } = await mountTagged(MAIN);
    await user.keyboard('{Shift>}');
    await user.click(row('p2'));
    await user.keyboard('{/Shift}');
    expect(selectedKeys()).toEqual(['p2']);
  });

  it('selects the focused row with Enter or Space, and ignores other keys', async () => {
    const { user } = await mountTagged(MAIN);
    act(() => row('doc').focus());
    await user.keyboard('x');
    expect(selectedKeys()).toEqual([]);
    await user.keyboard('{Enter}');
    expect(selectedKeys()).toEqual(['doc']);
    row('a').focus();
    await user.keyboard(' ');
    expect(selectedKeys()).toEqual(['a']);
  });

  it('keeps one row in the tab order: the selected one, or the first when none is', async () => {
    const { user } = await mountTagged(MAIN);
    expect(row('doc').getAttribute('tabindex')).toBe('0');
    expect(row('a').getAttribute('tabindex')).toBe('-1');
    await user.click(row('a'));
    expect(row('doc').getAttribute('tabindex')).toBe('-1');
    expect(row('a').getAttribute('tabindex')).toBe('0');
  });

  it("scrolls the selected row into view when the page's boxes, not the list, were clicked", async () => {
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      await mountTagged(MAIN);
      expect(scroll).not.toHaveBeenCalled();
      act(() => readingOrderStore.setSelected(['p2']));
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
      expect(scroll.mock.contexts[0]).toBe(row('p2'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('selects nothing for a key the tree does not have', async () => {
    await mountTagged(MAIN);
    act(() => readingOrderStore.setSelected(['gone']));
    expect(screen.getByText(/Select an element to change its type/)).toBeTruthy();
  });
});

describe('TagsView: the keyboard', () => {
  it('moves the selection with the arrows, stopping at the ends', async () => {
    const { user } = await mountTagged(MAIN, { pageCount: 1 });
    await user.click(row('doc'));
    await user.keyboard('{ArrowDown}');
    expect(selectedKeys()).toEqual(['a']);
    await user.keyboard('{ArrowUp}');
    expect(selectedKeys()).toEqual(['doc']);
    await user.keyboard('{ArrowUp}');
    expect(selectedKeys()).toEqual(['doc']);
    await user.click(row('p3'));
    await user.keyboard('{ArrowDown}');
    expect(selectedKeys()).toEqual(['p3']);
  });

  it('does nothing in a tree where nothing is selected', async () => {
    const { user } = await mountTagged(MAIN);
    act(() => row('doc').focus());
    await user.keyboard('{ArrowDown}');
    expect(selectedKeys()).toEqual([]);
  });

  it('folds with ArrowLeft and unfolds with ArrowRight, only where there is something to do', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('a'));
    await user.keyboard('{ArrowRight}');
    expect(row('a').getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowLeft}');
    expect(row('a').getAttribute('aria-expanded')).toBe('false');
    expect(rowKeys()).not.toContain('h1');
    await user.keyboard('{ArrowLeft}');
    expect(row('a').getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{ArrowRight}');
    expect(row('a').getAttribute('aria-expanded')).toBe('true');
    expect(rowKeys()).toContain('h1');

    await user.click(row('h1'));
    await user.keyboard('{ArrowLeft}');
    expect(rowKeys()).toContain('h1');
    expect(row('h1').hasAttribute('aria-expanded')).toBe(false);
  });

  it('moves the element with Alt and the arrows, and not past the ends of its siblings', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p2', 'p1']);
    expect(selectedKeys()).toEqual(['p1']);
    expect(draftText()).toBe('1 change(s) not yet applied.');

    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(draftText()).toBe('1 change(s) not yet applied.');
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p1', 'p2']);
    await user.click(row('h1'));
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p1', 'p2']);
    expect(draftText()).toBe('2 change(s) not yet applied.');
  });

  it('does not move anything with Alt and the arrows when the file cannot be edited', async () => {
    const { user } = await mountTagged(MAIN, { canEdit: false });
    await user.click(row('p1'));
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p1', 'p2']);
    expect(selectedKeys()).toEqual(['p1']);
    expect(draftText()).toBe('No changes yet.');
  });
});

/* ------------------------------------------------------------------ *
 * The toolbar
 * ------------------------------------------------------------------ */

describe('TagsView: the toolbar', () => {
  it('moves the selected element up and down among its siblings', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.click(button('Move up'));
    expect(rowKeys().slice(2, 5)).toEqual(['p1', 'h1', 'p2']);
    await user.click(button('Move down'));
    await user.click(button('Move down'));
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p2', 'p1']);
    expect(draftText()).toBe('3 change(s) not yet applied.');
  });

  it('moves the top-level elements among themselves', async () => {
    const { user } = await mountTagged(
      modelOf(el('x', 'Document', [el('x1', 'P', [mcid(0)])]), el('y', 'Document', [])),
      { pageCount: 1 },
    );
    await user.click(row('x'));
    await user.click(button('Move down'));
    expect(rowKeys()).toEqual(['y', 'x', 'x1']);
  });

  it('moves an element into the previous one and out of its parent again', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('p2'));
    await user.click(button('Move into the previous element'));
    expect(row('p2').getAttribute('aria-level')).toBe('4');
    expect(row('p1').getAttribute('aria-expanded')).toBe('true');
    await user.click(button('Move out of the parent'));
    expect(row('p2').getAttribute('aria-level')).toBe('3');
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p1', 'p2']);
    expect(draftText()).toBe('2 change(s) not yet applied.');
  });

  it('moves an element out of its grandparent to just after the parent', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('h1'));
    await user.click(button('Move out of the parent'));
    expect(rowKeys().slice(1, 6)).toEqual(['a', 'p1', 'p2', 'h1', 'b']);
    expect(row('h1').getAttribute('aria-level')).toBe('2');
  });

  it('disables what the selection cannot do', async () => {
    const { user } = await mountTagged(MAIN);
    for (const name of ['Move up', 'Move down', 'Move out of the parent', 'Move into the previous element']) {
      expect((button(name) as HTMLButtonElement).disabled).toBe(true);
    }
    await user.click(row('h1'));
    expect((button('Move up') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Move into the previous element') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Move down') as HTMLButtonElement).disabled).toBe(false);
    expect((button('Move out of the parent') as HTMLButtonElement).disabled).toBe(false);
    await user.click(row('p2'));
    expect((button('Move down') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Move up') as HTMLButtonElement).disabled).toBe(false);
    // The top element has no parent to leave; a child of it has no grandparent to join.
    await user.click(row('doc'));
    expect((button('Move out of the parent') as HTMLButtonElement).disabled).toBe(true);
    await user.click(row('a'));
    expect((button('Move out of the parent') as HTMLButtonElement).disabled).toBe(true);
    // Two elements selected are not one element to move.
    await user.keyboard('{Control>}');
    await user.click(row('b'));
    await user.keyboard('{/Control}');
    expect((button('Move down') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables every move for an element the writer cannot address, and when the file cannot be edited', async () => {
    const direct = modelOf(
      el('doc', 'Document', [el('d1', 'P', [mcid(0)], { editable: false }), el('d2', 'P', [mcid(1)])]),
    );
    const { user } = await mountTagged(direct, { pageCount: 1 });
    await user.click(row('d1'));
    expect((button('Move down') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Move into the previous element') as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const locked = await mountTagged(MAIN, { canEdit: false });
    await locked.user.click(row('p1'));
    for (const name of ['Move up', 'Move down', 'Move out of the parent', 'Move into the previous element']) {
      expect((button(name) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Dragging
 * ------------------------------------------------------------------ */

describe('TagsView: dragging', () => {
  it('drags a row onto another: into it, before it or after it by where it is dropped', async () => {
    await mountTagged(MAIN);
    const started = startDrag(row('p2'));
    expect(started.data['text/x-tag-key']).toBe('p2');
    expect(started.allowed).toBe('move');

    dragAt('drop', row('h1'), 0, transfer({ 'text/x-tag-key': 'p2' }));
    expect(rowKeys().slice(2, 5)).toEqual(['p2', 'h1', 'p1']);
    dragAt('drop', row('h1'), 1, transfer({ 'text/x-tag-key': 'p2' }));
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p2', 'p1']);
    dragAt('drop', row('p1'), 0.5, transfer({ 'text/x-tag-key': 'h1' }));
    expect(rowKeys().slice(2, 5)).toEqual(['p2', 'p1', 'h1']);
    expect(row('h1').getAttribute('aria-level')).toBe('4');
    expect(draftText()).toBe('3 change(s) not yet applied.');
  });

  it('shows where a drop would land and clears it on leaving or dropping', async () => {
    await mountTagged(MAIN);
    const drag = transfer({ 'text/x-tag-key': 'p2' });
    dragAt('dragOver', row('h1'), 0, drag);
    expect(row('h1').className).toContain('border-t-2');
    dragAt('dragOver', row('h1'), 1, drag);
    expect(row('h1').className).toContain('border-b-2');
    dragAt('dragOver', row('h1'), 0.5, drag);
    expect(row('h1').className).toContain('ring-pdf-accent');
    fireEvent.dragLeave(row('h1'));
    expect(row('h1').className).not.toContain('ring-pdf-accent');
    dragAt('dragOver', row('h1'), 0.5, drag);
    dragAt('drop', row('h1'), 0.5);
    expect(row('h1').className).not.toContain('ring-pdf-accent');
  });

  it('ignores a drop that carries no element or the element itself', async () => {
    await mountTagged(MAIN);
    dragAt('drop', row('h1'), 0);
    dragAt('drop', row('h1'), 0, transfer({ 'text/x-tag-key': 'h1' }));
    expect(draftText()).toBe('No changes yet.');
  });

  it('refuses a drop the document cannot take and says why', async () => {
    const { onNotice } = await mountTagged(MAIN);
    dragAt('drop', row('p1'), 0.5, transfer({ 'text/x-tag-key': 'a' }));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('An element cannot be moved into itself.');
    dragAt('drop', row('p1'), 0.5, transfer({ 'text/x-tag-key': 'nothing' }));
    expect(onNotice).toHaveBeenLastCalledWith('That element no longer exists.');
    expect(draftText()).toBe('No changes yet.');
  });

  it('accepts a refusal without a shell to tell', async () => {
    await mountTagged(MAIN, { onNotice: undefined });
    dragAt('drop', row('p1'), 0.5, transfer({ 'text/x-tag-key': 'a' }));
    expect(draftText()).toBe('No changes yet.');
  });

  it('is not draggable and takes no drop when the file cannot be edited', async () => {
    const direct = modelOf(el('doc', 'Document', [el('d1', 'P', [mcid(0)], { editable: false })]));
    await mountTagged(direct, { pageCount: 1 });
    expect(row('d1').getAttribute('draggable')).toBe('false');
    expect(row('doc').getAttribute('draggable')).toBe('true');
    cleanup();

    await mountTagged(MAIN, { canEdit: false });
    expect(row('h1').getAttribute('draggable')).toBe('false');
    dragAt('dragOver', row('h1'), 0);
    expect(row('h1').className).not.toContain('border-t-2');
  });
});

/* ------------------------------------------------------------------ *
 * The selected element
 * ------------------------------------------------------------------ */

describe('TagsView: the selected element', () => {
  it('asks for a selection first', async () => {
    await mountTagged(MAIN);
    expect(screen.getByText(/Select an element to change its type, description or position/)).toBeTruthy();
  });

  it('retypes the element from the list of types the editor offers', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('p1'));
    expect(typeSelect().value).toBe('P');
    expect(
      within(typeSelect())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toContain('Div');
    await user.selectOptions(typeSelect(), 'H2');
    expect(row('p1').getAttribute('data-tag-role')).toBe('H2');
    expect(draftText()).toBe('1 change(s) not yet applied.');
  });

  it('lists a type the file defines first, unselectable, and a missing type as a question mark', async () => {
    const model = modelOf(
      el('doc', 'Document', [
        el('weird', 'Weird', [mcid(0)], { standard: null }),
        el('blank', '', [mcid(1)], { standard: null }),
      ]),
    );
    const { user } = await mountTagged(model, { pageCount: 1 });
    await user.click(row('weird'));
    const options = within(typeSelect()).getAllByRole('option') as HTMLOptionElement[];
    expect(options[0]?.textContent).toBe('Weird');
    expect(options[0]?.disabled).toBe(true);
    expect(options[1]?.disabled).toBe(false);
    expect(typeSelect().value).toBe('Weird');
    await user.click(row('blank'));
    expect((within(typeSelect()).getAllByRole('option')[0] as HTMLOptionElement).textContent).toBe('?');
  });

  it('marks an element as an artifact, which removes it and its selection', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.click(button('Mark as an artifact: it leaves the reading order'));
    expect(rowKeys()).not.toContain('p1');
    expect(screen.getByText(/Select an element to change its type/)).toBeTruthy();
    expect(draftText()).toBe('1 change(s) not yet applied.');
  });

  it('says why an element cannot become an artifact', async () => {
    const linked = el('link', 'P', [
      { kind: 'content', item: { kind: 'objr', objectNumber: 9, pageIndex: 0, subtype: 'Link' } },
    ]);
    const { user, onNotice } = await mountTagged(modelOf(el('doc', 'Document', [linked])), { pageCount: 1 });
    await user.click(row('link'));
    await user.click(button('Mark as an artifact: it leaves the reading order'));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      'That element holds a link, a field or an annotation and cannot become an artifact.',
    );
    expect(draftText()).toBe('No changes yet.');
  });

  it('locks the controls for an element the writer cannot address, and when the file cannot be edited', async () => {
    const direct = modelOf(el('doc', 'Document', [el('d1', 'Figure', [mcid(0)], { editable: false })]));
    const { user } = await mountTagged(direct, { pageCount: 1 });
    await user.click(row('d1'));
    expect(typeSelect().disabled).toBe(true);
    expect((button('Mark as an artifact: it leaves the reading order') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByPlaceholderText('Alternative text') as HTMLInputElement).disabled).toBe(true);
    expect((button('Group in') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Dissolve') as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const locked = await mountTagged(MAIN, { canEdit: false });
    await locked.user.click(row('p1'));
    expect(typeSelect().disabled).toBe(true);
    expect((button('Group in') as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('combobox', { name: 'Type of the new group' }) as HTMLSelectElement).disabled,
    ).toBe(true);
  });

  it('writes a description for a picture, and offers it as the new text', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('fig'));
    const input = screen.getByPlaceholderText('Alternative text') as HTMLInputElement;
    const set = button('Set') as HTMLButtonElement;
    expect(input.value).toBe('');
    expect(set.disabled).toBe(true);
    await user.type(input, '   ');
    expect(set.disabled).toBe(true);
    await user.type(input, 'Our logo');
    expect(input.value).toBe('   Our logo');
    expect(set.disabled).toBe(false);
    await user.click(set);
    expect(draftText()).toBe('1 change(s) not yet applied.');
    expect(within(row('fig')).queryByText('no alt')).toBeNull();
    expect(within(row('fig')).getByText('Our logo')).toBeTruthy();
    expect((screen.getByPlaceholderText('Alternative text') as HTMLInputElement).value).toBe('Our logo');
    expect((button('Set') as HTMLButtonElement).disabled).toBe(true);
  });

  it('changes an existing description and offers a field for any element that has one', async () => {
    const model = modelOf(
      el('doc', 'Document', [el('para', 'P', [mcid(0)], { alt: 'Note' }), el('para2', 'P', [mcid(1)])]),
    );
    const { user } = await mountTagged(model, { pageCount: 1 });
    await user.click(row('para2'));
    expect(screen.queryByPlaceholderText('Alternative text')).toBeNull();
    await user.click(row('para'));
    const input = screen.getByPlaceholderText('Alternative text') as HTMLInputElement;
    expect(input.value).toBe('Note');
    await user.clear(input);
    expect((button('Set') as HTMLButtonElement).disabled).toBe(true);
    await user.type(input, 'Footnote');
    await user.click(button('Set'));
    expect(within(row('para')).getByText('Footnote')).toBeTruthy();
  });

  it('keeps a typed description for each element while the selection moves between them', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('fig'));
    await user.type(screen.getByPlaceholderText('Alternative text'), 'draft');
    await user.click(row('logo'));
    expect((screen.getByPlaceholderText('Alternative text') as HTMLInputElement).value).toBe('Company logo');
    await user.click(row('fig'));
    expect((screen.getByPlaceholderText('Alternative text') as HTMLInputElement).value).toBe('draft');
  });

  it('sets the scope of a header cell, and clears it', async () => {
    const model = modelOf(
      el('doc', 'Document', [
        el('plain', 'TH', [mcid(0)]),
        el('scoped', 'TH', [mcid(1)], { scope: 'Row' }),
        el('cell', 'TD', [mcid(2)]),
      ]),
    );
    const { user } = await mountTagged(model, { pageCount: 1 });
    await user.click(row('cell'));
    expect(screen.queryByRole('combobox', { name: 'Scope' })).toBeNull();
    await user.click(row('plain'));
    const scope = () => screen.getByRole('combobox', { name: 'Scope' }) as HTMLSelectElement;
    expect(scope().value).toBe('');
    expect(
      within(scope())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Not set', 'Column', 'Row', 'Both']);
    await user.selectOptions(scope(), 'Column');
    expect(scope().value).toBe('Column');
    await user.click(row('scoped'));
    expect(scope().value).toBe('Row');
    await user.selectOptions(scope(), 'Not set');
    expect(scope().value).toBe('');
    expect(draftText()).toBe('2 change(s) not yet applied.');
  });

  it('groups the element in a new element of the chosen type, and dissolves a wrapper', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.click(button('Group in'));
    expect(rowKeys().slice(2, 6)).toEqual(['h1', 'n1', 'p1', 'p2']);
    expect(row('n1').getAttribute('data-tag-role')).toBe('Sect');
    expect(row('p1').getAttribute('aria-level')).toBe('4');

    await user.click(row('p2'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type of the new group' }), 'Div');
    await user.click(button('Group in'));
    expect(row('n2').getAttribute('data-tag-role')).toBe('Div');

    await user.click(row('n1'));
    await user.click(button('Dissolve'));
    expect(rowKeys().slice(2, 6)).toEqual(['h1', 'p1', 'n2', 'p2']);
    expect(draftText()).toBe('3 change(s) not yet applied.');
  });

  it('dissolves only a wrapper of elements, and says why the document element stays', async () => {
    const { user, onNotice } = await mountTagged(MAIN);
    await user.click(row('h1'));
    expect((button('Dissolve') as HTMLButtonElement).disabled).toBe(true);
    await user.click(row('tr'));
    expect((button('Dissolve') as HTMLButtonElement).disabled).toBe(false);
    await user.click(row('th'));
    expect((button('Dissolve') as HTMLButtonElement).disabled).toBe(true);
    await user.click(row('doc'));
    await user.click(button('Dissolve'));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      'The document element cannot be moved, grouped or removed.',
    );
  });
});

describe('TagsView: several elements selected', () => {
  it('groups them in a new element', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('h1'));
    await user.keyboard('{Control>}');
    await user.click(row('p2'));
    await user.keyboard('{/Control}');
    expect(screen.getByText('2 elements selected.')).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type of the new group' }), 'Art');
    await user.click(button('Group in'));
    // The wrapper takes the place of the first member; the others follow it in their own order.
    expect(rowKeys().slice(1, 6)).toEqual(['a', 'n1', 'h1', 'p2', 'p1']);
    expect(row('n1').getAttribute('data-tag-role')).toBe('Art');
  });

  it('makes a list of them: a list, an item and a body for each', async () => {
    const { user } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.keyboard('{Control>}');
    await user.click(row('p2'));
    await user.keyboard('{/Control}');
    await user.click(button('Make list'));
    expect(draftText()).toBe('5 change(s) not yet applied.');
    expect(row('n5').getAttribute('data-tag-role')).toBe('L');
    expect(row('n2').getAttribute('data-tag-role')).toBe('LI');
    expect(row('n1').getAttribute('data-tag-role')).toBe('LBody');
    expect(rowKeys().slice(2, 10)).toEqual(['h1', 'n5', 'n2', 'n1', 'p1', 'n4', 'n3', 'p2']);
  });

  it('says why elements that do not share a parent cannot be grouped', async () => {
    const { user, onNotice } = await mountTagged(MAIN, { pageCount: 1 });
    await user.click(row('h1'));
    await user.keyboard('{Control>}');
    await user.click(row('p3'));
    await user.keyboard('{/Control}');
    await user.click(button('Group in'));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('Only elements with the same parent can be grouped.');
    await user.click(button('Make list'));
    expect(onNotice).toHaveBeenCalledTimes(2);
    expect(draftText()).toBe('No changes yet.');
  });

  it('is locked when the file cannot be edited', async () => {
    const { user } = await mountTagged(MAIN, { canEdit: false });
    await user.click(row('h1'));
    await user.keyboard('{Control>}');
    await user.click(row('p1'));
    await user.keyboard('{/Control}');
    expect((button('Group in') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Make list') as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The draft and Apply
 * ------------------------------------------------------------------ */

describe('TagsView: the draft', () => {
  it('counts the changes, undoes the last, and discards them all', async () => {
    const { user } = await mountTagged(MAIN);
    expect((button('Undo') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Discard') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Apply to document') as HTMLButtonElement).disabled).toBe(true);
    await user.click(row('p1'));
    await user.click(button('Move up'));
    await user.click(button('Move down'));
    await user.selectOptions(typeSelect(), 'H2');
    expect(draftText()).toBe('3 change(s) not yet applied.');
    await user.click(button('Undo'));
    expect(draftText()).toBe('2 change(s) not yet applied.');
    expect(row('p1').getAttribute('data-tag-role')).toBe('P');
    await user.click(button('Discard'));
    expect(draftText()).toBe('No changes yet.');
    expect(rowKeys().slice(2, 5)).toEqual(['h1', 'p1', 'p2']);
  });

  it('keeps the tree of the file when a new read no longer fits the draft', async () => {
    const { user, rerender, props, onNotice } = await mountTagged(MAIN, { pageCount: 1 });
    await user.click(row('p1'));
    await user.selectOptions(typeSelect(), 'H2');
    expect(row('p1').getAttribute('data-tag-role')).toBe('H2');

    const smaller = modelOf(el('doc', 'Document', [el('pic', 'Figure', [mcid(0)])]));
    engine.readStructure.mockResolvedValue({ pageCount: 1, model: smaller });
    rerender(<TagsView {...props} read={async () => BYTES} />);
    await waitFor(() => expect(rowKeys()).toEqual(['doc', 'pic']));
    expect(draftText()).toBe('1 change(s) not yet applied.');

    // The draft's own edit no longer applies, so nothing more is added to it and the text stays typed.
    await user.click(row('pic'));
    await user.type(screen.getByPlaceholderText('Alternative text'), 'Logo');
    await user.click(button('Set'));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('That element no longer exists.');
    expect(draftText()).toBe('1 change(s) not yet applied.');
    expect((screen.getByPlaceholderText('Alternative text') as HTMLInputElement).value).toBe('Logo');
  });
});

describe('TagsView: applying', () => {
  const outcome = {
    bytes: new Uint8Array([9, 9]),
    report: {
      notes: [{ kind: 'changed', key: 'op.note.tags.retagged', params: { count: 1 } }],
      steps: ['tags.write'],
    },
  };

  it('writes the whole draft in one go and hands the produced bytes to the shell', async () => {
    engine.editStructure.mockResolvedValue(outcome);
    const { user, onWritten } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.selectOptions(typeSelect(), 'H2');
    await user.click(row('p2'));
    await user.click(button('Move up'));
    await user.click(button('Apply to document'));
    await waitFor(() => expect(onWritten).toHaveBeenCalledOnce());
    expect(onWritten).toHaveBeenCalledExactlyOnceWith({
      bytes: outcome.bytes,
      notes: outcome.report.notes,
      steps: ['tags.write'],
    });
    expect(engine.editStructure).toHaveBeenCalledExactlyOnceWith(
      BYTES,
      [
        { op: 'role', key: 'p1', role: 'H2' },
        { op: 'move', key: 'p2', parentKey: 'a', index: 1 },
      ],
      { signal: expect.any(AbortSignal) },
    );
  });

  it('holds every control while the write runs, and frees them after', async () => {
    const pending = Promise.withResolvers<typeof outcome>();
    engine.editStructure.mockReturnValue(pending.promise);
    const { user } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.selectOptions(typeSelect(), 'H2');
    await user.click(button('Apply to document'));
    expect((button('Apply to document') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Undo') as HTMLButtonElement).disabled).toBe(true);
    expect((button('Discard') as HTMLButtonElement).disabled).toBe(true);
    expect(typeSelect().disabled).toBe(true);
    await act(async () => pending.resolve(outcome));
    expect((button('Undo') as HTMLButtonElement).disabled).toBe(false);
    expect(typeSelect().disabled).toBe(false);
  });

  it('says what failed, tells the shell, and keeps the draft', async () => {
    engine.editStructure.mockRejectedValue(new ToolError('internal', { engine: 'mupdf' }));
    const { user, onNotice, onWritten } = await mountTagged(MAIN);
    await user.click(row('p1'));
    await user.selectOptions(typeSelect(), 'H2');
    await user.click(button('Apply to document'));
    const failure = new ToolError('internal', { engine: 'mupdf' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
    expect(onWritten).not.toHaveBeenCalled();
    expect(draftText()).toBe('1 change(s) not yet applied.');
    expect((button('Apply to document') as HTMLButtonElement).disabled).toBe(false);
  });

  it('writes and fails without a shell to tell', async () => {
    engine.editStructure.mockResolvedValueOnce(outcome).mockRejectedValueOnce(new Error('boom'));
    const { user } = await mountTagged(MAIN, { onWritten: undefined, onNotice: undefined });
    await user.click(row('p1'));
    await user.selectOptions(typeSelect(), 'H2');
    await user.click(button('Apply to document'));
    await waitFor(() => expect(engine.editStructure).toHaveBeenCalledOnce());
    await waitFor(() => expect((button('Apply to document') as HTMLButtonElement).disabled).toBe(false));
    await user.click(button('Apply to document'));
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('publishes nothing for a view that closed before the write answered', async () => {
    const written = Promise.withResolvers<typeof outcome>();
    const failed = Promise.withResolvers<typeof outcome>();
    engine.editStructure.mockReturnValueOnce(written.promise).mockReturnValueOnce(failed.promise);
    const first = await mountTagged(MAIN);
    await first.user.click(row('p1'));
    await first.user.selectOptions(typeSelect(), 'H2');
    await first.user.click(button('Apply to document'));
    first.unmount();
    await act(async () => written.resolve(outcome));
    expect(first.onWritten).not.toHaveBeenCalled();

    const second = await mountTagged(MAIN);
    await second.user.click(row('p1'));
    await second.user.selectOptions(typeSelect(), 'H2');
    await second.user.click(button('Apply to document'));
    second.unmount();
    await act(async () => failed.reject(new Error('late')));
    expect(second.onNotice).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Opening one element from the PDF/UA view
 * ------------------------------------------------------------------ */

describe('TagsView: opening an element on request', () => {
  const deep = (extra: Partial<StructNode> = {}) =>
    el('doc', 'Document', [
      el('sect', 'Sect', [el('div', 'Div', [el('target', 'P', [mcid(0, 1)], { pageIndex: 1, ...extra })])]),
    ]);

  it('selects the element, shows its whole path, widens the view and goes to its page', async () => {
    const model = { ...modelOf(deep()), nodeCount: 400 };
    readingOrderStore.focusElement('target', 1);
    const { onGoToPage } = await mountTagged(model);
    expect(selectedKeys()).toEqual(['target']);
    expect(rowKeys()).toEqual(['doc', 'sect', 'div', 'target']);
    expect((screen.getByRole('combobox', { name: 'Show' }) as HTMLSelectElement).value).toBe('all');
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(readingOrderStore.snapshot().focus).toBeNull();
  });

  it('does not move the viewer for an element with no page, and selects a key the tree does not have without opening anything', async () => {
    readingOrderStore.focusElement('target', null);
    const first = await mountTagged(modelOf(deep()));
    expect(selectedKeys()).toEqual(['target']);
    expect(first.onGoToPage).not.toHaveBeenCalled();
    first.unmount();

    readingOrderStore.focusElement('absent', 0);
    const second = await mountTagged({ ...modelOf(deep()), nodeCount: 400 });
    expect(selectedKeys()).toEqual(['absent']);
    // Nothing was found to open, so the folded branch stays folded.
    expect(rowKeys()).toEqual(['doc', 'sect', 'div']);
    expect(second.onGoToPage).toHaveBeenCalledExactlyOnceWith(0);
  });
});

/* ------------------------------------------------------------------ *
 * Untagged files
 * ------------------------------------------------------------------ */

const candidate = (id: string, overrides: Partial<TagCandidate> = {}): TagCandidate => ({
  id,
  kind: 'text',
  role: 'P',
  text: id,
  alt: null,
  rect: [0, 0, 10, 10],
  ...overrides,
});

const PAGE_ZERO: TagCandidatePage = {
  pageIndex: 0,
  width: 300,
  height: 400,
  rotation: 0,
  skipped: 2,
  candidates: [
    candidate('b1', { role: 'H1', text: 'Annual report', rect: [10, 10, 50, 20] }),
    candidate('b2', { text: 'Body text', rect: null }),
    candidate('f3', { kind: 'figure', role: 'Figure', text: '', alt: 'A chart', rect: [10, 60, 40, 90] }),
    candidate('f4', { kind: 'figure', role: 'Figure', text: '', rect: [60, 60, 90, 90] }),
    candidate('b5', { role: 'Code', text: 'let x = 1', rect: [10, 100, 60, 110] }),
  ],
};

const NOTE: OperationNote = { kind: 'warning', key: 'op.note.tags.reordered', params: { count: 3 } };

async function mountUntagged(
  pages: readonly TagCandidatePage[] = [PAGE_ZERO],
  options: Partial<TagsViewProps> = {},
  notes: readonly OperationNote[] = [],
) {
  engine.readStructure.mockResolvedValue({ pageCount: 2, model: EMPTY_MODEL });
  engine.readTagCandidates.mockResolvedValue({ pages, notes, bodySize: 12 });
  const onWritten = vi.fn();
  const onNotice = vi.fn();
  const props: TagsViewProps = {
    t,
    read: async () => BYTES,
    language: 'en',
    currentPage: 0,
    canEdit: true,
    onWritten,
    onNotice,
    ...options,
  };
  const view = render(<TagsView {...props} />);
  await screen.findByText('This file has no tags.');
  return { ...view, props, onWritten, onNotice, user: userEvent.setup() };
}

const planRow = (id: string) => document.querySelector(`[data-plan-id="${id}"]`) as HTMLElement;
const planIds = () =>
  [...document.querySelectorAll('[data-plan-id]')].map((entry) => entry.getAttribute('data-plan-id'));
const planType = (id: string) =>
  within(planRow(id)).getByRole('combobox', { name: 'Type' }) as HTMLSelectElement;
const planNumber = (id: string) => planRow(id).querySelector('.tabular-nums')?.textContent;

describe('TagsView: an untagged file', () => {
  it("explains that there are no tags and lists the page's blocks in the order they are drawn", async () => {
    await mountUntagged();
    expect(document.querySelector('[data-tags-mode]')?.getAttribute('data-tags-mode')).toBe('untagged');
    expect(screen.getByText(/A reader falls back on the order the content is drawn in/)).toBeTruthy();
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Content blocks in reading order' })).toBeTruthy();
    expect(planIds()).toEqual(['b1', 'b2', 'f3', 'f4', 'b5']);
    expect(within(planRow('b1')).getByText('Annual report')).toBeTruthy();
    expect(within(planRow('f3')).getByText('[image]')).toBeTruthy();
    expect(['b1', 'b2', 'f3', 'f4', 'b5'].map(planNumber)).toEqual(['1', '2', '3', '4', '5']);
    expect(planType('b1').value).toBe('H1');
    expect(screen.getByText('2 block(s) on this page cannot be tagged.')).toBeTruthy();
    expect(screen.getByText('Language en is written when the file has none.')).toBeTruthy();
  });

  it('offers a role the tagger chose even when the list does not have it', async () => {
    await mountUntagged();
    const options = within(planType('b5')).getAllByRole('option') as HTMLOptionElement[];
    expect(options[0]?.value).toBe('Code');
    expect(planType('b5').value).toBe('Code');
    expect(
      within(planType('b1'))
        .getAllByRole('option')
        .map((option) => option.getAttribute('value')),
    ).not.toContain('Code');
    expect(within(planType('b1')).getByRole('option', { name: 'Artifact' }).getAttribute('value')).toBe(
      'Artifact',
    );
  });

  it('says so for a page with nothing to tag, and lists why pages were left out', async () => {
    await mountUntagged([PAGE_ZERO], { currentPage: 1 }, [NOTE]);
    expect(screen.getByText('Nothing to tag on this page.')).toBeTruthy();
    expect(screen.getByText('3 element(s) moved.')).toBeTruthy();
    expect(screen.queryByText(/cannot be tagged/)).toBeNull();
  });

  it('draws the plan as numbered boxes, without a number for an artifact or a box for a block that has none', async () => {
    const { user } = await mountUntagged();
    expect(readingOrderStore.snapshot().pages).toEqual([
      {
        pageIndex: 0,
        width: 300,
        height: 400,
        rotation: 0,
        items: [
          { key: 'b1', number: 1, role: 'H1', rect: [10, 10, 50, 20] },
          { key: 'f3', number: 3, role: 'Figure', rect: [10, 60, 40, 90] },
          { key: 'f4', number: 4, role: 'Figure', rect: [60, 60, 90, 90] },
          { key: 'b5', number: 5, role: 'Code', rect: [10, 100, 60, 110] },
        ],
      },
    ]);
    await user.selectOptions(planType('b1'), 'Artifact');
    expect(planNumber('b1')).toBe('–');
    expect(planNumber('b2')).toBe('1');
    expect(readingOrderStore.snapshot().pages[0]?.items.map((item) => [item.key, item.number])).toEqual([
      ['f3', 2],
      ['f4', 3],
      ['b5', 4],
    ]);
  });

  it("selects a block from its row, and highlights the one the page's box selected", async () => {
    const { user } = await mountUntagged();
    await user.click(within(planRow('b2')).getByRole('button', { name: 'Body text' }));
    expect(selectedKeys()).toEqual(['b2']);
    expect(
      within(planRow('b2')).getByRole('button', { name: 'Body text' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      within(planRow('b1')).getByRole('button', { name: 'Annual report' }).getAttribute('aria-pressed'),
    ).toBe('false');
    expect(planRow('b2').className).toContain('bg-pdf-accent/15');
  });

  it('moves a block up or down, and not past the ends', async () => {
    const { user } = await mountUntagged();
    const up = (id: string) =>
      within(planRow(id)).getByRole('button', { name: 'Move up' }) as HTMLButtonElement;
    const down = (id: string) =>
      within(planRow(id)).getByRole('button', { name: 'Move down' }) as HTMLButtonElement;
    expect(up('b1').disabled).toBe(true);
    expect(down('b5').disabled).toBe(true);
    expect(up('b2').disabled).toBe(false);
    await user.click(down('b1'));
    expect(planIds()).toEqual(['b2', 'b1', 'f3', 'f4', 'b5']);
    await user.click(up('b5'));
    expect(planIds()).toEqual(['b2', 'b1', 'f3', 'b5', 'f4']);
    expect(planNumber('b1')).toBe('2');
    expect(readingOrderStore.snapshot().pages[0]?.items.map((item) => item.key)).toEqual([
      'b1',
      'f3',
      'b5',
      'f4',
    ]);
  });

  it('describes a picture while it is a figure, and not once it is another type', async () => {
    const { user } = await mountUntagged();
    const alt = (id: string) =>
      within(planRow(id)).queryByPlaceholderText('Alternative text') as HTMLInputElement | null;
    expect(alt('f3')?.value).toBe('A chart');
    expect(alt('f4')?.value).toBe('');
    expect(alt('b1')).toBeNull();
    await user.type(alt('f4') as HTMLInputElement, 'Map');
    expect(alt('f4')?.value).toBe('Map');
    await user.selectOptions(planType('f4'), 'P');
    expect(alt('f4')).toBeNull();
    await user.selectOptions(planType('f4'), 'Figure');
    expect(alt('f4')?.value).toBe('Map');
  });

  it('drops a block before another by dragging its handle, and ignores anything else dropped', async () => {
    await mountUntagged();
    const handle = (id: string) => within(planRow(id)).getAllByRole('button')[0] as HTMLElement;
    const started = startDrag(handle('b5'));
    expect(started.data['text/x-plan-id']).toBe('b5');
    expect(started.allowed).toBe('move');
    const drag = transfer({ 'text/x-plan-id': 'b5' });

    fireEvent.dragOver(planRow('b2'), { dataTransfer: drag });
    expect(planRow('b2').className).toContain('border-t-2');
    fireEvent.dragLeave(planRow('b2'));
    expect(planRow('b2').className).not.toContain('border-t-2');
    fireEvent.dragOver(planRow('b2'), { dataTransfer: drag });
    fireEvent.drop(planRow('b2'), { dataTransfer: drag });
    expect(planIds()).toEqual(['b1', 'b5', 'b2', 'f3', 'f4']);
    expect(planRow('b2').className).not.toContain('border-t-2');

    fireEvent.drop(planRow('f3'), { dataTransfer: transfer({ 'text/x-plan-id': 'f3' }) });
    fireEvent.drop(planRow('f3'), { dataTransfer: transfer() });
    fireEvent.drop(planRow('f3'), { dataTransfer: transfer({ 'text/x-plan-id': 'elsewhere' }) });
    expect(planIds()).toEqual(['b1', 'b5', 'b2', 'f3', 'f4']);
  });

  it('drops the last block before the first', async () => {
    await mountUntagged();
    fireEvent.drop(planRow('b1'), { dataTransfer: transfer({ 'text/x-plan-id': 'f4' }) });
    expect(planIds()).toEqual(['f4', 'b1', 'b2', 'f3', 'b5']);
  });

  it('cannot be dragged into or edited when the file cannot be edited', async () => {
    await mountUntagged([PAGE_ZERO], { canEdit: false });
    const handle = within(planRow('b1')).getAllByRole('button')[0] as HTMLElement;
    expect(handle.getAttribute('draggable')).toBe('false');
    fireEvent.dragOver(planRow('b2'), { dataTransfer: transfer() });
    expect(planRow('b2').className).not.toContain('border-t-2');
    expect(planType('b1').disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Tag document' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot tag a file with no block to claim', async () => {
    await mountUntagged([]);
    expect((screen.getByRole('button', { name: 'Tag document' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Nothing to tag on this page.')).toBeTruthy();
  });
});

describe('TagsView: tagging an untagged file', () => {
  const tagged = {
    bytes: new Uint8Array([4, 4]),
    report: {
      notes: [
        { kind: 'changed', key: 'op.note.tags.grouped', params: { count: 2 } },
      ] satisfies OperationNote[],
      steps: ['tag.write'],
    },
  };
  const cleaned = {
    bytes: new Uint8Array([5, 5]),
    report: {
      notes: [
        { kind: 'preserved', key: 'op.note.tags.reordered', params: { count: 9 } },
        { kind: 'changed', key: 'op.note.tags.retagged', params: { count: 1 } },
      ] satisfies OperationNote[],
      steps: ['ua.artifact-paths', 'internal.step'],
    },
  };

  it('tags the document with the plan, then marks drawn lines as artifacts, and hands the result to the shell', async () => {
    engine.tagDocument.mockResolvedValue(tagged);
    engine.fixPdfUa.mockResolvedValue(cleaned);
    const { user, onWritten } = await mountUntagged();
    await user.selectOptions(planType('b2'), 'H2');
    await user.click(within(planRow('b2')).getByRole('button', { name: 'Move up' }));
    await user.type(within(planRow('f4')).getByPlaceholderText('Alternative text'), 'Map');
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    await waitFor(() => expect(onWritten).toHaveBeenCalledOnce());

    expect(engine.tagDocument).toHaveBeenCalledExactlyOnceWith(
      BYTES,
      { signal: expect.any(AbortSignal) },
      {
        language: 'en',
        plan: {
          pages: {
            0: {
              order: ['b2', 'b1', 'f3', 'f4', 'b5'],
              roles: { b1: 'H1', b2: 'H2', f3: 'Figure', f4: 'Figure', b5: 'Code' },
              alts: { f3: 'A chart', f4: 'Map' },
            },
          },
        },
      },
    );
    expect(engine.fixPdfUa).toHaveBeenCalledExactlyOnceWith(tagged.bytes, [{ kind: 'artifact-paths' }], {
      signal: expect.any(AbortSignal),
    });
    expect(onWritten).toHaveBeenCalledExactlyOnceWith({
      bytes: cleaned.bytes,
      notes: [tagged.report.notes[0], cleaned.report.notes[1]],
      steps: ['tag.write', 'ua.artifact-paths'],
    });
  });

  it('leaves the drawn lines alone when asked to, and when tagging changed nothing', async () => {
    engine.tagDocument
      .mockResolvedValueOnce(tagged)
      .mockResolvedValueOnce({ bytes: BYTES, report: { notes: [], steps: [] } });
    const { user, onWritten } = await mountUntagged();
    const checkbox = screen.getByRole('checkbox', {
      name: 'Mark drawn lines and backgrounds as artifacts',
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    await waitFor(() => expect(onWritten).toHaveBeenCalledOnce());
    expect(onWritten).toHaveBeenLastCalledWith({
      bytes: tagged.bytes,
      notes: tagged.report.notes,
      steps: ['tag.write'],
    });

    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(2));
    expect(onWritten).toHaveBeenLastCalledWith({ bytes: BYTES, notes: [], steps: [] });
    expect(engine.fixPdfUa).not.toHaveBeenCalled();
  });

  it('holds the controls while the file is tagged', async () => {
    const pending = Promise.withResolvers<typeof tagged>();
    engine.tagDocument.mockReturnValue(pending.promise);
    engine.fixPdfUa.mockResolvedValue(cleaned);
    const { user } = await mountUntagged();
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    expect((screen.getByRole('button', { name: 'Tag document' }) as HTMLButtonElement).disabled).toBe(true);
    expect(planType('b1').disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(within(planRow('b2')).getByRole('button', { name: 'Move up' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(planRow('f4')).getByPlaceholderText('Alternative text').hasAttribute('disabled')).toBe(
      true,
    );
    await act(async () => pending.resolve(tagged));
    expect((screen.getByRole('button', { name: 'Tag document' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says what failed and tells the shell', async () => {
    engine.tagDocument.mockRejectedValue(new ToolError('internal', { engine: 'mupdf' }));
    const { user, onNotice, onWritten } = await mountUntagged();
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    const failure = new ToolError('internal', { engine: 'mupdf' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
    expect(onWritten).not.toHaveBeenCalled();
  });

  it('writes and fails without a shell to tell', async () => {
    engine.tagDocument.mockResolvedValueOnce(tagged).mockRejectedValueOnce(new Error('boom'));
    engine.fixPdfUa.mockResolvedValue(cleaned);
    const { user } = await mountUntagged([PAGE_ZERO], { onWritten: undefined, onNotice: undefined });
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    await waitFor(() => expect(engine.fixPdfUa).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Tag document' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('publishes nothing for a view that closed before the answer', async () => {
    const written = Promise.withResolvers<typeof tagged>();
    const failed = Promise.withResolvers<typeof tagged>();
    engine.tagDocument.mockReturnValueOnce(written.promise).mockReturnValueOnce(failed.promise);
    engine.fixPdfUa.mockResolvedValue(cleaned);
    const first = await mountUntagged();
    await first.user.click(screen.getByRole('button', { name: 'Tag document' }));
    first.unmount();
    await act(async () => written.resolve(tagged));
    expect(first.onWritten).not.toHaveBeenCalled();

    const second = await mountUntagged();
    await second.user.click(screen.getByRole('button', { name: 'Tag document' }));
    second.unmount();
    await act(async () => failed.reject(new Error('late')));
    expect(second.onNotice).not.toHaveBeenCalled();
  });
});
