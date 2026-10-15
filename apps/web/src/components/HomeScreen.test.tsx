// @vitest-environment happy-dom
/**
 * The home screen's start tab: the file input, and the recent list read from `localStorage`
 * with its search, sort, star, remove and clear controls; and the "All tools" tab, which asks for
 * its chunk when the pointer reaches it and states that it is loading.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persistenceStore, resetPersistence } from '../features/persistence/persistence-store';
import { manifest, memoryStorage } from '../features/persistence/vault.fixtures';
import { loadRecentDocuments, type RecentDocumentItem, saveRecentDocuments } from '../recent';
import { HomeScreen } from './HomeScreen';

const handles = vi.hoisted(() => ({
  deleteRecentHandle: vi.fn(async (_id: string) => undefined),
  pruneRecentHandles: vi.fn(async (_keep: ReadonlySet<string>) => undefined),
}));
vi.mock('../recent-handles', () => handles);

/** The tool grid's chunk: it counts how often it is asked for and arrives when the test says so. */
const grid = vi.hoisted(() => {
  const state = { loads: 0, arrive: () => {}, arrived: Promise.resolve() };
  state.arrived = new Promise<void>((resolve) => {
    state.arrive = resolve;
  });
  return state;
});
vi.mock('./HomeToolGrid', async () => {
  const { createElement } = await import('react');
  grid.loads += 1;
  await grid.arrived;
  return { default: () => createElement('p', null, 'the tool grid') };
});

const t = createTranslator('en');
const NOW = Date.now();

const item = (
  id: string,
  name: string,
  sizeBytes: number,
  openedAt: number,
  starred?: boolean,
): RecentDocumentItem => ({
  id,
  name,
  sizeBytes,
  openedAt,
  pageCount: 3,
  ...(starred === undefined ? {} : { starred }),
});

function screenFor(overrides: Partial<ComponentProps<typeof HomeScreen>> = {}) {
  return (
    <HomeScreen
      t={t}
      onOpenFiles={vi.fn()}
      onSelectRecent={vi.fn()}
      onStart={vi.fn()}
      commands={[]}
      standaloneCommands={new Set()}
      onRunCommand={vi.fn()}
      activeDocumentName={null}
      openIds={new Set()}
      {...overrides}
    />
  );
}

/** The recent list's file names, top to bottom. */
function names(container: HTMLElement): (string | null | undefined)[] {
  return [...container.querySelectorAll('tbody tr')].map(
    (row) => row.querySelector('.truncate')?.textContent,
  );
}

beforeEach(() => {
  localStorage.clear();
  handles.deleteRecentHandle.mockClear();
  handles.pruneRecentHandles.mockClear();
  resetPersistence();
  persistenceStore.set({ draftStorage: memoryStorage() });
});
afterEach(cleanup);

describe('HomeScreen file input', () => {
  it('hands the chosen files over, and nothing when the browser reports no file list', () => {
    const onOpenFiles = vi.fn();
    const { container } = render(screenFor({ onOpenFiles }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-'], 'a.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });
    expect(onOpenFiles).toHaveBeenCalledExactlyOnceWith([file]);

    fireEvent.change(input, { target: { files: null } });
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });
});

describe('HomeScreen entry points', () => {
  it('opens a file through the drop zone alone: no second open card, no palette button of its own', () => {
    const { container } = render(screenFor());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    expect(input.labels?.[0]?.textContent).toContain(t('home.drop.title'));
    // CSS shows the shorter wording where nothing can be dragged (a coarse pointer).
    expect(input.labels?.[0]?.textContent).toContain(t('home.drop.titleTouch'));
    expect(screen.queryByRole('button', { name: /open a pdf/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /command palette|ctrl+k/i })).toBeNull();
  });
});

describe('HomeScreen recent list', () => {
  const seed = () =>
    saveRecentDocuments([
      item('a', 'Zebra report.pdf', 3_000, NOW - 3 * 3_600_000),
      item('b', 'Apple invoice.pdf', 5_000_000, NOW - 60_000, true),
      item('c', 'Mango notes.pdf', 2_000, NOW - 2 * 86_400_000),
    ]);

  it('lists the stored entries newest first and says nothing is recent when none are stored', () => {
    const empty = render(screenFor());
    expect(empty.getByText(t('home.noRecent'))).toBeTruthy();
    cleanup();

    seed();
    const { container } = render(screenFor());
    expect(names(container)).toEqual(['Apple invoice.pdf', 'Zebra report.pdf', 'Mango notes.pdf']);
  });

  it('marks the entries that are open and reopens the one chosen', async () => {
    seed();
    const onSelectRecent = vi.fn();
    const user = userEvent.setup();
    const { container } = render(screenFor({ onSelectRecent, openIds: new Set(['c']) }));

    expect(container.querySelectorAll('tbody tr')[2]?.textContent).toContain(t('home.badge.open'));
    expect(screen.getAllByText(t('home.badge.open'))).toHaveLength(1);

    await user.click(
      screen.getByRole('button', { name: t('home.openRecent', { name: 'Zebra report.pdf' }) }),
    );
    expect(onSelectRecent).toHaveBeenCalledExactlyOnceWith(
      item('a', 'Zebra report.pdf', 3_000, NOW - 3 * 3_600_000),
    );
  });

  it('filters by the search text, folding case, and says when nothing matches', async () => {
    seed();
    const user = userEvent.setup();
    const { container } = render(screenFor());
    const search = screen.getByPlaceholderText(t('home.recent.search'));

    await user.type(search, 'MANGO');
    expect(names(container)).toEqual(['Mango notes.pdf']);

    await user.clear(search);
    await user.type(search, 'nothing like this');
    expect(names(container)).toEqual([]);
    expect(screen.getByText(t('home.noMatch'))).toBeTruthy();
  });

  it('sorts by name and by size', async () => {
    seed();
    const user = userEvent.setup();
    const { container } = render(screenFor());
    const sort = screen.getByRole('combobox');

    await user.selectOptions(sort, 'name');
    expect(names(container)).toEqual(['Apple invoice.pdf', 'Mango notes.pdf', 'Zebra report.pdf']);

    await user.selectOptions(sort, 'size');
    expect(names(container)).toEqual(['Apple invoice.pdf', 'Zebra report.pdf', 'Mango notes.pdf']);
  });

  it('stars an entry, lists it under the starred tab, and unstars it', async () => {
    seed();
    const user = userEvent.setup();
    const { container } = render(screenFor());
    const row = (name: string) =>
      container.querySelectorAll('tbody tr')[names(container).indexOf(name)] as HTMLElement;

    await user.click(within(row('Mango notes.pdf')).getByRole('button', { name: t('home.star') }));
    expect(
      loadRecentDocuments()
        .filter((entry) => entry.starred === true)
        .map((entry) => entry.id),
    ).toEqual(['b', 'c']);

    await user.click(screen.getByRole('tab', { name: t('home.starredTab') }));
    expect(names(container)).toEqual(['Apple invoice.pdf', 'Mango notes.pdf']);

    await user.click(within(row('Apple invoice.pdf')).getByRole('button', { name: t('home.unstar') }));
    expect(names(container)).toEqual(['Mango notes.pdf']);
  });

  it('keeps what the list stores behind an info button, and repeats no privacy claim', async () => {
    seed();
    const user = userEvent.setup();
    const { container } = render(screenFor());
    const about = screen.getByRole('button', { name: t('home.recent.about') });

    expect(about.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(t('home.recent.stores'))).toBeNull();
    expect(container.textContent).not.toMatch(/never leave/i);

    await user.click(about);
    expect(about.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(t('home.recent.stores')).id).toBe(about.getAttribute('aria-controls'));

    await user.click(about);
    expect(screen.queryByText(t('home.recent.stores'))).toBeNull();
  });

  it('says nothing is starred when no entry is', async () => {
    saveRecentDocuments([item('a', 'one.pdf', 1, NOW)]);
    const user = userEvent.setup();
    render(screenFor());

    await user.click(screen.getByRole('tab', { name: t('home.starredTab') }));
    expect(screen.getByText(t('home.noStarred'))).toBeTruthy();
  });

  it('removes one entry and forgets its file handle', async () => {
    seed();
    const user = userEvent.setup();
    const { container } = render(screenFor());

    await user.click(screen.getByRole('button', { name: `${t('home.removeFromList')}: Zebra report.pdf` }));

    expect(names(container)).toEqual(['Apple invoice.pdf', 'Mango notes.pdf']);
    expect(loadRecentDocuments().map((entry) => entry.id)).toEqual(['b', 'c']);
    expect(handles.deleteRecentHandle).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('clears the list only after the confirmation, and prunes every handle nothing else needs', async () => {
    seed();
    const user = userEvent.setup();
    const { container } = render(screenFor());

    await user.click(screen.getByRole('button', { name: t('home.clearList') }));
    await user.click(screen.getByRole('button', { name: t('home.clearNo') }));
    expect(names(container)).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('button', { name: t('home.clearList') }));
    await user.click(screen.getByRole('button', { name: t('home.clearYes') }));
    expect(names(container)).toEqual([]);
    expect(loadRecentDocuments()).toEqual([]);
    await vi.waitFor(() => expect(handles.pruneRecentHandles).toHaveBeenCalledExactlyOnceWith(new Set()));
  });

  it('keeps the handle of a document that is open and of one the vault holds a draft for', async () => {
    seed();
    const storage = memoryStorage();
    storage.drafts.set('drafted', manifest('drafted'));
    persistenceStore.set({ draftStorage: storage });
    const user = userEvent.setup();
    render(screenFor({ openIds: new Set(['b']) }));

    await user.click(screen.getByRole('button', { name: t('home.clearList') }));
    await user.click(screen.getByRole('button', { name: t('home.clearYes') }));

    await vi.waitFor(() =>
      expect(handles.pruneRecentHandles).toHaveBeenCalledExactlyOnceWith(new Set(['b', 'drafted'])),
    );
    expect(loadRecentDocuments()).toEqual([]);
  });

  it.each([
    ['an enumeration that failed', { drafts: [], unreadable: [], enumerationFailed: true }],
    ['a manifest that could not be read', { drafts: [manifest('drafted')], unreadable: ['broken.json'] }],
  ])('prunes no handle when the vault inventory is incomplete: %s', async (_name, inventory) => {
    seed();
    const storage = memoryStorage();
    storage.inventory = inventory;
    persistenceStore.set({ draftStorage: storage });
    const user = userEvent.setup();
    render(screenFor());

    await user.click(screen.getByRole('button', { name: t('home.clearList') }));
    await user.click(screen.getByRole('button', { name: t('home.clearYes') }));

    expect(loadRecentDocuments()).toEqual([]);
    // The inventory read is a few microtasks; let them all run before asserting nothing happened.
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await settled;
    expect(handles.pruneRecentHandles).not.toHaveBeenCalled();
  });
});

describe('HomeScreen tools tab', () => {
  it('asks for the tool grid when the tab is reached, and states that it is loading until it arrives', async () => {
    const user = userEvent.setup();
    render(screenFor());
    const tools = screen.getByRole('tab', { name: t('home.tab.tools') });
    expect(grid.loads).toBe(0);

    await user.hover(tools);
    expect(grid.loads).toBe(1);

    await user.click(tools);
    expect(tools.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: t('home.tab.start') }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(screen.getByRole('status').textContent).toBe(t('home.tools.loading'));
    expect(screen.queryByText('the tool grid')).toBeNull();

    await act(async () => grid.arrive());
    expect(await screen.findByText('the tool grid')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(grid.loads).toBe(1);
  });
});
