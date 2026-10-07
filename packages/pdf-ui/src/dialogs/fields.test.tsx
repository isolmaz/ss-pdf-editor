/**
 * The field list's document-data select (`choice`): "nothing to select in this document" is
 * the answer for a list that came back empty, never for a list the reader has not picked from
 * yet. Rendered to markup with a translator that prints its keys, so the message is found by
 * its key.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FieldList } from './fields';
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
