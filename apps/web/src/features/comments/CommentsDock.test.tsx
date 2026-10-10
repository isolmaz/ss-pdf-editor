// @vitest-environment happy-dom
/**
 * The comments tab of the right dock: its own name stands in while the panel chunk loads, then
 * the panel gets exactly the props the shell passed. The panel itself is `pdf-ui`'s and is tested
 * there; importing the real `pdf-ui/panels` barrel here would load every panel of the app, so a
 * small stand-in marks the boundary.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { CommentsPanelProps } from 'pdf-ui/panels';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentsDock } from './CommentsDock';

vi.mock('pdf-ui/panels', () => ({
  CommentsPanel: ({ t, marks, onReply }: CommentsPanelProps) => (
    <section aria-label={t('panel.comments')}>
      <ul>
        {marks.map((mark) => (
          <li key={mark.id}>{mark.contents}</li>
        ))}
      </ul>
      <button type="button" onClick={() => onReply?.({ pending: true, id: 'a', pageIndex: 1 }, 'Fixed')}>
        Reply
      </button>
    </section>
  ),
}));

const t = createTranslator('en');

afterEach(cleanup);

describe('CommentsDock', () => {
  it('names the panel while it loads, then shows the panel with the shell’s props', async () => {
    const onReply = vi.fn();
    const user = userEvent.setup();
    const marks = [{ id: 'a', contents: 'Check this figure' }] as unknown as CommentsPanelProps['marks'];
    render(<CommentsDock t={t} marks={marks} existing={[]} onGoToPage={vi.fn()} onReply={onReply} />);

    const loading = screen.getByText('Comments');
    expect(loading.getAttribute('aria-busy')).toBe('true');

    expect(await screen.findByText('Check this figure')).toBeTruthy();
    expect(screen.queryByText('Comments')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalledWith({ pending: true, id: 'a', pageIndex: 1 }, 'Fixed');
  });
});
