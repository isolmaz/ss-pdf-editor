import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { useMemo } from 'react';
import { toggleSensitiveSession } from './draft-persist';
import { purgeActiveDocument, sweepVault } from './draft-vault';
import { checkOffline, prepareOfflinePackages } from './offline-actions';

export interface PersistenceActions {
  /** Flip the active document's sensitive-session opt-out, removing what was stored when it turns on. */
  readonly toggleSensitiveSession: () => void;
  /** Forget the active document: its manifest, its blobs and the handle that reopens its file. */
  readonly purgeActiveDocument: () => Promise<void>;
  /** Delete the vault blobs no document references any more. */
  readonly sweepVault: () => Promise<void>;
  /** Say what the service worker's cache holds for this build. */
  readonly checkOffline: () => Promise<void>;
  /** Fill the cache for the capabilities core editing needs. */
  readonly prepareOfflinePackages: () => Promise<void>;
}

/** The persistence commands bound to the shell's session and translator. */
export function usePersistenceActions(session: SessionStore, t: Translator): PersistenceActions {
  return useMemo(
    () => ({
      toggleSensitiveSession: () => toggleSensitiveSession(session, t),
      purgeActiveDocument: () => purgeActiveDocument(session, t),
      sweepVault: () => sweepVault(session, t),
      checkOffline: () => checkOffline(t),
      prepareOfflinePackages: () => prepareOfflinePackages(t),
    }),
    [session, t],
  );
}
