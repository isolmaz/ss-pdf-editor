// @vitest-environment happy-dom
/**
 * The redaction feature's markup as the user meets it: the layer that marks areas only while the
 * redact tool is armed and marking is allowed, and the dock listing the drawn marks with the
 * tool's own controls.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionStore } from 'pdf-model';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingOverlays } from '../../operations';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { existingTarget, redactionMark, redactionTarget, t } from './marks-fixtures';
import { initialMarksState, marksStore } from './marks-store';
import { RedactionDock, RedactionMarkLayer } from './RedactionSurfaces';

const viewer = { pointToPage: vi.fn<ViewerApi['pointToPage']>(() => null) } as unknown as ViewerApi;

beforeEach(() => {
  coreStore.set(initialCoreState());
  marksStore.set(initialMarksState());
});
afterEach(cleanup);

describe('RedactionMarkLayer', () => {
  function mount(enabled = true) {
    const session = new SessionStore();
    session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'h', pageCount: 1 });
    const view = render(<RedactionMarkLayer t={t} viewer={viewer} session={session} enabled={enabled} />);
    return { session, view };
  }

  it('shows nothing until the redact tool is armed', () => {
    const { view } = mount();
    expect(view.container.firstChild).toBeNull();
    act(() => selectTool('redact'));
    expect(view.container.firstChild).not.toBeNull();
  });

  it('marks the dragged area through the page mapping of the viewer and returns to the select tool', () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    vi.mocked(viewer.pointToPage).mockImplementation((x, y) => ({ pageIndex: 0, x, y }));
    selectTool('redact');
    const { session } = mount();
    const layer = screen.getByRole('application', { name: t('redact.mode.box') });
    fireEvent.pointerDown(layer, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 50, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 50, clientY: 30, pointerId: 1 });
    const marks = pendingOverlays(session.active).redactions;
    expect(marks).toHaveLength(1);
    expect(marks[0]?.mark).toEqual({ pageIndex: 0, space: 'app-v1', rect: [10, 10, 50, 30] });
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('shows nothing on a document that cannot be marked, even with the tool armed', () => {
    selectTool('redact');
    const { view } = mount(false);
    expect(view.container.firstChild).toBeNull();
  });
});

describe('RedactionDock', () => {
  function mount(over: { marks?: ReturnType<typeof redactionMark>[]; canEdit?: boolean } = {}) {
    const removeTargets = vi.fn(() => true);
    const onApply = vi.fn();
    render(
      <RedactionDock
        t={t}
        marks={over.marks ?? [redactionMark('r1', 0), redactionMark('r2', 2)]}
        canEdit={over.canEdit ?? true}
        removeTargets={removeTargets}
        onApply={onApply}
      />,
    );
    return { removeTargets, onApply };
  }

  it('lists each drawn mark with its page and removes one through the one removal intent', async () => {
    const { removeTargets } = mount();
    expect(screen.getByText(t('redact.markCount', { count: 2 }))).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', {
        name: `${t('redact.removeMark')}: ${t('dialog.redactMark.page', { page: 3 })}`,
      }),
    );
    expect(removeTargets).toHaveBeenCalledWith(['redaction:r2']);
  });

  it('clears the redaction marks and only those', async () => {
    marksStore.set({ targets: [redactionTarget('r1'), existingTarget('e1'), redactionTarget('r2')] });
    const { removeTargets } = mount();
    await userEvent.click(screen.getByRole('button', { name: t('redact.clearMarks') }));
    expect(removeTargets).toHaveBeenCalledWith(['redaction:r1', 'redaction:r2']);
  });

  it('arms and disarms the redact tool from its toggle', async () => {
    mount();
    const toggle = screen.getByRole('button', { name: t('redact.tool.start') });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    expect(coreStore.get().canvasTool).toBe('redact');
    const armed = screen.getByRole('button', { name: t('redact.tool.stop') });
    expect(armed.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(armed);
    expect(coreStore.get().canvasTool).toBe('select');
  });

  it('opens the redaction dialog from its button', async () => {
    const { onApply } = mount();
    await userEvent.click(screen.getByRole('button', { name: t('redact.title') }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('offers no tool and no application on a document that cannot be edited, or with nothing marked', () => {
    mount({ marks: [], canEdit: false });
    expect(screen.getByRole('button', { name: t('redact.tool.start') }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: t('redact.title') }).hasAttribute('disabled')).toBe(true);
    cleanup();
    mount({ marks: [] });
    expect(screen.getByRole('button', { name: t('redact.tool.start') }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: t('redact.title') }).hasAttribute('disabled')).toBe(true);
  });
});
