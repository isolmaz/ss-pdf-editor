import { describe, expect, it } from 'vitest';
import { DIALOG_IDS, dialogById, hasDialog, isStandaloneDialog } from './index';

describe('the operation dialog registry', () => {
  it('loads, for every registered id, the spec that carries that id', async () => {
    expect(DIALOG_IDS.length).toBeGreaterThan(30);
    for (const id of DIALOG_IDS) {
      const spec = await dialogById(id);
      expect(spec?.id, id).toBe(id);
      expect(hasDialog(id)).toBe(true);
    }
  });

  it('answers undefined for an id nothing registered', async () => {
    expect(hasDialog('no-such-dialog')).toBe(false);
    expect(await dialogById('no-such-dialog')).toBeUndefined();
  });

  it('knows without loading which dialogs start a document', () => {
    for (const id of ['images-to-pdf', 'new-document', 'merge-files', 'convert-to-pdf']) {
      expect(isStandaloneDialog(id), id).toBe(true);
    }
    expect(isStandaloneDialog('split')).toBe(false);
  });
});
