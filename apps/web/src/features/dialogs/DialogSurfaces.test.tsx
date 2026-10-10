// @vitest-environment happy-dom
/**
 * The modals the dialogs store opens: each is on screen exactly while the store says so, loads
 * on demand, and its own controls write the store (or the status line) back.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { OperationDialogSpec, OpRunResult } from 'pdf-ui/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_SHORTCUT_GROUPS } from '../../useShortcuts';
import { coreStore, initialCoreState } from '../core/core-store';
import { BatchDialogHost, ShortcutsDialogHost, StartDialogHost } from './DialogSurfaces';
import {
  dialogsStore,
  initialDialogsState,
  openBatchDialog,
  shortcutsOpened,
  startDialogOpened,
} from './dialogs-store';

const mocks = vi.hoisted(() => ({ downloadFiles: vi.fn() }));
vi.mock('../../operations', () => ({ downloadFiles: mocks.downloadFiles }));
vi.mock('pdf-ui/dialog', () => ({
  BatchDialog: (props: {
    open: boolean;
    onClose: () => void;
    onDownload: (files: never[]) => void;
    onNotice: (text: string) => void;
  }) => (
    <div role="dialog" aria-label="Batch" data-open={String(props.open)}>
      <button type="button" onClick={props.onClose}>
        Close batch
      </button>
      <button type="button" onClick={() => props.onDownload([{ name: 'a.pdf' }] as never[])}>
        Download batch
      </button>
      <button type="button" onClick={() => props.onNotice('batch said')}>
        Notify batch
      </button>
    </div>
  ),
  StartDialog: (props: {
    spec: { id: string };
    context: { bytes: Uint8Array; pageCount: number; name: string; currentPage: number };
    onClose: () => void;
    onResult: (result: OpRunResult) => void;
  }) => (
    <div role="dialog" aria-label={`Start ${props.spec.id}`}>
      <p>
        context {props.context.bytes.length} {props.context.pageCount} {props.context.currentPage}
      </p>
      <button type="button" onClick={props.onClose}>
        Close start
      </button>
      <button type="button" onClick={() => props.onResult({ files: [] } as unknown as OpRunResult)}>
        Run start
      </button>
    </div>
  ),
  ShortcutsDialog: (props: { open: boolean; groups: readonly unknown[]; onClose: () => void }) => (
    <div role="dialog" aria-label="Shortcuts" data-open={String(props.open)}>
      <p>{props.groups.length} groups</p>
      <button type="button" onClick={props.onClose}>
        Close shortcuts
      </button>
    </div>
  ),
}));

const t = createTranslator('en');

beforeEach(() => {
  vi.clearAllMocks();
  dialogsStore.set(initialDialogsState());
  coreStore.set(initialCoreState());
});
afterEach(cleanup);

describe('StartDialogHost', () => {
  const spec = { id: 'merge' } as unknown as OperationDialogSpec;

  it('mounts the standalone dialog only while a spec is open, with an empty run context', async () => {
    const onResult = vi.fn().mockResolvedValue(undefined);
    render(<StartDialogHost t={t} onResult={onResult} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => startDialogOpened(spec));
    expect(await screen.findByRole('dialog', { name: 'Start merge' })).toBeTruthy();
    expect(screen.getByText('context 0 0 0')).toBeTruthy();
  });

  it('hands the dialog’s result to the shell and closes on its own Close', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn().mockResolvedValue(undefined);
    render(<StartDialogHost t={t} onResult={onResult} />);
    act(() => startDialogOpened(spec));

    await user.click(await screen.findByRole('button', { name: 'Run start' }));
    expect(onResult).toHaveBeenCalledWith({ files: [] });

    await user.click(screen.getByRole('button', { name: 'Close start' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialogsStore.get().startSpec).toBeNull();
  });
});

describe('BatchDialogHost', () => {
  it('mounts the batch dialog only while the store says it is open', async () => {
    render(<BatchDialogHost t={t} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => openBatchDialog());
    const dialog = await screen.findByRole('dialog', { name: 'Batch' });
    expect(dialog.getAttribute('data-open')).toBe('true');
  });

  it('downloads its files, reports on the status line and closes itself', async () => {
    const user = userEvent.setup();
    render(<BatchDialogHost t={t} />);
    act(() => openBatchDialog());

    await user.click(await screen.findByRole('button', { name: 'Download batch' }));
    expect(mocks.downloadFiles).toHaveBeenCalledWith([{ name: 'a.pdf' }]);

    await user.click(screen.getByRole('button', { name: 'Notify batch' }));
    expect(coreStore.get().notice).toBe('batch said');

    await user.click(screen.getByRole('button', { name: 'Close batch' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dialogsStore.get().batchOpen).toBe(false);
  });
});

describe('ShortcutsDialogHost', () => {
  it('mounts the shortcut list only while open and prints the shell’s shortcut groups', async () => {
    render(<ShortcutsDialogHost t={t} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => shortcutsOpened(null));
    expect(await screen.findByRole('dialog', { name: 'Shortcuts' })).toBeTruthy();
    expect(screen.getByText(`${SHELL_SHORTCUT_GROUPS.length} groups`)).toBeTruthy();
  });

  it('asks the shell to close it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ShortcutsDialogHost t={t} onClose={onClose} />);
    act(() => shortcutsOpened(null));

    await user.click(await screen.findByRole('button', { name: 'Close shortcuts' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
