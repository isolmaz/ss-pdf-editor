// @vitest-environment happy-dom
/**
 * The ruler's overlay: the real layer over a stand-in viewer with one 600×800 page. The user
 * clicks a chain on the page and finishes it; what lands is a measurement in the session, the
 * live reading in the store, and Escape stops the tool.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { scaleForRatio } from 'pdf-core/ops/measure';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingOverlays } from '../../operations';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import { MeasureOverlay, type MeasureOverlayProps } from './MeasureOverlay';
import { armMeasure, initialMeasureState, measureStore } from './measure-store';

const t = createTranslator('en');

const viewer = {
  document: { pageCount: 1 },
  containerRect: () => ({ x: 0, y: 0, width: 600, height: 800 }),
  pageRect: (pageIndex: number) => (pageIndex === 0 ? { x: 0, y: 0, width: 600, height: 800 } : null),
  pageGeometry: (pageIndex: number) =>
    pageIndex === 0 ? { rotation: 0, x: 0, y: 0, width: 600, height: 800 } : null,
  pointToPage: (clientX: number, clientY: number) => ({ pageIndex: 0, x: clientX, y: clientY }),
} as unknown as ViewerApi;

let session: SessionStore;

beforeEach(() => {
  coreStore.set(initialCoreState());
  measureStore.set(initialMeasureState());
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'h', pageCount: 1 });
});
afterEach(cleanup);

function overlay(props: Partial<MeasureOverlayProps> = {}) {
  return (
    <MeasureOverlay
      t={t}
      session={session}
      viewer={viewer}
      marks={[]}
      canEdit
      color="#ff0000"
      opacity={0.5}
      thickness={3}
      author="Ada"
      {...props}
    />
  );
}

const ruler = () => screen.findByRole('application', { name: 'Measure' }, { timeout: 30_000 });

describe('MeasureOverlay', () => {
  it('draws nothing while no ruler is armed and the session holds no measurements', () => {
    const { container } = render(overlay());
    expect(container.innerHTML).toBe('');
  });

  it('takes the pointer once the ruler is armed, and a clicked chain finished with Enter becomes a measurement', async () => {
    const user = userEvent.setup();
    armMeasure('perimeter');
    render(overlay());
    const surface = await ruler();

    fireEvent.pointerDown(surface, { button: 0, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(surface, { clientX: 110, clientY: 20 });
    fireEvent.pointerDown(surface, { button: 0, clientX: 110, clientY: 20 });
    fireEvent.pointerMove(surface, { clientX: 210, clientY: 20 });
    await waitFor(() => expect(measureStore.get().reading).toMatchObject({ points: 3 }));

    await user.keyboard('{Enter}');

    const [mark, ...rest] = pendingOverlays(session.active).measures;
    expect(rest).toEqual([]);
    expect(mark).toMatchObject({
      pageIndex: 0,
      mode: 'perimeter',
      points: [
        { x: 10, y: 20 },
        { x: 110, y: 20 },
      ],
      scale: scaleForRatio(100),
      color: '#ff0000',
      opacity: 0.5,
      thickness: 3,
      author: 'Ada',
    });
    expect(session.active?.dirty).toBe(true);
    expect(measureStore.get().reading).toBeNull();
  }, 40_000);

  it('stops the tool on Escape with no chain under way', async () => {
    const user = userEvent.setup();
    armMeasure('area');
    render(overlay());
    await ruler();

    await user.keyboard('{Escape}');
    expect(coreStore.get().canvasTool).toBe('select');
  }, 40_000);

  it('draws the grid while a ruler is armed with the grid on, and not once the ruler is put away', async () => {
    armMeasure('distance');
    measureStore.set({ grid: true, spacing: 100 });
    const { container } = render(overlay());
    await ruler();
    expect(container.querySelector('path[stroke="currentColor"]')).not.toBeNull();

    act(() => selectTool('select'));
    expect(container.querySelector('path[stroke="currentColor"]')).toBeNull();
  }, 40_000);

  const mark = {
    id: 'm1',
    pageIndex: 0,
    mode: 'distance',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    scale: scaleForRatio(100),
    color: '#ff0000',
    opacity: 1,
    thickness: 2,
    author: '',
    contents: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('keeps measurements drawn with no ruler armed, but takes no pointer', async () => {
    render(overlay({ marks: [mark] }));
    await screen.findByRole('button', { name: 'Distance' }, { timeout: 30_000 });
    expect(screen.queryByRole('application', { name: 'Measure' })).toBeNull();
  }, 40_000);

  it('draws the measurements but never lets the ruler take the pointer while the document cannot be edited', async () => {
    armMeasure('distance');
    render(overlay({ marks: [mark], canEdit: false }));
    await screen.findByRole('button', { name: 'Distance' }, { timeout: 30_000 });
    expect(screen.queryByRole('application', { name: 'Measure' })).toBeNull();
  }, 40_000);
});
