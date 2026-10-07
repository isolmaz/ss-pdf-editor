import { isToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  chunkPages,
  extractedFileName,
  formatPageRanges,
  parsePageRanges,
  partFileName,
  validateRanges,
} from './page-ranges';

/**
 * The page-range parser is one of the critical modules: every
 * printing, OCR, redaction, extraction, split and imposition surface feeds user
 * text through it, and its failure mode is silent data loss (the wrong pages
 * exported) rather than a crash. These cases are the source project's defects
 * restated as behaviour.
 */
describe('parsePageRanges', () => {
  it('reads single pages, lists and ranges into ascending 0-based indices', () => {
    expect(parsePageRanges('1-3, 5', 10).pages).toEqual([0, 1, 2, 4]);
    expect(parsePageRanges('3', 10).pages).toEqual([2]);
    expect(parsePageRanges('2, 4, 1', 10).pages).toEqual([0, 1, 3]);
  });

  it('accepts Turkish typography: en/em dashes, semicolons and stray whitespace', () => {
    expect(parsePageRanges('1 – 3; 5', 10).pages).toEqual([0, 1, 2, 4]);
    expect(parsePageRanges('  1—2  ', 10).pages).toEqual([0, 1]);
  });

  it('resolves open ranges against the document', () => {
    expect(parsePageRanges('3-', 5).pages).toEqual([2, 3, 4]);
    expect(parsePageRanges('-2', 5).pages).toEqual([0, 1]);
  });

  /** The `engineMessage` of the refusal: says *which* rule fired, not just that something threw. */
  const refusal = (input: string, pageCount = 5): string => {
    try {
      parsePageRanges(input, pageCount);
    } catch (error) {
      if (isToolError(error) && error.code === 'range-invalid') return error.details.engineMessage ?? '';
      throw error;
    }
    return 'accepted';
  };

  it('rejects a repeated page instead of producing the same part twice', () => {
    expect(refusal('1,1')).toBe('duplicate page');
    expect(refusal('1-3, 2-4')).toBe('duplicate page');
  });

  it('rejects a descending range rather than silently swapping or dropping its ends', () => {
    expect(refusal('4-2')).toBe('descending range');
    // Next to a valid page the descending range would otherwise contribute nothing and the
    // request would look like it worked.
    expect(refusal('1, 4-2')).toBe('descending range');
  });

  it('rejects unparsable text and empty input', () => {
    expect(refusal('')).toBe('empty range');
    expect(refusal('   ')).toBe('empty range');
    for (const input of ['abc', '-', '0', '1..2']) expect(refusal(input), input).not.toBe('accepted');
    expect(refusal('abc')).toBe('unparsable segment');
    expect(refusal('-')).toBe('empty segment');
  });

  it('accepts an open range to the end of the document', () => {
    expect(parsePageRanges('1-', 5).pages).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects pages beyond the document instead of clamping them', () => {
    expect(refusal('7')).toBe('page 7 out of document bounds (5)');
    expect(refusal('2-9')).toBe('page 9 out of document bounds (5)');
    expect(refusal('1', 0)).toBe('invalid or zero document pageCount');
  });

  it('validates already-parsed pages against the document they are applied to', () => {
    const parsed = parsePageRanges('1-3', 10);
    expect(validateRanges(parsed, 3)).toBe(parsed);
    expect(() => validateRanges(parsed, 2)).toThrowError(expect.objectContaining({ code: 'range-invalid' }));
    expect(() => validateRanges({ pages: [-1], source: '0' }, 5)).toThrowError(
      expect.objectContaining({ code: 'range-invalid' }),
    );
  });

  it('names the offending 1-based page when validation refuses', () => {
    try {
      // The source text is not the page: a refusal that echoed it would say "1, 5".
      validateRanges({ pages: [0, 4], source: '1, 5' }, 3);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isToolError(error) && error.details.path).toBe('5');
    }
  });

  it('reports failures as the shared error contract, never as English engine text', () => {
    try {
      parsePageRanges('abc', 5);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isToolError(error)).toBe(true);
      if (isToolError(error)) {
        expect(error.code).toBe('range-invalid');
        expect(error.details.engineMessage).toBeTypeOf('string');
      }
    }
  });
});

describe('formatPageRanges', () => {
  it('collapses runs and keeps single pages separate', () => {
    expect(formatPageRanges([0, 1, 2, 4])).toBe('1-3, 5');
    expect(formatPageRanges([2])).toBe('3');
    expect(formatPageRanges([])).toBe('');
    expect(formatPageRanges([5, 3, 4])).toBe('4-6');
  });

  it('round-trips through the parser', () => {
    const pages = [0, 1, 2, 5, 9, 10];
    expect(parsePageRanges(formatPageRanges(pages), 20).pages).toEqual(pages);
  });
});

describe('chunkPages', () => {
  it('splits into equal parts and keeps the remainder', () => {
    expect(chunkPages([0, 1, 2, 3, 4], 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('refuses a non-positive size', () => {
    expect(() => chunkPages([0], 0)).toThrowError();
    expect(chunkPages([0, 1, 2], 1)).toEqual([[0], [1], [2]]);
  });
});

describe('partFileName', () => {
  it('pads the counter to the width of the part count', () => {
    expect(partFileName('rapor.pdf', 0, 9)).toBe('rapor-1.pdf');
    expect(partFileName('rapor.pdf', 8, 9)).toBe('rapor-9.pdf');
    expect(partFileName('rapor.pdf', 9, 10)).toBe('rapor-10.pdf');
    // Where the width is wider than the number, the counter is zero-padded.
    expect(partFileName('rapor.pdf', 0, 10)).toBe('rapor-01.pdf');
    expect(partFileName('rapor.pdf', 8, 10)).toBe('rapor-09.pdf');
    expect(partFileName('rapor.pdf', 0, 120)).toBe('rapor-001.pdf');
  });

  it('keeps the extension and numeric order past 999 parts', () => {
    // The source project's name builder broke here.
    expect(partFileName('buyuk.pdf', 999, 1000)).toBe('buyuk-1000.pdf');
    expect(partFileName('buyuk.pdf', 1233, 2000)).toBe('buyuk-1234.pdf');
  });

  it('accepts a name with no extension and one with an appended suffix', () => {
    expect(partFileName('belge', 0, 2, '-ek')).toBe('belge-1-ek.pdf');
  });
});

describe('extractedFileName', () => {
  it('names the extracted pages, not a part counter, and keeps the name file-system safe', () => {
    expect(extractedFileName('rapor.pdf', [1])).toBe('rapor-p2.pdf');
    expect(extractedFileName('rapor', [0, 1, 2, 4])).toBe('rapor-p1-3_5.pdf');
  });
});
