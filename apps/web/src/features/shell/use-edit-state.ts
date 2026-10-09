/**
 * What the shell derives from the session for the document on screen: the active tab and its
 * engine handle, the device tier's verdict on it, and whether it may be edited now. Every layout
 * component that needs one of these reads it here, so each re-renders on the change it depends
 * on rather than through the shell.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type SessionStore, type SessionTab, workingPageCount } from 'pdf-model';
import type { DeviceTier, LimitVerdict } from 'pdf-shared';
import { useMemo, useSyncExternalStore } from 'react';
import { useCore } from '../core/core-store';
import { documentVerdict, isEditable } from '../core/document';
import { useDocumentHandle } from '../core/handles';
import { currentFacts, factsStore } from '../facts/facts-store';
import { currentForms, formsStore } from '../forms/forms-store';
import { useOpen } from '../open/open-store';
import { useSave } from '../save/save-store';

export interface EditState {
  readonly activeTab: SessionTab | null;
  readonly activeId: string | null;
  readonly tabs: readonly SessionTab[];
  readonly activeHandle: PdfDocumentHandle | null;
  readonly pageCount: number;
  readonly verdict: LimitVerdict;
  /** Editing is off in viewing mode. */
  readonly viewingOnly: boolean;
  /** The tab is a protected document nothing can be written to. */
  readonly locked: boolean;
  /** Editing is off in viewing mode, while the tab is protected and while an operation runs. */
  readonly canEdit: boolean;
  /** The document's facts and form inventory are read, so a write can be verified. */
  readonly canPrepareWrite: boolean;
  /** No editor is shown: no document, no engine handle yet, or the start screen is asked for. */
  readonly isHome: boolean;
}

/** Starts `listener` on a change of either store the write verdict reads. */
function subscribeInspections(listener: () => void): () => void {
  const stops = [factsStore.subscribe(listener), formsStore.subscribe(listener)];
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * Whether the facts and the form inventory of `tab`'s current version are both read. Only the
 * verdict is subscribed to, not the facts or the inventory themselves: the facts arriving, or the
 * inventory starting to be read, would otherwise re-render every reader of this hook for a
 * verdict that did not change.
 */
function useInspectionsRead(tab: SessionTab | null): boolean {
  return useSyncExternalStore(
    subscribeInspections,
    () => currentFacts(tab) !== null && (currentForms(tab)?.fields ?? null) !== null,
  );
}

export function useEditState(session: SessionStore, tier: DeviceTier): EditState {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeId) ?? null;
  const activeHandle = useDocumentHandle(activeTab?.id ?? null);
  const lockedTabs = useOpen((state) => state.lockedTabs);
  const showHomeScreen = useOpen((state) => state.showHomeScreen);
  const busy = useCore((state) => state.busy);
  const viewerShowsHandle = useSave(
    (state) => activeHandle !== null && state.viewer?.document === activeHandle,
  );
  const inspectionsRead = useInspectionsRead(activeTab);
  const verdict = useMemo(() => documentVerdict(activeTab, tier), [activeTab, tier]);
  const viewingOnly = verdict.kind === 'viewing-only';
  const locked = activeTab !== null && lockedTabs.has(activeTab.id);
  const canEdit = isEditable({
    tab: activeTab,
    handle: activeHandle,
    viewerShowsHandle,
    verdict,
    locked,
    busy,
  });
  return {
    activeTab,
    activeId: snapshot.activeId,
    tabs: snapshot.tabs,
    activeHandle,
    pageCount: activeTab === null ? 0 : workingPageCount(activeTab),
    verdict,
    viewingOnly,
    locked,
    canEdit,
    canPrepareWrite: activeTab !== null && inspectionsRead && !busy,
    isHome: activeTab === null || activeHandle === null || showHomeScreen,
  };
}
