/**
 * A field's value as one line of text: what the panel shows and what a fill is compared
 * against, so an unchecked box or an empty list must read as empty, not as "false".
 */

import { describe, expect, it } from 'vitest';
import { fieldValueText } from './form-value';

describe('fieldValueText', () => {
  it('writes each value shape as one line of text', () => {
    expect(fieldValueText(null)).toBe('');
    expect(fieldValueText('Şişli')).toBe('Şişli');
    expect(fieldValueText(true)).toBe('✓');
    expect(fieldValueText(false)).toBe('');
    expect(fieldValueText(['kırmızı', 'mavi'])).toBe('kırmızı, mavi');
    expect(fieldValueText([])).toBe('');
  });
});
