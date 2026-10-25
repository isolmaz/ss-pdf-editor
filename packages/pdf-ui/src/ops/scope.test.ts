import { createTranslator, ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import type { OpRunContext } from '../dialogs/types';
import { resolveScope, typedRangeText } from './scope';

function context(overrides: Partial<OpRunContext> = {}): OpRunContext {
  return {
    signal: new AbortController().signal,
    onProgress: () => undefined,
    bytes: new Uint8Array(),
    pageCount: 6,
    name: 'a.pdf',
    currentPage: 2,
    selectedPages: [],
    t: createTranslator('en'),
    ...overrides,
  };
}

function failure(action: () => unknown): ToolError {
  try {
    action();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

describe('resolveScope', () => {
  it('means every page for "all", for a missing value and for a value of the wrong kind', () => {
    expect(resolveScope('all', context())).toEqual([0, 1, 2, 3, 4, 5]);
    expect(resolveScope(undefined, context())).toEqual([0, 1, 2, 3, 4, 5]);
    expect(resolveScope(['all'], context())).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('means the page being viewed for "current"', () => {
    expect(resolveScope('current', context())).toEqual([2]);
  });

  it('refuses a current page outside the document', () => {
    for (const currentPage of [-1, 6]) {
      const error = failure(() => resolveScope('current', context({ currentPage })));
      expect(error.code).toBe('range-invalid');
      expect(error.details.engineMessage).toBe(`current page ${currentPage} is outside the 6-page document`);
    }
  });

  it('refuses a document without pages whatever the scope', () => {
    const error = failure(() => resolveScope('all', context({ pageCount: 0 })));
    expect(error.code).toBe('selection-empty');
    expect(error.details.engineMessage).toBe('the document has no pages');
  });

  it('returns the selected pages ascending and unique', () => {
    expect(resolveScope('selection', context({ selectedPages: [4, 1, 4, 0] }))).toEqual([0, 1, 4]);
  });

  it('refuses an empty selection', () => {
    const error = failure(() => resolveScope('selection', context()));
    expect(error.code).toBe('selection-empty');
    expect(error.details.engineMessage).toBe('page scope "selection" with an empty selection');
  });

  it('refuses a selection holding a page that does not exist or is not an integer', () => {
    for (const page of [-1, 6, 1.5, Number.NaN]) {
      const error = failure(() => resolveScope('selection', context({ selectedPages: [0, page] })));
      expect(error.code).toBe('range-invalid');
      expect(error.details.engineMessage).toBe(`selected page ${page} is outside the 6-page document`);
      expect(error.details.path).toBe('selection');
    }
  });

  it('parses typed ranges, with or without the "range:" prefix', () => {
    expect(resolveScope('range:1-2,5', context())).toEqual([0, 1, 4]);
    expect(resolveScope('3,6', context())).toEqual([2, 5]);
  });

  it('refuses a typed range that leaves the document', () => {
    const error = failure(() => resolveScope('range:7', context()));
    expect(error.code).toBe('range-invalid');
  });
});

describe('typedRangeText', () => {
  it('hands the segments over as written, so touching ranges stay two', () => {
    expect(typedRangeText('  1-3, 4-6 ', context())).toBe('1-3, 4-6');
    expect(typedRangeText('5, 1-2', context())).toBe('5, 1-2');
  });

  it('refuses text the page-range parser refuses', () => {
    for (const text of ['', '1-3, 3', '7', 'all']) {
      expect(failure(() => typedRangeText(text, context())).code).toBe('range-invalid');
    }
  });

  it('refuses a document without pages', () => {
    expect(failure(() => typedRangeText('1', context({ pageCount: 0 }))).code).toBe('selection-empty');
  });
});
