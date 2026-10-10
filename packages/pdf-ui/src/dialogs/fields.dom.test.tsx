// @vitest-environment happy-dom
/**
 * The field list as a user drives it: every kind of control, what it reports through `onChange`
 * after real input, and what it shows for hints, errors, hidden fields and the advanced section.
 * The host keeps the values the way a dialog does, so what is typed comes back as what is shown.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldList, type FieldListProps, initialParams } from './fields';
import type { DialogParams, FieldSpec, FieldValue } from './types';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected value is missing');
  return value;
}

// The camera scanner is a heavy lazy chunk of its own (detector, warp, video): a stand-in with the
// same two exits stands where it would open, so what the field does with its pages is what is tested.
vi.mock('../scan/ScanDialog', () => ({
  ScanDialog: ({ onPages, onClose }: { onPages: (files: readonly File[]) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="scanner">
      <button
        type="button"
        onClick={() => onPages([new File(['p1'], 'scan-1.png'), new File(['p2'], 'scan-2.png')])}
      >
        use scanned
      </button>
      <button type="button" onClick={onClose}>
        close scanner
      </button>
    </div>
  ),
}));

const t = createTranslator('en');

function Host({
  fields,
  initial,
  onChange,
  ...rest
}: {
  fields: readonly FieldSpec[];
  initial?: DialogParams;
  onChange: (id: string, value: FieldValue) => void;
} & Partial<FieldListProps>) {
  const [values, setValues] = useState<DialogParams>({ ...initialParams(fields), ...initial });
  return (
    <FieldList
      t={t}
      fields={fields}
      values={values}
      pageCount={10}
      {...rest}
      onChange={(id, value) => {
        onChange(id, value);
        setValues((previous) => ({ ...previous, [id]: value }));
      }}
    />
  );
}

function show(
  fields: readonly FieldSpec[],
  extra: Partial<FieldListProps> & { initial?: DialogParams } = {},
) {
  const onChange = vi.fn();
  const view = render(<Host fields={fields} onChange={onChange} {...extra} />);
  return { onChange, ...view };
}

afterEach(cleanup);

describe('initialParams', () => {
  it('seeds every kind from its declared default, and leaves out what carries no value', () => {
    const fields: FieldSpec[] = [
      { kind: 'pageScope', id: 'scope', labelKey: 'op.scope', default: 'current' },
      { kind: 'pageScope', id: 'scopeAll', labelKey: 'op.scope' },
      { kind: 'radio', id: 'r', labelKey: 'op.scope', options: [], defaultValue: 'x' },
      { kind: 'select', id: 's', labelKey: 'op.scope', options: [], defaultValue: 'y' },
      { kind: 'choice', id: 'c', labelKey: 'op.scope', options: () => [], defaultValue: 'z' },
      { kind: 'text', id: 'tx', labelKey: 'op.scope', defaultValue: 'hello' },
      { kind: 'multiline', id: 'm', labelKey: 'op.scope', defaultValue: 'a\nb' },
      { kind: 'color', id: 'col', labelKey: 'op.scope', defaultValue: '#ff0000' },
      { kind: 'number', id: 'n', labelKey: 'op.scope', defaultValue: 4, min: 1, max: 9 },
      { kind: 'checkbox', id: 'cb', labelKey: 'op.scope', defaultValue: true },
      { kind: 'checkboxList', id: 'cl', labelKey: 'op.scope', options: [], defaultValue: ['p'] },
      { kind: 'password', id: 'pw', labelKey: 'op.scope' },
      { kind: 'image', id: 'im', labelKey: 'op.scope', accept: 'image/*' },
      { kind: 'files', id: 'fl', labelKey: 'op.scope', accept: '.pdf', multiple: true },
      { kind: 'scan', id: 'sc', labelKey: 'op.scope' },
      { kind: 'readOnlyText', id: 'ro', labelKey: 'op.scope', valueKey: 'op.close' },
    ];
    expect(initialParams(fields)).toEqual({
      scope: 'current',
      scopeAll: 'all',
      r: 'x',
      s: 'y',
      c: 'z',
      tx: 'hello',
      m: 'a\nb',
      col: '#ff0000',
      n: 4,
      cb: true,
      cl: ['p'],
      pw: '',
      im: [],
      fl: [],
      sc: [],
    });
  });
});

describe('FieldList page scope', () => {
  const scope: FieldSpec = { kind: 'pageScope', id: 'scope', labelKey: 'op.scope' };

  it('offers all pages, the current page and the selection, and disables a selection that is empty', () => {
    show([scope], { currentPage: 1, selectedCount: 0 });
    expect(screen.getByRole('radio', { name: 'All pages (10)' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Current page (2)' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Selected pages (0)' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByText('No pages selected.')).toBeTruthy();
  });

  it('leaves out "current page" when there is none, and selects pages when some are selected', async () => {
    const { onChange } = show([scope], { selectedCount: 3 });
    expect(screen.queryByRole('radio', { name: /Current page/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Selected pages (3)' }));
    expect(onChange).toHaveBeenLastCalledWith('scope', 'selection');
    expect(screen.queryByText('No pages selected.')).toBeNull();
  });

  it('types a custom range, says when it cannot be read, and remembers it when the choice moves away and back', async () => {
    const { onChange } = show([scope], { selectedCount: 1 });
    await userEvent.click(screen.getByRole('radio', { name: 'Custom range' }));
    expect(onChange).toHaveBeenLastCalledWith('scope', 'range:');
    const box = screen.getByPlaceholderText('e.g. 1-3, 5, 8-10');
    await userEvent.type(box, '2-4');
    expect(onChange).toHaveBeenLastCalledWith('scope', 'range:2-4');

    await userEvent.click(screen.getByRole('radio', { name: 'All pages (10)' }));
    expect(onChange).toHaveBeenLastCalledWith('scope', 'all');
    await userEvent.click(screen.getByRole('radio', { name: 'Custom range' }));
    expect(onChange).toHaveBeenLastCalledWith('scope', 'range:2-4');

    await userEvent.clear(screen.getByPlaceholderText('e.g. 1-3, 5, 8-10'));
    await userEvent.type(screen.getByPlaceholderText('e.g. 1-3, 5, 8-10'), 'zz');
    expect(screen.getByText(/Page range could not be parsed\./)).toBeTruthy();
  });

  it('shows a hint instead of the empty-selection note when the field has one', () => {
    show([{ ...scope, hintKey: 'op.cancelled' }], { selectedCount: 0 });
    expect(screen.getByText('Operation cancelled.')).toBeTruthy();
    expect(screen.queryByText('No pages selected.')).toBeNull();
  });
});

describe('FieldList choices', () => {
  const options = [
    { value: 'a', labelKey: 'op.close' as const },
    { value: 'b', labelKey: 'op.cancel' as const },
  ];

  it('a radio reports the option picked, in one column or several', async () => {
    const one = show([
      { kind: 'radio', id: 'r', labelKey: 'op.scope', options, defaultValue: 'a', hintKey: 'op.running' },
    ]);
    expect(screen.getByText('Processing…')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'Cancel' }));
    expect(one.onChange).toHaveBeenLastCalledWith('r', 'b');
    cleanup();

    const grid = show([
      { kind: 'radio', id: 'r', labelKey: 'op.scope', options, defaultValue: 'a', columns: 2 },
    ]);
    const group = screen.getByRole('radio', { name: 'Close' }).closest('div[style]') as HTMLElement;
    expect(group.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    await userEvent.click(screen.getByRole('radio', { name: 'Cancel' }));
    expect(grid.onChange).toHaveBeenLastCalledWith('r', 'b');
    cleanup();

    show([{ kind: 'radio', id: 'r', labelKey: 'op.scope', options, defaultValue: 'a', columns: 1 }]);
    expect(screen.getByRole('radio', { name: 'Close' }).closest('div[style]')).toBeNull();
  });

  it('a select shows the label of its value and reports the option picked', async () => {
    const { onChange } = show([
      { kind: 'select', id: 's', labelKey: 'op.scope', options, defaultValue: 'a' },
    ]);
    const trigger = screen.getByRole('combobox', { name: 'Page range' });
    expect(trigger.textContent).toBe('Close');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'Cancel' }));
    expect(onChange).toHaveBeenLastCalledWith('s', 'b');
  });

  it('a select whose value is not among its options shows the value itself', () => {
    show([{ kind: 'select', id: 's', labelKey: 'op.scope', options, defaultValue: 'a' }], {
      initial: { s: 'gone' },
    });
    expect(screen.getByRole('combobox', { name: 'Page range' }).textContent).toBe('gone');
  });

  it('a document-data select lists the options it was given and reports the one picked', async () => {
    const { onChange } = show(
      [{ kind: 'choice', id: 'c', labelKey: 'op.scope', options: () => [], defaultValue: 'x' }],
      {
        choices: {
          c: [
            { value: 'x', label: 'First' },
            { value: 'y', label: 'Second' },
          ],
        },
      },
    );
    expect(screen.getByRole('combobox', { name: 'Page range' }).textContent).toBe('First');
    await userEvent.click(screen.getByRole('combobox', { name: 'Page range' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Second' }));
    expect(onChange).toHaveBeenLastCalledWith('c', 'y');
  });

  it('a document-data select with no list shows the value it holds, and says there is nothing to select', () => {
    show([{ kind: 'choice', id: 'c', labelKey: 'op.scope', options: () => [], defaultValue: '' }]);
    expect(screen.getByText(t('dialog.field.choiceEmpty'))).toBeTruthy();
  });

  it('a checkbox list reports the whole list as it is ticked and unticked, in one column or several', async () => {
    const list: FieldSpec = {
      kind: 'checkboxList',
      id: 'cl',
      labelKey: 'op.scope',
      options,
      defaultValue: ['a'],
      hintKey: 'op.running',
    };
    const one = show([list]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Cancel' }));
    expect(one.onChange).toHaveBeenLastCalledWith('cl', ['a', 'b']);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Close' }));
    expect(one.onChange).toHaveBeenLastCalledWith('cl', ['b']);
    cleanup();

    show([{ ...list, columns: 2 }]);
    expect(screen.getByRole('checkbox', { name: 'Close' }).closest('div[style]')).not.toBeNull();
  });

  it('a single checkbox reports true and false, and carries its hint', async () => {
    const { onChange } = show([{ kind: 'checkbox', id: 'cb', labelKey: 'op.scope', defaultValue: false }]);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Page range' }));
    expect(onChange).toHaveBeenLastCalledWith('cb', true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Page range' }));
    expect(onChange).toHaveBeenLastCalledWith('cb', false);
  });
});

describe('FieldList values typed', () => {
  it('a number reports what is typed, NaN for an empty box, and shows a value set from outside', async () => {
    const field: FieldSpec = {
      kind: 'number',
      id: 'n',
      labelKey: 'op.scope',
      defaultValue: 5,
      min: 1,
      max: 10,
      hintKey: 'op.running',
    };
    const { onChange } = show([field]);
    const box = screen.getByRole('spinbutton', { name: 'Page range' }) as HTMLInputElement;
    expect(box.value).toBe('5');
    await userEvent.clear(box);
    expect(onChange).toHaveBeenLastCalledWith('n', Number.NaN);
    await userEvent.type(box, '7');
    expect(onChange).toHaveBeenLastCalledWith('n', 7);
    await userEvent.type(box, '77');
    expect(screen.getByText(t('dialog.field.numberRange', { min: 1, max: 10 }))).toBeTruthy();
  });

  it('a number shows a value the opener preset, and a decimal can be typed digit by digit', async () => {
    show([{ kind: 'number', id: 'n', labelKey: 'op.scope', defaultValue: 5, min: 0, max: 10, step: 0.5 }], {
      initial: { n: 3 },
    });
    const box = screen.getByRole('spinbutton', { name: 'Page range' }) as HTMLInputElement;
    expect(box.value).toBe('3');
    await userEvent.clear(box);
    await userEvent.type(box, '2.5');
    expect(box.value).toBe('2.5');
  });

  it('text reports every keystroke, shows placeholder and hint, and inserts a token at the caret', async () => {
    const { onChange } = show([
      {
        kind: 'text',
        id: 'tx',
        labelKey: 'op.scope',
        defaultValue: 'AB',
        placeholderKey: 'op.scope.placeholder',
        hintKey: 'op.running',
        maxLength: 20,
        tokens: [{ token: '{page}', labelKey: 'stamp.token.page' }],
      },
    ]);
    const box = screen.getByRole('textbox', { name: 'Page range' }) as HTMLInputElement;
    expect(box.placeholder).toBe('e.g. 1-3, 5, 8-10');
    expect(box.maxLength).toBe(20);
    box.setSelectionRange(1, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Page' }));
    expect(onChange).toHaveBeenLastCalledWith('tx', 'A{page}B');
    expect(box.value).toBe('A{page}B');
    await userEvent.type(box, 'Z');
    expect(onChange).toHaveBeenLastCalledWith('tx', 'A{page}BZ');
  });

  it('a plain text field has neither placeholder nor token buttons', () => {
    show([{ kind: 'text', id: 'tx', labelKey: 'op.scope', defaultValue: '' }]);
    expect((screen.getByRole('textbox') as HTMLInputElement).placeholder).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a multiline field reports its text, with the rows and hint it was given', async () => {
    const { onChange } = show([
      {
        kind: 'multiline',
        id: 'm',
        labelKey: 'op.scope',
        defaultValue: '',
        rows: 3,
        maxLength: 50,
        placeholderKey: 'op.scope.placeholder',
        hintKey: 'op.running',
      },
    ]);
    const area = screen.getByRole('textbox', { name: 'Page range' }) as HTMLTextAreaElement;
    expect([Number(area.rows), area.maxLength, area.placeholder]).toEqual([3, 50, 'e.g. 1-3, 5, 8-10']);
    expect(screen.getByText('Processing…')).toBeTruthy();
    await userEvent.type(area, 'hi');
    expect(onChange).toHaveBeenLastCalledWith('m', 'hi');
  });

  it('a bare multiline field has six rows and no hint', () => {
    show([{ kind: 'multiline', id: 'm', labelKey: 'op.scope', defaultValue: 'x' }]);
    expect(Number((screen.getByRole('textbox') as HTMLTextAreaElement).rows)).toBe(6);
  });

  it('a password is typed hidden and reported as typed', async () => {
    const { onChange } = show([
      { kind: 'password', id: 'pw', labelKey: 'op.scope', placeholderKey: 'op.scope.placeholder' },
    ]);
    const box = screen.getByLabelText('Page range') as HTMLInputElement;
    expect(box.type).toBe('password');
    expect(box.placeholder).toBe('e.g. 1-3, 5, 8-10');
    await userEvent.type(box, 'pw1');
    expect(onChange).toHaveBeenLastCalledWith('pw', 'pw1');
  });

  it('a password with no placeholder shows none', () => {
    show([{ kind: 'password', id: 'pw', labelKey: 'op.scope' }]);
    expect((screen.getByLabelText('Page range') as HTMLInputElement).placeholder).toBe('');
  });

  it('a colour reports the colour picked', () => {
    const { onChange } = show([{ kind: 'color', id: 'col', labelKey: 'op.scope', defaultValue: '#ff0000' }]);
    const well = screen.getByLabelText('Page range') as HTMLInputElement;
    expect(well.value).toBe('#ff0000');
    fireEvent.change(well, { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenLastCalledWith('col', '#00ff00');
  });

  it('a read-only field shows the dictionary sentence and cannot be edited', () => {
    show([{ kind: 'readOnlyText', id: 'ro', labelKey: 'op.scope', valueKey: 'op.close' }]);
    const box = screen.getByRole('textbox', { name: 'Page range' }) as HTMLInputElement;
    expect([box.value, box.readOnly]).toEqual(['Close', true]);
  });
});

describe('FieldList files', () => {
  const pdf = (name: string) => new File([name], name, { type: 'application/pdf' });
  const png = (name: string) => new File([name], name, { type: 'image/png' });
  const chooser = () => document.querySelector('input[type="file"]') as HTMLInputElement;

  it('a file input that reports no files leaves the field empty', () => {
    const { onChange } = show([{ kind: 'image', id: 'im', labelKey: 'op.scope', accept: 'image/*' }]);
    fireEvent.change(chooser(), { target: { files: null } });
    expect(onChange).toHaveBeenLastCalledWith('im', []);
    expect(screen.getByText(t('dialog.field.noFile'))).toBeTruthy();
  });

  it('a single file field says nothing is chosen, then names the chosen file, replacing it on a new pick', async () => {
    const { onChange } = show([
      { kind: 'image', id: 'im', labelKey: 'op.scope', accept: 'image/*', hintKey: 'op.running' },
    ]);
    expect(screen.getByText(t('dialog.field.noFile'))).toBeTruthy();
    expect(screen.getByText(t('dialog.field.chooseFile'))).toBeTruthy();
    expect(chooser().multiple).toBe(false);
    expect(screen.getByText('Processing…')).toBeTruthy();
    await userEvent.upload(chooser(), png('a.png'));
    expect(screen.getByText('a.png')).toBeTruthy();
    expect((must(onChange.mock.calls.at(-1))[1] as File[]).map((file) => file.name)).toEqual(['a.png']);
    await userEvent.upload(chooser(), png('b.png'));
    expect(screen.queryByText('a.png')).toBeNull();
    expect(screen.getByText('b.png')).toBeTruthy();
  });

  it('a multiple field adds picks in order, counts them, and moves and removes them', async () => {
    const { onChange } = show([
      { kind: 'files', id: 'fl', labelKey: 'op.scope', accept: '.pdf', multiple: true },
    ]);
    expect(screen.getByText(t('dialog.field.chooseFiles'))).toBeTruthy();
    await userEvent.upload(chooser(), pdf('one.pdf'));
    await userEvent.upload(chooser(), pdf('two.pdf'));
    expect(screen.getByText(t('dialog.field.addFiles'))).toBeTruthy();
    expect(screen.getByText(t('dialog.field.filesChosen', { count: 2 }))).toBeTruthy();
    const names = () => (must(onChange.mock.calls.at(-1))[1] as File[]).map((file) => file.name);
    expect(names()).toEqual(['one.pdf', 'two.pdf']);

    const rows = () => within(screen.getByRole('list')).getAllByRole('listitem');
    expect(
      (
        within(rows()[0] as HTMLElement).getByRole('button', {
          name: t('dialog.field.moveUp', { name: 'one.pdf' }),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(rows()[1] as HTMLElement).getByRole('button', {
          name: t('dialog.field.moveDown', { name: 'two.pdf' }),
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await userEvent.click(
      screen.getByRole('button', { name: t('dialog.field.moveDown', { name: 'one.pdf' }) }),
    );
    expect(names()).toEqual(['two.pdf', 'one.pdf']);
    await userEvent.click(
      screen.getByRole('button', { name: t('dialog.field.moveUp', { name: 'one.pdf' }) }),
    );
    expect(names()).toEqual(['one.pdf', 'two.pdf']);
    await userEvent.click(
      screen.getByRole('button', { name: t('dialog.field.removeFile', { name: 'one.pdf' }) }),
    );
    expect(names()).toEqual(['two.pdf']);
    expect(within(screen.getByRole('list')).getByText('two.pdf')).toBeTruthy();
  });

  it('a files field that is not multiple takes one file', () => {
    show([{ kind: 'files', id: 'fl', labelKey: 'op.scope', accept: '.pdf', multiple: false }], {
      initial: {},
    });
    expect(chooser().multiple).toBe(false);
  });
});

describe('FieldList scan field', () => {
  const scan: FieldSpec = { kind: 'scan', id: 'sc', labelKey: 'op.scope', hintKey: 'op.running' };

  it('opens the scanner, adds the scanned pages to the ones it holds, and clears them', async () => {
    const { onChange } = show([scan]);
    expect(screen.getByText(t('scan.field.none'))).toBeTruthy();
    expect(screen.getByText('Processing…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('scan.field.clear') })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: t('scan.field.open') }));
    await userEvent.click(await screen.findByRole('button', { name: 'use scanned' }));
    expect((must(onChange.mock.calls.at(-1))[1] as File[]).map((file) => file.name)).toEqual([
      'scan-1.png',
      'scan-2.png',
    ]);
    expect(screen.queryByRole('dialog', { name: 'scanner' })).toBeNull();
    expect(screen.getByText(t('scan.field.count', { count: 2 }))).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: t('scan.field.more') }));
    await userEvent.click(await screen.findByRole('button', { name: 'use scanned' }));
    expect((must(onChange.mock.calls.at(-1))[1] as File[]).map((file) => file.name)).toEqual([
      'scan-1.png',
      'scan-2.png',
      'scan-1.png',
      'scan-2.png',
    ]);

    await userEvent.click(screen.getByRole('button', { name: t('scan.field.clear') }));
    expect(onChange).toHaveBeenLastCalledWith('sc', []);
    expect(screen.getByText(t('scan.field.none'))).toBeTruthy();
  });

  it('closes the scanner without changing what the field holds', async () => {
    const { onChange } = show([scan]);
    await userEvent.click(screen.getByRole('button', { name: t('scan.field.open') }));
    await userEvent.click(await screen.findByRole('button', { name: 'close scanner' }));
    expect(screen.queryByRole('dialog', { name: 'scanner' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('starts a field the dialog holds no value for from nothing, and shows no hint it was not given', async () => {
    const onChange = vi.fn();
    render(
      <FieldList
        t={t}
        fields={[{ kind: 'scan', id: 'sc', labelKey: 'op.scope' }]}
        values={{}}
        onChange={onChange}
        pageCount={1}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: t('scan.field.open') }));
    await userEvent.click(await screen.findByRole('button', { name: 'use scanned' }));
    expect((must(onChange.mock.calls.at(-1))[1] as File[]).map((file) => file.name)).toEqual([
      'scan-1.png',
      'scan-2.png',
    ]);
    expect(screen.queryByText('Processing…')).toBeNull();
  });
});

describe('FieldList with no value held yet', () => {
  it('shows every field at its declared default', () => {
    const fields: FieldSpec[] = [
      { kind: 'pageScope', id: 'scope', labelKey: 'op.scope' },
      {
        kind: 'radio',
        id: 'r',
        labelKey: 'op.close',
        options: [
          { value: 'a', labelKey: 'op.close' },
          { value: 'b', labelKey: 'op.cancel' },
        ],
        defaultValue: 'b',
      },
      {
        kind: 'select',
        id: 's',
        labelKey: 'op.cancel',
        options: [
          { value: 'a', labelKey: 'op.close' },
          { value: 'b', labelKey: 'op.cancel' },
        ],
        defaultValue: 'b',
      },
      { kind: 'choice', id: 'c', labelKey: 'op.running', options: () => [], defaultValue: 'x' },
      { kind: 'number', id: 'n', labelKey: 'op.scope.custom', defaultValue: 4, min: 1, max: 9 },
      { kind: 'text', id: 'tx', labelKey: 'op.scope.placeholder', defaultValue: 'hello' },
      { kind: 'multiline', id: 'm', labelKey: 'op.scope.empty', defaultValue: 'a\nb' },
      { kind: 'password', id: 'pw', labelKey: 'op.result.newTab' },
      { kind: 'color', id: 'col', labelKey: 'op.result.download', defaultValue: '#ff0000' },
      {
        kind: 'checkboxList',
        id: 'cl',
        labelKey: 'op.cancelled',
        options: [{ value: 'a', labelKey: 'op.close' }],
        defaultValue: [],
      },
    ];
    render(
      <FieldList
        t={t}
        fields={fields}
        values={{}}
        onChange={() => {}}
        pageCount={3}
        choices={{ c: [{ value: 'x', label: 'Ex' }] }}
      />,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'true',
    ]);
    expect(screen.getByRole('combobox', { name: t('op.cancel') }).textContent).toBe('Cancel');
    expect(screen.getByRole('combobox', { name: t('op.running') }).textContent).toBe('Ex');
    expect((screen.getByRole('spinbutton', { name: t('op.scope.custom') }) as HTMLInputElement).value).toBe(
      '4',
    );
    expect((screen.getByRole('textbox', { name: t('op.scope.placeholder') }) as HTMLInputElement).value).toBe(
      'hello',
    );
    expect((screen.getByRole('textbox', { name: t('op.scope.empty') }) as HTMLTextAreaElement).value).toBe(
      'a\nb',
    );
    expect((screen.getByLabelText(t('op.result.newTab')) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(t('op.result.download')) as HTMLInputElement).value).toBe('#ff0000');
    expect(screen.getByRole('checkbox', { name: 'Close' }).getAttribute('aria-checked')).toBe('false');
  });

  it('says an unknown choice by its value, and offers nothing when the document lists nothing under it', () => {
    render(
      <FieldList
        t={t}
        fields={[{ kind: 'choice', id: 'c', labelKey: 'op.running', options: () => [], defaultValue: 'x' }]}
        values={{ c: 'gone' }}
        onChange={() => {}}
        pageCount={3}
        choices={{ other: [{ value: 'o', label: 'Other' }] }}
      />,
    );
    expect(screen.getByRole('combobox', { name: t('op.running') }).textContent).toBe('gone');
  });

  it('inserts a token at the end of the text when the caret cannot be read', async () => {
    const onChange = vi.fn();
    render(
      <FieldList
        t={t}
        fields={[
          {
            kind: 'text',
            id: 'tx',
            labelKey: 'op.scope',
            defaultValue: 'AB',
            tokens: [{ token: '{page}', labelKey: 'stamp.token.page' }],
          },
        ]}
        values={{}}
        onChange={onChange}
        pageCount={3}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Page range' });
    Object.defineProperty(box, 'selectionStart', { value: null });
    Object.defineProperty(box, 'selectionEnd', { value: null });
    await userEvent.click(screen.getByRole('button', { name: 'Page' }));
    expect(onChange).toHaveBeenLastCalledWith('tx', '{page}');
  });

  it('shows a number the dialog holds no number for as an empty box, and follows a value set from outside', () => {
    const field: FieldSpec = {
      kind: 'number',
      id: 'n',
      labelKey: 'op.scope',
      defaultValue: 5,
      min: 1,
      max: 10,
    };
    const view = render(
      <FieldList t={t} fields={[field]} values={{ n: '' }} onChange={() => {}} pageCount={1} />,
    );
    const box = () => screen.getByRole('spinbutton', { name: 'Page range' }) as HTMLInputElement;
    expect(box().value).toBe('');
    view.rerender(<FieldList t={t} fields={[field]} values={{ n: 0 }} onChange={() => {}} pageCount={1} />);
    expect(box().value).toBe('0');
    view.rerender(<FieldList t={t} fields={[field]} values={{ n: 8 }} onChange={() => {}} pageCount={1} />);
    expect(box().value).toBe('8');
    view.rerender(
      <FieldList t={t} fields={[field]} values={{ n: Number.NaN }} onChange={() => {}} pageCount={1} />,
    );
    expect(box().value).toBe('8');
  });
});

describe('FieldList visibility and the advanced section', () => {
  const driver: FieldSpec = {
    kind: 'radio',
    id: 'mode',
    labelKey: 'op.scope',
    options: [
      { value: 'a', labelKey: 'op.close' },
      { value: 'b', labelKey: 'op.cancel' },
    ],
    defaultValue: 'a',
  };

  it('shows a field only while its driver has one of the values it asks for', async () => {
    show([
      driver,
      {
        kind: 'text',
        id: 'only-b',
        labelKey: 'op.scope.custom',
        defaultValue: '',
        visibleWhen: { field: 'mode', equals: ['b'] },
      },
    ]);
    expect(screen.queryByRole('textbox', { name: 'Custom range' })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Cancel' }));
    expect(screen.getByRole('textbox', { name: 'Custom range' })).toBeTruthy();
  });

  it('keeps the advanced fields in one closed section that counts them and opens itself on an error', () => {
    const number: FieldSpec = {
      kind: 'number',
      id: 'n',
      labelKey: 'op.scope',
      defaultValue: 5,
      min: 1,
      max: 10,
      advanced: true,
    };
    const { container, unmount } = show([
      { kind: 'checkbox', id: 'x', labelKey: 'op.close', defaultValue: false },
      number,
    ]);
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText(/1/, { selector: 'summary' })).toBeTruthy();
    unmount();

    const broken = show([number], { initial: { n: 99 } });
    expect((broken.container.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('has no advanced section when no advanced field is visible', () => {
    const { container } = show([
      driver,
      {
        kind: 'checkbox',
        id: 'adv',
        labelKey: 'op.close',
        defaultValue: false,
        advanced: true,
        visibleWhen: { field: 'mode', equals: ['b'] },
      },
    ]);
    expect(container.querySelector('details')).toBeNull();
  });
});
