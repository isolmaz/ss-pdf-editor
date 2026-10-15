import type { SessionStore } from 'pdf-model';
import type { DeviceTier } from 'pdf-shared';
import { persistDraft } from './draft-persist';
import { queueVaultWrite } from './persistence-store';

/**
 * Write every open tab's draft now, like the autosave does: under the cross-window vault lock
 * and on the vault's own write queue (after the writes already queued, so it cannot race the
 * debounced one). `persistDraft` writes only a draft this window owns, so a tab another window
 * holds is left alone. The shell's autosave timer dies with a shell
 * that crashed, and the last edits are what the recovery screen promises to bring back.
 *
 * Best effort: a draft the storage refuses leaves the previous one standing, and a recovery
 * screen has nothing better to do with that failure than still offer the reload, so the error
 * is expected control flow here and is not reported.
 */
export async function flushDrafts(session: SessionStore, tier: DeviceTier): Promise<void> {
  try {
    await queueVaultWrite(async () => {
      for (const tab of session.getSnapshot().tabs) await persistDraft(session, tab.id, tier);
    });
  } catch {
    // The previous draft stands; see above.
  }
}
