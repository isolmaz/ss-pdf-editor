// @vitest-environment happy-dom
/**
 * The property strip of the armed tool: it shows the sentence for what the pointer does now and
 * only the controls that tool really carries, reports every edit to the shell with the value
 * clamped to the writer's bounds, and offers the selection actions the shell wired.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CanvasToolId, ToolProperties, type ToolPropertiesProps } from './ToolProperties';

afterEach(cleanup);

const t = createTranslator('en');

function show(tool: CanvasToolId, overrides: Partial<ToolPropertiesProps> = {}) {
  const handlers = {
    onColor: vi.fn(),
    onOpacity: vi.fn(),
    onThickness: vi.fn(),
    onAuthor: vi.fn(),
    onShape: vi.fn(),
  };
  render(
    <ToolProperties
      t={t}
      tool={tool}
      color="#ff0000"
      opacity={0.8}
      thickness={3}
      author="Ann"
      shape="square"
      selectedCount={0}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

/** The input a label names (the opacity label also wraps its readout, so the label text alone is ambiguous). */
const inputs = (name: string) =>
  [...document.querySelectorAll<HTMLInputElement>('input,select')].filter(
    (e) => e.getAttribute('aria-label') === name,
  );
const control = (name: string) => inputs(name)[0] as HTMLInputElement;
const has = (name: string) => inputs(name).length > 0;

describe('the sentence for what the pointer does now', () => {
  it.each<[CanvasToolId, string]>([
    ['select', 'Click a mark, or drag to select several.'],
    ['hand', 'Drag the page to scroll.'],
    ['text', 'Click the paragraph you want to edit.'],
    ['freetext', 'Click where the text goes; click outside or press Ctrl+Enter when done.'],
    ['highlight', 'Select text and release, or paint freehand.'],
    ['underline', 'Select text and release.'],
    ['strikeout', 'Select text and release.'],
    ['squiggly', 'Select text and release.'],
    ['ink', 'Hold and draw.'],
    ['shapes', 'Drag to draw the shape.'],
    ['note', 'Click where the note goes.'],
    ['link', 'Drag the area the link covers.'],
    ['redact', 'Drag over the area to remove; Apply removes it permanently.'],
    ['stamp', 'Click on the page to place it; press Esc to cancel.'],
  ])('%s: "%s"', (tool, sentence) => {
    show(tool);
    expect(screen.getByText(sentence)).toBeTruthy();
  });

  it('is absent for the measure tool, which keeps its own strip', () => {
    show('measure');
    expect(screen.getByRole('group', { name: 'Tool settings' }).textContent).toBe('');
  });

  it('gives way to the selection readout once marks are selected', () => {
    show('ink', { selectedCount: 2 });
    expect(screen.queryByText('Hold and draw.')).toBeNull();
    expect(screen.getByRole('status', { name: 'Selection' }).textContent).toBe('2 mark(s) selected');
  });

  it('disables every control while the strip is disabled', () => {
    show('ink', { disabled: true });
    expect(screen.getByRole('group', { name: 'Tool settings' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the four text-markup looks', () => {
  it('shows one button per look, presses the armed one and switches look on a click', async () => {
    const onTool = vi.fn();
    show('underline', { onTool });
    const group = screen.getByRole('group', { name: 'Style' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Highlight', 'false'],
      ['Underline', 'true'],
      ['Strikeout', 'false'],
      ['Squiggly', 'false'],
    ]);
    await userEvent.setup().click(within(group).getByRole('button', { name: 'Squiggly' }));
    expect(onTool).toHaveBeenCalledExactlyOnceWith('squiggly');
  });

  it('is not offered when the shell cannot switch looks', () => {
    show('highlight');
    expect(screen.queryByRole('group', { name: 'Style' })).toBeNull();
  });

  it('is not offered for a tool that is not one of the four', () => {
    show('ink', { onTool: vi.fn() });
    expect(screen.queryByRole('group', { name: 'Style' })).toBeNull();
  });
});

describe('typed text', () => {
  it('shows its own colour and size, not the marker style', () => {
    show('freetext', { textColor: '#00ff00', fontSize: 18 });
    expect(inputs('Color')).toHaveLength(1);
    expect(control('Color').value).toBe('#00ff00');
    expect(control('Size').value).toBe('18');
    expect(has('Opacity')).toBe(false);
    expect(has('Thickness')).toBe(false);
    expect(control('Author').value).toBe('Ann');
  });

  it('starts black at 12 pt', () => {
    show('freetext');
    expect(control('Color').value).toBe('#000000');
    expect(control('Size').value).toBe('12');
  });

  it('reports a chosen colour', () => {
    const onTextColor = vi.fn();
    show('freetext', { onTextColor });
    fireEvent.change(control('Color'), { target: { value: '#123456' } });
    expect(onTextColor).toHaveBeenCalledExactlyOnceWith('#123456');
  });

  it.each([
    ['20', 20],
    ['12.6', 13],
    ['3', 6],
    ['500', 72],
  ])("reports a size of %s as %d pt, within the writer's 6–72 pt range", (typed, size) => {
    const onFontSize = vi.fn();
    show('freetext', { onFontSize });
    fireEvent.change(control('Size'), { target: { value: typed } });
    expect(onFontSize).toHaveBeenCalledExactlyOnceWith(size);
  });

  it('keeps the last size while the field is emptied to type a new one', () => {
    const onFontSize = vi.fn();
    show('freetext', { onFontSize, fontSize: 30 });
    fireEvent.change(control('Size'), { target: { value: '' } });
    expect(onFontSize).not.toHaveBeenCalled();
  });
});

describe('redaction', () => {
  it('says how many areas are marked, and applies them on the explicit step', async () => {
    const onApplyRedaction = vi.fn();
    show('redact', { redactionCount: 3, onApplyRedaction });
    expect(screen.getByText('3 area(s) marked')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Apply redaction' }));
    expect(onApplyRedaction).toHaveBeenCalledOnce();
  });

  it('offers nothing to apply while no area is marked', () => {
    show('redact', { onApplyRedaction: vi.fn() });
    expect(screen.getByText('0 area(s) marked')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply redaction' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows only the count when the shell has no apply step', () => {
    show('redact', { redactionCount: 1 });
    expect(screen.getByText('1 area(s) marked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply redaction' })).toBeNull();
  });
});

describe('the properties a tool carries', () => {
  it.each<[CanvasToolId, string[]]>([
    ['select', []],
    ['hand', []],
    ['highlight', ['Color', 'Opacity', 'Thickness']],
    ['underline', ['Color', 'Opacity', 'Thickness', 'Author']],
    ['ink', ['Color', 'Opacity', 'Thickness', 'Author']],
    ['shapes', ['Color', 'Opacity', 'Thickness', 'Author', 'Shape']],
    ['note', ['Color', 'Author']],
    ['redact', []],
    ['measure', []],
    ['link', []],
    ['text', []],
    ['stamp', []],
  ])('%s', (tool, shown) => {
    show(tool);
    expect(['Color', 'Opacity', 'Thickness', 'Author', 'Shape'].filter(has)).toEqual(shown);
  });

  it('reports a chosen colour', () => {
    const { onColor } = show('ink');
    fireEvent.change(control('Color'), { target: { value: '#0000ff' } });
    expect(onColor).toHaveBeenCalledExactlyOnceWith('#0000ff');
  });

  it('reads the opacity as a percentage and reports the slider as a fraction', () => {
    const { onOpacity } = show('ink', { opacity: 0.55 });
    expect(screen.getByText('55%')).toBeTruthy();
    fireEvent.change(control('Opacity'), { target: { value: '0.3' } });
    expect(onOpacity).toHaveBeenCalledExactlyOnceWith(0.3);
    expect(control('Opacity').min).toBe('0.1');
    expect(control('Opacity').max).toBe('1');
  });

  it.each([
    ['7', 7],
    ['2.4', 2],
    ['0', 1],
    ['99', 20],
  ])('reports a thickness of %s as %d pt, within 1–20 pt', (typed, thickness) => {
    const { onThickness } = show('ink');
    expect(control('Thickness').value).toBe('3');
    fireEvent.change(control('Thickness'), { target: { value: typed } });
    expect(onThickness).toHaveBeenCalledExactlyOnceWith(thickness);
  });

  it('keeps the last thickness while the field is emptied to type a new one', () => {
    const { onThickness } = show('ink');
    fireEvent.change(control('Thickness'), { target: { value: '' } });
    expect(onThickness).not.toHaveBeenCalled();
  });

  it('reports each character typed into the author field', async () => {
    const { onAuthor } = show('note');
    await userEvent.setup().type(control('Author'), 'b');
    expect(onAuthor).toHaveBeenCalledExactlyOnceWith('Annb');
  });

  it('offers the three shapes, shows the current one and reports the chosen one', async () => {
    const { onShape } = show('shapes', { shape: 'circle' });
    const select = screen.getByRole('combobox', { name: 'Shape' }) as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Square', 'Circle', 'Line']);
    expect(select.value).toBe('circle');
    await userEvent.setup().selectOptions(select, 'line');
    expect(onShape).toHaveBeenCalledExactlyOnceWith('line');
  });
});

describe('the selection', () => {
  it('is the select tool’s own readout, and says when nothing is selected', () => {
    show('select');
    expect(screen.getByRole('status', { name: 'Selection' }).textContent).toBe('No marks selected');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('follows the selection under any tool', () => {
    show('ink', { selectedCount: 1 });
    expect(screen.getByRole('status', { name: 'Selection' }).textContent).toBe('1 mark(s) selected');
  });

  it('is absent under another tool while nothing is selected', () => {
    show('ink');
    expect(screen.queryByRole('status', { name: 'Selection' })).toBeNull();
  });

  it('offers only the actions the shell wired', () => {
    show('select', { selectedCount: 2 });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('deletes, rotates and clears the selection on a click each', async () => {
    const onDeleteSelection = vi.fn();
    const onRotateSelection = vi.fn();
    const onClearSelection = vi.fn();
    show('select', { selectedCount: 2, onDeleteSelection, onRotateSelection, onClearSelection });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    await user.click(screen.getByRole('button', { name: 'Rotate 90°' }));
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onDeleteSelection).toHaveBeenCalledOnce();
    expect(onRotateSelection).toHaveBeenCalledOnce();
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it('moves the selection 5 pt in the direction of each arrow, y growing downwards', async () => {
    const onMoveSelection = vi.fn();
    show('select', { selectedCount: 2, onMoveSelection });
    const group = screen.getByRole('group', { name: 'Move selection' });
    const user = userEvent.setup();
    for (const name of ['Move up (5 pt)', 'Move down (5 pt)', 'Move left (5 pt)', 'Move right (5 pt)']) {
      await user.click(within(group).getByRole('button', { name }));
    }
    expect(onMoveSelection.mock.calls).toEqual([
      [0, -5],
      [0, 5],
      [-5, 0],
      [5, 0],
    ]);
  });
});
