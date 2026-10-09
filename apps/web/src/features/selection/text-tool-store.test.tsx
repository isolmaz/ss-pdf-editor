// @vitest-environment happy-dom
/** The text tool's state: the block the user picked and the bytes its model is read from. */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTextEdit,
  initialTextToolState,
  type TextEditSelection,
  textBlockPicked,
  textToolBytesFrozen,
  textToolStore,
  useTextTool,
} from './text-tool-store';

const picked = {
  pageIndex: 2,
  block: { id: 'b1' },
  model: { id: 'page' },
  fonts: { catalog: {}, metrics: {} },
  // What the layer also hands over: the store keeps only what the dialog's run context carries.
  editable: true,
} as unknown as TextEditSelection;

beforeEach(() => textToolStore.set(initialTextToolState()));
afterEach(cleanup);

describe('the text tool state', () => {
  it('starts with no block picked and no bytes frozen', () => {
    expect(textToolStore.get()).toEqual({ edit: null, bytes: null });
  });

  it('keeps the picked block with the four things the dialog edits, and drops it when spent', () => {
    textBlockPicked(picked);
    expect(textToolStore.get().edit).toEqual({
      pageIndex: 2,
      block: picked.block,
      model: picked.model,
      fonts: picked.fonts,
    });
    clearTextEdit();
    expect(textToolStore.get().edit).toBeNull();
  });

  it('holds the frozen bytes until they are let go', () => {
    const bytes = new Uint8Array([1]);
    textToolBytesFrozen(bytes);
    expect(textToolStore.get().bytes).toBe(bytes);
    textToolBytesFrozen(null);
    expect(textToolStore.get().bytes).toBeNull();
  });

  it('re-renders a reader of the picked block', () => {
    const view = renderHook(() => useTextTool((state) => state.edit));
    expect(view.result.current).toBeNull();
    act(() => textBlockPicked(picked));
    expect(view.result.current?.pageIndex).toBe(2);
  });
});
