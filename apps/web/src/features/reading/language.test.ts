/**
 * The language a PDF declares: the primary subtag a voice is matched on, and what counts as
 * no declaration.
 */

import { describe, expect, it } from 'vitest';
import { declaredLanguage, primaryLanguage } from './language';

describe('primaryLanguage', () => {
  it('keeps the primary subtag, lower-cased, whatever the region or separator', () => {
    expect(primaryLanguage('de-DE')).toBe('de');
    expect(primaryLanguage('en_GB')).toBe('en');
    expect(primaryLanguage('  FR ')).toBe('fr');
    expect(primaryLanguage('zho-Hans-CN')).toBe('zho');
    expect(primaryLanguage('tr')).toBe('tr');
  });

  it('is null for a value that is not a language tag', () => {
    expect(primaryLanguage('')).toBeNull();
    expect(primaryLanguage('   ')).toBeNull();
    expect(primaryLanguage('x-unknown')).toBeNull();
    expect(primaryLanguage('english')).toBeNull();
    expect(primaryLanguage('12')).toBeNull();
  });
});

describe('declaredLanguage', () => {
  it('reads the catalog language out of the document info', () => {
    expect(declaredLanguage({ Language: 'de-DE' })).toBe('de');
  });

  it('is null for no info, no declaration, a declaration that is not text, or one that is not a tag', () => {
    expect(declaredLanguage(null)).toBeNull();
    expect(declaredLanguage(undefined)).toBeNull();
    expect(declaredLanguage({})).toBeNull();
    expect(declaredLanguage({ Language: 7 })).toBeNull();
    expect(declaredLanguage({ Language: 'x-unknown' })).toBeNull();
  });
});
