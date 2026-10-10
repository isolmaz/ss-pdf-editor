// @vitest-environment happy-dom
/**
 * The picture box: the largest rectangle of the picture's shape that fits its parent, re-measured
 * when the parent is resized. happy-dom has no layout, so the parent's size and the observer that
 * reports its changes are given here.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FittedStage } from './FittedStage';

let parent = { width: 400, height: 200 };
const observers: FakeObserver[] = [];

class FakeObserver {
  disconnected = false;
  observed: Element[] = [];
  constructor(readonly callback: () => void) {
    observers.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  disconnect() {
    this.disconnected = true;
  }
}

beforeEach(() => {
  parent = { width: 400, height: 200 };
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => parent.width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => parent.height);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function box(): HTMLElement {
  return screen.getByText('picture');
}

describe('FittedStage', () => {
  it('is as wide as the parent allows when the picture is wide enough to fill it', () => {
    render(<FittedStage aspect={2}>picture</FittedStage>);
    expect(box().style.width).toBe('400px');
    expect(box().style.height).toBe('200px');
  });

  it('is limited by the parent height for a picture narrower than the parent', () => {
    render(<FittedStage aspect={1}>picture</FittedStage>);
    expect(box().style.width).toBe('200px');
    expect(box().style.height).toBe('200px');
  });

  it('is limited by the parent width for a tall parent', () => {
    parent = { width: 300, height: 900 };
    render(<FittedStage aspect={1.5}>picture</FittedStage>);
    expect(box().style.width).toBe('300px');
    expect(box().style.height).toBe('200px');
  });

  it('measures again when the parent is resized, and again for a picture of another shape', () => {
    const view = render(<FittedStage aspect={2}>picture</FittedStage>);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([box().parentElement]);
    parent = { width: 100, height: 100 };
    act(() => observers[0]?.callback());
    expect(box().style.width).toBe('100px');
    expect(box().style.height).toBe('50px');
    view.rerender(<FittedStage aspect={0.5}>picture</FittedStage>);
    expect(box().style.width).toBe('50px');
    expect(box().style.height).toBe('100px');
  });

  it('stops watching the parent when it goes away', () => {
    const view = render(<FittedStage aspect={2}>picture</FittedStage>);
    expect(observers[0]?.disconnected).toBe(false);
    view.unmount();
    expect(observers[0]?.disconnected).toBe(true);
  });

  it('adds the caller class to the parent box, and none when there is none', () => {
    const view = render(
      <FittedStage aspect={2} className="size-full">
        picture
      </FittedStage>,
    );
    expect(box().parentElement?.className).toBe('relative flex items-center justify-center size-full');
    view.unmount();
    render(<FittedStage aspect={2}>picture</FittedStage>);
    expect(box().parentElement?.className.trim()).toBe('relative flex items-center justify-center');
  });
});
