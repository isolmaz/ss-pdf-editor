/**
 * Comments and annotations.
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
 *
 * A comment is a thread: its replies are listed under it and its review state beside
 * it (`ops/annotation-review.ts`). The file's reply and state records are folded into
 * the comment they answer instead of being listed as comments of their own; a reply to
 * a comment the file no longer has stays a row, so nothing the file carries is hidden.
 */

import { commentThreads } from 'pdf-core/ops/annotation-threads';
import type {
  AnnotationKind,
  AnnotationMark,
  ExistingAnnotation,
  ReviewState,
} from 'pdf-core/ops/annotations';
import { annotationKindKey, REVIEW_STATES } from 'pdf-core/ops/annotations';
import type { MessageKey, Translator } from 'pdf-shared';
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
  /**
   * Writes the review as a file of its own: the session's marks as JSON or FDF
   * (`annotation-data.ts`), or the file's comments and the session's together as XFDF
   * (`annotation-xfdf.ts`).
   */
  readonly onExportData?: (format: 'json' | 'fdf' | 'xfdf') => void;
  /** Reads a marks file back into the session; the shell owns the file dialog. */
  readonly onImportData?: (file: File) => void;
  /** Answers a comment: a session mark keeps the reply, a file comment gets it written. */
  readonly onReply?: (target: ReviewTarget, contents: string) => void;
  /** Sets a comment's review state, the same way as a reply. */
  readonly onSetState?: (target: ReviewTarget, state: ReviewState) => void;
  /** Removes a reply: one the session holds, or one the file carries (by its id). */
  readonly onRemoveReply?: (target: ReviewTarget, replyId: string) => void;
  readonly disabled?: boolean;
  /** Tool settings slot, supplied by the host (the panel owns no tool state). */
  readonly children?: ReactNode;
}

/** The comment a reply or a state is for: a session mark, or a file annotation by id. */
export interface ReviewTarget {
  readonly pending: boolean;
  readonly id: string;
  readonly pageIndex: number;
}

/** One reply as the panel lists it. */
interface ReplyRow {
  readonly id: string;
  readonly author: string;
  readonly contents: string;
  readonly depth: number;
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
  readonly replies: readonly ReplyRow[];
  /** The newest review state and who set it; `null` when none (or `None`) was set. */
  readonly review: { readonly state: string; readonly author: string } | null;
  readonly marked: boolean;
}

/** The message key of a review state the file may spell in any way. */
function stateKey(state: string): MessageKey | null {
  return REVIEW_STATES.includes(state as ReviewState) || state === 'Marked'
    ? (`ann.state.${state}` as MessageKey)
    : null;
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
  onReply,
  onSetState,
  onRemoveReply,
  disabled,
  children,
}: CommentsPanelProps) {
  const [filter, setFilter] = useState<AnnotationKind | 'all'>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replying, setReplying] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');

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
      replies: (mark.replies ?? []).map((reply) => ({
        id: reply.id,
        author: reply.author,
        contents: reply.contents,
        depth: 1,
      })),
      review:
        mark.review === undefined || mark.review.state === 'None'
          ? null
          : { state: mark.review.state, author: mark.review.author },
      marked: false,
    }));
    const { threads, records } = commentThreads(existing ?? []);
    const saved: CommentRow[] = (existing ?? [])
      .filter((annotation) => annotation.kind !== null && !records.has(annotation.id))
      .map((annotation) => {
        const thread = threads.get(annotation.id);
        return {
          id: annotation.id,
          pageIndex: annotation.pageIndex,
          kind: annotation.kind ?? 'note',
          color: null,
          contents: annotation.contents,
          author: annotation.author,
          pending: false,
          selectable: false,
          replies: (thread?.replies ?? []).map((reply) => ({
            id: reply.annotation.id,
            author: reply.annotation.author,
            contents: reply.annotation.contents,
            depth: reply.depth,
          })),
          review:
            thread?.review === null || thread?.review === undefined || thread.review.state === 'None'
              ? null
              : { state: thread.review.state, author: thread.review.author },
          marked: thread?.marked === true,
        };
      });
    return [...pending, ...saved].sort((a, b) => a.pageIndex - b.pageIndex);
  }, [existing, marks]);

  const sendReply = useCallback(
    (row: CommentRow) => {
      const contents = replyDraft.trim();
      if (contents === '') return;
      onReply?.({ pending: row.pending, id: row.id, pageIndex: row.pageIndex }, contents);
      setReplying(null);
      setReplyDraft('');
    },
    [onReply, replyDraft],
  );

  const visible = filter === 'all' ? rows : rows.filter((row) => row.kind === filter);
  const fileComments = rows.length - marks.length;

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
        The review as a file of its own. A mark this app owns
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
        {/* XFDF carries the file's own comments too, so it needs no session mark. */}
        <button
          type="button"
          disabled={disabled === true || (marks.length === 0 && fileComments === 0)}
          onClick={() => onExportData?.('xfdf')}
          className="h-6 rounded-sm px-1.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
        >
          {t('ann.data.exportXfdf')}
        </button>
        <label className="ms-auto flex h-6 cursor-pointer items-center rounded-sm px-1.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default">
          {t('ann.data.import')}
          <input
            type="file"
            accept="application/json,.json,.fdf,.xfdf,application/vnd.adobe.xfdf"
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
              // A session mark and a file annotation are two id spaces; the key keeps them apart.
              <li key={`${row.pending ? 'session' : 'file'}:${row.id}`} className="mb-0.5">
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
                    className="w-full text-start"
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
                  <span className="mt-0.5 flex flex-wrap items-center gap-1">
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
                        className="whitespace-nowrap rounded-sm px-1 text-[10px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
                      >
                        {t(isEditing ? 'ann.editCancel' : 'ann.edit')}
                      </button>
                    ) : null}
                    {row.pending && onRemove !== undefined ? (
                      <button
                        type="button"
                        disabled={disabled === true}
                        onClick={() => onRemove(row.id)}
                        className="whitespace-nowrap rounded-sm px-1 text-[10px] text-kumo-danger hover:bg-kumo-tint disabled:opacity-40"
                      >
                        {t('ann.remove')}
                      </button>
                    ) : null}
                    {onReply !== undefined ? (
                      <button
                        type="button"
                        disabled={disabled === true}
                        aria-expanded={replying === row.id}
                        onClick={() => {
                          setReplying(replying === row.id ? null : row.id);
                          setReplyDraft('');
                        }}
                        className="whitespace-nowrap rounded-sm px-1 text-[10px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
                      >
                        {t('ann.reply')}
                      </button>
                    ) : null}
                    {row.marked ? (
                      <span className="rounded-sm border border-kumo-line px-1 text-[10px] text-kumo-subtle">
                        {t('ann.state.Marked')}
                      </span>
                    ) : null}
                    {onSetState !== undefined ? (
                      <>
                        <label className="sr-only" htmlFor={`ann-state-${row.id}`}>
                          {t('ann.state.label')}
                        </label>
                        <select
                          id={`ann-state-${row.id}`}
                          disabled={disabled === true}
                          value={row.review?.state ?? 'None'}
                          title={
                            row.review === null
                              ? t('ann.state.label')
                              : t('ann.state.by', {
                                  state: t(stateKey(row.review.state) ?? 'ann.state.None'),
                                  author: row.review.author,
                                })
                          }
                          onChange={(event) =>
                            onSetState(
                              { pending: row.pending, id: row.id, pageIndex: row.pageIndex },
                              event.target.value as ReviewState,
                            )
                          }
                          className="ms-auto h-5 min-w-0 rounded-sm border border-kumo-line bg-kumo-base px-0.5 text-[10px] text-kumo-default disabled:opacity-40"
                        >
                          {REVIEW_STATES.map((state) => (
                            <option key={state} value={state}>
                              {t(`ann.state.${state}` as MessageKey)}
                            </option>
                          ))}
                          {/* A state the file spells that the picker has no entry for stays visible. */}
                          {row.review !== null && stateKey(row.review.state) === null ? (
                            <option value={row.review.state}>{row.review.state}</option>
                          ) : null}
                        </select>
                      </>
                    ) : row.review !== null ? (
                      <span className="rounded-sm border border-kumo-line px-1 text-[10px] text-kumo-subtle">
                        {t(stateKey(row.review.state) ?? 'ann.state.None')}
                      </span>
                    ) : null}
                  </span>
                  {row.replies.length > 0 ? (
                    <ul
                      className="mt-1 flex flex-col gap-0.5 border-s border-kumo-line ps-1.5"
                      aria-label={t('ann.reply.count', { count: row.replies.length })}
                    >
                      {row.replies.map((reply) => (
                        <li
                          key={reply.id}
                          className="flex items-start gap-1 text-[11px] text-kumo-default"
                          style={{ marginLeft: `${(reply.depth - 1) * 8}px` }}
                        >
                          <span className="min-w-0 flex-1 break-words">
                            {reply.author.length === 0 ? null : (
                              <span className="font-medium text-kumo-subtle">{reply.author}: </span>
                            )}
                            {reply.contents}
                          </span>
                          {onRemoveReply !== undefined ? (
                            <button
                              type="button"
                              disabled={disabled === true}
                              aria-label={t('ann.reply.remove')}
                              title={t('ann.reply.remove')}
                              onClick={() =>
                                onRemoveReply(
                                  { pending: row.pending, id: row.id, pageIndex: row.pageIndex },
                                  reply.id,
                                )
                              }
                              className="shrink-0 rounded-sm px-1 text-[10px] text-kumo-danger hover:bg-kumo-tint disabled:opacity-40"
                            >
                              ×
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {replying === row.id ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        sendReply(row);
                      }}
                      className="mt-1 flex flex-col gap-1"
                    >
                      <label className="sr-only" htmlFor={`ann-reply-${row.id}`}>
                        {t('ann.reply.label')}
                      </label>
                      <textarea
                        id={`ann-reply-${row.id}`}
                        value={replyDraft}
                        rows={2}
                        // biome-ignore lint/a11y/noAutofocus: the field opens on the user's own click.
                        autoFocus
                        placeholder={t('ann.reply.label')}
                        onChange={(event) => setReplyDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                            event.preventDefault();
                            sendReply(row);
                          } else if (event.key === 'Escape') {
                            setReplying(null);
                          }
                        }}
                        className="w-full rounded-sm border border-kumo-line bg-kumo-base p-1 text-xs text-kumo-default outline-none focus:ring-1 focus:ring-kumo-focus"
                      />
                      <span className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setReplying(null)}
                          className="h-6 rounded-sm px-1.5 text-[11px] text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
                        >
                          {t('ann.reply.cancel')}
                        </button>
                        <button
                          type="submit"
                          disabled={disabled === true || replyDraft.trim() === ''}
                          className="h-6 rounded-sm border border-kumo-line px-2 text-[11px] font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-40"
                        >
                          {t('ann.reply.send')}
                        </button>
                      </span>
                    </form>
                  ) : null}
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
