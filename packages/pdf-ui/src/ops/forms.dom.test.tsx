// @vitest-environment happy-dom
/**
 * The form-fields dialog as a user fills it in: the fills and the calculations take one line per
 * assignment, so the boxes must accept more than one line.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FieldList, initialParams } from '../dialogs/fields';
import type { DialogParams } from '../dialogs/types';
import { formFieldsDialog } from './forms';

const t = createTranslator('en');

let latest: DialogParams = {};

function Host() {
  const [values, setValues] = useState<DialogParams>(initialParams(formFieldsDialog.fields));
  latest = values;
  return (
    <FieldList
      t={t}
      fields={formFieldsDialog.fields}
      values={values}
      pageCount={1}
      onChange={(id, value) => setValues((previous) => ({ ...previous, [id]: value }))}
    />
  );
}

afterEach(cleanup);

describe('formFieldsDialog fields', () => {
  it('keeps every line typed into the fills and the calculations', async () => {
    render(<Host />);
    const user = userEvent.setup();

    await user.type(screen.getByRole('textbox', { name: 'Fields to fill' }), 'ad=Ada{Enter}onay=true');
    await user.type(
      screen.getByRole('textbox', { name: 'Calculations' }),
      'toplam = a + b{Enter}fark = a - b',
    );

    expect(latest.fills).toBe('ad=Ada\nonay=true');
    expect(latest.calculations).toBe('toplam = a + b\nfark = a - b');
  });

  it('still inserts an equals sign at the caret of the fills box', async () => {
    render(<Host />);
    const user = userEvent.setup();

    const box = screen.getByRole('textbox', { name: 'Fields to fill' }) as HTMLTextAreaElement;
    await user.type(box, 'ad{Enter}x');
    box.setSelectionRange(2, 2);
    await user.click(screen.getByRole('button', { name: 'equals' }));

    expect(latest.fills).toBe('ad=\nx');
  });
});
