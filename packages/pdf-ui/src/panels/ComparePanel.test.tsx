// @vitest-environment happy-dom
/**
 * The comparison panel: pick a second document, run the text or the pixel comparison, and
 * read one table row per page and method with the method named on the row. Bounds, page-count
 * differences and failures are stated, a cancelled or superseded run never lands, and nothing
 * is compared until the reader asks. The comparison engine has its own suite against real
 * documents, so it answers here with the results its contract describes.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type * as CompareModule from 'pdf-core/ops/compare';
import type {
  CompareCanvas,
  CompareVisualOptions,
  TextComparison,
  TextPageComparison,
  VisualComparison,
  VisualPageComparison,
} from 'pdf-core/ops/compare';
import type { OperationContext } from 'pdf-core/ops/types';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparePanel, type ComparePanelProps } from './ComparePanel';

const { compareText, compareVisual } = vi.hoisted(() => ({ compareText: vi.fn(), compareVisual: vi.fn() }));
vi.mock('pdf-core/ops/compare', async (importOriginal) => ({
  ...(await importOriginal<typeof CompareModule>()),
  compareText,
  compareVisual,
}));

const t = createTranslator('en');
const LEFT = new Uint8Array([1, 1, 1]);
const RIGHT = new Uint8Array([2, 2]);

beforeEach(() => {
  compareText.mockReset();
  compareVisual.mockReset();
});
afterEach(cleanup);

const textPage = (pageIndex: number, overrides: Partial<TextPageComparison> = {}): TextPageComparison => ({
  pageIndex,
  status: 'identical',
  leftLines: 4,
  rightLines: 4,
  added: 0,
  removed: 0,
  changed: 0,
  lines: [],
  truncated: false,
  reasons: [],
  ...overrides,
});

const textResult = (
  pages: readonly TextPageComparison[],
  overrides: Partial<TextComparison> = {},
): TextComparison => ({
  method: 'text',
  leftPageCount: pages.length,
  rightPageCount: pages.length,
  pageCountDelta: 0,
  pages,
  summary: {
    pagesCompared: pages.length,
    identicalPages: 0,
    changedPages: 0,
    addedPages: 0,
    removedPages: 0,
    addedLines: 0,
    removedLines: 0,
    changedLines: 0,
  },
  truncated: false,
  truncationReasons: [],
  ...overrides,
});

const visualPage = (
  pageIndex: number,
  overrides: Partial<VisualPageComparison> = {},
): VisualPageComparison => ({
  pageIndex,
  status: 'identical',
  differencePercent: 0,
  differingPixels: 0,
  totalPixels: 100,
  meanDifference: 0,
  differingTiles: 0,
  tileCount: 16,
  tiles: { columns: 4, rows: 4 },
  leftSize: { width: 10, height: 10 },
  rightSize: { width: 10, height: 10 },
  ...overrides,
});

const visualResult = (
  pages: readonly VisualPageComparison[],
  overrides: Partial<VisualComparison> = {},
): VisualComparison => ({
  method: 'pixels',
  dpi: 40,
  thresholdPercent: 0.5,
  leftPageCount: pages.length,
  rightPageCount: pages.length,
  pageCountDelta: 0,
  pages,
  summary: {
    pagesCompared: pages.length,
    identicalPages: 0,
    changedPages: 0,
    addedPages: 0,
    removedPages: 0,
    unavailablePages: 0,
    meanDifferencePercent: 0,
  },
  truncated: false,
  truncationReasons: [],
  ...overrides,
});

function show(props: Partial<ComparePanelProps> = {}) {
  const readDocument = vi.fn(async () => LEFT);
  const onNotice = vi.fn();
  const view = render(<ComparePanel t={t} readDocument={readDocument} onNotice={onNotice} {...props} />);
  return { readDocument, onNotice, user: userEvent.setup(), ...view };
}

const pickerOf = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;

/** Picks `other.pdf` (the bytes `RIGHT`) through the file input. */
async function pick(user: UserEvent, container: HTMLElement, name = 'other.pdf') {
  await user.upload(pickerOf(container), new File([RIGHT], name, { type: 'application/pdf' }));
  await screen.findByText(`Selected: ${name}`);
}

const run = (user: UserEvent, method: 'text' | 'pixels') =>
  user.click(screen.getByRole('button', { name: method === 'text' ? 'Compare text' : 'Compare pixels' }));

const rowOf = (method: string, page: number) =>
  document.querySelector(`tr[data-compare-row="${method}:${page}"]`) as HTMLElement;

const cellsOf = (row: HTMLElement) => [...row.children].map((cell) => cell.textContent);

/** The progress callback and the signal the panel handed the comparison. */
const contextOf = (mock: typeof compareText): OperationContext => mock.mock.calls[0]?.[2] as OperationContext;

describe('ComparePanel before a document is picked', () => {
  it('asks for a second document and runs nothing', () => {
    show();
    expect(screen.getByText('Select a second PDF to compare.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare text' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Compare pixels' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Select second document' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('cannot pick a document while the host is not taking work', () => {
    show({ disabled: true });
    expect(screen.getByRole('button', { name: 'Select second document' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('opens the file picker from the button', async () => {
    const { user, container } = show();
    const opened = vi.fn();
    pickerOf(container).addEventListener('click', opened);
    await user.click(screen.getByRole('button', { name: 'Select second document' }));
    expect(opened).toHaveBeenCalledOnce();
  });
});

describe('ComparePanel picking the other document', () => {
  it('names the picked file and enables both comparisons, until the host stops taking work', async () => {
    const { user, container, rerender, readDocument } = show();
    await pick(user, container);
    expect(screen.getByText('Selected: other.pdf').getAttribute('title')).toBe('other.pdf');
    expect(screen.getByText('No results yet: run Compare text or Compare pixels.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare text' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Compare pixels' }).hasAttribute('disabled')).toBe(false);
    expect(readDocument).not.toHaveBeenCalled();

    rerender(<ComparePanel t={t} readDocument={readDocument} disabled />);
    expect(screen.getByRole('button', { name: 'Compare text' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Compare pixels' }).hasAttribute('disabled')).toBe(true);
  });

  it('ignores a picker that closed without a file', () => {
    const { container } = show();
    fireEvent.change(pickerOf(container), { target: { files: [] } });
    expect(screen.getByText('Select a second PDF to compare.')).toBeTruthy();
  });

  it('clears the earlier results when another document is picked', async () => {
    compareText.mockResolvedValue(textResult([textPage(0)]));
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');
    await screen.findByRole('table');

    await pick(user, container, 'third.pdf');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No results yet: run Compare text or Compare pixels.')).toBeTruthy();
  });
});

describe('ComparePanel text comparison', () => {
  it('compares the open document with the picked bytes and names the method on every row', async () => {
    compareText.mockResolvedValue(
      textResult(
        [
          textPage(0),
          textPage(1, { status: 'changed', changed: 2, added: 1, removed: 3, truncated: true }),
          textPage(2, { status: 'added', added: 5 }),
        ],
        { rightPageCount: 3, leftPageCount: 2, pageCountDelta: 1 },
      ),
    );
    const { user, container, readDocument } = show();
    await pick(user, container);
    await run(user, 'text');
    await screen.findByRole('table', { name: 'Page-by-page comparison results' });

    expect(readDocument).toHaveBeenCalledOnce();
    expect(compareText).toHaveBeenCalledExactlyOnceWith(
      LEFT,
      RIGHT,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(cellsOf(rowOf('text', 1))).toEqual(['1', 'Text', 'Identical', 'No changes', 'Jump']);
    expect(cellsOf(rowOf('text', 2)).slice(0, 4)).toEqual([
      '2',
      'Text',
      'Changed',
      '2 changed, 1 added, 3 deleted line(s) *',
    ]);
    expect(cellsOf(rowOf('text', 3)).slice(0, 4)).toEqual([
      '3',
      'Text',
      'Added',
      '0 changed, 5 added, 0 deleted line(s)',
    ]);
    expect(screen.getByText('Page count: 2 → 3')).toBeTruthy();
    expect(screen.getByText('Page count difference: 1')).toBeTruthy();
    expect(screen.getByText('* detail for this row was capped')).toBeTruthy();
  });

  it('states no page-count difference and no cap when there is none', async () => {
    compareText.mockResolvedValue(textResult([textPage(0)]));
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');
    await screen.findByRole('table');
    expect(screen.getByText('Page count: 1 → 1')).toBeTruthy();
    expect(screen.queryByText(/Page count difference/)).toBeNull();
    expect(screen.queryByText(/Comparison capped/)).toBeNull();
  });

  it('states the bounds the comparison hit, in words', async () => {
    compareText.mockResolvedValue(
      textResult([textPage(0, { status: 'changed', changed: 1 })], {
        truncated: true,
        truncationReasons: ['line-matrix', 'word-matrix', 'line-list'],
      }),
    );
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');
    expect(
      await screen.findByText('Comparison capped: line matrix cap, word matrix cap, line list cap'),
    ).toBeTruthy();
  });

  it('jumps to the page of a row, and only to pages the open document has', async () => {
    compareText.mockResolvedValue(
      textResult([textPage(0), textPage(1, { status: 'added', added: 1 })], {
        leftPageCount: 1,
        rightPageCount: 2,
        pageCountDelta: 1,
      }),
    );
    const onGoToPage = vi.fn();
    const { user, container } = show({ onGoToPage });
    await pick(user, container);
    await run(user, 'text');
    await screen.findByRole('table');

    const first = within(rowOf('text', 1)).getByRole('button', { name: 'Jump' });
    const second = within(rowOf('text', 2)).getByRole('button', { name: 'Jump' });
    expect(second.hasAttribute('disabled')).toBe(true);
    await user.click(first);
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('cannot jump anywhere when the shell gives no way to', async () => {
    compareText.mockResolvedValue(textResult([textPage(0)]));
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');
    await screen.findByRole('table');
    expect(within(rowOf('text', 1)).getByRole('button', { name: 'Jump' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});

describe('ComparePanel pixel comparison', () => {
  it('states the dpi, the difference, the tiles and what could not be compared, per page', async () => {
    compareVisual.mockResolvedValue(
      visualResult(
        [
          visualPage(0, { status: 'changed', differencePercent: 12.5, differingTiles: 3 }),
          visualPage(1, {
            status: 'changed',
            differencePercent: 3,
            differingTiles: 4,
            reason: 'page-size-mismatch',
          }),
          visualPage(2, { status: 'added' }),
          visualPage(3, { status: 'removed' }),
          visualPage(4, { status: 'unavailable', reason: 'page-too-large' }),
          visualPage(5),
        ],
        { truncated: true, truncationReasons: ['raster-cap'] },
      ),
    );
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'pixels');
    await screen.findByRole('table');

    expect(cellsOf(rowOf('pixels', 1)).slice(0, 4)).toEqual([
      '1',
      'Pixel diff (40 dpi)',
      'Changed',
      '12.50% · 3/16',
    ]);
    expect(cellsOf(rowOf('pixels', 2)).slice(0, 4)).toEqual([
      '2',
      'Pixel diff (40 dpi)',
      'Changed',
      '3.00% · 4/16 · different page sizes',
    ]);
    expect(cellsOf(rowOf('pixels', 3)).slice(2, 4)).toEqual(['Added', 'Page exists in only one document']);
    expect(cellsOf(rowOf('pixels', 4)).slice(2, 4)).toEqual(['Deleted', 'Page exists in only one document']);
    expect(cellsOf(rowOf('pixels', 5)).slice(2, 4)).toEqual([
      'Could not compare',
      'page exceeds pixel limit *',
    ]);
    expect(cellsOf(rowOf('pixels', 6)).slice(2, 4)).toEqual(['Identical', '0.00% · 0/16']);
    expect(screen.getByText('Comparison capped: pixel raster cap')).toBeTruthy();
  });

  it('gives the renderer a fresh canvas for every page it asks for', async () => {
    let created: unknown[] = [];
    compareVisual.mockImplementation(
      async (
        _left: Uint8Array,
        _right: Uint8Array,
        _context: OperationContext,
        options: CompareVisualOptions,
      ) => {
        created = [options.createCanvas(), options.createCanvas()];
        return visualResult([visualPage(0)]);
      },
    );
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'pixels');
    await screen.findByRole('table');

    expect(compareVisual).toHaveBeenCalledExactlyOnceWith(
      LEFT,
      RIGHT,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({ createCanvas: expect.any(Function) }),
    );
    const [first, second] = created as CompareCanvas[];
    expect(first).toBeInstanceOf(HTMLCanvasElement);
    expect(second).toBeInstanceOf(HTMLCanvasElement);
    expect(first).not.toBe(second);
  });
});

describe('ComparePanel both methods', () => {
  it('lists both methods in one table, by page and then by method, with the bounds of both', async () => {
    compareText.mockResolvedValue(
      textResult([textPage(0), textPage(1)], {
        truncated: true,
        truncationReasons: ['line-list', 'line-matrix'],
      }),
    );
    compareVisual.mockResolvedValue(
      visualResult([visualPage(0), visualPage(1)], {
        truncated: true,
        truncationReasons: ['line-matrix', 'raster-cap'],
      }),
    );
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');
    await screen.findByRole('table');
    await run(user, 'pixels');
    await vi.waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(5));

    const order = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.getAttribute('data-compare-row'));
    expect(order).toEqual(['pixels:1', 'text:1', 'pixels:2', 'text:2']);
    expect(
      screen.getByText('Comparison capped: line list cap, line matrix cap, pixel raster cap'),
    ).toBeTruthy();
    // The page counts come from the text run, the first one to answer.
    expect(screen.getByText('Page count: 2 → 2')).toBeTruthy();
  });
});

describe('ComparePanel while comparing', () => {
  it('disables the controls, says it is comparing, and shows the work done so far', async () => {
    const pending = Promise.withResolvers<TextComparison>();
    compareText.mockReturnValue(pending.promise);
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');

    expect(await screen.findByText('Comparing…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare text' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Compare pixels' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Select second document' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();

    const { onProgress } = contextOf(compareText);
    await vi.waitFor(() => expect(onProgress).toBeDefined());
    act(() => onProgress?.({ phase: 'text', labelKey: 'compare.running', done: 2, total: 5 }));
    expect(screen.getByText('Comparing… (2/5)')).toBeTruthy();
    act(() => onProgress?.({ phase: 'text', labelKey: 'compare.running' }));
    expect(screen.getByText('Comparing… (0/0)')).toBeTruthy();

    await act(async () => pending.resolve(textResult([textPage(0)])));
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Compare text' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('Comparing… (0/0)')).toBeNull();
  });

  it('keeps the earlier table while a second comparison runs', async () => {
    compareText.mockResolvedValueOnce(textResult([textPage(0)]));
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');
    await screen.findByRole('table');

    compareText.mockReturnValueOnce(Promise.withResolvers<TextComparison>().promise);
    await run(user, 'text');
    await vi.waitFor(() => expect(compareText).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByText('Comparing…')).toBeNull();
  });
});

describe('ComparePanel cancelling', () => {
  const startText = async (readDocument?: ComparePanelProps['readDocument']) => {
    const shown = show(readDocument === undefined ? {} : { readDocument });
    await pick(shown.user, shown.container);
    await run(shown.user, 'text');
    await screen.findByRole('button', { name: 'Cancel' });
    return shown;
  };

  it('stops the run and says there is no result, and a late progress report is ignored', async () => {
    compareText.mockReturnValue(Promise.withResolvers<TextComparison>().promise);
    const { user } = await startText();
    await vi.waitFor(() => expect(compareText).toHaveBeenCalledOnce());
    const context = contextOf(compareText);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(context.signal.aborted).toBe(true);
    expect(screen.getByText('No results yet: run Compare text or Compare pixels.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

    act(() => context.onProgress?.({ phase: 'text', labelKey: 'compare.running', done: 1, total: 2 }));
    expect(screen.queryByText('Comparing… (1/2)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Compare text' }).hasAttribute('disabled')).toBe(false);
  });

  it('never compares a document whose bytes arrive after the cancel', async () => {
    const bytes = Promise.withResolvers<Uint8Array>();
    const { user } = await startText(() => bytes.promise);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => bytes.resolve(LEFT));
    expect(compareText).not.toHaveBeenCalled();
    expect(screen.getByText('No results yet: run Compare text or Compare pixels.')).toBeTruthy();
  });

  it('drops a text result that arrives after the cancel', async () => {
    const pending = Promise.withResolvers<TextComparison>();
    compareText.mockReturnValue(pending.promise);
    const { user } = await startText();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => pending.resolve(textResult([textPage(0)])));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('No results yet: run Compare text or Compare pixels.')).toBeTruthy();
  });

  it('drops a pixel result that arrives after the cancel', async () => {
    const pending = Promise.withResolvers<VisualComparison>();
    compareVisual.mockReturnValue(pending.promise);
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'pixels');
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await act(async () => pending.resolve(visualResult([visualPage(0)])));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('does not report the failure of a run that was cancelled', async () => {
    const pending = Promise.withResolvers<TextComparison>();
    compareText.mockReturnValue(pending.promise);
    const { user, onNotice } = await startText();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => pending.reject(new DOMException('aborted', 'AbortError')));
    expect(onNotice).not.toHaveBeenCalled();
    expect(screen.queryByText(t('error.aborted.message'))).toBeNull();
  });

  it('aborts a comparison still running when the panel goes away', async () => {
    compareText.mockReturnValue(Promise.withResolvers<TextComparison>().promise);
    const { unmount } = await startText();
    await vi.waitFor(() => expect(compareText).toHaveBeenCalledOnce());
    const { signal } = contextOf(compareText);
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('does not report a failure that arrives once the panel is gone', async () => {
    const pending = Promise.withResolvers<TextComparison>();
    compareText.mockReturnValue(pending.promise);
    const { unmount, onNotice } = await startText();
    await vi.waitFor(() => expect(compareText).toHaveBeenCalledOnce());
    unmount();
    pending.reject(new Error('late'));
    await sleep(0);
    expect(onNotice).not.toHaveBeenCalled();
  });
});

describe('ComparePanel failures', () => {
  it('says what went wrong with its hint, keeps the engine message for diagnostics, and tells the shell', async () => {
    const error = new ToolError('corrupt-document', { engine: 'pdfjs', engineMessage: 'bad xref' });
    compareText.mockRejectedValue(error);
    const { user, container, onNotice } = show();
    await pick(user, container);
    await run(user, 'text');

    const message = t('error.corrupt-document.message');
    const failure = await screen.findByText(`${message} ${t('error.corrupt-document.hint')}`);
    expect(failure.getAttribute('data-compare-failure')).toBe('bad xref');
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(message);
    expect(screen.getByText('No results yet: run Compare text or Compare pixels.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare text' }).hasAttribute('disabled')).toBe(false);
  });

  it('reports a failure of the open document without an engine message, and without a notice line', async () => {
    const { user, container } = show({
      readDocument: async () => {
        throw new ToolError('unsupported', { engine: 'ui' });
      },
      onNotice: undefined,
    });
    await pick(user, container);
    await run(user, 'pixels');

    const failure = await screen.findByText(
      `${t('error.unsupported.message')} ${t('error.unsupported.hint')}`,
    );
    expect(failure.getAttribute('data-compare-failure')).toBe('');
    expect(compareVisual).not.toHaveBeenCalled();
  });

  it('clears the failure when the next comparison starts', async () => {
    compareText.mockRejectedValueOnce(new ToolError('unsupported', { engine: 'pdfjs' }));
    const { user, container } = show();
    await pick(user, container);
    await run(user, 'text');
    await screen.findByText(`${t('error.unsupported.message')} ${t('error.unsupported.hint')}`);

    compareText.mockResolvedValueOnce(textResult([textPage(0)]));
    await run(user, 'text');
    await screen.findByRole('table');
    expect(screen.queryByText(t('error.unsupported.message'), { exact: false })).toBeNull();
  });
});
