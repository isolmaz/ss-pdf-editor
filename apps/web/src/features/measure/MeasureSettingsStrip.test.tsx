// @vitest-environment happy-dom
/**
 * The tool strip's measure settings: the real settings strip, wired to the measure store. What
 * the user sees follows the store; what they do lands in the store, the core store or the
 * shell's annotation-style callbacks.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { MeasureSettingsStrip } from './MeasureSettingsStrip';
import { armMeasure, initialMeasureState, measureStore, setMeasureReading } from './measure-store';

const t = createTranslator('en');
const style = {
  onColor: vi.fn(),
  onOpacity: vi.fn(),
  onThickness: vi.fn(),
  onAuthor: vi.fn(),
};

// The settings strip is a dynamic chunk: load it once up front so no test races the first import.
beforeAll(async () => {
  await import('pdf-ui');
}, 120_000);
beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  measureStore.set(initialMeasureState());
  armMeasure('distance');
});
afterEach(cleanup);

async function renderStrip() {
  render(<MeasureSettingsStrip t={t} color="#ff0000" opacity={0.5} thickness={3} author="Ada" {...style} />);
  await screen.findByRole('button', { name: 'Distance' });
}

describe('MeasureSettingsStrip', () => {
  it('shows the armed measurement as pressed and the scale hint until the ruler reads something', async () => {
    await renderStrip();
    expect(screen.getByRole('button', { name: 'Distance' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Area' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('status', { name: 'Tool settings' }).textContent).toBe('e.g. 1:100 · 1 cm = 5 m');

    act(() => setMeasureReading({ primary: '3.5 m', secondary: '12 m', angle: '45°', points: 2 }));
    expect(screen.getByRole('status', { name: 'Tool settings' }).textContent).toBe('3.5 m · 12 m · 45°');
  });

  it('arms another measurement, and stops when the armed one is clicked again or Stop is pressed', async () => {
    const user = userEvent.setup();
    await renderStrip();

    await user.click(screen.getByRole('button', { name: 'Area' }));
    expect(measureStore.get().subMode).toBe('area');
    expect(coreStore.get().canvasTool).toBe('measure');

    await user.click(screen.getByRole('button', { name: 'Area' }));
    expect(coreStore.get().canvasTool).toBe('select');

    armMeasure('perimeter');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('writes the scale, unit, grid and snapping the user changes into the store', async () => {
    const user = userEvent.setup();
    await renderStrip();

    const scale = screen.getByRole('textbox', { name: 'Scale' });
    await user.clear(scale);
    await user.type(scale, '1:50');
    expect(measureStore.get().scale.ratio).toBe(50);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'ft');
    expect(measureStore.get().scale).toMatchObject({ ratio: 50, unit: 'ft' });

    await user.click(screen.getByRole('checkbox', { name: 'Grid' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Spacing' }), '25');
    await user.click(screen.getByRole('checkbox', { name: 'Snap to grid' }));
    await user.click(screen.getByRole('checkbox', { name: 'Snap to endpoints' }));
    expect(measureStore.get()).toMatchObject({
      grid: true,
      spacing: 25,
      snapGrid: true,
      snapPoints: true,
    });
  });

  it('hands the shared annotation style back to the shell, not to the measure store', async () => {
    const user = userEvent.setup();
    await renderStrip();

    fireEvent.change(screen.getByLabelText('Color'), { target: { value: '#00ff00' } });
    fireEvent.change(screen.getByLabelText('Opacity'), { target: { value: '0.75' } });
    fireEvent.change(screen.getByLabelText('Thickness'), { target: { value: '5' } });
    await user.type(screen.getByLabelText('Author'), 'B');

    expect(style.onColor).toHaveBeenCalledWith('#00ff00');
    expect(style.onOpacity).toHaveBeenCalledWith(0.75);
    expect(style.onThickness).toHaveBeenCalledWith(5);
    expect(style.onAuthor).toHaveBeenCalledWith('AdaB');
  });
});
