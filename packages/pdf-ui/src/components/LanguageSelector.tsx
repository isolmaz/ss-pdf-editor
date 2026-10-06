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
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null && isLocale(stored)) return stored;
      if (typeof navigator !== 'undefined') {
        const languages = navigator.languages?.length ? navigator.languages : [navigator.language ?? ''];
        const matched = matchLocale(languages);
        if (matched !== null) return matched;
      }
    }
  } catch {
    // Storage access may be restricted
  }
  return DEFAULT_LOCALE;
}

/** `<html lang>` and `<html dir>` follow the interface language. */
function markDocument(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = localeInfo(locale)?.dir ?? 'ltr';
}

export function applyLocale(locale: Locale): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, locale);
      markDocument(locale);
      window.dispatchEvent(
        new CustomEvent('pdf-locale-change', {
          detail: { locale },
        }),
      );
    }
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
      const custom = event as CustomEvent<{ locale: Locale }>;
      if (custom.detail?.locale) {
        setLocaleState(custom.detail.locale);
      }
    };

    window.addEventListener('pdf-locale-change', onLocaleChange);
    return () => {
      window.removeEventListener('pdf-locale-change', onLocaleChange);
    };
  }, []);

  return { locale, setLocale };
}

export interface LanguageSelectorProps {
  readonly t?: Translator;
  readonly variant?: 'segmented' | 'icon' | 'badge';
  readonly className?: string;
}

export function LanguageSelector({ t, variant = 'segmented', className = '' }: LanguageSelectorProps) {
  const { locale, setLocale } = useLocale();
  const current = localeInfo(locale);
  const label = t ? t('lang.select') : 'Language';

  // Two languages toggle; more than that is a list.
  if (LOCALES.length > 3 || ((variant === 'icon' || variant === 'badge') && LOCALES.length > 2)) {
    return (
      <label
        className={`flex h-7 items-center gap-1 rounded-md border border-kumo-line bg-kumo-base px-2 text-xs font-semibold text-kumo-strong ${className}`}
      >
        <Globe size={14} className="text-pdf-accent" aria-hidden="true" />
        <span className="sr-only">{label}</span>
        <select
          value={locale}
          onChange={(event) => {
            if (isLocale(event.target.value)) setLocale(event.target.value);
          }}
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

  if (variant === 'icon' || variant === 'badge') {
    const index = LOCALES.findIndex((info) => info.id === locale);
    const next = LOCALES[(index + 1) % LOCALES.length] ?? LOCALES[0];
    return (
      <button
        type="button"
        title={`${current?.nativeName ?? locale} → ${next.nativeName}`}
        aria-label={label}
        onClick={() => setLocale(next.id)}
        className={`flex h-7 items-center gap-1 rounded-md border border-kumo-line bg-kumo-base px-2 text-xs font-semibold text-kumo-strong hover:bg-kumo-recessed transition-colors ${className}`}
      >
        <Globe size={14} className="text-pdf-accent" />
        <span className="uppercase">{locale}</span>
      </button>
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
