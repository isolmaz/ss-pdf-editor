/** The left dock: the page thumbnails, outline, search, layers and attachments of the open document. */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { DocumentPanel } from 'pdf-ui/ui';
import { SIMPLE_MODE_DOCK_TABS } from '../../commands';
import type { AttachmentActions } from '../attachments/attachments';
import { hideLeftDock, selectLeftTab, showNotice, useCore } from '../core/core-store';
import { useVisibleMarks } from '../marks/overlays';
import type { WriterActions } from '../marks/use-mark-actions';
import { selectPages, useOpen } from '../open/open-store';
import { currentViewer, useSave } from '../save/save-store';
import type { ShellActions } from './shell-actions';
import { useEditState } from './use-edit-state';

export interface DocumentDockProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly actions: Pick<ShellActions, 'runPageAction' | 'openDialog'> & {
    readonly writeLayers: WriterActions['writeLayers'];
    readonly attachments: AttachmentActions;
  };
}

export function DocumentDock({ session, tier, t, actions }: DocumentDockProps) {
  const { activeTab, activeHandle, canEdit } = useEditState(session, tier);
  const leftDock = useCore((state) => state.leftDock);
  const compactViewport = useCore((state) => state.compactViewport);
  const leftTab = useCore((state) => state.leftTab);
  const mode = useCore((state) => state.mode);
  const currentPage = useSave((state) => state.currentPage);
  const selectedPages = useOpen((state) => state.selectedPages);
  const visibleMarks = useVisibleMarks(activeTab);
  if (!leftDock || activeTab === null || activeHandle === null) return null;
  return (
    <div className={compactViewport ? 'absolute inset-y-0 start-0 z-40 max-w-full' : 'contents'}>
      <DocumentPanel
        onToggle={() => hideLeftDock()}
        document={activeHandle}
        t={t}
        currentPage={currentPage}
        selectedPages={selectedPages}
        onSelectionChange={selectPages}
        onPageAction={actions.runPageAction}
        editing={canEdit}
        version={activeTab.working.stateId}
        marks={visibleMarks.annotations}
        onGoToPage={(pageIndex) => currentViewer()?.goToPage(pageIndex)}
        onNotice={showNotice}
        onHighlightQuery={(query) => currentViewer()?.find(query)}
        onLayersChanged={() => void currentViewer()?.refreshOptionalContent()}
        onExtract={() => actions.openDialog('extract-pages')}
        onEditOutline={() => actions.openDialog('outline-edit')}
        onWriteLayers={(request) => void actions.writeLayers(request)}
        onAddAttachments={(files) => void actions.attachments.write({ add: files })}
        onRemoveAttachments={(names) => void actions.attachments.write({ remove: names })}
        visibleTabs={mode === 'simple' ? SIMPLE_MODE_DOCK_TABS : undefined}
        tab={leftTab}
        onTabChange={selectLeftTab}
      />
    </div>
  );
}
