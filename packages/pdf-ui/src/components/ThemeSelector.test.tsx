/**
 * The theme selector is one segmented control with a button per mode, labelled by the
 * translator. With no storage and no window (server render) the stored mode is `system`.
 */

import { createTranslator } from 'pdf-shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThemeSelector } from './ThemeSelector';

describe('ThemeSelector', () => {
  it('renders light, dark and system buttons with the translator’s words, system pressed', () => {
    const markup = renderToStaticMarkup(<ThemeSelector t={createTranslator('en')} className="extra" />);
    const buttons = [...markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*title="([^"]+)"/g)].map(
      (m) => [m[2], m[1]],
    );

    expect(buttons).toEqual([
      ['Light Theme', 'false'],
      ['Dark Theme', 'false'],
      ['System Theme', 'true'],
    ]);
    expect(markup).toContain('extra');
  });

  it('uses the other language’s words for the same buttons', () => {
    const markup = renderToStaticMarkup(<ThemeSelector t={createTranslator('tr')} />);
    expect(markup).toContain('title="Açık Tema"');
    expect(markup).toContain('title="Koyu Tema"');
    expect(markup).toContain('title="Sistem Teması"');
  });
});
