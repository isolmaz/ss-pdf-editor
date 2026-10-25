/**
 * How a running operation's progress becomes words.
 *
 * An operation reports `{ labelKey, done, total }` and the interface turns it into a
 * sentence in four places (the dialog's phase line, the floating activity bar, the compare
 * panel and a batch step). They share this one function because the report is not fit to
 * print as it stands:
 *
 *  - `done` is fractional while a step is part-way through a page (OCR reports
 *    `position + fraction` so the bar moves inside a page), and "2.4/10 pages" is not a
 *    sentence;
 *  - a label such as `ocr.running` carries `{page}`/`{total}` placeholders of its own, and
 *    the translator leaves a placeholder it was given no value for as raw text.
 *
 * So every surface passes the same whole-number params and none of them can show a `{done}`.
 */

import type { MessageKey, Translator } from './i18n';

/** What an operation reports, structurally: the shape of `pdf-core`'s `OperationProgress`. */
export interface ProgressReport {
  readonly labelKey: MessageKey;
  readonly done?: number | undefined;
  readonly total?: number | undefined;
}

/** The whole numbers a progress message may use as `{done}`, `{total}`, `{percent}`, `{page}`. */
export interface ProgressCounts {
  /** Steps finished, rounded down; never above `total`. */
  readonly done: number;
  /** The step count, `0` when the operation reports none. */
  readonly total: number;
  /** `0`–`100`, from the fractional `done`, so the figure moves inside a step too. */
  readonly percent: number;
  /** The step being worked on (`done + 1`), never past `total`; `1` when there is no total. */
  readonly page: number;
}

/** A figure that is not a finite number (NaN, an infinity) counts as nothing reported. */
const finiteOrZero = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) ? value : 0;

export function progressCounts(progress: Pick<ProgressReport, 'done' | 'total'>): ProgressCounts {
  const total = Math.max(0, Math.floor(finiteOrZero(progress.total)));
  const reached = Math.min(Math.max(finiteOrZero(progress.done), 0), total);
  const done = Math.floor(reached);
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((100 * reached) / total),
    page: Math.min(done + 1, Math.max(total, 1)),
  };
}

/** The sentence a progress report names, with its counters filled in. */
export function progressLabel(t: Translator, progress: ProgressReport): string {
  const { done, total, percent, page } = progressCounts(progress);
  return t(progress.labelKey, { done, total, percent, page });
}

/**
 * The sentence followed by `(done/total)` when the report has a step count. For the
 * surfaces that have no bar of their own to show the numbers beside the sentence.
 */
export function progressLine(t: Translator, progress: ProgressReport): string {
  const label = progressLabel(t, progress);
  const { done, total } = progressCounts(progress);
  return total === 0 ? label : t('op.progress', { label, done, total });
}
