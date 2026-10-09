/**
 * The marks a tab can edit: its pending overlay with the marks the file already carries taken
 * out, so a mark that was written into the bytes is not also drawn from the session.
 */

import type { SessionTab } from 'pdf-model';
import { useMemo } from 'react';
import { normalizePendingMarks } from '../../annotation-interaction';
import { type PendingOverlays, pendingOverlays } from '../../operations';
import { type ExistingInventory, existingAnnotationsOf, formsStore, useForms } from '../forms/forms-store';

function editableIn(inventory: ExistingInventory | null, tab: SessionTab): PendingOverlays {
  const stored = pendingOverlays(tab);
  const existing = existingAnnotationsOf(inventory, tab);
  if (existing === null) return stored;
  const normalized = normalizePendingMarks(stored, existing);
  return normalized === stored ? stored : { ...stored, ...normalized };
}

/** `tab`'s pending overlay as the file's own annotation inventory, read now, leaves it. */
export function editableOverlays(tab: SessionTab): PendingOverlays {
  return editableIn(formsStore.get().existingInventory, tab);
}

/** The marks the page draws for `tab`: what `editableOverlays` says, again whenever the inventory changes. */
export function useVisibleMarks(tab: SessionTab | null): PendingOverlays {
  const inventory = useForms((state) => state.existingInventory);
  return useMemo(() => (tab === null ? pendingOverlays(null) : editableIn(inventory, tab)), [tab, inventory]);
}
