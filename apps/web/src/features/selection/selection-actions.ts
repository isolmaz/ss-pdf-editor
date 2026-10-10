/** What the user does with the selection: Delete, Select all, and opening a note. */

import type { AnnotationMark } from 'pdf-core';
import type { SessionStore } from 'pdf-model';
import { markTargetKey } from 'pdf-ui/tools';
import { knownExistingAnnotations, orphanSweepInFlight } from '../annotations/annotations-store';
import { coreStore, isBusy, openRightPanel, selectTool } from '../core/core-store';
import { currentMarkTargets } from '../marks/marks-store';
import { selectedMarkKeys, selectMarks } from './selection-store';

/** What the selection handlers need from the shell: the pieces it still owns. */
export interface SelectionHost {
  readonly session: SessionStore;
  /** The controller of the operation holding the document. */
  readonly cancel: { readonly current: AbortController | null };
  /** Say that the document is busy. */
  readonly refuseBusy: () => void;
  /** Commit native editors; whether the engine still holds entries that must be materialised. */
  readonly settleNativeEditors: () => boolean;
  readonly sweepOrphanAnnotations: () => Promise<void>;
  /** Remove the marks named by the keys: one journal step. `false`: nothing was removed. */
  readonly removeTargets: (keys: readonly string[]) => boolean;
}

/**
 * `Delete` acts on the **whole** common selection — every family at once, and on the marks the
 * user can see rather than on whichever list happens to be first.
 *
 * Recovered native records are adopted first, so a draft's annotation cannot be left outside the
 * journal-owned selection. New gestures are already session marks. `false` means the key was not
 * the shell's to answer, so it is not swallowed.
 */
export function deleteMarkSelection(host: SelectionHost): boolean {
  const keys = selectedMarkKeys();
  if (keys.length === 0) return false;
  if (orphanSweepInFlight() === null && (isBusy() || host.cancel.current !== null)) {
    host.refuseBusy();
    return false;
  }
  if (host.settleNativeEditors()) void host.sweepOrphanAnnotations();
  return host.removeTargets(keys);
}

/**
 * `Ctrl/Cmd+A` selects every mark the common layer can act on. It answers only in the select tool
 * with a document open and marks to select: anywhere else the key belongs to the engine (while
 * one of its tools is armed) or to the page's own text, and the shell declines it instead of
 * stealing it.
 */
export function selectAllMarks(session: SessionStore): boolean {
  if (coreStore.get().canvasTool !== 'select') return false;
  if (session.active === null || knownExistingAnnotations() === null) return false;
  const keys = currentMarkTargets().map((target) => target.key);
  if (keys.length === 0) return false;
  selectMarks(keys);
  return true;
}

/** Opens the note the common layer just created: selected, visible, contents editable. */
export function openNote(mark: AnnotationMark): void {
  selectTool('select');
  selectMarks([markTargetKey('annotation', mark.id, mark.pageIndex)]);
  openRightPanel('comments');
}
