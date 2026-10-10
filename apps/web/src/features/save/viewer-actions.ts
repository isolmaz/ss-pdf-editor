/**
 * What the viewer's reports mean to the session: its API arriving for a document, and the
 * engine's own form values and annotations changing under it.
 */

import { readAnnotations } from 'pdf-core/ops/annotations';
import type { JsonValue, SessionStore } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { engineValuesNotices, failureNotices, noticeLine } from '../../notices';
import { pendingOverlays } from '../../operations';
import { heldEngineValues, releaseEngineValues } from '../annotations/annotations-store';
import { showNotice, showNoticeIfEmpty } from '../core/core-store';
import { handleFor, handleInUse } from '../core/handles';
import { existingInventoryRead, existingInventoryUnknown } from '../forms/forms-store';
import { currentViewer, viewerChanged, zoomChanged } from './save-store';

/** What the shell still holds that the viewer's reports run on. */
export interface ViewerHost {
  readonly session: SessionStore;
  readonly t: Translator;
  /** Take over the marks the engine's own annotation editor produced for `api`. */
  readonly takeEngineAnnotations: (api: ViewerApi) => unknown;
}

/**
 * The viewer handed back its imperative API (once per document), or `null` as it went away.
 *
 * Marks the engine's own annotation editor produced are taken over here. The engine holds them
 * in its storage, where the next `saveDocument()` would write them. The app needs them in its
 * own list first — the journal, the comment panel and the retag step all read that list — so
 * each captured entry becomes a mark and its storage entry is removed. Leaving it would make
 * the same annotation arrive twice: once from the storage and once from the writer.
 */
export function viewerReady(host: ViewerHost, api: ViewerApi | null): void {
  const { session, t, takeEngineAnnotations } = host;
  viewerChanged(api);
  if (api === null) {
    existingInventoryUnknown();
    return;
  }
  handleInUse(api.document);
  zoomChanged(api.getZoom());
  takeEngineAnnotations(api);
  // Every annotation the file already carries, listed once per document so the
  // comment panel can show the document's own notes beside the new marks.
  const controller = new AbortController();
  const tab = session.active;
  const bytesKey = tab === null ? null : (tab.working.produced?.id ?? 'source');
  void readAnnotations(api.document, { signal: controller.signal })
    .then((found) => {
      // Keyed to the bytes the read describes: a read that lands after a byte
      // operation replaced that version describes a document nobody is looking at,
      // and it is dropped rather than shown.
      if (currentViewer() !== api || tab === null || bytesKey === null) return;
      existingInventoryRead({ tabId: tab.id, bytesKey, annotations: found });
    })
    .catch((error) => {
      if (currentViewer() !== api) return;
      // A failed read is unknown, not an empty document. Keep saved-mark edits
      // unavailable rather than normalizing against an invented empty inventory.
      existingInventoryUnknown();
      const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'pdfjs' });
      showNotice(t(failure.messageKey));
    });
  // A draft that carried engine-side edits applies them as soon as its document is
  // the one on screen; the tab stays dirty until a real save writes them.
  const id = session.active?.id;
  if (id === undefined) return;
  const pending = heldEngineValues(id) ?? pendingOverlays(session.active).engineValues;
  if (pending === undefined) return;
  void api
    .applyEngineValues(pending)
    .then((applied) => {
      if (currentViewer() !== api) return;
      // The staged copy goes only once the engine has taken it: a rejection
      // must leave the entries where a retry can still reach them, and a restore
      // that applied **nothing** is reported with its own count, never in silence.
      releaseEngineValues(id);
      takeEngineAnnotations(api);
      const restoration = noticeLine(
        engineValuesNotices({ applied, carried: pending.entries.length, dropped: pending.dropped }),
        t,
      );
      // A successful byte edit restores the carried form state as part of its
      // redraw. Keep that operation's result; incomplete restoration still wins.
      if (applied < pending.entries.length || pending.dropped > 0) showNotice(restoration);
      else showNoticeIfEmpty(restoration);
    })
    .catch((error) => {
      if (currentViewer() !== api) return;
      // The delta stays staged: it is the only copy of edits the document cannot see.
      showNotice(noticeLine(failureNotices(error, 'error.write-failed.message'), t));
    });
}

/**
 * Fold the engine's live storage — the form values that were typed and the native
 * entries it still holds — into the session's own overlay state.
 *
 * This is the checkpoint every gesture that will later be *undone through the
 * journal* depends on. An overlay step restores the mark state of its own moment,
 * and the engine's storage is not part of any of it: without this, typing into a
 * form field and then undoing a mark edit would reopen the bytes from before the
 * typing and restore the older overlay state — losing a value the user can see.
 * Capturing first puts the value in the step's own `before`, where undo restores it
 * and the viewer re-applies it.
 *
 * Returns whether anything changed, so a caller that only needs the fresh state can
 * tell a real checkpoint from a no-op without reading the store again.
 */
export async function checkpointEngineValues(session: SessionStore): Promise<boolean> {
  const api = currentViewer();
  const tab = session.active;
  if (api === null || tab === null || api.document !== handleFor(tab.id)) return false;
  const engineValues = await api.captureEngineValues();
  if (currentViewer() !== api) return false;
  const latest = session.getSnapshot().tabs.find((item) => item.id === tab.id);
  if (
    latest === undefined ||
    session.active?.id !== tab.id ||
    handleFor(tab.id) !== api.document ||
    latest.working.produced?.id !== tab.working.produced?.id
  )
    return false;
  const overlays = pendingOverlays(latest);
  const previous = overlays.engineValues ?? { entries: [], dropped: 0 };
  if (JSON.stringify(previous) === JSON.stringify(engineValues)) return false;
  // Each keystroke in a form field lands here; a burst of them is one undo step.
  session.setOverlays(tab.id, { ...overlays, engineValues } as unknown as JsonValue, 'ann.engineEdit', {
    coalesceWithinMs: 1500,
  });
  return true;
}

/**
 * A form value or annotation changed in the engine: the tab is dirty until a write
 * succeeds. A change that came from the annotation editor is taken over as a mark
 * at the same moment, because the engine holds it as an editable object and the
 * app needs the geometry in its own model before the next save.
 */
export function markActiveDirty(host: ViewerHost): void {
  const { session, t, takeEngineAnnotations } = host;
  const api = currentViewer();
  const tab = session.active;
  if (api === null || tab === null || api.document !== handleFor(tab.id)) return;
  takeEngineAnnotations(api);
  void checkpointEngineValues(session).catch((error) => {
    const failure = error instanceof ToolError ? error : new ToolError('internal', { engine: 'pdfjs' });
    showNotice(t(failure.messageKey));
  });
}
