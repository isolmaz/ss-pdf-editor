// @vitest-environment happy-dom
/**
 * The engine-handle registry: a replaced handle is destroyed only once the viewer has let it go
 * (in either order), a handle still in use is never destroyed, and a component that reads a
 * tab's handle renders again when it is swapped.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreStore } from './core-store';
import {
  adoptHandle,
  dropHandle,
  handleFor,
  handleInUse,
  handleReleased,
  replaceHandle,
  useDocumentHandle,
} from './handles';

const made: string[] = [];
function fakeHandle(name: string, destroy: () => Promise<void> = () => Promise.resolve()) {
  return Object.assign({ name, destroy: vi.fn(destroy) }) as unknown as PdfDocumentHandle & {
    readonly destroy: ReturnType<typeof vi.fn>;
  };
}
function tab(id: string): string {
  made.push(id);
  return id;
}
afterEach(() => {
  cleanup();
  for (const id of made.splice(0)) dropHandle(id);
});

describe('the registry', () => {
  it('registers a tab’s handle, finds it, and hands it back when dropped', () => {
    const id = tab('registry');
    const handle = fakeHandle('a');
    expect(handleFor(id)).toBeUndefined();
    adoptHandle(id, handle);
    expect(handleFor(id)).toBe(handle);
    expect(dropHandle(id)).toBe(handle);
    expect(handleFor(id)).toBeUndefined();
    expect(dropHandle(id)).toBeUndefined();
    expect(handle.destroy).not.toHaveBeenCalled();
  });

  it('swaps a handle and says so, but keeps the old one alive until the viewer releases it', () => {
    const id = tab('swap');
    const [old, next] = [fakeHandle('old'), fakeHandle('next')];
    const failed = vi.fn();
    adoptHandle(id, old);
    const before = coreStore.get().handleVersion;

    replaceHandle(id, next, failed);

    expect(handleFor(id)).toBe(next);
    expect(coreStore.get().handleVersion).toBe(before + 1);
    expect(old.destroy).not.toHaveBeenCalled();

    handleReleased(old, failed);
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    handleReleased(old, failed);
    expect(old.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys a replaced handle at once when the viewer had already released it', () => {
    const id = tab('released-first');
    const [old, next] = [fakeHandle('old'), fakeHandle('next')];
    adoptHandle(id, old);
    handleReleased(old, vi.fn());
    expect(old.destroy).not.toHaveBeenCalled();

    replaceHandle(id, next, vi.fn());

    expect(old.destroy).toHaveBeenCalledTimes(1);
  });

  it('does not destroy a handle the viewer mounted again, nor one replaced by itself', () => {
    const id = tab('in-use');
    const [old, next] = [fakeHandle('old'), fakeHandle('next')];
    adoptHandle(id, old);
    handleReleased(old, vi.fn());
    handleInUse(old);

    replaceHandle(id, next, vi.fn());
    expect(old.destroy).not.toHaveBeenCalled();

    replaceHandle(id, next, vi.fn());
    handleReleased(next, vi.fn());
    expect(next.destroy).not.toHaveBeenCalled();
  });

  it('reports a handle that will not shut down', async () => {
    const id = tab('failure');
    const old = fakeHandle('old', () => Promise.reject(new Error('worker gone')));
    const failed = vi.fn();
    adoptHandle(id, old);
    replaceHandle(id, fakeHandle('next'), failed);

    handleReleased(old, failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
  });
});

describe('useDocumentHandle', () => {
  function Reader({ tabId }: { readonly tabId: string | null }) {
    const handle = useDocumentHandle(tabId) as unknown as { readonly name: string } | null;
    return <output>{handle === null ? 'none' : handle.name}</output>;
  }

  it('reads the tab’s handle and renders again when it is swapped', () => {
    const id = tab('reader');
    adoptHandle(id, fakeHandle('first'));
    render(<Reader tabId={id} />);
    expect(screen.getByRole('status').textContent).toBe('first');

    act(() => replaceHandle(id, fakeHandle('second'), vi.fn()));

    expect(screen.getByRole('status').textContent).toBe('second');
  });

  it('is null with no tab and for a tab with no handle yet', () => {
    const { rerender } = render(<Reader tabId={null} />);
    expect(screen.getByRole('status').textContent).toBe('none');
    rerender(<Reader tabId={tab('unknown')} />);
    expect(screen.getByRole('status').textContent).toBe('none');
  });
});
