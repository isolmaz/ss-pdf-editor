// @vitest-environment happy-dom
/**
 * The comments panel: the session's marks and the file's own annotations in one page-ordered
 * list, each marked saved or not; selecting a row selects the mark and walks the viewer to its
 * page; a comment can be edited in place, answered, given a review state and removed; the
 * file's reply and state records fold into the comment they answer instead of being rows.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnnotationMark, ExistingAnnotation } from 'pdf-core/ops/annotations';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentsPanel, type CommentsPanelProps } from './CommentsPanel';

afterEach(cleanup);

const t = createTranslator('en');

const mark = (overrides: Partial<AnnotationMark> = {}): AnnotationMark => ({
  id: 'm1',
  kind: 'highlight',
  pageIndex: 0,
  quads: [[0, 0, 10, 10]],
  color: '#ffee00',
  opacity: 0.4,
  contents: 'Check this',
  author: 'Ann',
  createdAt: '2026-05-01T10:00:00.000Z',
  ...overrides,
});

const saved = (overrides: Partial<ExistingAnnotation> = {}): ExistingAnnotation => ({
  id: '10R',
  subtype: 'Text',
  pageIndex: 1,
  kind: 'note',
  rect: null,
  contents: 'From the file',
  marker: null,
  author: 'Bob',
  modified: null,
  ...overrides,
});

const baseProps: CommentsPanelProps = { t, marks: [], existing: [], onGoToPage: () => {} };

const show = (props: Partial<CommentsPanelProps> = {}) => render(<CommentsPanel {...baseProps} {...props} />);

const rows = () => [...screen.getByRole('list', { name: 'Comments' }).children] as HTMLElement[];
const rowOf = (text: string) => screen.getByText(text, { exact: false }).closest('li') as HTMLElement;
const buttonIn = (row: HTMLElement, name: string) => within(row).getByRole('button', { name });

describe('CommentsPanel before the document answers', () => {
  it('shows a skeleton while there is neither a mark nor an answer', () => {
    const { container } = show({ existing: null });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows the marks of the session without waiting for the document', () => {
    show({ existing: null, marks: [mark()] });
    expect(rows()).toHaveLength(1);
    expect(screen.getByText('Check this — Ann')).toBeTruthy();
  });

  it('renders the tool settings slot above the list', () => {
    show({ children: <p>Tool settings</p> });
    expect(screen.getByText('Tool settings')).toBeTruthy();
  });
});

describe('CommentsPanel list', () => {
  it('says there are no comments, and how many are displayed and pending', () => {
    show();
    expect(
      screen.getByText('No comments added yet. Select a tool from the toolbar and mark on the page.'),
    ).toBeTruthy();
    expect(screen.getByText('0 comment(s) displayed; 0 pending save.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Comments' })).toBeNull();
  });

  it('merges marks and file annotations in page order, each with its kind, page, text and saved state', () => {
    show({
      marks: [
        mark({ id: 'm2', pageIndex: 2, kind: 'ink', contents: '', author: '', color: '#ff0000' }),
        mark(),
      ],
      existing: [saved()],
    });
    expect(rows().map((row) => row.querySelector('button')?.textContent)).toEqual([
      'Highlightp. 1Check this — Ann',
      'Notep. 2From the file — Bob',
      'Freehand drawingp. 3No comment',
    ]);
    const [first, second, third] = rows();
    expect(within(first as HTMLElement).getByText('unsaved')).toBeTruthy();
    expect(within(second as HTMLElement).getByText('in file')).toBeTruthy();
    expect(within(third as HTMLElement).getByText('unsaved')).toBeTruthy();
    expect(screen.getByText('3 comment(s) displayed; 2 pending save.')).toBeTruthy();
  });

  it('paints a mark in its own colour and a file annotation in a neutral one', () => {
    show({ marks: [mark()], existing: [saved()] });
    const dot = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>('[aria-hidden="true"]');
    const [markRow, fileRow] = rows();
    expect(dot(markRow)?.style.background).toBe('#ffee00');
    expect(dot(fileRow)?.style.background).toBe('currentcolor');
  });

  it('keeps a mark and a file annotation with the same id apart', () => {
    show({ marks: [mark({ id: '10R' })], existing: [saved()] });
    expect(rows()).toHaveLength(2);
  });

  it('lists no annotation the app has no word for', () => {
    show({ existing: [saved({ id: '11R', kind: null, contents: 'a widget' })] });
    expect(screen.queryByText(/a widget/)).toBeNull();
  });
});

describe('CommentsPanel selecting', () => {
  it('selects the row and walks the viewer to its page', async () => {
    const onSelect = vi.fn();
    const onGoToPage = vi.fn();
    show({ marks: [mark()], existing: [saved()], onSelect, onGoToPage });
    await userEvent.setup().click(screen.getByRole('button', { name: /From the file/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('10R');
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('marks the selected row, and a second click deselects it', async () => {
    const onSelect = vi.fn();
    show({ marks: [mark(), mark({ id: 'm2', pageIndex: 3 })], selectedId: 'm2', onSelect });
    const selected = screen.getByRole('button', { name: /p\. 4/ });
    expect(selected.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: /p\. 1/ }).hasAttribute('aria-current')).toBe(false);
    await userEvent.setup().click(selected);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('still walks to the page when the host does not track a selection', async () => {
    const onGoToPage = vi.fn();
    show({ marks: [mark({ pageIndex: 4 })], onGoToPage });
    await userEvent.setup().click(screen.getByRole('button', { name: /p\. 5/ }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(4);
  });
});

describe('CommentsPanel filter', () => {
  const kinds = [
    mark({ id: 'h', kind: 'highlight', contents: 'a highlight' }),
    mark({ id: 'n', kind: 'note', contents: 'a note' }),
  ];

  it('offers every kind and shows only the chosen one', async () => {
    show({ marks: kinds });
    const select = screen.getByRole('combobox', { name: 'Filter comment type' });
    expect([...(select as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
      'All',
      'Highlight',
      'Underline',
      'Strikeout',
      'Squiggly',
      'Freehand drawing',
      'Shape',
      'Note',
      'Text',
    ]);
    await userEvent.setup().selectOptions(select, 'Note');
    expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining('a note')]);
    expect(screen.getByText('1 comment(s) displayed; 2 pending save.')).toBeTruthy();

    await userEvent.setup().selectOptions(select, 'All');
    expect(rows()).toHaveLength(2);
  });

  it('says no comment matches when the filter hides every one', async () => {
    show({ marks: kinds });
    await userEvent
      .setup()
      .selectOptions(screen.getByRole('combobox', { name: 'Filter comment type' }), 'Shape');
    expect(screen.getByText('No comments match this filter.')).toBeTruthy();
  });

  it('says there are no comments rather than none match when the filter hides only file annotations', async () => {
    show({ existing: [saved()] });
    await userEvent
      .setup()
      .selectOptions(screen.getByRole('combobox', { name: 'Filter comment type' }), 'Shape');
    expect(
      screen.getByText('No comments added yet. Select a tool from the toolbar and mark on the page.'),
    ).toBeTruthy();
  });
});

describe('CommentsPanel clearing and exporting', () => {
  it('clears the marks of the session on request, and only when there are some', async () => {
    const onClear = vi.fn();
    const { unmount } = show({ onClear });
    expect(screen.getByRole('button', { name: 'Clear all' }).hasAttribute('disabled')).toBe(true);
    unmount();

    show({ marks: [mark()], onClear });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('exports the session as JSON, FDF or XFDF, naming the format', async () => {
    const onExportData = vi.fn();
    show({ marks: [mark()], onExportData });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export comments as JSON' }));
    await user.click(screen.getByRole('button', { name: 'Export comments as FDF' }));
    await user.click(screen.getByRole('button', { name: 'Export comments as XFDF' }));
    expect(onExportData.mock.calls).toEqual([['json'], ['fdf'], ['xfdf']]);
  });

  it('exports the file comments as XFDF with no mark in the session, but not as JSON or FDF', () => {
    show({ existing: [saved()], onExportData: () => {} });
    expect(screen.getByRole('button', { name: 'Export comments as JSON' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Export comments as FDF' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Export comments as XFDF' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('cannot export anything of an empty document', () => {
    show({ onExportData: () => {} });
    expect(screen.getByRole('button', { name: 'Export comments as XFDF' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('disables clearing and exporting while the host is busy', () => {
    show({ marks: [mark()], existing: [saved()], disabled: true, onClear: () => {}, onExportData: () => {} });
    for (const name of [
      'Clear all',
      'Export comments as JSON',
      'Export comments as FDF',
      'Export comments as XFDF',
    ]) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
  });

  it('presses on without a handler', async () => {
    show({ marks: [mark()] });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Export comments as JSON' }));
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(rows()).toHaveLength(1);
  });
});

describe('CommentsPanel importing', () => {
  const picker = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;

  it('hands the picked comments file to the host', async () => {
    const onImportData = vi.fn();
    const { container } = show({ onImportData });
    const file = new File(['{}'], 'comments.json', { type: 'application/json' });
    await userEvent.setup().upload(picker(container), file);
    expect(onImportData).toHaveBeenCalledExactlyOnceWith(file);
  });

  it('ignores a picker that closed without a file', () => {
    const onImportData = vi.fn();
    const { container } = show({ onImportData });
    fireEvent.change(picker(container), { target: { files: [] } });
    expect(onImportData).not.toHaveBeenCalled();
  });

  it('takes a pick without a handler as nothing to do', async () => {
    const { container } = show();
    await userEvent
      .setup()
      .upload(picker(container), new File(['{}'], 'comments.json', { type: 'application/json' }));
    expect(screen.getByText('0 comment(s) displayed; 0 pending save.')).toBeTruthy();
  });
});

describe('CommentsPanel editing', () => {
  it('offers editing and removal for session marks only, when the host handles them', () => {
    show({ marks: [mark()], existing: [saved()], onEdit: () => {}, onRemove: () => {} });
    const [markRow, fileRow] = rows() as [HTMLElement, HTMLElement];
    expect(within(markRow).getByRole('button', { name: 'Edit comment' })).toBeTruthy();
    expect(within(markRow).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(fileRow).queryByRole('button', { name: 'Edit comment' })).toBeNull();
    expect(within(fileRow).queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('offers neither without a handler', () => {
    show({ marks: [mark()] });
    expect(screen.queryByRole('button', { name: 'Edit comment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('removes the mark the row names', async () => {
    const onRemove = vi.fn();
    show({ marks: [mark(), mark({ id: 'm2', pageIndex: 1, contents: 'second' })], onRemove });
    await userEvent.setup().click(buttonIn(rowOf('second'), 'Delete'));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('m2');
  });

  it('edits the text in place and commits it when the box loses focus', async () => {
    const onEdit = vi.fn();
    show({ marks: [mark()], onEdit });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit comment' }));
    const box = screen.getByRole('textbox', { name: 'Comment text' });
    expect((box as HTMLTextAreaElement).value).toBe('Check this');

    await user.clear(box);
    await user.type(box, 'Rewritten');
    await user.tab();
    expect(onEdit).toHaveBeenCalledExactlyOnceWith('m1', 'Rewritten');
    expect(screen.queryByRole('textbox', { name: 'Comment text' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit comment' })).toBeTruthy();
  });

  it('turns the edit button into Cancel while editing, and closes the box with it', async () => {
    show({ marks: [mark()], onEdit: () => {} });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit comment' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Comment text' })).toBeNull();
  });

  it('disables the row controls while the host is busy', () => {
    show({
      marks: [mark()],
      disabled: true,
      onEdit: () => {},
      onRemove: () => {},
      onReply: () => {},
      onSetState: () => {},
    });
    const row = rows()[0] as HTMLElement;
    for (const name of ['Edit comment', 'Delete', 'Reply']) {
      expect(buttonIn(row, name).hasAttribute('disabled')).toBe(true);
    }
    expect(within(row).getByRole('combobox').hasAttribute('disabled')).toBe(true);
  });
});

describe('CommentsPanel replying', () => {
  const target = { pending: true, id: 'm1', pageIndex: 0 };

  it('offers a reply only when the host takes one', () => {
    show({ marks: [mark()] });
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('sends the trimmed reply for the comment of the row, and closes the box', async () => {
    const onReply = vi.fn();
    show({ marks: [mark()], onReply });
    const user = userEvent.setup();
    const open = screen.getByRole('button', { name: 'Reply' });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await user.click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');

    const box = screen.getByRole('textbox', { name: 'Your reply' });
    expect(document.activeElement).toBe(box);
    await user.type(box, '  Agreed  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onReply).toHaveBeenCalledExactlyOnceWith(target, 'Agreed');
    expect(screen.queryByRole('textbox', { name: 'Your reply' })).toBeNull();
  });

  it('addresses a reply to a file comment by its id and page', async () => {
    const onReply = vi.fn();
    show({ existing: [saved()], onReply });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox', { name: 'Your reply' }), 'Thanks');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onReply).toHaveBeenCalledExactlyOnceWith({ pending: false, id: '10R', pageIndex: 1 }, 'Thanks');
  });

  it('sends with Ctrl+Enter, and not with a bare Enter or another key', async () => {
    const onReply = vi.fn();
    show({ marks: [mark()], onReply });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    const box = screen.getByRole('textbox', { name: 'Your reply' });
    await user.type(box, 'Fine');
    await user.keyboard('{Enter}');
    expect(onReply).not.toHaveBeenCalled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onReply).toHaveBeenCalledExactlyOnceWith(target, 'Fine');
  });

  it('sends with Meta+Enter as well', async () => {
    const onReply = vi.fn();
    show({ marks: [mark()], onReply });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox', { name: 'Your reply' }), 'Fine');
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onReply).toHaveBeenCalledExactlyOnceWith(target, 'Fine');
  });

  it('sends nothing for an empty reply, however it is submitted', async () => {
    const onReply = vi.fn();
    show({ marks: [mark()], onReply });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByRole('textbox', { name: 'Your reply' }), '   ');
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onReply).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Your reply' })).toBeTruthy();
  });

  it('closes the box on Escape or Cancel, and on a second press of Reply', async () => {
    show({ marks: [mark()], onReply: () => {} });
    const user = userEvent.setup();
    const reply = screen.getByRole('button', { name: 'Reply' });
    const box = () => screen.queryByRole('textbox', { name: 'Your reply' });

    await user.click(reply);
    await user.keyboard('{Escape}');
    expect(box()).toBeNull();

    await user.click(reply);
    await user.click(
      within(screen.getByRole('textbox', { name: 'Your reply' }).closest('form') as HTMLElement).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    expect(box()).toBeNull();

    await user.click(reply);
    expect(box()).not.toBeNull();
    await user.click(reply);
    expect(box()).toBeNull();
  });

  it('opens one box at a time, and starts each empty', async () => {
    show({ marks: [mark(), mark({ id: 'm2', pageIndex: 1, contents: 'second' })], onReply: () => {} });
    const user = userEvent.setup();
    const [first, second] = screen.getAllByRole('button', { name: 'Reply' }) as [HTMLElement, HTMLElement];
    await user.click(first);
    await user.type(screen.getByRole('textbox', { name: 'Your reply' }), 'draft');
    await user.click(second);
    expect(screen.getAllByRole('textbox', { name: 'Your reply' })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: 'Your reply' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('cannot send while the host is busy', async () => {
    const onReply = vi.fn();
    const { rerender } = show({ marks: [mark()], onReply });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reply' }));
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Your reply' }), 'text');
    rerender(<CommentsPanel {...baseProps} marks={[mark()]} onReply={onReply} disabled />);
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('CommentsPanel review state', () => {
  const targetOf = { pending: true, id: 'm1', pageIndex: 0 };

  it('offers the review states and reports the one picked for the comment of the row', async () => {
    const onSetState = vi.fn();
    show({ marks: [mark()], onSetState });
    const select = screen.getByRole('combobox', { name: 'Review status' });
    expect([...(select as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
      'No status',
      'Accepted',
      'Rejected',
      'Cancelled',
      'Completed',
    ]);
    expect((select as HTMLSelectElement).value).toBe('None');
    expect(select.getAttribute('title')).toBe('Review status');
    await userEvent.setup().selectOptions(select, 'Rejected');
    expect(onSetState).toHaveBeenCalledExactlyOnceWith(targetOf, 'Rejected');
  });

  it('shows the state of a comment with who set it, or just the state when nobody is named', () => {
    show({
      marks: [
        mark({ review: { state: 'Accepted', author: 'Cara', at: '2026-05-01T10:00:00.000Z' } }),
        mark({
          id: 'm2',
          pageIndex: 1,
          review: { state: 'Completed', author: ' ', at: '2026-05-01T10:00:00.000Z' },
        }),
        mark({
          id: 'm3',
          pageIndex: 2,
          review: { state: 'None', author: 'Dan', at: '2026-05-01T10:00:00.000Z' },
        }),
      ],
      onSetState: () => {},
    });
    const [accepted, completed, none] = screen.getAllByRole('combobox', {
      name: 'Review status',
    }) as HTMLSelectElement[];
    expect([accepted?.value, accepted?.title]).toEqual(['Accepted', 'Accepted · Cara']);
    expect([completed?.value, completed?.title]).toEqual(['Completed', 'Completed']);
    expect([none?.value, none?.title]).toEqual(['None', 'Review status']);
  });

  it('keeps a state the file spells in its own way visible, named as no status', () => {
    show({
      existing: [
        saved({ id: '1R' }),
        saved({
          id: '2R',
          inReplyTo: '1R',
          replyType: 'R',
          state: 'Weird',
          stateModel: 'Review',
          author: 'Eve',
        }),
      ],
      onSetState: () => {},
    });
    const select = screen.getByRole('combobox', { name: 'Review status' }) as HTMLSelectElement;
    expect(select.value).toBe('Weird');
    expect([...select.options].at(-1)?.textContent).toBe('Weird');
    expect(select.title).toBe('No status · Eve');
  });

  it('names a state the file spells in its own way as no status when nobody set it by name', () => {
    show({
      existing: [
        saved({ id: '1R' }),
        saved({
          id: '2R',
          inReplyTo: '1R',
          replyType: 'R',
          state: 'Weird',
          stateModel: 'Review',
          author: '',
        }),
      ],
      onSetState: () => {},
    });
    expect(screen.getByRole('combobox', { name: 'Review status' }).getAttribute('title')).toBe('No status');
  });

  it('reports a state change of a file comment by its id', async () => {
    const onSetState = vi.fn();
    show({ existing: [saved()], onSetState });
    await userEvent
      .setup()
      .selectOptions(screen.getByRole('combobox', { name: 'Review status' }), 'Accepted');
    expect(onSetState).toHaveBeenCalledExactlyOnceWith(
      { pending: false, id: '10R', pageIndex: 1 },
      'Accepted',
    );
  });

  it('shows the state as a plain label when the host cannot set one', () => {
    show({
      marks: [
        mark({ review: { state: 'Rejected', author: 'Cara', at: '2026-05-01T10:00:00.000Z' } }),
        mark({ id: 'm2', pageIndex: 1 }),
        mark({
          id: 'm3',
          pageIndex: 2,
          review: { state: 'None', author: 'Dan', at: '2026-05-01T10:00:00.000Z' },
        }),
      ],
    });
    expect(screen.queryByRole('combobox', { name: 'Review status' })).toBeNull();
    expect(screen.getAllByText('Rejected')).toHaveLength(1);
    expect(screen.queryByText('No status')).toBeNull();
  });

  it('shows a state the file spells in its own way as no status when the host cannot set one', () => {
    show({
      existing: [
        saved({ id: '1R' }),
        saved({ id: '2R', inReplyTo: '1R', replyType: 'R', state: 'Weird', stateModel: 'Review' }),
      ],
    });
    expect(screen.getByText('No status')).toBeTruthy();
  });
});

describe('CommentsPanel threads', () => {
  it('folds the file replies and states into the comment they answer, in order, with their depth', () => {
    show({
      existing: [
        saved({ id: '1R', contents: 'Root comment' }),
        saved({
          id: '2R',
          inReplyTo: '1R',
          replyType: 'R',
          contents: 'Second',
          author: 'Cara',
          modified: 'D:20260502000000',
        }),
        saved({
          id: '3R',
          inReplyTo: '1R',
          replyType: 'R',
          contents: 'First',
          author: '',
          modified: 'D:20260501000000',
        }),
        saved({
          id: '4R',
          inReplyTo: '2R',
          replyType: 'R',
          contents: 'Nested',
          author: 'Dan',
          modified: 'D:20260503000000',
        }),
        saved({
          id: '5R',
          inReplyTo: '1R',
          replyType: 'R',
          state: 'Accepted',
          stateModel: 'Review',
          author: 'Eve',
          modified: 'D:20260504000000',
        }),
        saved({
          id: '6R',
          inReplyTo: '1R',
          replyType: 'R',
          state: 'Marked',
          stateModel: 'Marked',
          author: 'Fay',
          modified: 'D:20260505000000',
        }),
      ],
    });
    expect(rows()).toHaveLength(1);
    const thread = screen.getByRole('list', { name: '3 replies' });
    const replies = within(thread).getAllByRole('listitem');
    expect(replies.map((reply) => reply.textContent)).toEqual(['First', 'Cara: Second', 'Dan: Nested']);
    expect(replies.map((reply) => reply.style.marginLeft)).toEqual(['0px', '0px', '8px']);
    expect(screen.getByText('Accepted')).toBeTruthy();
    expect(screen.getByText('Marked')).toBeTruthy();
  });

  it('keeps a reply to a comment the file no longer has as a row of its own', () => {
    show({ existing: [saved({ id: '2R', inReplyTo: '9R', replyType: 'R', contents: 'Orphan reply' })] });
    expect(rowOf('Orphan reply')).toBeTruthy();
  });

  it('lists the replies a session mark carries, and removes the one the button names', async () => {
    const onRemoveReply = vi.fn();
    show({
      marks: [
        mark({
          replies: [
            { id: 'r1', author: 'Gus', contents: 'One', createdAt: '2026-05-01T10:00:00.000Z' },
            { id: 'r2', author: '', contents: 'Two', createdAt: '2026-05-01T11:00:00.000Z' },
          ],
        }),
      ],
      onRemoveReply,
    });
    const replies = within(screen.getByRole('list', { name: '2 replies' })).getAllByRole('listitem');
    expect(replies.map((reply) => reply.textContent)).toEqual(['Gus: One×', 'Two×']);
    await userEvent
      .setup()
      .click(within(replies[1] as HTMLElement).getByRole('button', { name: 'Delete reply' }));
    expect(onRemoveReply).toHaveBeenCalledExactlyOnceWith({ pending: true, id: 'm1', pageIndex: 0 }, 'r2');
  });

  it('removes a reply the file carries by the comment it answers and its own id', async () => {
    const onRemoveReply = vi.fn();
    show({
      existing: [
        saved({ id: '1R' }),
        saved({ id: '2R', inReplyTo: '1R', replyType: 'R', contents: 'A reply' }),
      ],
      onRemoveReply,
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete reply' }));
    expect(onRemoveReply).toHaveBeenCalledExactlyOnceWith({ pending: false, id: '1R', pageIndex: 1 }, '2R');
  });

  it('shows replies without a way to remove them when the host gives none, and disabled while busy', () => {
    const replies = [{ id: 'r1', author: 'Gus', contents: 'One', createdAt: '2026-05-01T10:00:00.000Z' }];
    const { rerender } = show({ marks: [mark({ replies })] });
    expect(screen.getByText('One')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete reply' })).toBeNull();

    rerender(<CommentsPanel {...baseProps} marks={[mark({ replies })]} onRemoveReply={() => {}} disabled />);
    expect(screen.getByRole('button', { name: 'Delete reply' }).hasAttribute('disabled')).toBe(true);
  });
});
