// @vitest-environment happy-dom
/**
 * The form field inventory: every field with its kind, lock and required marks and current
 * value; an inline control for the kinds that can be edited in place (opened by the value
 * button, by choosing the row, or by the shell selecting the field); commits by Enter or by
 * leaving the field, never for text nobody changed; Escape abandoning an edit; checkboxes
 * committing at once; locked and disabled fields keeping their value but no control; and
 * arrow, Home, End and Enter walking the rows. The panel applies nothing: it reports values.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FormFieldInfo } from 'pdf-core/ops/forms';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormPanel, type FormPanelProps } from './FormPanel';

afterEach(cleanup);

const t = createTranslator('en');

const field = (name: string, overrides: Partial<FormFieldInfo> = {}): FormFieldInfo => ({
  name,
  kind: 'text',
  value: '',
  readOnly: false,
  required: false,
  maxLength: null,
  options: null,
  pageIndex: 0,
  ...overrides,
});

function show(props: Partial<FormPanelProps> = {}) {
  const onSelect = vi.fn();
  const onFill = vi.fn();
  const view = render(
    <FormPanel t={t} fields={[field('Name')]} onSelect={onSelect} onFill={onFill} {...props} />,
  );
  return { onSelect, onFill, ...view, user: userEvent.setup() };
}

const rowOf = (name: string) =>
  screen.getByText(name, { selector: 'span.truncate' }).closest('li') as HTMLElement;
const rowButton = (name: string) => rowOf(name).querySelector('button') as HTMLButtonElement;
const input = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

describe('FormPanel: the inventory', () => {
  it('shows a loading state while the fields are read', () => {
    const { container } = show({ loading: true });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says the document has no form fields', () => {
    show({ fields: [] });
    expect(screen.getByText('No form fields in this document.')).toBeTruthy();
  });

  it('lists every field with its kind, marks and value, and announces the count', () => {
    show({
      fields: [
        field('Full name', { value: 'Ada', required: true }),
        field('Notes', { value: '' }),
        field('Agree', { kind: 'checkbox', value: true }),
        field('Newsletter', { kind: 'checkbox', value: false }),
        field('Country', { kind: 'dropdown', value: 'TR', options: ['TR', 'DE'] }),
        field('Choices', { kind: 'optionlist', value: ['a', 'b'], options: ['a', 'b', 'c'] }),
        field('Plan', { kind: 'radio', value: 'basic', options: ['basic', 'pro'] }),
        field('Send', { kind: 'button', value: null }),
        field('Sign here', { kind: 'signature', value: null }),
        field('Mystery', { kind: 'unknown', value: 'x' }),
        field('Locked', { value: 'fixed', readOnly: true }),
      ],
    });
    expect(screen.getByText('11 form field(s) listed.')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Form fields' });
    const rows = within(list)
      .getAllByRole('listitem')
      .map((row) => row.textContent);
    expect(rows).toEqual([
      'Full name*TextAda',
      'NotesText(empty)',
      'AgreeCheckboxChecked',
      'NewsletterCheckboxUnchecked',
      'CountryDropdownTR',
      'ChoicesList boxa, b',
      'PlanRadio groupbasic',
      'SendButton(empty)',
      'Sign hereSignature(empty)',
      'MysteryUnknownx',
      'Locked🔒Textfixed',
    ]);
    expect(rowOf('Full name').querySelector('[title="Required"]')?.textContent).toBe('*');
    expect(rowOf('Locked').querySelector('[title="Read only"]')?.textContent).toBe('🔒');
    expect(rowOf('Notes').querySelector('[title="Required"]')).toBeNull();
    expect(rowOf('Notes').querySelector('[title="Read only"]')).toBeNull();
  });

  it('keeps a value that cannot be edited as text, not as a control', () => {
    show({
      fields: [
        field('Locked', { value: 'fixed', readOnly: true }),
        field('Mystery', { kind: 'unknown', value: 'x' }),
      ],
    });
    expect(within(rowOf('Locked')).queryByRole('button', { name: 'fixed' })).toBeNull();
    expect(within(rowOf('Mystery')).queryByRole('button', { name: 'x' })).toBeNull();
    expect(within(rowOf('Locked')).getByText('fixed')).toBeTruthy();
  });

  it('marks the field the shell has selected as current', () => {
    show({ fields: [field('A', { kind: 'button' }), field('B', { kind: 'button' })], selectedName: 'B' });
    expect(rowButton('A').getAttribute('aria-current')).toBeNull();
    expect(rowButton('B').getAttribute('aria-current')).toBe('true');
  });
});

describe('FormPanel: editing a field in place', () => {
  it('opens the control from the value button and commits the typed value on Enter', async () => {
    const { user, onFill } = show({ fields: [field('Name', { value: 'Ada' })] });
    await user.click(screen.getByRole('button', { name: 'Ada' }));
    expect(input('Name').value).toBe('Ada');
    expect(document.activeElement).toBe(input('Name'));

    await user.clear(input('Name'));
    await user.type(input('Name'), 'Grace{Enter}');
    expect(onFill).toHaveBeenCalledExactlyOnceWith('Name', 'Grace');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the placeholder on the value button of an empty field and opens it empty', async () => {
    const { user } = show();
    await user.click(screen.getByRole('button', { name: '(empty)' }));
    expect(input('Name').value).toBe('');
  });

  it('commits a changed value when the user leaves the field', async () => {
    const { user, onFill } = show({ fields: [field('Name', { value: 'Ada' })] });
    await user.click(screen.getByRole('button', { name: 'Ada' }));
    await user.type(input('Name'), '!');
    await user.tab();
    expect(onFill).toHaveBeenCalledExactlyOnceWith('Name', 'Ada!');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('reports nothing when the user leaves the field without changing it', async () => {
    const { user, onFill } = show({ fields: [field('Name', { value: 'Ada' })] });
    await user.click(screen.getByRole('button', { name: 'Ada' }));
    await user.tab();
    expect(onFill).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    // The value is shown again, and can be opened again.
    expect(screen.getByRole('button', { name: 'Ada' })).toBeTruthy();
  });

  it('abandons the edit on Escape without reporting it, and without leaving the form', async () => {
    const outer = vi.fn();
    const { user, onFill } = show({ fields: [field('Name', { value: 'Ada' })] });
    document.addEventListener('keydown', outer);
    await user.click(screen.getByRole('button', { name: 'Ada' }));
    await user.type(input('Name'), 'xyz');
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', outer);

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ada' })).toBeTruthy();
    expect(onFill).not.toHaveBeenCalled();
    expect(outer.mock.calls.filter(([event]) => (event as KeyboardEvent).key === 'Escape')).toEqual([]);

    // A later edit of the same field reports again: the abandoned one left no trace.
    await user.click(screen.getByRole('button', { name: 'Ada' }));
    await user.type(input('Name'), '?{Enter}');
    expect(onFill).toHaveBeenCalledExactlyOnceWith('Name', 'Ada?');
  });

  it('ignores other keys inside the control', async () => {
    const { user, onFill } = show({ fields: [field('Name', { value: 'Ada' })] });
    await user.click(screen.getByRole('button', { name: 'Ada' }));
    await user.keyboard('{ArrowLeft}');
    expect(input('Name').value).toBe('Ada');
    expect(onFill).not.toHaveBeenCalled();
  });

  it('offers a dropdown its options as suggestions', async () => {
    const { user, container } = show({
      fields: [field('Country', { kind: 'dropdown', value: 'TR', options: ['TR', 'DE'] })],
    });
    await user.click(screen.getByRole('button', { name: 'TR' }));
    expect(screen.getByRole('combobox', { name: 'Country' }).getAttribute('list')).toBe(
      'form-options-Country',
    );
    expect(
      [...container.querySelectorAll('#form-options-Country option')].map((option) =>
        option.getAttribute('value'),
      ),
    ).toEqual(['TR', 'DE']);
  });

  it('offers a text field no suggestions', async () => {
    const { user, container } = show({ fields: [field('Free', { value: 'x' })] });
    await user.click(screen.getByRole('button', { name: 'x' }));
    expect(input('Free').hasAttribute('list')).toBe(false);
    expect(container.querySelector('datalist')).toBeNull();
  });

  it('opens the control when its row is chosen, and reports the choice to the shell', async () => {
    const { user, onSelect } = show({ fields: [field('Name', { value: 'Ada' })] });
    await user.click(rowButton('Name'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('Name');
    expect(input('Name').value).toBe('Ada');
  });

  it('keeps what was typed when the row of an open field is chosen again', async () => {
    const { user, onSelect } = show({ fields: [field('Name', { value: 'Ada' })] });
    await user.click(rowButton('Name'));
    await user.type(input('Name'), '!');
    fireEvent.click(rowButton('Name'));
    expect(input('Name').value).toBe('Ada!');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('only reports the choice for a row that has no control to open', async () => {
    const { user, onSelect } = show({
      fields: [field('Agree', { kind: 'checkbox', value: false })],
    });
    await user.click(rowButton('Agree'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('Agree');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('works without a shell that listens to choices or fills', async () => {
    const { user } = show({
      onSelect: undefined,
      onFill: undefined,
      fields: [field('Name', { value: 'Ada' })],
    });
    await user.click(rowButton('Name'));
    await user.type(input('Name'), '!{Enter}');
    // The panel applies nothing: with nobody to apply the fill, the document's own value shows.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ada' })).toBeTruthy();
  });

  it('gives a locked field and a disabled panel a value but no control', async () => {
    const { user } = show({
      fields: [field('Locked', { value: 'fixed', readOnly: true })],
    });
    await user.click(rowButton('Locked'));
    expect(screen.queryByRole('textbox')).toBeNull();
    cleanup();

    const disabled = show({
      disabled: true,
      fields: [field('Name', { value: 'Ada' })],
      selectedName: 'Name',
    });
    expect(disabled.container.querySelector('input')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ada' })).toBeNull();
    expect(screen.getByText('Ada', { selector: 'span.block' })).toBeTruthy();
  });
});

describe('FormPanel: checkboxes', () => {
  it('commit at once, with the new state', async () => {
    const { user, onFill } = show({
      fields: [
        field('Agree', { kind: 'checkbox', value: true }),
        field('News', { kind: 'checkbox', value: false }),
      ],
    });
    await user.click(screen.getByRole('checkbox', { name: 'Checked' }));
    await user.click(screen.getByRole('checkbox', { name: 'Unchecked' }));
    expect(onFill.mock.calls).toEqual([
      ['Agree', false],
      ['News', true],
    ]);
  });

  it('cannot be changed when the field is locked or the panel is disabled', () => {
    show({ fields: [field('Agree', { kind: 'checkbox', value: true, readOnly: true })] });
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    show({ disabled: true, fields: [field('Agree', { kind: 'checkbox', value: true })] });
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    show({ fields: [field('Agree', { kind: 'checkbox', value: true })] });
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('FormPanel: the field the shell selects', () => {
  it('opens its control seeded with the document value', () => {
    show({ fields: [field('Name', { value: 'Ada' }), field('Other', { value: 'o' })], selectedName: 'Name' });
    expect(input('Name').value).toBe('Ada');
    expect(screen.queryByRole('textbox', { name: 'Other' })).toBeNull();
  });

  it.each([
    ['nothing', undefined],
    ['no field', null],
    ['a field the document does not have', 'Missing'],
    ['a field with no inline control', 'Agree'],
  ])('opens no control when the shell selects %s', (_label, selectedName) => {
    show({
      fields: [field('Name', { value: 'Ada' }), field('Agree', { kind: 'checkbox', value: false })],
      selectedName,
    });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('follows a changed document value while nobody is editing it', () => {
    const { rerender } = show({ fields: [field('Name', { value: 'Ada' })], selectedName: 'Name' });
    rerender(<FormPanel t={t} fields={[field('Name', { value: 'Grace' })]} selectedName="Name" />);
    expect(input('Name').value).toBe('Grace');
  });

  it('keeps an edit in progress when the document reloads under it', async () => {
    const { user, rerender } = show({ fields: [field('Name', { value: 'Ada' })], selectedName: 'Name' });
    await user.type(input('Name'), '!');
    rerender(<FormPanel t={t} fields={[field('Name', { value: 'Grace' })]} selectedName="Name" />);
    expect(input('Name').value).toBe('Ada!');
  });

  it('leaves an open control alone when the same fields are shown again', () => {
    const fields = [field('Name', { value: 'Ada' })];
    const { rerender } = show({ fields, selectedName: 'Name' });
    rerender(<FormPanel t={t} fields={fields} selectedName="Name" disabled={false} />);
    expect(input('Name').value).toBe('Ada');
  });
});

describe('FormPanel: walking the rows', () => {
  const FIELDS = [
    field('A', { kind: 'button' }),
    field('B', { kind: 'button' }),
    field('C', { kind: 'button' }),
  ];
  const focusRow = (name: string) => act(() => rowButton(name).focus());
  const tabStops = () => ['A', 'B', 'C'].filter((name) => rowButton(name).tabIndex === 0);

  it('makes one row the tab stop and moves it with the arrow keys, clamped to the list', async () => {
    const { user } = show({ fields: FIELDS });
    expect(tabStops()).toEqual(['A']);
    focusRow('A');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rowButton('A'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowButton('B'));
    expect(tabStops()).toEqual(['B']);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(rowButton('C'));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rowButton('B'));
  });

  it('jumps to the first and last row with Home and End', async () => {
    const { user } = show({ fields: FIELDS });
    focusRow('B');
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(rowButton('C'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(rowButton('A'));
    expect(tabStops()).toEqual(['A']);
  });

  it('follows focus that arrives some other way', () => {
    show({ fields: FIELDS });
    focusRow('C');
    expect(tabStops()).toEqual(['C']);
  });

  it('keeps the page keys away from the shell', () => {
    show({ fields: FIELDS });
    expect(screen.getByRole('list', { name: 'Form fields' }).hasAttribute('data-owns-page-keys')).toBe(true);
  });

  it('selects the focused row on Enter', () => {
    const { onSelect } = show({ fields: FIELDS });
    focusRow('B');
    fireEvent.keyDown(rowButton('B'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('B');
  });

  it('selects nothing on Enter when the list has shrunk under the remembered row', () => {
    const { onSelect, rerender } = show({ fields: FIELDS });
    focusRow('C');
    rerender(
      <FormPanel
        t={t}
        fields={[FIELDS[0] as FormFieldInfo, FIELDS[2] as FormFieldInfo]}
        onSelect={onSelect}
      />,
    );
    fireEvent.keyDown(rowButton('C'), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not walk, or select, on other keys', async () => {
    const { user, onSelect } = show({ fields: FIELDS });
    focusRow('A');
    await user.keyboard('a{ArrowLeft}');
    expect(document.activeElement).toBe(rowButton('A'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('leaves the arrow keys to a control inside a row', async () => {
    const { user } = show({
      fields: [field('A', { value: 'one' }), field('B', { value: 'two' })],
      selectedName: 'A',
    });
    expect(document.activeElement).toBe(input('A'));
    await user.keyboard('{ArrowDown}{Home}');
    expect(document.activeElement).toBe(input('A'));
  });
});
