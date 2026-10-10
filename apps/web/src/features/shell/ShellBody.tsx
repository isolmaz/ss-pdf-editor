/**
 * The area between the header and the status bar: the home screen, or the editor (docks, tool
 * rail, canvas), with the dialogs and the status overlay that mount beside either.
 *
 * The editor layout is its own chunk (`editor.ts`). It is requested as soon as a document is
 * opening and the home screen stands in until it has arrived, under the same "document opening"
 * overlay the shell already shows while a file is read, so the switch never paints an empty frame.
 */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import type { Command } from 'pdf-ui';
import type { OpRunResult } from 'pdf-ui/ui';
import { useEffect, useMemo } from 'react';
import { STANDALONE_COMMAND_IDS } from '../../commands';
import { ActivityOverlay } from '../../components/ActivityOverlay';
import { HomeScreen } from '../../components/HomeScreen';
import type { RecentDocumentItem } from '../../recent';
import { clearNotice, useCore } from '../core/core-store';
import { BatchDialogHost, StartDialogHost } from '../dialogs/DialogSurfaces';
import { openBatchDialog } from '../dialogs/dialogs-store';
import { useOpen } from '../open/open-store';
import { requestCancel } from '../pages/page-actions';
import { ScanDialogHost } from '../results/ResultsSurfaces';
import type { ResultsActions } from '../results/results-actions';
import { openScanDialog, useResults } from '../results/results-store';
import type { DocumentDockProps } from './DocumentDock';
import { requestEditor, useEditorSurfaces } from './editor-store';
import type { RightDockProps } from './RightDock';
import type { ShellActions } from './shell-actions';
import { openPalette } from './shell-store';
import { useEditState } from './use-edit-state';
import type { ViewerAreaProps } from './ViewerArea';

export interface ShellBodyProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly commands: readonly Command[];
  readonly runHomeCommand: (commandId: string) => void;
  readonly dialogContext: RightDockProps['dialogContext'];
  readonly home: {
    readonly openFilesFromSurface: (files: readonly File[]) => Promise<void>;
    readonly openViaPicker: ShellActions['openViaPicker'];
    readonly openStart: (id: string) => void;
    readonly selectRecent: (item: RecentDocumentItem) => void;
  };
  readonly dock: DocumentDockProps['actions'];
  readonly viewer: ViewerAreaProps['actions'];
  readonly right: RightDockProps['actions'];
  readonly results: Pick<ResultsActions, 'printProduced' | 'scanDocument'>;
  readonly startResult: (result: OpRunResult) => Promise<void>;
}

export function ShellBody(props: ShellBodyProps) {
  const { session, tier, t, commands, results } = props;
  const { activeTab, tabs, isHome } = useEditState(session, tier);
  const editor = useEditorSurfaces();
  const busy = useCore((state) => state.busy);
  const notice = useCore((state) => state.notice);
  const opening = useOpen((state) => state.opening);
  const progress = useResults((state) => state.progress);
  const openIds = useMemo(() => new Set(tabs.map((tab) => tab.id)), [tabs]);
  const wantsEditor = opening || activeTab !== null;
  useEffect(() => {
    if (wantsEditor) requestEditor(t);
  }, [wantsEditor, t]);
  // A document is open and its handle is ready, but the editor chunk is still on its way.
  const editorPending = !isHome && editor === null;
  return (
    <main className="relative min-h-0 flex-1">
      {isHome || activeTab === null || editor === null ? (
        <HomeScreen
          t={t}
          onOpenFiles={(files) => void props.home.openFilesFromSurface(files)}
          onOpenPicker={() => void props.home.openViaPicker()}
          onStart={(action) => {
            if (action === 'batch') openBatchDialog();
            else if (action === 'scan') openScanDialog();
            else
              props.home.openStart(
                action === 'blank'
                  ? 'new-document'
                  : action === 'images'
                    ? 'images-to-pdf'
                    : action === 'convert'
                      ? 'convert-to-pdf'
                      : 'merge-files',
              );
          }}
          // The grid is the discovery surface named 'all tools': it lists every tool in either
          // mode (the simple mode filters the menus and the palette, it never disables).
          commands={commands}
          standaloneCommands={STANDALONE_COMMAND_IDS}
          onRunCommand={props.runHomeCommand}
          activeDocumentName={activeTab === null ? null : activeTab.name}
          openIds={openIds}
          onSelectRecent={props.home.selectRecent}
          onOpenPalette={openPalette}
          busy={busy}
        />
      ) : (
        <editor.EditorSurface
          session={session}
          tier={tier}
          t={t}
          dialogContext={props.dialogContext}
          dock={props.dock}
          viewer={props.viewer}
          right={props.right}
          results={results}
        />
      )}
      {/* Mounted outside the home/editor split: the batch dialog starts from files on disk, so it
          has to open with no document too. Each host mounts only while its dialog is open: a
          static import here is what put Kumo's dialog primitives on the first-paint graph, and a
          `lazy` boundary that is mounted unconditionally still fetches immediately. */}
      <StartDialogHost t={t} onResult={props.startResult} />
      <ScanDialogHost t={t} onDocument={results.scanDocument} />
      <BatchDialogHost t={t} />
      <ActivityOverlay
        t={t}
        notice={notice}
        onDismiss={clearNotice}
        progress={progress}
        onCancel={() => requestCancel({ t })}
        activity={opening || editorPending ? t('open.progress') : null}
      />
    </main>
  );
}
