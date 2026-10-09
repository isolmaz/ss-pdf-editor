import type { PdfDocumentHandle } from 'pdf-core';
import type { AnnotationMark } from 'pdf-core/ops/annotations';
import type { LayerWriteRequest } from 'pdf-core/ops/layer-write';
import type { MessageKey, Translator } from 'pdf-shared';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Dock } from '../shell/Dock';
import { AttachmentsPanel } from './AttachmentsPanel';
import { LayersPanel } from './LayersPanel';
import { type PageMoveAction, PagesPanel } from './PagesPanel';
import { SearchResultsPanel } from './SearchResultsPanel';
import { SignaturesPanel } from './SignaturesPanel';

/**
 * Left dock of the reader half: the page list, the document
 * outline, its attachments, optional content groups, signature fields and the
 * search results, in one panel with a tab per view.
 *
 * Every view reads the same `PdfDocumentHandle` the shell already owns, and the ones
 * that navigate do it through the viewer's imperative API — the panel never touches
 * pdf.js directly, which is also why it stays
 * testable outside a browser canvas.
 *
 * A tab strip, nothing else: the views themselves own their behaviour. The pages
 * tab is `PagesPanel` (with the selection and reorder
 * machinery the reader half needs); the rest are read when their tab is shown, not
 * before.
 */

export interface OutlineEntry {
  readonly title: string;
  readonly pageIndex: number | null;
  readonly children: readonly OutlineEntry[];
}

export interface DocumentPanelProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  /** Current page (0-based) — the thumbnail list follows it. */
  readonly currentPage: number;
  readonly onGoToPage: (pageIndex: number) => void;
  /** The page list's controlled selection, in the shell's state. */
  readonly selectedPages: readonly number[];
  readonly onSelectionChange: (pages: readonly number[]) => void;
  /** Structural page changes (rotate/delete/duplicate/move), applied by the shell. */
  readonly onPageAction: (action: PageMoveAction) => void;
  /** False in viewing mode: the page list still selects, every action is disabled. */
  readonly editing: boolean;
  /** Opens the extract-pages dialog; absent leaves that button disabled. */
  readonly onExtract?: () => void;
  /**
   * The shell's notice line (`App.tsx` state) — receives already-translated text.
   * Optional: without it a failing view still carries its own message.
   */
  readonly onNotice?: (message: string) => void;
  /**
   * The viewer's find layer, when the shell can reach it — `viewerApi.find(query)`
   * highlights the query of the result the user clicked.
   */
  readonly onHighlightQuery?: (query: string) => void;
  /**
   * Layer visibility changed in the engine; the shell points this at the viewer's
   * `refreshOptionalContent()` so the canvas actually repaints.
   */
  readonly onLayersChanged?: () => void;
  /**
   * Opens the outline editor (`ops/outline-edit.ts`). The list itself is the reader's
   * navigation surface; editing it is a file write, so it is the shell's to run and
   * this panel only offers the way in. Absent leaves the list read-only.
   */
  readonly onEditOutline?: () => void;
  readonly version?: string;
  /** The session's unwritten marks, drawn on the page thumbnails (`PagesPanel`). */
  readonly marks?: readonly AnnotationMark[];
  /**
   * Layer state the panel shows, written into the file (`ops/layer-write.ts`).
   * Ownership follows the same rule: the panel holds the view state, the shell holds
   * the bytes.
   */
  readonly onWriteLayers?: (request: LayerWriteRequest) => void;
  /** Embed files in the document (`ops/attachments-write.ts`); the shell does the write. */
  readonly onAddAttachments: (files: readonly File[]) => void;
  /** Remove embedded files by name. */
  readonly onRemoveAttachments: (names: readonly string[]) => void;
  /**
   * The visible tab. Absent leaves the panel in charge of its own selection; the shell
   * passes it when a menu or palette command has to open a specific view (the layer
   * write lives behind the layers tab, and a command that cannot reach it is not a way
   * in).
   */
  /**
   * The tabs this surface offers. Omitted means every tab, which is what the advanced
   * mode and every existing caller get. The simple mode drops the readers for advanced
   * structure — attachments, layers and the signature-field list — while the tabs that
   * answer "what is in this document and where" stay.
   */
  readonly visibleTabs?: readonly DocumentPanelTab[];
  readonly tab?: DocumentPanelTab;
  readonly onTabChange?: (tab: DocumentPanelTab) => void;
  readonly onToggle: () => void;
}

export type DocumentPanelTab = 'pages' | 'outline' | 'attachments' | 'layers' | 'signatures' | 'search';

type Tab = DocumentPanelTab;

/** Tab strip order; each label is a dictionary key, never an English string. */
const TABS: readonly { readonly id: Tab; readonly label: MessageKey }[] = [
  { id: 'pages', label: 'panel.pages' },
  { id: 'outline', label: 'panel.outline' },
  { id: 'attachments', label: 'panel.attachments' },
  { id: 'layers', label: 'panel.layers' },
  { id: 'signatures', label: 'panel.signatures' },
  { id: 'search', label: 'panel.search' },
];

export function DocumentPanel({
  document,
  t,
  currentPage,
  onGoToPage,
  selectedPages,
  onSelectionChange,
  onPageAction,
  editing,
  onExtract,
  version,
  marks,
  onNotice,
  onHighlightQuery,
  onLayersChanged,
  onEditOutline,
  onWriteLayers,
  onAddAttachments,
  onRemoveAttachments,
  visibleTabs,
  tab: controlledTab,
  onTabChange,
  onToggle,
}: DocumentPanelProps) {
  const [ownTab, setOwnTab] = useState<Tab>('pages');
  const tabs = visibleTabs === undefined ? TABS : TABS.filter((entry) => visibleTabs.includes(entry.id));
  // The requested tab is honoured only when this mode offers it: a mode change while a
  // hidden tab was open must not leave the dock rendering nothing.
  const requested = controlledTab ?? ownTab;
  const tab: Tab = tabs.some((entry) => entry.id === requested) ? requested : (tabs[0]?.id ?? 'pages');
  const selectTab = (next: Tab) => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  const [outline, setOutline] = useState<readonly OutlineEntry[] | null>(null);

  useEffect(() => {
    let disposed = false;
    void document.getOutline().then((entries) => {
      if (!disposed) setOutline(entries);
    });
    return () => {
      disposed = true;
    };
  }, [document]);

  return (
    <Dock
      t={t}
      side="left"
      tabs={tabs}
      activeId={tab}
      onSelect={(id) => selectTab(id as Tab)}
      onToggle={onToggle}
    >
      {tab === 'pages' ? (
        <PagesPanel
          document={document}
          t={t}
          currentPage={currentPage}
          selectedPages={selectedPages}
          onSelectionChange={onSelectionChange}
          onGoToPage={onGoToPage}
          onPageAction={onPageAction}
          editing={editing}
          version={version}
          marks={marks}
          {...(onExtract === undefined ? {} : { onExtract })}
        />
      ) : null}
      {tab === 'outline' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {onEditOutline === undefined ? null : (
            <Button variant="outline" className="m-2 mb-1" disabled={!editing} onClick={onEditOutline}>
              {t('panel.outline.edit')}
            </Button>
          )}
          <OutlineList t={t} entries={outline} currentPage={currentPage} onGoToPage={onGoToPage} />
        </div>
      ) : null}
      {tab === 'attachments' ? (
        <AttachmentsPanel
          document={document}
          t={t}
          onNotice={onNotice}
          disabled={!editing}
          onAdd={onAddAttachments}
          onRemove={onRemoveAttachments}
        />
      ) : null}
      {tab === 'layers' ? (
        <LayersPanel
          document={document}
          t={t}
          onNotice={onNotice}
          onLayersChanged={onLayersChanged}
          disabled={!editing}
          {...(onWriteLayers === undefined ? {} : { onWriteDocument: onWriteLayers })}
        />
      ) : null}
      {tab === 'signatures' ? (
        <SignaturesPanel document={document} t={t} onGoToPage={onGoToPage} onNotice={onNotice} />
      ) : null}
      {tab === 'search' ? (
        <SearchResultsPanel
          document={document}
          t={t}
          currentPage={currentPage}
          onGoToPage={onGoToPage}
          onHighlightQuery={onHighlightQuery}
          onNotice={onNotice}
        />
      ) : null}
    </Dock>
  );
}

function OutlineList({
  t,
  entries,
  currentPage,
  onGoToPage,
}: {
  t: Translator;
  entries: readonly OutlineEntry[] | null;
  currentPage: number;
  onGoToPage: (pageIndex: number) => void;
}) {
  if (entries === null) {
    return <p className="p-3 text-xs text-kumo-subtle">{t('panel.outline.loading')}</p>;
  }
  if (entries.length === 0) {
    return <p className="p-3 text-xs text-kumo-subtle">{t('panel.outline.empty')}</p>;
  }
  return (
    <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t('panel.outline')}>
      <OutlineLevel t={t} entries={entries} depth={0} currentPage={currentPage} onGoToPage={onGoToPage} />
    </nav>
  );
}

function OutlineLevel({
  t,
  entries,
  depth,
  currentPage,
  onGoToPage,
}: {
  t: Translator;
  entries: readonly OutlineEntry[];
  depth: number;
  currentPage: number;
  onGoToPage: (pageIndex: number) => void;
}) {
  return (
    <ul className={depth === 0 ? '' : 'ms-3 border-s border-kumo-line ps-2'}>
      {entries.map((entry) => {
        const { pageIndex } = entry;
        return (
          <li key={`${entry.title}-${pageIndex ?? -1}`} className="my-0.5">
            <button
              type="button"
              disabled={pageIndex === null}
              onClick={pageIndex === null ? undefined : () => onGoToPage(pageIndex)}
              aria-current={pageIndex === currentPage ? 'page' : undefined}
              className={`w-full truncate rounded-sm px-1.5 py-1 text-start text-xs ${
                pageIndex === currentPage
                  ? 'bg-kumo-tint text-kumo-strong'
                  : 'text-kumo-default hover:bg-kumo-tint'
              } disabled:text-kumo-subtle`}
              title={entry.title}
            >
              {entry.title}
            </button>
            {entry.children.length > 0 ? (
              <OutlineLevel
                t={t}
                entries={entry.children}
                depth={depth + 1}
                currentPage={currentPage}
                onGoToPage={onGoToPage}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
