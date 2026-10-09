/**
 * The decisions behind a page action and an undo/redo press, with nothing they act on: what
 * the gate answers, which pages an action means, which sentence the status line says. The
 * handlers in `page-actions.ts` read the live state and call these; every rule here is a
 * function of the values it is handed.
 */

import { ToolError, type Translator } from 'pdf-shared';

/** What a gate says about an operation the user just asked for. */
export type Gate = 'ignore' | 'refuse' | 'run';

/** What the shell knows at the moment an operation is asked for. */
export interface GateInput {
  /** A document is open and has an engine handle. */
  readonly hasDocument: boolean;
  /** The open document accepts edits. */
  readonly canEdit: boolean;
  /** An operation already holds a cancel controller. */
  readonly running: boolean;
  /** The busy gate is held. */
  readonly busy: boolean;
}

/**
 * Whether an operation on the open document may start. With no document, no right to edit or a
 * controller already registered, the press is not the operation's to answer (`ignore`); a busy
 * document is refused out loud (`refuse`).
 */
export function operationGate(input: GateInput): Gate {
  if (!input.hasDocument || !input.canEdit || input.running) return 'ignore';
  return input.busy ? 'refuse' : 'run';
}

/**
 * The pages an action means: a control that names its pages (a thumbnail's own rotate or delete)
 * wins; else the page panel's selection; else the page on screen — the status-bar rotate and
 * the context menu act on "this page".
 */
export function pageSelection(
  named: readonly number[] | undefined,
  selected: readonly number[],
  current: number,
): readonly number[] {
  if (named !== undefined && named.length > 0) return named;
  return selected.length > 0 ? selected : [current];
}

/** What an undo/redo key press does. */
export type HistoryPress = 'decline' | 'refuse' | 'queue';

/**
 * A press with no document is declined (the key is left to whatever owns it). A press that
 * arrives while another step is pending, or while an orphan sweep is still settling, is
 * queued; otherwise a busy document refuses it.
 */
export function historyPress(input: {
  readonly hasDocument: boolean;
  /** History steps are already pending behind this press. */
  readonly queued: boolean;
  /** An orphan sweep is in flight. */
  readonly sweeping: boolean;
  readonly running: boolean;
  readonly busy: boolean;
}): HistoryPress {
  if (!input.hasDocument) return 'decline';
  if (!input.queued && !input.sweeping && (input.busy || input.running)) return 'refuse';
  return 'queue';
}

/**
 * Whether a queued step may carry on: the tab it was pressed on is still the active one and
 * still renders the handle it expects.
 */
export function stillCurrent(
  activeId: string | undefined,
  tabId: string,
  now: unknown,
  expected: unknown,
): boolean {
  return activeId === tabId && now !== undefined && now === expected;
}

/** The status line for a failure: the tool's own words, or the internal-error ones. */
export function failureNotice(error: unknown, t: Translator): string {
  const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
  return `${t(failure.messageKey)} ${t(failure.hintKey)}`;
}

/** The status line after an undo or redo moved the history. */
export function historyNotice(
  direction: 'undo' | 'redo',
  entry: { readonly labelKey: string; readonly labelParams?: unknown },
  t: Translator,
): string {
  const label = t(
    entry.labelKey as Parameters<Translator>[0],
    (entry.labelParams ?? {}) as Readonly<Record<string, string | number>>,
  );
  return t(direction === 'undo' ? 'op.undo.done' : 'op.redo.done', { label });
}
