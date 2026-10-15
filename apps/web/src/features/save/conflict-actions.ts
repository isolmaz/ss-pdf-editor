/**
 * The file-changed question: an in-place Save found the file on disk is not the one this editor
 * last saw (`saveDocument`), and asks whether to overwrite it, save as a new file, or leave it.
 * These are the answers the dialog's buttons give.
 */

import type { SessionStore } from 'pdf-model';
import { saveAndClose } from './close-actions';
import type { SaveOptions } from './save-actions';
import { conflictResolved, saveStore } from './save-store';

/** What the answers run on. */
export interface ConflictAnswerHost {
  readonly session: SessionStore;
  readonly discardTab: (id: string) => void;
  readonly saveActive: (tabId: string, options?: SaveOptions) => Promise<boolean>;
}

/** "Cancel": the file stays as it is, and so does the document. */
export function keepFile(): void {
  conflictResolved();
}

/**
 * "Overwrite" (`{ overwrite: true }`) or "Save as" (`{ saveAs: true }`): the question is answered
 * and the save runs again accordingly. When the question came up under "Save and close", the
 * document closes once this save has left it clean, exactly as the first attempt would have.
 */
export async function saveAfterConflict(
  host: ConflictAnswerHost,
  tabId: string,
  options: SaveOptions,
): Promise<void> {
  conflictResolved();
  const saveWith = (id: string) => host.saveActive(id, options);
  if (saveStore.get().closeRequest === tabId) {
    await saveAndClose({ session: host.session, discardTab: host.discardTab, saveActive: saveWith }, tabId);
  } else {
    await saveWith(tabId);
  }
}
