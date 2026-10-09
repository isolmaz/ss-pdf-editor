// @vitest-environment happy-dom
/**
 * The form-detection panel: one button before a scan, a busy state during it, and a review of
 * what was found: counts split by confidence, the notes on what the detector could not read,
 * a row per kept candidate with its source, kind and page, removal and restoring, and the
 * add / cancel / detect-again actions. The panel holds no state; the shell does.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FieldCandidate, FormDetection } from 'pdf-core/ops/form-detect';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormDetectPanel, type FormDetectPanelProps } from './FormDetectPanel';

afterEach(cleanup);

const t = createTranslator('en');

const candidate = (id: string, overrides: Partial<FieldCandidate> = {}): FieldCandidate => ({
  id,
  kind: 'text',
  pageIndex: 0,
  rect: [0, 0, 10, 10],
  name: `Name ${id}`,
  label: `Label ${id}`,
  confidence: 'high',
  source: 'line',
  size: 10,
  ...overrides,
});

const detection = (overrides: Partial<FormDetection> = {}): FormDetection => ({
  candidates: [],
  pageCount: 3,
  needsOcr: [],
  rasterPages: [],
  alreadyFields: 0,
  truncated: false,
  ...overrides,
});

function show(props: Partial<FormDetectPanelProps> = {}) {
  const handlers = {
    onDetect: vi.fn(),
    onCancel: vi.fn(),
    onApply: vi.fn(),
    onRemove: vi.fn(),
    onRestore: vi.fn(),
    onSelect: vi.fn(),
  };
  const view = render(
    <FormDetectPanel
      t={t}
      phase="review"
      detection={detection()}
      removed={new Set()}
      selectedId={null}
      disabled={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view, user: userEvent.setup() };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('FormDetectPanel: before the review', () => {
  it('offers to detect, with a sentence on what that does', async () => {
    const { user, onDetect, container } = show({ phase: 'idle' });
    expect(container.querySelector('[data-form-detect="idle"]')).not.toBeNull();
    expect(
      screen.getByText(
        'Guess where a form without fields is meant to be filled in, review the guesses, and add them as real form fields.',
      ),
    ).toBeTruthy();
    await user.click(button('Detect fields'));
    expect(onDetect).toHaveBeenCalledOnce();
  });

  it('cannot start while editing is not allowed', () => {
    show({ phase: 'idle', disabled: true });
    expect(button('Detect fields').disabled).toBe(true);
  });

  it('says it is scanning and cannot be started again meanwhile', () => {
    const { container } = show({ phase: 'scanning' });
    expect(container.querySelector('[data-form-detect="scanning"]')).not.toBeNull();
    expect(screen.getByText('Scanning pages…')).toBeTruthy();
    expect(button('Detect fields').disabled).toBe(true);
    expect(button('Detect fields').getAttribute('aria-busy')).toBe('true');
  });

  it('shows the start state when a review has no detection to show', () => {
    show({ phase: 'review', detection: null });
    expect(button('Detect fields').disabled).toBe(false);
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('FormDetectPanel: the review', () => {
  it('says nothing was found and offers no list and no guidance', async () => {
    const { user, onCancel, onApply, onDetect } = show();
    expect(screen.getByText('No place to fill in was found in this document.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/Look over the frames/)).toBeNull();
    expect(button('Add 0 fields').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Bring removed fields back' })).toBeNull();

    await user.click(button('Cancel'));
    await user.click(button('Detect again'));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onDetect).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('counts what is kept by confidence and lists one row per candidate', async () => {
    const candidates = [
      candidate('a'),
      candidate('b', { confidence: 'medium', kind: 'checkbox', source: 'square', pageIndex: 2 }),
      candidate('c', { kind: 'radio', source: 'circle', option: 'Yes', group: 'g' }),
    ];
    const { user, onSelect, onRemove, onApply } = show({
      detection: detection({ candidates }),
      selectedId: 'b',
    });
    expect(screen.getByText('3 fields found: 2 labelled, 1 guessed.')).toBeTruthy();
    expect(screen.getByText(/Look over the frames on the page/)).toBeTruthy();

    const rows = within(screen.getByRole('list', { name: 'Detected fields' })).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('button')?.textContent)).toEqual([
      'Name aLabelledText · 1',
      'Name bGuessedCheckbox · 3',
      'Name c · YesLabelledRadio group · 1',
    ]);
    expect(rows.map((row) => row.querySelector('button')?.getAttribute('title'))).toEqual([
      'line',
      'square',
      'circle',
    ]);
    expect(rows.map((row) => row.querySelector('button')?.getAttribute('aria-current'))).toEqual([
      null,
      'true',
      null,
    ]);
    const confidence = (row: HTMLElement) =>
      row.querySelector('button span:nth-child(2)')?.getAttribute('title');
    expect(confidence(rows[0] as HTMLElement)).toBe('There is a label beside it and a drawn place to write.');
    expect(confidence(rows[1] as HTMLElement)).toBe(
      'The label or the place was inferred (a caption under a line, a label ending in a colon, a table header…).',
    );

    await user.click(rows[1]?.querySelector('button') as HTMLElement);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('b');
    await user.click(button('Remove the field Name c'));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('c');
    await user.click(button('Add 3 fields'));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('leaves removed candidates out of the list and the counts, and offers to bring them back', async () => {
    const candidates = [candidate('a'), candidate('b', { confidence: 'medium' }), candidate('c')];
    const { user, onRestore } = show({
      detection: detection({ candidates }),
      removed: new Set(['a']),
    });
    expect(screen.getByText('2 fields found: 1 labelled, 1 guessed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove the field Name a' })).toBeNull();
    expect(button('Add 2 fields').disabled).toBe(false);
    await user.click(button('Bring removed fields back'));
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('says no fields are left once every candidate was removed', () => {
    show({ detection: detection({ candidates: [candidate('a')] }), removed: new Set(['a']) });
    expect(screen.getByText('0 fields found: 0 labelled, 0 guessed.')).toBeTruthy();
    expect(button('No fields left to add.').disabled).toBe(true);
    expect(within(screen.getByRole('list', { name: 'Detected fields' })).queryAllByRole('listitem')).toEqual(
      [],
    );
  });

  it('disables adding and detecting again while editing is not allowed, but never cancelling', () => {
    show({ detection: detection({ candidates: [candidate('a')] }), disabled: true });
    expect(button('Add 1 fields').disabled).toBe(true);
    expect(button('Detect again').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(false);
  });

  it('states what the detector could not read, with 1-based page numbers', () => {
    show({
      detection: detection({
        candidates: [candidate('a')],
        needsOcr: [0, 4],
        rasterPages: [2],
        alreadyFields: 5,
        truncated: true,
      }),
    });
    expect(screen.getAllByRole('note').map((note) => note.textContent)).toEqual([
      '1, 5 page(s) are only a picture with no text; there is no label to name a field from, so they were skipped. Run OCR first.',
      '3 page(s) are scans: only horizontal lines were read from the pixels; boxes and circles cannot be found and the fields are guesses.',
      '5 place(s) skipped because a form field is already there.',
      'There are too many candidates; the first 1 are listed.',
    ]);
  });

  it('shows no notes when there is nothing to say', () => {
    show({ detection: detection({ candidates: [candidate('a')] }) });
    expect(screen.queryAllByRole('note')).toEqual([]);
  });
});
