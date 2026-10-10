// @vitest-environment happy-dom
/**
 * The reading overlays follow the reading store: the pane is on screen exactly while the store
 * says so, its own controls write the store back, and it says which voice it is looking for.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore } from '../core/core-store';
import { ReadingLayers } from './ReadingLayers';
import { openSnapshot, readingStore, setDocumentLanguage, toggleReading } from './reading-store';

const t = createTranslator('en');
const initialReading = readingStore.get();
const initialCore = coreStore.get();

function shell(viewer: ViewerApi | null, pageNumber = 0) {
  return (
    <ReadingLayers
      t={t}
      locale="en"
      viewer={viewer}
      viewerRef={{ current: viewer }}
      pageNumber={pageNumber}
    />
  );
}
const pane = () => screen.queryByRole('region', { name: t('reading.toggle') });

beforeEach(() => {
  readingStore.set(initialReading);
  coreStore.set(initialCore);
});
afterEach(cleanup);

describe('ReadingLayers', () => {
  it('shows the reading pane exactly while the store says reading is on', () => {
    render(shell(null));
    expect(pane()).toBeNull();

    act(() => toggleReading());
    expect(pane()).not.toBeNull();

    act(() => toggleReading());
    expect(pane()).toBeNull();
  });

  it('closes the store’s reading flag from the pane’s own close button and from Escape', async () => {
    const user = userEvent.setup();
    render(shell(null));
    act(() => toggleReading());

    await user.click(screen.getByRole('button', { name: t('reading.toggle') }));
    expect(readingStore.get().reading).toBe(false);
    expect(pane()).toBeNull();

    act(() => toggleReading());
    await user.keyboard('{Escape}');
    expect(readingStore.get().reading).toBe(false);
  });

  it('turns pages through the viewer', async () => {
    const user = userEvent.setup();
    const goToPage = vi.fn();
    render(shell({ goToPage } as unknown as ViewerApi, 2));
    act(() => toggleReading());

    await user.click(screen.getByRole('button', { name: t('panel.goToPage', { page: 4 }) }));
    await user.click(screen.getByRole('button', { name: t('panel.goToPage', { page: 2 }) }));

    expect(goToPage.mock.calls).toEqual([[3], [1]]);
  });

  it('reports a page it cannot read on the notice line', async () => {
    render(shell({ goToPage: vi.fn() } as unknown as ViewerApi));
    act(() => toggleReading());

    await waitFor(() => expect(coreStore.get().notice).toBe(t('error.internal.message')));
  });

  it('looks for a voice in the document’s language, else the interface’s', () => {
    render(shell(null));
    act(() => toggleReading());
    const missing = (language: string) => t('reading.noLocalVoice', { language });

    expect(screen.queryByText(missing('English'))).not.toBeNull();

    act(() => setDocumentLanguage('de'));
    expect(screen.queryByText(missing('German'))).not.toBeNull();
  });

  it('closes the snapshot menu and says why when the page has nothing to capture', async () => {
    render(shell({ goToPage: vi.fn() } as unknown as ViewerApi));
    act(() => openSnapshot());

    await waitFor(() => expect(readingStore.get().snapshotOpen).toBe(false));
    expect(coreStore.get().notice).not.toBeNull();
  });
});
