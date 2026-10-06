import { en } from './en';
import { type MessageKey, tr } from './tr';

export type Locale = 'tr' | 'en';

export type { MessageKey };

export const DEFAULT_LOCALE: Locale = 'tr';

/**
 * A locale supplies the keys it maintains. Turkish is the complete locale;
 * every other locale is a scaffold and falls back to `tr` per key.
 */
export type Dictionary = Partial<Record<MessageKey, string>>;

const DICTIONARIES: Record<Locale, Dictionary> = { tr, en };

export interface Translator {
  (key: MessageKey, params?: Readonly<Record<string, string | number>>): string;
  readonly locale: Locale;
}

const PARAM = /\{(\w+)\}/g;

/**
 * Turkish-first translator. `en` is a scaffold: a key missing there
 * falls back to Turkish so a half-translated locale can never render blank UI.
 */
export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  const dictionary = DICTIONARIES[locale];
  const translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>): string => {
    const template = dictionary[key] ?? tr[key];
    if (params === undefined) return template;
    return template.replace(PARAM, (match, name: string) => {
      const value = params[name];
      return value === undefined ? match : String(value);
    });
  };
  return Object.assign(translate, { locale });
}
