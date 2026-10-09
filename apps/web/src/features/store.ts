/**
 * The one store helper every `features/<name>/` module builds its state on.
 *
 * A feature's state lives in a module store, not in one component's `useState`, so a change does
 * not re-render the whole shell: a component subscribes to the slice it reads, and a change
 * re-renders the components whose selected value changed, and nothing else. The pattern is the repository's own (`reading-order-store.ts` in `pdf-ui`,
 * `SessionStore` in `pdf-model`): plain observable TypeScript plus `useSyncExternalStore`, no
 * library.
 *
 * A store is a plain object. Handlers outside React read it with `get()` **at call time** —
 * so no `fooRef.current = foo` mirror is needed to dodge a stale closure — and write it with
 * `set()`. A component reads it with `useStore(store, selector)`.
 */

import { useRef, useSyncExternalStore } from 'react';

/** Compares two selected values; `true` means "unchanged, do not re-render". */
export type Equality<T> = (a: T, b: T) => boolean;

/** The read half of a store: what `useStore` needs. */
export interface ReadableStore<S> {
  /** The current state. Always the same object until a `set` changes something. */
  get(): S;
  /**
   * Call `listener` after every change; returns the function that stops it. Pass a distinct
   * function per subscription: the same function subscribed twice is one subscription.
   */
  subscribe(listener: () => void): () => void;
}

export interface Store<S extends object> extends ReadableStore<S> {
  /**
   * Merge a change into the state: a partial state, or a function from the current state to
   * one (use it whenever the change depends on what is there, so it cannot go stale).
   *
   * A change that leaves every key it names as it is (`Object.is`) is not a change: no new
   * state object is made and no subscriber is called.
   */
  set(change: Partial<S> | ((state: S) => Partial<S>)): void;
}

/** A store holding `initial`. State is replaced, never mutated: `get()` identity is the version. */
export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(change) {
      const patch = typeof change === 'function' ? change(state) : change;
      const keys = Object.keys(patch) as (keyof S)[];
      if (keys.every((key) => Object.is(state[key], patch[key]))) return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** What one `useStore` call last handed React, and what it was derived from. */
interface Selection<S, T> {
  readonly state: S;
  readonly selector: (state: S) => T;
  readonly value: T;
}

/**
 * The part of the store a component reads, and only that part: the component re-renders when
 * the selected value changes (`Object.is`, or `equality` when given), not when the store does.
 *
 * **A selector must return a stable value for an unchanged state.** Picking a field
 * (`(s) => s.busy`) or a derived primitive always does. A selector that builds a fresh object
 * or array on every call (`(s) => ({ a: s.a, b: s.b })`, `(s) => s.list.filter(...)`) is a new
 * value every time, so without an `equality` function it re-renders on every store change:
 * pass `shallowEqual`, or select the fields with separate `useStore` calls.
 */
export function useStore<S, T>(
  store: ReadableStore<S>,
  selector: (state: S) => T,
  equality: Equality<T> = Object.is,
): T {
  const last = useRef<Selection<S, T> | null>(null);
  const getSnapshot = (): T => {
    const state = store.get();
    const previous = last.current;
    if (previous !== null && previous.state === state && previous.selector === selector) {
      return previous.value;
    }
    const selected = selector(state);
    // The value React already holds stays the value while it is "equal": its identity is what
    // a component's memos and effects depend on.
    const value = previous !== null && equality(previous.value, selected) ? previous.value : selected;
    last.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * Equal when both have the same own keys with `Object.is`-equal values (objects) or the same
 * length and `Object.is`-equal items (arrays): the `equality` for a selector that returns a
 * fresh object or array of stable parts.
 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    Array.isArray(a) === Array.isArray(b) &&
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  );
}
