// @vitest-environment happy-dom
/**
 * The answers `mark-interaction` reads from the live document: whether a mark tool may take the
 * pointer at a point, whether a key's target is a control that takes typed keys, and whether a
 * consumed press lets go of a text control.
 * happy-dom has no layout, so `elementFromPoint` is the one thing a test supplies: it answers
 * with whatever element the test says is under the pointer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { holdsKeyboard, pageGestureAt, releaseFocusHolder } from './mark-interaction';

let under: Element | null = null;

beforeEach(() => {
  document.elementFromPoint = () => under;
});

afterEach(() => {
  under = null;
  document.body.replaceChildren();
});

/** A page surface holding `inner`, appended to the body. */
function pageWith(inner: string): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = inner;
  document.body.append(page);
  return page;
}

describe('pageGestureAt', () => {
  it('is not available where there is no element under the pointer', () => {
    under = null;
    expect(pageGestureAt(5, 5)).toEqual({ available: false, onLink: false });
  });

  it('is available on a page surface, and not on a link', () => {
    under = pageWith('<span class="textLayer"></span>');
    expect(pageGestureAt(5, 5)).toEqual({ available: true, onLink: false });
  });

  it('reports a link on a page, still available, so the layer decides whether to take the press', () => {
    const page = pageWith('<div class="annotationLayer"><a href="https://example.com/">x</a></div>');
    under = page.querySelector('a');
    expect(pageGestureAt(5, 5)).toEqual({ available: true, onLink: true });
  });

  it('is not available outside every page surface, even over a link', () => {
    const outside = document.createElement('a');
    outside.href = 'https://example.com/';
    document.body.append(outside);
    under = outside;
    expect(pageGestureAt(5, 5)).toEqual({ available: false, onLink: false });
  });

  it.each([
    ['a text input', '<input type="text">', 'input'],
    ['a text area', '<textarea></textarea>', 'textarea'],
    ['a select', '<select><option>a</option></select>', 'select'],
    ['a button', '<button type="button">b</button>', 'button'],
    ['an editable region', '<div contenteditable="true"><b>x</b></div>', 'b'],
  ])('leaves %s inside a page to the control itself', (_title, markup, selector) => {
    under = pageWith(markup).querySelector(selector);
    expect(pageGestureAt(5, 5)).toEqual({ available: false, onLink: false });
  });
});

describe('holdsKeyboard', () => {
  it.each([
    ['a text input', '<input type="text">', 'input'],
    ['a text area', '<textarea></textarea>', 'textarea'],
    ['a select', '<select><option>a</option></select>', 'select'],
    ['an editable region', '<div contenteditable="true">x</div>', 'div'],
    ['a plain-text editable region', '<div contenteditable="plaintext-only">x</div>', 'div'],
    ['inside an editable region', '<div contenteditable="true"><b>x</b></div>', 'b'],
  ])('is true for %s', (_title, markup, selector) => {
    expect(holdsKeyboard(pageWith(markup).querySelector(selector))).toBe(true);
  });

  it.each([
    ['a button', '<button type="button">b</button>', 'button'],
    ['a link', '<a href="https://example.com/">l</a>', 'a'],
    ['plain content', '<p>text</p>', 'p'],
    ['an explicitly non-editable region', '<div contenteditable="false">x</div>', 'div'],
  ])('is false for %s: it takes no typed keys', (_title, markup, selector) => {
    expect(holdsKeyboard(pageWith(markup).querySelector(selector))).toBe(false);
  });

  it('is false for the window, the document and no target at all', () => {
    expect(holdsKeyboard(window)).toBe(false);
    expect(holdsKeyboard(document)).toBe(false);
    expect(holdsKeyboard(null)).toBe(false);
  });
});

describe('releaseFocusHolder', () => {
  it.each([
    ['a text input', '<input>'],
    ['a text area', '<textarea></textarea>'],
    ['a select', '<select><option>a</option></select>'],
  ])('takes the keyboard away from %s', (_title, markup) => {
    const control = pageWith(markup).firstElementChild as HTMLElement;
    control.focus();
    expect(document.activeElement).toBe(control);
    releaseFocusHolder();
    expect(document.activeElement).not.toBe(control);
  });

  it('leaves a button focused: it holds no text', () => {
    const button = pageWith('<button type="button">b</button>').firstElementChild as HTMLElement;
    button.focus();
    releaseFocusHolder();
    expect(document.activeElement).toBe(button);
  });

  it('does nothing when nothing but the page holds the focus', () => {
    releaseFocusHolder();
    expect(document.activeElement).toBe(document.body);
  });
});
