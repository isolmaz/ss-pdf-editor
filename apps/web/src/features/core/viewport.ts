import { useEffect } from 'react';
import { COMPACT_VIEW_QUERY, compactViewportChanged } from './core-store';

/** What `watchCompactViewport` needs of a `MediaQueryList`. */
export type CompactViewportQuery = Pick<
  MediaQueryList,
  'matches' | 'addEventListener' | 'removeEventListener'
>;

/** Report every crossing of the compact breakpoint to the core store; returns the stop function. */
export function watchCompactViewport(media: CompactViewportQuery): () => void {
  const onChange = () => compactViewportChanged(media.matches);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** Keep the core store's `compactViewport` (and, on narrowing, the docks) in step with the window. */
export function useCompactViewport(): void {
  useEffect(() => watchCompactViewport(window.matchMedia(COMPACT_VIEW_QUERY)), []);
}
