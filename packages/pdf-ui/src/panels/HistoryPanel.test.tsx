// @vitest-environment happy-dom
/**
 * The history panel: the journal's steps as a labelled list, the cursor marked as the current
 * step, steps past the cursor shown as redoable, and undo/redo as the only controls. Entry
 * params arrive as JSON; only scalars reach the sentence, and a nested payload leaves the
 * placeholder visible rather than printing `[object Object]`.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JournalEntry, JsonValue } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryPanel, type HistoryPanelProps } from './HistoryPanel';

afterEach(cleanup);

const t = createTranslator('en');

const entry = (seq: number, labelKey: string, labelParams?: JsonValue): JournalEntry => ({
  id: `entry-${seq}`,
  seq,
  labelKey,
  ...(labelParams === undefined ? {} : { labelParams }),
  engine: 'model',
  op: { kind: 'test', payload: null },
  schema: 2,
  timestamp: seq,
});

function show(props: Partial<HistoryPanelProps> = {}) {
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  render(<HistoryPanel t={t} entries={[]} cursor={0} onUndo={onUndo} onRedo={onRedo} {...props} />);
  return { onUndo, onRedo, user: userEvent.setup() };
}

const undo = () => screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
const redo = () => screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;

describe('HistoryPanel', () => {
  it('says there is no history and offers neither undo nor redo for an empty journal', () => {
    show();
    expect(screen.getByText('No operation history for this document.')).toBeTruthy();
    expect(screen.getByText('0 step(s) can be undone · 0 step(s) can be redone')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(true);
  });

  it('lists the steps in order, marks the cursor step as current and counts the redoable tail', async () => {
    const entries = [
      entry(1, 'op.undo'),
      entry(2, 'op.note.a11y.pageNoBlocks', { page: 3 }),
      entry(3, 'op.redo'),
    ];
    const { onUndo, onRedo, user } = show({ entries, cursor: 2 });

    const list = screen.getByRole('list', { name: 'History' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      '1Undo',
      '2Page 3 not tagged: no text layer.',
      '3Redo',
    ]);
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(screen.getByText('2 step(s) can be undone · 1 step(s) can be redone')).toBeTruthy();

    await user.click(undo());
    await user.click(redo());
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
  });

  it('disables redo at the end of the journal and undo at its start', () => {
    show({ entries: [entry(1, 'op.undo')], cursor: 1 });
    expect(undo().disabled).toBe(false);
    expect(redo().disabled).toBe(true);
    cleanup();
    show({ entries: [entry(1, 'op.undo')], cursor: 0 });
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(false);
  });

  it('keeps scalar params and drops anything nested, leaving its placeholder visible', () => {
    show({
      entries: [
        entry(1, 'op.note.a11y.pageOverlap', { page: 4, skipped: true, extra: { deep: 1 }, none: null }),
        entry(2, 'op.note.a11y.pageOverlap', { page: 'five', skipped: [1, 2] }),
      ],
      cursor: 2,
    });
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toBe('1Page 4: true overlapping span(s) skipped.');
    expect(items[1]?.textContent).toBe('2Page five: {skipped} overlapping span(s) skipped.');
  });

  it('leaves every placeholder visible when the params are not an object or hold no scalar', () => {
    show({
      entries: [
        entry(1, 'op.note.a11y.pageNoBlocks', null),
        entry(2, 'op.note.a11y.pageNoBlocks', [3]),
        entry(3, 'op.note.a11y.pageNoBlocks', 'page 3'),
        entry(4, 'op.note.a11y.pageNoBlocks', { page: { deep: 3 } }),
      ],
      cursor: 4,
    });
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '1Page {page} not tagged: no text layer.',
      '2Page {page} not tagged: no text layer.',
      '3Page {page} not tagged: no text layer.',
      '4Page {page} not tagged: no text layer.',
    ]);
  });
});
