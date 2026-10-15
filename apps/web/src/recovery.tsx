/**
 * What the shell does when React cannot render it.
 *
 * Without a boundary, one component that throws while rendering unmounts the whole tree and
 * leaves a white page. The commonest cause is not a bug: a `lazy()` chunk the browser cannot
 * fetch (offline with the chunk not cached, a release that replaced the hashed file) rejects
 * inside its `Suspense`, and nothing above catches it. `RootBoundary` catches it and shows a
 * recovery screen in the interface language: what happened (`toToolError`: "connect and
 * reload" offline, "the app was updated, reload" online, the generic sentence for a bug),
 * what happens to the open documents, and one button that reloads the page.
 *
 * This module is in the first-paint chunk, so it is deliberately small: no icons, no Kumo
 * components (a failing component library must not take the recovery screen with it), and it
 * sits outside `components/` and `features/`, which the React Compiler would otherwise
 * memoise for no gain.
 */

import { createTranslator, type Translator, toToolError } from 'pdf-shared';
import { getStoredLocale } from 'pdf-ui/ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** What stands in for the children once one of them has thrown while rendering. */
  readonly fallback: (error: unknown) => ReactNode;
  /** Told once per caught error, after the fallback is chosen. */
  readonly onCatch?: (error: unknown, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  /** Boxed: anything can be thrown, `undefined` and `0` included. */
  readonly caught: { readonly error: unknown } | null;
}

/**
 * A React error boundary. It does not reset itself: a failed `lazy()` payload stays rejected
 * for the page's lifetime, so trying the children again would only throw again. A caller that
 * wants a fresh start gives it a new `key`.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { caught: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { caught: { error } };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onCatch?.(error, info);
  }

  override render(): ReactNode {
    const { caught } = this.state;
    return caught === null ? this.props.children : this.props.fallback(caught.error);
  }
}

/** A failure as a sentence: what happened, then what to do (`error.<code>.message` and `.hint`). */
export function failureText(error: unknown, t: Translator): string {
  const failure = toToolError(error, 'ui');
  return `${t(failure.messageKey)} ${t(failure.hintKey)}`;
}

/**
 * The screen that replaces a shell that crashed. The words come from the stored interface
 * language, read here and not from the shell's own state, which is gone.
 */
function RecoveryScreen({ error }: { readonly error: unknown }) {
  const t = createTranslator(getStoredLocale());
  return (
    <main className="grid min-h-dvh place-items-center bg-kumo-base p-6 text-kumo-default">
      <div role="alert" className="flex max-w-lg flex-col items-start gap-3">
        <h1 className="text-lg font-semibold">{t('recovery.title')}</h1>
        <p className="text-sm">{failureText(error, t)}</p>
        <p className="text-sm text-kumo-subtle">{t('recovery.drafts')}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-9 rounded-md bg-pdf-accent px-4 text-sm font-semibold text-pdf-on-accent hover:opacity-90"
        >
          {t('recovery.reload')}
        </button>
      </div>
    </main>
  );
}

export interface RootBoundaryProps {
  readonly children: ReactNode;
  /**
   * The shell has crashed. Called before anyone has read the screen: the place to save what the
   * screen promises (the open documents' drafts), since the shell's own autosave went with it.
   */
  readonly onCrash: () => void;
}

/** The boundary around the whole app: the recovery screen instead of a white page. */
export function RootBoundary({ children, onCrash }: RootBoundaryProps) {
  return (
    <ErrorBoundary onCatch={onCrash} fallback={(error) => <RecoveryScreen error={error} />}>
      {children}
    </ErrorBoundary>
  );
}
