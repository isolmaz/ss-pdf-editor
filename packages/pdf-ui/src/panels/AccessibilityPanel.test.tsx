// @vitest-environment happy-dom
/**
 * The accessibility panel: three views behind one tab strip, the open one kept in the
 * reading-order store so it survives a remount. The report view keeps "found a problem",
 * "could not check" and "checked, nothing found" apart and always lists what the check did not
 * look at; it writes tags and figure alt text through the shell's own handlers and then marks
 * itself stale; a failure is a message and a notice; nothing is published for a panel that
 * has closed. The checker and the writers have their own suites, so they answer here with what
 * their contracts describe; the PDF/UA and tags views have theirs, so they are stood in for
 * by views that only hand their props and callbacks over.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccessibilityReport } from 'pdf-core/ops/accessibility';
import type { OperationNote } from 'pdf-core/ops/types';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityPanel, type AccessibilityPanelProps } from './AccessibilityPanel';
import type { WrittenOutcome } from './PdfUaView';
import { readingOrderStore } from './reading-order-store';

const engine = vi.hoisted(() => ({
  checkAccessibility: vi.fn(),
  setImageAlt: vi.fn(),
  tagDocument: vi.fn(),
}));
vi.mock('pdf-core/ops/accessibility', () => engine);

/**
 * A view stand-in: lists the props it was given (functions by name, the rest by value) and
 * hands each callback to a button named after it, with a fixed argument.
 */
const stub = vi.hoisted(() => {
  const CALLS: Record<string, (props: Record<string, (...args: unknown[]) => unknown>) => unknown> = {
    read: (props) => props.read?.({ signal: new AbortController().signal }),
    onGoToPage: (props) => props.onGoToPage?.(2),
    onWritten: (props) => props.onWritten?.({ bytes: new Uint8Array([7]), notes: [], steps: ['s'] }),
    onNotice: (props) => props.onNotice?.('notice'),
    onOpenElement: (props) => props.onOpenElement?.('node-9', 4),
  };
  return (
    h: (type: string, props: object, ...children: unknown[]) => unknown,
    name: string,
    props: Record<string, unknown>,
  ) => {
    const keys = Object.keys(props).sort();
    const values = keys
      .filter((key) => key !== 't' && typeof props[key] !== 'function')
      .map((key) => `${key}=${String(props[key])}`)
      .join(';');
    return h(
      'div',
      { 'data-testid': `view-${name}`, 'data-props': keys.join(','), 'data-values': values },
      ...keys
        .filter((key) => typeof props[key] === 'function' && key in CALLS)
        .map((key) => h('button', { type: 'button', key, onClick: () => CALLS[key]?.(props as never) }, key)),
    );
  };
});
vi.mock('./PdfUaView', async () => {
  const { createElement } = await import('react');
  return { PdfUaView: (props: Record<string, unknown>) => stub(createElement as never, 'ua', props) };
});
vi.mock('./TagsView', async () => {
  const { createElement } = await import('react');
  return { TagsView: (props: Record<string, unknown>) => stub(createElement as never, 'tags', props) };
});

const t = createTranslator('en');
const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  for (const fn of Object.values(engine)) fn.mockReset();
  readingOrderStore.setView('report');
  readingOrderStore.clear();
});
afterEach(cleanup);

const report = (overrides: Partial<AccessibilityReport> = {}): AccessibilityReport => ({
  pageCount: 4,
  findings: [],
  checked: [],
  notChecked: ['op.note.a11y.formsNotTagged'],
  images: [],
  fields: [],
  structure: { present: false } as AccessibilityReport['structure'],
  ...overrides,
});

const outcome = (notes: OperationNote[] = []) => ({
  bytes: new Uint8Array([9]),
  report: { notes, steps: ['step-a'] },
});

function show(props: Partial<AccessibilityPanelProps> = {}) {
  const read = vi.fn(async () => BYTES);
  const view = render(<AccessibilityPanel t={t} read={read} language="en" {...props} />);
  return { read, ...view, user: userEvent.setup() };
}

const audit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Audit' }));

describe('AccessibilityPanel: the report view', () => {
  it('says the audit has not been run, and runs it on the bytes on screen', async () => {
    engine.checkAccessibility.mockResolvedValue(report());
    const { user, read } = show();
    expect(screen.getByText('Audit has not been run yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Accessibility', level: 3 })).toBeTruthy();

    await audit(user);
    await screen.findByText('4 page(s) · 0 issue(s) · 0 unknown');
    expect(read).toHaveBeenCalledOnce();
    expect(engine.checkAccessibility).toHaveBeenCalledExactlyOnceWith(BYTES, {
      signal: expect.any(AbortSignal),
    });
    expect(screen.queryByText('Audit has not been run yet.')).toBeNull();
  });

  it('shows a loading state, and holds the Audit button, while the first audit runs', async () => {
    let resolve: (value: AccessibilityReport) => void = () => {};
    engine.checkAccessibility.mockReturnValue(
      new Promise<AccessibilityReport>((done) => {
        resolve = done;
      }),
    );
    const { user, container } = show();
    await audit(user);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Audit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('Audit has not been run yet.')).toBeNull();

    await act(async () => resolve(report()));
    expect((screen.getByRole('button', { name: 'Audit' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps problems, unchecked items and clean checks in their own groups, with pages and places', async () => {
    engine.checkAccessibility.mockResolvedValue(
      report({
        findings: [
          { id: 'struct-tree', state: 'problem', key: 'op.a11y.check.structTree' },
          { id: 'lang-ok', state: 'ok', key: 'op.a11y.check.langOk', params: { lang: 'tr' } },
          {
            id: 'trunc',
            state: 'unchecked',
            key: 'op.a11y.check.structTruncated',
            params: { limit: 500 },
            pageIndex: 2,
            where: 'image Im1',
          },
          { id: 'lang', state: 'problem', key: 'op.a11y.check.lang', where: 'catalog' },
        ],
      }),
    );
    const { user } = show();
    await audit(user);

    expect(await screen.findByText('4 page(s) · 2 issue(s) · 1 unknown')).toBeTruthy();
    const sections = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent);
    expect(sections).toEqual([
      'Detected issues',
      'Could not check',
      'Checked, no issues found',
      'Unaudited items',
      'Figure alt text',
    ]);
    const rowsOf = (heading: string) =>
      within(screen.getByRole('heading', { name: heading }).closest('section') as HTMLElement)
        .getAllByRole('listitem')
        .map((row) => row.textContent);
    expect(rowsOf('Detected issues')).toEqual([
      'No structure tree (/StructTreeRoot) found.',
      'No document language (/Lang) declared.catalog',
    ]);
    expect(rowsOf('Could not check')).toEqual([
      'Structure tree truncated at 500 items; counted values are lower bounds.Page 3image Im1',
    ]);
    expect(rowsOf('Checked, no issues found')).toEqual(['Document language: tr.']);
    expect(rowsOf('Unaudited items')).toEqual(['Form fields and links not tagged (text and figures only).']);
  });

  it('leaves out the groups that have no rows, and still lists what was not checked', async () => {
    engine.checkAccessibility.mockResolvedValue(
      report({
        findings: [{ id: 'lang-ok', state: 'ok', key: 'op.a11y.check.langOk', params: { lang: 'tr' } }],
      }),
    );
    const { user } = show();
    await audit(user);
    await screen.findByText('Document language: tr.');
    expect(screen.queryByRole('heading', { name: 'Detected issues' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Could not check' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Unaudited items' })).toBeTruthy();
  });

  it('says a failed audit failed, tells the shell, and offers it again', async () => {
    engine.checkAccessibility.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'mupdf' });
    });
    const onNotice = vi.fn();
    const { user } = show({ onNotice });
    await audit(user);
    const failure = new ToolError('internal', { engine: 'mupdf' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
    expect(screen.queryByText('Audit has not been run yet.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Audit' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a failed audit even when the shell takes no notices', async () => {
    engine.checkAccessibility.mockImplementation(async () => {
      throw new Error('boom');
    });
    const { user } = show();
    await audit(user);
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('cancels the work context once the audit has finished', async () => {
    let seen: AbortSignal | undefined;
    engine.checkAccessibility.mockImplementation(
      async (_bytes: Uint8Array, context: { signal: AbortSignal }) => {
        seen = context.signal;
        expect(seen.aborted).toBe(false);
        return report();
      },
    );
    const { user } = show();
    await audit(user);
    await screen.findByText('4 page(s) · 0 issue(s) · 0 unknown');
    expect(seen?.aborted).toBe(true);
  });

  it('publishes nothing for a panel that has closed before the audit answers', async () => {
    let resolve: (value: AccessibilityReport) => void = () => {};
    engine.checkAccessibility.mockReturnValue(
      new Promise<AccessibilityReport>((done) => {
        resolve = done;
      }),
    );
    const { user, unmount } = show();
    await audit(user);
    unmount();
    await act(async () => resolve(report()));
    expect(screen.queryByText('4 page(s) · 0 issue(s) · 0 unknown')).toBeNull();
  });

  it('tells the shell nothing about a failure that arrives after the panel closed', async () => {
    let reject: (cause: unknown) => void = () => {};
    engine.checkAccessibility.mockReturnValue(
      new Promise<AccessibilityReport>((_done, fail) => {
        reject = fail;
      }),
    );
    const onNotice = vi.fn();
    const { user, unmount } = show({ onNotice });
    await audit(user);
    unmount();
    await act(async () => reject(new Error('late')));
    expect(onNotice).not.toHaveBeenCalled();
  });
});

describe('AccessibilityPanel: writing tags', () => {
  const NOTES: OperationNote[] = [{ kind: 'changed', key: 'op.note.a11y.langSet', params: { lang: 'en' } }];

  async function auditedWith(
    props: Partial<AccessibilityPanelProps>,
    images: AccessibilityReport['images'] = [],
  ) {
    engine.checkAccessibility.mockResolvedValue(report({ images }));
    const shown = show(props);
    await audit(shown.user);
    await screen.findByText('4 page(s) · 0 issue(s) · 0 unknown');
    return shown;
  }

  it('tags the bytes on screen in the interface language, hands the result to the shell and goes stale', async () => {
    engine.tagDocument.mockResolvedValue(outcome(NOTES));
    const onTagged = vi.fn();
    const { user, read } = await auditedWith({ onTagged, language: 'tr' });
    await user.click(screen.getByRole('button', { name: 'Tag document' }));

    await screen.findByText(
      'Document modified since this audit; results describe prior version. Re-run audit.',
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(engine.tagDocument).toHaveBeenCalledExactlyOnceWith(
      BYTES,
      { signal: expect.any(AbortSignal) },
      { language: 'tr' },
    );
    expect(onTagged).toHaveBeenCalledExactlyOnceWith({
      bytes: new Uint8Array([9]),
      notes: NOTES,
      steps: ['step-a'],
    } satisfies WrittenOutcome);
    expect(screen.getByRole('heading', { name: 'Notes from this operation' })).toBeTruthy();
    expect(screen.getByText('Document language written as /Lang = en.')).toBeTruthy();
  });

  it('shows no notes section when the write had nothing to say', async () => {
    engine.tagDocument.mockResolvedValue(outcome());
    const { user } = await auditedWith({ onTagged: vi.fn() });
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    await screen.findByText(/Document modified since this audit/);
    expect(screen.queryByRole('heading', { name: 'Notes from this operation' })).toBeNull();
  });

  it('cannot tag without a shell that takes the bytes', async () => {
    await auditedWith({});
    expect((screen.getByRole('button', { name: 'Tag document' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('still goes stale, and hands nothing to the alt-text handler, when only that is wired', async () => {
    engine.tagDocument.mockResolvedValue(outcome());
    const onAltWritten = vi.fn();
    const { user } = await auditedWith({ onAltWritten });
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    await screen.findByText(/Document modified since this audit/);
    expect(onAltWritten).not.toHaveBeenCalled();
  });

  it('tells the shell and shows the failure when tagging fails', async () => {
    engine.tagDocument.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'mupdf' });
    });
    const onNotice = vi.fn();
    const onTagged = vi.fn();
    const { user } = await auditedWith({ onTagged, onNotice });
    await user.click(screen.getByRole('button', { name: 'Tag document' }));
    const failure = new ToolError('internal', { engine: 'mupdf' });
    await waitFor(() => expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey)));
    expect(onTagged).not.toHaveBeenCalled();
    // The report from before stays on screen beside the failure.
    expect(screen.getByText('4 page(s) · 0 issue(s) · 0 unknown')).toBeTruthy();
  });
});

describe('AccessibilityPanel: figure alt text', () => {
  const saveButton = () => screen.getByText('Save').closest('button') as HTMLButtonElement;
  const altInput = (name: string) =>
    screen
      .getByText(`Alt text for figure ${name}`)
      .closest('label')
      ?.querySelector('input') as HTMLInputElement;
  const IMAGE = {
    pageIndex: 1,
    name: 'Im1',
    ref: '12 0 R',
    pages: [1, 3],
    alt: null as string | null,
    width: 10,
    height: 10,
  };

  async function auditedWith(props: Partial<AccessibilityPanelProps>, images = [IMAGE]) {
    engine.checkAccessibility.mockResolvedValue(report({ images }));
    const shown = show(props);
    await audit(shown.user);
    await screen.findByText('4 page(s) · 0 issue(s) · 0 unknown');
    return shown;
  }

  it('says there are no figures when the check found none', async () => {
    await auditedWith({}, []);
    expect(screen.getByText('No rendered figures found in this document.')).toBeTruthy();
  });

  it('lists each figure with its pages, says when it has no alt text, and shows an existing one', async () => {
    await auditedWith({ onAltWritten: vi.fn() }, [
      IMAGE,
      { ...IMAGE, name: 'Im2', ref: '13 0 R', pages: [0], alt: 'A cat' },
    ]);
    expect(screen.getByText('Im1 · page 2, 4 · no alt text')).toBeTruthy();
    expect(screen.getByText('Im2 · page 1')).toBeTruthy();
    expect(altInput('Im1').value).toBe('');
    expect(altInput('Im2').value).toBe('A cat');
  });

  it('writes the trimmed text for the figure, through the shell, and goes stale', async () => {
    engine.setImageAlt.mockResolvedValue(outcome());
    const onAltWritten = vi.fn();
    const { user, read } = await auditedWith({ onAltWritten });
    await user.type(altInput('Im1'), '  A red door  ');
    await user.click(saveButton());

    await screen.findByText(/Document modified since this audit/);
    expect(read).toHaveBeenCalledTimes(2);
    expect(engine.setImageAlt).toHaveBeenCalledExactlyOnceWith(
      BYTES,
      [{ kind: 'image', pageIndex: 1, name: 'Im1', alt: 'A red door' }],
      { signal: expect.any(AbortSignal) },
    );
    expect(onAltWritten).toHaveBeenCalledExactlyOnceWith({
      bytes: new Uint8Array([9]),
      notes: [],
      steps: ['step-a'],
    });
  });

  it('saves a corrected text over the one the figure already has', async () => {
    engine.setImageAlt.mockResolvedValue(outcome());
    const { user } = await auditedWith({ onAltWritten: vi.fn() }, [{ ...IMAGE, alt: 'A cat' }]);
    await user.type(altInput('Im1'), 's');
    await user.click(saveButton());
    await screen.findByText(/Document modified since this audit/);
    expect(engine.setImageAlt.mock.calls[0]?.[1]).toEqual([
      { kind: 'image', pageIndex: 1, name: 'Im1', alt: 'A cats' },
    ]);
  });

  it('saves the existing text as it stands when it was not edited', async () => {
    engine.setImageAlt.mockResolvedValue(outcome());
    const { user } = await auditedWith({ onAltWritten: vi.fn() }, [{ ...IMAGE, alt: 'A cat' }]);
    await user.click(saveButton());
    await screen.findByText(/Document modified since this audit/);
    expect(engine.setImageAlt.mock.calls[0]?.[1]).toEqual([
      { kind: 'image', pageIndex: 1, name: 'Im1', alt: 'A cat' },
    ]);
  });

  it('writes nothing for an empty text', async () => {
    const onAltWritten = vi.fn();
    const { user, read } = await auditedWith({ onAltWritten });
    await user.click(saveButton());
    await user.type(altInput('Im1'), '   ');
    await user.click(saveButton());
    expect(engine.setImageAlt).not.toHaveBeenCalled();
    expect(onAltWritten).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });

  it('cannot be edited or saved without a shell that takes the bytes', async () => {
    await auditedWith({});
    expect(altInput('Im1').disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });
});

describe('AccessibilityPanel: the views', () => {
  const tab = (name: string) => screen.getByRole('tab', { name }) as HTMLButtonElement;

  it('opens on the report and names the three views, one of them selected and in the tab order', () => {
    const { container } = show();
    expect(screen.getAllByRole('tab').map((entry) => entry.textContent)).toEqual([
      'Report',
      'PDF/UA',
      'Tags',
    ]);
    expect(screen.getByRole('tablist', { name: 'Accessibility' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((entry) => entry.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(screen.getAllByRole('tab').map((entry) => entry.tabIndex)).toEqual([0, -1, -1]);
    expect(container.querySelector('[data-a11y-view="report"]')).not.toBeNull();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('a11y-tab-report');
  });

  it('switches view when a tab is chosen, in the store', async () => {
    const { user } = show();
    await user.click(tab('PDF/UA'));
    expect(readingOrderStore.snapshot().view).toBe('ua');
    expect(screen.getByTestId('view-ua')).toBeTruthy();
    await user.click(tab('Tags'));
    expect(readingOrderStore.snapshot().view).toBe('tags');
    expect(screen.getByTestId('view-tags')).toBeTruthy();
    await user.click(tab('Report'));
    expect(screen.queryByTestId('view-tags')).toBeNull();
    expect(screen.getByRole('button', { name: 'Audit' })).toBeTruthy();
  });

  it('walks the views with the arrow keys, wrapping at both ends, and moves focus with them', async () => {
    const { user } = show();
    tab('Report').focus();
    await user.keyboard('{ArrowRight}');
    expect(readingOrderStore.snapshot().view).toBe('ua');
    expect(document.activeElement).toBe(tab('PDF/UA'));
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(readingOrderStore.snapshot().view).toBe('report');
    expect(document.activeElement).toBe(tab('Report'));
    await user.keyboard('{ArrowLeft}');
    expect(readingOrderStore.snapshot().view).toBe('tags');
    expect(document.activeElement).toBe(tab('Tags'));
  });

  it('ignores other keys on a tab', async () => {
    const { user } = show();
    tab('Report').focus();
    await user.keyboard('{ArrowDown}a{Enter}');
    expect(readingOrderStore.snapshot().view).toBe('report');
  });

  it('takes the reading-order boxes off the pages when the tags view is left, and when the panel closes', () => {
    const boxes = [{ pageIndex: 0, width: 100, height: 100, rotation: 0 as const, items: [] }];
    const { unmount } = show();
    act(() => {
      readingOrderStore.setView('tags');
      readingOrderStore.setPages(boxes);
    });
    expect(readingOrderStore.snapshot().pages).toEqual(boxes);

    act(() => readingOrderStore.setView('ua'));
    expect(readingOrderStore.snapshot().pages).toEqual([]);

    act(() => {
      readingOrderStore.setView('tags');
      readingOrderStore.setPages(boxes);
    });
    unmount();
    expect(readingOrderStore.snapshot().pages).toEqual([]);
  });

  it('gives the PDF/UA view the bytes reader, the language, the edit right and every handler the shell has', async () => {
    const onGoToPage = vi.fn();
    const onWritten = vi.fn();
    const onNotice = vi.fn();
    const { user, read } = show({ onGoToPage, onWritten, onNotice, canEdit: false, language: 'de' });
    await user.click(tab('PDF/UA'));
    const view = screen.getByTestId('view-ua');
    expect(view.getAttribute('data-props')).toBe(
      'canEdit,language,onGoToPage,onNotice,onOpenElement,onWritten,read,t',
    );
    expect(view.getAttribute('data-values')).toBe('canEdit=false;language=de');

    await user.click(within(view).getByRole('button', { name: 'read' }));
    expect(read).toHaveBeenCalledOnce();
    await user.click(within(view).getByRole('button', { name: 'onGoToPage' }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(2);
    await user.click(within(view).getByRole('button', { name: 'onWritten' }));
    expect(onWritten).toHaveBeenCalledExactlyOnceWith({
      bytes: new Uint8Array([7]),
      notes: [],
      steps: ['s'],
    });
    await user.click(within(view).getByRole('button', { name: 'onNotice' }));
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('notice');
  });

  it('gives the PDF/UA view only what the shell has', async () => {
    const { user } = show();
    await user.click(tab('PDF/UA'));
    const view = screen.getByTestId('view-ua');
    expect(view.getAttribute('data-props')).toBe('canEdit,language,onOpenElement,read,t');
    expect(view.getAttribute('data-values')).toBe('canEdit=true;language=en');
  });

  it('opens an element chosen in the PDF/UA view in the tags editor, on its page', async () => {
    const { user } = show();
    await user.click(tab('PDF/UA'));
    await user.click(within(screen.getByTestId('view-ua')).getByRole('button', { name: 'onOpenElement' }));
    expect(screen.getByTestId('view-tags')).toBeTruthy();
    expect(readingOrderStore.snapshot().view).toBe('tags');
    expect(readingOrderStore.takeFocus()).toEqual({ key: 'node-9', pageIndex: 4 });
  });

  it('gives the tags view the page being shown, the edit right and every handler the shell has', async () => {
    const onGoToPage = vi.fn();
    const onWritten = vi.fn();
    const onNotice = vi.fn();
    const { user } = show({ onGoToPage, onWritten, onNotice, currentPage: 6, canEdit: false });
    await user.click(tab('Tags'));
    const view = screen.getByTestId('view-tags');
    expect(view.getAttribute('data-props')).toBe(
      'canEdit,currentPage,language,onGoToPage,onNotice,onWritten,read,t',
    );
    expect(view.getAttribute('data-values')).toBe('canEdit=false;currentPage=6;language=en');
    await user.click(within(view).getByRole('button', { name: 'onGoToPage' }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('gives the tags view page 0 and the right to edit unless told otherwise, and only the handlers the shell has', async () => {
    const { user } = show();
    await user.click(tab('Tags'));
    const view = screen.getByTestId('view-tags');
    expect(view.getAttribute('data-props')).toBe('canEdit,currentPage,language,read,t');
    expect(view.getAttribute('data-values')).toBe('canEdit=true;currentPage=0;language=en');
  });
});
