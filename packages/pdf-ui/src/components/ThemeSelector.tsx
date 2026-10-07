import { Desktop, Moon, Sun } from '@phosphor-icons/react';
import type { Translator } from 'pdf-shared';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

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
} {
  const [theme, setThemeState] = useState<ThemeMode>(() => getStoredTheme());

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  useEffect(() => {
    const onThemeChange = (e: Event) => {
      const custom = e as CustomEvent<{ theme: ThemeMode; resolved: 'light' | 'dark' }>;
      if (custom.detail) setThemeState(custom.detail.theme);
    };

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onMediaChange = () => {
      if (getStoredTheme() === 'system') {
        const nextResolved = media.matches ? 'dark' : 'light';
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

  return { theme, setTheme };
}

export interface ThemeSelectorProps {
  readonly t: Translator;
  readonly className?: string;
}

export function ThemeSelector({ t, className = '' }: ThemeSelectorProps) {
  const { theme, setTheme } = useTheme();

  const modes: readonly { readonly mode: ThemeMode; readonly label: string; readonly icon: ReactNode }[] = [
    { mode: 'light', label: t('theme.light'), icon: <Sun size={14} /> },
    { mode: 'dark', label: t('theme.dark'), icon: <Moon size={14} /> },
    { mode: 'system', label: t('theme.system'), icon: <Desktop size={14} /> },
  ];

  return (
    <div
      className={`flex items-center gap-0.5 rounded-lg border border-kumo-line bg-kumo-recessed p-0.5 text-xs select-none ${className}`}
    >
      {modes.map(({ mode, label, icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={theme === mode}
          title={label}
          onClick={() => setTheme(mode)}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-all ${
            theme === mode
              ? 'bg-kumo-base text-kumo-strong'
              : 'text-kumo-subtle hover:text-kumo-default hover:bg-kumo-base/50'
          }`}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
