/**
 * The interface languages. The wrong answers that matter: a browser language list matched
 * to the wrong locale (or to one the app does not have), a half-translated locale that
 * renders a blank label instead of its fallback's words, a `{param}` that one catalogue
 * has and the other lost (the sentence then shows a raw placeholder), and the two shipped
 * catalogues drifting apart in their keys.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from './en';
import { createTranslator, DEFAULT_LOCALE, isLocale, isLocaleLoaded, LOCALE_IDS, matchLocale } from './index';
import { tr } from './tr';

describe('locale ids', () => {
  it('knows tr and en, and nothing else', () => {
    expect(LOCALE_IDS).toEqual(['tr', 'en']);
    expect(DEFAULT_LOCALE).toBe('tr');
    expect(isLocale('tr')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('de')).toBe(false);
    expect(isLocale('')).toBe(false);
    expect(isLocale('EN')).toBe(false);
  });

  it('matches a browser language list by exact tag, then primary language, in the list`s order', () => {
    expect(matchLocale(['tr-TR'])).toBe('tr');
    expect(matchLocale(['de-DE', 'en-GB'])).toBe('en');
    expect(matchLocale(['EN-us', 'tr'])).toBe('en');
    expect(matchLocale(['  tr  '])).toBe('tr');
    expect(matchLocale(['de', 'fr'])).toBeNull();
    expect(matchLocale(['', '  '])).toBeNull();
    expect(matchLocale([])).toBeNull();
  });
});

describe('the shipped catalogues', () => {
  it('have the same keys, and every message uses the same {placeholders} in both', () => {
    const trKeys = Object.keys(tr).sort();
    expect(Object.keys(en).sort()).toEqual(trKeys);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const mismatched = trKeys.filter(
      (key) =>
        JSON.stringify(placeholders(tr[key as keyof typeof tr])) !==
        JSON.stringify(placeholders(en[key as keyof typeof en])),
    );
    expect(mismatched).toEqual([]);
  });
});

describe('createTranslator', () => {
  it('speaks each loaded language, fills {params}, leaves an unknown param and an unknown key visible', () => {
    expect(isLocaleLoaded('tr')).toBe(true);
    expect(isLocaleLoaded('en')).toBe(true);
    expect(createTranslator('tr')('update.refresh')).toBe(tr['update.refresh']);
    expect(createTranslator('en')('update.refresh')).toBe('Refresh');
    expect(createTranslator('en').locale).toBe('en');
    expect(createTranslator().locale).toBe('tr');

    const withParam = (Object.keys(en) as (keyof typeof en)[]).find((key) => en[key].includes('{count}'));
    if (withParam === undefined) throw new Error('no catalogue message takes {count}');
    const translate = createTranslator('en');
    expect(translate(withParam, { count: 7 })).toBe(en[withParam].replaceAll('{count}', '7'));
    expect(translate(withParam, { other: 1 })).toBe(en[withParam]);
    expect(translate('no.such.key' as never)).toBe('no.such.key');
  });
});

describe('a partial locale', () => {
  afterEach(() => {
    vi.doUnmock('./locales');
    vi.resetModules();
  });

  /**
   * A registry in which `xx` falls back to `en`, then Turkish, and each holds one different key.
   * `fetched` lists every dictionary chunk the loader asked for, in order.
   */
  async function partialRegistry(fetched: string[] = []) {
    vi.resetModules();
    vi.doMock('./locales', async (importActual) => {
      const actual = await importActual<typeof import('./locales')>();
      const chunk = (id: string, dictionary: Record<string, string>) => async () => {
        fetched.push(id);
        return dictionary;
      };
      const registry = [
        {
          id: 'tr',
          dir: 'ltr',
          load: chunk('tr', { 'toolbar.hand': 'TR hand', 'update.refresh': 'TR refresh' }),
        },
        { id: 'en', dir: 'ltr', load: chunk('en', { 'update.refresh': 'EN refresh' }) },
        { id: 'xx', dir: 'ltr', fallback: 'en', load: chunk('xx', { 'update.available': 'XX available' }) },
        { id: 'a', dir: 'ltr', fallback: 'b', load: chunk('a', {}) },
        { id: 'b', dir: 'ltr', fallback: 'a', load: chunk('b', {}) },
        { id: 'orphan', dir: 'ltr', fallback: 'gone', load: chunk('orphan', { 'update.available': 'O' }) },
      ];
      return { ...actual, localeInfo: (id: string) => registry.find((info) => info.id === id) };
    });
    return await import('./index');
  }

  it('fetches each dictionary once, and skips a fallback that is not registered', async () => {
    const fetched: string[] = [];
    const i18n = await partialRegistry(fetched);
    await i18n.loadLocale('xx' as never);
    await i18n.loadLocale('en');
    await i18n.loadLocale('xx' as never);
    expect(fetched).toEqual(['xx', 'en']);
    await i18n.loadLocale('orphan' as never);
    expect(fetched).toEqual(['xx', 'en', 'orphan']);
    expect(i18n.isLocaleLoaded('gone' as never)).toBe(false);
    expect(i18n.createTranslator('orphan' as never)('update.available')).toBe('O');
  });

  it('takes a missing key from its fallback, then from Turkish, and the key itself last', async () => {
    const i18n = await partialRegistry();
    const before = i18n.createTranslator('xx' as never);
    // Nothing is loaded yet: no blank label, the key shows.
    expect(before('update.available')).toBe('update.available');

    await i18n.loadLocale('xx' as never);
    expect(i18n.isLocaleLoaded('xx' as never)).toBe(true);
    // Loading a locale loads its fallback chain too, and Turkish is added by the lookup itself.
    expect(i18n.isLocaleLoaded('en')).toBe(true);
    const translate = i18n.createTranslator('xx' as never);
    expect(translate('update.available')).toBe('XX available');
    expect(translate('update.refresh')).toBe('EN refresh');
    expect(i18n.isLocaleLoaded('tr')).toBe(false);
    await i18n.loadLocale('tr');
    expect(i18n.createTranslator('xx' as never)('toolbar.hand')).toBe('TR hand');
    expect(i18n.createTranslator('xx' as never)('toolbar.fit' as never)).toBe('toolbar.fit');
  });

  it('stops at a fallback cycle instead of looping', async () => {
    const i18n = await partialRegistry();
    await i18n.loadLocale('a' as never);
    expect(i18n.isLocaleLoaded('a' as never)).toBe(true);
    expect(i18n.isLocaleLoaded('b' as never)).toBe(true);
    expect(i18n.createTranslator('a' as never)('update.refresh')).toBe('update.refresh');
  });
});
