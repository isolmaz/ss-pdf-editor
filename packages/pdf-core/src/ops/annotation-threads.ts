/**
 * Comment threads as the file's annotations describe them: which annotations are
 * replies and review states (`/IRT`), which comment each answers, and the state a
 * comment is in now. Pure, so the comment list and the selection layer can read it
 * without loading a PDF engine; the writer is `annotation-review.ts`.
 */

import type { ExistingAnnotation } from './annotations';

/** The thread around one comment of the file. */
export interface CommentThread {
  /** Replies (not state records), oldest first; `depth` 1 answers the comment itself. */
  readonly replies: readonly { readonly annotation: ExistingAnnotation; readonly depth: number }[];
  /** The newest `Review` state, or `null` when none was ever set. */
  readonly review: { readonly state: string; readonly author: string; readonly at: string | null } | null;
  /** The newest `Marked` state is `Marked`. */
  readonly marked: boolean;
  /** Ids of every record in the thread, replies and states alike — what goes with the comment. */
  readonly records: readonly string[];
}

/** `D:YYYYMMDDHHmmSS` (or ISO 8601) → milliseconds; `0` for anything unreadable. */
export function reviewDateMillis(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw.trim());
  if (match === null) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

/**
 * Every reply and state record of the file, keyed by the comment its chain of `/IRT`s
 * ends at, plus the set of record ids — the rows a comment list folds into a thread
 * instead of listing on their own.
 *
 * A record whose chain ends at an annotation that is not in the list (a reply to a
 * removed comment) is not folded anywhere: it stays a row of its own, so nothing the
 * file carries disappears from the list. `/RT /Group` annotations are grouped with
 * another one, not replies, and stay rows too.
 */
export function commentThreads(existing: readonly ExistingAnnotation[]): {
  readonly threads: ReadonlyMap<string, CommentThread>;
  readonly records: ReadonlySet<string>;
} {
  const byId = new Map<string, ExistingAnnotation>();
  for (const annotation of existing) byId.set(annotation.id, annotation);
  const isRecord = (
    annotation: ExistingAnnotation,
  ): annotation is ExistingAnnotation & { inReplyTo: string } =>
    annotation.inReplyTo !== undefined && annotation.replyType !== 'Group';

  const records = new Set<string>();
  const grouped = new Map<string, { annotation: ExistingAnnotation; depth: number }[]>();
  for (const annotation of existing) {
    if (!isRecord(annotation)) continue;
    let target = byId.get(annotation.inReplyTo);
    let depth = 1;
    const seen = new Set<string>([annotation.id]);
    while (target !== undefined && isRecord(target) && !seen.has(target.id)) {
      seen.add(target.id);
      depth += 1;
      target = byId.get(target.inReplyTo);
    }
    if (target === undefined || isRecord(target)) continue;
    records.add(annotation.id);
    const list = grouped.get(target.id) ?? [];
    list.push({ annotation, depth });
    grouped.set(target.id, list);
  }

  const threads = new Map<string, CommentThread>();
  for (const [rootId, list] of grouped) {
    const when = (annotation: ExistingAnnotation) =>
      reviewDateMillis(annotation.modified ?? annotation.created ?? null);
    const ordered = [...list].sort((a, b) => when(a.annotation) - when(b.annotation));
    const replies = ordered.filter((item) => item.annotation.state === undefined);
    const reviews = ordered.flatMap(({ annotation }) =>
      annotation.state !== undefined && (annotation.stateModel ?? 'Review') === 'Review'
        ? [{ annotation, state: annotation.state }]
        : [],
    );
    const marks = ordered.filter((item) => item.annotation.stateModel === 'Marked');
    const latest = reviews.at(-1);
    threads.set(rootId, {
      replies,
      review:
        latest === undefined
          ? null
          : {
              state: latest.state,
              author: latest.annotation.author,
              at: latest.annotation.modified ?? latest.annotation.created ?? null,
            },
      marked: marks.at(-1)?.annotation.state === 'Marked',
      records: list.map((item) => item.annotation.id),
    });
  }
  return { threads, records };
}
