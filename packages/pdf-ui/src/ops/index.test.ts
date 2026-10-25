import { createTranslator } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { fieldErrors } from '../dialogs/fields';
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

  it.each([
    ['link-add', 'page'],
    ['outline-edit', 'page'],
    ['sign', 'page'],
    ['insert-pages', 'position'],
    ['insert-pages', 'count'],
    ['page-labels', 'start'],
    ['page-numbers', 'startAt'],
    ['split', 'chunkSize'],
    ['split', 'bookmarkLevel'],
    ['impose', 'columns'],
    ['impose', 'rows'],
    ['new-document', 'pages'],
  ])(
    'refuses a fraction in the whole-number field %s / %s and takes its lowest value',
    async (dialog, id) => {
      const t = createTranslator('en');
      const found = (await dialogById(dialog))?.fields.find((candidate) => candidate.id === id);
      if (found?.kind !== 'number') throw new Error(`${dialog} has no number field ${id}`);
      // Judged on its own: the condition that shows it is not what is under test.
      const field = { ...found, visibleWhen: undefined };
      const message = t('dialog.field.integerRange', { min: field.min, max: field.max });
      expect(fieldErrors(t, [field], { [id]: field.min + 0.5 }, 10, 0)).toEqual({ [id]: message });
      expect(fieldErrors(t, [field], { [id]: field.min }, 10, 0)).toEqual({});
    },
  );

  it('answers undefined for an id nothing registered', async () => {
    expect(hasDialog('no-such-dialog')).toBe(false);
    expect(await dialogById('no-such-dialog')).toBeUndefined();
  });

  it('knows without loading which dialogs start a document', () => {
    for (const id of ['images-to-pdf', 'new-document', 'merge-files', 'convert-to-pdf', 'repair']) {
      expect(isStandaloneDialog(id), id).toBe(true);
    }
    expect(isStandaloneDialog('split')).toBe(false);
  });
});
