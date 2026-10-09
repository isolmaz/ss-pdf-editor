/** The words a document's applied redactions removed: kept per tab, joined, and forgotten with the tab. */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  erasedWordsOf,
  initialRedactionState,
  redactedWordsForgotten,
  redactedWordsRead,
  redactionStore,
} from './redaction-store';

beforeEach(() => redactionStore.set(initialRedactionState()));

describe('the erased words', () => {
  it('are empty for a tab nothing was redacted on', () => {
    expect(erasedWordsOf('a')).toEqual([]);
  });

  it('join what an earlier redaction on the same tab erased, without repeating a word', () => {
    redactedWordsRead('a', ['alpha', 'beta']);
    redactedWordsRead('a', ['beta', 'gamma']);
    redactedWordsRead('b', ['delta']);
    expect(erasedWordsOf('a')).toEqual(['alpha', 'beta', 'gamma']);
    expect(erasedWordsOf('b')).toEqual(['delta']);
  });

  it('change nothing when a redaction erased no word', () => {
    const before = redactionStore.get();
    redactedWordsRead('a', []);
    expect(redactionStore.get()).toBe(before);
  });

  it('are forgotten with the tab, and only that tab`s', () => {
    redactedWordsRead('a', ['alpha']);
    redactedWordsRead('b', ['delta']);
    redactedWordsForgotten('a');
    expect(erasedWordsOf('a')).toEqual([]);
    expect(erasedWordsOf('b')).toEqual(['delta']);
  });

  it('change nothing when the tab had none', () => {
    const before = redactionStore.get();
    redactedWordsForgotten('never');
    expect(redactionStore.get()).toBe(before);
  });
});
