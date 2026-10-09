// @vitest-environment happy-dom
/**
 * The redaction mark list: how many marks there are, each mark on its 1-based page (with what
 * it covers when the tool knows), removing one or all, and the active tool's settings beneath.
 * Without a tool the panel says so; without marks it says how to make the first.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedactionPanel, type RedactionPanelProps } from './RedactionPanel';

afterEach(cleanup);

const t = createTranslator('en');

function show(props: Partial<RedactionPanelProps> = {}) {
  const onRemove = vi.fn();
  const onClear = vi.fn();
  render(<RedactionPanel t={t} marks={[]} onRemove={onRemove} onClear={onClear} {...props} />);
  return { onRemove, onClear, user: userEvent.setup() };
}

describe('RedactionPanel', () => {
  it('explains how to make the first mark, offers nothing to clear and says no tool is active', () => {
    show();
    expect(screen.getByText('0 mark(s)')).toBeTruthy();
    expect(screen.getByText('No marks yet. Draw a box on the page.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Clear marks' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('No active tool.')).toBeTruthy();
  });

  it('lists each mark on its 1-based page, naming a mark by what it covers when the tool knows', async () => {
    const { onRemove, onClear, user } = show({
      marks: [
        { id: 'a', pageIndex: 0, labelKey: 'op.note.a11y.pageNoBlocks', labelParams: { page: 7 } },
        { id: 'b', pageIndex: 4 },
      ],
    });
    expect(screen.getByText('2 mark(s)')).toBeTruthy();
    const items = within(screen.getByRole('list', { name: 'Marks' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Page 7 not tagged: no text layer.Page 1',
      'Page 5',
    ]);

    await user.click(screen.getByRole('button', { name: 'Remove mark: Page 5' }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('b');
    await user.click(screen.getByRole('button', { name: 'Remove mark: Page 1' }));
    expect(onRemove).toHaveBeenLastCalledWith('a');

    await user.click(screen.getByRole('button', { name: 'Clear marks' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('shows the active tool settings under the heading instead of the no-tool sentence', () => {
    show({ children: <button type="button">Image handling</button> });
    const settings = screen.getByRole('region', { name: 'Tool settings' });
    expect(within(settings).getByRole('heading', { name: 'Tool settings' })).toBeTruthy();
    expect(within(settings).getByRole('button', { name: 'Image handling' })).toBeTruthy();
    expect(screen.queryByText('No active tool.')).toBeNull();
  });
});
