/**
 * The language selector is a segmented toggle while the app has two or three languages
 * (what the browser shows) and a list once it has more. The list is what a fourth language
 * turns it into, so the registry is given four entries here; the markup is what a reader
 * would see.
 */

import type * as Shared from 'pdf-shared';
import { createTranslator } from 'pdf-shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LanguageSelector } from './LanguageSelector';

vi.mock('pdf-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  const more = ['de', 'fr'].map((id) => ({
    id,
    nativeName: id === 'de' ? 'Deutsch' : 'Français',
    englishName: id,
    dir: 'ltr' as const,
    load: actual.LOCALES[1].load,
  }));
  return { ...actual, LOCALES: [...actual.LOCALES, ...more] };
});

describe('LanguageSelector with more than three languages', () => {
  it('renders a labelled list of every language by its own name, with the current one selected', () => {
    const markup = renderToStaticMarkup(<LanguageSelector t={createTranslator('en')} className="extra" />);

    expect(markup).toContain('<span class="sr-only">Language</span>');
    expect(markup).toContain('<select');
    for (const name of ['Türkçe', 'English', 'Deutsch', 'Français']) {
      expect(markup).toContain(`>${name}</option>`);
    }
    expect(markup).toContain('value="de" lang="de" dir="ltr"');
    expect(markup).toContain('extra');
    expect(markup).not.toContain('aria-pressed');
  });
});
