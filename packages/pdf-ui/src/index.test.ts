/**
 * The dialog surface is one list. The `./dialog` subpath (`dialogs/DialogSurface.tsx`) and the
 * root barrel used to name their dialogs separately (four on the root, twelve on the subpath),
 * so a dialog added to one was missing from the other. The root now re-exports the subpath's
 * module whole.
 */

import { describe, expect, it } from 'vitest';
import * as dialogSurface from './dialogs/DialogSurface';
import * as root from './index';

describe('the dialog surface', () => {
  it('names every dialog and stamp helper of the ./dialog subpath, and the root barrel carries the same ones', () => {
    const names = Object.keys(dialogSurface).sort();
    expect(names).toEqual([
      'BatchDialog',
      'CloseDocumentDialog',
      'ExportDialog',
      'OperationForm',
      'OperationReportPanel',
      'PasswordDialog',
      'SaveConflictDialog',
      'SettingsDialog',
      'ShortcutsDialog',
      'SignatureDialog',
      'SignatureWarningDialog',
      'StartDialog',
      'XfaFormDialog',
      'bytesOfDataUrl',
      'imageFromFile',
    ]);
    const rootExports = root as Record<string, unknown>;
    const surface = dialogSurface as Record<string, unknown>;
    for (const name of names) expect(rootExports[name], name).toBe(surface[name]);
  });
});
