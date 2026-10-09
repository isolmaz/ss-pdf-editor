// @vitest-environment happy-dom
/**
 * The command palette: what it lists for a query and in which order, what a click or Enter
 * runs (once, after closing), how recent commands rise to the top, what it says when nothing
 * matches, and how a blocked or damaged store of recent commands is survived.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, type MessageKey } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { CommandPalette, type CommandPaletteProps } from './CommandPalette';
import type { Command } from './types';

const t = createTranslator('en');
const RECENT_KEY = 'pdf-editor.recent-commands';

function command(id: string, labelKey: MessageKey, overrides: Partial<Command> = {}): Command {
  return { id, labelKey, group: 'file', run: vi.fn(), ...overrides };
}

const open = command('open', 'panel.pages', { group: 'file' });
const outline = command('outline', 'panel.outline', { group: 'view', shortcut: 'Ctrl+O' });
const attach = command('attach', 'panel.attachments', {
  group: 'tools',
  keywords: ['Paperclip', 'embed'],
  icon: <svg data-testid="attach-icon" />,
});
const layers = command('layers', 'panel.layers', { group: 'view', checked: true, danger: true });
const signatures = command('signatures', 'panel.signatures', { group: 'tools', disabled: true });
const ALL = [open, outline, attach, layers, signatures];

const blocked: MockInstance[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  for (const spy of blocked.splice(0)) spy.mockRestore();
  cleanup();
});

function show(overrides: Partial<CommandPaletteProps> = {}) {
  const onClose = vi.fn();
  const onRun = vi.fn();
  const props: CommandPaletteProps = { t, commands: ALL, open: true, onClose, onRun, ...overrides };
  const view = render(<CommandPalette {...props} />);
  return { onClose, onRun, view, props };
}

const input = () => screen.getByRole('combobox', { name: 'Command palette' });
const options = () => screen.queryAllByRole('option');
const labels = () => options().map((option) => within(option).getAllByText(/./)[0]?.textContent);

describe('CommandPalette listing', () => {
  it('draws nothing while closed', () => {
    show({ open: false });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('lists every command in the order given, with the live count, hint and placeholder', () => {
    show();
    expect(labels()).toEqual(['Pages', 'Outline', 'Attachments', 'Layers', 'Signatures']);
    expect(screen.getByText('5 command(s)').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByText('↑↓ navigate · Enter execute · Esc close')).toBeTruthy();
    expect(input().getAttribute('placeholder')).toBe('Search commands or tools…');
  });

  it('shows each command’s group, shortcut, icon and checked state, and marks a disabled one', () => {
    show();
    const row = (name: string) => options().find((option) => within(option).queryByText(name) !== null);
    expect(within(row('Outline') as HTMLElement).getByText('View')).toBeTruthy();
    expect(within(row('Outline') as HTMLElement).getByText('Ctrl+O')).toBeTruthy();
    expect(within(row('Attachments') as HTMLElement).getByTestId('attach-icon')).toBeTruthy();
    expect(within(row('Layers') as HTMLElement).getByText('Layers').className).toContain('text-kumo-danger');
    expect(within(row('Pages') as HTMLElement).getByText('Pages').className).toContain('text-kumo-default');
    expect(row('Layers')?.querySelector('svg')).not.toBeNull();
    expect(row('Pages')?.querySelector('svg')).toBeNull();
    expect(row('Signatures')?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('CommandPalette filtering', () => {
  it.each<[string, string[]]>([
    ['pages', ['Pages']],
    ['att', ['Attachments']],
    ['ments', ['Attachments']],
    ['ayer', ['Layers']],
    ['olne', ['Outline']],
    ['sgntrs', ['Signatures']],
  ])('"%s" lists %j', async (query, expected) => {
    show();
    await userEvent.type(input(), query);
    expect(labels()).toEqual(expected);
    expect(screen.getByText(`${expected.length} command(s)`)).toBeTruthy();
  });

  it('ranks an exact label above a prefix, a prefix above a word start, a word start above a substring and a substring above letters in order', async () => {
    const words: Partial<Record<MessageKey, string>> = {
      'panel.pages': 'chart',
      'panel.outline': 'concatenate',
      'panel.attachments': 'the cat',
      'panel.layers': 'catalog',
      'panel.signatures': 'cat',
      'shell.menu.file': 'File',
    };
    const lexicon = Object.assign((key: MessageKey) => words[key] ?? key, { locale: 'en' as const });
    show({
      t: lexicon,
      commands: [open, outline, attach, layers, signatures].map((c) => ({ ...c, disabled: false })),
    });
    await userEvent.type(screen.getByRole('combobox'), 'cat');
    expect(labels()).toEqual(['cat', 'catalog', 'the cat', 'concatenate', 'chart']);
  });

  it('matches a keyword exactly, by prefix or inside, case-insensitively', async () => {
    show();
    await userEvent.type(input(), 'PaperClip');
    expect(labels()).toEqual(['Attachments']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'paperc');
    expect(labels()).toEqual(['Attachments']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'mbe');
    expect(labels()).toEqual(['Attachments']);
  });

  it('matches a group name by prefix or inside it, ranking below label matches', async () => {
    show();
    await userEvent.type(input(), 'view');
    expect(labels()).toEqual(['Outline', 'Layers']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'ool');
    expect(labels()).toEqual(['Attachments', 'Signatures']);
  });

  it('folds the Turkish dotted İ so a Turkish keyboard finds a keyword that begins with it', async () => {
    const watch = command('watch', 'panel.pages', { keywords: ['İzle'] });
    show({ commands: [watch, outline] });
    await userEvent.type(input(), 'İZL');
    expect(labels()).toEqual(['Pages']);
    await userEvent.clear(input());
    await userEvent.type(input(), 'izl');
    expect(labels()).toEqual(['Pages']);
  });

  it('ignores the whitespace around a query', async () => {
    show();
    await userEvent.type(input(), '  pages  ');
    expect(labels()).toEqual(['Pages']);
  });

  it('says nothing matches, and offers no way out unless the simple mode hides commands', async () => {
    show();
    await userEvent.type(input(), 'zzzz');
    expect(screen.getByText('No matching commands.')).toBeTruthy();
    expect(screen.getByText('0 command(s)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Advanced mode' })).toBeNull();
  });

  it('also says nothing is hidden when the simple mode hides zero commands', async () => {
    show({ hiddenByMode: 0 });
    await userEvent.type(input(), 'zzzz');
    expect(screen.queryByRole('button', { name: 'Advanced mode' })).toBeNull();
  });

  it('tells the user how many commands the simple mode hides and leaves it from the empty state', async () => {
    const onUseAdvanced = vi.fn();
    show({ hiddenByMode: 3, onUseAdvanced });
    await userEvent.type(input(), 'zzzz');

    expect(screen.getByText('3 more command(s) are hidden by the simple mode.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Advanced mode' }));
    expect(onUseAdvanced).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input());
  });

  it('survives the Advanced button being pressed with no handler given', async () => {
    show({ hiddenByMode: 1 });
    await userEvent.type(input(), 'zzzz');
    await userEvent.click(screen.getByRole('button', { name: 'Advanced mode' }));
    expect(document.activeElement).toBe(input());
  });
});

describe('CommandPalette running a command', () => {
  it('closes first, then runs exactly the command clicked, once', async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    const onRun = vi.fn((chosen: Command) => order.push(`run ${chosen.id}`));
    show({ onClose, onRun });

    await userEvent.click(options()[1] as HTMLElement);

    expect(order).toEqual(['close', 'run outline']);
    expect(onRun).toHaveBeenCalledExactlyOnceWith(outline);
  });

  it('does not run a disabled command', async () => {
    const { onRun, onClose } = show();
    await userEvent.click(options()[4] as HTMLElement);
    expect(onRun).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('runs the highlighted command on Enter, once, even though the primitive also activates it', async () => {
    const { onRun, onClose } = show();
    await userEvent.type(input(), 'out');
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(onRun).toHaveBeenCalledExactlyOnceWith(outline);
    expect(onClose).toHaveBeenCalled();
  });

  it('runs nothing on Enter when no command is highlighted', async () => {
    const { onRun } = show();
    await userEvent.type(input(), 'zzzz{Enter}');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('runs nothing on Enter when the highlighted command has since been filtered out', async () => {
    const { onRun } = show();
    await userEvent.type(input(), 'out');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.type(input(), 'zzzz{Enter}');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('runs nothing on Enter when the highlighted command is disabled', async () => {
    const { onRun } = show();
    await userEvent.type(input(), 'sign');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { onClose } = show();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets a second opening run a command again', async () => {
    const { onRun, view, props } = show();
    await userEvent.click(options()[0] as HTMLElement);
    view.rerender(<CommandPalette {...props} open={false} />);
    view.rerender(<CommandPalette {...props} open />);
    await userEvent.click(options()[0] as HTMLElement);

    expect(onRun).toHaveBeenCalledTimes(2);
  });
});

describe('CommandPalette recent commands', () => {
  it('stores what was run, newest first and without repeats, and lists it first on an empty query', async () => {
    const first = show();
    await userEvent.click(options()[2] as HTMLElement);
    first.view.unmount();
    const second = show();
    await userEvent.click(options()[3] as HTMLElement);
    second.view.unmount();
    const third = show();
    await userEvent.click(options()[1] as HTMLElement);
    third.view.unmount();

    expect(JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]')).toEqual(['attach', 'layers']);
  });

  it('puts recently run commands first, the newest foremost, when a palette opens with an empty query', async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(['layers', 'attach']));
    show();
    expect(labels()).toEqual(['Layers', 'Attachments', 'Pages', 'Outline', 'Signatures']);
  });

  it('keeps only the twenty most recent', async () => {
    const many = Array.from({ length: 25 }, (_, index) => `old-${index}`);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(many));
    show();
    await userEvent.click(options()[0] as HTMLElement);

    const stored = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
    expect(stored).toHaveLength(20);
    expect(stored.slice(0, 2)).toEqual(['open', 'old-0']);
  });

  it('lets a recent command outrank an equally good match', async () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(['layers']));
    show();
    await userEvent.type(input(), 'view');
    expect(labels()).toEqual(['Layers', 'Outline']);
  });

  it('drops non-string entries from the stored list', () => {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([7, null, 'attach']));
    show();
    expect(labels()).toEqual(['Attachments', 'Pages', 'Outline', 'Layers', 'Signatures']);
  });

  it.each([
    ['not JSON', '{oops'],
    ['not a list', '{"a":1}'],
    ['empty', ''],
  ])('ignores a stored list that is %s', (_, raw) => {
    window.localStorage.setItem(RECENT_KEY, raw);
    show();
    expect(labels()).toEqual(['Pages', 'Outline', 'Attachments', 'Layers', 'Signatures']);
  });

  it('still runs commands when the store is blocked', async () => {
    blocked.push(
      vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      }),
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      }),
    );
    const { onRun } = show();
    expect(labels()).toEqual(['Pages', 'Outline', 'Attachments', 'Layers', 'Signatures']);
    await userEvent.click(options()[0] as HTMLElement);
    expect(onRun).toHaveBeenCalledExactlyOnceWith(open);
  });
});
