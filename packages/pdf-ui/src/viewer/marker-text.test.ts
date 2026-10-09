// @vitest-environment happy-dom
/**
 * The identity marker of an annotation written before `/NM` carried it never reaches the
 * reader: it is stripped from what the page already shows and from every popup pdf.js
 * builds later, while the reader's own words stay.
 */

import { describe, expect, it } from 'vitest';
import { hideEditorMarkers } from './marker-text';

function mount(html = '') {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe('hideEditorMarkers', () => {
  it('strips the marker from what is already on the page and leaves the words', () => {
    const root = mount(
      '<section><p>pdf-editor-ann:abc123 first words</p><p>untouched</p><p>x pdf-editor-ann:q9 y</p></section>',
    );
    const stop = hideEditorMarkers(root);
    expect([...root.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'first words',
      'untouched',
      'x  y',
    ]);
    stop();
  });

  it('leaves a page without any marker exactly as it was', () => {
    const root = mount('<p>just words</p>');
    const stop = hideEditorMarkers(root);
    expect(root.innerHTML).toBe('<p>just words</p>');
    stop();
  });

  it('cleans a popup element added later', async () => {
    const root = mount();
    const stop = hideEditorMarkers(root);
    const popup = document.createElement('div');
    popup.innerHTML = '<span>pdf-editor-ann:late1 hello</span><span>kept</span>';
    root.append(popup);
    await Promise.resolve();
    expect([...popup.querySelectorAll('span')].map((s) => s.textContent)).toEqual(['hello', 'kept']);
    stop();
  });

  it('ignores an added element that carries no marker', async () => {
    const root = mount();
    const stop = hideEditorMarkers(root);
    const popup = document.createElement('div');
    popup.textContent = 'plain popup';
    root.append(popup);
    await Promise.resolve();
    expect(popup.textContent).toBe('plain popup');
    stop();
  });

  it('cleans a bare text node added later', async () => {
    const root = mount();
    const stop = hideEditorMarkers(root);
    root.append(document.createTextNode('pdf-editor-ann:bare7 loose words'));
    await Promise.resolve();
    expect(root.textContent).toBe('loose words');
    stop();
  });

  it('leaves an added text node without a marker alone', async () => {
    const root = mount();
    const stop = hideEditorMarkers(root);
    root.append(document.createTextNode('loose words'));
    await Promise.resolve();
    expect(root.textContent).toBe('loose words');
    stop();
  });

  it('cleans text whose content is rewritten in place', async () => {
    const root = mount('<p>first</p>');
    const stop = hideEditorMarkers(root);
    const text = root.querySelector('p')?.firstChild as Text;
    text.data = 'pdf-editor-ann:edit5 rewritten';
    await Promise.resolve();
    expect(root.textContent).toBe('rewritten');
    stop();
  });

  it('stops watching once disconnected', async () => {
    const root = mount();
    const stop = hideEditorMarkers(root);
    stop();
    root.append(document.createTextNode('pdf-editor-ann:after1 stays'));
    await Promise.resolve();
    expect(root.textContent).toBe('pdf-editor-ann:after1 stays');
  });
});
