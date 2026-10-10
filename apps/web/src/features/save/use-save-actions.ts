import type { ViewerApi } from 'pdf-ui/viewer';
import { useCallback } from 'react';
import { closeTab as closeTabFor } from './close-actions';
import { exportDocument, type SaveHost } from './save-actions';
import { checkpointEngineValues, markActiveDirty, viewerReady } from './viewer-actions';

/** What the shell still holds that the save and viewer handlers run on. */
export interface SaveActionsDeps extends SaveHost {
  /** Drop a tab and everything kept for it (`discardTab`). */
  readonly discardTab: (id: string) => void;
  /** Take over the marks the engine's own annotation editor produced for `api`. */
  readonly takeEngineAnnotations: (api: ViewerApi) => unknown;
}

export interface SaveActions {
  /** Close a tab, asking first when it holds unsaved work. */
  readonly closeTab: (id: string) => void;
  /** Download the current version of a tab (default: the active one) as a new file. */
  readonly exportActive: (tabId?: string) => Promise<void>;
  /** Fold the engine's live form values into the session's overlays; whether anything changed. */
  readonly checkpointEngineValues: () => Promise<boolean>;
  /** The engine changed a form value or annotation. */
  readonly markActiveDirty: () => void;
  /** The viewer handed back its API for a document (or `null` as it went away). */
  readonly handleViewerReady: (api: ViewerApi | null) => void;
}

/**
 * The save and viewer handlers bound to what the shell holds. Each keeps its own identity
 * rules: the viewer's ready handler in particular changes only with the session, the translator
 * and the annotation takeover, so the viewer is not torn down on every render.
 */
export function useSaveActions(deps: SaveActionsDeps): SaveActions {
  const { session, t, prepareOutput, discardTab, takeEngineAnnotations } = deps;
  const closeTab = useCallback(
    (id: string) => closeTabFor({ session, t, discardTab }, id),
    [session, t, discardTab],
  );
  const exportActive = useCallback(
    (tabId?: string) => exportDocument({ session, t, prepareOutput }, tabId ?? session.active?.id),
    [session, t, prepareOutput],
  );
  const checkpoint = useCallback(() => checkpointEngineValues(session), [session]);
  const markDirty = useCallback(
    () => markActiveDirty({ session, t, takeEngineAnnotations }),
    [session, t, takeEngineAnnotations],
  );
  const handleViewerReady = useCallback(
    (api: ViewerApi | null) => viewerReady({ session, t, takeEngineAnnotations }, api),
    [session, t, takeEngineAnnotations],
  );
  return {
    closeTab,
    exportActive,
    checkpointEngineValues: checkpoint,
    markActiveDirty: markDirty,
    handleViewerReady,
  };
}
