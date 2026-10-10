// @vitest-environment happy-dom
/**
 * The language selector in a page: which language the interface starts in (the stored one,
 * else the browser's, else Turkish), what a press stores and announces, how `<html lang>` and
 * `<html dir>` follow, and what happens while a language's dictionary is still being fetched.
 * Languages beyond Turkish and English are registered per test (the registry is the one
 * `pdf-shared` exports, so every function that reads it sees them) and removed afterwards.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTranslator, LOCALE_IDS, LOCALES, type LocaleInfo } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { applyLocale, getStoredLocale, LanguageSelector } from './LanguageSelector';

const STORAGE_KEY = 'pdf-editor.locale';
const registry = LOCALES as unknown as LocaleInfo[];
const registeredIds = LOCALE_IDS as unknown as string[];
const t = createTranslator('en');

let added: string[] = [];

/** Adds a language to the registry; its dictionary is empty and loads at once unless told otherwise. */
function register(id: string, overrides: Partial<LocaleInfo> = {}): void {
  added.push(id);
  registry.push({
    id,
    nativeName: id.toUpperCase(),
    englishName: id,
    dir: 'ltr',
    load: async () => ({}),
    ...overrides,
  });
  registeredIds.push(id);
}

function browserLanguages(languages: readonly string[], language: string): void {
  Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = '';
  document.documentElement.dir = '';
  browserLanguages(['tr'], 'tr');
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
  for (const id of added) {
    registry.splice(
      registry.findIndex((info) => info.id === id),
      1,
    );
    registeredIds.splice(registeredIds.indexOf(id), 1);
  }
  added = [];
  Reflect.deleteProperty(window.navigator, 'languages');
  Reflect.deleteProperty(window.navigator, 'language');
});

function pressed(): string[] {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('aria-label') ?? '');
}

describe('which language the interface starts in', () => {
  it('is the stored language, ahead of the browser’s', () => {
    window.localStorage.setItem(STORAGE_KEY, 'tr');
    browserLanguages(['en-US'], 'en-US');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['Türkçe']);
    expect(document.documentElement.lang).toBe('tr');
    expect(getStoredLocale()).toBe('tr');
  });

  it('is the first of the browser’s languages the app has when nothing is stored', () => {
    browserLanguages(['de-DE', 'en-GB', 'tr'], 'de-DE');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['English']);
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('ignores a stored language the app does not have', () => {
    window.localStorage.setItem(STORAGE_KEY, 'xx');
    browserLanguages(['en'], 'en');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['English']);
  });

  it('reads the browser’s single language when it lists none', () => {
    browserLanguages([], 'en-US');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['English']);
  });

  it('is Turkish when no browser language is one the app has', () => {
    browserLanguages(['fr-FR'], 'fr-FR');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['Türkçe']);
    expect(document.documentElement.lang).toBe('tr');
  });

  it('is Turkish when the store is blocked', () => {
    browserLanguages(['en'], 'en');
    blockStore('getItem');

    expect(getStoredLocale()).toBe('tr');
    render(<LanguageSelector t={t} />);
    expect(pressed()).toEqual(['Türkçe']);
  });
});

describe('pressing a language', () => {
  it('stores it, presses its button, sets <html lang> and announces it as pdf-locale-change', () => {
    const heard: unknown[] = [];
    const listen = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener('pdf-locale-change', listen);
    render(<LanguageSelector t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    window.removeEventListener('pdf-locale-change', listen);

    expect(pressed()).toEqual(['English']);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(heard).toEqual([{ locale: 'en' }]);
  });

  it('moves every other selector on the page', () => {
    render(
      <>
        <div data-testid="first">
          <LanguageSelector t={t} />
        </div>
        <div data-testid="second">
          <LanguageSelector t={t} />
        </div>
      </>,
    );
    fireEvent.click(screen.getByTestId('first').querySelector('[aria-label="English"]') as Element);

    expect(
      screen.getByTestId('second').querySelector('[aria-label="English"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByTestId('second').querySelector('[aria-label="Türkçe"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('still switches the interface when the store is blocked, but stores and announces nothing', () => {
    blockStore('setItem');
    const heard: unknown[] = [];
    const listen = (event: Event) => heard.push(event);
    window.addEventListener('pdf-locale-change', listen);
    render(<LanguageSelector t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    window.removeEventListener('pdf-locale-change', listen);

    expect(pressed()).toEqual(['English']);
    expect(document.documentElement.lang).toBe('en');
    expect(heard).toEqual([]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('applyLocale outside a selector stores the language and moves a mounted selector', () => {
    render(<LanguageSelector t={t} />);
    act(() => applyLocale('en'));

    expect(pressed()).toEqual(['English']);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('a right-to-left language sets <html dir="rtl"> and a left-to-right one takes it back', async () => {
    register('ar', { dir: 'rtl', nativeName: 'العربية' });
    render(<LanguageSelector t={t} />);

    fireEvent.click(screen.getByRole('button', { name: 'العربية' }));
    await waitFor(() => expect(pressed()).toEqual(['العربية']));
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(document.documentElement.dir).toBe('ltr');
  });
});

describe('a language whose dictionary is not loaded yet', () => {
  it('is switched to once it has loaded, after pressing it', async () => {
    const dictionary = Promise.withResolvers<Record<string, string>>();
    register('pl', { nativeName: 'Polski', load: () => dictionary.promise });
    render(<LanguageSelector t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Polski' }));

    // Nothing changes until its words have arrived.
    expect(pressed()).toEqual(['Türkçe']);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    await act(async () => dictionary.resolve({}));
    await waitFor(() => expect(pressed()).toEqual(['Polski']));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('pl');
  });

  it('is switched to even when its dictionary fails to load', async () => {
    register('ru', {
      nativeName: 'Русский',
      load: () => Promise.reject(new Error('offline')),
    });
    render(<LanguageSelector t={t} />);
    fireEvent.click(screen.getByRole('button', { name: 'Русский' }));

    await waitFor(() => expect(pressed()).toEqual(['Русский']));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('ru');
  });

  it('starts in its fallback when that is loaded, then in its own once it has loaded', async () => {
    register('de', { nativeName: 'Deutsch', fallback: 'en' });
    window.localStorage.setItem(STORAGE_KEY, 'de');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['English']);
    await waitFor(() => expect(pressed()).toEqual(['Deutsch']));
  });

  it('starts in Turkish when it has no fallback', async () => {
    register('nl', { nativeName: 'Nederlands' });
    window.localStorage.setItem(STORAGE_KEY, 'nl');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['Türkçe']);
    await waitFor(() => expect(pressed()).toEqual(['Nederlands']));
  });

  it('starts in Turkish when its fallback is not a language the app has', async () => {
    register('sv', { nativeName: 'Svenska', fallback: 'zz' });
    window.localStorage.setItem(STORAGE_KEY, 'sv');
    render(<LanguageSelector t={t} />);

    expect(pressed()).toEqual(['Türkçe']);
    await waitFor(() => expect(pressed()).toEqual(['Svenska']));
  });

  it('starts in Turkish when its fallback is itself not loaded yet', async () => {
    register('da', { nativeName: 'Dansk', fallback: 'no' });
    register('no', { nativeName: 'Norsk' });
    window.localStorage.setItem(STORAGE_KEY, 'da');
    render(<LanguageSelector t={t} />);

    expect(screen.getByRole('combobox')).toHaveProperty('value', 'tr');
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveProperty('value', 'da'));
  });
});

describe('with more than three languages', () => {
  it('is a labelled list that stores and applies the language picked', () => {
    register('es', { nativeName: 'Español' });
    register('it', { nativeName: 'Italiano' });
    render(<LanguageSelector t={t} />);

    const list = screen.getByLabelText('Language');
    expect(list).toHaveProperty('value', 'tr');
    fireEvent.change(list, { target: { value: 'en' } });

    expect(screen.getByLabelText('Language')).toHaveProperty('value', 'en');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
