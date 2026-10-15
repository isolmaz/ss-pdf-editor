// @vitest-environment happy-dom
/**
 * The tool rail reads the armed tool from the core store and a press writes it back: which
 * button is pressed follows the store whichever surface armed the tool, and a second press
 * puts the pointer back on select.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreStore, selectTool } from '../features/core/core-store';
import { ToolRail } from './ToolRail';

const t = createTranslator('en');
const initial = coreStore.get();
const button = (key: Parameters<typeof t>[0]) => screen.getByRole('button', { name: t(key) });

beforeEach(() => coreStore.set(initial));
afterEach(cleanup);

describe('ToolRail', () => {
  it('presses the armed tool, from whichever surface armed it', () => {
    render(<ToolRail t={t} canEdit />);
    expect(button('toolbar.select').getAttribute('aria-pressed')).toBe('true');

    act(() => selectTool('ink'));

    expect(button('ann.tool.ink').getAttribute('aria-pressed')).toBe('true');
    expect(button('toolbar.select').getAttribute('aria-pressed')).toBe('false');
  });

  it('arms a tool on a press and puts the pointer back on select on the next', async () => {
    const user = userEvent.setup();
    render(<ToolRail t={t} canEdit />);

    await user.click(button('toolbar.text'));
    expect(coreStore.get().canvasTool).toBe('text');
    expect(button('toolbar.text').getAttribute('aria-pressed')).toBe('true');

    await user.click(button('toolbar.text'));
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('keeps the select tool armed when its own button is pressed again', async () => {
    const user = userEvent.setup();
    render(<ToolRail t={t} canEdit />);
    await user.click(button('toolbar.select'));
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('stands one button for the four markup looks and arms the one used last', async () => {
    const user = userEvent.setup();
    render(<ToolRail t={t} canEdit />);

    await user.click(button('toolbar.markup'));
    expect(coreStore.get().canvasTool).toBe('highlight');

    act(() => selectTool('underline'));
    expect(button('toolbar.markup').getAttribute('aria-pressed')).toBe('true');
    await user.click(button('toolbar.markup'));
    expect(coreStore.get().canvasTool).toBe('select');

    await user.click(button('toolbar.markup'));
    expect(coreStore.get().canvasTool).toBe('underline');
  });

  it('opens the comments dock with the note tool', async () => {
    const user = userEvent.setup();
    coreStore.set({ rightDock: false });
    render(<ToolRail t={t} canEdit />);

    await user.click(button('toolbar.comment'));

    expect(coreStore.get()).toMatchObject({ canvasTool: 'note', rightDock: true, rightTab: 'comments' });
  });

  it('leaves measurement and redaction off the rail in the simple mode, and keeps everything else', () => {
    const names = () => screen.getAllByRole('button').map((item) => item.getAttribute('aria-label'));
    act(() => coreStore.set({ mode: 'advanced' }));
    const { unmount } = render(<ToolRail t={t} canEdit />);
    const everything = names();
    expect(everything).toContain(t('toolbar.measure'));
    expect(everything).toContain(t('toolbar.redact'));
    unmount();

    act(() => coreStore.set({ mode: 'simple' }));
    render(<ToolRail t={t} canEdit />);
    expect(names()).toEqual(
      everything.filter((name) => name !== t('toolbar.measure') && name !== t('toolbar.redact')),
    );
  });

  it('names each tool`s letter in its tooltip and to assistive technology, and takes it from the key table', async () => {
    const user = userEvent.setup();
    render(<ToolRail t={t} canEdit />);

    await user.hover(button('ann.tool.ink'));

    expect((await screen.findByRole('tooltip')).textContent).toBe(`${t('ann.tool.ink')} (D)`);
    const keys = screen
      .getAllByRole('button')
      .map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-keyshortcuts')]);
    expect(keys).toEqual([
      [t('toolbar.select'), 'V'],
      [t('toolbar.hand'), 'H'],
      [t('toolbar.text'), 'E'],
      [t('toolbar.freetext'), 'T'],
      [t('toolbar.markup'), 'U'],
      [t('ann.tool.ink'), 'D'],
      [t('toolbar.shape'), 'R'],
      [t('toolbar.comment'), 'N'],
      [t('link.tool'), 'K'],
    ]);
  });

  it('disables the tools that write to the document while it cannot be edited', () => {
    render(<ToolRail t={t} canEdit={false} />);
    expect(button('toolbar.text')).toHaveProperty('disabled', true);
    expect(button('toolbar.select')).toHaveProperty('disabled', false);
    expect(button('toolbar.hand')).toHaveProperty('disabled', false);
  });
});
