// @vitest-environment happy-dom
/**
 * The editor chunk's loader: one shared request, the module published to the store once it has
 * arrived, a failed fetch forgotten and reported in the user's language, and a hook that follows it.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import {
  type EditorSurfaces,
  editorStore,
  initialEditorState,
  loadEditor,
  requestEditor,
  useEditorSurfaces,
} from './editor-store';

// The chunk's own surfaces are tested where they are rendered; here only the loading is.
const standIn = vi.hoisted(() => () => ({ EditorSurface: () => null, ToolStrip: () => null }));
vi.mock('./editor', standIn);

const t = createTranslator('en');

beforeEach(() => {
  editorStore.set(initialEditorState());
  coreStore.set(initialCoreState());
});
afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe('loadEditor', () => {
  it('is empty until something asks for the chunk', () => {
    expect(editorStore.get()).toEqual({ surfaces: null, loading: null });
  });

  it('fetches the chunk once, shares the request and publishes the module', async () => {
    const first = loadEditor();
    const second = loadEditor();
    expect(second).toBe(first);
    const surfaces = await first;
    expect(typeof surfaces.EditorSurface).toBe('function');
    expect(typeof surfaces.ToolStrip).toBe('function');
    expect(editorStore.get().surfaces).toBe(surfaces);
    expect(await loadEditor()).toBe(surfaces);
  });

  it('forgets a fetch that failed, so the next call asks again, and rethrows it', async () => {
    vi.resetModules();
    vi.doMock('./editor', () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    // A fresh copy of the module under a mocked chunk: the test exercises the load boundary itself.
    try {
      const fresh = await import('./editor-store');
      await expect(fresh.loadEditor()).rejects.toThrow();
      expect(fresh.editorStore.get()).toEqual({ surfaces: null, loading: null });
      await expect(fresh.loadEditor()).rejects.toThrow();
    } finally {
      vi.doMock('./editor', standIn);
    }
  });
});

describe('requestEditor', () => {
  it('loads the chunk and says nothing when it arrives', async () => {
    requestEditor(t);
    await act(async () => {
      await editorStore.get().loading;
    });
    expect(editorStore.get().surfaces).not.toBeNull();
    expect(coreStore.get().notice).toBeNull();
  });

  it('turns a chunk the browser could not fetch into the offline notice', async () => {
    editorStore.set({
      surfaces: null,
      loading: Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    });
    requestEditor(t);
    await act(async () => {
      await Promise.resolve();
    });
    expect(coreStore.get().notice).toBe(
      `${t('error.asset-offline.message')} ${t('error.asset-offline.hint')}`,
    );
  });
});

describe('useEditorSurfaces', () => {
  function Probe() {
    return <p>{useEditorSurfaces() === null ? 'pending' : 'loaded'}</p>;
  }

  it('follows the store from pending to loaded', () => {
    render(<Probe />);
    expect(screen.getByText('pending')).toBeTruthy();
    act(() => editorStore.set({ surfaces: {} as EditorSurfaces }));
    expect(screen.getByText('loaded')).toBeTruthy();
  });
});
