// @vitest-environment happy-dom
/**
 * The right-click menu: it offers only the intents the shell wired, disables the writing ones
 * while the document cannot be edited, stays inside the viewport by its measured size, and
 * closes after an entry, on Escape and on a press outside it.
 */

import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, type ContextMenuProps } from './ContextMenu';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const t = createTranslator('en');

function show(props: Partial<ContextMenuProps> = {}) {
  const onClose = vi.fn();
  const view = render(
    <ContextMenu x={40} y={60} t={t} hasSelection={false} canEdit onClose={onClose} {...props} />,
  );
  return { onClose, ...view };
}

const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

describe('ContextMenu', () => {
  it('lists only the page entries the shell wired, under their heading, without a selection block', () => {
    show({ onRotateRight: vi.fn(), onFitWidth: vi.fn() });
    expect(items()).toEqual(['Rotate right', 'Fit width']);
    expect(screen.getByText('Page and edit')).toBeTruthy();
    expect(screen.queryByText('Text selection actions')).toBeNull();
  });

  it('puts the selection block ahead of the page block, split by a separator, when text is selected', () => {
    const { container } = show({
      hasSelection: true,
      onHighlight: vi.fn(),
      onUnderline: vi.fn(),
      onStrikeout: vi.fn(),
      onCopy: vi.fn(),
      onRedact: vi.fn(),
      onAddNote: vi.fn(),
      onRotateRight: vi.fn(),
      onRotateLeft: vi.fn(),
      onDeletePage: vi.fn(),
      onAddText: vi.fn(),
      onEditText: vi.fn(),
      onDrawInk: vi.fn(),
      onFitWidth: vi.fn(),
    });
    expect(items()).toEqual([
      'Highlight',
      'Underline',
      'Strikethrough',
      'Copy text',
      'Redact selection',
      'Add note',
      'Rotate right',
      'Rotate left',
      'Delete this page',
      'Add text',
      'Edit text',
      'Freehand drawing',
      'Fit width',
    ]);
    expect(container.querySelectorAll('span[aria-hidden="true"].h-px')).toHaveLength(1);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Text selection actions')).toBeTruthy();
  });

  it('runs the chosen entry and then closes', async () => {
    const onDeletePage = vi.fn();
    const { onClose } = show({ onDeletePage });
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Delete this page' }));
    expect(onDeletePage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables the entries that write while the document is read-only, and keeps the others live', async () => {
    const onRotateRight = vi.fn();
    const onFitWidth = vi.fn();
    const { onClose } = show({ canEdit: false, onRotateRight, onFitWidth });
    const user = userEvent.setup();
    const rotate = screen.getByRole('menuitem', { name: 'Rotate right' }) as HTMLButtonElement;
    const fit = screen.getByRole('menuitem', { name: 'Fit width' }) as HTMLButtonElement;
    expect(rotate.disabled).toBe(true);
    expect(fit.disabled).toBe(false);
    await user.click(rotate);
    expect(onRotateRight).not.toHaveBeenCalled();
    await user.click(fit);
    expect(onFitWidth).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens where it was asked when it fits', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 300));
    show({ x: 40, y: 60, onFitWidth: vi.fn() });
    expect(screen.getByRole('menu').style.cssText).toContain('left: 40px; top: 60px;');
  });

  it('is pulled back inside the viewport by its measured size at the far corner', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 300));
    show({ x: window.innerWidth - 10, y: window.innerHeight - 10, onFitWidth: vi.fn() });
    expect(screen.getByRole('menu').style.cssText).toContain(
      `left: ${window.innerWidth - 200 - 8}px; top: ${window.innerHeight - 300 - 8}px;`,
    );
  });

  it('keeps an 8 px margin from the top-left edge', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 300));
    show({ x: 1, y: 2, onFitWidth: vi.fn() });
    expect(screen.getByRole('menu').style.cssText).toContain('left: 8px; top: 8px;');
  });

  it('closes on Escape and ignores other keys', async () => {
    const { onClose } = show({ onFitWidth: vi.fn() });
    const user = userEvent.setup();
    await user.keyboard('a');
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on a press outside the menu, not on one inside it', async () => {
    const { onClose } = show({ onFitWidth: vi.fn() });
    const user = userEvent.setup();
    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('menu') });
    expect(onClose).not.toHaveBeenCalled();
    await user.pointer({ keys: '[MouseLeft>]', target: document.body });
    expect(onClose).toHaveBeenCalledOnce();
  });

  describe('the keyboard', () => {
    const WIRED = { onRotateRight: vi.fn(), onDeletePage: vi.fn(), onAddText: vi.fn(), onFitWidth: vi.fn() };
    const focused = () => document.activeElement?.textContent;

    it('takes focus into the first entry as it opens', () => {
      show(WIRED);
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rotate right' }));
    });

    it('lands on the first entry that is live while the document is read-only', () => {
      show({ ...WIRED, canEdit: false });
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Fit width' }));
    });

    it('takes focus itself when every entry it offers is disabled, and walks nowhere', async () => {
      show({ onRotateRight: vi.fn(), onDeletePage: vi.fn(), canEdit: false });
      const menu = screen.getByRole('menu');
      expect(document.activeElement).toBe(menu);
      const user = userEvent.setup();
      await user.keyboard('{ArrowDown}{ArrowUp}{Home}{End}');
      expect(document.activeElement).toBe(menu);
    });

    it('walks the entries with the arrow keys, wrapping at both ends', async () => {
      show(WIRED);
      const user = userEvent.setup();
      await user.keyboard('{ArrowDown}');
      expect(focused()).toBe('Delete this page');
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(focused()).toBe('Fit width');
      await user.keyboard('{ArrowDown}');
      expect(focused()).toBe('Rotate right');
      await user.keyboard('{ArrowUp}');
      expect(focused()).toBe('Fit width');
      await user.keyboard('{ArrowUp}');
      expect(focused()).toBe('Add text');
    });

    it('walks past the disabled entries while the document is read-only', async () => {
      show({
        hasSelection: true,
        canEdit: false,
        onHighlight: vi.fn(),
        onCopy: vi.fn(),
        onRedact: vi.fn(),
        onRotateRight: vi.fn(),
        onFitWidth: vi.fn(),
      });
      const user = userEvent.setup();
      // Copy and Fit Width are the only entries that do not write: the keys reach those two.
      expect(focused()).toBe('Copy text');
      await user.keyboard('{ArrowDown}');
      expect(focused()).toBe('Fit width');
      await user.keyboard('{ArrowDown}');
      expect(focused()).toBe('Copy text');
      await user.keyboard('{ArrowUp}');
      expect(focused()).toBe('Fit width');
      await user.keyboard('{Home}');
      expect(focused()).toBe('Copy text');
    });

    it('goes to the first and last entry with Home and End', async () => {
      show(WIRED);
      const user = userEvent.setup();
      await user.keyboard('{End}');
      expect(focused()).toBe('Fit width');
      await user.keyboard('{Home}');
      expect(focused()).toBe('Rotate right');
    });

    it('enters the last entry with ArrowUp from the menu itself, and keeps the keys it does not use', async () => {
      show({ ...WIRED, canEdit: false });
      const menu = screen.getByRole('menu');
      act(() => menu.focus());
      const user = userEvent.setup();
      await user.keyboard('{ArrowUp}');
      expect(focused()).toBe('Fit width');
      const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      act(() => {
        screen.getByRole('menuitem', { name: 'Fit width' }).dispatchEvent(other);
      });
      expect(other.defaultPrevented).toBe(false);
    });

    it('closes on Tab and keeps focus from walking on into the page', async () => {
      const { onClose } = show(WIRED);
      await userEvent.setup().keyboard('{Tab}');
      expect(onClose).toHaveBeenCalledOnce();
      expect(focused()).toBe('Rotate right');
    });

    it('hands focus back to where it was when it closes with focus still inside', () => {
      const opener = document.createElement('button');
      document.body.append(opener);
      try {
        opener.focus();
        const { unmount } = show(WIRED);
        expect(document.activeElement).not.toBe(opener);
        unmount();
        expect(document.activeElement).toBe(opener);
      } finally {
        opener.remove();
      }
    });

    it('leaves focus where an entry sent it', async () => {
      const opener = document.createElement('button');
      const elsewhere = document.createElement('input');
      document.body.append(opener, elsewhere);
      try {
        opener.focus();
        const onAddText = vi.fn(() => elsewhere.focus());
        const { unmount } = show({ onAddText });
        await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Add text' }));
        expect(document.activeElement).toBe(elsewhere);
        unmount();
        expect(document.activeElement).toBe(elsewhere);
      } finally {
        opener.remove();
        elsewhere.remove();
      }
    });

    it('opened with nothing focused, drops its focus with the menu instead of inventing a target', () => {
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      const { unmount } = show(WIRED);
      unmount();
      expect(document.activeElement).toBe(document.body);
    });
  });

  it('stops listening once it is gone', async () => {
    const { onClose, unmount } = show({ onFitWidth: vi.fn() });
    unmount();
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
