/**
 * The annotation marks of the active tab. They are session state, not engine state: the engine
 * owns the gesture for the four types it has an editor for, and the mark it produces is taken
 * over (`engine-takeover.ts`) so the journal, the comment panel and the writer all see the same
 * list. The list is the tab's pending overlay; every change is one undoable journal step.
 */

import type { AnnotationMark } from 'pdf-core';
import type { SessionStore } from 'pdf-model';
import { useCallback, useSyncExternalStore } from 'react';
import { annotationStepLabel } from '../../annotation-interaction';
import { pendingOverlays } from '../../operations';
import { type OverlayChange, writeOverlay } from '../core/overlays';

/** Replace the active tab's annotation marks (a new list, or a function of the current one). */
export function writeAnnotations(
  session: SessionStore,
  change: OverlayChange<readonly AnnotationMark[]>,
): void {
  writeOverlay(session, 'annotations', change, annotationStepLabel);
}

/** The active tab's annotation marks, re-read whenever the session changes, and the way to change them. */
export function useAnnotationMarks(session: SessionStore) {
  useSyncExternalStore(session.subscribe, session.getSnapshot);
  const setAnnotations = useCallback(
    (change: OverlayChange<readonly AnnotationMark[]>) => writeAnnotations(session, change),
    [session],
  );
  return { annotations: pendingOverlays(session.active).annotations, setAnnotations };
}
