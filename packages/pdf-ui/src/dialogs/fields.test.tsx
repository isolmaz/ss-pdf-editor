/**
 * The field list's document-data select (`choice`): "nothing to select in this document" is
 * the answer for a list that came back empty, never for a list the reader has not picked from
 * yet. Rendered to markup with a translator that prints its keys, so the message is found by
 * its key.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FieldList, fieldErrors, isVisible } from './fields';
import type { FieldSpec } from './types';

/** The translator stub renders the dictionary key. */
const t = Object.assign((key: string) => key, { locale: 'en' as const }) as never;

const target: FieldSpec = {
  kind: 'choice',
  id: 'target',
  labelKey: 'image.field.target',
  options: () => [],
  defaultValue: '',
};

const markupWith = (options: readonly { value: string; label: string }[]) =>
  renderToStaticMarkup(
    <FieldList
      t={t}
      fields={[target]}
      values={{ target: '' }}
      onChange={() => {}}
      pageCount={1}
      choices={{ target: options }}
    />,
  );

describe('a choice field', () => {
  it('does not say the document has nothing to select while it offers something', () => {
    expect(markupWith([{ value: '0|Im0', label: 'Im0 (page 1)' }])).not.toContain('dialog.field.choiceEmpty');
  });

  it('says so when the document really has nothing to select', () => {
    expect(markupWith([])).toContain('dialog.field.choiceEmpty');
  });
});

const base = { labelKey: 'op.scope', hintKey: 'op.scope.empty' } as const;
const showing = (fields: readonly FieldSpec[], values: Record<string, never> | Record<string, unknown>) =>
  renderToStaticMarkup(
    <FieldList t={t} fields={fields} values={values as never} onChange={() => {}} pageCount={3} />,
  );

describe('isVisible', () => {
  const field = (equals: readonly (string | boolean | readonly string[])[]): FieldSpec => ({
    kind: 'checkbox',
    id: 'dependent',
    labelKey: 'op.scope',
    defaultValue: false,
    visibleWhen: { field: 'driver', equals },
  });

  it('shows a field with no condition and hides one whose driver has no value', () => {
    expect(isVisible({ kind: 'checkbox', id: 'a', labelKey: 'op.scope', defaultValue: false }, {}, [])).toBe(
      true,
    );
    expect(isVisible(field(['x']), {}, [])).toBe(false);
  });

  it('compares scalars by identity and lists by their content', () => {
    expect(isVisible(field(['x', 'y']), { driver: 'y' }, [])).toBe(true);
    expect(isVisible(field(['x']), { driver: 'z' }, [])).toBe(false);
    expect(isVisible(field([true]), { driver: true }, [])).toBe(true);
    expect(isVisible(field([['a', 'b']]), { driver: ['a', 'b'] }, [])).toBe(true);
    expect(isVisible(field([['a', 'b']]), { driver: ['a', 'c'] }, [])).toBe(false);
    expect(isVisible(field([['a', 'b']]), { driver: ['a'] }, [])).toBe(false);
    expect(isVisible(field([['a']]), { driver: 'a' }, [])).toBe(false);
  });

  it('hides a field whose driver is itself hidden, however the driver is set', () => {
    const driver: FieldSpec = {
      ...field(['x']),
      id: 'driver',
      visibleWhen: { field: 'root', equals: ['on'] },
    };
    const dependent = field(['x']);
    const fields = [driver, dependent];
    // `driver` is still 'x' (its default) while its own condition fails: the dependent must not show.
    expect(isVisible(dependent, { root: 'off', driver: 'x' }, fields)).toBe(false);
    expect(isVisible(dependent, { root: 'on', driver: 'x' }, fields)).toBe(true);
    expect(isVisible(dependent, { root: 'on', driver: 'z' }, fields)).toBe(false);
  });

  it('does not loop on conditions that depend on each other', () => {
    const a: FieldSpec = { ...field(['x']), id: 'a', visibleWhen: { field: 'b', equals: ['x'] } };
    const b: FieldSpec = { ...field(['x']), id: 'b', visibleWhen: { field: 'a', equals: ['x'] } };
    expect(isVisible(a, { a: 'x', b: 'x' }, [a, b])).toBe(true);
  });
});

describe('fieldErrors', () => {
  const scope: FieldSpec = { kind: 'pageScope', id: 'scope', labelKey: 'op.scope' };
  const count: FieldSpec = { kind: 'number', id: 'n', labelKey: 'op.scope', defaultValue: 1, min: 1, max: 5 };
  const choice: FieldSpec = {
    kind: 'choice',
    id: 'c',
    labelKey: 'op.scope',
    defaultValue: '',
    options: () => [],
  };

  it('refuses a selection scope with no pages selected, and keywords and valid ranges pass', () => {
    expect(fieldErrors(t, [scope], { scope: 'selection' }, 5, 0)).toEqual({ scope: 'op.scope.empty' });
    expect(fieldErrors(t, [scope], { scope: 'selection' }, 5, 2)).toEqual({});
    expect(fieldErrors(t, [scope], { scope: 'all' }, 5, 0)).toEqual({});
    expect(fieldErrors(t, [scope], { scope: 'range:1-2, 5' }, 5, 0)).toEqual({});
    expect(fieldErrors(t, [scope], {}, 5, 0)).toEqual({});
  });

  it("answers a range that cannot be read or is out of the document with the parser's own two sentences", () => {
    for (const range of ['range:abc', 'range:9', 'range:']) {
      const errors = fieldErrors(t, [scope], { scope: range }, 5, 0);
      expect(errors.scope, range).toMatch(/^error\.\S+\.message error\.\S+\.hint$/);
    }
  });

  it('refuses an unpicked choice, a number outside its range and a number that is not one', () => {
    expect(fieldErrors(t, [choice], { c: '' }, 1, 0)).toEqual({ c: 'dialog.field.choiceEmpty' });
    expect(fieldErrors(t, [choice], { c: 'x' }, 1, 0)).toEqual({});
    for (const value of [0, 6, Number.NaN, '3']) {
      expect(fieldErrors(t, [count], { n: value }, 1, 0), String(value)).toEqual({
        n: 'dialog.field.numberRange',
      });
    }
    expect(fieldErrors(t, [count], { n: 5 }, 1, 0)).toEqual({});
  });

  it('does not judge a field that is hidden', () => {
    const hidden: FieldSpec = { ...count, visibleWhen: { field: 'mode', equals: ['on'] } };
    expect(fieldErrors(t, [hidden], { mode: 'off', n: 99 }, 1, 0)).toEqual({});
    expect(fieldErrors(t, [hidden], { mode: 'on', n: 99 }, 1, 0)).toEqual({ n: 'dialog.field.numberRange' });
  });
});

describe('the field controls', () => {
  it('renders a colour well, a masked password, a multi-line box and token buttons from the spec', () => {
    const markup = showing(
      [
        { kind: 'color', id: 'color', ...base, defaultValue: '#336699' },
        { kind: 'password', id: 'secret', ...base },
        { kind: 'multiline', id: 'body', ...base, defaultValue: 'line one', rows: 3, maxLength: 40 },
        {
          kind: 'text',
          id: 'format',
          ...base,
          defaultValue: '{page}',
          tokens: [{ token: '{page}', labelKey: 'stamp.token.page' }],
        },
      ],
      {},
    );
    expect(markup).toContain('type="color"');
    expect(markup).toContain('value="#336699"');
    expect(markup).toContain('type="password"');
    expect(markup).toMatch(/<textarea[^>]*rows="3"[^>]*maxLength="40"[^>]*>line one<\/textarea>/);
    expect(markup).toContain('>stamp.token.page</button>');
  });

  it('lists the files picked in a multiple field in order, with the ends of the list unable to move outward', () => {
    const files = [new File(['a'], 'first.pdf'), new File(['b'], 'second.pdf'), new File(['c'], 'third.pdf')];
    const markup = showing(
      [{ kind: 'files', id: 'files', ...base, accept: 'application/pdf', multiple: true }],
      { files },
    );
    expect(markup).toContain('dialog.field.addFiles');
    expect(markup).toContain('dialog.field.filesChosen');
    const names = [...markup.matchAll(/<span class="min-w-0 flex-1 truncate">([^<]+)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(['first.pdf', 'second.pdf', 'third.pdf']);
    const up = [...markup.matchAll(/<button[^>]*aria-label="dialog\.field\.moveUp"[^>]*>/g)].map((m) => m[0]);
    const down = [...markup.matchAll(/<button[^>]*aria-label="dialog\.field\.moveDown"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(up.map((tag) => tag.includes(' disabled=""'))).toEqual([true, false, false]);
    expect(down.map((tag) => tag.includes(' disabled=""'))).toEqual([false, false, true]);
  });

  it('names a single picked file instead of counting it, and says nothing is chosen for none', () => {
    const one = showing([{ kind: 'files', id: 'f', ...base, accept: '.pdf', multiple: false }], {
      f: [new File(['a'], 'only.pdf')],
    });
    expect(one).toContain('only.pdf');
    expect(one).toContain('dialog.field.chooseFile');
    expect(one).not.toContain('<ol');
    const none = showing([{ kind: 'files', id: 'f', ...base, accept: '.pdf', multiple: true }], {});
    expect(none).toContain('dialog.field.noFile');
    expect(none).toContain('dialog.field.chooseFiles');
  });
});
