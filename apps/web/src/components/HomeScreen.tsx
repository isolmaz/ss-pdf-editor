/**
 * The home screen: what a user can start, every tool by task, and the recent list.
 *
 * Two tabs, both of which do something. **Start** holds the ways to begin — open a PDF,
 * a blank document, a PDF from images, merging several PDFs, a batch run — and the recent
 * documents. **All tools** is the command registry laid out by task (`HomeToolGrid`): pick
 * the tool first, and the shell asks for the file when the tool needs one.
 *
 * Nothing here holds document bytes. The recent list is metadata in `localStorage`
 * (`recent.ts`); whether an entry is open in a tab is told by the shell, which owns the tabs.
 */

import {
  ArrowsMerge,
  Camera,
  CloudArrowUp,
  FileArrowUp,
  FilePdf,
  FilePlus,
  Images,
  Info,
  MagnifyingGlass,
  Stack,
  Star,
  Trash,
} from '@phosphor-icons/react';
import { CONVERT_ACCEPT } from 'pdf-core/ops/convert-formats';
import { formatBytes, type Translator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import { lazy, type ReactNode, Suspense, useId, useMemo, useState } from 'react';
import { readInventory } from '../features/persistence/draft-vault';
import {
  clearRecentDocuments,
  loadRecentDocuments,
  type RecentDocumentItem,
  removeRecentDocument,
  toggleStarRecentDocument,
} from '../recent';
import { deleteRecentHandle, pruneRecentHandles } from '../recent-handles';

/** The grid is a chunk of its own; the tab asks for it on hover and focus, before the click needs it. */
let toolGrid: Promise<typeof import('./HomeToolGrid')> | undefined;
const loadToolGrid = () => {
  toolGrid ??= import('./HomeToolGrid');
  return toolGrid;
};
const HomeToolGrid = lazy(loadToolGrid);

/**
 * After the list is cleared, forget the file handles nothing else needs. A tab open now and a
 * draft the vault still holds both reopen their file through the handle — a restored tab
 * without it could only Export — so those stay. An inventory that could not be read completely
 * prunes nothing: the same refusal the vault's own cleanup makes, because not knowing what is
 * referenced is not the same as nothing being referenced.
 */
async function forgetUnneededHandles(openIds: ReadonlySet<string>): Promise<void> {
  const inventory = await readInventory();
  if (inventory.enumerationFailed === true || inventory.unreadable.length > 0) return;
  await pruneRecentHandles(new Set([...openIds, ...inventory.drafts.map((draft) => draft.id)]));
}

export type HomeStartAction = 'blank' | 'images' | 'merge' | 'batch' | 'convert' | 'scan';

export interface HomeScreenProps {
  readonly t: Translator;
  /** A file the user chose or dropped here; with none, the shell opens its picker. */
  readonly onOpenFiles: (files: readonly File[]) => void;
  readonly onSelectRecent: (item: RecentDocumentItem) => void;
  readonly onStart: (action: HomeStartAction) => void;
  /** Every command; the tool grid is built from them whatever the interface mode. */
  readonly commands: readonly Command[];
  /** Commands that start a document and never need one open. */
  readonly standaloneCommands: ReadonlySet<string>;
  readonly onRunCommand: (commandId: string) => void;
  /** The tab the tools apply to, or `null` with no document open. */
  readonly activeDocumentName: string | null;
  /** Recent entries open in a tab right now, by id. */
  readonly openIds: ReadonlySet<string>;
  readonly busy?: boolean;
}

type SortKey = 'date' | 'name' | 'size';

/** "3 minutes ago", "yesterday", or a date — in the interface language, never hardcoded. */
function formatOpened(timestamp: number, locale: string, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(0, 'second');
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
  return new Date(timestamp).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

function fold(text: string): string {
  return text.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

function TabButton({
  selected,
  controls,
  onSelect,
  onIntent,
  children,
}: {
  readonly selected: boolean;
  readonly controls: string;
  readonly onSelect: () => void;
  /** The pointer or the keyboard reached the tab: a chance to prepare what it opens. */
  readonly onIntent?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={controls}
      onClick={onSelect}
      onPointerEnter={onIntent}
      onFocus={onIntent}
      className={`border-b-2 pb-2 text-sm font-semibold transition-colors ${
        selected
          ? 'border-pdf-accent text-kumo-strong'
          : 'border-transparent text-kumo-subtle hover:text-kumo-default'
      }`}
    >
      {children}
    </button>
  );
}

function StartCard({
  icon,
  title,
  description,
  onClick,
  disabled,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex h-full flex-col rounded-lg border border-kumo-line bg-kumo-base p-4 text-start transition-colors hover:border-kumo-contrast hover:bg-kumo-recessed focus-visible:border-kumo-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 max-sm:flex-row max-sm:items-center max-sm:gap-3 max-sm:p-2.5"
    >
      <span className="mb-3 flex size-9 shrink-0 items-center justify-center rounded-md bg-kumo-recessed text-pdf-accent transition-transform group-hover:scale-105 max-sm:mb-0 max-sm:size-8">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold text-kumo-strong">{title}</span>
        <span className="mt-1 text-xs leading-relaxed text-kumo-subtle max-sm:mt-0 max-sm:truncate">
          {description}
        </span>
      </span>
    </button>
  );
}

export function HomeScreen({
  t,
  onOpenFiles,
  onSelectRecent,
  onStart,
  commands,
  standaloneCommands,
  onRunCommand,
  activeDocumentName,
  openIds,
  busy = false,
}: HomeScreenProps) {
  const [recentItems, setRecentItems] = useState<RecentDocumentItem[]>(() => loadRecentDocuments());
  const [topTab, setTopTab] = useState<'start' | 'tools'>('start');
  const [recentTab, setRecentTab] = useState<'recent' | 'starred'>('recent');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('date');
  const [confirmClear, setConfirmClear] = useState(false);
  const [showStored, setShowStored] = useState(false);
  const fileInputId = useId();
  const startPanelId = useId();
  const storedId = useId();
  const toolsPanelId = useId();
  const locale = t.locale;

  const displayedItems = useMemo(() => {
    const needle = fold(query.trim());
    const filtered = recentItems.filter(
      (item) =>
        (recentTab === 'recent' || item.starred === true) &&
        (needle === '' || fold(item.name).includes(needle)),
    );
    const sorted = [...filtered];
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, locale));
    else if (sort === 'size') sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
    else sorted.sort((a, b) => b.openedAt - a.openedAt);
    return sorted;
  }, [locale, query, recentItems, recentTab, sort]);

  const tabItems =
    recentTab === 'starred' ? recentItems.filter((item) => item.starred === true) : recentItems;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-kumo-canvas px-4 py-6 text-kumo-default select-none max-sm:py-4 md:px-12">
      <input
        id={fileInputId}
        type="file"
        accept={`application/pdf,.pdf,${CONVERT_ACCEPT}`}
        multiple
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onOpenFiles(files);
        }}
        disabled={busy}
      />

      <div className="flex items-center justify-between gap-3 border-b border-kumo-line">
        <div role="tablist" aria-label={t('home.start.title')} className="flex items-center gap-6">
          <TabButton
            selected={topTab === 'start'}
            controls={startPanelId}
            onSelect={() => setTopTab('start')}
          >
            {t('home.tab.start')}
          </TabButton>
          <TabButton
            selected={topTab === 'tools'}
            controls={toolsPanelId}
            onSelect={() => setTopTab('tools')}
            onIntent={() => void loadToolGrid()}
          >
            {t('home.tab.tools')}
          </TabButton>
        </div>
      </div>

      {topTab === 'tools' ? (
        <div id={toolsPanelId} role="tabpanel">
          <Suspense
            fallback={
              <p role="status" className="mt-6 text-xs text-kumo-subtle">
                {t('home.tools.loading')}
              </p>
            }
          >
            <HomeToolGrid
              t={t}
              commands={commands}
              activeDocumentName={activeDocumentName}
              standalone={standaloneCommands}
              onRun={onRunCommand}
            />
          </Suspense>
        </div>
      ) : (
        <div id={startPanelId} role="tabpanel" className="flex flex-1 flex-col">
          <h2 className="sr-only">{t('home.start.title')}</h2>
          <div className="mt-6 grid grid-cols-1 gap-2 max-sm:mt-3 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
            <label
              htmlFor={fileInputId}
              className="group flex cursor-pointer sm:col-span-2 flex-col items-center justify-center rounded-lg border-2 border-dashed border-kumo-line bg-kumo-base/50 p-4 text-center transition-colors hover:border-pdf-accent hover:bg-kumo-base focus-within:border-kumo-focus max-sm:flex-row max-sm:justify-start max-sm:gap-3 max-sm:p-2.5 max-sm:text-start"
            >
              <span className="mb-2 flex size-10 shrink-0 items-center justify-center rounded-full bg-kumo-recessed text-pdf-accent transition-transform group-hover:scale-110 max-sm:mb-0 max-sm:size-8">
                <CloudArrowUp size={24} weight="duotone" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-col">
                {/* Nothing is dragged with a finger: on a touch screen the zone only says to open. */}
                <span className="text-xs font-semibold text-kumo-strong pointer-coarse:hidden">
                  {t('home.drop.title')}
                </span>
                <span className="hidden text-xs font-semibold text-kumo-strong pointer-coarse:inline">
                  {t('home.drop.titleTouch')}
                </span>
                <span className="mt-1 text-[11px] text-kumo-subtle">{t('home.drop.desc')}</span>
              </span>
            </label>
            <StartCard
              icon={<FilePlus size={20} weight="duotone" />}
              title={t('home.start.blank.title')}
              description={t('home.start.blank.desc')}
              onClick={() => onStart('blank')}
              disabled={busy}
            />
            <StartCard
              icon={<FileArrowUp size={20} weight="duotone" />}
              title={t('home.start.convert.title')}
              description={t('home.start.convert.desc')}
              onClick={() => onStart('convert')}
              disabled={busy}
            />
            <StartCard
              icon={<Images size={20} weight="duotone" />}
              title={t('home.start.images.title')}
              description={t('home.start.images.desc')}
              onClick={() => onStart('images')}
              disabled={busy}
            />
            <StartCard
              icon={<Camera size={20} weight="duotone" />}
              title={t('home.start.scan.title')}
              description={t('home.start.scan.desc')}
              onClick={() => onStart('scan')}
              disabled={busy}
            />
            <StartCard
              icon={<ArrowsMerge size={20} weight="duotone" />}
              title={t('home.start.merge.title')}
              description={t('home.start.merge.desc')}
              onClick={() => onStart('merge')}
              disabled={busy}
            />
            <StartCard
              icon={<Stack size={20} weight="duotone" />}
              title={t('home.start.batch.title')}
              description={t('home.start.batch.desc')}
              onClick={() => onStart('batch')}
              disabled={busy}
            />
          </div>

          <div className="mt-10 flex flex-1 flex-col max-sm:mt-6">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-kumo-line">
              <div className="flex items-center gap-4">
                <div role="tablist" aria-label={t('home.recentTab')} className="flex items-center gap-6">
                  <TabButton
                    selected={recentTab === 'recent'}
                    controls="home-recent"
                    onSelect={() => setRecentTab('recent')}
                  >
                    {t('home.recentTab')}
                  </TabButton>
                  <TabButton
                    selected={recentTab === 'starred'}
                    controls="home-recent"
                    onSelect={() => setRecentTab('starred')}
                  >
                    {t('home.starredTab')}
                  </TabButton>
                </div>
                <button
                  type="button"
                  aria-expanded={showStored}
                  aria-controls={storedId}
                  aria-label={t('home.recent.about')}
                  title={t('home.recent.about')}
                  onClick={() => setShowStored((open) => !open)}
                  className="mb-2 rounded p-1 text-kumo-subtle transition-colors hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                >
                  <Info size={14} aria-hidden="true" />
                </button>
              </div>
              {recentItems.length > 0 ? (
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <label className="relative block">
                    <span className="sr-only">{t('home.recent.search')}</span>
                    <MagnifyingGlass
                      size={13}
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 start-2 -translate-y-1/2 text-kumo-subtle"
                    />
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t('home.recent.search')}
                      className="w-44 rounded-md border border-kumo-line bg-kumo-base py-1 pe-2 ps-7 text-xs placeholder:text-kumo-subtle focus:border-kumo-focus focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-xs text-kumo-subtle">
                    {t('home.recent.sort')}
                    <select
                      value={sort}
                      onChange={(event) => setSort(event.target.value as SortKey)}
                      className="rounded-md border border-kumo-line bg-kumo-base px-1.5 py-1 text-xs text-kumo-default focus:border-kumo-focus focus:outline-none"
                    >
                      <option value="date">{t('home.recent.sort.date')}</option>
                      <option value="name">{t('home.recent.sort.name')}</option>
                      <option value="size">{t('home.recent.sort.size')}</option>
                    </select>
                  </label>
                  {confirmClear ? (
                    <span role="alert" className="flex items-center gap-2 text-xs text-kumo-default">
                      {t('home.clearConfirm')}
                      <button
                        type="button"
                        className="rounded-md bg-kumo-danger px-2 py-0.5 font-medium text-white hover:opacity-90"
                        onClick={() => {
                          setRecentItems(clearRecentDocuments());
                          void forgetUnneededHandles(openIds);
                          setConfirmClear(false);
                        }}
                      >
                        {t('home.clearYes')}
                      </button>
                      <button
                        type="button"
                        className="rounded-md px-2 py-0.5 text-kumo-subtle hover:bg-kumo-recessed"
                        onClick={() => setConfirmClear(false)}
                      >
                        {t('home.clearNo')}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-kumo-subtle transition-colors hover:text-kumo-danger"
                      onClick={() => setConfirmClear(true)}
                    >
                      {t('home.clearList')}
                    </button>
                  )}
                </div>
              ) : null}
            </div>

            {showStored ? (
              <p id={storedId} className="mt-3 text-[11px] text-kumo-subtle">
                {t('home.recent.stores')}
              </p>
            ) : null}

            <div id="home-recent" role="tabpanel" className="flex flex-1 flex-col">
              {displayedItems.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
                  <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-kumo-recessed text-kumo-subtle">
                    <FilePdf size={28} weight="duotone" aria-hidden="true" />
                  </span>
                  <p className="text-sm font-medium text-kumo-strong">
                    {tabItems.length > 0
                      ? t('home.noMatch')
                      : recentTab === 'starred'
                        ? t('home.noStarred')
                        : t('home.noRecent')}
                  </p>
                </div>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-start text-xs text-kumo-default">
                    <thead>
                      <tr className="border-b border-kumo-line text-[11px] font-medium tracking-wider text-kumo-subtle uppercase">
                        <th scope="col" className="w-8 py-2.5 pe-2 ps-2">
                          <span className="sr-only">{t('home.star')}</span>
                        </th>
                        <th scope="col" className="px-3 py-2.5 font-semibold">
                          {t('home.colName')}
                        </th>
                        <th scope="col" className="hidden px-3 py-2.5 text-end font-semibold sm:table-cell">
                          {t('home.colPages')}
                        </th>
                        <th scope="col" className="px-3 py-2.5 font-semibold">
                          {t('home.colLastOpened')}
                        </th>
                        <th scope="col" className="hidden px-3 py-2.5 text-end font-semibold sm:table-cell">
                          {t('home.colSize')}
                        </th>
                        <th scope="col" className="w-10 py-2.5 pe-2 ps-3 text-end">
                          <span className="sr-only">{t('home.colActions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-kumo-line/40">
                      {displayedItems.map((item) => (
                        <tr key={item.id} className="group transition-colors hover:bg-kumo-base/80">
                          <td className="py-2 pe-2 ps-2 text-center">
                            <button
                              type="button"
                              aria-pressed={item.starred === true}
                              aria-label={item.starred === true ? t('home.unstar') : t('home.star')}
                              onClick={() => setRecentItems(toggleStarRecentDocument(item.id))}
                              className={`rounded p-1 transition-colors ${
                                item.starred === true
                                  ? 'text-kumo-warning'
                                  : 'text-kumo-subtle/60 hover:text-kumo-subtle'
                              }`}
                            >
                              <Star size={16} weight={item.starred === true ? 'fill' : 'regular'} />
                            </button>
                          </td>
                          <td className="px-3 py-2 font-medium text-kumo-strong">
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={t('home.openRecent', { name: item.name })}
                              onClick={() => onSelectRecent(item)}
                              className="flex max-w-full items-center gap-2 rounded text-start hover:underline focus-visible:outline-1 focus-visible:outline-kumo-focus disabled:opacity-50"
                            >
                              <FilePdf size={18} className="shrink-0 text-pdf-accent" aria-hidden="true" />
                              <span className="max-w-[18rem] truncate">{item.name}</span>
                              {openIds.has(item.id) ? (
                                <span className="shrink-0 rounded border border-kumo-line/60 bg-kumo-recessed px-1.5 py-px text-[10px] font-medium text-kumo-strong">
                                  {t('home.badge.open')}
                                </span>
                              ) : null}
                            </button>
                          </td>
                          <td className="hidden px-3 py-2 text-end text-kumo-subtle tabular-nums sm:table-cell">
                            {item.pageCount === undefined ? '—' : item.pageCount.toLocaleString(locale)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-kumo-subtle">
                            <time dateTime={new Date(item.openedAt).toISOString()}>
                              {formatOpened(item.openedAt, locale)}
                            </time>
                          </td>
                          <td className="hidden px-3 py-2 text-end whitespace-nowrap text-kumo-subtle tabular-nums sm:table-cell">
                            {formatBytes(item.sizeBytes, locale)}
                          </td>
                          <td className="py-2 pe-2 ps-3 text-end">
                            {/* Visible on touch screens and to the keyboard; on a pointer
                                device it fades in with the row. */}
                            <button
                              type="button"
                              aria-label={`${t('home.removeFromList')}: ${item.name}`}
                              onClick={() => {
                                setRecentItems(removeRecentDocument(item.id));
                                void deleteRecentHandle(item.id);
                              }}
                              className="rounded p-1 text-kumo-subtle transition-opacity hover:bg-kumo-recessed hover:text-kumo-danger focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
                            >
                              <Trash size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
