/**
 * The decisions behind a page action and an undo/redo press: what a gate answers for every
 * combination of the four facts it reads, which pages an action means, which queued steps may
 * carry on, and which sentence the status line says.
 */

import { createTranslator, ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  failureNotice,
  historyNotice,
  historyPress,
  operationGate,
  pageSelection,
  stillCurrent,
} from './history-plan';

const t = createTranslator('en');
const READY = { hasDocument: true, canEdit: true, running: false, busy: false } as const;

describe('operationGate', () => {
  it('runs on an editable, idle document', () => {
    expect(operationGate(READY)).toBe('run');
  });

  it('is not the operation to answer with no document, no right to edit, or one already running', () => {
    expect(operationGate({ ...READY, hasDocument: false })).toBe('ignore');
    expect(operationGate({ ...READY, canEdit: false })).toBe('ignore');
    expect(operationGate({ ...READY, running: true })).toBe('ignore');
    // Not being allowed wins over being busy: a read-only document is not "busy".
    expect(operationGate({ ...READY, canEdit: false, busy: true })).toBe('ignore');
  });

  it('refuses a busy document out loud', () => {
    expect(operationGate({ ...READY, busy: true })).toBe('refuse');
  });
});

describe('pageSelection', () => {
  it('prefers the pages a control names, then the panel selection, then the page on screen', () => {
    expect(pageSelection([4], [1, 2], 7)).toEqual([4]);
    expect(pageSelection(undefined, [1, 2], 7)).toEqual([1, 2]);
    expect(pageSelection([], [1, 2], 7)).toEqual([1, 2]);
    expect(pageSelection(undefined, [], 7)).toEqual([7]);
    expect(pageSelection([], [], 0)).toEqual([0]);
  });
});

describe('historyPress', () => {
  const idle = { hasDocument: true, queued: false, sweeping: false, running: false, busy: false } as const;

  it('queues a press on an idle document', () => {
    expect(historyPress(idle)).toBe('queue');
  });

  it('declines a press with no document, whatever else is going on', () => {
    expect(historyPress({ ...idle, hasDocument: false, busy: true })).toBe('decline');
  });

  it('refuses a press while an operation holds the document', () => {
    expect(historyPress({ ...idle, busy: true })).toBe('refuse');
    expect(historyPress({ ...idle, running: true })).toBe('refuse');
  });

  it('queues behind pending steps or a sweep in flight instead of refusing', () => {
    expect(historyPress({ ...idle, busy: true, queued: true })).toBe('queue');
    expect(historyPress({ ...idle, running: true, queued: true })).toBe('queue');
    expect(historyPress({ ...idle, busy: true, sweeping: true })).toBe('queue');
  });
});

describe('stillCurrent', () => {
  const handle = {};

  it('carries on only for the same tab on the same handle', () => {
    expect(stillCurrent('tab', 'tab', handle, handle)).toBe(true);
    expect(stillCurrent('other', 'tab', handle, handle)).toBe(false);
    expect(stillCurrent(undefined, 'tab', handle, handle)).toBe(false);
    expect(stillCurrent('tab', 'tab', {}, handle)).toBe(false);
  });

  it('stops for a tab with no handle, even when both sides lack one', () => {
    expect(stillCurrent('tab', 'tab', undefined, undefined)).toBe(false);
  });
});

describe('failureNotice', () => {
  it('says the tool error’s own message and hint', () => {
    const error = new ToolError('aborted', { engine: 'model' });
    expect(failureNotice(error, t)).toBe(`${t(error.messageKey)} ${t(error.hintKey)}`);
  });

  it('says the internal-error sentence for anything else', () => {
    const internal = new ToolError('internal', { engine: 'model' });
    expect(failureNotice(new TypeError('boom'), t)).toBe(`${t(internal.messageKey)} ${t(internal.hintKey)}`);
  });
});

describe('historyNotice', () => {
  it('names the step undone or redone, with its parameters', () => {
    const entry = { labelKey: 'pages.rotate.done', labelParams: { count: 2 } };
    const label = t('pages.rotate.done', { count: 2 });
    expect(historyNotice('undo', entry, t)).toBe(t('op.undo.done', { label }));
    expect(historyNotice('redo', entry, t)).toBe(t('op.redo.done', { label }));
  });

  it('names a step that has no parameters', () => {
    const label = t('op.step.pages');
    expect(historyNotice('undo', { labelKey: 'op.step.pages' }, t)).toBe(t('op.undo.done', { label }));
  });
});
