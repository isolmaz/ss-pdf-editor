/**
 * The organize grid over the editor area (`page.organize`). The view itself is pdf-ui's
 * `OrganizeView`, fetched when it is first asked for; this is the part that knows the shell:
 * the selection and the page on screen, the viewer, and the page actions that journal a change.
 */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { lazy, Suspense, useEffect } from 'react';
import { closeOrganize, useCore } from '../core/core-store';
import { useDialogs } from '../dialogs/dialogs-store';
import { useVisibleMarks } from '../marks/overlays';
import { selectPages, useOpen } from '../open/open-store';
import { currentViewer, useSave } from '../save/save-store';
import { PanelBoundary } from '../shell/SurfaceBoundaries';
import type { ShellActions } from '../shell/shell-actions';
import { useEditState } from '../shell/use-edit-state';

const OrganizeView = lazy(async () => {
  const module = await import('pdf-ui/organize');
  return { default: module.OrganizeView };
});

export interface OrganizeSurfaceProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly actions: Pick<ShellActions, 'runPageAction' | 'openDialog'>;
}

export function OrganizeSurface({ session, tier, t, actions }: OrganizeSurfaceProps) {
  const { activeTab, activeId, activeHandle, canEdit } = useEditState(session, tier);
  const open = useCore((state) => state.organize);
  const currentPage = useSave((state) => state.currentPage);
  const selectedPages = useOpen((state) => state.selectedPages);
  const dialogOpen = useDialogs((state) => state.dialogSpec !== null);
  const visibleMarks = useVisibleMarks(activeTab);
  // The grid belongs to one document: another tab, or the start screen, takes it away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab id is the trigger; the cleanup closes
  useEffect(() => closeOrganize, [activeId]);
  // A form opens in the right dock, which the grid covers.
  useEffect(() => {
    if (dialogOpen) closeOrganize();
  }, [dialogOpen]);
  if (!open || activeTab === null || activeHandle === null) return null;
  return (
    <PanelBoundary t={t}>
      <Suspense
        fallback={
          <p aria-busy="true" className="sr-only">
            {t('tools.group.pages')}
          </p>
        }
      >
        <OrganizeView
          document={activeHandle}
          t={t}
          currentPage={currentPage}
          selectedPages={selectedPages}
          onSelectionChange={selectPages}
          onGoToPage={(pageIndex) => currentViewer()?.goToPage(pageIndex)}
          onPageAction={actions.runPageAction}
          onClose={closeOrganize}
          editing={canEdit}
          onExtract={() => actions.openDialog('extract-pages')}
          onInsert={() => actions.openDialog('insert-pages')}
          version={activeTab.working.stateId}
          marks={visibleMarks.annotations}
        />
      </Suspense>
    </PanelBoundary>
  );
}
