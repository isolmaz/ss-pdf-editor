// @vitest-environment happy-dom
/**
 * The export dialog and the context menu follow the export store: they are on screen exactly
 * while the store says so, and what the user chooses reaches the shell as the exact calls the
 * shell wires. The export dialog's internals are pdf-ui's own (and tested there); here it is a
 * stand-in that exposes the props the shell wires. The context menu is the real one.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionTab } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { ContextMenuHost, ExportDialogHost } from './ExportSurfaces';
import { exportStore, initialExportState, openContextMenu, openExportDialog } from './export-store';

vi.mock('pdf-ui/dialog', async () => {
  const { createElement } = await import('react');
  return {
    ExportDialog: (props: {
      open: boolean;
      fileName: string;
      fileSize: number;
      onClose: () => void;
      onExport: (options: { kind: string }) => void;
    }) =>
      createElement(
        'section',
        {
          'aria-label': 'export dialog',
          'data-open': String(props.open),
          'data-name': props.fileName,
          'data-size': String(props.fileSize),
        },
        createElement('button', { type: 'button', onClick: props.onClose }, 'close export'),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onExport({ kind: 'text' }) },
          'export',
        ),
      ),
  };
});

const t = createTranslator('en');

// The dialog is a dynamic chunk (mocked here): resolve it once up front so no test races the first import.
beforeAll(async () => {
  await import('pdf-ui/dialog');
}, 120_000);
beforeEach(() => {
  exportStore.set(initialExportState());
  coreStore.set(initialCoreState());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function tabOf(produced: Uint8Array | null): SessionTab {
  return {
    id: 'tab',
    name: 'report.pdf',
    source: { master: new Uint8Array(3) },
    working: { produced: produced === null ? null : { bytes: produced } },
  } as unknown as SessionTab;
}

describe('ExportDialogHost', () => {
  it('shows the dialog exactly while the store says it is open and a document is', async () => {
    const tab = tabOf(null);
    const { rerender } = render(<ExportDialogHost t={t} tab={tab} onExport={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'export dialog' })).toBeNull();

    act(() => openExportDialog());
    expect(await screen.findByRole('region', { name: 'export dialog' })).toBeTruthy();

    rerender(<ExportDialogHost t={t} tab={null} onExport={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'export dialog' })).toBeNull();
  });

  it('names the file and sizes it from the opened bytes until a version has been produced', async () => {
    const view = render(<ExportDialogHost t={t} tab={tabOf(null)} onExport={vi.fn()} />);
    act(() => openExportDialog());
    const dialog = await screen.findByRole('region', { name: 'export dialog' });
    expect(dialog.getAttribute('data-open')).toBe('true');
    expect(dialog.getAttribute('data-name')).toBe('report.pdf');
    expect(dialog.getAttribute('data-size')).toBe('3');

    view.rerender(<ExportDialogHost t={t} tab={tabOf(new Uint8Array(11))} onExport={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'export dialog' }).getAttribute('data-size')).toBe('11');
  });

  it('closes through the store and passes the choice to the shell', async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(<ExportDialogHost t={t} tab={tabOf(null)} onExport={onExport} />);
    act(() => openExportDialog());

    await user.click(await screen.findByRole('button', { name: 'export' }));
    expect(onExport).toHaveBeenCalledWith({ kind: 'text' });

    await user.click(screen.getByRole('button', { name: 'close export' }));
    expect(exportStore.get().exportOpen).toBe(false);
    expect(screen.queryByRole('region', { name: 'export dialog' })).toBeNull();
  });
});

describe('ContextMenuHost', () => {
  function host(overrides: { viewer?: ViewerApi | null; canEdit?: boolean } = {}) {
    const setRedactionMarks = vi.fn();
    const onPageAction = vi.fn();
    const viewer = { current: overrides.viewer === undefined ? null : overrides.viewer };
    render(
      <ContextMenuHost
        t={t}
        canEdit={overrides.canEdit ?? true}
        viewer={viewer}
        setRedactionMarks={setRedactionMarks}
        onPageAction={onPageAction}
      />,
    );
    return { setRedactionMarks, onPageAction };
  }

  /** A browser selection whose one client rectangle sits on page 2. */
  function selectWords(text: string) {
    const removeAllRanges = vi.fn();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => text,
      getRangeAt: () => ({
        getClientRects: () => [{ left: 10, top: 20, right: 60, bottom: 32, width: 50, height: 12 }],
      }),
      removeAllRanges,
    } as unknown as Selection);
    return removeAllRanges;
  }
  const pageViewer = (setZoom = vi.fn()) =>
    ({ pointToPage: (x: number, y: number) => ({ pageIndex: 2, x, y }), setZoom }) as unknown as ViewerApi;

  it('renders nothing until the store holds a menu, and closes through it', async () => {
    const user = userEvent.setup();
    host();
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => openContextMenu({ x: 5, y: 6, hasSelection: false }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Copy' })).toBeNull();

    await user.keyboard('{Escape}');
    expect(exportStore.get().contextMenu).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers the selection entries only when words are selected, and arms the markup tools', async () => {
    const user = userEvent.setup();
    host();
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'words' }));

    await user.click(screen.getByRole('menuitem', { name: t('context.highlight') }));
    expect(coreStore.get().canvasTool).toBe('highlight');
    expect(exportStore.get().contextMenu).toBeNull();

    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'words' }));
    await user.click(screen.getByRole('menuitem', { name: t('context.underline') }));
    expect(coreStore.get().canvasTool).toBe('underline');

    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'words' }));
    await user.click(screen.getByRole('menuitem', { name: t('context.strikeout') }));
    expect(coreStore.get().canvasTool).toBe('strikeout');
  });

  it('copies the selected words to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    host();
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'words' }));

    await user.click(screen.getByRole('menuitem', { name: t('context.copy') }));

    expect(writeText).toHaveBeenCalledWith('words');
  });

  it('copies nothing when the menu carries no selected text', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    host();
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true }));

    await user.click(screen.getByRole('menuitem', { name: t('context.copy') }));

    expect(writeText).not.toHaveBeenCalled();
  });

  it('turns the selected words into pending redaction areas and arms the redact tool', async () => {
    const user = userEvent.setup();
    const removeAllRanges = selectWords('secret');
    const { setRedactionMarks } = host({ viewer: pageViewer() });
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'secret' }));

    await user.click(screen.getByRole('menuitem', { name: t('context.redact') }));

    expect(setRedactionMarks).toHaveBeenCalledTimes(1);
    const change = setRedactionMarks.mock.calls[0]?.[0] as (marks: readonly unknown[]) => readonly unknown[];
    const existing = { id: 'old', mark: {} };
    const next = change([existing]) as { id: string; mark: unknown }[];
    expect(next[0]).toBe(existing);
    expect(next).toHaveLength(2);
    expect(next[1]?.mark).toEqual({ pageIndex: 2, space: 'app-v1', rect: [10, 20, 60, 32] });
    expect(next[1]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
    expect(coreStore.get().canvasTool).toBe('redact');
  });

  it('arms the redact tool and marks nothing when the selection covers no page', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: true, rangeCount: 0 } as Selection);
    const { setRedactionMarks } = host({ viewer: pageViewer() });
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'secret' }));

    await user.click(screen.getByRole('menuitem', { name: t('context.redact') }));

    expect(setRedactionMarks).not.toHaveBeenCalled();
    expect(coreStore.get().canvasTool).toBe('redact');
  });

  it('arms the redact tool and marks nothing while no viewer is mounted', async () => {
    const user = userEvent.setup();
    const { setRedactionMarks } = host({ viewer: null });
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'secret' }));

    await user.click(screen.getByRole('menuitem', { name: t('context.redact') }));

    expect(setRedactionMarks).not.toHaveBeenCalled();
    expect(coreStore.get().canvasTool).toBe('redact');
  });

  it('adds a note through the rail route, which also opens the comments dock', async () => {
    const user = userEvent.setup();
    host();
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: true, selectedText: 'words' }));

    await user.click(screen.getByRole('menuitem', { name: t('context.addNote') }));

    expect(coreStore.get().canvasTool).toBe('note');
    expect(coreStore.get().rightTab).toBe('comments');
  });

  it('runs the page actions the menu names', async () => {
    const user = userEvent.setup();
    const { onPageAction } = host();
    const entries: [string, unknown][] = [
      ['context.rotateCW', { kind: 'rotate', direction: 'right' }],
      ['context.rotateCCW', { kind: 'rotate', direction: 'left' }],
      ['context.deletePage', { kind: 'delete' }],
    ];
    for (const [key, action] of entries) {
      act(() => openContextMenu({ x: 5, y: 6, hasSelection: false }));
      await user.click(screen.getByRole('menuitem', { name: t(key as never) }));
      expect(onPageAction).toHaveBeenLastCalledWith(action);
    }
    expect(onPageAction).toHaveBeenCalledTimes(3);
  });

  it('arms the text, free text and ink tools', async () => {
    const user = userEvent.setup();
    host();
    for (const [key, tool] of [
      ['context.addText', 'freetext'],
      ['context.editText', 'text'],
      ['context.drawInk', 'ink'],
    ] as const) {
      act(() => openContextMenu({ x: 5, y: 6, hasSelection: false }));
      await user.click(screen.getByRole('menuitem', { name: t(key) }));
      expect(coreStore.get().canvasTool).toBe(tool);
    }
  });

  it('fits the page width on the viewer on screen, and does nothing without one', async () => {
    const user = userEvent.setup();
    const setZoom = vi.fn();
    const withViewer = host({ viewer: pageViewer(setZoom) });
    expect(withViewer.onPageAction).not.toHaveBeenCalled();
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: false }));
    await user.click(screen.getByRole('menuitem', { name: t('context.fitWidth') }));
    expect(setZoom).toHaveBeenCalledWith('page-width');
    cleanup();

    host({ viewer: null });
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: false }));
    await user.click(screen.getByRole('menuitem', { name: t('context.fitWidth') }));
    expect(exportStore.get().contextMenu).toBeNull();
  });

  it('disables the entries that write while the document cannot be edited', () => {
    host({ canEdit: false });
    act(() => openContextMenu({ x: 5, y: 6, hasSelection: false }));
    expect(
      (screen.getByRole('menuitem', { name: t('context.deletePage') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('menuitem', { name: t('context.fitWidth') }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
