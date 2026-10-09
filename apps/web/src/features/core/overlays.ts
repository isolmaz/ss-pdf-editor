/**
 * Marks drawn on the active tab and not yet written into its bytes — redaction rectangles,
 * annotations, measurements — live in the session as the tab's pending overlays
 * (`operations.ts`). Every one of them is written the same way, so there is one writer.
 */

import type { JsonValue, SessionStore } from 'pdf-model';
import type { MessageKey } from 'pdf-shared';
import { type PendingOverlays, pendingOverlays } from '../../operations';

/** The overlay lists the session keeps. */
export type OverlayKey = 'annotations' | 'measures' | 'redactions';

/** A new list, or a function from the current one (so a change cannot go stale). */
export type OverlayChange<T> = T | ((current: T) => T);

/**
 * Replace one overlay list of the active tab, journalled as one undoable step named by `label`
 * (a function of the list before and after, for a step whose name depends on what changed).
 *
 * Nothing is written without an active tab, for the very list that is there, or for one empty
 * list replacing another: those are not edits, and a journal step for them would be an undo
 * that does nothing.
 */
export function writeOverlay<K extends OverlayKey>(
  session: SessionStore,
  key: K,
  change: OverlayChange<PendingOverlays[K]>,
  label: MessageKey | ((before: PendingOverlays[K], after: PendingOverlays[K]) => MessageKey),
): void {
  const tab = session.active;
  if (tab === null) return;
  const overlays = pendingOverlays(tab);
  const current = overlays[key];
  const next = typeof change === 'function' ? change(current) : change;
  if (next === current || (next.length === 0 && current.length === 0)) return;
  session.setOverlays(
    tab.id,
    { ...overlays, [key]: next } as unknown as JsonValue,
    typeof label === 'function' ? label(current, next) : label,
  );
}
