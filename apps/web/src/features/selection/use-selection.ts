/** The selection handlers bound to the shell's host, and the effects that keep the selection honest. */

import type { AnnotationMark, ExistingAnnotation } from 'pdf-core';
import type { MarkTarget } from 'pdf-ui/tools';
import { useEffect, useMemo } from 'react';
import { deleteMarkSelection, openNote, type SelectionHost, selectAllMarks } from './selection-actions';
import { clearMarkSelection, pruneSelection, settlePendingSelection } from './selection-store';

export interface SelectionActions {
  /** Delete the whole selection. `false`: the key was not the shell's to answer. */
  readonly deleteMarkSelection: () => boolean;
  /** Select every mark. `false`: the key was not the shell's to answer. */
  readonly selectAllMarks: () => boolean;
  readonly openNote: (mark: AnnotationMark) => void;
}

/** The handlers, rebuilt only when what they run on changes. */
export function useSelectionActions(host: SelectionHost): SelectionActions {
  const { session, t, settleNativeEditors, sweepOrphanAnnotations, removeTargets } = host;
  return useMemo(() => {
    const bound: SelectionHost = { session, t, settleNativeEditors, sweepOrphanAnnotations, removeTargets };
    return {
      deleteMarkSelection: () => deleteMarkSelection(bound),
      selectAllMarks: () => selectAllMarks(session),
      openNote,
    };
  }, [session, t, settleNativeEditors, sweepOrphanAnnotations, removeTargets]);
}

/**
 * A selection never outlives what it names. **Leaving the common layer's modes** clears it
 * outright — a selection made with the select tool has no meaning under a highlighter, and the
 * strip must not offer to delete marks the user is not looking at — and changing the document
 * clears it too, because one document's marks are not another's. A selection that survives into
 * a new walking version keeps only the keys that are still there: a removal removes its own
 * keys, an undo can bring others back.
 *
 * Entering the modes is deliberately *not* a clear: the note tool selects the note it just made
 * as it returns to `select`, and that selection is the point. A mark a write just added is
 * selected as soon as the re-read inventory lists it.
 */
export function useSelectionEffects({
  markMode,
  tabId,
  existing,
  targets,
}: {
  /** `null` whenever no tool of the common layer's own is armed. */
  readonly markMode: 'select' | null;
  readonly tabId: string | undefined;
  readonly existing: readonly ExistingAnnotation[] | null;
  readonly targets: readonly MarkTarget[];
}): void {
  useEffect(() => settlePendingSelection(targets), [targets]);

  useEffect(() => {
    if (markMode === null) clearMarkSelection();
  }, [markMode]);

  useEffect(() => {
    if (tabId === undefined) return;
    clearMarkSelection();
  }, [tabId]);

  useEffect(() => {
    // A byte rewrite temporarily has no inventory. That is not evidence that the selected
    // objects disappeared; prune only once their replacement was read.
    if (existing === null) return;
    pruneSelection(targets);
  }, [existing, targets]);
}
