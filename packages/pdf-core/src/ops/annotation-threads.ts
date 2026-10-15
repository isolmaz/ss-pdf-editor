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

/**
 * `D:YYYYMMDDHHmmSS` with the time zone a PDF writes after it (`Z`, `+02'00'`, `-0530`,
 * `+03`): every part after the year is optional (ISO 32000-1 §7.9.4), the whole string must
 * be a date.
 */
const PDF_DATE =
  /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:Z(?:\d{2}'?(?:\d{2}'?)?)?|([+-])(\d{2})'?(\d{2})?'?)?$/i;

/**
 * A PDF date as milliseconds since the epoch, or `null` when it is not one.
 *
 * This is the one reader every comment path uses (the thread list, the Acrobat FDF and
 * the XFDF imports). Each field is checked for what it is — month 1–12, a day the month
 * has, hour 0–23, minute and second 0–59 — because `Date.UTC` would roll `D:20241301`
 * into 2025 and `new Date(...)` of the same text would refuse it with a `RangeError`; an
 * impossible date is no date, and the comment that carries it is still read. The zone is
 * applied: `D:20261002080000+02'00'` is 06:00 UTC. A date without a zone is taken as UTC.
 */
export function parsePdfDate(raw: string): number | null {
  const match = PDF_DATE.exec(raw.trim());
  if (match === null) return null;
  const [, year = '', month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match;
  const [sign, zoneHour = '00', zoneMinute = '00'] = match.slice(7);
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  // `setUTCFullYear` takes the year as written: `Date.UTC(99, …)` would mean 1999.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  // A day the month does not have (the 30th of February) rolls into the next month.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  if (sign === undefined) return date.getTime();
  const zoneH = Number(zoneHour);
  const zoneM = Number(zoneMinute);
  if (zoneH > 23 || zoneM > 59) return null;
  return date.getTime() - (sign === '-' ? -1 : 1) * (zoneH * 60 + zoneM) * 60_000;
}

/** Milliseconds since the epoch as a PDF date (`D:YYYYMMDDHHmmSSZ`); `null` when no such date can name it. */
export function formatPdfDate(millis: number): string | null {
  const date = new Date(millis);
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 1 || year > 9999) return null;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `D:${pad(year, 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** A PDF date or ISO 8601 → milliseconds; `0` for anything unreadable. */
export function reviewDateMillis(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const text = raw.trim();
  if (text.startsWith('D:')) return parsePdfDate(text) ?? 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
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
