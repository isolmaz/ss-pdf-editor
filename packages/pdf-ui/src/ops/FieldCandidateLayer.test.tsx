// @vitest-environment happy-dom
/**
 * The review of detected form fields: a frame per candidate, over the place the page asks
 * to be written in, that the user selects, and removes with the ✕ or with Delete.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FieldCandidate } from 'pdf-core/ops/form-detect';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { FieldCandidateLayer } from './FieldCandidateLayer';

afterEach(cleanup);

/** Page 0 is a 600 × 800 pt page drawn at 50 % at (100, 50); page 1 is not on screen. */
const viewer = {
  pageGeometry: (index: number) =>
    index === 0 ? { x: 0, y: 0, width: 600, height: 800, rotation: 0 as const } : null,
  pageRect: (index: number) => (index === 0 ? { x: 100, y: 50, width: 300, height: 400 } : null),
  containerRect: () => ({ x: 0, y: 0, width: 1000, height: 1000 }),
} as unknown as ViewerApi;

function candidate(overrides: Partial<FieldCandidate> = {}): FieldCandidate {
  return {
    id: 'c1',
    kind: 'text',
    pageIndex: 0,
    rect: [100, 200, 300, 260],
    name: 'Email',
    label: 'Email',
    confidence: 'high',
    source: 'label',
    size: 12,
    ...overrides,
  } as FieldCandidate;
}

function show(candidates: readonly FieldCandidate[], selectedId: string | null = null) {
  const onSelect = vi.fn();
  const onRemove = vi.fn();
  render(
    <FieldCandidateLayer
      t={createTranslator('en')}
      viewer={viewer}
      layout={0}
      candidates={candidates}
      selectedId={selectedId}
      onSelect={onSelect}
      onRemove={onRemove}
    />,
  );
  return { onSelect, onRemove };
}

describe('FieldCandidateLayer', () => {
  it('draws each candidate as a frame over its place on the page, named by its kind and page', () => {
    show([candidate()]);
    const frame = screen.getByRole('button', { name: 'Email — Text, page 1' });
    expect(frame.getAttribute('data-kind')).toBe('text');
    expect(frame.getAttribute('data-name')).toBe('Email');
    expect(frame.parentElement?.style.cssText).toBe('left: 150px; top: 150px; width: 100px; height: 30px;');
  });

  it('draws a detected field solid and an inferred one dashed, a radio button round', () => {
    show([
      candidate({ id: 'a', name: 'Name' }),
      candidate({ id: 'b', name: 'Choice', kind: 'radio', confidence: 'medium' }),
    ]);
    const solid = screen.getByRole('button', { name: 'Name — Text, page 1' });
    const dashed = screen.getByRole('button', { name: 'Choice — Radio group, page 1' });
    expect(solid.className).not.toContain('border-dashed');
    expect(solid.className).toContain('rounded-[2px]');
    expect(dashed.className).toContain('border-dashed');
    expect(dashed.className).toContain('rounded-full');
  });

  it('marks the selected frame as pressed and no other', () => {
    show([candidate({ id: 'a', name: 'Name' }), candidate({ id: 'b', name: 'City' })], 'b');
    expect(screen.getByRole('button', { name: 'Name — Text, page 1' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'City — Text, page 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('draws nothing for a candidate on a page that is not on screen or whose frame has no area', () => {
    show([
      candidate({ id: 'off', name: 'Off', pageIndex: 1 }),
      candidate({ id: 'flat', name: 'Flat', rect: [100, 200, 100, 260] }),
      candidate({ id: 'thin', name: 'Thin', rect: [100, 200, 300, 200] }),
      candidate({ id: 'ok', name: 'Kept' }),
    ]);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Kept — Text, page 1',
      'Remove the field Kept',
    ]);
  });

  it('selects a frame by click and by focus', async () => {
    const { onSelect } = show([candidate()]);
    const frame = screen.getByRole('button', { name: 'Email — Text, page 1' });
    await userEvent.click(frame);
    expect(onSelect).toHaveBeenCalledWith('c1');
    onSelect.mockClear();
    frame.blur();
    frame.focus();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it.each(['{Delete}', '{Backspace}'])('removes the focused frame with %s', async (key) => {
    const { onRemove } = show([candidate()]);
    screen.getByRole('button', { name: 'Email — Text, page 1' }).focus();
    await userEvent.keyboard(key);
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('keeps the frame on any other key', async () => {
    const { onRemove } = show([candidate()]);
    screen.getByRole('button', { name: 'Email — Text, page 1' }).focus();
    await userEvent.keyboard('a{Escape}');
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('removes a candidate with the ✕ at its corner, without taking the focus off the page', async () => {
    const { onRemove, onSelect } = show([candidate()]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove the field Email' }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('c1');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
