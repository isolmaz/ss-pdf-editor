// @vitest-environment happy-dom
/**
 * The header's three toggles (tools panel, reading pane, text editing) show their state from
 * the stores they flip, its one-shot actions and file actions call the shell's handlers, the
 * name edits in place, and the document switcher is a popover.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, openRightPanel, selectTool } from '../features/core/core-store';
import { readingStore, toggleReading } from '../features/reading/reading-store';
import { ModernEditorHeader, type ModernEditorHeaderProps } from './ModernEditorHeader';

const t = createTranslator('en');
const initialCore = coreStore.get();
const initialReading = readingStore.get();
const button = (name: string) => screen.getByRole('button', { name });
const pressed = (name: string) => button(name).getAttribute('aria-pressed');

const tabs = [
  { id: 'a', name: 'one.pdf', dirty: true },
  { id: 'b', name: 'two.pdf', dirty: false },
];

function props(overrides: Partial<ModernEditorHeaderProps> = {}): ModernEditorHeaderProps {
  return {
    t,
    docName: 'one.pdf',
    isDirty: false,
    canEdit: true,
    onConvert: vi.fn(),
    onSign: vi.fn(),
    onHome: vi.fn(),
    onOpen: vi.fn(),
    canSave: true,
    saveMode: 'save',
    onSave: vi.fn(),
    canExport: true,
    onExport: vi.fn(),
    onExportOptions: vi.fn(),
    onSearch: vi.fn(),
    onPalette: vi.fn(),
    menu: <span>menu</span>,
    tabs,
    activeTabId: 'a',
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onSettings: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  coreStore.set(initialCore);
  readingStore.set(initialReading);
});
afterEach(cleanup);

describe('ModernEditorHeader toggles', () => {
  it('presses the tools panel only while the right dock shows it, and toggles it', async () => {
    const user = userEvent.setup();
    render(<ModernEditorHeader {...props()} />);
    const tools = t('mode.tools');
    expect(pressed(tools)).toBe('false');

    await user.click(button(tools));
    expect(coreStore.get()).toMatchObject({ rightDock: true, rightTab: 'tools' });
    expect(pressed(tools)).toBe('true');

    await user.click(button(tools));
    expect(coreStore.get().rightDock).toBe(false);
    expect(pressed(tools)).toBe('false');

    act(() => openRightPanel('history'));
    expect(pressed(tools)).toBe('false');
  });

  it('presses reading while the pane is open, whichever route opened it', async () => {
    const user = userEvent.setup();
    render(<ModernEditorHeader {...props()} />);
    const read = t('mode.read');
    expect(pressed(read)).toBe('false');

    act(() => toggleReading());
    expect(pressed(read)).toBe('true');

    await user.click(button(read));
    expect(readingStore.get().reading).toBe(false);
  });

  it('presses text editing while the text tool is armed, and a second press stops it', async () => {
    const user = userEvent.setup();
    render(<ModernEditorHeader {...props()} />);
    const edit = t('mode.edit');
    expect(pressed(edit)).toBe('false');

    await user.click(button(edit));
    expect(coreStore.get().canvasTool).toBe('text');
    expect(pressed(edit)).toBe('true');

    act(() => selectTool('ink'));
    expect(pressed(edit)).toBe('false');
  });

  it('disables editing and converting when the document allows neither', () => {
    render(<ModernEditorHeader {...props({ canEdit: false, canExport: false })} />);
    expect(button(t('mode.edit')).hasAttribute('disabled')).toBe(true);
    expect(button(t('mode.convert')).hasAttribute('disabled')).toBe(true);
  });

  it('offers convert and sign as one-shot actions that show no pressed state', async () => {
    const user = userEvent.setup();
    const onConvert = vi.fn();
    const onSign = vi.fn();
    render(<ModernEditorHeader {...props({ onConvert, onSign })} />);
    expect(button(t('mode.convert')).hasAttribute('aria-pressed')).toBe(false);

    await user.click(button(t('mode.convert')));
    await user.click(button(t('mode.sign')));
    expect(onConvert).toHaveBeenCalledTimes(1);
    expect(onSign).toHaveBeenCalledTimes(1);
  });
});

describe('ModernEditorHeader actions', () => {
  it('routes the identity, search, palette, open, export and settings controls to the shell', async () => {
    const user = userEvent.setup();
    const handlers = {
      onHome: vi.fn(),
      onSearch: vi.fn(),
      onPalette: vi.fn(),
      onOpen: vi.fn(),
      onExport: vi.fn(),
      onExportOptions: vi.fn(),
      onSettings: vi.fn(),
    };
    render(<ModernEditorHeader {...props(handlers)} />);
    expect(screen.getByText('menu')).toBeTruthy();

    await user.click(button(t('shell.home')));
    await user.click(button(t('shell.search')));
    await user.click(button(t('palette.title')));
    await user.click(button(t('shell.open')));
    await user.click(button(t('shell.export')));
    await user.click(button(t('tools.exportOptions')));
    await user.click(button(t('settings.open')));

    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledTimes(1);
  });

  it('saves in place, lit while there are changes to save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<ModernEditorHeader {...props({ onSave, isDirty: true })} />);

    await user.click(button(t('shell.save')));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle(t('status.dirty'))).toBeTruthy();
  });

  it('asks where to save a document with no file yet, and is disabled when it cannot save', () => {
    render(<ModernEditorHeader {...props({ saveMode: 'saveAs', canSave: false, canExport: false })} />);
    expect(button(t('shell.saveAs')).hasAttribute('disabled')).toBe(true);
    expect(button(t('shell.export')).hasAttribute('disabled')).toBe(true);
  });

  it('offers no Save where the browser can only download', () => {
    render(<ModernEditorHeader {...props({ saveMode: 'none' })} />);
    expect(screen.queryByRole('button', { name: t('shell.save') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('shell.saveAs') })).toBeNull();
  });
});

describe('ModernEditorHeader rename', () => {
  const field = () => screen.getByRole('textbox', { name: t('shell.rename.prompt') }) as HTMLInputElement;

  it('selects the name on focus and commits what was typed on Enter', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onRenameCancel = vi.fn();
    render(<ModernEditorHeader {...props({ renaming: true, onRename, onRenameCancel })} />);
    expect(field().value).toBe('one.pdf');

    await user.clear(field());
    await user.type(field(), 'new.pdf{Enter}');

    expect(onRename).toHaveBeenCalledWith('new.pdf');
    expect(onRenameCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape, and the next blur commits again', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onRenameCancel = vi.fn();
    render(<ModernEditorHeader {...props({ renaming: true, onRename, onRenameCancel })} />);

    await user.type(field(), 'x{Escape}');
    expect(onRenameCancel).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();

    field().focus();
    fireEvent.blur(field());
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing commit or cancel handler', async () => {
    const user = userEvent.setup();
    render(<ModernEditorHeader {...props({ renaming: true })} />);
    await user.type(field(), '{Enter}');
    await user.type(field(), '{Escape}');
    expect(field()).toBeTruthy();
  });

  it('shows no tab list while renaming', () => {
    render(<ModernEditorHeader {...props({ renaming: true })} />);
    expect(screen.queryByText(new RegExp(t('shell.openTabs')))).toBeNull();
  });
});

describe('ModernEditorHeader document switcher', () => {
  const switcher = () => screen.getAllByRole('button', { name: /one\.pdf/ })[0] as HTMLElement;

  it('lists the open documents, marks the dirty ones and switches on a pick', async () => {
    const user = userEvent.setup();
    const onSelectTab = vi.fn();
    render(<ModernEditorHeader {...props({ onSelectTab })} />);
    expect(switcher().getAttribute('aria-expanded')).toBe('false');

    await user.click(switcher());
    expect(switcher().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(`${t('shell.openTabs')} (2)`)).toBeTruthy();

    await user.click(screen.getByTitle('two.pdf'));
    expect(onSelectTab).toHaveBeenCalledWith('b');
    expect(screen.queryByText(`${t('shell.openTabs')} (2)`)).toBeNull();
  });

  it('closes a document from the list without closing the list', async () => {
    const user = userEvent.setup();
    const onCloseTab = vi.fn();
    render(<ModernEditorHeader {...props({ onCloseTab })} />);

    await user.click(switcher());
    await user.click(screen.getAllByRole('button', { name: t('shell.closeTab') })[1] as HTMLElement);

    expect(onCloseTab).toHaveBeenCalledWith('b');
    expect(screen.getByText(`${t('shell.openTabs')} (2)`)).toBeTruthy();
  });

  it('closes on its own button, on Escape and on a press outside, but not on a press inside', async () => {
    const user = userEvent.setup();
    render(<ModernEditorHeader {...props()} />);
    const open = () => screen.queryByText(`${t('shell.openTabs')} (2)`) !== null;

    await user.click(switcher());
    await user.click(switcher());
    expect(open()).toBe(false);

    await user.click(switcher());
    await user.keyboard('{a}');
    expect(open()).toBe(true);
    await user.keyboard('{Escape}');
    expect(open()).toBe(false);

    await user.click(switcher());
    fireEvent.pointerDown(screen.getByText(`${t('shell.openTabs')} (2)`));
    expect(open()).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(open()).toBe(false);

    await user.click(switcher());
    fireEvent.pointerDown(window);
    expect(open()).toBe(false);
  });
});
