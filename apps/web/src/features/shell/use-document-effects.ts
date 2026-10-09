/**
 * What follows the document on screen without drawing anything: the window title, the facts and
 * form inventory read from its bytes, the language it declares, the text tool's frozen page model
 * and the mark targets the common layer hit-tests. Mounted once, by the shell.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { SessionStore, SessionTab } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { pendingOverlays } from '../../operations';
import { useAnnotationMarks } from '../annotations/annotation-marks';
import { usePublishExistingAnnotations } from '../annotations/use-annotation-actions';
import { useCore } from '../core/core-store';
import { useStoredTrust } from '../facts/trust-store';
import { useDocumentFacts } from '../facts/use-document-facts';
import { useExistingAnnotations, useForms } from '../forms/forms-store';
import { useFormInventory } from '../forms/use-form-inventory';
import { useMarkTargets } from '../marks/mark-targets';
import { useRedactionMarks } from '../marks/redaction';
import { useDocumentLanguage } from '../reading/use-document-language';
import { useSave } from '../save/save-store';
import { useSelectionEffects } from '../selection/use-selection';
import { useTextToolBytes } from '../selection/use-text-tool-bytes';
import { useEditState } from './use-edit-state';

/** The product name the window carries when no document is open; `index.html`'s `<title>` is the same string. */
export const PRODUCT_TITLE = 'SsPdfEditor';

/**
 * The document names the browser's own surfaces: the printed file, a "Save as…" suggestion and the
 * window itself. The print dialog and the export both take their suggested file name from
 * `document.title`, so it follows the active document (and says so when there are unsaved
 * changes) instead of staying the product name while a contract sits open.
 */
export function documentTitle(tab: SessionTab | null, t: Translator): string {
  return tab === null ? PRODUCT_TITLE : `${tab.name}${tab.dirty ? ` — ${t('tab.dirty')}` : ''}`;
}

export interface DocumentEffectsHost {
  readonly session: SessionStore;
  readonly t: Translator;
  readonly tab: SessionTab | null;
  readonly handle: PdfDocumentHandle | null;
}

export function useDocumentEffects({ session, t, tab, handle }: DocumentEffectsHost): void {
  const viewer = useSave((state) => state.viewer);
  const inspectionRevision = useForms((state) => state.inspectionRevision);
  const canvasTool = useCore((state) => state.canvasTool);
  const { annotations } = useAnnotationMarks(session);
  const { redactionMarks } = useRedactionMarks(session);
  const existing = useExistingAnnotations(tab);

  useDocumentLanguage(viewer);
  // The two layout effects, in this order: the file's annotations are published before the
  // targets derived from them, and both before any passive effect of the commit runs.
  usePublishExistingAnnotations(existing);
  const targets = useMarkTargets({
    annotations,
    measures: pendingOverlays(session.active).measures,
    redactions: redactionMarks,
    existing,
    viewer,
    t,
  });
  useEffect(() => {
    document.title = documentTitle(tab, t);
  }, [tab, t]);
  useFormInventory({ store: session, t, tab, handle });
  useStoredTrust();
  useDocumentFacts({ store: session, t, tab, handle, revision: inspectionRevision });
  useTextToolBytes(session, tab, handle, t);
  useSelectionEffects({
    markMode: canvasTool === 'select' ? 'select' : null,
    tabId: tab?.id,
    existing,
    targets,
  });
}

export interface DocumentEffectsProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
}

/**
 * `useDocumentEffects` in a component of its own, rendering nothing. What these effects follow
 * (the viewer, the inventory revision, the marks, the file's annotations) changes several times
 * while a document opens, and each change would re-render whatever called the hook: called by the
 * shell, that is every layout component under it, for a render that draws nothing new.
 */
export function DocumentEffects({ session, tier, t }: DocumentEffectsProps): null {
  const { activeTab, activeHandle } = useEditState(session, tier);
  useDocumentEffects({ session, t, tab: activeTab, handle: activeHandle });
  return null;
}
