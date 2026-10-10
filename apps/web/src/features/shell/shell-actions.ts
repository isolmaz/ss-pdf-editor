/**
 * What the shell's layout components and command host need from the feature hooks `App.tsx`
 * composes. The state they read, they read from the stores; this is only the handlers, which are
 * built from the translator, the session and the document context and so cannot be a store.
 */

import type { Translator } from 'pdf-shared';
import type { FieldValue } from 'pdf-ui';
import type { PageAction } from '../../operations';

export interface ShellActions {
  readonly t: Translator;
  readonly openViaPicker: () => Promise<void>;
  readonly saveActive: (tabId?: string) => Promise<boolean>;
  readonly exportActive: (tabId?: string) => Promise<void>;
  readonly closeTab: (id: string) => void;
  readonly openDialog: (id: string, presets?: Readonly<Record<string, FieldValue>>) => void;
  readonly showShortcuts: () => void;
  readonly runPageAction: (action: PageAction) => void;
  readonly stepHistoryNow: (direction: 'undo' | 'redo') => boolean;
  readonly openPrint: () => void;
  readonly openSnapshotMenu: () => void;
  readonly openXfaForm: () => void;
  readonly startFormDetect: () => void;
  readonly openSignature: () => void;
  readonly pickImage: () => void;
  readonly deleteMarkSelection: () => boolean;
  readonly selectAllMarks: () => boolean;
  readonly toggleSensitiveSession: () => void;
  readonly opfsSave: () => Promise<void>;
  readonly purgeActiveDocument: () => Promise<void>;
  readonly sweepVault: () => Promise<void>;
  readonly checkOffline: () => Promise<void>;
  readonly prepareOfflinePackages: () => Promise<void>;
  /** Switch the interface mode; entering the simple mode also closes a dialog it hides. */
  readonly changeMode: (mode: 'simple' | 'advanced') => void;
}
