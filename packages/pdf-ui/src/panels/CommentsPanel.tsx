/**
 * Comments and annotations (`PLAN.md §5/Phase 3`).
 *
 * The panel is the document's annotation inventory seen from one place: the marks
 * this session holds (not yet written to the file) **and** the annotations the file
 * already carries, in page order. Two lists, one view, because from the user's
 * side there is one document — the difference is whether the row will survive a
 * save without being written, which the "not saved yet" badge states.
 *
 * A row is a button: selecting it is what the on-canvas layer outlines, and the
 * click also walks the viewer to the mark's page. The comment body is editable
 * in place — a note that cannot be typed into is not a comment.
 */

import type { AnnotationKind, AnnotationMark, ExistingAnnotation } from 'pdf-core/ops/annotations';
import { annotationKindKey, commentText } from 'pdf-core/ops/annotations';
import type { Translator } from 'pdf-shared';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { PanelLoading, PanelMessage } from './PanelParts';

export interface CommentsPanelProps {
  readonly t: Translator;
  /** Marks held by the session; they reach the file on the next save. */
  readonly marks: readonly AnnotationMark[];
  /** Annotations already in the document, from `readAnnotations`. */
  readonly existing: readonly ExistingAnnotation[] | null;
  readonly selectedId?: string | null;
  readonly onSelect?: (id: string | null) => void;
  readonly onGoToPage: (pageIndex: number) => void;
  readonly onEdit?: (id: string, contents: string) => void;
  readonly onRemove?: (id: string) => void;
  readonly onClear?: () => void;
  /** Writes the session's marks as a file of their own (`annotation-data.ts`). */
  readonly onExportData?: (format: 'json' | 'fdf') => void;
  /** Reads a marks file back into the session; the shell owns the file dialog. */
  readonly onImportData?: (file: File) => void;
  readonly disabled?: boolean;
  /** Tool settings slot, supplied by the host (the panel owns no tool state). */
  readonly children?: ReactNode;
}

/** One row of the merged inventory. */
interface CommentRow {
  readonly id: string;
  readonly pageIndex: number;
  readonly kind: AnnotationKind;
  readonly color: string | null;
  readonly contents: string;
  readonly author: string;
  readonly pending: boolean;
  readonly selectable: boolean;
}

/**
 * Which kinds the filter shows. An annotation kind the engine reports but the app
 * has no vocabulary for (`kind === null`) stays visible under every filter — a
 * document's own annotations must never be hidden by a missing dictionary entry.
 */
const FILTERS: readonly AnnotationKind[] = [
  'highlight',
  'underline',
  'strikeout',
  'squiggly',
  'ink',
  'shapes',
  'note',
  'freetext',
];

export function CommentsPanel({
  t,
  marks,
  existing,
  selectedId,
  onSelect,
  onGoToPage,
  onEdit,
  onRemove,
  onClear,
  onExportData,
  onImportData,
  disabled,
  children,
}: CommentsPanelProps) {
  const [filter, setFilter] = useState<AnnotationKind | 'all'>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const rows = useMemo((): readonly CommentRow[] => {
    const pending: CommentRow[] = marks.map((mark) => ({
      id: mark.id,
      pageIndex: mark.pageIndex,
      kind: mark.kind,
      color: mark.color,
      contents: mark.contents,
      author: mark.author,
      pending: true,
      selectable: true,
    }));
    const saved: CommentRow[] = (existing ?? [])
      .filter((annotation) => annotation.kind !== null)
      .map((annotation) => ({
        id: annotation.id,
        pageIndex: annotation.pageIndex,
        kind: annotation.kind ?? 'note',
        color: null,
        contents: commentText(annotation.contents),
        author: annotation.author,
        pending: false,
        selectable: false,
      }));
    return [...pending, ...saved].sort((a, b) => a.pageIndex - b.pageIndex);
  }, [existing, marks]);

  const visible = filter === 'all' ? rows : rows.filter((row) => row.kind === filter);

  const commitEdit = useCallback(() => {
    if (editing === null) return;
    onEdit?.(editing, draft);
    setEditing(null);
    setDraft('');
  }, [draft, editing, onEdit]);

  // `existing === null` means the engine has not answered yet; with marks in hand
  // the panel still shows them, because the user's own work must never wait on a
  // document read.
  if (existing === null && marks.length === 0) return <PanelLoading />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {children}
      <div className="flex flex-wrap items-center gap-1 border-b border-kumo-line px-1.5 py-1">
        <label className="sr-only" htmlFor="ann-filter">
          {t('ann.filter')}
        </label>
        <select
          id="ann-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as AnnotationKind | 'all')}
          className="h-6 min-w-0 flex-1 rounded-sm border border-kumo-line bg-kumo-base px-1 text-[11px] text-kumo-default"
        >
          <option value="all">{t('ann.filter.all')}</option>
          {FILTERS.map((kind) => (
            <option key={kind} value={kind}>
              {t(annotationKindKey(kind))}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled === true || marks.length === 0}
          onClick={onClear}
          className="h-6 rounded-sm px-1.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
        >
          {t('ann.clear')}
        </button>
      </div>

      {/*
        The review as a file of its own (`PLAN.md §5/Phase 3`). A mark this app owns
        lives in the session until a save writes it, and the engine's own marks live
        in the engine's storage — so a review that has to move between machines needs
        its own export, not the PDF.
      */}
      <div className="flex flex-wrap items-center gap-1 border-b border-kumo-line px-1.5 py-1">
        <button
          type="button"
          disabled={disabled === true || marks.length === 0}
          onClick={() => onExportData?.('json')}
          className="h-6 rounded-sm px-1.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
        >
          {t('ann.data.exportJson')}
        </button>
        <button
          type="button"
          disabled={disabled === true || marks.length === 0}
          onClick={() => onExportData?.('fdf')}
          className="h-6 rounded-sm px-1.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
        >
          {t('ann.data.exportFdf')}
        </button>
        <label className="ml-auto flex h-6 cursor-pointer items-center rounded-sm px-1.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default">
          {t('ann.data.import')}
          <input
            type="file"
            accept="application/json,.json,.fdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // The input is reused: without this, picking the same file twice in a
              // row fires no change event and the second import silently does nothing.
              event.target.value = '';
              if (file !== undefined) onImportData?.(file);
            }}
          />
        </label>
      </div>

      <p aria-live="polite" className="sr-only">
        {t('ann.count', { count: visible.length, pending: marks.length })}
      </p>

      {visible.length === 0 ? (
        <PanelMessage text={t(marks.length === 0 ? 'ann.empty' : 'ann.emptyFilter')} />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1" aria-label={t('panel.comments')}>
          {visible.map((row) => {
            const isEditing = editing === row.id;
            return (
              <li key={row.id} className="mb-0.5">
                <div
                  className={`rounded-sm px-1.5 py-1 ${
                    selectedId === row.id
                      ? 'bg-kumo-tint outline outline-1 outline-kumo-focus'
                      : 'hover:bg-kumo-tint'
                  }`}
                >
                  <button
                    type="button"
                    aria-current={selectedId === row.id ? 'true' : undefined}
                    onClick={() => {
                      onSelect?.(selectedId === row.id ? null : row.id);
                      onGoToPage(row.pageIndex);
                    }}
                    className="w-full text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block size-2 shrink-0 rounded-full border border-kumo-line"
                        style={
                          row.color === null
                            ? { background: 'currentColor', opacity: 0.3 }
                            : { background: row.color }
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-kumo-default">
                        {t(annotationKindKey(row.kind))}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-kumo-subtle">
                        {t('ann.page', { page: row.pageIndex + 1 })}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-kumo-subtle">
                      {row.contents.length === 0 ? t('ann.noComment') : row.contents}
                      {row.author.length === 0 ? '' : ` — ${row.author}`}
                    </span>
                  </button>
                  <span className="mt-0.5 flex items-center gap-1">
                    {row.pending ? (
                      <span className="rounded-sm bg-kumo-tint px-1 text-[10px] text-kumo-subtle">
                        {t('ann.pending')}
                      </span>
                    ) : (
                      <span className="rounded-sm border border-kumo-line px-1 text-[10px] text-kumo-subtle">
                        {t('ann.inFile')}
                      </span>
                    )}
                    {row.pending && onEdit !== undefined ? (
                      <button
                        type="button"
                        disabled={disabled === true}
                        onClick={() => {
                          setEditing(isEditing ? null : row.id);
                          setDraft(row.contents);
                        }}
                        className="rounded-sm px-1 text-[10px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
                      >
                        {t(isEditing ? 'ann.editCancel' : 'ann.edit')}
                      </button>
                    ) : null}
                    {row.pending && onRemove !== undefined ? (
                      <button
                        type="button"
                        disabled={disabled === true}
                        onClick={() => onRemove(row.id)}
                        className="rounded-sm px-1 text-[10px] text-kumo-danger hover:bg-kumo-tint disabled:opacity-40"
                      >
                        {t('ann.remove')}
                      </button>
                    ) : null}
                  </span>
                </div>
                {isEditing ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitEdit();
                    }}
                    className="mt-1"
                  >
                    <label className="sr-only" htmlFor={`ann-comment-${row.id}`}>
                      {t('ann.comment')}
                    </label>
                    <textarea
                      id={`ann-comment-${row.id}`}
                      value={draft}
                      rows={2}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commitEdit}
                      className="w-full rounded-sm border border-kumo-line bg-kumo-base p-1 text-xs text-kumo-default outline-none focus:ring-1 focus:ring-kumo-focus"
                    />
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
