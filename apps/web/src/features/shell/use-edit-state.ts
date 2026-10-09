/**
 * What the shell derives from the session for the document on screen: the active tab and its
 * engine handle, the device tier's verdict on it, and whether it may be edited now. Every layout
 * component that needs one of these reads it here, so each re-renders on the change it depends
 * on rather than through the shell.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type SessionStore, type SessionTab, workingPageCount } from 'pdf-model';
import { checkDocumentLimits, type DeviceTier, type LimitVerdict } from 'pdf-shared';
import { useMemo, useSyncExternalStore } from 'react';
import { useCore } from '../core/core-store';
import { useDocumentHandle } from '../core/handles';
import { type DocumentFacts, useCurrentFacts } from '../facts/facts-store';
import { useCurrentForms } from '../forms/forms-store';
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
  readonly documentFacts: DocumentFacts | null;
  /** No editor is shown: no document, no engine handle yet, or the start screen is asked for. */
  readonly isHome: boolean;
}

export function useEditState(session: SessionStore, tier: DeviceTier): EditState {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeId) ?? null;
  const activeHandle = useDocumentHandle(activeTab?.id ?? null);
  const lockedTabs = useOpen((state) => state.lockedTabs);
  const showHomeScreen = useOpen((state) => state.showHomeScreen);
  const busy = useCore((state) => state.busy);
  const viewer = useSave((state) => state.viewer);
  const documentFacts = useCurrentFacts(activeTab);
  const formFields = useCurrentForms(activeTab)?.fields ?? null;
  const verdict = useMemo(() => {
    if (activeTab === null) return checkDocumentLimits(tier, 0, 0);
    const currentBytes = activeTab.working.produced?.bytes.byteLength ?? activeTab.source.size;
    return checkDocumentLimits(tier, workingPageCount(activeTab), currentBytes);
  }, [activeTab, tier]);
  const viewingOnly = verdict.kind === 'viewing-only';
  const locked = activeTab !== null && lockedTabs.has(activeTab.id);
  const canEdit =
    activeTab !== null &&
    activeHandle !== null &&
    viewer?.document === activeHandle &&
    !viewingOnly &&
    !locked &&
    !busy;
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
    canPrepareWrite: activeTab !== null && documentFacts !== null && formFields !== null && !busy,
    documentFacts,
    isHome: activeTab === null || activeHandle === null || showHomeScreen,
  };
}
