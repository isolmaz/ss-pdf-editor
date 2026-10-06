import { en } from './en';
import { type Locale, localeInfo } from './locales';
import { type MessageKey, tr } from './tr';

export type { LocaleInfo } from './locales';
export { isLocale, LOCALE_IDS, LOCALES, localeInfo, matchLocale } from './locales';
export type { Locale, MessageKey };

export const DEFAULT_LOCALE: Locale = 'tr';

/**
 * A locale supplies the keys it maintains. Turkish is the complete locale;
 * every other locale falls back per key (`LocaleInfo.fallback`, then Turkish).
 */
export type Dictionary = Partial<Record<MessageKey, string>>;

/**
 * The dictionaries in memory. Turkish and English are bundled; another locale's is
 * added by `loadLocale` before the interface switches to it.
 */
const DICTIONARIES = new Map<string, Dictionary>([
  ['tr', tr],
  ['en', en],
]);

/** Fetch a registered locale's dictionary (and its fallback's) so `createTranslator` has it. */
export async function loadLocale(locale: Locale): Promise<void> {
  const chain: string[] = [];
  for (let id: string | undefined = locale; id !== undefined && !chain.includes(id); ) {
    chain.push(id);
    id = localeInfo(id)?.fallback;
  }
  for (const id of chain) {
    if (DICTIONARIES.has(id)) continue;
    const info = localeInfo(id);
    if (info !== undefined) DICTIONARIES.set(id, await info.load());
  }
}

/** Whether a locale's dictionary is in memory, so switching to it needs no load. */
export function isLocaleLoaded(locale: Locale): boolean {
  return DICTIONARIES.has(locale);
}

export interface Translator {
  (key: MessageKey, params?: Readonly<Record<string, string | number>>): string;
  readonly locale: Locale;
}

const PARAM = /\{(\w+)\}/g;

/**
 * The dictionaries a key is looked up in, in order: the locale's own, its fallbacks',
 * and Turkish last. A locale whose dictionary is not loaded yet contributes nothing, so
 * the interface shows the fallback's words until `loadLocale` has finished.
 */
function lookupChain(locale: Locale): readonly Dictionary[] {
  const chain: Dictionary[] = [];
  const seen = new Set<string>();
  for (
    let id: string | undefined = locale;
    id !== undefined && !seen.has(id);
    id = localeInfo(id)?.fallback
  ) {
    seen.add(id);
    const dictionary = DICTIONARIES.get(id);
    if (dictionary !== undefined) chain.push(dictionary);
  }
  if (!seen.has('tr')) chain.push(tr);
  return chain;
}

/**
 * The translator for a locale: its own words, a missing key from its fallback, and
 * Turkish last, so a half-translated locale can never render a blank label.
 */
export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  const chain = lookupChain(locale);
  const translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>): string => {
    let template: string = tr[key];
    for (const dictionary of chain) {
      const value = dictionary[key];
      if (value !== undefined) {
        template = value;
        break;
      }
    }
    if (params === undefined) return template;
    return template.replace(PARAM, (match, name: string) => {
      const value = params[name];
      return value === undefined ? match : String(value);
    });
  };
  return Object.assign(translate, { locale });
}
