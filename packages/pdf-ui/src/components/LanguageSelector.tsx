import { Globe } from '@phosphor-icons/react';
import type { Locale, Translator } from 'pdf-shared';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'pdf-editor.locale';

export function getStoredLocale(): Locale {
  try {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'tr' || stored === 'en') return stored;
      // Auto-detect browser language if not explicitly chosen
      if (typeof navigator !== 'undefined' && navigator.language) {
        if (navigator.language.toLowerCase().startsWith('en')) {
          return 'en';
        }
      }
    }
  } catch {
    // Storage access may be restricted
  }
  return 'tr';
}

export function applyLocale(locale: Locale): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, locale);
      document.documentElement.lang = locale;
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
  const [locale, setLocaleState] = useState<Locale>(() => getStoredLocale());

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    applyLocale(next);
  }, []);

  // The document's language is the interface's, however it was decided: a locale taken
  // from the browser (nothing stored yet) must not leave `<html lang="tr">` over English.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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

  const toggleLocale = () => {
    setLocale(locale === 'tr' ? 'en' : 'tr');
  };

  const titleText =
    locale === 'tr' ? 'Dili Değiştir (İngilizceye Geç)' : 'Switch Language (Switch to Turkish)';

  if (variant === 'icon' || variant === 'badge') {
    return (
      <button
        type="button"
        title={titleText}
        aria-label={t ? t('lang.select') : 'Language'}
        onClick={toggleLocale}
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
      <button
        type="button"
        title="Türkçe"
        aria-label="Türkçe"
        aria-pressed={locale === 'tr'}
        onClick={() => setLocale('tr')}
        className={`rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
          locale === 'tr'
            ? 'bg-kumo-base text-kumo-strong shadow-xs'
            : 'text-kumo-subtle hover:text-kumo-strong'
        }`}
      >
        TR
      </button>
      <button
        type="button"
        title="English"
        aria-label="English"
        aria-pressed={locale === 'en'}
        onClick={() => setLocale('en')}
        className={`rounded px-1.5 py-0.5 text-[11px] font-semibold transition-colors ${
          locale === 'en'
            ? 'bg-kumo-base text-kumo-strong shadow-xs'
            : 'text-kumo-subtle hover:text-kumo-strong'
        }`}
      >
        EN
      </button>
    </div>
  );
}
