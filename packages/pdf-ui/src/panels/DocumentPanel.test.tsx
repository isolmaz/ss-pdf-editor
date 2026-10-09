// @vitest-environment happy-dom
/**
 * The left dock of the reader half: a tab per view (pages, outline, attachments, layers,
 * signatures, search results), the tabs a mode offers, the tab a menu command asks for, and
 * each view wired to the shell's callbacks. The views run for real over a stand-in document;
 * only the engine readers they call (attachments, layers, signature fields, text search) are
 * answered by hand, as their own suites cover them.
 */

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPanel, type DocumentPanelProps, type OutlineEntry } from './DocumentPanel';

const engine = vi.hoisted(() => ({
  listPdfAttachments: vi.fn(),
  readPdfAttachment: vi.fn(),
  searchPdfText: vi.fn(),
  listPdfLayers: vi.fn(),
  setPdfLayerVisibility: vi.fn(),
  listPdfSignatureFields: vi.fn(),
}));
vi.mock('pdf-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pdf-core')>()),
  listPdfAttachments: engine.listPdfAttachments,
  readPdfAttachment: engine.readPdfAttachment,
  searchPdfText: engine.searchPdfText,
}));
vi.mock('pdf-core/layers', () => ({
  listPdfLayers: engine.listPdfLayers,
  setPdfLayerVisibility: engine.setPdfLayerVisibility,
}));
vi.mock('pdf-core/signature-fields', () => ({ listPdfSignatureFields: engine.listPdfSignatureFields }));

const t = createTranslator('en');

function documentOf(outline: Promise<readonly OutlineEntry[]> | readonly OutlineEntry[] = []) {
  return {
    pageCount: 2,
    getPageLabels: async () => null,
    getOutline: () => Promise.resolve(outline),
    getPageSize: async () => ({ width: 100, height: 200 }),
    renderPage: async () => undefined,
  } as unknown as PdfDocumentHandle;
}

beforeEach(() => {
  for (const fn of Object.values(engine)) fn.mockReset();
  engine.listPdfAttachments.mockResolvedValue([]);
  engine.listPdfLayers.mockResolvedValue([]);
  engine.listPdfSignatureFields.mockResolvedValue([]);
  engine.searchPdfText.mockResolvedValue([]);
});
afterEach(cleanup);

function show(props: Partial<DocumentPanelProps> = {}) {
  const handlers = {
    onGoToPage: vi.fn(),
    onSelectionChange: vi.fn(),
    onPageAction: vi.fn(),
    onAddAttachments: vi.fn(),
    onRemoveAttachments: vi.fn(),
    onToggle: vi.fn(),
  };
  const document = props.document ?? documentOf();
  const view = render(
    <DocumentPanel
      document={document}
      t={t}
      currentPage={0}
      selectedPages={[]}
      editing
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view, user: userEvent.setup() };
}

const tab = (name: string) => screen.getByRole('tab', { name }) as HTMLButtonElement;
const tabNames = () => screen.getAllByRole('tab').map((entry) => entry.getAttribute('aria-label'));

describe('DocumentPanel: the tabs', () => {
  it('offers every view and opens on the pages', () => {
    show();
    expect(tabNames()).toEqual(['Pages', 'Outline', 'Attachments', 'Layers', 'Signatures', 'Results']);
    expect(tab('Pages').getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('option').map((page) => page.getAttribute('aria-label'))).toEqual([
      'Go to page 1',
      'Go to page 2',
    ]);
  });

  it('switches view when a tab is chosen, and tells the shell', async () => {
    const onTabChange = vi.fn();
    const { user } = show({ onTabChange });
    await user.click(tab('Outline'));
    expect(onTabChange).toHaveBeenCalledExactlyOnceWith('outline');
    expect(tab('Outline').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(tab('Signatures'));
    expect(onTabChange).toHaveBeenLastCalledWith('signatures');
    expect(await screen.findByText('This document has no signature fields.')).toBeTruthy();
  });

  it('switches view without a shell that listens', async () => {
    const { user } = show();
    await user.click(tab('Layers'));
    expect(await screen.findByText('This document has no layers.')).toBeTruthy();
  });

  it('shows the tab a menu command asks for, whatever was chosen by hand', async () => {
    const onTabChange = vi.fn();
    const { user } = show({ tab: 'layers', onTabChange });
    expect(tab('Layers').getAttribute('aria-selected')).toBe('true');
    await user.click(tab('Results'));
    expect(onTabChange).toHaveBeenCalledExactlyOnceWith('search');
    expect(tab('Layers').getAttribute('aria-selected')).toBe('true');
  });

  it('offers only the tabs the mode keeps, and shows the first when the open one is hidden', () => {
    show({ visibleTabs: ['outline', 'search'] });
    expect(tabNames()).toEqual(['Outline', 'Results']);
    expect(tab('Outline').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the requested tab when the mode keeps it', () => {
    show({ visibleTabs: ['pages', 'search'], tab: 'search' });
    expect(tab('Results').getAttribute('aria-selected')).toBe('true');
  });

  it('shows nothing when the mode keeps no tab', () => {
    const { container } = show({ visibleTabs: [] });
    expect(container.innerHTML).toBe('');
  });

  it('collapses the dock from its toggle', async () => {
    const { user, onToggle } = show();
    await user.click(screen.getByRole('button', { name: 'Toggle left dock' }));
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe('DocumentPanel: pages', () => {
  it('goes to a page when its thumbnail is chosen, and selects it', async () => {
    const { user, onGoToPage, onSelectionChange } = show();
    await user.click(screen.getByRole('option', { name: 'Go to page 2' }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith([1]);
  });

  it('opens the extract dialog from the selection toolbar when the shell has one', async () => {
    const onExtract = vi.fn();
    const { user } = show({ selectedPages: [0], onExtract });
    await user.click(screen.getByRole('button', { name: 'Extract Pages' }));
    expect(onExtract).toHaveBeenCalledOnce();
  });

  it('leaves extracting disabled when the shell has no extract dialog', () => {
    show({ selectedPages: [0] });
    expect((screen.getByRole('button', { name: 'Extract Pages' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends page actions to the shell while editing, and not in viewing mode', async () => {
    const toolbarDelete = () =>
      within(screen.getByRole('toolbar')).getByRole('button', { name: 'Delete pages' }) as HTMLButtonElement;
    const { user, onPageAction } = show({ selectedPages: [0] });
    await user.click(toolbarDelete());
    expect(onPageAction).toHaveBeenCalledExactlyOnceWith({ kind: 'delete' });
    cleanup();
    show({ selectedPages: [0], editing: false });
    expect(toolbarDelete().disabled).toBe(true);
  });
});

describe('DocumentPanel: outline', () => {
  const OUTLINE: OutlineEntry[] = [
    {
      title: 'Chapter 1',
      pageIndex: 0,
      children: [{ title: 'Section 1.1', pageIndex: 1, children: [] }],
    },
    { title: 'Appendix', pageIndex: null, children: [] },
  ];

  it('says it is reading the outline until the document answers, then lists it', async () => {
    let resolve: (entries: OutlineEntry[]) => void = () => {};
    const outline = new Promise<OutlineEntry[]>((done) => {
      resolve = done;
    });
    const { user } = show({ document: documentOf(outline) });
    await user.click(tab('Outline'));
    expect(screen.getByText('Reading the outline…')).toBeTruthy();
    await act(async () => {
      resolve(OUTLINE);
      await outline;
    });
    expect(screen.getByRole('navigation', { name: 'Outline' })).toBeTruthy();
  });

  it('says the document has no outline', async () => {
    const { user } = show();
    await user.click(tab('Outline'));
    expect(await screen.findByText('This document has no outline.')).toBeTruthy();
  });

  it('lists the outline with nesting, marks the current page, and walks to a page', async () => {
    const { user, onGoToPage } = show({ document: documentOf(OUTLINE), currentPage: 1 });
    await user.click(tab('Outline'));
    const nav = await screen.findByRole('navigation', { name: 'Outline' });
    const entries = within(nav).getAllByRole('button');
    expect(entries.map((entry) => entry.textContent)).toEqual(['Chapter 1', 'Section 1.1', 'Appendix']);
    expect(entries.map((entry) => entry.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    expect(entries.map((entry) => (entry as HTMLButtonElement).disabled)).toEqual([false, false, true]);
    expect(entries[1]?.closest('ul')?.parentElement?.closest('ul')).not.toBeNull();

    await user.click(entries[1] as HTMLElement);
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);
    await user.click(entries[2] as HTMLElement);
    expect(onGoToPage).toHaveBeenCalledOnce();
  });

  it('offers to edit the outline only when the shell can, and only while editing', async () => {
    const onEditOutline = vi.fn();
    const { user } = show({ onEditOutline });
    await user.click(tab('Outline'));
    await user.click(screen.getByRole('button', { name: 'Edit outline' }));
    expect(onEditOutline).toHaveBeenCalledOnce();
    cleanup();

    show({ onEditOutline, editing: false, tab: 'outline' });
    expect((screen.getByRole('button', { name: 'Edit outline' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    show({ tab: 'outline' });
    expect(screen.queryByRole('button', { name: 'Edit outline' })).toBeNull();
  });

  it('shows the outline of the open document when an earlier one answers late', async () => {
    let resolveFirst: (entries: OutlineEntry[]) => void = () => {};
    const first = new Promise<OutlineEntry[]>((done) => {
      resolveFirst = done;
    });
    const { rerender } = show({ document: documentOf(first), tab: 'outline' });
    const props = {
      t,
      currentPage: 0,
      selectedPages: [] as number[],
      editing: true,
      tab: 'outline' as const,
      onGoToPage: vi.fn(),
      onSelectionChange: vi.fn(),
      onPageAction: vi.fn(),
      onAddAttachments: vi.fn(),
      onRemoveAttachments: vi.fn(),
      onToggle: vi.fn(),
    };
    rerender(
      <DocumentPanel {...props} document={documentOf([{ title: 'Current', pageIndex: 0, children: [] }])} />,
    );
    expect(await screen.findByRole('button', { name: 'Current' })).toBeTruthy();
    await act(async () => {
      resolveFirst([{ title: 'Stale', pageIndex: 0, children: [] }]);
      await first;
    });
    expect(screen.queryByRole('button', { name: 'Stale' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Current' })).toBeTruthy();
  });
});

describe('DocumentPanel: attachments', () => {
  const ATTACHMENT = { id: 'a', filename: 'report.csv', description: '', content: null };

  it('hands picked files and names to remove to the shell', async () => {
    engine.listPdfAttachments.mockResolvedValue([ATTACHMENT]);
    engine.readPdfAttachment.mockResolvedValue(new Uint8Array(1));
    const { user, container, onAddAttachments, onRemoveAttachments } = show({ tab: 'attachments' });
    await user.click(await screen.findByRole('button', { name: 'Remove attachment: report.csv' }));
    expect(onRemoveAttachments).toHaveBeenCalledExactlyOnceWith(['report.csv']);

    const file = new File(['x'], 'x.txt');
    await user.upload(container.querySelector('input[data-attachment-picker]') as HTMLInputElement, file);
    expect(onAddAttachments).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it('takes no writes in viewing mode', async () => {
    engine.listPdfAttachments.mockResolvedValue([ATTACHMENT]);
    engine.readPdfAttachment.mockResolvedValue(new Uint8Array(1));
    show({ tab: 'attachments', editing: false });
    expect(((await screen.findByRole('button', { name: 'Add file' })) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Remove attachment: report.csv' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('puts a failure on the shell notice line', async () => {
    engine.listPdfAttachments.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    show({ tab: 'attachments', onNotice });
    const failure = new ToolError('internal', { engine: 'pdfjs' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
  });
});

describe('DocumentPanel: layers', () => {
  const LAYER = { kind: 'group', id: 'A', name: 'Layer A', visible: true, children: [] };

  it('offers writing the layer state only when the shell can, and passes it on', async () => {
    engine.listPdfLayers.mockResolvedValue([LAYER]);
    const onWriteLayers = vi.fn();
    const { user } = show({ tab: 'layers', onWriteLayers });
    await user.click(await screen.findByRole('button', { name: 'Write layer state to the document' }));
    expect(onWriteLayers).toHaveBeenCalledExactlyOnceWith({
      states: [{ name: 'Layer A', visible: true }],
      order: ['Layer A'],
    });
    cleanup();

    show({ tab: 'layers' });
    await screen.findByRole('checkbox', { name: 'Layer A' });
    expect(screen.queryByRole('button', { name: 'Write layer state to the document' })).toBeNull();
  });

  it('stops writing in viewing mode', async () => {
    engine.listPdfLayers.mockResolvedValue([LAYER]);
    show({ tab: 'layers', onWriteLayers: vi.fn(), editing: false });
    const button = await screen.findByRole('button', { name: 'Write layer state to the document' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('tells the viewer to repaint after a layer is switched', async () => {
    engine.listPdfLayers.mockResolvedValue([LAYER]);
    engine.setPdfLayerVisibility.mockResolvedValue([{ ...LAYER, visible: false }]);
    const onLayersChanged = vi.fn();
    const { user } = show({ tab: 'layers', onLayersChanged });
    await user.click(await screen.findByRole('checkbox', { name: 'Layer A' }));
    await vi.waitFor(() => expect(onLayersChanged).toHaveBeenCalledOnce());
  });
});

describe('DocumentPanel: signatures and search', () => {
  it('walks to the page of a signature field', async () => {
    engine.listPdfSignatureFields.mockResolvedValue([{ name: 'Sig1', id: '1R', pageIndex: 1, signed: true }]);
    const { user, onGoToPage } = show({ tab: 'signatures' });
    await user.click(await screen.findByRole('button', { name: /Sig1/ }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('puts a signature read failure on the shell notice line', async () => {
    engine.listPdfSignatureFields.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    show({ tab: 'signatures', onNotice });
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledOnce());
  });

  it('goes to the page of a search result and asks the viewer to highlight the query', async () => {
    engine.searchPdfText.mockResolvedValue([
      { pageIndex: 1, index: 0, length: 3, snippet: 'fox den', snippetOffset: 0 },
    ]);
    const onHighlightQuery = vi.fn();
    const { user, onGoToPage } = show({ tab: 'search', onHighlightQuery });
    await user.type(screen.getByRole('textbox', { name: 'Find in document' }), 'fox{Enter}');
    await user.click(await screen.findByRole('button', { name: /fox den/ }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(onHighlightQuery).toHaveBeenCalledExactlyOnceWith('fox');
  });

  it('puts a search failure on the shell notice line', async () => {
    engine.searchPdfText.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    const { user } = show({ tab: 'search', onNotice });
    await user.type(screen.getByRole('textbox', { name: 'Find in document' }), 'fox{Enter}');
    await vi.waitFor(() => expect(onNotice).toHaveBeenCalledOnce());
  });
});
