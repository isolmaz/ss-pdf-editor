// @vitest-environment happy-dom
/**
 * The application menu bar, to the ARIA menubar pattern: one trigger per populated group, a
 * roving tab stop, the menu a trigger owns and the entry highlighted in it, what each key does
 * on the bar and in a menu, and what a press, a hover and a press elsewhere do.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, type MessageKey } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenuBar } from './MenuBar';
import type { Command, MenuGroup } from './types';

const t = createTranslator('en');

afterEach(cleanup);

function command(
  id: string,
  labelKey: MessageKey,
  group: MenuGroup,
  overrides: Partial<Command> = {},
): Command {
  return { id, labelKey, group, run: vi.fn(), ...overrides };
}

const pages = command('pages', 'panel.pages', 'file');
const outline = command('outline', 'panel.outline', 'file', { disabled: true });
const attachments = command('attachments', 'panel.attachments', 'file', {
  shortcut: 'Ctrl+A',
  icon: <svg data-testid="attachments-icon" />,
});
const layers = command('layers', 'panel.layers', 'view', { checked: true });
const signatures = command('signatures', 'panel.signatures', 'view', { checked: false });
const search = command('search', 'panel.search', 'view', { danger: true });
const comments = command('comments', 'panel.comments', 'tools', { disabled: true });
const forms = command('forms', 'panel.forms', 'tools', { disabled: true });
const compare = command('compare', 'panel.compare', 'help');
const ALL = [pages, outline, attachments, layers, signatures, search, comments, forms, compare];

function show(commands: readonly Command[] = ALL) {
  const view = render(<MenuBar t={t} commands={commands} />);
  return { view, rerender: (next: readonly Command[]) => view.rerender(<MenuBar t={t} commands={next} />) };
}

const trigger = (name: string) => screen.getByRole('menuitem', { name });
const menu = () => screen.getByRole('menu');
const items = () => [...menu().querySelectorAll<HTMLElement>('[role^="menuitem"]')];
const activeItem = () => document.getElementById(menu().getAttribute('aria-activedescendant') ?? '');
const activeLabel = () => activeItem()?.textContent;

describe('MenuBar structure', () => {
  it('draws nothing without commands', () => {
    const { view } = show([]);
    expect(view.container.innerHTML).toBe('');
  });

  it('has a trigger for each populated group only, in menu order, in a labelled menubar', () => {
    show();
    const bar = screen.getByRole('menubar', { name: 'Application menu' });
    expect(
      within(bar)
        .getAllByRole('menuitem')
        .map((el) => el.textContent),
    ).toEqual(['File', 'View', 'Tools', 'Help']);
  });

  it('makes the first trigger the only tab stop, each announcing a closed menu', () => {
    show();
    const triggers = ['File', 'View', 'Tools', 'Help'].map(trigger);
    expect(triggers.map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);
    for (const el of triggers) {
      expect(el.getAttribute('aria-haspopup')).toBe('menu');
      expect(el.getAttribute('aria-expanded')).toBe('false');
      expect(el.hasAttribute('aria-controls')).toBe(false);
    }
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('moves the tab stop to the trigger last used, and back to the first when its group empties', async () => {
    const { rerender } = show();
    await userEvent.click(trigger('View'));
    expect(['File', 'View', 'Tools', 'Help'].map((name) => trigger(name).tabIndex)).toEqual([-1, 0, -1, -1]);

    rerender([pages, compare]);
    expect(['File', 'Help'].map((name) => trigger(name).tabIndex)).toEqual([0, -1]);
  });
});

describe('MenuBar opening and closing with the pointer', () => {
  it('opens the menu a trigger owns and links them both ways', async () => {
    show();
    await userEvent.click(trigger('File'));

    expect(trigger('File').getAttribute('aria-expanded')).toBe('true');
    expect(menu().id).toBe(trigger('File').getAttribute('aria-controls'));
    expect(menu().getAttribute('aria-labelledby')).toBe(trigger('File').id);
    expect(screen.getByRole('menu', { name: 'File' })).toBe(menu());
    expect(items().map((el) => el.textContent)).toEqual(['Pages', 'Outline', 'AttachmentsCtrl+A']);
  });

  it('closes it again on a second press and puts focus back on the trigger', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.click(trigger('File'));

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger('File').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger('File'));
  });

  it('draws each entry as it is: toggles with their state, disabled, icon, shortcut and danger', async () => {
    show();
    await userEvent.click(trigger('File'));
    const [first, second, third] = items();
    expect(first?.getAttribute('role')).toBe('menuitem');
    expect(first?.hasAttribute('aria-checked')).toBe(false);
    expect(second?.hasAttribute('disabled')).toBe(true);
    expect(first?.hasAttribute('disabled')).toBe(false);
    expect(within(third as HTMLElement).getByTestId('attachments-icon')).toBeTruthy();
    expect(within(third as HTMLElement).getByText('Ctrl+A')).toBeTruthy();
    expect(first?.querySelector('svg')).toBeNull();
    expect(first?.className).toContain('text-kumo-default');

    await userEvent.click(trigger('File'));
    await userEvent.click(trigger('View'));
    const [checked, unchecked, danger] = items();
    expect(checked?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(checked?.getAttribute('aria-checked')).toBe('true');
    expect(checked?.querySelector('svg')).not.toBeNull();
    expect(unchecked?.getAttribute('role')).toBe('menuitemcheckbox');
    expect(unchecked?.getAttribute('aria-checked')).toBe('false');
    expect(unchecked?.querySelector('svg')).toBeNull();
    expect(danger?.className).toContain('text-kumo-danger');
  });

  it('draws a rule where the section changes, and nowhere else', async () => {
    const sectioned = [
      command('a', 'panel.pages', 'file', { section: 0 }),
      command('b', 'panel.outline', 'file', { section: 0 }),
      command('c', 'panel.attachments', 'file', { section: 1 }),
      command('d', 'panel.layers', 'file', { section: 2 }),
    ];
    show(sectioned);
    await userEvent.click(trigger('File'));
    // Entries and rules in the order drawn: a rule sits between two sections, never at an end.
    const drawn = [...menu().children].map((child) => (child.tagName === 'HR' ? '---' : child.textContent));
    expect(drawn).toEqual(['Pages', 'Outline', '---', 'Attachments', '---', 'Layers']);
    expect(within(menu()).getAllByRole('separator')).toHaveLength(2);
    // The rules are not entries: the keyboard walks the four entries.
    expect(items()).toHaveLength(4);
  });

  it('draws no rule in a menu whose entries carry no section', async () => {
    show();
    await userEvent.click(trigger('File'));
    expect(within(menu()).queryAllByRole('separator')).toHaveLength(0);
  });

  it('explains a disabled entry with its reason, and an enabled one with nothing', async () => {
    const reasoned = [
      command('a', 'panel.pages', 'file', { disabled: true, disabledReason: 'cmd.reason.noDocument' }),
      command('b', 'panel.outline', 'file', { disabled: true }),
      command('c', 'panel.attachments', 'file', { disabledReason: 'cmd.reason.noDocument' }),
    ];
    show(reasoned);
    await userEvent.click(trigger('File'));
    const [withReason, withoutReason, enabled] = items();
    const text = t('cmd.reason.noDocument');
    expect(withReason?.getAttribute('title')).toBe(text);
    expect(withReason?.getAttribute('aria-description')).toBe(text);
    expect(withoutReason?.hasAttribute('title')).toBe(false);
    expect(withoutReason?.hasAttribute('aria-description')).toBe(false);
    expect(enabled?.hasAttribute('title')).toBe(false);
    expect(enabled?.hasAttribute('aria-description')).toBe(false);
  });

  it('highlights the first enabled entry and leaves focus on the trigger when opened by a press', async () => {
    show([outline, pages, attachments]);
    await userEvent.click(trigger('File'));
    expect(activeLabel()).toBe('Pages');
    expect(document.activeElement).toBe(trigger('File'));
  });

  it('runs an entry pressed, once, after closing the menu and returning focus to its trigger', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.click(screen.getByRole('menuitem', { name: /^Attachments/ }));

    expect(attachments.run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger('File'));
  });

  it('does not run a disabled entry and keeps the menu open', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Outline' }));

    expect(outline.run).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('closes on a press anywhere else but not on a press inside the bar or its menu', async () => {
    const { view } = show();
    await userEvent.click(trigger('File'));

    fireEvent.pointerDown(menu());
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(trigger('View'));
    expect(screen.getByRole('menu')).toBeTruthy();

    fireEvent.pointerDown(view.container.ownerDocument.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger('File').getAttribute('aria-expanded')).toBe('false');
  });

  it('stops listening for presses elsewhere once closed', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.click(trigger('File'));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('MenuBar hover', () => {
  it('does nothing on a bar with no menu open', async () => {
    show();
    await userEvent.hover(trigger('View'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('swaps the open menu to the trigger hovered, and leaves it alone on its own trigger', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.hover(trigger('File'));
    expect(screen.getByRole('menu', { name: 'File' })).toBeTruthy();

    await userEvent.hover(trigger('View'));
    expect(screen.getByRole('menu', { name: 'View' })).toBeTruthy();
    expect(trigger('File').getAttribute('aria-expanded')).toBe('false');
  });

  it('highlights an enabled entry under the pointer and ignores a disabled one', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.hover(screen.getByRole('menuitem', { name: /^Attachments/ }));
    expect(activeLabel()).toBe('AttachmentsCtrl+A');

    await userEvent.hover(screen.getByRole('menuitem', { name: 'Outline' }));
    expect(activeLabel()).toBe('AttachmentsCtrl+A');
  });
});

describe('MenuBar keys on a trigger', () => {
  it.each([
    ['{ArrowRight}', 'File', 'View'],
    ['{ArrowRight}', 'Help', 'File'],
    ['{ArrowLeft}', 'View', 'File'],
    ['{ArrowLeft}', 'File', 'Help'],
    ['{Home}', 'Tools', 'File'],
    ['{End}', 'Tools', 'Help'],
  ])('%s on %s moves focus and the tab stop to %s', async (key, from, to) => {
    show();
    trigger(from).focus();
    await userEvent.keyboard(key);

    expect(document.activeElement).toBe(trigger(to));
    expect(trigger(to).tabIndex).toBe(0);
    expect(trigger(from).tabIndex).toBe(-1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('carries an open menu along the bar, focusing into the one it arrives at', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.keyboard('{ArrowRight}');

    expect(screen.getByRole('menu', { name: 'View' })).toBeTruthy();
    expect(trigger('File').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu());
    expect(activeLabel()).toBe('Layers');
  });

  it.each([['{ArrowDown}'], ['{Enter}'], [' ']])(
    '%j opens the menu with focus in it and the first entry highlighted',
    async (key) => {
      show();
      trigger('File').focus();
      await userEvent.keyboard(key);

      expect(document.activeElement).toBe(menu());
      expect(activeLabel()).toBe('Pages');
      expect(trigger('File').getAttribute('aria-expanded')).toBe('true');
    },
  );

  it.each([['{ArrowDown}'], ['{Enter}']])(
    '%j enters a menu a press already opened and highlights its first entry',
    async (key) => {
      show();
      await userEvent.click(trigger('File'));
      expect(document.activeElement).toBe(trigger('File'));
      await userEvent.keyboard(key);

      expect(document.activeElement).toBe(menu());
      expect(activeLabel()).toBe('Pages');
    },
  );

  it('does not carry the request to enter a menu over to the next menu a press opens', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();

    await userEvent.click(trigger('View'));
    expect(screen.getByRole('menu', { name: 'View' })).toBeTruthy();
    expect(document.activeElement).toBe(trigger('View'));
  });

  it('opens on the last enabled entry with ArrowUp', async () => {
    show([pages, attachments, command('closed', 'panel.comments', 'file', { disabled: true })]);
    trigger('File').focus();
    await userEvent.keyboard('{ArrowUp}');

    expect(document.activeElement).toBe(menu());
    expect(activeLabel()).toBe('AttachmentsCtrl+A');
  });

  it('closes an open menu with Escape, keeping focus where it is', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger('File'));
  });

  it('leaves Escape alone when no menu is open, so it can reach whatever is behind the bar', () => {
    show();
    trigger('File').focus();
    expect(fireEvent.keyDown(trigger('File'), { key: 'Escape' })).toBe(true);
  });

  it('closes an open menu on Tab and lets focus move on', async () => {
    show();
    await userEvent.click(trigger('File'));
    await userEvent.tab();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not open a menu on Tab with none open, or on any other key', async () => {
    show();
    trigger('File').focus();
    await userEvent.tab();
    expect(screen.queryByRole('menu')).toBeNull();

    trigger('View').focus();
    await userEvent.keyboard('x');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('MenuBar keys in a menu', () => {
  async function openFile() {
    show();
    trigger('File').focus();
    await userEvent.keyboard('{ArrowDown}');
  }

  it('marks only the keyboard-active entry, so it is drawn highlighted like a hovered one', async () => {
    await openFile();
    const marked = () => items().filter((el) => el.hasAttribute('data-active'));
    expect(marked().map((el) => el.textContent)).toEqual(['Pages']);
    await userEvent.keyboard('{ArrowDown}');
    expect(marked().map((el) => el.textContent)).toEqual(['AttachmentsCtrl+A']);
    expect(marked()[0]?.className).toContain('data-[active]:bg-kumo-tint');
  });

  it('walks the enabled entries with the arrows, skipping a disabled one and wrapping at either end', async () => {
    await openFile();
    expect(activeLabel()).toBe('Pages');
    await userEvent.keyboard('{ArrowDown}');
    expect(activeLabel()).toBe('AttachmentsCtrl+A');
    await userEvent.keyboard('{ArrowDown}');
    expect(activeLabel()).toBe('Pages');
    await userEvent.keyboard('{ArrowUp}');
    expect(activeLabel()).toBe('AttachmentsCtrl+A');
    await userEvent.keyboard('{ArrowUp}');
    expect(activeLabel()).toBe('Pages');
  });

  it('jumps to the first and last enabled entry with Home and End', async () => {
    await openFile();
    await userEvent.keyboard('{End}');
    expect(activeLabel()).toBe('AttachmentsCtrl+A');
    await userEvent.keyboard('{Home}');
    expect(activeLabel()).toBe('Pages');
  });

  it.each([['{Enter}'], [' ']])(
    '%j runs the highlighted entry, closes and returns focus to the trigger',
    async (key) => {
      await openFile();
      await userEvent.keyboard('{ArrowDown}');
      await userEvent.keyboard(key);

      expect(attachments.run).toHaveBeenCalledTimes(1);
      expect(pages.run).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger('File'));
    },
  );

  it('closes on Escape and puts focus back on the trigger', async () => {
    await openFile();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger('File'));
  });

  it('closes on Tab and leaves the key to the browser, so focus moves on instead of returning', async () => {
    await openFile();
    expect(fireEvent.keyDown(menu(), { key: 'Tab' })).toBe(true);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ignores any other key', async () => {
    await openFile();
    await userEvent.keyboard('x');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(activeLabel()).toBe('Pages');
  });

  it('can be entered when every entry is disabled, but has nothing to highlight or run', async () => {
    show();
    trigger('Tools').focus();
    await userEvent.keyboard('{ArrowDown}');

    expect(document.activeElement).toBe(menu());
    expect(menu().hasAttribute('aria-activedescendant')).toBe(false);
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Home}{End}{Enter}');
    expect(comments.run).not.toHaveBeenCalled();
    expect(forms.run).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on the first entry with ArrowUp when every entry is disabled', async () => {
    show();
    trigger('Tools').focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(menu());
    expect(menu().hasAttribute('aria-activedescendant')).toBe(false);
  });
});
