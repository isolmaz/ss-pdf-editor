// @vitest-environment happy-dom
/**
 * The tools rail: tool groups that fold open and shut (page, export and signing tools open by
 * default), each tool reaching the shell by the route it is wired to, the simple mode's subset
 * of groups, and the inline runner that replaces the rail while a tool is open: a way back, the
 * tool's own settings, and its result handed to the shell.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationDialogSpec, OperationRunContext, OpRunResult } from '../dialogs/types';
import { ToolsRailPanel, type ToolsRailPanelProps } from './ToolsRailPanel';

afterEach(cleanup);

const t = createTranslator('en');

function show(props: Partial<ToolsRailPanelProps> = {}) {
  const handlers = {
    onSelectTool: vi.fn(),
    onBackToTools: vi.fn(),
    onResult: vi.fn(),
    onOpenDialog: vi.fn(),
    onPageAction: vi.fn(),
    onArmTool: vi.fn(),
    onOpenPalette: vi.fn(),
    onExportModal: vi.fn(),
  };
  render(<ToolsRailPanel t={t} {...handlers} {...props} />);
  return { ...handlers, user: userEvent.setup() };
}

const group = (name: string) => screen.getByRole('button', { name, expanded: undefined });

describe('ToolsRailPanel: the rail', () => {
  it('opens the page, export and signing groups and keeps security and numbering shut', () => {
    show();
    const state = (title: string) =>
      screen.getByRole('button', { name: title }).getAttribute('aria-expanded');
    expect(screen.getByRole('heading', { name: 'ALL TOOLS' })).toBeTruthy();
    expect(state('Organize Pages')).toBe('true');
    expect(state('Convert & Export PDF')).toBe('true');
    expect(state('Fill & Sign')).toBe('true');
    expect(state('Security & Redaction')).toBe('false');
    expect(state('Numbering & Watermark')).toBe('false');
    expect(screen.getByRole('button', { name: 'Rotate Pages' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Protect with Password' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Watermark' })).toBeNull();
  });

  it('folds a group shut and a shut group open again', async () => {
    const { user } = show();
    await user.click(group('Organize Pages'));
    expect(group('Organize Pages').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Rotate Pages' })).toBeNull();

    await user.click(group('Security & Redaction'));
    expect(group('Security & Redaction').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Protect with Password' })).toBeTruthy();
    await user.click(group('Numbering & Watermark'));
    expect(screen.getByRole('button', { name: 'Add Watermark' })).toBeTruthy();
  });

  it('lists the tools of each group, the export options marked as new', async () => {
    const { user } = show();
    await user.click(group('Security & Redaction'));
    await user.click(group('Numbering & Watermark'));
    const titles = (name: string) => {
      const section = screen.getByRole('button', { name }).parentElement as HTMLElement;
      return within(section)
        .getAllByRole('button')
        .slice(1)
        .map((button) => button.textContent);
    };
    expect(titles('Organize Pages')).toEqual([
      'Rotate Pages',
      'Delete Pages',
      'Extract Pages',
      'Split Document',
      'Combine / Add Document',
    ]);
    expect(titles('Convert & Export PDF')).toEqual([
      'Export OptionsNEW',
      'Compress PDF',
      'Export Pages as Images',
      'Export as Plain Text',
      'Export as Word, Excel or CSV',
      'Save as PDF/A',
    ]);
    expect(titles('Fill & Sign')).toEqual([
      'Digital Signature (PAdES)',
      'Fill Form Fields',
      'Add New Form Field',
    ]);
    expect(titles('Security & Redaction')).toEqual([
      'Protect with Password',
      'Remove Password',
      'Sanitize Document',
      'Permanent Redaction',
    ]);
    expect(titles('Numbering & Watermark')).toEqual(['Add Page Numbers', 'Add Watermark']);
  });

  it('sends page actions, the export modal and the palette to the shell', async () => {
    const { user, onPageAction, onExportModal, onOpenPalette, onSelectTool } = show();
    await user.click(screen.getByRole('button', { name: 'Rotate Pages' }));
    await user.click(screen.getByRole('button', { name: 'Delete Pages' }));
    expect(onPageAction.mock.calls).toEqual([[{ kind: 'rotate', direction: 'right' }], [{ kind: 'delete' }]]);

    await user.click(screen.getByRole('button', { name: /Export Options/ }));
    expect(onExportModal).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Search All Commands (Ctrl+K)' }));
    expect(onOpenPalette).toHaveBeenCalledOnce();
    expect(onSelectTool).not.toHaveBeenCalled();
  });

  it('selects the tool a row names, arming the redaction tool first', async () => {
    const { user, onSelectTool, onArmTool, onOpenDialog } = show();
    await user.click(group('Security & Redaction'));
    await user.click(group('Numbering & Watermark'));
    const rows: [string, string][] = [
      ['Extract Pages', 'extract-pages'],
      ['Split Document', 'split'],
      ['Combine / Add Document', 'add-document'],
      ['Compress PDF', 'compress'],
      ['Export Pages as Images', 'export-images'],
      ['Export as Plain Text', 'export-text'],
      ['Export as Word, Excel or CSV', 'export-office'],
      ['Save as PDF/A', 'pdfa'],
      ['Digital Signature (PAdES)', 'sign'],
      ['Fill Form Fields', 'form-fields'],
      ['Add New Form Field', 'form-create-field'],
      ['Protect with Password', 'protect'],
      ['Remove Password', 'unlock'],
      ['Sanitize Document', 'sanitize'],
      ['Add Page Numbers', 'page-numbers'],
      ['Add Watermark', 'watermark'],
    ];
    for (const [title] of rows) await user.click(screen.getByRole('button', { name: title }));
    expect(onSelectTool.mock.calls).toEqual(rows.map(([, id]) => [id]));
    expect(onArmTool).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Permanent Redaction' }));
    expect(onArmTool).toHaveBeenCalledExactlyOnceWith('redact');
    expect(onSelectTool).toHaveBeenLastCalledWith('redact');
    expect(onOpenDialog).not.toHaveBeenCalled();
  });

  it('opens the tool as a dialog when the shell has no inline runner', async () => {
    const { user, onOpenDialog } = show({ onSelectTool: undefined });
    await user.click(screen.getByRole('button', { name: 'Split Document' }));
    expect(onOpenDialog).toHaveBeenCalledExactlyOnceWith('split');
  });

  it('offers only the groups the mode keeps', () => {
    show({ visibleGroups: ['pages', 'sign'] });
    expect(screen.getByRole('button', { name: 'Organize Pages' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fill & Sign' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convert & Export PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Security & Redaction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Numbering & Watermark' })).toBeNull();
  });
});

const REPORT = {
  pageCount: 3,
  inputBytes: 10,
  outputBytes: 12,
  engine: 'mupdf' as const,
  incremental: true,
  steps: [],
  notes: [],
};
const RESULT: OpRunResult = { files: [], report: REPORT };

const SPEC: OperationDialogSpec = {
  id: 'probe',
  titleKey: 'op.scope',
  introKey: 'redact.intro',
  confirmKey: 'op.result.download',
  resultKind: 'replace',
  fields: [],
  run: async () => RESULT,
};

const CONTEXT: OperationRunContext = {
  bytes: new Uint8Array(),
  pageCount: 3,
  name: 'a.pdf',
  currentPage: 0,
  selectedPages: [],
  t,
};

describe('ToolsRailPanel: the inline runner', () => {
  it('replaces the rail with the tool, named by its title, and goes back to the rail', async () => {
    const { user, onBackToTools } = show({ activeSpec: SPEC, context: CONTEXT });
    const runner = screen.getByRole('region', { name: 'Page range' });
    expect(within(runner).getByRole('heading', { name: 'Page range' })).toBeTruthy();
    expect(
      within(runner).getByText(
        'Text and graphics in marked areas are permanently deleted from the document.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'ALL TOOLS' })).toBeNull();

    await user.click(within(runner).getByRole('button', { name: 'Back to All Tools' }));
    expect(onBackToTools).toHaveBeenCalledOnce();
    await user.click(within(runner).getByRole('button', { name: 'Cancel' }));
    expect(onBackToTools).toHaveBeenCalledTimes(2);
  });

  it('runs the tool and hands its result to the shell', async () => {
    const { user, onResult, onBackToTools } = show({ activeSpec: SPEC, context: CONTEXT });
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await user.click(await screen.findByRole('button', { name: 'Apply to document' }));
    expect(onResult).toHaveBeenCalledExactlyOnceWith(RESULT);
    // Going back as well would cancel the apply that has just started.
    expect(onBackToTools).not.toHaveBeenCalled();
  });

  it('shows the rail when there is a tool but no document to run it on, or a document but no tool', () => {
    const first = render(<ToolsRailPanel t={t} activeSpec={SPEC} context={null} />);
    expect(screen.getByRole('heading', { name: 'ALL TOOLS' })).toBeTruthy();
    first.unmount();
    render(<ToolsRailPanel t={t} activeSpec={null} context={CONTEXT} />);
    expect(screen.getByRole('heading', { name: 'ALL TOOLS' })).toBeTruthy();
  });
});
