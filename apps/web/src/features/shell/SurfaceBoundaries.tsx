/**
 * The narrow error boundaries of the editor layout. A panel or a mark layer that arrives through
 * a lazy chunk can fail to load (offline, a release that replaced the file) without the editor
 * around it being any less usable, so it is contained here instead of reaching the root
 * recovery screen (`recovery.tsx`), which takes the whole app away.
 */

import type { Translator } from 'pdf-shared';
import type { ReactNode } from 'react';
import { ErrorBoundary, failureText } from '../../recovery';
import { showNotice } from '../core/core-store';

export interface SurfaceBoundaryProps {
  readonly t: Translator;
  readonly children: ReactNode;
}

/**
 * Around the dock's panel. The failure is said in the panel's place, with the tabs still
 * there; the caller keys it by the tab, so another tab starts clean.
 */
export function PanelBoundary({ t, children }: SurfaceBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(error) => (
        <p role="alert" className="p-2 text-xs text-kumo-danger">
          {failureText(error, t)}
        </p>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Around a layer over the pages (the ruler, the text blocks, the reading-order boxes). It draws
 * nothing once it has failed, and the notice line says why.
 */
export function LayerBoundary({ t, children }: SurfaceBoundaryProps) {
  return (
    <ErrorBoundary fallback={() => null} onCatch={(error) => showNotice(failureText(error, t))}>
      {children}
    </ErrorBoundary>
  );
}
