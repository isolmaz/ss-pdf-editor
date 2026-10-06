import { Desktop, Moon, Sun } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'pdf-editor.theme';

export function getStoredTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage may be blocked
  }
  return 'system';
}

export function applyTheme(mode: ThemeMode): void {
  try {
    if (mode === 'system') {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, mode);
    }
  } catch {
    // Storage may be blocked
  }

  const isDark =
    mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolvedMode = isDark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = resolvedMode;
  document.documentElement.dataset.mode = resolvedMode;

  window.dispatchEvent(
    new CustomEvent('pdf-theme-change', {
      detail: { theme: mode, resolved: resolvedMode },
    }),
  );
}

export function useTheme(): {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  resolvedTheme: 'light' | 'dark';
} {
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() => {
    const current = getStoredTheme();
    if (current === 'light' || current === 'dark') return current;
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  useEffect(() => {
    const onThemeChange = (e: Event) => {
      const custom = e as CustomEvent<{ theme: ThemeMode; resolved: 'light' | 'dark' }>;
      if (custom.detail) {
        setThemeState(custom.detail.theme);
        setResolvedTheme(custom.detail.resolved);
      }
    };

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = () => {
      if (getStoredTheme() === 'system') {
        const nextResolved = media.matches ? 'dark' : 'light';
        setResolvedTheme(nextResolved);
        document.documentElement.style.colorScheme = nextResolved;
        document.documentElement.dataset.mode = nextResolved;
      }
    };

    window.addEventListener('pdf-theme-change', onThemeChange);
    media.addEventListener('change', onMediaChange);
    return () => {
      window.removeEventListener('pdf-theme-change', onThemeChange);
      media.removeEventListener('change', onMediaChange);
    };
  }, []);

  return { theme, setTheme, resolvedTheme };
}

export interface ThemeSelectorProps {
  readonly t?: Translator;
  readonly variant?: 'icon' | 'segmented';
  readonly className?: string;
}

export function ThemeSelector({ t, variant = 'icon', className = '' }: ThemeSelectorProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();

  const getLabel = (mode: ThemeMode) => {
    if (t) {
      if (mode === 'light') return t('theme.light');
      if (mode === 'dark') return t('theme.dark');
      return t('theme.system');
    }
    return mode === 'light' ? 'Açık' : mode === 'dark' ? 'Koyu' : 'Sistem';
  };

  const cycleTheme = () => {
    if (theme === 'system') setTheme('light');
    else if (theme === 'light') setTheme('dark');
    else setTheme('system');
  };

  if (variant === 'segmented') {
    return (
      <div
        className={`flex items-center gap-0.5 rounded-lg border border-kumo-line bg-kumo-recessed p-0.5 text-xs select-none ${className}`}
      >
        <button
          type="button"
          aria-pressed={theme === 'light'}
          title={getLabel('light')}
          onClick={() => setTheme('light')}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-all ${
            theme === 'light'
              ? 'bg-kumo-base text-kumo-strong'
              : 'text-kumo-subtle hover:text-kumo-default hover:bg-kumo-base/50'
          }`}
        >
          <Sun size={14} />
          <span>{getLabel('light')}</span>
        </button>

        <button
          type="button"
          aria-pressed={theme === 'dark'}
          title={getLabel('dark')}
          onClick={() => setTheme('dark')}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-all ${
            theme === 'dark'
              ? 'bg-kumo-base text-kumo-strong'
              : 'text-kumo-subtle hover:text-kumo-default hover:bg-kumo-base/50'
          }`}
        >
          <Moon size={14} />
          <span>{getLabel('dark')}</span>
        </button>

        <button
          type="button"
          aria-pressed={theme === 'system'}
          title={getLabel('system')}
          onClick={() => setTheme('system')}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-all ${
            theme === 'system'
              ? 'bg-kumo-base text-kumo-strong'
              : 'text-kumo-subtle hover:text-kumo-default hover:bg-kumo-base/50'
          }`}
        >
          <Desktop size={14} />
          <span>{getLabel('system')}</span>
        </button>
      </div>
    );
  }

  // Icon variant: compact button with intuitive cycle & descriptive tooltip
  const currentIcon =
    theme === 'system' ? (
      <Desktop size={16} />
    ) : resolvedTheme === 'dark' ? (
      <Moon size={16} />
    ) : (
      <Sun size={16} />
    );

  const nextModeText =
    theme === 'system' ? getLabel('light') : theme === 'light' ? getLabel('dark') : getLabel('system');

  return (
    <button
      type="button"
      onClick={cycleTheme}
      className={`flex size-8 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong transition-colors ${className}`}
      title={
        t
          ? t('theme.cycle.title', { current: getLabel(theme), next: nextModeText })
          : `${getLabel(theme)} (${nextModeText} moduna geç)`
      }
      aria-label={t ? t('theme.cycle.aria', { current: getLabel(theme) }) : `${getLabel(theme)} tema`}
    >
      {currentIcon}
    </button>
  );
}
