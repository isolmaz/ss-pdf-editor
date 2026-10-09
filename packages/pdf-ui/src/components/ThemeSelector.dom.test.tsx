// @vitest-environment happy-dom
/**
 * The theme selector in a page: a press on a mode stores it, paints the document with the
 * resolved scheme and tells every other selector; `system` follows the operating system's
 * preference, live, and a blocked store never stops the page from changing its colours.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { applyTheme, getStoredTheme, ThemeSelector } from './ThemeSelector';

const STORAGE_KEY = 'pdf-editor.theme';

/** The operating system's colour preference: `prefersDark` is what the media query answers. */
const preference = { prefersDark: false };
let mediaListeners: Set<() => void>;

beforeEach(() => {
  mediaListeners = new Set();
  preference.prefersDark = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' && preference.prefersDark;
    },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }));
  window.localStorage.clear();
  delete document.documentElement.dataset.mode;
  document.documentElement.style.colorScheme = '';
});

const blocked: MockInstance[] = [];

/** The store refuses the call, as a browser with storage disabled does. */
function blockStore(method: 'getItem' | 'setItem' | 'removeItem'): void {
  blocked.push(
    vi.spyOn(window.localStorage, method).mockImplementation(() => {
      throw new Error('blocked');
    }),
  );
}

afterEach(() => {
  for (const spy of blocked.splice(0)) spy.mockRestore();
  cleanup();
  vi.unstubAllGlobals();
});

const t = createTranslator('en');

function pressed(): string[] {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('title') ?? '');
}

describe('ThemeSelector in a page', () => {
  it('starts on system when nothing is stored', () => {
    render(<ThemeSelector t={t} />);
    expect(pressed()).toEqual(['System Theme']);
  });

  it('starts on the stored light or dark mode, and on system for any other stored value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    const dark = render(<ThemeSelector t={t} />);
    expect(pressed()).toEqual(['Dark Theme']);
    dark.unmount();

    window.localStorage.setItem(STORAGE_KEY, 'light');
    const light = render(<ThemeSelector t={t} />);
    expect(pressed()).toEqual(['Light Theme']);
    light.unmount();

    window.localStorage.setItem(STORAGE_KEY, 'sepia');
    render(<ThemeSelector t={t} />);
    expect(pressed()).toEqual(['System Theme']);
  });

  it('a press on Dark stores it, paints the document dark and presses the button', () => {
    render(<ThemeSelector t={t} />);
    fireEvent.click(screen.getByTitle('Dark Theme'));

    expect(pressed()).toEqual(['Dark Theme']);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('a press on Light paints the document light even when the system prefers dark', () => {
    preference.prefersDark = true;
    render(<ThemeSelector t={t} />);
    fireEvent.click(screen.getByTitle('Light Theme'));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('a press on System forgets the stored mode and takes the system preference, dark or light', () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    preference.prefersDark = true;
    render(<ThemeSelector t={t} />);
    fireEvent.click(screen.getByTitle('System Theme'));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.mode).toBe('dark');

    preference.prefersDark = false;
    fireEvent.click(screen.getByTitle('Dark Theme'));
    fireEvent.click(screen.getByTitle('System Theme'));
    expect(document.documentElement.dataset.mode).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('announces the change as pdf-theme-change with the chosen and the resolved mode', () => {
    const heard: unknown[] = [];
    const listen = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener('pdf-theme-change', listen);
    render(<ThemeSelector t={t} />);
    fireEvent.click(screen.getByTitle('Dark Theme'));
    preference.prefersDark = true;
    fireEvent.click(screen.getByTitle('System Theme'));
    window.removeEventListener('pdf-theme-change', listen);

    expect(heard).toEqual([
      { theme: 'dark', resolved: 'dark' },
      { theme: 'system', resolved: 'dark' },
    ]);
  });

  it('a press in one selector moves every other selector on the page', () => {
    render(
      <>
        <div data-testid="first">
          <ThemeSelector t={t} />
        </div>
        <div data-testid="second">
          <ThemeSelector t={t} />
        </div>
      </>,
    );
    const second = screen.getByTestId('second');
    fireEvent.click(screen.getByTestId('first').querySelector('[title="Dark Theme"]') as Element);

    expect(second.querySelector('[title="Dark Theme"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(second.querySelector('[title="System Theme"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('follows the system preference live while on system, and not while a mode is chosen', () => {
    render(<ThemeSelector t={t} />);
    expect(mediaListeners.size).toBe(1);

    preference.prefersDark = true;
    for (const listener of mediaListeners) listener();
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    preference.prefersDark = false;
    for (const listener of mediaListeners) listener();
    expect(document.documentElement.dataset.mode).toBe('light');

    fireEvent.click(screen.getByTitle('Dark Theme'));
    preference.prefersDark = false;
    for (const listener of mediaListeners) listener();
    expect(document.documentElement.dataset.mode).toBe('dark');
  });

  it('stops listening to the system once unmounted', () => {
    const view = render(<ThemeSelector t={t} />);
    view.unmount();
    expect(mediaListeners.size).toBe(0);
  });

  it('still paints the page when the store is blocked, and starts on system', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    blockStore('getItem');
    blockStore('setItem');
    blockStore('removeItem');
    expect(getStoredTheme()).toBe('system');

    render(<ThemeSelector t={t} />);
    fireEvent.click(screen.getByTitle('Dark Theme'));
    expect(pressed()).toEqual(['Dark Theme']);
    expect(document.documentElement.dataset.mode).toBe('dark');

    preference.prefersDark = true;
    fireEvent.click(screen.getByTitle('System Theme'));
    expect(document.documentElement.dataset.mode).toBe('dark');
  });

  it('applyTheme called outside a selector paints the document and moves a mounted selector', () => {
    render(<ThemeSelector t={t} />);
    fireEvent.click(screen.getByTitle('System Theme'));
    act(() => applyTheme('light'));

    expect(pressed()).toEqual(['Light Theme']);
    expect(document.documentElement.dataset.mode).toBe('light');
  });
});
