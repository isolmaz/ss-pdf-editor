// @vitest-environment happy-dom
/**
 * The palette and the settings dialog mount only while the shell store says they are open. Their
 * internals are pdf-ui's own; here they are stand-ins that expose the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle } from '../core/handles';
import { hideStartScreen, initialOpenState, openStore } from '../open/open-store';
import { PaletteHost, SettingsHost, type SettingsHostProps } from './ShellOverlays';
import { initialShellState, openPalette, openSettings, shellStore } from './shell-store';

vi.mock('pdf-ui/palette', async () => {
  const { createElement } = await import('react');
  return {
    CommandPalette: (props: {
      commands: readonly Command[];
      open: boolean;
      hiddenByMode: number;
      onClose: () => void;
      onRun: (command: Command) => void;
      onUseAdvanced: () => void;
    }) =>
      createElement(
        'section',
        {
          'aria-label': 'palette',
          'data-open': String(props.open),
          'data-hidden': String(props.hiddenByMode),
        },
        createElement('button', { type: 'button', onClick: props.onClose }, 'close palette'),
        createElement('button', { type: 'button', onClick: props.onUseAdvanced }, 'use advanced'),
        ...props.commands.map((command) =>
          createElement(
            'button',
            { key: command.id, type: 'button', onClick: () => props.onRun(command) },
            command.id,
          ),
        ),
      ),
  };
});
vi.mock('pdf-ui/dialog', async () => {
  const { createElement } = await import('react');
  return {
    SettingsDialog: (props: {
      mode: string;
      sensitive: boolean | null;
      onClose: () => void;
      onModeChange: (mode: string) => void;
      onToggleSensitive: () => void;
      onSaveDraft: () => void;
      onPurgeDocument: () => void;
      onSweepVault: () => void;
      onPrepareOffline: () => void;
      onCheckOffline: () => void;
      onShowShortcuts: () => void;
    }) =>
      createElement(
        'section',
        { 'aria-label': 'settings', 'data-mode': props.mode, 'data-sensitive': String(props.sensitive) },
        createElement('button', { type: 'button', onClick: props.onClose }, 'close settings'),
        createElement('button', { type: 'button', onClick: () => props.onModeChange('advanced') }, 'mode'),
        createElement('button', { type: 'button', onClick: props.onToggleSensitive }, 'sensitive'),
        createElement('button', { type: 'button', onClick: props.onSaveDraft }, 'save draft'),
        createElement('button', { type: 'button', onClick: props.onPurgeDocument }, 'purge'),
        createElement('button', { type: 'button', onClick: props.onSweepVault }, 'sweep'),
        createElement('button', { type: 'button', onClick: props.onPrepareOffline }, 'prepare offline'),
        createElement('button', { type: 'button', onClick: props.onCheckOffline }, 'check offline'),
        createElement('button', { type: 'button', onClick: props.onShowShortcuts }, 'shortcuts'),
      ),
  };
});

type SettingsSpies = Record<keyof SettingsHostProps['actions'], Mock>;

// The hosts load their dialogs lazily: resolve the (mocked) modules up front so the first
// open does not wait on a cold import. Static imports would defeat the point.
beforeAll(async () => {
  await import('pdf-ui/palette');
  await import('pdf-ui/dialog');
}, 120_000);

const t = createTranslator('en');
const handle = { id: 'h' } as unknown as PdfDocumentHandle;
let session: SessionStore;

function command(id: string, run: () => void = vi.fn()): Command {
  return { id, labelKey: 'shell.save', group: 'file', run };
}

afterEach(cleanup);

beforeEach(() => {
  coreStore.set(initialCoreState());
  shellStore.set(initialShellState());
  openStore.set(initialOpenState());
  session = new SessionStore();
});

describe('PaletteHost', () => {
  it('mounts nothing while the palette is closed', () => {
    render(<PaletteHost t={t} commands={[command('file.new')]} changeMode={vi.fn()} />);
    expect(screen.queryByLabelText('palette')).toBeNull();
  });

  it('lists every command in the advanced mode and closes on request', async () => {
    const user = userEvent.setup();
    coreStore.set({ mode: 'advanced' });
    render(
      <PaletteHost t={t} commands={[command('file.new'), command('x.advanced-only')]} changeMode={vi.fn()} />,
    );
    act(() => openPalette());
    const palette = await screen.findByLabelText('palette');
    expect(palette.getAttribute('data-hidden')).toBe('0');
    expect(screen.getByRole('button', { name: 'x.advanced-only' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'close palette' }));
    expect(shellStore.get().paletteOpen).toBe(false);
    expect(screen.queryByLabelText('palette')).toBeNull();
  });

  it('offers only the simple mode commands and counts the hidden ones', async () => {
    coreStore.set({ mode: 'simple' });
    render(
      <PaletteHost t={t} commands={[command('file.new'), command('x.advanced-only')]} changeMode={vi.fn()} />,
    );
    act(() => openPalette());
    const palette = await screen.findByLabelText('palette');
    expect(palette.getAttribute('data-hidden')).toBe('1');
    expect(screen.getByRole('button', { name: 'file.new' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'x.advanced-only' })).toBeNull();
  });

  it('closes the palette, then runs the chosen command', async () => {
    const user = userEvent.setup();
    const run = vi.fn(() => {
      expect(shellStore.get().paletteOpen).toBe(false);
    });
    coreStore.set({ mode: 'advanced' });
    render(<PaletteHost t={t} commands={[command('file.new', run)]} changeMode={vi.fn()} />);
    act(() => openPalette());
    await user.click(await screen.findByRole('button', { name: 'file.new' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(shellStore.get().paletteOpen).toBe(false);
  });

  it('switches to the advanced mode from the hint', async () => {
    const user = userEvent.setup();
    const changeMode = vi.fn();
    coreStore.set({ mode: 'simple' });
    render(<PaletteHost t={t} commands={[command('file.new')]} changeMode={changeMode} />);
    act(() => openPalette());
    await user.click(await screen.findByRole('button', { name: 'use advanced' }));
    expect(changeMode).toHaveBeenCalledWith('advanced');
  });
});

describe('SettingsHost', () => {
  function actions(): SettingsSpies {
    return {
      changeMode: vi.fn(),
      toggleSensitiveSession: vi.fn(),
      opfsSave: vi.fn(async () => undefined),
      purgeActiveDocument: vi.fn(async () => undefined),
      sweepVault: vi.fn(async () => undefined),
      prepareOfflinePackages: vi.fn(async () => undefined),
      checkOffline: vi.fn(async () => undefined),
      showShortcuts: vi.fn(),
    };
  }

  function mount(given: SettingsSpies) {
    return render(<SettingsHost session={session} tier="desktop" t={t} actions={given} />);
  }

  it('mounts nothing while the dialog is closed', () => {
    mount(actions());
    expect(screen.queryByLabelText('settings')).toBeNull();
  });

  it('shows the mode and no sensitive flag with no document, and closes on request', async () => {
    const user = userEvent.setup();
    coreStore.set({ mode: 'simple' });
    mount(actions());
    act(() => openSettings());
    const dialog = await screen.findByLabelText('settings');
    expect(dialog.getAttribute('data-mode')).toBe('simple');
    expect(dialog.getAttribute('data-sensitive')).toBe('null');
    await user.click(screen.getByRole('button', { name: 'close settings' }));
    expect(shellStore.get().settingsOpen).toBe(false);
  });

  it("shows the active document's sensitive flag", async () => {
    const tab = session.openDocument({
      name: 'a.pdf',
      bytes: new Uint8Array([1]),
      sha256: 'a',
      pageCount: 1,
    });
    adoptHandle(tab.id, handle);
    hideStartScreen();
    session.setSensitive(tab.id, true);
    mount(actions());
    act(() => openSettings());
    expect((await screen.findByLabelText('settings')).getAttribute('data-sensitive')).toBe('true');
  });

  it('hands each control to the shell action it names', async () => {
    const user = userEvent.setup();
    const given = actions();
    mount(given);
    act(() => openSettings());
    await screen.findByLabelText('settings');
    await user.click(screen.getByRole('button', { name: 'mode' }));
    expect(given.changeMode).toHaveBeenCalledWith('advanced');
    await user.click(screen.getByRole('button', { name: 'sensitive' }));
    expect(given.toggleSensitiveSession).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'save draft' }));
    expect(given.opfsSave).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'purge' }));
    expect(given.purgeActiveDocument).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'sweep' }));
    expect(given.sweepVault).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'prepare offline' }));
    expect(given.prepareOfflinePackages).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'check offline' }));
    expect(given.checkOffline).toHaveBeenCalledTimes(1);
    expect(shellStore.get().settingsOpen).toBe(true);
  });

  it('closes the dialog before it shows the shortcuts', async () => {
    const user = userEvent.setup();
    const given = actions();
    given.showShortcuts.mockImplementation(() => {
      expect(shellStore.get().settingsOpen).toBe(false);
    });
    mount(given);
    act(() => openSettings());
    await user.click(await screen.findByRole('button', { name: 'shortcuts' }));
    expect(given.showShortcuts).toHaveBeenCalledTimes(1);
    expect(shellStore.get().settingsOpen).toBe(false);
  });
});
