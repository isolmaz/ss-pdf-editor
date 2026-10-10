/**
 * The file-name rules every open goes through: which extension is converted, which is a
 * picture, which is a known document no converter reads (said plainly, not "corrupt"),
 * and the name a converted file gets.
 */

import { describe, expect, it } from 'vitest';
import {
  convertFormatOf,
  formatLabel,
  isImageName,
  pdfNameFor,
  unsupportedDocumentKind,
} from './convert-formats';

describe('convert formats', () => {
  it('maps extensions to formats case-insensitively and rejects unknown ones', () => {
    expect(convertFormatOf('Report.DOCX')).toBe('docx');
    expect(convertFormatOf('a.b.xlsx')).toBe('xlsx');
    expect(convertFormatOf('page.htm')).toBe('html');
    expect(convertFormatOf('notes.md')).toBe('txt');
    expect(convertFormatOf('data.tsv')).toBe('tsv');
    expect(convertFormatOf('scan.pdf')).toBeNull();
    expect(convertFormatOf('legacy.doc')).toBeNull();
    expect(convertFormatOf('noextension')).toBeNull();
  });

  it('names pictures and known-but-unreadable documents, and nothing else', () => {
    expect(isImageName('photo.JPEG')).toBe(true);
    expect(isImageName('scan.tiff')).toBe(true);
    expect(isImageName('report.docx')).toBe(false);
    expect(isImageName('photo')).toBe(false);
    expect(unsupportedDocumentKind('old.XLS')).toBe('XLS');
    expect(unsupportedDocumentKind('letter.rtf')).toBe('RTF');
    expect(unsupportedDocumentKind('new.docx')).toBeNull();
    expect(unsupportedDocumentKind('x.png')).toBeNull();
    expect(unsupportedDocumentKind('letter')).toBeNull();
  });

  it('labels a format in capitals, as the notices spell it', () => {
    expect(formatLabel('docx')).toBe('DOCX');
    expect(formatLabel('txt')).toBe('TXT');
  });

  it('swaps only the last extension and drops any folder', () => {
    expect(pdfNameFor('rapor.final.docx')).toBe('rapor.final.pdf');
    expect(pdfNameFor('dir/sub/tablo.csv')).toBe('tablo.pdf');
    expect(pdfNameFor('noext')).toBe('noext.pdf');
    expect(pdfNameFor('.hidden')).toBe('.hidden.pdf');
  });
});
