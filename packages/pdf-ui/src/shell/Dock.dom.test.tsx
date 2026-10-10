// @vitest-environment happy-dom
/**
 * The dock: an icon rail of tabs next to the active tab's panel. What it labels, which tab is
 * selected, what a press and the arrow keys do to the selection and the focus, which side the
 * rail sits on, and what it draws when it has nothing or an unknown selection.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dock, type DockProps, type DockTab } from './Dock';

const t = createTranslator('en');

afterEach(cleanup);

const TABS: readonly DockTab[] = [
  { id: 'pages', label: 'panel.pages' },
  { id: 'outline', label: 'panel.outline' },
  { id: 'attachments', label: 'panel.attachments' },
];

function show(overrides: Partial<DockProps> = {}) {
  const onSelect = vi.fn();
  const onToggle = vi.fn();
  const view = render(
    <Dock
      t={t}
      side="left"
      tabs={TABS}
      activeId="outline"
      onSelect={onSelect}
      onToggle={onToggle}
      {...overrides}
    >
      <p>The panel body</p>
    </Dock>,
  );
  return { onSelect, onToggle, view, root: view.container.firstElementChild as HTMLElement };
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('Dock', () => {
  it('draws nothing without tabs', () => {
    const { view } = show({ tabs: [] });
    expect(view.container.innerHTML).toBe('');
  });

  it('labels the left rail "Left dock" and the right rail "Right dock"', () => {
    show({ side: 'left' });
    expect(screen.getByRole('tablist', { name: 'Left dock' })).toBeTruthy();
    cleanup();
    show({ side: 'right' });
    expect(screen.getByRole('tablist', { name: 'Right dock' })).toBeTruthy();
  });

  it('names every tab by its label and selects the active one, which alone is a tab stop', () => {
    show();
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Pages',
      'Outline',
      'Attachments',
    ]);
    expect(screen.getAllByRole('tab').map((el) => el.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(screen.getAllByRole('tab').map((el) => el.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('shows the first tab when the active id names none', () => {
    show({ activeId: 'missing' });
    expect(tab('Pages').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Pages', { selector: 'span' })).toBeTruthy();
  });

  it('puts the active tab’s title and content in a tabpanel that the tab labels', () => {
    show();
    const panel = screen.getByRole('tabpanel', { name: 'Outline' });
    expect(within(panel).getByText('The panel body')).toBeTruthy();
    expect(tab('Outline').getAttribute('aria-controls')).toBe(panel.id);
    expect(screen.getByText('Outline', { selector: 'span' })).toBeTruthy();
  });

  it('selects the tab pressed, by its id', async () => {
    const { onSelect } = show();
    await userEvent.click(tab('Attachments'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('attachments');
  });

  it('collapses through the toggle button, named for its side', async () => {
    const left = show({ side: 'left' });
    await userEvent.click(screen.getByRole('button', { name: 'Toggle left dock' }));
    expect(left.onToggle).toHaveBeenCalledTimes(1);
    cleanup();

    const right = show({ side: 'right' });
    await userEvent.click(screen.getByRole('button', { name: 'Toggle right dock' }));
    expect(right.onToggle).toHaveBeenCalledTimes(1);
  });

  it('puts the rail before the panel on the left and after it on the right', () => {
    const left = show({ side: 'left' });
    expect(left.root.firstElementChild?.getAttribute('role')).toBe('tablist');
    expect(left.root.className).toContain('w-72');
    cleanup();

    const right = show({ side: 'right' });
    expect(right.root.lastElementChild?.getAttribute('role')).toBe('tablist');
    expect(right.root.className).toContain('w-80');
  });

  it('widens only the right dock, and only when asked to', () => {
    expect(show({ side: 'right', wide: true }).root.className).toContain('w-[26rem]');
    cleanup();
    expect(show({ side: 'left', wide: true }).root.className).toContain('w-72');
  });
});

describe('Dock keyboard', () => {
  it.each([
    ['{ArrowRight}', 'attachments'],
    ['{ArrowDown}', 'attachments'],
    ['{ArrowLeft}', 'pages'],
    ['{ArrowUp}', 'pages'],
    ['{Home}', 'pages'],
    ['{End}', 'attachments'],
  ])('%s from the Outline tab selects %s and moves focus to it', async (key, id) => {
    const { onSelect } = show();
    tab('Outline').focus();
    await userEvent.keyboard(key);

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(id);
    const target = TABS.find((entry) => entry.id === id) as DockTab;
    expect(document.activeElement).toBe(tab(t(target.label)));
  });

  it('wraps from the last tab to the first and from the first to the last', async () => {
    const last = show({ activeId: 'attachments' });
    tab('Attachments').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(last.onSelect).toHaveBeenCalledExactlyOnceWith('pages');
    cleanup();

    const first = show({ activeId: 'pages' });
    tab('Pages').focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(first.onSelect).toHaveBeenCalledExactlyOnceWith('attachments');
  });

  it('leaves the selection alone for any other key', async () => {
    const { onSelect } = show();
    tab('Outline').focus();
    await userEvent.keyboard('a');
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tab('Outline'));
  });
});

describe('Dock icons', () => {
  const icon = (name: string) => tab(name).querySelector('svg')?.innerHTML ?? '';

  it('draws a tab’s own icon when it has one', () => {
    show({
      tabs: [{ id: 'pages', label: 'panel.pages', icon: () => <svg data-testid="own-icon" /> }],
      activeId: 'pages',
    });
    expect(within(tab('Pages')).getByTestId('own-icon')).toBeTruthy();
  });

  it('draws a tab id the dock does not know the pages icon, and the known ids their own', () => {
    show({
      tabs: [
        { id: 'pages', label: 'panel.pages' },
        { id: 'invented', label: 'panel.attachments' },
        { id: 'outline', label: 'panel.outline' },
      ],
      activeId: 'outline',
    });
    expect(icon('Pages')).not.toBe('');
    expect(icon('Attachments')).toBe(icon('Pages'));
    expect(icon('Outline')).not.toBe(icon('Pages'));
  });

  it('draws the active tab’s icon filled and the others regular', () => {
    show({ activeId: 'pages' });
    const filled = icon('Pages');
    cleanup();
    show({ activeId: 'outline' });
    expect(icon('Pages')).not.toBe('');
    expect(icon('Pages')).not.toBe(filled);
  });
});
