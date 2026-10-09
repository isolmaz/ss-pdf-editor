/**
 * Answering a comment: a reply or a review state (`ops/annotation-review.ts`), and taking a
 * reply back. The comments feature owns no state — the marks are the session's pending
 * overlay and the file's own comments are read from the document — so this is a set of
 * handlers over what the shell hands in.
 */

import type { ReviewRecordRequest } from 'pdf-core/ops/annotation-review';
import type { AnnotationMark, ReviewState } from 'pdf-core/ops/annotations';
import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { ReviewTarget } from 'pdf-ui/panels';
import { markTargetKey } from 'pdf-ui/tools';
import { useMemo } from 'react';
import { showNotice } from '../core/core-store';
import type { OverlayChange } from '../core/overlays';
import type { WriteFileAnnotation } from '../marks/host';

/** What the handlers need from the shell. */
export interface ReviewHost {
  readonly session: Pick<SessionStore, 'active' | 'setDirty'>;
  readonly t: Translator;
  /** Who a new reply or state is by (the annotation author the user typed, possibly empty). */
  readonly author: string;
  readonly setAnnotations: (change: OverlayChange<readonly AnnotationMark[]>) => void;
  readonly writeFileAnnotation: WriteFileAnnotation;
  readonly removeTargets: (keys: readonly string[]) => unknown;
}

export type ReviewAnswer =
  | { readonly kind: 'reply'; readonly contents: string }
  | { readonly kind: 'state'; readonly state: ReviewState };

/**
 * A reply or a review state for a comment. A mark the session holds keeps it until the mark
 * itself is written (`writeAnnotationsToFile`); a comment the file already carries gets it
 * written now, as one journal step that undo takes back whole.
 */
export function answerComment(host: ReviewHost, target: ReviewTarget, answer: ReviewAnswer): void {
  const { author, t } = host;
  const createdAt = new Date().toISOString();
  if (target.pending) {
    host.setAnnotations((current) =>
      current.map((mark) => {
        if (mark.id !== target.id) return mark;
        if (answer.kind === 'reply') {
          return {
            ...mark,
            replies: [
              ...(mark.replies ?? []),
              { id: crypto.randomUUID(), author, contents: answer.contents, createdAt },
            ],
          };
        }
        return { ...mark, review: { state: answer.state, author, at: createdAt } };
      }),
    );
    const id = host.session.active?.id;
    if (id !== undefined) host.session.setDirty(id, true);
    showNotice(
      answer.kind === 'reply'
        ? t('ann.reply.pendingDone')
        : author.trim() === ''
          ? t(`ann.state.${answer.state}`)
          : t('ann.state.by', { state: t(`ann.state.${answer.state}`), author }),
    );
    return;
  }
  const record: ReviewRecordRequest =
    answer.kind === 'reply'
      ? {
          kind: 'reply',
          pageIndex: target.pageIndex,
          parentId: target.id,
          id: crypto.randomUUID(),
          author,
          createdAt,
          contents: answer.contents,
        }
      : {
          kind: 'state',
          pageIndex: target.pageIndex,
          parentId: target.id,
          id: crypto.randomUUID(),
          author,
          createdAt,
          state: answer.state,
        };
  host.writeFileAnnotation(
    { key: answer.kind === 'reply' ? 'ann.reply.added' : 'ann.state.changed' },
    async (base, signal) => {
      // Loaded on the first file-comment answer: the review writer stays out of the entry chunk.
      const { writeCommentReview } = await import('pdf-core/ops/annotation-review');
      return writeCommentReview(base, [record], { signal });
    },
    answer.kind === 'reply'
      ? t('ann.reply.done')
      : t('ann.state.done', { state: t(`ann.state.${answer.state}`) }),
  );
}

/**
 * Take a reply back: one the session holds leaves its mark, one the file carries goes
 * through the removal intent (one journal step, the same undo as a Delete).
 */
export function removeReply(host: ReviewHost, target: ReviewTarget, replyId: string): void {
  if (target.pending) {
    host.setAnnotations((current) =>
      current.map((mark) =>
        mark.id === target.id
          ? { ...mark, replies: (mark.replies ?? []).filter((reply) => reply.id !== replyId) }
          : mark,
      ),
    );
    return;
  }
  host.removeTargets([markTargetKey('existing', replyId, target.pageIndex)]);
}

/** The three callbacks the comments panel takes for answering. */
export interface CommentReview {
  readonly onReply: (target: ReviewTarget, contents: string) => void;
  readonly onSetState: (target: ReviewTarget, state: ReviewState) => void;
  readonly onRemoveReply: (target: ReviewTarget, replyId: string) => void;
}

/** The three callbacks the comments panel takes for answering, bound to the shell's host. */
export function useCommentReview(host: ReviewHost): CommentReview {
  const { session, t, author, setAnnotations, writeFileAnnotation, removeTargets } = host;
  return useMemo(() => {
    const bound: ReviewHost = { session, t, author, setAnnotations, writeFileAnnotation, removeTargets };
    return {
      onReply: (target: ReviewTarget, contents: string) =>
        answerComment(bound, target, { kind: 'reply', contents }),
      onSetState: (target: ReviewTarget, state: ReviewState) =>
        answerComment(bound, target, { kind: 'state', state }),
      onRemoveReply: (target: ReviewTarget, replyId: string) => removeReply(bound, target, replyId),
    };
  }, [session, t, author, setAnnotations, writeFileAnnotation, removeTargets]);
}
