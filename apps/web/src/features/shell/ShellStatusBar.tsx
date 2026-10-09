/**
 * The status bar. It owns the memory sampler, so the sample every 2.5 s re-renders this bar and
 * nothing around it.
 */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { usePresentation } from 'pdf-ui/tools';
import { StatusBar } from 'pdf-ui/ui';
import { PageNavigation } from '../../components/PageNavigation';
import { useMemorySampler, useMemoryUsage } from '../diagnostics/memory-store';
import { currentViewer, useSave } from '../save/save-store';
import type { ShellActions } from './shell-actions';
import { useEditState } from './use-edit-state';

export interface ShellStatusBarProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly actions: Pick<ShellActions, 'runPageAction'>;
}

export function ShellStatusBar({ session, tier, t, actions }: ShellStatusBarProps) {
  const { activeTab, activeHandle, pageCount, verdict, documentFacts, canEdit, isHome } = useEditState(
    session,
    tier,
  );
  const zoom = useSave((state) => state.zoom);
  const currentPage = useSave((state) => state.currentPage);
  const viewer = useSave((state) => state.viewer);
  const presentation = usePresentation(viewer);
  const memoryUsage = useMemoryUsage();
  useMemorySampler(session, tier);
  return (
    <StatusBar
      t={t}
      pageIndex={activeHandle === null ? null : currentPage}
      pageCount={activeTab === null ? null : pageCount}
      zoom={zoom}
      tier={tier}
      limits={verdict}
      signatures={documentFacts?.signatures ?? []}
      memoryUsage={memoryUsage}
      sensitive={activeTab?.sensitive ?? false}
      navigation={
        isHome || activeTab === null ? undefined : (
          <PageNavigation
            t={t}
            currentPage={currentPage}
            pageCount={pageCount}
            onGoToPage={(pageIndex) => currentViewer()?.goToPage(pageIndex)}
            zoom={zoom}
            onZoomChange={(next) => currentViewer()?.setZoom(next)}
            {...(canEdit
              ? { onRotate: () => actions.runPageAction({ kind: 'rotate', direction: 'right' }) }
              : {})}
            onToggleFullscreen={() => presentation.toggle()}
          />
        )
      }
    />
  );
}
