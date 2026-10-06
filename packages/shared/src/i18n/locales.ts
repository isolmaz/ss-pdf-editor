/**
 * The interface languages, in one list.
 *
 * Adding a language is one entry here and one dictionary file: a `Dictionary` holds the
 * keys it translates, and every key it does not is taken from its `fallback` (English for
 * a new language), then from Turkish, the one complete catalogue — so a half-translated
 * language never shows a blank label. Every dictionary is its own chunk, fetched when its
 * language is in use (`loadLocale`): the app loads one catalogue, not all of them.
 *
 * `dir` is the writing direction the shell puts on `<html dir>`, which is what lets a
 * right-to-left language mirror the interface.
 */

import type { Dictionary } from './index';

export interface LocaleInfo {
  /** BCP 47 tag; also what `Intl` formats dates and numbers with. */
  readonly id: string;
  /** The language's own name for itself (`Türkçe`, `English`, `العربية`). */
  readonly nativeName: string;
  readonly englishName: string;
  readonly dir: 'ltr' | 'rtl';
  /** The locale a missing key comes from before Turkish. */
  readonly fallback?: string;
  /** Fetches the dictionary, a chunk of its own. */
  readonly load: () => Promise<Dictionary>;
}

export const LOCALES = [
  {
    id: 'tr',
    nativeName: 'Türkçe',
    englishName: 'Turkish',
    dir: 'ltr',
    load: async () => (await import('./tr')).tr,
  },
  {
    id: 'en',
    nativeName: 'English',
    englishName: 'English',
    dir: 'ltr',
    load: async () => (await import('./en')).en,
  },
] as const satisfies readonly LocaleInfo[];

export type Locale = (typeof LOCALES)[number]['id'];

export const LOCALE_IDS: readonly Locale[] = LOCALES.map((info) => info.id);

/** The registry entry for a locale id, or `undefined` for one the app does not have. */
export function localeInfo(id: string): LocaleInfo | undefined {
  return (LOCALES as readonly LocaleInfo[]).find((info) => info.id === id);
}

export function isLocale(id: string): id is Locale {
  return localeInfo(id) !== undefined;
}

/**
 * The best locale for a list of browser languages (`navigator.languages`), in their
 * order: an exact tag first (`pt-BR`), then its primary language (`pt`). `null` when
 * none of them is one the app has.
 */
export function matchLocale(languages: readonly string[]): Locale | null {
  for (const language of languages) {
    const tag = language.trim();
    if (tag === '') continue;
    const exact = LOCALE_IDS.find((id) => id.toLowerCase() === tag.toLowerCase());
    if (exact !== undefined) return exact;
    const primary = tag.split('-')[0]?.toLowerCase();
    const partial = LOCALE_IDS.find((id) => id.split('-')[0]?.toLowerCase() === primary);
    if (partial !== undefined) return partial;
  }
  return null;
}
