/**
 * What the PDF/A converter hands Ghostscript and how it reads the engine's warnings back: the
 * pure half of `ghostscript-run.ts` (the engine itself runs in `ops/pdfa.test.ts`). A wrong
 * escape here corrupts the document information; a wrong flag converts to the wrong part.
 */

import { describe, expect, it } from 'vitest';
import {
  collectWarnings,
  ghostscriptArguments,
  OUTPUT_CONDITION,
  type PdfaDocumentInfo,
  pdfaDefinition,
  postScriptString,
} from './ghostscript-run';

const empty: PdfaDocumentInfo = {
  title: null,
  author: null,
  subject: null,
  keywords: null,
  creator: null,
  creationDate: null,
  language: null,
};

describe('ghostscript-run', () => {
  it('writes ASCII as an escaped literal and everything else as UTF-16BE hex with a BOM', () => {
    expect(postScriptString('Plain title')).toBe('(Plain title)');
    expect(postScriptString('a (b) \\ c')).toBe('(a \\(b\\) \\\\ c)');
    expect(postScriptString('')).toBe('()');
    // U+015F (s with cedilla) and U+20AC (euro sign).
    expect(postScriptString('ş€')).toBe('<FEFF015F20AC>');
    // U+1F600 is outside the BMP: a surrogate pair, D83D DE00.
    expect(postScriptString('\u{1F600}')).toBe('<FEFFD83DDE00>');
  });

  it('puts only the known information in the definition, plus the language and one sRGB intent', () => {
    const text = pdfaDefinition({
      ...empty,
      title: 'Rapor (taslak)',
      author: 'Ayşe',
      creationDate: 'D:20260101120000Z',
      language: 'tr-TR',
    });
    expect(text.startsWith('%!\n')).toBe(true);
    expect(text).toContain('  /Title (Rapor \\(taslak\\))');
    expect(text).toContain('  /Author <FEFF00410079015F0065>');
    expect(text).toContain('  /CreationDate (D:20260101120000Z)');
    expect(text).toContain('[{Catalog} <</Lang (tr-TR)>> /PUT pdfmark');
    expect(text).not.toContain('/Subject');
    expect(text).not.toContain('/Keywords');
    expect(text.match(/\/S \/GTS_PDFA1/g)).toHaveLength(1);
    expect(text).toContain(`/OutputConditionIdentifier (${OUTPUT_CONDITION})`);
    expect(text).toContain('/DestOutputProfile {icc_PDFA}');

    const bare = pdfaDefinition(empty);
    expect(bare).not.toContain('/Lang');
    expect(bare).not.toContain('/Title');
    expect(bare).toContain('/DOCINFO pdfmark');
  });

  it('asks for the part it was given and always names the definition and the input last', () => {
    for (const part of [1, 2, 3] as const) {
      const args = ghostscriptArguments(part);
      expect(args).toContain(`-dPDFA=${part}`);
      expect(args.filter((arg) => arg.startsWith('-dPDFA='))).toHaveLength(1);
      expect(args.slice(-2)).toEqual(['/tmp/PDFA_def.ps', '/tmp/input.pdf']);
    }
    const args = ghostscriptArguments(2);
    expect(args).toContain('-sDEVICE=pdfwrite');
    expect(args).toContain('-sColorConversionStrategy=RGB');
    expect(args).toContain('-dPDFACompatibilityPolicy=1');
    expect(args).toContain('--permit-file-read=/tmp/srgb.icc');
    expect(args).toContain('-dEmbedAllFonts=true');
  });

  it('joins a warning with its continuation lines and counts repeats of the same message', () => {
    const warnings = collectWarnings([
      'GPL Ghostscript 10.06.0: Annotation set to non-printing,',
      '  as required by PDF/A.',
      'GPL Ghostscript 10.06.0: Annotation set to non-printing, as required by PDF/A.',
      'GPL Ghostscript 10.06.0: Font X not embedded',
      '',
      'stray line without a prefix',
    ]);
    expect(warnings).toEqual([
      { text: 'Annotation set to non-printing, as required by PDF/A.', count: 2 },
      { text: 'Font X not embedded', count: 1 },
      { text: 'stray line without a prefix', count: 1 },
    ]);
    expect(collectWarnings([])).toEqual([]);
  });
});
