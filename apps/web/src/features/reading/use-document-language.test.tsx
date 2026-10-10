// @vitest-environment happy-dom
/**
 * The document language follows the document on screen: it is cleared when the viewer changes,
 * read from the engine's metadata, and never taken from a read that arrived after the viewer
 * moved on.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readingStore, setDocumentLanguage } from './reading-store';
import { type LanguageSource, useDocumentLanguage } from './use-document-language';

function Follower({ viewer }: { readonly viewer: LanguageSource | null }) {
  useDocumentLanguage(viewer);
  return null;
}

/** A viewer whose metadata read the test settles. */
function viewerWith() {
  let resolve!: (info: unknown) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<{ info: unknown }>((ok, fail) => {
    resolve = (info) => ok({ info });
    reject = fail;
  });
  const viewer: LanguageSource = { document: { raw: { getMetadata: () => pending } } };
  return { viewer, resolve, reject };
}

beforeEach(() => setDocumentLanguage(null));
afterEach(cleanup);

describe('useDocumentLanguage', () => {
  it('reads the primary language the document declares', async () => {
    const { viewer, resolve } = viewerWith();
    render(<Follower viewer={viewer} />);
    expect(readingStore.get().documentLanguage).toBeNull();

    await act(async () => resolve({ Language: 'de-DE' }));

    expect(readingStore.get().documentLanguage).toBe('de');
  });

  it('declares none for a document without a language, or whose metadata cannot be read', async () => {
    const plain = viewerWith();
    const { rerender } = render(<Follower viewer={plain.viewer} />);
    await act(async () => plain.resolve({}));
    expect(readingStore.get().documentLanguage).toBeNull();

    const broken = viewerWith();
    setDocumentLanguage('de');
    rerender(<Follower viewer={broken.viewer} />);
    expect(readingStore.get().documentLanguage).toBeNull();
    await act(async () => broken.reject(new Error('worker gone')));
    expect(readingStore.get().documentLanguage).toBeNull();
  });

  it('clears the language when the viewer goes away', async () => {
    const { viewer, resolve } = viewerWith();
    const { rerender } = render(<Follower viewer={viewer} />);
    await act(async () => resolve({ Language: 'fr' }));
    expect(readingStore.get().documentLanguage).toBe('fr');

    rerender(<Follower viewer={null} />);

    expect(readingStore.get().documentLanguage).toBeNull();
  });

  it('drops a read that lands after the viewer changed or the shell unmounted', async () => {
    const first = viewerWith();
    const second = viewerWith();
    const { rerender, unmount } = render(<Follower viewer={first.viewer} />);
    rerender(<Follower viewer={second.viewer} />);

    await act(async () => first.resolve({ Language: 'de' }));
    expect(readingStore.get().documentLanguage).toBeNull();

    await act(async () => second.resolve({ Language: 'fr' }));
    expect(readingStore.get().documentLanguage).toBe('fr');

    const third = viewerWith();
    rerender(<Follower viewer={third.viewer} />);
    unmount();
    await act(async () => third.resolve({ Language: 'es' }));
    expect(readingStore.get().documentLanguage).toBeNull();
  });
});
