import { describe, expect, it } from 'vitest';
import { en } from '../../../packages/shared/src/i18n/en';
import { tr } from '../../../packages/shared/src/i18n/tr';
import { APP } from './mock-strings';

/**
 * The models on the landing page show the editor's interface text. They keep their own copy
 * (the landing must not load the editor's dictionaries), so this test is what ties the copy to
 * the editor: a renamed key or a reworded string in either language fails here.
 */
describe('the interface text of the landing-page models', () => {
  const dictionaries = { en: en as Record<string, string>, tr: tr as Record<string, string> };

  for (const lang of ['en', 'tr'] as const) {
    it(`matches the editor's ${lang} dictionary key by key`, () => {
      const copy = APP[lang] as Record<string, string>;
      const drift = Object.entries(copy)
        .filter(([key, text]) => dictionaries[lang][key] !== text)
        .map(([key, text]) => `${key}: model "${text}", editor "${dictionaries[lang][key] ?? '(missing)'}"`);
      expect(drift).toEqual([]);
    });
  }

  it('has the same keys in both languages', () => {
    expect(Object.keys(APP.tr).sort()).toEqual(Object.keys(APP.en).sort());
  });
});
