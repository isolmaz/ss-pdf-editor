/**
 * The store between the tags panel and the reading-order overlay: what each write changes, that
 * a view survives `clear`, and that a focus request is consumed exactly once.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type OverlayPage, readingOrderStore } from './reading-order-store';

const page: OverlayPage = {
  pageIndex: 2,
  width: 595,
  height: 842,
  rotation: 0,
  items: [{ key: 'o17', number: 1, role: 'H1', rect: [10, 10, 100, 40] }],
};

beforeEach(() => {
  readingOrderStore.clear();
  readingOrderStore.setView('report');
  readingOrderStore.takeFocus();
});

describe('readingOrderStore', () => {
  it('starts empty on the report view and keeps what is written', () => {
    const empty = readingOrderStore.snapshot();
    expect(empty).toEqual({ pages: [], selectedKeys: [], view: 'report', focus: null });

    readingOrderStore.setPages([page]);
    readingOrderStore.setSelected(['o17']);
    const state = readingOrderStore.snapshot();
    expect(state.pages).toEqual([page]);
    expect(state.selectedKeys).toEqual(['o17']);
    expect(state).not.toBe(empty);
  });

  it('clears the overlay and the selection but not the view the user chose', () => {
    readingOrderStore.setPages([page]);
    readingOrderStore.setSelected(['o17']);
    readingOrderStore.setView('ua');
    readingOrderStore.clear();
    expect(readingOrderStore.snapshot()).toEqual({ pages: [], selectedKeys: [], view: 'ua', focus: null });
  });

  it('opens the tags view for a focus request and hands the request out once', () => {
    readingOrderStore.setView('ua');
    readingOrderStore.focusElement('o19', 1);
    expect(readingOrderStore.snapshot().view).toBe('tags');
    expect(readingOrderStore.takeFocus()).toEqual({ key: 'o19', pageIndex: 1 });
    expect(readingOrderStore.takeFocus()).toBeNull();
    // The view stays where the request put it.
    expect(readingOrderStore.snapshot().view).toBe('tags');
    expect(readingOrderStore.snapshot().focus).toBeNull();
  });
});
