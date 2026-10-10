// @vitest-environment happy-dom
/**
 * The right-click menu: it offers only the intents the shell wired, disables the writing ones
 * while the document cannot be edited, stays inside the viewport by its measured size, and
 * closes after an entry, on Escape and on a press outside it.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
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
    expect(items()).toEqual(['Rotate Clockwise (90°)', 'Fit Width']);
    expect(screen.getByText('Page & Edit')).toBeTruthy();
    expect(screen.queryByText('Text Selection Actions')).toBeNull();
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
      'Copy Text',
      'Redact Selection',
      'Add Note',
      'Rotate Clockwise (90°)',
      'Rotate Counterclockwise (-90°)',
      'Delete Current Page',
      'Add Text',
      'Edit Text',
      'Freehand Draw',
      'Fit Width',
    ]);
    expect(container.querySelectorAll('span[aria-hidden="true"].h-px')).toHaveLength(1);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Text Selection Actions')).toBeTruthy();
  });

  it('runs the chosen entry and then closes', async () => {
    const onDeletePage = vi.fn();
    const { onClose } = show({ onDeletePage });
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Delete Current Page' }));
    expect(onDeletePage).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('disables the entries that write while the document is read-only, and keeps the others live', async () => {
    const onRotateRight = vi.fn();
    const onFitWidth = vi.fn();
    const { onClose } = show({ canEdit: false, onRotateRight, onFitWidth });
    const user = userEvent.setup();
    const rotate = screen.getByRole('menuitem', { name: 'Rotate Clockwise (90°)' }) as HTMLButtonElement;
    const fit = screen.getByRole('menuitem', { name: 'Fit Width' }) as HTMLButtonElement;
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

  it('stops listening once it is gone', async () => {
    const { onClose, unmount } = show({ onFitWidth: vi.fn() });
    unmount();
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
