// @vitest-environment happy-dom
/**
 * The search results panel: the matches of the typed query, page by page, with the hit
 * emphasised inside its snippet; a click goes to the page first and only then asks the viewer
 * to highlight the query. Searches are debounced, remembered for the last few queries, and an
 * answer for a query that is no longer the typed one never replaces the current list. The scan
 * itself has its own suite, so it answers here with the matches its contract describes.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle, PdfSearchMatch } from 'pdf-core';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchResultsPanel, type SearchResultsPanelProps } from './SearchResultsPanel';

const { searchPdfText } = vi.hoisted(() => ({ searchPdfText: vi.fn() }));
vi.mock('pdf-core', () => ({ searchPdfText }));

const t = createTranslator('en');
const DOCUMENT = { name: 'doc' } as unknown as PdfDocumentHandle;

beforeEach(() => {
  searchPdfText.mockReset();
});
afterEach(cleanup);

const match = (pageIndex: number, overrides: Partial<PdfSearchMatch> = {}): PdfSearchMatch => ({
  pageIndex,
  index: 10,
  length: 5,
  snippet: 'the quick fox',
  snippetOffset: 4,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function show(props: Partial<SearchResultsPanelProps> = {}) {
  const onGoToPage = vi.fn();
  const view = render(
    <SearchResultsPanel document={DOCUMENT} t={t} currentPage={0} onGoToPage={onGoToPage} {...props} />,
  );
  return { onGoToPage, ...view, user: userEvent.setup() };
}

const box = () => screen.getByRole('textbox', { name: 'Find in document' });

describe('SearchResultsPanel', () => {
  it('asks for a query before it searches anything', () => {
    show();
    expect(screen.getByText('No matches.')).toBeTruthy();
    expect(searchPdfText).not.toHaveBeenCalled();
  });

  it('lists the matches of a query with the hit emphasised and the current page marked', async () => {
    searchPdfText.mockResolvedValue([
      match(0),
      match(2, { snippet: 'a fox jumps', snippetOffset: 2, length: 3 }),
    ]);
    const { user } = show({ currentPage: 2 });
    await user.type(box(), '  fox{Enter}');

    const list = await screen.findByRole('list', { name: 'Results' });
    expect(searchPdfText).toHaveBeenCalledExactlyOnceWith(DOCUMENT, 'fox', {
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByText('2 matches')).toBeTruthy();
    const rows = within(list).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual(['1the quick fox', '3a fox jumps']);
    expect(rows.map((row) => row.getAttribute('title'))).toEqual(['Go to page 1', 'Go to page 3']);
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'page']);
    expect(rows[0]?.querySelector('span > span')?.textContent).toBe('quick');
    expect(rows[1]?.querySelector('span > span')?.textContent).toBe('fox');
  });

  it('shows the searching state until the scan answers', async () => {
    const pending = deferred<PdfSearchMatch[]>();
    searchPdfText.mockReturnValue(pending.promise);
    const { user, container } = show();
    await user.type(box(), 'fox{Enter}');

    expect(await screen.findByText('Searching…')).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    pending.resolve([match(0)]);
    expect(await screen.findByText('1 matches')).toBeTruthy();
  });

  it('goes to the page first and only then asks the viewer to highlight the query', async () => {
    searchPdfText.mockResolvedValue([match(1)]);
    const calls: string[] = [];
    const onHighlightQuery = vi.fn((query: string) => calls.push(`highlight ${query}`));
    const { user, onGoToPage } = show({ onHighlightQuery });
    onGoToPage.mockImplementation((page: number) => calls.push(`go ${page}`));
    await user.type(box(), 'fox{Enter}');

    await user.click(await screen.findByRole('button', { name: /the quick fox/ }));
    expect(calls).toEqual(['go 1', 'highlight fox']);
  });

  it('goes to the page when the shell has no find layer to highlight with', async () => {
    searchPdfText.mockResolvedValue([match(3)]);
    const { user, onGoToPage } = show();
    await user.type(box(), 'fox{Enter}');
    await user.click(await screen.findByRole('button', { name: /the quick fox/ }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('searches the settled query without Enter once typing pauses', async () => {
    searchPdfText.mockResolvedValue([match(0)]);
    const { user } = show();
    await user.type(box(), 'fox');
    expect(searchPdfText).not.toHaveBeenCalled();
    await waitFor(() => expect(searchPdfText).toHaveBeenCalledOnce());
    expect(searchPdfText.mock.calls[0]?.[1]).toBe('fox');
    expect(await screen.findByText('1 matches')).toBeTruthy();
  });

  it('says there are no matches, and empties the list when the query is cleared', async () => {
    searchPdfText.mockResolvedValue([]);
    const { user } = show();
    await user.type(box(), 'zzz{Enter}');
    expect(await screen.findByText('0 matches')).toBeTruthy();
    expect(screen.getByText('No matches.')).toBeTruthy();

    await user.clear(box());
    await user.keyboard('{Enter}');
    expect(screen.queryByText('0 matches')).toBeNull();
    expect(screen.getByText('No matches.')).toBeTruthy();
  });

  it('ignores keys other than Enter until the typing pause settles the query', async () => {
    searchPdfText.mockResolvedValue([match(0)]);
    const { user } = show();
    await user.type(box(), 'fo{ArrowLeft}');
    expect(searchPdfText).not.toHaveBeenCalled();
    await waitFor(() => expect(searchPdfText).toHaveBeenCalledOnce());
  });

  it('answers a repeated query from memory and forgets the oldest once five are kept', async () => {
    searchPdfText.mockImplementation(async (_doc: unknown, query: string) => [
      match(0, { snippet: `hit ${query}`, snippetOffset: 4, length: query.length }),
    ]);
    const { user } = show();
    const search = async (query: string) => {
      await user.clear(box());
      await user.type(box(), `${query}{Enter}`);
      await screen.findByRole('button', { name: new RegExp(`hit ${query}$`) });
    };

    for (const query of ['a', 'b', 'c', 'd']) await search(query);
    expect(searchPdfText).toHaveBeenCalledTimes(4);
    await search('a');
    expect(searchPdfText).toHaveBeenCalledTimes(4);

    await search('e');
    expect(searchPdfText).toHaveBeenCalledTimes(5);
    // 'a' was the oldest kept query, so it is searched again — and that evicts 'b' in turn.
    await search('a');
    expect(searchPdfText).toHaveBeenCalledTimes(6);
    await search('e');
    expect(searchPdfText).toHaveBeenCalledTimes(6);
    await search('b');
    expect(searchPdfText).toHaveBeenCalledTimes(7);
  });

  it('says what failed and tells the shell when the scan fails', async () => {
    searchPdfText.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    const { user } = show({ onNotice });
    await user.type(box(), 'fox{Enter}');

    const failure = new ToolError('internal', { engine: 'pdfjs' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
  });

  it('shows a failure even when the shell takes no notices', async () => {
    searchPdfText.mockImplementation(async () => {
      throw new Error('boom');
    });
    const { user } = show();
    await user.type(box(), 'fox{Enter}');
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('keeps the current query list when an answer for an earlier query arrives late', async () => {
    const first = deferred<PdfSearchMatch[]>();
    searchPdfText
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([match(0, { snippet: 'current hit', snippetOffset: 0, length: 7 })]);
    const { user } = show();
    await user.type(box(), 'old{Enter}');
    await screen.findByText('Searching…');
    await user.clear(box());
    await user.type(box(), 'new{Enter}');
    expect(await screen.findByRole('button', { name: /current hit/ })).toBeTruthy();

    await act(async () => {
      first.resolve([match(0, { snippet: 'stale hit', snippetOffset: 0, length: 5 })]);
      await first.promise;
    });
    expect(screen.queryByRole('button', { name: /stale hit/ })).toBeNull();
    expect(screen.getByRole('button', { name: /current hit/ })).toBeTruthy();
  });

  it('does not report a failure of an earlier query once another is being searched', async () => {
    const first = deferred<PdfSearchMatch[]>();
    searchPdfText
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([match(0, { snippet: 'current hit', snippetOffset: 0, length: 7 })]);
    const onNotice = vi.fn();
    const { user } = show({ onNotice });
    await user.type(box(), 'old{Enter}');
    await screen.findByText('Searching…');
    await user.clear(box());
    await user.type(box(), 'new{Enter}');
    expect(await screen.findByRole('button', { name: /current hit/ })).toBeTruthy();

    await act(async () => {
      first.reject(new Error('late failure'));
      await first.promise.catch(() => undefined);
    });
    expect(onNotice).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /current hit/ })).toBeTruthy();
  });
});
