// @vitest-environment happy-dom
/**
 * The root boundary: a render that throws (the commonest being a lazy chunk the browser cannot
 * fetch) ends in a recovery screen in the interface language, with the sentence for what
 * happened, what becomes of the open documents and a reload button, and the crash handler is
 * told once so the drafts can be written. The failure the user reads is the classified one
 * (`toToolError`), never the engine's English text.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, loadLocale } from 'pdf-shared';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, failureText, RootBoundary } from './recovery';

const en = createTranslator('en');

beforeAll(async () => {
  await loadLocale('en');
});
beforeEach(() => {
  window.localStorage.setItem('pdf-editor.locale', 'en');
  // React logs a caught render error; the tests throw on purpose.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'onLine');
  window.localStorage.clear();
});

function Throws({ error }: { readonly error: unknown }): ReactNode {
  throw error;
}

function setOnLine(onLine: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: onLine });
}

describe('ErrorBoundary', () => {
  it('renders its children until one throws, then the fallback for the thrown value, and tells onCatch once', () => {
    const onCatch = vi.fn();
    const thrown = new Error('boom');
    const { rerender } = render(
      <ErrorBoundary fallback={() => <p>fallback</p>} onCatch={onCatch}>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeTruthy();
    expect(onCatch).not.toHaveBeenCalled();

    rerender(
      <ErrorBoundary
        fallback={(error) => <p>{error === thrown ? 'got the error' : 'wrong error'}</p>}
        onCatch={onCatch}
      >
        <Throws error={thrown} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('got the error')).toBeTruthy();
    expect(onCatch).toHaveBeenCalledTimes(1);
    expect(onCatch.mock.calls[0]?.[0]).toBe(thrown);
  });

  it('catches a thrown falsy value and works without onCatch', () => {
    render(
      <ErrorBoundary fallback={(error) => <p>{`caught ${String(error)}`}</p>}>
        <Throws error={undefined} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('caught undefined')).toBeTruthy();
  });
});

describe('failureText', () => {
  it('says what happened and what to do, in the translator’s language', () => {
    setOnLine(false);
    const chunk = new TypeError('Failed to fetch dynamically imported module: /editor/assets/x-1.js');
    expect(failureText(chunk, en)).toBe(
      `${en('error.asset-offline.message')} ${en('error.asset-offline.hint')}`,
    );
    setOnLine(true);
    expect(failureText(chunk, en)).toBe(`${en('error.asset-stale.message')} ${en('error.asset-stale.hint')}`);
    expect(failureText(new Error('kaboom'), en)).toBe(
      `${en('error.internal.message')} ${en('error.internal.hint')}`,
    );
    expect(failureText(new Error('kaboom'), en)).not.toContain('kaboom');
  });
});

describe('RootBoundary', () => {
  it('shows the app while it renders', () => {
    render(
      <RootBoundary onCrash={vi.fn()}>
        <p>the app</p>
      </RootBoundary>,
    );
    expect(screen.getByText('the app')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('replaces a crashed app with the recovery screen: the failure, the drafts and a reload button', async () => {
    setOnLine(true);
    const onCrash = vi.fn();
    render(
      <RootBoundary onCrash={onCrash}>
        <Throws error={new TypeError('Failed to fetch dynamically imported module: /editor/assets/x-1.js')} />
      </RootBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(en('recovery.title'));
    expect(alert.textContent).toContain(en('error.asset-stale.message'));
    expect(alert.textContent).toContain(en('error.asset-stale.hint'));
    expect(alert.textContent).toContain(en('recovery.drafts'));
    expect(alert.textContent).not.toContain('dynamically imported module');
    expect(onCrash).toHaveBeenCalledTimes(1);

    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await userEvent.click(screen.getByRole('button', { name: en('recovery.reload') }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('speaks the stored interface language and gives a bug the generic sentence', async () => {
    window.localStorage.setItem('pdf-editor.locale', 'tr');
    await loadLocale('tr');
    const tr = createTranslator('tr');
    render(
      <RootBoundary onCrash={vi.fn()}>
        <Throws error={new Error('render bug')} />
      </RootBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(tr('recovery.title'));
    expect(alert.textContent).toContain(tr('error.internal.message'));
    expect(screen.getByRole('button', { name: tr('recovery.reload') })).toBeTruthy();
  });
});
