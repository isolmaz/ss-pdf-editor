/**
 * Word export of a page whose text holds characters above U+FFFF (an emoji, a mathematical
 * letter, a Linear B syllable, a SignWriting sign), unzipped and read with independent readers.
 * The wrong answers that matter: the character cut to its low 16 bits (U+1F600 written as the
 * private-use U+F600, U+10000 as U+0000 and then dropped as a control character, U+1D800 as half a
 * pair), and a `document.xml` that is not valid UTF-8 or not valid XML 1.0 text.
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { ASTRAL_CHARACTERS, astralPage } from '../astral-fixtures';
import { docxToHtml } from './convert-ooxml';
import { exportOffice } from './export-office';

const run = { signal: new AbortController().signal };

/** The `Char` production of XML 1.0 (§2.2): what a text node may hold. */
const XML_CHARS = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

/** `word/document.xml` as text, decoded from its own bytes by a decoder that refuses invalid UTF-8. */
async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file('word/document.xml');
  if (file === null) throw new Error('word/document.xml is missing');
  return new TextDecoder('utf-8', { fatal: true }).decode(await file.async('uint8array'));
}

/**
 * The text of every `w:t` of a document, in order, without any whitespace. A text box of the exact
 * layout is written twice by design (`mc:Choice` for Word 2010+, a VML copy in `mc:Fallback` for
 * older readers); only the first is read, as a reader that understands `wps` does.
 */
function runText(xml: string): string {
  const read = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  return [...read.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => match[1] ?? '')
    .join('')
    .replace(/\s+/g, '');
}

const EXPECTED = `Hi${ASTRAL_CHARACTERS.join('')}ok`;

describe('exportOffice → DOCX with characters above U+FFFF', () => {
  it('writes the flowing text with the emoji and the mathematical letter whole', async () => {
    const { file } = await exportOffice(
      await astralPage(),
      { pages: [0], baseName: 'astral.pdf', format: 'docx' },
      run,
    );
    const xml = await documentXml(file.bytes);
    expect(runText(xml)).toBe(EXPECTED);
    expect(xml).toContain(String.fromCodePoint(0x1f600));
    expect(xml).toContain(String.fromCodePoint(0x1d400));
    expect(xml).not.toContain('\uF600');
    expect(xml).not.toContain('\uD400');
    expect(XML_CHARS.test(xml)).toBe(true);
    // An independent reader (mammoth, through the converter) reads the four characters as one word.
    const html = (await docxToHtml(file.bytes, 'astral.docx')).parts[0]?.html ?? '';
    expect(html).toContain(ASTRAL_CHARACTERS.join(''));
  });

  it('writes the exact layout with the same characters, valid as UTF-8 and as XML', async () => {
    const { file } = await exportOffice(
      await astralPage(),
      { pages: [0], baseName: 'astral.pdf', format: 'docx', docxLayout: 'layout' },
      run,
    );
    const xml = await documentXml(file.bytes);
    expect(runText(xml)).toBe(EXPECTED);
    // The text box is written twice (`mc:Choice` and its VML `mc:Fallback`): both copies are whole.
    expect(xml.split(ASTRAL_CHARACTERS.join('')).length - 1).toBe(2);
    expect(xml).not.toContain('\uF600');
    expect(xml).not.toContain('\uD400');
    expect(XML_CHARS.test(xml)).toBe(true);
  });
});
