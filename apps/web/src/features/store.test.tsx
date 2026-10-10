// @vitest-environment happy-dom
/**
 * The store helper's contract: what a write notifies, what a no-op write does not, and — the
 * property the whole `features/` split rests on — that a component subscribed with a selector
 * re-renders when its selected value changes and not when something else in the store does.
 * Components count their own renders.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, type Equality, type ReadableStore, shallowEqual, useStore } from './store';

afterEach(cleanup);

interface Counter {
  readonly count: number;
  readonly label: string;
  readonly tags: readonly string[];
}

const fresh = (): Counter => ({ count: 0, label: 'a', tags: [] });

describe('createStore', () => {
  it('holds the initial state and merges a partial change into a new state object', () => {
    const initial = fresh();
    const store = createStore(initial);
    expect(store.get()).toBe(initial);

    store.set({ count: 1 });
    expect(store.get()).toEqual({ count: 1, label: 'a', tags: [] });
    expect(store.get()).not.toBe(initial);
    expect(initial.count).toBe(0);
  });

  it('computes an updater change from the state it is applied to', () => {
    const store = createStore(fresh());
    store.set((state) => ({ count: state.count + 1 }));
    store.set((state) => ({ count: state.count + 1 }));
    expect(store.get().count).toBe(2);
  });

  it('notifies every subscriber once per change, after the state is replaced', () => {
    const store = createStore(fresh());
    const seen: number[] = [];
    const other = vi.fn();
    store.subscribe(() => seen.push(store.get().count));
    store.subscribe(other);

    store.set({ count: 5 });
    store.set({ count: 6 });

    expect(seen).toEqual([5, 6]);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a change that leaves every named key as it is', () => {
    const store = createStore(fresh());
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.get();

    store.set({ count: 0 });
    store.set({});
    store.set((state) => ({ label: state.label }));

    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(before);
  });

  it('treats a new object with equal contents as a change, and NaN as equal to itself', () => {
    const store = createStore({ items: [] as readonly string[], ratio: Number.NaN });
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ ratio: Number.NaN });
    expect(listener).not.toHaveBeenCalled();

    store.set({ items: [] });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a subscriber after it unsubscribes, and leaves the others', () => {
    const store = createStore(fresh());
    const stopped = vi.fn();
    const kept = vi.fn();
    const unsubscribe = store.subscribe(stopped);
    store.subscribe(kept);

    store.set({ count: 1 });
    unsubscribe();
    store.set({ count: 2 });
    unsubscribe();

    expect(stopped).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledTimes(2);
  });

  it('lets a subscriber unsubscribe itself while it is being notified', () => {
    const store = createStore(fresh());
    const once = vi.fn(() => unsubscribe());
    const after = vi.fn();
    const unsubscribe = store.subscribe(once);
    store.subscribe(after);

    store.set({ count: 1 });
    store.set({ count: 2 });

    expect(once).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('is usable through its detached methods, with no `this`', () => {
    const { get, set, subscribe } = createStore(fresh());
    const listener = vi.fn();
    subscribe(listener);
    set({ label: 'b' });
    expect(get().label).toBe('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('useStore', () => {
  /** A consumer of `store` through `selector`; reports each render in `renders`. */
  function consumer<T>(
    store: ReadableStore<Counter>,
    selector: (state: Counter) => T,
    renders: T[],
    equality?: Equality<T>,
  ) {
    return function Consumer() {
      const value = useStore(store, selector, equality);
      renders.push(value);
      return <output>{JSON.stringify(value)}</output>;
    };
  }

  it('renders the selected value and follows the store when it changes', () => {
    const store = createStore(fresh());
    const renders: number[] = [];
    const Consumer = consumer(store, (state) => state.count, renders);
    render(<Consumer />);
    expect(screen.getByRole('status').textContent).toBe('0');

    act(() => store.set({ count: 3 }));

    expect(screen.getByRole('status').textContent).toBe('3');
    expect(renders).toEqual([0, 3]);
  });

  it('does not re-render when a key the selector does not read changes', () => {
    const store = createStore(fresh());
    const renders: number[] = [];
    const Consumer = consumer(store, (state) => state.count, renders);
    render(<Consumer />);

    act(() => store.set({ label: 'b' }));
    act(() => store.set({ tags: ['x'] }));

    expect(renders).toEqual([0]);

    act(() => store.set({ count: 1 }));
    act(() => store.set({ label: 'c' }));
    expect(renders).toEqual([0, 1]);
  });

  it('re-renders only the components whose selected value changed', () => {
    const store = createStore(fresh());
    const counts: number[] = [];
    const labels: string[] = [];
    const Count = consumer(store, (state) => state.count, counts);
    const Label = consumer(store, (state) => state.label, labels);
    render(
      <>
        <Count />
        <Label />
      </>,
    );

    act(() => store.set({ label: 'b' }));
    act(() => store.set({ count: 1 }));

    expect(counts).toEqual([0, 1]);
    expect(labels).toEqual(['a', 'b']);
  });

  it('keeps the same value while the selected part is equal, so a re-render is not forced', () => {
    const store = createStore(fresh());
    const renders: { readonly count: number; readonly label: string }[] = [];
    const Consumer = consumer(
      store,
      (state) => ({ count: state.count, label: state.label }),
      renders,
      shallowEqual,
    );
    render(<Consumer />);

    act(() => store.set({ tags: ['x'] }));
    expect(renders).toHaveLength(1);

    act(() => store.set({ count: 1 }));
    expect(renders).toHaveLength(2);
    expect(renders[1]).toEqual({ count: 1, label: 'a' });
  });

  it('re-renders on every store change for a fresh-object selector given no equality function', () => {
    const store = createStore(fresh());
    const renders: { readonly count: number }[] = [];
    const Consumer = consumer(store, (state) => ({ count: state.count }), renders);
    render(<Consumer />);

    act(() => store.set({ label: 'b' }));

    expect(renders).toHaveLength(2);
    expect(renders[1]).toEqual(renders[0]);
    expect(renders[1]).not.toBe(renders[0]);
  });

  it('recomputes when the selector changes though the store did not', () => {
    const store = createStore({ items: ['zero', 'one', 'two'] });
    function Item({ index }: { readonly index: number }) {
      const item = useStore(store, (state) => state.items[index]);
      return <output>{item}</output>;
    }
    const { rerender } = render(<Item index={0} />);
    expect(screen.getByRole('status').textContent).toBe('zero');

    rerender(<Item index={2} />);

    expect(screen.getByRole('status').textContent).toBe('two');
  });

  it('stops listening when the component unmounts', () => {
    const store = createStore(fresh());
    const renders: number[] = [];
    const Consumer = consumer(store, (state) => state.count, renders);
    const { unmount } = render(<Consumer />);
    unmount();

    act(() => store.set({ count: 1 }));

    expect(renders).toEqual([0]);
  });

  it('renders on the server from the current state', () => {
    const store = createStore({ ...fresh(), count: 7 });
    const Consumer = consumer(store, (state) => state.count, []);
    expect(renderToStaticMarkup(<Consumer />)).toBe('<output>7</output>');
  });
});

describe('shallowEqual', () => {
  it('is true for the same value, equal primitives and NaN', () => {
    const object = { a: 1 };
    expect(shallowEqual(object, object)).toBe(true);
    expect(shallowEqual(3, 3)).toBe(true);
    expect(shallowEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(shallowEqual(null, null)).toBe(true);
  });

  it('is true for objects and arrays whose parts are the same values', () => {
    const part = { deep: true };
    expect(shallowEqual({ a: 1, b: part }, { a: 1, b: part })).toBe(true);
    expect(shallowEqual([part, 2], [part, 2])).toBe(true);
    expect(shallowEqual({}, {})).toBe(true);
  });

  it('is false for different primitives, null against an object, and an object against a primitive', () => {
    expect(shallowEqual(1, 2)).toBe(false);
    expect(shallowEqual<unknown>(null, {})).toBe(false);
    expect(shallowEqual<unknown>({}, null)).toBe(false);
    expect(shallowEqual<unknown>({}, 'x')).toBe(false);
    expect(shallowEqual<unknown>('x', {})).toBe(false);
  });

  it('is false when a part differs, a key is missing, the length differs or an array meets an object', () => {
    expect(shallowEqual({ a: { x: 1 } }, { a: { x: 1 } })).toBe(false);
    expect(shallowEqual<Record<string, number>>({ a: 1 }, { b: 1 })).toBe(false);
    expect(shallowEqual<Record<string, number>>({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual([1, 2], [1])).toBe(false);
    expect(shallowEqual<unknown>([1], { 0: 1 })).toBe(false);
  });
});
