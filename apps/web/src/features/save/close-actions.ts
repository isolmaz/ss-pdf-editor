/**
 * Closing a document: the discard that ends it, the question asked first when it holds unsaved
 * work, and the answers the question's buttons give.
 */

import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { hasEngineEdits } from '../../operations';
import { releaseEngineValues } from '../annotations/annotations-store';
import { clearNotice, isBusy, showNotice } from '../core/core-store';
import { dropHandle, handleFor } from '../core/handles';
import { dialogsStore } from '../dialogs/dialogs-store';
import { redactedWordsForgotten } from '../marks/redaction-store';
import { draftWrites } from '../persistence/persistence-store';
import { closeDismissed, closeRequested, saveStore } from './save-store';

/** What the shell still holds that closing a tab runs on. */
export interface CloseHost {
  readonly session: SessionStore;
  /** The running operation's controller. */
  readonly cancelRef: { current: AbortController | null };
  /** The translator, read when a notice is worded so a language change in between is honoured. */
  readonly translator: { readonly current: Translator };
  /** Delete what the vault keeps for `tabId`; `null` means the inventory was incomplete and nothing was deleted. */
  readonly forgetTabDraft: (tabId: string) => Promise<readonly string[] | null>;
}

/** Drop `id` from the session and everything the shell keeps for it, whatever it holds unsaved. */
export function discardDocument(host: CloseHost, id: string): void {
  const { session, cancelRef, translator, forgetTabDraft } = host;
  if (session.active?.id === id) cancelRef.current?.abort();
  const abandoned = dropHandle(id);
  if (abandoned !== undefined) {
    // Closing a tab is not a place where a failure may be swallowed, and it
    // is not a place where one may be thrown at the user either: the document is
    // gone from the session, so the release is reported and the close proceeds.
    void abandoned.destroy().catch(() => showNotice(translator.current('notice.engineReleaseFailed')));
  }
  session.closeTab(id);
  releaseEngineValues(id);
  redactedWordsForgotten(id);
  draftWrites.current = draftWrites.current
    .then(async () => {
      // The reference graph is read fresh and *whole*: the previous version derived it
      // from `readDrafts()`, which reports an unreadable or unlistable vault as “no
      // drafts” — the exact input that makes a shared source blob look unreferenced.
      // An incomplete inventory deletes nothing and says so.
      const removed = await forgetTabDraft(id);
      if (removed === null) showNotice(translator.current('vault.incomplete'));
    })
    .catch(() => showNotice(translator.current('error.write-failed.message')));
}

/**
 * Close `id`: at once when it holds nothing unsaved, otherwise by asking first. The question
 * remembers what had the focus so closing it can give the focus back.
 */
export function closeTab(
  host: Pick<CloseHost, 'session' | 'cancelRef'> & {
    readonly refuseBusy: () => void;
    readonly discardTab: (id: string) => void;
  },
  id: string,
): void {
  const { session, cancelRef, refuseBusy, discardTab } = host;
  if (isBusy() || cancelRef.current !== null || dialogsStore.get().dialogSpec !== null) {
    refuseBusy();
    return;
  }
  const tab = session.getSnapshot().tabs.find((item) => item.id === id);
  if (tab === undefined) return;
  const handle = handleFor(id);
  if (tab.dirty || (handle !== undefined && hasEngineEdits(handle))) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    session.setActive(id);
    clearNotice();
    closeRequested(id, trigger);
    return;
  }
  discardTab(id);
}

/** End the close question and give the focus back to what had it, or to the open document. */
export function cancelClose(): void {
  closeDismissed();
  requestAnimationFrame(() => {
    const target = saveStore.get().closeTrigger;
    if (target?.isConnected) target.focus();
    else
      document.querySelector<HTMLElement>('[data-document-tab][aria-current="true"], main button')?.focus();
  });
}

/** What the close question's buttons run on. */
export interface CloseAnswerHost {
  readonly session: SessionStore;
  readonly cancelRef: { current: AbortController | null };
  readonly discardTab: (id: string) => void;
  readonly saveActive: (tabId: string) => Promise<boolean>;
}

/** "Cancel": stop what is running for the question and keep the document open. */
export function keepOpen(host: Pick<CloseAnswerHost, 'cancelRef'>): void {
  host.cancelRef.current?.abort();
  cancelClose();
}

/** "Discard": close `id` without saving, unless an operation is running. */
export function discardAndClose(host: Pick<CloseAnswerHost, 'discardTab'>, id: string): void {
  if (!isBusy()) {
    host.discardTab(id);
    cancelClose();
  }
}

/** "Save and close": close `id` once the save has left it clean. A refused or failed save keeps it open. */
export async function saveAndClose(host: CloseAnswerHost, id: string): Promise<void> {
  const saved = await host.saveActive(id);
  const tab = host.session.getSnapshot().tabs.find((item) => item.id === id);
  if (saved && tab !== undefined && !tab.dirty) {
    host.discardTab(id);
    cancelClose();
  }
}
