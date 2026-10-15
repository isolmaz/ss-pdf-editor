/**
 * The object-level audit reads raw file bytes, so its fixtures are hand-written PDF text:
 * what is in the string is exactly what the scan sees. The wrong answers that matter: an
 * erased string still present and reported as clean, a finding that quotes the erased text
 * itself, a second revision or an orphan object that goes unmentioned, and an abort that
 * the scan does not honour. The same wrong answers hide behind encodings: a word with `ş`
 * in a UTF-16BE string, an ASCII word in a hex string, an object definition after a CR
 * line end, and an attachment reported for the empty name tree MuPDF leaves behind.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf, savePdf } from '../engines/mupdf';
import { auditRedactedDocument } from './redact-audit';

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.charCodeAt(0));

/** A text as UTF-16BE with its byte-order mark, one latin1 character per byte. */
const utf16be = (text: string): string => {
  let bytes = '\u00FE\u00FF';
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes += String.fromCharCode(unit >> 8, unit & 0xff);
  }
  return bytes;
};

/** A literal string around raw bytes; the three bytes a literal reserves are escaped. */
const literal = (bytes: string): string => `(${bytes.replace(/[\\()]/g, (reserved) => `\\${reserved}`)})`;

/** A hex string of raw bytes. */
const hex = (bytes: string): string =>
  `<${Array.from(bytes, (character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('')}>`;

/** Three referenced objects, no markers, a single `startxref`. */
const CLEAN = [
  '%PDF-1.7',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '2 0 obj',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  'endobj',
  '3 0 obj',
  '<< /Type /Page /Parent 2 0 R >>',
  'endobj',
  'trailer',
  '<< /Root 1 0 R >>',
  'startxref',
  '0',
  '%%EOF',
  '',
].join('\n');

const CLEAN_MARKERS = [
  { kind: 'metadata', key: 'audit.clean.metadata' },
  { kind: 'xmp', key: 'audit.clean.xmp' },
  { kind: 'attachment', key: 'audit.clean.attachments' },
  { kind: 'annotation', key: 'audit.clean.annotations' },
  { kind: 'javascript', key: 'audit.clean.javascript' },
  { kind: 'structure', key: 'audit.clean.names' },
].map(({ kind, key }) => ({ kind, severity: 'info', key }));

describe('auditRedactedDocument', () => {
  it('reports a file without traces as a clean row for every check, in report order', async () => {
    const audit = await auditRedactedDocument(latin1(CLEAN), []);
    expect(audit.findings).toEqual([
      { kind: 'clean', severity: 'info', key: 'audit.clean.text', params: { terms: 0 } },
      { kind: 'clean', severity: 'info', key: 'audit.clean.revisions' },
      { kind: 'clean', severity: 'info', key: 'audit.clean.orphans' },
      { kind: 'clean', severity: 'info', key: 'audit.clean.compressed' },
      ...CLEAN_MARKERS,
    ]);
    expect(audit).toMatchObject({
      objectCount: 3,
      revisionCount: 1,
      incrementalChains: 0,
      bytes: CLEAN.length,
    });
  });

  it('counts a residual needle, says where it sits and never quotes it', async () => {
    const inObject = CLEAN.replace('/Page /Parent', '/Page /Title (GIZLI-4711 GIZLI-4711) /Parent');
    const audit = await auditRedactedDocument(latin1(inObject), ['GIZLI-4711']);
    expect(audit.findings[0]).toEqual({
      kind: 'residual-text',
      severity: 'content',
      key: 'audit.residual',
      params: { term: 1, count: 2 },
      where: 'object 3 0 R',
    });
    expect(JSON.stringify(audit)).not.toContain('GIZLI-4711');
    // The needle was found, so there is no "nothing found" row for the text check.
    expect(audit.findings.some((entry) => entry.key === 'audit.clean.text')).toBe(false);
  });

  it('names a byte offset for an occurrence in front of every object definition', async () => {
    const header = CLEAN.replace('%PDF-1.7', '%PDF-1.7\n%ERASEDHEAD');
    const audit = await auditRedactedDocument(latin1(header), ['ERASEDHEAD']);
    expect(audit.findings[0]).toMatchObject({
      kind: 'residual-text',
      where: `byte ${header.indexOf('ERASEDHEAD')}`,
    });
  });

  it('skips empty and repeated needles, numbers terms by the caller list and reports the ones not found', async () => {
    const inObject = CLEAN.replace('/Page /Parent', '/Page /Title (BETA) /Parent');
    const audit = await auditRedactedDocument(latin1(inObject), ['', 'ALFA', 'BETA', 'BETA', 'ALFA']);
    expect(audit.findings.slice(0, 2)).toEqual([
      {
        kind: 'residual-text',
        severity: 'content',
        key: 'audit.residual',
        params: { term: 3, count: 1 },
        where: 'object 3 0 R',
      },
      { kind: 'clean', severity: 'info', key: 'audit.clean.textRest', params: { terms: 1 } },
    ]);
  });

  it('reports a second revision and an /Prev chain as content that may still be present', async () => {
    const updated = `${CLEAN}4 0 obj\n<< /Prev 0 >>\nendobj\ntrailer\n<< /Root 1 0 R /Prev 0 /X 4 0 R >>\nstartxref\n9\n%%EOF\n`;
    const audit = await auditRedactedDocument(latin1(updated), []);
    const revision = audit.findings.find((entry) => entry.kind === 'previous-revision');
    expect(revision).toEqual({
      kind: 'previous-revision',
      severity: 'content',
      key: 'audit.revision',
      params: { revisions: 2, chains: 2 },
      where: `object 3 0 R`,
    });
    expect(audit).toMatchObject({ revisionCount: 2, incrementalChains: 2 });
  });

  it('reports an orphan that sits right in front of an xref stream, and not the stream itself', async () => {
    const orphaned = CLEAN.replace(
      'trailer',
      '9 0 obj\n<< /Length 4 >>\nendobj\n8 0 obj\n<< /Length 2 >>\nendobj\n7 0 obj\n<< /Type /XRef >>\nendobj\ntrailer',
    );
    const audit = await auditRedactedDocument(latin1(orphaned), []);
    const orphan = audit.findings.find((entry) => entry.kind === 'orphan-object');
    expect(orphan).toEqual({
      kind: 'orphan-object',
      severity: 'content',
      key: 'audit.orphan',
      params: { count: 2 },
      where: 'object 9 0 R',
    });
  });

  it('reports an orphan whose definition is cut off before its endobj', async () => {
    const truncated = `${CLEAN}9 0 obj\n<< /Length 4 >>`;
    const audit = await auditRedactedDocument(latin1(truncated), []);
    expect(audit.findings.find((entry) => entry.kind === 'orphan-object')).toMatchObject({
      params: { count: 1 },
      where: 'object 9 0 R',
    });
  });

  it('declines an orphan verdict while object streams hide the references', async () => {
    const withStream = CLEAN.replace('trailer', '5 0 obj\n<< /Type /ObjStm /N 1 >>\nendobj\ntrailer');
    const audit = await auditRedactedDocument(latin1(withStream), []);
    expect(
      audit.findings.find((entry) => entry.kind === 'structure' && entry.key === 'audit.orphans.skipped'),
    ).toEqual({
      kind: 'structure',
      severity: 'warning',
      key: 'audit.orphans.skipped',
      params: { streams: 1 },
      where: 'object 5 0 R',
    });
    expect(audit.findings.some((entry) => entry.kind === 'orphan-object')).toBe(false);
    expect(audit.findings.some((entry) => entry.key === 'audit.clean.orphans')).toBe(false);
  });

  it('says a compressed file cannot be fully scanned', async () => {
    const deflated = CLEAN.replace('/Page /Parent', '/Page /Filter /FlateDecode /Parent');
    const audit = await auditRedactedDocument(latin1(deflated), []);
    expect(audit.findings.find((entry) => entry.key === 'audit.compressed')).toEqual({
      kind: 'structure',
      severity: 'warning',
      key: 'audit.compressed',
      params: { count: 1 },
      where: 'object 3 0 R',
    });
  });

  it('reports each structural trace with its count and object', async () => {
    const traces = CLEAN.replace(
      '/Page /Parent',
      '/Page /Info 1 0 R /Annots [] /JavaScript (x) /EmbeddedFile /Names <</A 1>> /Extra (<?xpacket begin) /Parent',
    );
    const audit = await auditRedactedDocument(latin1(traces), []);
    const markers = audit.findings.filter(
      (entry) => CLEAN_MARKERS.some((row) => row.kind === entry.kind) && entry.kind !== 'clean',
    );
    expect(markers.filter((entry) => entry.kind !== 'structure' || entry.key === 'audit.names')).toEqual([
      {
        kind: 'metadata',
        severity: 'warning',
        key: 'audit.metadata',
        params: { count: 1 },
        where: 'object 3 0 R',
      },
      { kind: 'xmp', severity: 'warning', key: 'audit.xmp', params: { count: 1 }, where: 'object 3 0 R' },
      {
        kind: 'attachment',
        severity: 'warning',
        key: 'audit.attachment',
        params: { count: 1 },
        where: 'object 3 0 R',
      },
      {
        kind: 'annotation',
        severity: 'warning',
        key: 'audit.annotation',
        params: { count: 1 },
        where: 'object 3 0 R',
      },
      {
        kind: 'javascript',
        severity: 'warning',
        key: 'audit.javascript',
        params: { count: 1 },
        where: 'object 3 0 R',
      },
      {
        kind: 'structure',
        severity: 'info',
        key: 'audit.names',
        params: { count: 1 },
        where: 'object 3 0 R',
      },
    ]);
  });

  it('stops when the signal is already aborted, and between its passes', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(auditRedactedDocument(latin1(CLEAN), [], aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    // A signal that reports `aborted` from its n-th read on: the scan reads it once at the
    // start, once before the revision pass and once per marker check.
    const abortsAtRead = (limit: number): AbortSignal => {
      let reads = 0;
      return {
        get aborted() {
          reads += 1;
          return reads >= limit;
        },
      } as AbortSignal;
    };
    await expect(auditRedactedDocument(latin1(CLEAN), [], abortsAtRead(2))).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(auditRedactedDocument(latin1(CLEAN), [], abortsAtRead(3))).rejects.toMatchObject({
      name: 'AbortError',
    });
    const finished = await auditRedactedDocument(latin1(CLEAN), [], abortsAtRead(100));
    expect(finished.findings).toHaveLength(4 + CLEAN_MARKERS.length);
  });
});

/** `CLEAN` with `entry` spliced into object 3, the page. */
const inPage = (entry: string): string => CLEAN.replace('/Page /Parent', () => `/Page ${entry} /Parent`);

/** `CLEAN` with `objects` (whole definitions) in front of the trailer. */
const withObjects = (objects: string, base = CLEAN): string =>
  base.replace('trailer', () => `${objects}trailer`);

/** A stream object 5 around `body`, and whatever follows it. */
const streamObject = (dictionary: string, body: string, after = ''): string =>
  `5 0 obj\n<< ${dictionary} /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n${after}`;

const found = (term: number, count: number, where: string) => ({
  kind: 'residual-text',
  severity: 'content',
  key: 'audit.residual',
  params: { term, count },
  where,
});

describe('auditRedactedDocument: a needle the raw bytes do not spell', () => {
  const YASAR: [string, string][] = [
    ['a UTF-16BE literal /Alt', `/Alt ${literal(utf16be('Yaşar'))}`],
    ['a UTF-16BE hex /ActualText', `/ActualText ${hex(utf16be('Yaşar'))}`],
    [
      'an upper-case UTF-16BE hex string split by white space',
      `/V <${hex(utf16be('Yaşar')).slice(1, -1).toUpperCase().replace(/(..)/g, '$1 ')}>`,
    ],
    ['a UTF-8 literal behind a byte-order mark', `/T ${literal('\u00EF\u00BB\u00BFYa\u00C5\u009Far')}`],
    ['a UTF-16BE literal with a decomposed ş', `/Alt ${literal(utf16be('Yas\u0327ar'))}`],
    ['a UTF-16BE literal with a language tag', `/Alt ${literal(utf16be('\u001Ben\u001BYaşar'))}`],
    ['a UTF-16BE literal with a dangling last byte', `/Alt ${literal(`${utf16be('Yaşar')}\u0001`)}`],
  ];

  it.each(YASAR)('finds Yaşar written as %s, once, without quoting it', async (_form, entry) => {
    const audit = await auditRedactedDocument(latin1(inPage(entry)), ['Yaşar']);
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 3 0 R'));
    expect(audit.findings.some((row) => row.key === 'audit.clean.text')).toBe(false);
    expect(JSON.stringify(audit)).not.toContain('Yaşar');
  });

  it('matches in NFC: a decomposed needle finds a composed ş and the other way round', async () => {
    const composed = await auditRedactedDocument(latin1(inPage(`/Alt ${literal(utf16be('Yaşar'))}`)), [
      'Yas\u0327ar',
    ]);
    expect(composed.findings[0]).toEqual(found(1, 1, 'object 3 0 R'));
    const decomposed = await auditRedactedDocument(
      latin1(inPage(`/Alt ${literal(utf16be('Yas\u0327ar'))}`)),
      ['Yaşar'],
    );
    expect(decomposed.findings[0]).toEqual(found(1, 1, 'object 3 0 R'));
  });

  it('does not report a different word, and says the term was not found', async () => {
    const others = ['/Alt (Yasar)', `/Alt ${literal(utf16be('Yaşa'))}`, `/Alt ${hex(utf16be('Yaşa r'))}`];
    for (const entry of others) {
      const audit = await auditRedactedDocument(latin1(inPage(entry)), ['Yaşar']);
      expect(audit.findings[0]).toEqual({
        kind: 'clean',
        severity: 'info',
        key: 'audit.clean.text',
        params: { terms: 1 },
      });
    }
  });

  const SECRET: [string, string][] = [
    ['a hex string', '<534543524554>'],
    ['a hex string with white space and a line break', '<53 45 43\n52 45 54>'],
    ['a hex string with an odd last digit', '<5345435245545>'],
    ['a literal with an octal escape', '(SEC\\122ET)'],
    ['a literal with a line continuation', '(SE\\\nCRET)'],
    ['a literal with a CRLF line continuation', '(SE\\\r\nCRET)'],
    ['a literal with an escape that stands for itself', '(SEC\\RET)'],
    ['a literal with only octal escapes', '(\\123\\105\\103\\122\\105\\124)'],
    ['a UTF-16BE literal', literal(utf16be('SECRET'))],
  ];

  it.each(SECRET)('finds the ASCII word SECRET written as %s', async (_form, entry) => {
    const audit = await auditRedactedDocument(latin1(inPage(`/Title ${entry}`)), ['SECRET']);
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 3 0 R'));
  });

  it('does not read an escaped backslash or a newline escape as part of a word', async () => {
    for (const entry of ['(SEC\\\\RET)', '(SEC\\nRET)', '(SEC\\(RET)']) {
      const audit = await auditRedactedDocument(latin1(inPage(`/Title ${entry}`)), ['SECRET']);
      expect(audit.findings[0]).toMatchObject({ kind: 'clean', key: 'audit.clean.text' });
    }
  });

  const PDFDOC: [string, string][] = [
    ['€5 TL', '(fiyat \\2405 TL)'],
    ['Kırık', '(K\\232r\\232k)'],
    ['“Gizli”', '(\\215Gizli\\216)'],
    ['Gül', '(G\\374l)'],
    // The byte itself, not an escape: the raw search sees it, and the decoded one adds nothing.
    ['Gül', '(G\u00FCl)'],
  ];

  it.each(PDFDOC)('decodes PDFDocEncoding: %s is found once in %s', async (needle, entry) => {
    const audit = await auditRedactedDocument(latin1(inPage(`/Title ${entry}`)), [needle]);
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 3 0 R'));
  });

  const SYNTAX: [string, string, string][] = [
    ['a short octal escape', '(A\\53B)', 'A+B'],
    ['a nested balanced pair of parentheses', '(x(y)z)', 'x(y)z'],
    ['a backslash before a lone CR', '(SE\\\rCRET)', 'SECRET'],
    ['a raw CR, which reads as a line feed', '(SE\rCRET)', 'SE\nCRET'],
    ['a raw CRLF, which reads as one line feed', '(SE\r\nCRET)', 'SE\nCRET'],
  ];

  it.each(SYNTAX)('reads a literal string with %s as the reader does', async (_form, entry, needle) => {
    const audit = await auditRedactedDocument(latin1(inPage(`/Title ${entry}`)), [needle]);
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 3 0 R'));
  });

  it('keeps the text of a literal as text: a hex string spelled inside it is not a hex string', async () => {
    // Read by a parser that ended the literal at its first `)`, `<534543524554>` would be a
    // hex string and SECRET would be reported for text that only *shows* the digits.
    const audit = await auditRedactedDocument(latin1(inPage('/Title (a (b) <534543524554>)')), ['SECRET']);
    expect(audit.findings[0]).toEqual({
      kind: 'clean',
      severity: 'info',
      key: 'audit.clean.text',
      params: { terms: 1 },
    });
  });

  it('counts a place once however many searches see it, and names the earliest place', async () => {
    const file = inPage(`/B (SECRET) /C ${literal(utf16be('SECRET'))}`).replace(
      '/Type /Pages',
      () => '/Type /Pages /A <534543524554>',
    );
    const audit = await auditRedactedDocument(latin1(file), ['SECRET']);
    expect(audit.findings[0]).toEqual(found(1, 3, 'object 2 0 R'));
  });

  it('numbers terms by the caller list when only an encoded one is found', async () => {
    const audit = await auditRedactedDocument(latin1(inPage(`/Alt ${literal(utf16be('Yaşar'))}`)), [
      'ALFA',
      'Yaşar',
      'BETA',
    ]);
    expect(audit.findings.slice(0, 2)).toEqual([
      found(2, 1, 'object 3 0 R'),
      { kind: 'clean', severity: 'info', key: 'audit.clean.textRest', params: { terms: 2 } },
    ]);
  });

  it('reads the strings of an unfiltered stream, up to its endstream and no further', async () => {
    const hexText = '<534543524554>';
    const content = await auditRedactedDocument(
      latin1(withObjects(streamObject('', `BT [${hexText}] TJ ET`))),
      ['SECRET'],
    );
    expect(content.findings[0]).toEqual(found(1, 1, 'object 5 0 R'));

    // An unbalanced parenthesis in a stream's data must not swallow the next object's string,
    // whether the stream is filtered (skipped) or not (bounded by its endstream).
    for (const dictionary of ['/Filter /FlateDecode', '']) {
      const next = `6 0 obj\n<< /Alt ${hexText} >>\nendobj\n`;
      const audit = await auditRedactedDocument(
        latin1(withObjects(streamObject(dictionary, '\u0001\u0002(\u00FF\u00FE', next))),
        ['SECRET'],
      );
      expect(audit.findings[0]).toEqual(found(1, 1, 'object 6 0 R'));
    }
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])("starts a stream's data after the keyword and its %s", async (_name, eol) => {
    // The data's first bytes are the string: a start one byte early or late would cut it.
    const object = `5 0 obj${eol}<< /Length 20 >>${eol}stream${eol}<534543524554> Tj${eol}endstream${eol}endobj${eol}`;
    const audit = await auditRedactedDocument(latin1(withObjects(object)), ['SECRET']);
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 5 0 R'));
  });

  it('tolerates blanks between the stream keyword and its line break', async () => {
    const object = '5 0 obj\n<< /Length 20 >>\nstream \t\n<534543524554> Tj\nendstream\nendobj\n';
    const audit = await auditRedactedDocument(latin1(withObjects(object)), ['SECRET']);
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 5 0 R'));
  });

  it('reads the data of a stream that has no endstream up to the end of the file', async () => {
    const truncated = `${CLEAN}5 0 obj\n<< /Length 20 >>\nstream\nBT <534543524554> Tj`;
    const audit = await auditRedactedDocument(latin1(truncated), ['SECRET']);
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 5 0 R'));
  });

  it('reads a stream that sits in front of every object definition and says it is a byte offset', async () => {
    const file = CLEAN.replace(
      '%PDF-1.7\n',
      () => '%PDF-1.7\n<< /Length 20 >>\nstream\nBT <534543524554> Tj\nendstream\n',
    );
    const audit = await auditRedactedDocument(latin1(file), ['SECRET']);
    expect(audit.findings[0]).toEqual(found(1, 1, `byte ${file.indexOf('<534543524554>')}`));
  });

  it('finds a word with ş as UTF-8 bytes in an uncompressed XMP packet, once', async () => {
    const packet = '<x:xmpmeta><dc:title>Ya\u00C5\u009Far</dc:title></x:xmpmeta>';
    const audit = await auditRedactedDocument(
      latin1(withObjects(streamObject('/Type /Metadata /Subtype /XML', packet))),
      ['Yaşar'],
    );
    expect(audit.findings[0]).toEqual(found(1, 1, 'object 5 0 R'));
  });

  it('reads the text MuPDF writes: a UTF-16BE /Alt is found and a deleted last attachment is not one', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    let bytes: Uint8Array = new Uint8Array();
    try {
      const page = doc.addPage([0, 0, 200, 200], 0, doc.newDictionary(), '');
      doc.insertPage(-1, page);
      page.put('Alt', doc.newString('Yaşar Kırık'));
      const payload = new TextEncoder().encode('ATTACHED');
      doc.insertEmbeddedFile(
        'gizli.txt',
        doc.addEmbeddedFile('gizli.txt', 'text/plain', payload, new Date(0), new Date(0)),
      );
      doc.deleteEmbeddedFile('gizli.txt');
      bytes = savePdf(doc, 'garbage=compact');
    } finally {
      doc.destroy();
    }
    const audit = await auditRedactedDocument(bytes, ['Yaşar', 'Kırık', 'ATTACHED']);
    expect(audit.findings.slice(0, 3)).toEqual([
      { ...found(1, 1, ''), where: expect.stringMatching(/^object \d+ 0 R$/) },
      { ...found(2, 1, ''), where: expect.stringMatching(/^object \d+ 0 R$/) },
      { kind: 'clean', severity: 'info', key: 'audit.clean.textRest', params: { terms: 1 } },
    ]);
    expect(audit.findings.find((row) => row.kind === 'attachment')).toEqual({
      kind: 'attachment',
      severity: 'info',
      key: 'audit.clean.attachments',
    });
  });
});

describe('auditRedactedDocument: object definitions and line ends', () => {
  const orphaned = `${CLEAN}9 0 obj\n<< /Length 4 >>\nendobj\n`;

  it.each([
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['LF', '\n'],
  ])('counts every object of a file with %s line ends and reports its orphan', async (_name, eol) => {
    const audit = await auditRedactedDocument(latin1(orphaned.replace(/\n/g, eol)), []);
    expect(audit.objectCount).toBe(4);
    expect(audit.findings.find((row) => row.kind === 'orphan-object')).toEqual({
      kind: 'orphan-object',
      severity: 'content',
      key: 'audit.orphan',
      params: { count: 1 },
      where: 'object 9 0 R',
    });
    expect(audit.findings.some((row) => row.key === 'audit.clean.orphans')).toBe(false);
  });

  it('gives a CR-only file the report of the same file with LF line ends, objects located', async () => {
    const withTitle = inPage('/Title (GIZLI-4711)');
    const lf = await auditRedactedDocument(latin1(withTitle), ['GIZLI-4711']);
    const cr = await auditRedactedDocument(latin1(withTitle.replace(/\n/g, '\r')), ['GIZLI-4711']);
    expect(cr.objectCount).toBe(3);
    expect(cr.findings).toEqual(lf.findings);
    expect(cr.findings[0]).toEqual(found(1, 1, 'object 3 0 R'));
  });

  it('counts an object that opens the file', async () => {
    const audit = await auditRedactedDocument(latin1(CLEAN.replace('%PDF-1.7\n', '')), []);
    expect(audit.objectCount).toBe(3);
  });
});

describe('auditRedactedDocument: the attachment check', () => {
  const inCatalog = (names: string, objects = ''): Uint8Array =>
    latin1(
      withObjects(
        objects,
        CLEAN.replace('/Type /Catalog', () => `/Type /Catalog /Names ${names}`),
      ),
    );

  const attachmentRow = async (file: Uint8Array) =>
    (await auditRedactedDocument(file, [])).findings.find((row) => row.kind === 'attachment');

  const EMPTY: [string, string, string][] = [
    ['what MuPDF leaves after the last deletion', '<</EmbeddedFiles<</Names[]>>>>', ''],
    ['an empty /Names array', '<< /EmbeddedFiles << /Names [ ] >> >>', ''],
    ['an empty /Kids array', '<< /EmbeddedFiles << /Kids [] >> >>', ''],
    ['an empty dictionary', '<< /EmbeddedFiles << >> >>', ''],
    [
      'an empty tree in an indirect object',
      '<< /EmbeddedFiles 7 0 R >>',
      '7 0 obj\n<< /Names [] >>\nendobj\n',
    ],
  ];

  it.each(EMPTY)('reports no attachment for %s', async (_form, names, objects) => {
    expect(await attachmentRow(inCatalog(names, objects))).toEqual({
      kind: 'attachment',
      severity: 'info',
      key: 'audit.clean.attachments',
    });
  });

  const FILLED: [string, string, string][] = [
    ['a name', '<< /EmbeddedFiles << /Names [(a.txt) 5 0 R] >> >>', ''],
    ['a kid', '<< /EmbeddedFiles << /Kids [5 0 R] >> >>', ''],
    [
      'a name in an indirect object',
      '<< /EmbeddedFiles 7 0 R >>',
      '7 0 obj\n<< /Names [(a.txt) 5 0 R] >>\nendobj\n',
    ],
    ['an object nothing defines', '<< /EmbeddedFiles 99 0 R >>', ''],
  ];

  it.each(FILLED)('still reports an attachment for a tree with %s', async (_form, names, objects) => {
    expect(await attachmentRow(inCatalog(names, objects))).toEqual({
      kind: 'attachment',
      severity: 'warning',
      key: 'audit.attachment',
      params: { count: 1 },
      where: 'object 1 0 R',
    });
  });

  it('counts every attached file stream and names the first one', async () => {
    const attached = (number: number): string =>
      `${number} 0 obj\n<< /Type /EmbeddedFile /Length 0 >>\nstream\n\nendstream\nendobj\n`;
    expect(
      await attachmentRow(inCatalog('<</EmbeddedFiles<</Names[]>>>>', attached(6) + attached(7))),
    ).toEqual({
      kind: 'attachment',
      severity: 'warning',
      key: 'audit.attachment',
      params: { count: 2 },
      where: 'object 6 0 R',
    });
  });

  it('counts an attached file stream even when the tree beside it is empty', async () => {
    const attached = '6 0 obj\n<< /Type /EmbeddedFile /Length 0 >>\nstream\n\nendstream\nendobj\n';
    expect(await attachmentRow(inCatalog('<</EmbeddedFiles<</Names[]>>>>', attached))).toEqual({
      kind: 'attachment',
      severity: 'warning',
      key: 'audit.attachment',
      params: { count: 1 },
      where: 'object 6 0 R',
    });
  });
});
