// @vitest-environment happy-dom
/**
 * The PDF/UA view: one row per rule with its verdict, the places that fail, why the rule exists
 * and how to fix it, and the quick fixes that can be applied from there. Failing rules open by
 * themselves; the filter narrows the rules; a fix goes to the shell as bytes, never into the
 * document by itself; and nothing is published for a view that has closed. The checker and
 * the fixer have their own suites, so they answer here with what their contracts describe.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfUaReport, UaGroup, UaInstance, UaRule } from 'pdf-core/ops/pdfua';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfUaView, type PdfUaViewProps } from './PdfUaView';

const engine = vi.hoisted(() => ({ checkPdfUa: vi.fn(), fixPdfUa: vi.fn() }));
vi.mock('pdf-core/ops/pdfua', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pdf-core/ops/pdfua')>()),
  ...engine,
}));

const t = createTranslator('en');
const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  engine.checkPdfUa.mockReset();
  engine.fixPdfUa.mockReset();
});
afterEach(cleanup);

const rule = (id: string, group: UaGroup, overrides: Partial<UaRule> = {}): UaRule =>
  ({
    id,
    group,
    matterhorn: '06',
    iso: '7.1',
    state: 'pass',
    count: 0,
    instances: [],
    manual: false,
    ...overrides,
  }) as UaRule;

const reportOf = (rules: UaRule[], overrides: Partial<PdfUaReport> = {}): PdfUaReport => ({
  pageCount: 3,
  rules,
  summary: { pass: 1, fail: 2, manual: 3, na: 4, unchecked: 5 },
  automatedPass: false,
  declaredPart: null,
  tagged: true,
  title: null,
  lang: null,
  ...overrides,
});

function show(props: Partial<PdfUaViewProps> = {}) {
  const read = vi.fn(async () => BYTES);
  const view = render(<PdfUaView t={t} read={read} language="en" canEdit {...props} />);
  return { read, ...view, user: userEvent.setup() };
}

async function shown(report: PdfUaReport, props: Partial<PdfUaViewProps> = {}) {
  engine.checkPdfUa.mockResolvedValue(report);
  const view = show(props);
  await screen.findByText(/How the file is|The file (does not )?declare/);
  return view;
}

const row = (id: string) => document.querySelector(`[data-ua-rule="${id}"]`) as HTMLElement;
const rowButton = (id: string) => row(id).querySelector('button') as HTMLButtonElement;
const inRow = (id: string) => within(row(id));
/** A button inside a label takes the label's text into its name; find it by its own text. */
const labelled = (text: string) => screen.getByText(text).closest('button') as HTMLButtonElement;

describe('PdfUaView: the check', () => {
  it('shows a loading state, checks the bytes on screen, and holds the button meanwhile', async () => {
    let resolve: (value: PdfUaReport) => void = () => {};
    engine.checkPdfUa.mockReturnValue(
      new Promise<PdfUaReport>((done) => {
        resolve = done;
      }),
    );
    const { container, read } = show();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => resolve(reportOf([rule('title', 'document')])));
    expect(read).toHaveBeenCalledOnce();
    expect(engine.checkPdfUa).toHaveBeenCalledExactlyOnceWith(BYTES, { signal: expect.any(AbortSignal) });
    expect((screen.getByRole('button', { name: 'Check again' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('checks again on request', async () => {
    const { user, read } = await shown(reportOf([rule('title', 'document')]));
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('states the verdict counts and whether the file declares PDF/UA', async () => {
    const { container } = await shown(reportOf([rule('title', 'document')], { declaredPart: 1 }));
    expect(container.querySelector('[data-ua-summary]')?.textContent).toBe(
      t('ua.summary' as never, { pass: 1, fail: 2, manual: 3, na: 4, unchecked: 5 } as never),
    );
    expect(screen.getByText('The file declares PDF/UA-1.')).toBeTruthy();
    cleanup();
    await shown(reportOf([rule('title', 'document')]));
    expect(screen.getByText('The file does not declare PDF/UA conformance.')).toBeTruthy();
  });

  it('says what failed and tells the shell when the check fails', async () => {
    engine.checkPdfUa.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'mupdf' });
    });
    const onNotice = vi.fn();
    show({ onNotice });
    const failure = new ToolError('internal', { engine: 'mupdf' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
  });

  it('shows a failed check even when the shell takes no notices', async () => {
    engine.checkPdfUa.mockImplementation(async () => {
      throw new Error('boom');
    });
    show();
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('publishes nothing for a view that has closed before the check answers', async () => {
    let resolve: (value: PdfUaReport) => void = () => {};
    let reject: (cause: unknown) => void = () => {};
    engine.checkPdfUa
      .mockReturnValueOnce(
        new Promise<PdfUaReport>((done) => {
          resolve = done;
        }),
      )
      .mockReturnValueOnce(
        new Promise<PdfUaReport>((_done, fail) => {
          reject = fail;
        }),
      );
    const onNotice = vi.fn();
    const first = show({ onNotice });
    first.unmount();
    await act(async () => resolve(reportOf([rule('title', 'document')])));
    expect(screen.queryByText(/does not declare/)).toBeNull();

    const second = show({ onNotice });
    second.unmount();
    await act(async () => reject(new Error('late')));
    expect(onNotice).not.toHaveBeenCalled();
  });
});

describe('PdfUaView: the rules', () => {
  const RULES = [
    rule('marked', 'document', { state: 'fail', count: 2, fix: 'marked', instances: [{}] }),
    rule('title', 'document', { state: 'pass', fix: 'title' }),
    rule('lang', 'document', { state: 'pass', fix: 'lang', params: { lang: 'tr-TR' } }),
    rule('encryption', 'document', { state: 'na' }),
    rule('reading-order', 'structure', { state: 'manual', manual: true }),
    rule('struct-tree', 'structure', { state: 'unchecked', count: 0 }),
  ];

  it('groups the rules, names each verdict, and counts only failures', async () => {
    await shown(reportOf(RULES));
    expect(screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual([
      'Document',
      'Structure',
    ]);
    const verdict = (id: string) => rowButton(id).lastElementChild?.textContent;
    expect(verdict('marked')).toContain('Fail (2)');
    expect(verdict('title')).toBe('✓ Pass');
    expect(verdict('encryption')).toContain('Not applicable');
    expect(verdict('reading-order')).toContain('Check by hand');
    expect(verdict('struct-tree')).toContain('Not checked');
    expect(row('marked').getAttribute('data-ua-state')).toBe('fail');
    expect(inRow('marked').getByText('File is marked as tagged')).toBeTruthy();
  });

  it('opens failing rules by themselves, and any rule on request', async () => {
    const { user } = await shown(reportOf(RULES));
    const expanded = (id: string) => rowButton(id).getAttribute('aria-expanded');
    expect(expanded('marked')).toBe('true');
    expect(expanded('title')).toBe('false');
    expect(expanded('reading-order')).toBe('false');

    await user.click(rowButton('title'));
    expect(expanded('title')).toBe('true');
    await user.click(rowButton('marked'));
    expect(expanded('marked')).toBe('false');
    expect(inRow('marked').queryByText(/How to fix/)).toBeNull();
  });

  it('says how to fix a failing, manual or unchecked rule, but not a passing or inapplicable one', async () => {
    const { user } = await shown(reportOf(RULES));
    for (const id of ['title', 'encryption', 'reading-order', 'struct-tree']) await user.click(rowButton(id));
    expect(inRow('marked').getByText('How to fix:')).toBeTruthy();
    expect(inRow('reading-order').getByText('How to fix:')).toBeTruthy();
    expect(inRow('struct-tree').getByText('How to fix:')).toBeTruthy();
    expect(inRow('title').queryByText('How to fix:')).toBeNull();
    expect(inRow('encryption').queryByText('How to fix:')).toBeNull();
    expect(inRow('marked').getByText('Matterhorn checkpoint group 06 · ISO 14289-1 clause 7.1')).toBeTruthy();
  });

  it('quotes the facts of a passing rule that has any, and says nothing more for one that has none', async () => {
    const { user } = await shown(reportOf(RULES));
    await user.click(rowButton('lang'));
    await user.click(rowButton('title'));
    expect(inRow('lang').getByText('Language: tr-TR.')).toBeTruthy();
    expect(inRow('title').queryByText(/Language:/)).toBeNull();
  });

  it('says a passing rule is fine in its own words even when it quotes no value', async () => {
    const { user } = await shown(reportOf([rule('bookmarks', 'navigation', { state: 'pass' })]));
    await user.click(rowButton('bookmarks'));
    expect(inRow('bookmarks').getByText('The document has bookmarks.')).toBeTruthy();
  });

  it('counts the failures the list does not show', async () => {
    await shown(reportOf([rule('marked', 'document', { state: 'fail', count: 5, instances: [{}, {}] })]));
    expect(inRow('marked').getByText('… and 3 more.')).toBeTruthy();
  });

  it('shows no more-line when every failure is listed', async () => {
    await shown(reportOf([rule('marked', 'document', { state: 'fail', count: 1, instances: [{}] })]));
    expect(inRow('marked').queryByText(/more\./)).toBeNull();
  });

  it('narrows to failing and unchecked rules, or to those that need a person, and back to all', async () => {
    const { user } = await shown(reportOf(RULES));
    const ids = () =>
      [...document.querySelectorAll('[data-ua-rule]')].map((li) => li.getAttribute('data-ua-rule'));
    const filter = screen.getByRole('combobox', { name: 'Show' });
    await user.selectOptions(filter, 'fail');
    expect(ids()).toEqual(['marked', 'struct-tree']);
    await user.selectOptions(filter, 'manual');
    expect(ids()).toEqual(['reading-order']);
    expect(screen.queryByRole('heading', { name: 'Document' })).toBeNull();
    await user.selectOptions(filter, 'all');
    expect(ids()).toHaveLength(6);
  });
});

describe('PdfUaView: failing instances', () => {
  const instances: UaInstance[] = [
    { pageIndex: 1, nodeKey: 'n-1', where: 'annotation 12 0 R', reason: 'missing' },
    { nodeKey: 'n-2', params: { lang: 'xx' }, reason: 'invalid' },
    { reason: 'missing' },
  ];
  const LANG = rule('lang', 'document', { state: 'fail', count: 3, instances, params: { lang: 'zz' } });

  it('lists each place with its sentence, its page and its PDF notation', async () => {
    await shown(reportOf([LANG]));
    const items = within(row('lang'))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      'The catalogue has no /Lang entry.Page 2annotation 12 0 R',
      '"xx" is not a valid language tag.',
      'The catalogue has no /Lang entry.',
    ]);
  });

  it('walks to the page of a place, and opens its element in the tags view', async () => {
    const onGoToPage = vi.fn();
    const onOpenElement = vi.fn();
    const { user } = await shown(reportOf([LANG]), { onGoToPage, onOpenElement });
    await user.click(inRow('lang').getByRole('button', { name: 'Page 2' }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);

    const open = inRow('lang').getAllByRole('button', { name: 'Open this element in the Tags view' });
    await user.click(open[0] as HTMLElement);
    await user.click(open[1] as HTMLElement);
    expect(onOpenElement.mock.calls).toEqual([
      ['n-1', 1],
      ['n-2', null],
    ]);
  });

  it('offers the same buttons when the shell does not listen', async () => {
    const { user } = await shown(reportOf([LANG]));
    await user.click(inRow('lang').getByRole('button', { name: 'Page 2' }));
    await user.click(
      inRow('lang').getAllByRole('button', { name: 'Open this element in the Tags view' })[0] as HTMLElement,
    );
    expect(inRow('lang').getByRole('button', { name: 'Page 2' })).toBeTruthy();
  });

  it('says why a rule could not be checked in one shared sentence per reason', async () => {
    const { user } = await shown(
      reportOf([
        rule('struct-tree', 'structure', {
          state: 'unchecked',
          count: 2,
          instances: [{ reason: 'untagged' }, { reason: 'unreadable' }],
        }),
        rule('headings', 'structure', { state: 'unchecked', count: 1, instances: [{ reason: 'none' }] }),
      ]),
    );
    await user.click(rowButton('struct-tree'));
    await user.click(rowButton('headings'));
    expect(inRow('struct-tree').getByText('Not checked: the file has no structure tree.')).toBeTruthy();
    expect(
      inRow('struct-tree').getByText('Not checked: this part of the file could not be read.'),
    ).toBeTruthy();
    expect(within(row('headings')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('puts the instance page into a sentence that names it, and leaves it empty for one with no page', async () => {
    await shown(
      reportOf([
        rule('headings', 'structure', {
          state: 'fail',
          count: 2,
          instances: [{ pageIndex: 3 }, {}],
        }),
      ]),
    );
    expect(
      within(row('headings'))
        .getAllByRole('listitem')
        .map((li) => li.textContent?.includes('4')),
    ).toEqual([true, false]);
  });
});

describe('PdfUaView: quick fixes on one place', () => {
  const LINK = rule('link-alt', 'links', {
    state: 'fail',
    count: 2,
    fix: 'link-contents',
    instances: [{ objectNumber: 12, pageIndex: 0 }, { where: 'no object' }],
  });
  const FIELD = rule('form-tooltip', 'forms', {
    state: 'fail',
    count: 2,
    fix: 'field-tooltip',
    instances: [{ fieldName: 'Name' }, { objectNumber: 4 }],
  });

  it('writes a link description for the annotation it sits on, through the shell', async () => {
    engine.fixPdfUa.mockResolvedValue({ bytes: new Uint8Array([9]), report: { notes: [], steps: ['s1'] } });
    const onWritten = vi.fn();
    const { user, read } = await shown(reportOf([LINK]), { onWritten });
    const input = inRow('link-alt').getByPlaceholderText('Description of this link');
    const save = inRow('link-alt').getByText('Save').closest('button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(input, 'Home page');
    expect(save.disabled).toBe(false);
    await user.click(save);

    await waitFor(() => expect(onWritten).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledTimes(2);
    expect(engine.fixPdfUa).toHaveBeenCalledExactlyOnceWith(
      BYTES,
      [{ kind: 'link-contents', objectNumber: 12, text: 'Home page' }],
      { signal: expect.any(AbortSignal) },
    );
    expect(onWritten).toHaveBeenCalledExactlyOnceWith({
      bytes: new Uint8Array([9]),
      notes: [],
      steps: ['s1'],
    });
    expect(inRow('link-alt').getAllByPlaceholderText('Description of this link')).toHaveLength(1);
  });

  it('writes a form field tooltip by the field name, and offers no control for a place without one', async () => {
    engine.fixPdfUa.mockResolvedValue({ bytes: new Uint8Array(), report: { notes: [], steps: [] } });
    const { user } = await shown(reportOf([FIELD]), { onWritten: vi.fn() });
    expect(inRow('form-tooltip').getAllByRole('textbox')).toHaveLength(1);
    await user.type(inRow('form-tooltip').getByPlaceholderText('Tooltip for Name'), 'Your name');
    await user.click(inRow('form-tooltip').getByText('Save').closest('button') as HTMLElement);
    await waitFor(() => expect(engine.fixPdfUa).toHaveBeenCalledOnce());
    expect(engine.fixPdfUa.mock.calls[0]?.[1]).toEqual([
      { kind: 'field-tooltip', name: 'Name', text: 'Your name' },
    ]);
  });

  it('cannot be edited without the right to edit', async () => {
    await shown(reportOf([LINK]), { canEdit: false });
    expect(
      (inRow('link-alt').getByPlaceholderText('Description of this link') as HTMLInputElement).disabled,
    ).toBe(true);
  });
});

describe('PdfUaView: quick fixes on a rule', () => {
  const asRules = (...rules: UaRule[]) => reportOf(rules);

  async function fixed(report: PdfUaReport, props: Partial<PdfUaViewProps> = {}) {
    engine.fixPdfUa.mockResolvedValue({ bytes: new Uint8Array([5]), report: { notes: [], steps: [] } });
    return shown(report, { onWritten: vi.fn(), ...props });
  }
  const lastFixes = () => engine.fixPdfUa.mock.calls.at(-1)?.[1];

  it('sets the title, starting from the title the file has', async () => {
    const { user } = await fixed(
      asRules(rule('title', 'document', { state: 'fail', fix: 'title', count: 1 })),
    );
    await user.type(screen.getByPlaceholderText('Document title'), 'New');
    await user.click(labelled('Set title'));
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'title', title: 'New' }]));
    cleanup();
    const second = await fixed(
      reportOf([rule('title', 'document', { state: 'fail', fix: 'title', count: 1 })], {
        title: 'Old title',
      }),
    );
    const input = screen.getByPlaceholderText('Document title') as HTMLInputElement;
    expect(input.value).toBe('Old title');
    await second.user.type(input, '!');
    await second.user.click(labelled('Set title'));
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'title', title: 'Old title!' }]));
  });

  it('sets the language, starting from the file language or else the interface language', async () => {
    const withFileLang = await fixed(
      reportOf([rule('lang', 'document', { state: 'fail', fix: 'lang', count: 1 })], { lang: 'de-DE' }),
    );
    expect((screen.getByPlaceholderText('Language tag') as HTMLInputElement).value).toBe('de-DE');
    expect(screen.getByText('For example en-US, tr-TR or de-DE.')).toBeTruthy();
    await withFileLang.user.type(screen.getByPlaceholderText('Language tag'), 'x');
    await withFileLang.user.click(labelled('Set language'));
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'lang', lang: 'de-DEx' }]));
    cleanup();

    await fixed(asRules(rule('lang', 'document', { state: 'fail', fix: 'lang', count: 1 })), {
      language: 'tr',
    });
    expect((screen.getByPlaceholderText('Language tag') as HTMLInputElement).value).toBe('tr');
  });

  it('applies the one-click fixes', async () => {
    const { user } = await fixed(
      asRules(
        rule('display-title', 'document', { state: 'fail', fix: 'display-title', count: 1 }),
        rule('tab-order', 'forms', { state: 'fail', fix: 'tabs', count: 1 }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Show the title in the window bar' }));
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'display-title' }]));
    await user.click(screen.getByRole('button', { name: 'Set tab order to the structure' }));
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'tabs' }]));
    expect(screen.queryByText(/^Mark drawn/)).toBeNull();
  });

  it('offers marking and annotation tagging only for a tagged file, and explains the latter', async () => {
    const tagged = await fixed(
      asRules(
        rule('marked', 'document', { state: 'fail', fix: 'marked', count: 1 }),
        rule('annot-tagged', 'forms', { state: 'fail', fix: 'tag-annots', count: 1 }),
      ),
    );
    expect(screen.getByRole('button', { name: 'Mark the file as tagged' })).toBeTruthy();
    const tagAnnots = screen.getByRole('button', {
      name: 'Put links, fields and annotations in the structure tree',
    });
    await tagged.user.click(tagAnnots);
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'tag-annots' }]));
    expect(screen.getAllByText(/./, { selector: 'p.text-\\[10px\\]' }).length).toBeGreaterThan(1);
    cleanup();

    await fixed(
      reportOf(
        [
          rule('marked', 'document', { state: 'fail', fix: 'marked', count: 1 }),
          rule('annot-tagged', 'forms', { state: 'fail', fix: 'tag-annots', count: 1 }),
        ],
        { tagged: false },
      ),
    );
    expect(screen.queryByRole('button', { name: 'Mark the file as tagged' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Put links, fields/ })).toBeNull();
  });

  it('offers marking drawn paths as artifacts only while the rule fails', async () => {
    const failing = await fixed(
      asRules(rule('tagged-content', 'content', { state: 'fail', fix: 'artifact-paths', count: 1 })),
    );
    await failing.user.click(
      screen.getByRole('button', { name: 'Mark drawn lines and backgrounds as artifacts' }),
    );
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'artifact-paths' }]));
    cleanup();

    const unchecked = await fixed(
      asRules(rule('tagged-content', 'content', { state: 'unchecked', fix: 'artifact-paths', count: 0 })),
    );
    await unchecked.user.click(rowButton('tagged-content'));
    expect(screen.queryByRole('button', { name: /Mark drawn/ })).toBeNull();
  });

  it('declares PDF/UA only when every automated rule passes and nothing is declared yet', async () => {
    const MARK = rule('pdfua-id', 'document', { state: 'fail', fix: 'mark-pdfua', count: 1 });
    const ready = await fixed(reportOf([MARK], { automatedPass: true }));
    const button = () => screen.getByRole('button', { name: 'Declare PDF/UA-1' }) as HTMLButtonElement;
    expect(button().disabled).toBe(false);
    await ready.user.click(button());
    await waitFor(() => expect(lastFixes()).toEqual([{ kind: 'mark-pdfua' }]));
    cleanup();

    await fixed(reportOf([MARK], { automatedPass: false }));
    expect(button().disabled).toBe(true);
    expect(
      screen.getByText('Not offered while an automated rule fails or could not be checked.'),
    ).toBeTruthy();
    cleanup();

    await fixed(reportOf([MARK], { automatedPass: true, declaredPart: 2 }));
    expect(button().disabled).toBe(true);
  });

  it('offers no fix for a rule that has none, or one that passes or does not apply', async () => {
    const { user } = await fixed(
      asRules(
        rule('struct-tree', 'structure', { state: 'fail', count: 1 }),
        rule('title', 'document', { state: 'pass', fix: 'title' }),
        rule('lang', 'document', { state: 'na', fix: 'lang' }),
      ),
    );
    await user.click(rowButton('title'));
    await user.click(rowButton('lang'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Set / })).toBeNull();
  });

  it('holds every fix without the right to edit, and while one is being written', async () => {
    const report = asRules(
      rule('display-title', 'document', { state: 'fail', fix: 'display-title', count: 1 }),
    );
    await fixed(report, { canEdit: false });
    expect(
      (screen.getByRole('button', { name: 'Show the title in the window bar' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    cleanup();

    let resolve: (value: unknown) => void = () => {};
    engine.fixPdfUa.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    engine.checkPdfUa.mockResolvedValue(report);
    const { user } = show({ onWritten: vi.fn() });
    const button = await screen.findByRole('button', { name: 'Show the title in the window bar' });
    await user.click(button);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Show the title in the window bar' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    await act(async () => resolve({ bytes: new Uint8Array(), report: { notes: [], steps: [] } }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Show the title in the window bar' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it('tells the shell and shows the failure when a fix fails, and still works without a shell that takes bytes', async () => {
    engine.fixPdfUa.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'mupdf' });
    });
    const onNotice = vi.fn();
    const { user } = await shown(
      asRules(rule('display-title', 'document', { state: 'fail', fix: 'display-title', count: 1 })),
      { onNotice },
    );
    await user.click(screen.getByRole('button', { name: 'Show the title in the window bar' }));
    const failure = new ToolError('internal', { engine: 'mupdf' });
    await waitFor(() => expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey)));
    expect(screen.getByText(t(failure.messageKey))).toBeTruthy();
  });

  it('shows a failed fix even when the shell takes no notices', async () => {
    engine.fixPdfUa.mockImplementation(async () => {
      throw new Error('boom');
    });
    const { user } = await shown(
      asRules(rule('display-title', 'document', { state: 'fail', fix: 'display-title', count: 1 })),
    );
    await user.click(screen.getByRole('button', { name: 'Show the title in the window bar' }));
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('publishes nothing for a view that has closed before a fix answers', async () => {
    let resolve: (value: unknown) => void = () => {};
    let reject: (cause: unknown) => void = () => {};
    const onWritten = vi.fn();
    const onNotice = vi.fn();
    const report = asRules(
      rule('display-title', 'document', { state: 'fail', fix: 'display-title', count: 1 }),
    );
    engine.fixPdfUa
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockReturnValueOnce(
        new Promise((_done, fail) => {
          reject = fail;
        }),
      );

    const first = await shown(report, { onWritten, onNotice });
    await first.user.click(screen.getByRole('button', { name: 'Show the title in the window bar' }));
    first.unmount();
    await act(async () => resolve({ bytes: new Uint8Array(), report: { notes: [], steps: [] } }));
    expect(onWritten).not.toHaveBeenCalled();

    const second = await shown(report, { onWritten, onNotice });
    await second.user.click(screen.getByRole('button', { name: 'Show the title in the window bar' }));
    second.unmount();
    await act(async () => reject(new Error('late')));
    expect(onNotice).not.toHaveBeenCalled();
  });
});
