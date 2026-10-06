import type { FormFieldInfo } from './forms';

/**
 * A field's value as one line of text: the panel renders it, and the app compares it
 * against an incoming write so a fill that would repeat the document's own value is not
 * written at all (`App.tsx` `fillField`). Its own module, so the shell can call it without
 * pulling the form writer (`forms.ts`) into the first paint.
 *
 * `Array.isArray` does not narrow a `readonly string[]` union member, so the array case is
 * reached by elimination.
 */
export function fieldValueText(value: FormFieldInfo['value']): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? '✓' : '';
  return typeof value === 'string' ? value : value.join(', ');
}
