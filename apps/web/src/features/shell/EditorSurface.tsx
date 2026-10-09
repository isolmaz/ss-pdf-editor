/**
 * The editor layout of an open document: the document dock, the tool rail, the canvas, the right
 * dock, the reading layers and the print dialog. It is the lazy half of `ShellBody` and is
 * reached through `editor.ts` (`editor-store.ts` loads it), never imported by the home path.
 */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { useLocale } from 'pdf-ui/ui';
import { ToolRail } from '../../components/ToolRail';
import { showContextMenu } from '../export/export-actions';
import { ReadingLayers } from '../reading/ReadingLayers';
import { PrintDialogHost } from '../results/ResultsSurfaces';
import type { ResultsActions } from '../results/results-actions';
import { useSave, viewerRef } from '../save/save-store';
import { DocumentDock, type DocumentDockProps } from './DocumentDock';
import { RightDock, type RightDockProps } from './RightDock';
import { useEditState } from './use-edit-state';
import { ViewerArea, type ViewerAreaProps } from './ViewerArea';

export interface EditorSurfaceProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly dialogContext: RightDockProps['dialogContext'];
  readonly dock: DocumentDockProps['actions'];
  readonly viewer: ViewerAreaProps['actions'];
  readonly right: RightDockProps['actions'];
  readonly results: Pick<ResultsActions, 'printProduced'>;
}

export function EditorSurface({
  session,
  tier,
  t,
  dialogContext,
  dock,
  viewer,
  right,
  results,
}: EditorSurfaceProps) {
  const { locale } = useLocale();
  const { canEdit } = useEditState(session, tier);
  const handle = useSave((state) => state.viewer);
  const currentPage = useSave((state) => state.currentPage);
  return (
    <div className="flex h-full">
      <DocumentDock session={session} tier={tier} t={t} actions={dock} />
      <ToolRail t={t} canEdit={canEdit} />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: context menu listener on the document canvas container */}
      <div className="relative min-w-0 flex-1 overflow-hidden" onContextMenu={showContextMenu}>
        <ViewerArea session={session} tier={tier} t={t} actions={viewer} />
      </div>
      <RightDock session={session} tier={tier} t={t} dialogContext={dialogContext} actions={right} />
      <ReadingLayers t={t} locale={locale} viewer={handle} viewerRef={viewerRef} pageNumber={currentPage} />
      <PrintDialogHost t={t} viewer={handle} onProduced={results.printProduced} />
    </div>
  );
}
