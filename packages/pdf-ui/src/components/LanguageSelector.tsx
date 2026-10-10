import { Globe } from '@phosphor-icons/react';
import {
  DEFAULT_LOCALE,
  isLocale,
  isLocaleLoaded,
  LOCALES,
  type Locale,
  loadLocale,
  localeInfo,
  matchLocale,
  type Translator,
} from 'pdf-shared';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'pdf-editor.locale';

/**
 * The interface language: the one the user chose, else the first of the browser's
 * languages the app has (`navigator.languages`, in order), else Turkish.
 */
export function getStoredLocale(): Locale {
  try {
    // Without a `window` (a server render) the reads below throw and the default applies.
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null && isLocale(stored)) return stored;
    const languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
    const matched = matchLocale(languages);
    if (matched !== null) return matched;
  } catch {
    // Storage access may be restricted
  }
  return DEFAULT_LOCALE;
}

/** `<html lang>` and `<html dir>` follow the interface language. */
function markDocument(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = localeInfo(locale)?.dir === 'rtl' ? 'rtl' : 'ltr';
}

export function applyLocale(locale: Locale): void {
  try {
    // Without a `window` (a server render) the first line throws and nothing is applied.
    window.localStorage.setItem(STORAGE_KEY, locale);
    markDocument(locale);
    window.dispatchEvent(
      new CustomEvent('pdf-locale-change', {
        detail: { locale },
      }),
    );
  } catch {
    // Storage access may be restricted
  }
}

export function useLocale(): {
  locale: Locale;
  setLocale: (locale: Locale) => void;
} {
  // A stored language whose dictionary is not loaded yet starts in its fallback and
  // switches once the dictionary has arrived (the effect below): a translator is built
  // from the dictionaries in memory, so it must not be built before they are there.
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = getStoredLocale();
    if (isLocaleLoaded(stored)) return stored;
    const fallback = localeInfo(stored)?.fallback;
    return fallback !== undefined && isLocale(fallback) && isLocaleLoaded(fallback)
      ? fallback
      : DEFAULT_LOCALE;
  });

  // A language whose dictionary is not loaded yet is loaded first, so the switch shows
  // its words at once instead of its fallback's for a moment.
  const setLocale = useCallback((next: Locale) => {
    const apply = () => {
      setLocaleState(next);
      applyLocale(next);
    };
    if (isLocaleLoaded(next)) apply();
    else void loadLocale(next).then(apply, apply);
  }, []);

  // The document's language is the interface's, however it was decided: a locale taken
  // from the browser (nothing stored yet) must not leave `<html lang="tr">` over English.
  useEffect(() => {
    markDocument(locale);
  }, [locale]);

  useEffect(() => {
    const stored = getStoredLocale();
    if (!isLocaleLoaded(stored)) void loadLocale(stored).then(() => setLocaleState(stored));
  }, []);

  useEffect(() => {
    const onLocaleChange = (event: Event) => {
      // `applyLocale` is the only dispatcher of this event and always sets `detail.locale`.
      setLocaleState((event as CustomEvent<{ locale: Locale }>).detail.locale);
    };

    window.addEventListener('pdf-locale-change', onLocaleChange);
    return () => {
      window.removeEventListener('pdf-locale-change', onLocaleChange);
    };
  }, []);

  return { locale, setLocale };
}

export interface LanguageSelectorProps {
  readonly t: Translator;
  readonly className?: string;
}

export function LanguageSelector({ t, className = '' }: LanguageSelectorProps) {
  const { locale, setLocale } = useLocale();
  const label = t('lang.select');

  // Two languages toggle; more than that is a list.
  if (LOCALES.length > 3) {
    return (
      <label
        className={`flex h-7 items-center gap-1 rounded-md border border-kumo-line bg-kumo-base px-2 text-xs font-semibold text-kumo-strong ${className}`}
      >
        <Globe size={14} className="text-pdf-accent" aria-hidden="true" />
        <span className="sr-only">{label}</span>
        <select
          value={locale}
          // The options are the registry's own ids, so the value is always a `Locale`.
          onChange={(event) => setLocale(event.target.value as Locale)}
          className="bg-transparent text-xs font-semibold text-kumo-strong outline-none"
        >
          {LOCALES.map((info) => (
            <option key={info.id} value={info.id} lang={info.id} dir={info.dir}>
              {info.nativeName}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div
      className={`inline-flex items-center rounded-md border border-kumo-line bg-kumo-recessed p-0.5 text-xs font-medium ${className}`}
    >
      {LOCALES.map((info) => (
        <button
          key={info.id}
          type="button"
          title={info.nativeName}
          aria-label={info.nativeName}
          aria-pressed={locale === info.id}
          lang={info.id}
          onClick={() => setLocale(info.id)}
          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase transition-colors ${
            locale === info.id
              ? 'bg-kumo-base text-kumo-strong shadow-xs'
              : 'text-kumo-subtle hover:text-kumo-strong'
          }`}
        >
          {info.id}
        </button>
      ))}
    </div>
  );
}
