import type { SessionSnapshot, SessionStore } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { storedCopyWarning } from '../../notices';
import { createVaultChannel } from '../../vault-channel';
import { showNotice, showNoticeOnce } from '../core/core-store';
import { announceOpenKeys } from './draft-vault';
import { queueDraftWrite, vaultChannelClosed, vaultChannelOpened } from './persistence-store';

/** How long the document model sits still before its drafts are written. */
const AUTOSAVE_DELAY_MS = 600;

export interface AutosaveHost {
  readonly store: SessionStore;
  /** The tabs as of this render: the trigger. */
  readonly session: SessionSnapshot;
  /** Write one tab's draft (the shell's persistence callback). */
  readonly persist: (tabId: string) => Promise<unknown>;
  /** The translator, read when a failure is worded so a language change does not restart the timer. */
  readonly translator: { readonly current: Translator };
}

/**
 * Immutable byte snapshots are stored once; each draft update writes only model data. A failure
 * is worded on the notice line and never repeated over a notice that already says it: it recurs
 * on every change while the browser's storage stays full.
 */
export function useDraftAutosave({ session, store, persist, translator }: AutosaveHost): void {
  useEffect(() => {
    if (session.tabs.length === 0) return undefined;
    const timer = setTimeout(() => {
      void queueDraftWrite(async () => {
        for (const tab of store.getSnapshot().tabs) await persist(tab.id);
      }).catch((error) => {
        const translate = translator.current;
        if (error instanceof ToolError) {
          showNotice(`${translate(error.messageKey)} ${translate(error.hintKey)}`);
          return;
        }
        // The browser's storage refused the draft: the same sentence an open that could
        // not store its recovery copy shows.
        showNoticeOnce(storedCopyWarning(error, translate));
      });
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session, store, persist, translator]);
}

/**
 * Cross-window vault coordination (`vault-channel.ts`). The effect owns creation and disposal
 * together; a render-owned channel stayed closed after StrictMode's setup → cleanup → setup
 * cycle and crashed the next announcement.
 *
 * Then it tells the other windows which vault keys this one is holding, so their sweeps treat
 * them as live. `session` is the trigger because the set can only change when the document
 * model does — a new tab, a new snapshot, a closed document.
 */
export function useVaultChannel(store: SessionStore, session: SessionSnapshot): void {
  useEffect(() => {
    const owned = createVaultChannel();
    vaultChannelOpened(owned);
    return () => {
      vaultChannelClosed(owned);
      owned.close();
    };
  }, []);
  useEffect(() => {
    void session;
    announceOpenKeys(store);
  }, [session, store]);
}
