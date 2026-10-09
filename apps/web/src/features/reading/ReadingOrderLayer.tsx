import { lazy } from 'react';

/**
 * The reading-order boxes belong to the accessibility tags view; they draw what that view
 * published to its store (same module instance as the panel, one chunk) and nothing else.
 * Lazy, like the panel: the first paint carries neither.
 */
export const ReadingOrderLayer = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.ReadingOrderLayer };
});
