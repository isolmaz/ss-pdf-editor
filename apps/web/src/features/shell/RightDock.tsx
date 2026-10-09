/** The right dock: the tools, history, comments, forms, properties and the other panels of the open document. */

import type { OperationContext } from 'pdf-core/ops/types';
import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { markTargetKey } from 'pdf-ui/tools';
import {
  Dock,
  HistoryPanel,
  type OperationRunContext,
  type OpRunResult,
  ToolsRailPanel,
  useLocale,
} from 'pdf-ui/ui';
import { lazy, Suspense } from 'react';
import { SIMPLE_MODE_RAIL_GROUPS } from '../../commands';
import type { PageAction } from '../../operations';
import { useAnnotationMarks } from '../annotations/annotation-marks';
import type { AnnotationActions } from '../annotations/use-annotation-actions';
import type { AttachmentActions } from '../attachments/attachments';
import { CommentsDock } from '../comments/CommentsDock';
import type { CommentReview } from '../comments/review';
import { hideRightDock, selectRightTab, selectTool, showNotice, useCore } from '../core/core-store';
import { dismissOperationDialog, useDialogs } from '../dialogs/dialogs-store';
import { openExportDialog } from '../export/export-store';
import { PropertiesFacts } from '../facts/PropertiesFacts';
import { RedactionAuditView } from '../facts/RedactionAuditView';
import { FormsPanel } from '../forms/FormsSurface';
import { retryInspection, useExistingAnnotations } from '../forms/forms-store';
import { useMarks } from '../marks/marks-store';
import { useVisibleMarks } from '../marks/overlays';
import { RedactionDock } from '../marks/RedactionSurfaces';
import { useRedactionMarks } from '../marks/redaction';
import { erasedWordsOf } from '../marks/redaction-store';
import type { MarkActions } from '../marks/use-mark-actions';
import { AccessibilityDock, PdfADock } from '../results/ResultsSurfaces';
import type { ResultsActions } from '../results/results-actions';
import { currentViewer, useSave } from '../save/save-store';
import { clearMarkSelection, selectMarks, useSelection } from '../selection/selection-store';
import { clearTextEdit } from '../selection/text-tool-store';
import type { ShellActions } from './shell-actions';
import { openPalette } from './shell-store';
import { useEditState } from './use-edit-state';

/**
 * The comparison panel reads the working bytes, so it rides the dock panels' own boundary
 * rather than the first paint.
 */
const ComparePanel = lazy(async () => {
  const module = await import('pdf-ui/panels');
  return { default: module.ComparePanel };
});

const RIGHT_TABS = [
  { id: 'tools', label: 'shell.menu.tools' },
  { id: 'history', label: 'panel.history' },
  { id: 'comments', label: 'panel.comments' },
  { id: 'forms', label: 'panel.forms' },
  { id: 'properties', label: 'props.title' },
  { id: 'redaction', label: 'panel.redaction' },
  { id: 'redaction-audit', label: 'audit.title' },
  { id: 'compare', label: 'panel.compare' },
  { id: 'accessibility', label: 'panel.accessibility' },
  { id: 'pdfa', label: 'panel.pdfa' },
] as const;

export interface RightDockProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  /** What an operation dialog runs against; frozen when it opened. */
  readonly dialogContext: OperationRunContext | null;
  readonly actions: Pick<
    ShellActions,
    'openDialog' | 'runPageAction' | 'stepHistoryNow' | 'startFormDetect'
  > & {
    readonly abortOperation: () => void;
    readonly refuseBusy: () => void;
    readonly dialogResult: (result: OpRunResult) => Promise<void>;
    readonly removeTargets: MarkActions['removeTargets'];
    readonly annotationData: Pick<AnnotationActions, 'exportAnnotationData' | 'importAnnotationData'>;
    readonly commentReview: CommentReview;
    readonly attachments: AttachmentActions;
    readonly results: Pick<ResultsActions, 'applyAccessibility'>;
    readonly currentBytes: (operation: OperationContext) => Promise<Uint8Array>;
    readonly applyFormDetect: () => void;
    readonly fillField: (name: string, value: string | boolean) => void;
  };
}

export function RightDock({ session, tier, t, dialogContext, actions }: RightDockProps) {
  const { locale } = useLocale();
  const { activeTab, canEdit, locked } = useEditState(session, tier);
  const rightDock = useCore((state) => state.rightDock);
  const rightTab = useCore((state) => state.rightTab);
  const compactViewport = useCore((state) => state.compactViewport);
  const mode = useCore((state) => state.mode);
  const busy = useCore((state) => state.busy);
  const dialogSpec = useDialogs((state) => state.dialogSpec);
  const currentPage = useSave((state) => state.currentPage);
  const selectedKeys = useSelection((state) => state.selectedKeys);
  const markTargets = useMarks((state) => state.targets);
  const visibleMarks = useVisibleMarks(activeTab);
  const existingAnnotations = useExistingAnnotations(activeTab);
  const { annotations, setAnnotations } = useAnnotationMarks(session);
  const { redactionMarks } = useRedactionMarks(session);
  if (!rightDock || activeTab === null) return null;
  const goToPage = (pageIndex: number) => currentViewer()?.goToPage(pageIndex);
  return (
    <div className={compactViewport ? 'absolute inset-y-0 end-0 z-40 max-w-full' : 'contents'}>
      <Dock
        t={t}
        side="right"
        tabs={RIGHT_TABS}
        activeId={rightTab}
        onSelect={selectRightTab}
        onToggle={() => hideRightDock()}
        wide={rightTab === 'accessibility'}
      >
        {rightTab === 'tools' ? (
          <ToolsRailPanel
            t={t}
            activeSpec={dialogSpec}
            context={dialogContext}
            onSelectTool={(id) => {
              // Same refusal as the arming half below: the form is not offered on a
              // tab nothing can be written to, and a protected one says why.
              if (id === 'redact' && !canEdit) {
                if (locked) showNotice(t('locked.banner'));
                else if (busy) actions.refuseBusy();
                return;
              }
              actions.openDialog(id);
            }}
            onBackToTools={() => {
              actions.abortOperation();
              dismissOperationDialog();
              // The block selection belongs to exactly one run: leaving it in
              // place would let a later `text-edit` open on a paragraph the
              // user is no longer looking at.
              clearTextEdit();
            }}
            onResult={actions.dialogResult}
            onPageAction={(action) => actions.runPageAction(action as PageAction)}
            onArmTool={(tool) => {
              // The rail emits the redaction tool and the highlighter; anything else is not
              // a canvas tool and must not silently arm one.
              if (tool === 'redact') {
                if (canEdit) selectTool('redact');
                else if (locked) showNotice(t('locked.banner'));
              } else if (tool === 'highlight') selectTool('highlight');
            }}
            onOpenPalette={openPalette}
            onExportModal={openExportDialog}
            visibleGroups={mode === 'simple' ? SIMPLE_MODE_RAIL_GROUPS : undefined}
          />
        ) : rightTab === 'history' ? (
          <HistoryPanel
            t={t}
            entries={activeTab.journal.entries}
            cursor={activeTab.journal.cursor}
            onUndo={() => void actions.stepHistoryNow('undo')}
            onRedo={() => void actions.stepHistoryNow('redo')}
          />
        ) : rightTab === 'comments' ? (
          <CommentsDock
            t={t}
            marks={visibleMarks.annotations}
            existing={existingAnnotations}
            // The panel's rows name marks by id; the selection is one key
            // space, so the highlighted row is derived from the target list
            // rather than by re-spelling a key.
            selectedId={
              markTargets.find(
                (target) => target.family === 'annotation' && selectedKeys.includes(target.key),
              )?.id ?? null
            }
            onSelect={(id) => {
              // The panel toggles: a second click on the selected row
              // reports `null`, which is the empty selection.
              if (id === null) {
                clearMarkSelection();
                return;
              }
              const mark = annotations.find((item) => item.id === id);
              if (mark !== undefined) selectMarks([markTargetKey('annotation', mark.id, mark.pageIndex)]);
            }}
            onGoToPage={goToPage}
            onEdit={(id, contents) =>
              setAnnotations((marks) => marks.map((mark) => (mark.id === id ? { ...mark, contents } : mark)))
            }
            // Panel removal is the same intent as selection Delete: one path,
            // one journal entry, the same undo.
            onRemove={(id) => void actions.removeTargets([markTargetKey('annotation', id, 0)])}
            onClear={() =>
              void actions.removeTargets(
                markTargets.filter((target) => target.family === 'annotation').map((target) => target.key),
              )
            }
            onExportData={(format) => void actions.annotationData.exportAnnotationData(format)}
            onImportData={(file) => void actions.annotationData.importAnnotationData(file)}
            onReply={actions.commentReview.onReply}
            onSetState={actions.commentReview.onSetState}
            onRemoveReply={actions.commentReview.onRemoveReply}
            disabled={!canEdit}
          />
        ) : rightTab === 'properties' ? (
          <PropertiesFacts
            t={t}
            tab={activeTab}
            disabled={!canEdit}
            onRetry={retryInspection}
            onAddAttachments={(files) => void actions.attachments.addToDocument(files)}
            onRemoveAttachment={(name) => void actions.attachments.removeFromDocument(name)}
            onReadAttachment={(name) => void actions.attachments.readOut(name)}
          />
        ) : rightTab === 'redaction-audit' ? (
          <RedactionAuditView store={session} t={t} erasedTerms={erasedWordsOf} />
        ) : rightTab === 'compare' ? (
          <Suspense
            fallback={
              <p aria-busy="true" className="p-2 text-xs text-kumo-subtle">
                {t('panel.compare')}
              </p>
            }
          >
            <ComparePanel
              key={activeTab.working.id}
              t={t}
              // The shell's one route from the session to bytes: a mark drawn a
              // moment ago is part of what is compared.
              readDocument={() => actions.currentBytes({ signal: new AbortController().signal })}
              onGoToPage={goToPage}
              onNotice={showNotice}
              disabled={!canEdit}
            />
          </Suspense>
        ) : rightTab === 'accessibility' ? (
          <AccessibilityDock
            key={activeTab.working.id}
            t={t}
            read={actions.currentBytes}
            language={locale}
            currentPage={currentPage}
            canEdit={canEdit}
            onGoToPage={goToPage}
            onWritten={actions.results.applyAccessibility}
          />
        ) : rightTab === 'pdfa' ? (
          <PdfADock
            key={activeTab.working.id}
            t={t}
            read={actions.currentBytes}
            onConvert={() => actions.openDialog('pdfa')}
          />
        ) : rightTab === 'forms' ? (
          <FormsPanel
            t={t}
            tab={activeTab}
            canEdit={canEdit}
            goToPage={goToPage}
            onDetect={actions.startFormDetect}
            onApply={actions.applyFormDetect}
            onFill={(name, value) => actions.fillField(name, value)}
          />
        ) : (
          <RedactionDock
            t={t}
            marks={redactionMarks}
            canEdit={canEdit}
            removeTargets={actions.removeTargets}
            onApply={() => actions.openDialog('redact')}
          />
        )}
      </Dock>
    </div>
  );
}
