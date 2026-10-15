// @vitest-environment happy-dom
/**
 * `public/theme-boot.js`, the script that paints the stored theme before first paint. The
 * wrong answer that matters: it reads the stored choice once, so after the editor drops that
 * choice (a pick of "system" removes it) the page's own light/dark switch is still overridden
 * by the choice the user has since dropped.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'pdf-editor.theme';
// Relative to the repository root, where vitest runs (as `offline.test.ts` reads `tools/asset-pins.json`).
const source = readFileSync('public/theme-boot.js', 'utf8');

/** The operating system's colour preference and the listeners the script registered on it. */
const preference = { prefersDark: false };
let mediaListeners: Array<() => void>;

/** The system switches its scheme: the media query answers anew and tells its listeners. */
function systemSwitchesTo(scheme: 'light' | 'dark'): void {
  preference.prefersDark = scheme === 'dark';
  for (const listener of mediaListeners) listener();
}

/** Run the script as the browser does: a classic script, once, in the page's global scope. */
function runScript(): void {
  new Function(source)();
}

function painted(): { mode: string | undefined; scheme: string } {
  return { mode: document.documentElement.dataset.mode, scheme: document.documentElement.style.colorScheme };
}

beforeEach(() => {
  mediaListeners = [];
  preference.prefersDark = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: dark)' && preference.prefersDark;
    },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.push(listener),
  }));
  window.localStorage.clear();
  delete document.documentElement.dataset.mode;
  document.documentElement.style.colorScheme = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('theme-boot.js', () => {
  it('paints the stored choice at once, and the system preference when nothing is stored', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark');
    runScript();
    expect(painted()).toEqual({ mode: 'dark', scheme: 'dark' });

    window.localStorage.clear();
    preference.prefersDark = true;
    runScript();
    expect(painted()).toEqual({ mode: 'dark', scheme: 'dark' });

    preference.prefersDark = false;
    runScript();
    expect(painted()).toEqual({ mode: 'light', scheme: 'light' });
  });

  it('ignores a stored value that is neither light nor dark', () => {
    window.localStorage.setItem(STORAGE_KEY, 'sepia');
    preference.prefersDark = true;
    runScript();
    expect(painted()).toEqual({ mode: 'dark', scheme: 'dark' });
  });

  it('follows the system again once the editor drops the stored choice', () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    runScript();
    expect(painted()).toEqual({ mode: 'light', scheme: 'light' });

    // The user picks "system" in the editor: the stored choice is removed.
    window.localStorage.removeItem(STORAGE_KEY);
    systemSwitchesTo('dark');
    expect(painted()).toEqual({ mode: 'dark', scheme: 'dark' });
    systemSwitchesTo('light');
    expect(painted()).toEqual({ mode: 'light', scheme: 'light' });
  });

  it('keeps a choice the editor changes while the page lives, whatever the system does', () => {
    runScript();
    expect(painted()).toEqual({ mode: 'light', scheme: 'light' });

    window.localStorage.setItem(STORAGE_KEY, 'dark');
    systemSwitchesTo('light');
    expect(painted()).toEqual({ mode: 'dark', scheme: 'dark' });
  });

  it('still follows the system when the store refuses to be read', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    preference.prefersDark = true;
    runScript();
    expect(painted()).toEqual({ mode: 'dark', scheme: 'dark' });
    systemSwitchesTo('light');
    expect(painted()).toEqual({ mode: 'light', scheme: 'light' });
  });
});
