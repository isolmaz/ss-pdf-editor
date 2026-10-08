/**
 * The PDF/UA check and its quick fixes against real bytes. What matters: an untagged file fails
 * the tagging rules and a tagged one passes them, manual rules are never reported as passed, each
 * fix is read back from the file (Info, XMP, catalog) and not from the report, and the
 * `pdfuaid` identifier is written only when every automated rule passes.
 */

import { describe, expect, it } from 'vitest';
import { readXmpPacket } from './accessibility';
import {
  checkPdfUa,
  type FixState,
  fixPdfUa,
  isRegularTable,
  type PdfUaReport,
  ruleKey,
  UA_RULES,
  type UaInstance,
  verifyFixes,
  verifyUaPart,
} from './pdfua';
import { editStructure, readStructure } from './structure';
import { buildTagged, mutate, type TNode, type TSpec, tagged } from './tagged.fixtures';
import type { OperationContext } from './types';
import { run, taggedFixture, untaggedFixture } from './ua.fixtures';
import { buildUaPacket, readUaPart, readXmpTitle } from './ua-xmp';

const states = (report: PdfUaReport): Record<string, string> =>
  Object.fromEntries(report.rules.map((rule) => [rule.id, rule.state]));

async function open(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  return doc;
}

/** A stream dictionary no reader can decode: a predictor over a column count that is not positive. */
const UNDECODABLE = {
  Filter: 'FlateDecode',
  DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
};

/** Run `read` on the re-opened bytes and release the document. */
async function mutateRead<T>(
  bytes: Uint8Array,
  read: (doc: Awaited<ReturnType<typeof open>>) => T,
): Promise<T> {
  const doc = await open(bytes);
  try {
    return read(doc);
  } finally {
    doc.destroy();
  }
}

/** The catalog facts the fixes write, read straight from the object model. */
async function catalogFacts(bytes: Uint8Array) {
  const doc = await open(bytes);
  try {
    const root = doc.getTrailer().get('Root');
    const packet = readXmpPacket(root);
    const preferences = root.get('ViewerPreferences');
    const display = preferences.isNull() ? null : preferences.get('DisplayDocTitle');
    return {
      infoTitle: doc.getMetaData('info:Title') ?? null,
      lang: root.get('Lang').isNull() ? null : root.get('Lang').asString(),
      displayDocTitle: display === null || display.isNull() ? null : display.asBoolean(),
      xmpTitle: packet === null ? null : readXmpTitle(packet),
      uaPart: packet === null ? null : readUaPart(packet),
    };
  } finally {
    doc.destroy();
  }
}

describe('checkPdfUa', () => {
  it('fails an untagged file on the tagging rules and leaves the rules that need a tree unchecked', async () => {
    const report = await checkPdfUa(await untaggedFixture(), run);
    expect(report.tagged).toBe(false);
    expect(report.automatedPass).toBe(false);
    expect(report.title).toBeNull();
    expect(report.lang).toBeNull();
    expect(states(report)).toMatchObject({
      marked: 'fail',
      title: 'fail',
      lang: 'fail',
      'pdfua-id': 'fail',
      'struct-tree': 'fail',
      'tagged-content': 'fail',
      headings: 'unchecked',
      'figure-alt': 'unchecked',
    });
    expect(report.rules.map((rule) => rule.id)).toEqual(UA_RULES.map((rule) => rule.id));
  });

  it('passes the tagging rules of a tagged file, fails what only a person can add, and never passes a manual rule', async () => {
    const report = await checkPdfUa(await taggedFixture('en-US'), run);
    expect(report.tagged).toBe(true);
    expect(report.lang).toBe('en-US');
    expect(states(report)).toMatchObject({
      marked: 'pass',
      lang: 'pass',
      'struct-tree': 'pass',
      'role-map': 'pass',
      'tagged-content': 'pass',
      'mcid-references': 'pass',
      headings: 'pass',
      'font-embedded': 'pass',
      title: 'fail',
      'display-title': 'fail',
      'figure-alt': 'fail',
      'pdfua-id': 'fail',
    });
    expect(report.rules.find((rule) => rule.id === 'figure-alt')?.count).toBe(2);
    // A rule only a person can decide is never reported as passed ('alt-quality' is n/a: no alt text yet).
    const manual = report.rules.filter((entry) => entry.manual);
    expect(manual.map((rule) => rule.id)).toEqual(['reading-order', 'alt-quality', 'contrast', 'lang-parts']);
    expect(manual.map((rule) => rule.state)).toEqual(['manual', 'na', 'manual', 'manual']);
    // The summary counts every rule exactly once.
    const { summary } = report;
    expect(summary.pass + summary.fail + summary.manual + summary.na + summary.unchecked).toBe(
      report.rules.length,
    );
    expect(report.automatedPass).toBe(false);
  });

  it('flags a heading level that is skipped', async () => {
    const tagged = await taggedFixture();
    const model = (await readStructure(tagged, run)).model;
    const paragraph = model.roots[0]?.kids.flatMap((kid) =>
      kid.kind === 'element' && kid.node.role === 'P' ? [kid.node.key] : [],
    )[0];
    const skipped = await editStructure(tagged, [{ op: 'role', key: paragraph as string, role: 'H3' }], run);
    const headings = (await checkPdfUa(skipped.bytes, run)).rules.find((rule) => rule.id === 'headings');
    expect(headings?.state).toBe('fail');
    expect(headings?.instances[0]).toMatchObject({ reason: 'skip', params: { from: 1, to: 3 } });
  });
});

describe('fixPdfUa', () => {
  it('writes title, language and DisplayDocTitle, and they read back from the file', async () => {
    const untagged = await untaggedFixture();
    expect(await catalogFacts(untagged)).toEqual({
      infoTitle: null,
      lang: null,
      displayDocTitle: null,
      xmpTitle: null,
      uaPart: null,
    });
    const out = await fixPdfUa(
      untagged,
      [{ kind: 'title', title: 'Yıllık Rapor' }, { kind: 'display-title' }, { kind: 'lang', lang: 'tr-TR' }],
      run,
    );
    expect(await catalogFacts(out.bytes)).toEqual({
      infoTitle: 'Yıllık Rapor',
      lang: 'tr-TR',
      displayDocTitle: true,
      xmpTitle: 'Yıllık Rapor',
      uaPart: null,
    });
    const report = await checkPdfUa(out.bytes, run);
    expect(states(report)).toMatchObject({ title: 'pass', 'display-title': 'pass', lang: 'pass' });
    await expect(fixPdfUa(untagged, [], run)).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('does not declare PDF/UA while an automated rule still fails, and says how many', async () => {
    const out = await fixPdfUa(
      await taggedFixture(),
      [{ kind: 'title', title: 'Annual Report' }, { kind: 'display-title' }, { kind: 'mark-pdfua' }],
      run,
    );
    const refusal = out.report.notes.find((entry) => entry.key === 'op.note.ua.markRefused');
    expect(refusal?.params).toEqual({ count: 1 }); // the two figures still lack alternative text
    expect(out.report.notes.some((entry) => entry.key === 'op.note.ua.uaMarked')).toBe(false);
    // The other fixes still landed, and no identifier is in the packet.
    expect(await catalogFacts(out.bytes)).toMatchObject({
      xmpTitle: 'Annual Report',
      displayDocTitle: true,
      uaPart: null,
    });
    expect((await checkPdfUa(out.bytes, run)).declaredPart).toBeNull();
  });

  it('declares PDF/UA-1 once every automated rule passes, and keeps a declaration that is already there', async () => {
    const tagged = await taggedFixture();
    const model = (await readStructure(tagged, run)).model;
    const figures = (model.roots[0]?.kids ?? []).flatMap((kid) =>
      kid.kind === 'element' && kid.node.role === 'Figure' ? [kid.node.key] : [],
    );
    const withAlt = await editStructure(
      tagged,
      figures.map((key) => ({ op: 'alt' as const, key, alt: 'A grey square' })),
      run,
    );
    const out = await fixPdfUa(
      withAlt.bytes,
      [{ kind: 'title', title: 'Annual Report' }, { kind: 'display-title' }, { kind: 'mark-pdfua' }],
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.ua.uaMarked');
    expect((await catalogFacts(out.bytes)).uaPart).toBe(1);
    const report = await checkPdfUa(out.bytes, run);
    expect(report.declaredPart).toBe(1);
    expect(report.automatedPass).toBe(true);
    expect(states(report)['pdfua-id']).toBe('pass');

    const again = await fixPdfUa(out.bytes, [{ kind: 'mark-pdfua' }], run);
    expect(again.report.notes.map((entry) => entry.key)).toContain('op.note.ua.uaKept');
    expect((await catalogFacts(again.bytes)).uaPart).toBe(1);
  });
});

/** The check of a file built from `spec`, and one rule's verdict. */
async function checked(spec: TSpec) {
  const built = await buildTagged(spec);
  const report = await checkPdfUa(built.bytes, run);
  const rule = (id: string) => {
    const found = report.rules.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no rule ${id}`);
    return found;
  };
  return { report, rule, built };
}

const reasons = (instances: readonly UaInstance[]) => instances.map((entry) => entry.reason);

/** A tagged page: `count` paragraphs, one marked-content id each. */
const PAGE = { content: tagged('P', 0, 'BT /F 12 Tf 10 100 Td (Hello) Tj ET') };

describe('headings', () => {
  it('flags a plain H mixed with numbered headings and a first heading that is not H1', async () => {
    const mixed = await checked({
      pages: [PAGE],
      tree: [{ s: 'Document', k: [{ s: 'H1' }, { s: 'H' }] }],
    });
    expect(mixed.rule('headings').state).toBe('fail');
    expect(reasons(mixed.rule('headings').instances)).toEqual(['mixed']);

    const first = await checked({ pages: [PAGE], tree: [{ s: 'Document', k: [{ s: 'H2' }, { s: 'H3' }] }] });
    expect(first.rule('headings').instances).toMatchObject([{ reason: 'first', params: { level: 2 } }]);

    const fine = await checked({ pages: [PAGE], tree: [{ s: 'Document', k: [{ s: 'H' }, { s: 'H' }] }] });
    expect(fine.rule('headings').state).toBe('pass');
  });
});

describe('table rules', () => {
  const cell = (s: 'TH' | 'TD', extra: Partial<TNode> = {}): TNode => ({ s, ...extra });
  const table = (...kids: TNode[]): TSpec => ({
    pages: [PAGE],
    tree: [{ s: 'Document', k: [{ s: 'Table', k: kids }] }],
  });

  it('reports every way a table is built wrong, each with its own reason', async () => {
    const loose = await checked({
      pages: [PAGE],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'TD' },
            { s: 'TR', k: [{ s: 'P' }] },
            {
              s: 'Table',
              k: [{ s: 'THead', k: [{ s: 'P' }] }, { s: 'P' }, { s: 'TFoot' }, { s: 'Caption' }],
            },
          ],
        },
      ],
    });
    expect(loose.rule('table-structure').state).toBe('fail');
    expect(reasons(loose.rule('table-structure').instances)).toEqual([
      'cell-outside-row',
      'row-outside-table',
      'row-child',
      'table-child',
      'part-child',
    ]);
    expect(loose.rule('table-structure').instances[0]).toMatchObject({ params: { role: 'TD' } });
  });

  it('accepts rows inside THead, TBody and TFoot and counts the tables', async () => {
    const good = await checked(
      table(
        { s: 'Caption' },
        { s: 'THead', k: [{ s: 'TR', k: [cell('TH', { attrs: { scope: 'Column' } })] }] },
        { s: 'TBody', k: [{ s: 'TR', k: [cell('TD', { attrs: { headers: ['h1'] } })] }] },
        { s: 'TFoot', k: [{ s: 'TR', k: [cell('TD', { attrs: { headers: ['h1'] } })] }] },
      ),
    );
    expect(good.rule('table-structure')).toMatchObject({ state: 'pass', params: { tables: 1 } });
    expect(good.rule('table-headers').state).toBe('pass');
    expect(good.rule('table-scope').state).toBe('pass');
    expect(good.rule('table-regular').state).toBe('pass');
  });

  it('fails a table with no header cell, a header cell without scope or links, and a lacking cell in an irregular grid', async () => {
    const noHeader = await checked(table({ s: 'TR', k: [cell('TD')] }));
    expect(noHeader.rule('table-headers').state).toBe('fail');

    const unscoped = await checked(table({ s: 'TR', k: [cell('TH'), cell('TH')] }));
    expect(unscoped.rule('table-scope')).toMatchObject({
      state: 'fail',
      instances: [{ params: { count: 2 } }],
    });

    // A header the data cells point at through /Headers needs no scope.
    const linked = await checked(
      table(
        { s: 'TR', k: [cell('TH', { id: 'colA' })] },
        { s: 'TR', k: [cell('TD', { attrs: { headers: ['colA'] } })] },
      ),
    );
    expect(linked.rule('table-scope').state).toBe('pass');

    // Rows of different width: the two data cells have neither scope nor /Headers behind them.
    const ragged = await checked(
      table(
        { s: 'TR', k: [cell('TH', { attrs: { scope: 'Row' } }), cell('TD'), cell('TD')] },
        { s: 'TR', k: [cell('TD')] },
      ),
    );
    expect(ragged.rule('table-regular')).toMatchObject({
      state: 'fail',
      instances: [{ params: { count: 3 } }],
    });

    // Ragged too, but every data cell names its headers: nothing is lacking, so the table is not reported.
    const linkedRagged = await checked(
      table(
        {
          s: 'TR',
          k: [cell('TH', { id: 'a', attrs: { scope: 'Row' } }), cell('TD', { attrs: { headers: ['a'] } })],
        },
        { s: 'TR', k: [cell('TD', { attrs: { headers: ['a'] } })] },
      ),
    );
    expect(linkedRagged.rule('table-regular').state).toBe('pass');

    // A paragraph inside a row is reported, and takes no part in the grid.
    const stray = await checked(table({ s: 'TR', k: [cell('TH', { attrs: { scope: 'Row' } }), { s: 'P' }] }));
    expect(reasons(stray.rule('table-structure').instances)).toEqual(['row-child']);
  });

  it('lays out row and column spans: a rectangle is regular, a hole or a short row is not', async () => {
    const node = (colSpan: number, rowSpan: number) =>
      ({ node: { colSpan, rowSpan }, header: false }) as never;
    expect(isRegularTable([])).toBe(true);
    expect(isRegularTable([[node(2, 1)], [node(1, 1), node(1, 1)]])).toBe(true);
    // A cell spanning two rows pushes the next row's first cell one column right.
    expect(isRegularTable([[node(1, 2), node(1, 1)], [node(1, 1)]])).toBe(true);
    // The second row is one column short.
    expect(isRegularTable([[node(1, 1), node(1, 1)], [node(1, 1)]])).toBe(false);
    // Same widths, but the middle column of the second row is empty (the third column is spanned from above).
    expect(isRegularTable([[node(1, 1), node(1, 1), node(1, 2)], [node(1, 1)]])).toBe(false);
  });
});

describe('list rules', () => {
  it('reports a list item outside a list, a list child that is not an item, and a broken item', async () => {
    const found = await checked({
      pages: [PAGE],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'L', k: [{ s: 'P' }, { s: 'LI', k: [{ s: 'Lbl' }, { s: 'P' }] }] },
            { s: 'LI', k: [{ s: 'LBody' }] },
            { s: 'Lbl' },
          ],
        },
      ],
    });
    expect(found.rule('list-structure').state).toBe('fail');
    expect(reasons(found.rule('list-structure').instances)).toEqual([
      'list-child',
      'item-child',
      'no-body',
      'item-outside-list',
      'part-outside-item',
    ]);
    const good = await checked({
      pages: [PAGE],
      tree: [{ s: 'Document', k: [{ s: 'L', k: [{ s: 'LI', k: [{ s: 'Lbl' }, { s: 'LBody' }] }] }] }],
    });
    expect(good.rule('list-structure')).toMatchObject({ state: 'pass', params: { lists: 1 } });
  });
});

describe('role map rules', () => {
  it('flags a standard type that is remapped, a loop, and a custom type nothing maps — once each', async () => {
    const found = await checked({
      pages: [PAGE],
      roleMap: { P: 'H1', Loop1: 'Loop2', Loop2: 'Loop1', Fine: 'Sect', Dangling: 'Nowhere' },
      tree: [{ s: 'Document', k: [{ s: 'Fine' }, { s: 'Weird' }, { s: 'Weird' }, { s: 'Dangling' }] }],
    });
    const role = found.rule('role-map');
    expect(role.state).toBe('fail');
    expect(role.instances).toMatchObject([
      { reason: 'remapped', params: { role: 'P', to: 'H1' } },
      { reason: 'unresolved', params: { role: 'Loop1', to: 'Loop2' } },
      { reason: 'unresolved', params: { role: 'Loop2', to: 'Loop1' } },
      { reason: 'unresolved', params: { role: 'Dangling', to: 'Nowhere' } },
      { reason: 'unmapped', params: { role: 'Weird' } },
    ]);
  });
});

describe('document rules', () => {
  const XMP_WITHOUT_TITLE =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>';
  const withXmp =
    (packet: string): TSpec['setup'] =>
    (doc, root) => {
      root.put(
        'Metadata',
        doc.addRawStream(new TextEncoder().encode(packet), { Type: 'Metadata', Subtype: 'XML' }),
      );
    };

  it('tells a title that only the Info dictionary has from one the XMP packet carries, and reads a wrong UA part', async () => {
    const none = await checked({ pages: [PAGE] });
    expect(none.rule('title').instances).toEqual([{ reason: 'none' }]);
    const infoOnly = await checked({ pages: [PAGE], title: 'Report' });
    expect(infoOnly.rule('title')).toMatchObject({
      state: 'fail',
      instances: [{ reason: 'info-only-no-xmp' }],
      params: { title: 'Report' },
    });
    expect(infoOnly.report.title).toBe('Report');
    const withPacket = await checked({ pages: [PAGE], title: 'Report', setup: withXmp(XMP_WITHOUT_TITLE) });
    expect(withPacket.rule('title').instances).toEqual([{ reason: 'info-only' }]);
    const other = await checked({
      pages: [PAGE],
      setup: withXmp(buildUaPacket({ title: 'Report', uaPart: 2 })),
    });
    expect(other.rule('title').state).toBe('pass');
    expect(other.rule('pdfua-id')).toMatchObject({
      state: 'fail',
      instances: [{ reason: 'other', params: { part: 2 } }],
    });
    expect(other.report.declaredPart).toBe(2);
    expect(other.report.title).toBe('Report');
    expect(none.rule('pdfua-id').instances).toEqual([{ reason: 'none', params: { part: 0 } }]);
  });

  it('rejects a /Lang that is not a language tag and accepts the grandfathered x- form', async () => {
    const bad = await checked({ pages: [PAGE], lang: 'not a tag!' });
    expect(bad.rule('lang')).toMatchObject({
      state: 'fail',
      instances: [{ reason: 'invalid', params: { lang: 'not a tag!' } }],
    });
    expect(bad.report.lang).toBe('not a tag!');
    expect((await checked({ pages: [PAGE], lang: 'i-klingon' })).rule('lang').state).toBe('pass');
    expect((await checked({ pages: [PAGE], lang: 'zh-Hant-TW' })).rule('lang')).toMatchObject({
      state: 'pass',
      params: { lang: 'zh-Hant-TW' },
    });
  });

  it('fails an encrypted file that withholds accessibility extraction and passes one that allows it; XFA fails', async () => {
    const save = (permissions: number) =>
      `encrypt=aes-128,owner-password=owner,user-password=,permissions=${String(permissions)}`;
    // Bit 10 (512) is "extract for accessibility".
    const blocked = await checked({ pages: [PAGE], save: save(-3904) });
    expect(-3904 & 512).toBe(0);
    expect(blocked.rule('encryption').state).toBe('fail');
    const allowed = await checked({ pages: [PAGE], save: save(-3392) });
    expect(-3392 & 512).toBe(512);
    expect(allowed.rule('encryption').state).toBe('pass');
    expect((await checked({ pages: [PAGE] })).rule('encryption').state).toBe('na');

    expect((await checked({ pages: [PAGE], acroForm: { XFA: [] } })).rule('xfa').state).toBe('fail');
    expect((await checked({ pages: [PAGE], acroForm: {} })).rule('xfa').state).toBe('pass');
    expect((await checked({ pages: [PAGE] })).rule('xfa').state).toBe('na');
  });

  it('counts bookmarks: not needed up to 20 pages, required beyond', async () => {
    const pages = (count: number) => Array.from({ length: count }, () => PAGE);
    expect((await checked({ pages: pages(2), outlines: true })).rule('bookmarks').state).toBe('pass');
    expect((await checked({ pages: pages(2) })).rule('bookmarks').state).toBe('na');
    const long = await checked({ pages: pages(21) });
    expect(long.rule('bookmarks')).toMatchObject({ state: 'fail', instances: [{ params: { pages: 21 } }] });
    expect((await checked({ pages: pages(21), outlines: true })).rule('bookmarks').state).toBe('pass');
  });

  it('reports a structure root that is not a dictionary as unreadable, and a missing one as none', async () => {
    const broken = await checked({ pages: [PAGE], tree: [{ s: 'Document' }], rootAsName: true });
    expect(broken.rule('struct-tree').instances).toEqual([{ reason: 'unreadable' }]);
    expect(broken.report.tagged).toBe(false);
    expect(broken.rule('headings').state).toBe('unchecked');
    expect(broken.rule('reading-order').instances).toEqual([{ reason: 'untagged' }]);
    expect((await checked({ pages: [PAGE] })).rule('struct-tree').instances).toEqual([{ reason: 'none' }]);
  });

  it('leaves the rules that need the whole tree unchecked, saying truncated, when the walk stops at its depth bound', async () => {
    let deep: TNode = { s: 'P', k: [0] };
    for (let level = 0; level < 70; level += 1) deep = { s: 'Sect', k: [deep] };
    const found = await checked({ pages: [PAGE], tree: [deep] });
    expect(found.report.tagged).toBe(true);
    expect(found.rule('role-map')).toMatchObject({
      state: 'unchecked',
      instances: [{ reason: 'truncated' }],
    });
    expect(found.rule('mcid-references').state).toBe('unchecked');
    expect(found.rule('alt-quality').state).toBe('na');
  });
});

describe('content rules', () => {
  const text = (body: string) => `BT /F 12 Tf 10 100 Td (${body}) Tj ET`;
  const HELV = { F: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } } };

  it('matches the marked content of each page against the tree: orphans, danglers, duplicates and a missing /StructParents', async () => {
    const orphan = await checked({
      pages: [
        { content: tagged('P', 0, text('a')) + tagged('P', 5, text('b')), fonts: HELV, structParents: 0 },
      ],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [0] }] }],
      parentTree: true,
    });
    expect(orphan.rule('mcid-references').instances).toEqual([
      { pageIndex: 0, reason: 'orphan', params: { count: 1 } },
    ]);

    const dangling = await checked({
      pages: [{ content: tagged('P', 0, text('a')), fonts: HELV, structParents: 0 }],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [0, 7] }] }],
      parentTree: true,
    });
    expect(dangling.rule('mcid-references').instances).toEqual([
      { pageIndex: 0, reason: 'dangling', params: { count: 1 } },
    ]);

    const duplicate = await checked({
      pages: [{ content: tagged('P', 0, text('a')), fonts: HELV, structParents: 0 }],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'P', pg: 0, k: [0] },
            { s: 'P', pg: 0, k: [{ mcr: 0 }] },
          ],
        },
      ],
      parentTree: true,
    });
    expect(duplicate.rule('mcid-references').instances).toEqual([
      { pageIndex: 0, reason: 'duplicate', params: { count: 1 } },
    ]);

    const noParents = await checked({
      pages: [{ content: tagged('P', 0, text('a')), fonts: HELV }],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [0] }] }],
    });
    expect(reasons(noParents.rule('mcid-references').instances)).toEqual([
      'no-parent-tree',
      'no-struct-parents',
    ]);

    // Content in a form XObject (/Stm) is outside what a page-level count can match.
    const streamed = await checked({
      pages: [{ content: tagged('P', 0, text('a')), fonts: HELV, structParents: 0 }],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [0, { mcr: 9, stm: true }] }] }],
      parentTree: true,
    });
    expect(streamed.rule('mcid-references').state).toBe('pass');
  });

  it('counts unmarked content by kind, descends into form XObjects, and reports a page it cannot read', async () => {
    const found = await checked({
      pages: [
        {
          content: `${text('loose')}\n0 0 10 10 re f\nq 20 0 0 20 0 0 cm /Im1 Do Q\n/Fm1 Do\n/Missing Do\n/Fm2 Do\nBI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI\n0 0 m 5 5 l S`,
          fonts: HELV,
          image: true,
          forms: {
            Fm1: { content: 'BT /F 12 Tf (inside) Tj ET', fonts: HELV },
            Fm2: { content: '/Fm2 Do' },
          },
        },
        { content: ']' },
      ],
      tree: [{ s: 'Document' }],
      parentTree: true,
    });
    const tagged_ = found.rule('tagged-content');
    expect(tagged_.state).toBe('fail');
    expect(tagged_.instances).toEqual([
      // text: "loose" + the form's "inside"; paths: the rectangle and the line; images: the picture, the inline one and
      // the XObject no resource names; 1 other: the form that draws itself is entered once, its second visit counts as one.
      { pageIndex: 0, params: { count: 8, text: 2, paths: 2, images: 3 } },
      { pageIndex: 1, reason: 'unreadable' },
    ]);
    // An unreadable page does not stop the other checks; its characters are simply not measured.
    expect(found.rule('font-embedded').state).toBe('fail');
  });

  it('says tagged content is unchecked, not passed, when every page is unreadable', async () => {
    const found = await checked({ pages: [{ content: ']' }], tree: [{ s: 'Document' }], parentTree: true });
    expect(found.rule('tagged-content')).toMatchObject({
      state: 'unchecked',
      instances: [{ pageIndex: 0, reason: 'unreadable' }],
    });
  });

  it('flags a tagged sequence inside an artifact and an artifact inside a tagged one, per page', async () => {
    const found = await checked({
      pages: [
        {
          content: `/Artifact <</MCID 3>> BDC\n/P <</MCID 0>> BDC\n${text('a')}\nEMC\nEMC\n/P <</MCID 1>> BDC\n/Artifact BMC\n${text('b')}\nEMC\nEMC\n/Artifact BMC\n/P <</MCID 2>> BDC\n${text('c')}\nEMC\nEMC`,
          fonts: HELV,
        },
      ],
      tree: [{ s: 'Document' }],
    });
    expect(found.rule('artifact-nesting')).toMatchObject({
      state: 'fail',
      instances: [{ pageIndex: 0, params: { count: 4 } }],
    });
  });

  it('finds a page that is one big picture with no text', async () => {
    const picture = '/Artifact BMC q 190 0 0 190 5 5 cm /Im1 Do Q EMC';
    const found = await checked({
      pages: [
        { content: picture, image: true },
        { content: picture + tagged('P', 0, text('x')), image: true, fonts: HELV },
      ],
      tree: [{ s: 'Document' }],
    });
    expect(found.rule('image-only').instances).toEqual([{ pageIndex: 0 }]);
    const small = await checked({
      pages: [{ content: 'q 20 0 0 20 5 5 cm /Im1 Do Q', image: true }],
      tree: [{ s: 'Document' }],
    });
    expect(small.rule('image-only').state).toBe('pass');
  });
});

describe('font rules', () => {
  const use = (...names: string[]) =>
    names.map((name, index) => tagged('P', index, `BT /${name} 12 Tf (a) Tj ET`)).join('');
  const toUnicode = (body: string) => `/CIDInit /ProcSet findresource begin begincmap\n${body}\nendcmap`;

  it('judges embedding and a Unicode route per font, for every kind of font and encoding', async () => {
    const mupdfFile = (doc: import('mupdf').PDFDocument) => doc.addStream('program', {});
    const fonts = {
      Plain: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica' } },
      Mystery: { dict: { Subtype: 'Type1', BaseFont: 'Mystery' } },
      Proc: { dict: { Subtype: 'Type3' } },
      Sub: {
        build: (doc: import('mupdf').PDFDocument) =>
          doc.addObject({
            Type: 'Font',
            Subtype: 'TrueType',
            BaseFont: 'ABCDEF+Sub',
            Encoding: 'WinAnsiEncoding',
            FontDescriptor: doc.addObject({
              Type: 'FontDescriptor',
              FontName: 'Sub',
              Flags: 32,
              FontFile2: mupdfFile(doc),
            }),
          }),
      },
      BadChar: {
        dict: { Subtype: 'Type1', BaseFont: 'Bad1' },
        toUnicode: toUnicode('1 beginbfchar\n<01> <FFFD>\nendbfchar'),
      },
      BadChar2: {
        dict: { Subtype: 'Type1', BaseFont: 'Bad2' },
        toUnicode: toUnicode('1 beginbfchar\n<4142> <0000>\nendbfchar'),
      },
      BadRange: {
        dict: { Subtype: 'Type1', BaseFont: 'Bad3' },
        toUnicode: toUnicode('1 beginbfrange\n<0001> <0003> <FFFE>\nendbfrange'),
      },
      BadArray: {
        dict: { Subtype: 'Type1', BaseFont: 'Bad4' },
        toUnicode: toUnicode('1 beginbfrange\n<0001> <0002> [<0041> <0000>]\nendbfrange'),
      },
      Good: {
        dict: { Subtype: 'Type1', BaseFont: 'Good1' },
        toUnicode: toUnicode(
          '3 beginbfchar\n<01> <0041>\n<>  <0041>\n<02>\nendbfchar\n1 beginbfrange\n<0001> <0003> <0041>\n<0004> <0005>\nendbfrange',
        ),
      },
    };
    const found = await checked({
      pages: [{ content: use(...Object.keys(fonts)), fonts }],
      tree: [{ s: 'Document' }],
    });
    const embedded = found.rule('font-embedded');
    expect(embedded.params).toEqual({ fonts: 9 });
    expect(embedded.instances.map((entry) => entry.params?.font)).toEqual([
      'Helvetica',
      'Mystery',
      'Bad1',
      'Bad2',
      'Bad3',
      'Bad4',
      'Good1',
    ]);
    const unicode = found.rule('font-unicode');
    expect(unicode.state).toBe('fail');
    expect(unicode.instances.map((entry) => [entry.params?.font, entry.reason])).toEqual([
      ['Mystery', 'no-map'],
      ['Proc', 'no-map'],
      ['Bad1', 'bad-map'],
      ['Bad2', 'bad-map'],
      ['Bad3', 'bad-map'],
      ['Bad4', 'bad-map'],
    ]);
  });

  it('reads a Unicode route from the encoding of a CID font, a symbolic font and a simple font', async () => {
    type Doc = import('mupdf').PDFDocument;
    const cid = (
      name: string,
      encoding: (doc: Doc) => unknown,
      ordering?: string,
      withDescendant = true,
    ) => ({
      build: (doc: Doc) => {
        const descendant = doc.addObject({
          Type: 'Font',
          Subtype: 'CIDFontType2',
          BaseFont: name,
          ...(ordering === undefined
            ? {}
            : {
                CIDSystemInfo: {
                  Registry: doc.newString('Adobe'),
                  ...(ordering === '' ? {} : { Ordering: doc.newString(ordering) }),
                  Supplement: 0,
                },
              }),
          FontDescriptor: doc.addObject({
            Type: 'FontDescriptor',
            FontName: name,
            Flags: 4,
            FontFile2: doc.addStream('x', {}),
          }),
        });
        return doc.addObject({
          Type: 'Font',
          Subtype: 'Type0',
          BaseFont: name,
          Encoding: encoding(doc) as never,
          ...(withDescendant ? { DescendantFonts: [descendant] } : {}),
        });
      },
    });
    const simple = (name: string, extra: Record<string, unknown>, flags?: number) => ({
      build: (doc: Doc) =>
        doc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: name,
          ...(flags === undefined
            ? {}
            : { FontDescriptor: doc.addObject({ Type: 'FontDescriptor', FontName: name, Flags: flags }) }),
          ...extra,
        } as never),
    });
    const fonts = {
      Identity: cid('Identity', () => 'Identity-H'),
      Uni: cid('Uni', () => 'UniJIS-UCS2-H'),
      Japan: cid('Japan', () => 'Identity-H', 'Japan1'),
      CMapName: cid('CMapName', (doc) =>
        doc.addStream('/CMapName /X def', { Type: 'CMap', CMapName: 'UniGB-UCS2-H' } as never),
      ),
      NoDescendant: cid('NoDescendant', () => 'Identity-H', undefined, false),
      NoCMapName: cid('NoCMapName', (doc) => doc.addStream('x', { Type: 'CMap' } as never)),
      NoOrdering: cid('NoOrdering', () => 'Identity-H', ''),
      Wingdings: simple('Wingdings', {}, 4),
      Symbol: simple('Symbol', {}, 4),
      Known: simple('Known', { Encoding: 'MacRomanEncoding' }),
      Unknown: simple('Unknown', { Encoding: 'Whatever' }),
      Plausible: simple('Plausible', {
        Encoding: {
          BaseEncoding: 'WinAnsiEncoding',
          Differences: [65, 'Aacute', '.notdef', 66, 'germandbls'],
        },
      }),
      Opaque: simple('Opaque', { Encoding: { BaseEncoding: 'WinAnsiEncoding', Differences: [65, 'g12'] } }),
      Odd: simple('Odd', { Encoding: { BaseEncoding: 'WinAnsiEncoding', Differences: [65, 'A-b'] } }),
      OtherBase: simple('OtherBase', { Encoding: { BaseEncoding: 'Foreign' } }),
      NoDifferences: simple('NoDifferences', { Encoding: {} }),
    };
    const found = await checked({
      pages: [
        {
          content: Object.keys(fonts)
            .map((name, index) => tagged('P', index, `BT /${name} 12 Tf (a) Tj ET`))
            .join(''),
          fonts,
        },
      ],
      tree: [{ s: 'Document' }],
    });
    // A route exists through a Uni* encoding, a Japan1 ordering, a CMapName dictionary, a named standard
    // encoding and a Differences list of real glyph names; it does not through Identity, a symbolic face
    // (Symbol included, which is not a Latin standard font here), an unknown encoding name, made-up glyph
    // names or an unknown base encoding.
    expect(found.rule('font-unicode').instances.map((entry) => entry.params?.font)).toEqual([
      'Identity',
      'NoDescendant',
      'NoCMapName',
      'NoOrdering',
      'Wingdings',
      'Symbol',
      'Unknown',
      'Opaque',
      'Odd',
      'OtherBase',
    ]);
    expect(found.rule('font-unicode').params).toEqual({ fonts: 16 });
  });
});

describe('annotation, link and form rules', () => {
  const link = (contents?: string, extra: Partial<import('./tagged.fixtures').TAnnot> = {}) => ({
    subtype: 'Link',
    ...(contents === undefined ? {} : { contents }),
    ...extra,
  });
  const doc = (kids: TNode[]): TNode[] => [{ s: 'Document', k: kids }];

  it('checks every visible link for its element and its description, and every Link element for its annotation', async () => {
    const found = await checked({
      pages: [
        {
          annots: [
            link(), // 0: tagged, no description
            link(), // 1: not in the tree at all
            link('Home page'), // 2: sits in a paragraph element
            link('Described', { flags: 2 }), // 3: hidden, never reported
            link(undefined, { direct: true }), // 4: a direct dictionary: no object number
            { subtype: 'Popup' },
          ],
        },
      ],
      tree: doc([
        { s: 'Link', k: [{ objr: [0, 0] }] },
        { s: 'P', k: [{ objr: [0, 2] }] },
        { s: 'Link', alt: 'Alt on the element', k: [{ objr: [0, 3] }] },
        { s: 'Link' },
      ]),
      parentTree: true,
    });
    const tag = found.rule('link-tagged');
    expect(tag.state).toBe('fail');
    expect(tag.params).toEqual({ links: 4 });
    expect(tag.instances.map((entry) => [entry.reason, entry.where])).toEqual([
      ['untagged', `annotation ${found.built.annots[0]?.[1]} 0 R`],
      ['wrong-element', `annotation ${found.built.annots[0]?.[2]} 0 R`],
      ['untagged', 'annotation'],
      ['no-annotation', undefined],
    ]);
    expect(tag.instances[1]).toMatchObject({ params: { role: 'P' } });
    const alt = found.rule('link-alt');
    expect(alt.instances.map((entry) => entry.objectNumber)).toEqual([
      found.built.annots[0]?.[0],
      found.built.annots[0]?.[1],
      undefined,
    ]);
    // An /Alt on the element stands in for the annotation's /Contents.
    const standIn = await checked({
      pages: [{ annots: [link()] }],
      tree: doc([{ s: 'Link', alt: 'Where it goes', k: [{ objr: [0, 0] }] }]),
      parentTree: true,
    });
    expect(standIn.rule('link-alt').state).toBe('pass');
    expect(standIn.rule('link-tagged').state).toBe('pass');
  });

  it('cannot say whether links are tagged without a usable tree, but still checks their descriptions', async () => {
    const found = await checked({
      pages: [{ annots: [link(), link('Described'), link(undefined, { direct: true })] }],
    });
    expect(found.rule('link-tagged')).toMatchObject({
      state: 'unchecked',
      instances: [{ reason: 'untagged' }],
    });
    const alt = found.rule('link-alt');
    expect(alt.instances).toEqual([
      {
        pageIndex: 0,
        where: `annotation ${found.built.annots[0]?.[0]} 0 R`,
        objectNumber: found.built.annots[0]?.[0],
      },
      { pageIndex: 0, where: 'annotation' },
    ]);
    // No links and no Link element: not applicable.
    const none = await checked({ pages: [PAGE] });
    expect(none.rule('link-tagged').state).toBe('na');
    expect(none.rule('link-alt').state).toBe('na');
    // A Link element without any link annotation is still reported, even with no annotation on the page.
    const lonely = await checked({ pages: [PAGE], tree: doc([{ s: 'Link' }]) });
    expect(lonely.rule('link-tagged').instances).toMatchObject([{ reason: 'no-annotation' }]);
  });

  it('wants other annotations in an Annot element with contents, and widgets in a Form element', async () => {
    const found = await checked({
      pages: [
        {
          annots: [
            { subtype: 'Text' }, // untagged
            { subtype: 'Highlight' }, // in a paragraph element
            { subtype: 'Stamp' }, // in an Annot element, no contents, no alt
            { subtype: 'Square', contents: 'Fine' }, // in an Annot element with contents
            { subtype: 'Circle', flags: 32 }, // NoView: ignored
            { subtype: 'Ink', direct: true },
            { subtype: 'Widget', field: { name: 'a' } }, // untagged
            { subtype: 'Widget', field: { name: 'b' } }, // in a paragraph element
            { subtype: 'Widget', field: { name: 'c' } }, // in a Form element
          ],
        },
      ],
      tree: doc([
        { s: 'P', k: [{ objr: [0, 1] }, { objr: [0, 7] }] },
        { s: 'Annot', k: [{ objr: [0, 2] }] },
        { s: 'Annot', k: [{ objr: [0, 3] }] },
        { s: 'Form', k: [{ objr: [0, 8] }] },
      ]),
      parentTree: true,
    });
    const annot = found.rule('annot-tagged');
    expect(annot.params).toEqual({ annotations: 5 });
    expect(annot.instances.map((entry) => [entry.reason, entry.params])).toEqual([
      ['untagged', { subtype: 'Text' }],
      ['wrong-element', { role: 'P' }],
      ['no-contents', { subtype: 'Stamp' }],
      ['untagged', { subtype: 'Ink' }],
    ]);
    const form = found.rule('form-tagged');
    expect(form.params).toEqual({ widgets: 3 });
    expect(form.instances.map((entry) => [entry.reason, entry.params])).toEqual([
      ['untagged', undefined],
      ['wrong-element', { role: 'P' }],
    ]);
    const bare = await checked({
      pages: [{ annots: [{ subtype: 'Text' }, { subtype: 'Widget', field: { name: 'a' } }] }],
    });
    expect(bare.rule('annot-tagged').state).toBe('unchecked');
    expect(bare.rule('form-tagged').state).toBe('unchecked');
    const clean = await checked({ pages: [{ annots: [{ subtype: 'Popup' }] }], tree: doc([]) });
    expect(clean.rule('annot-tagged').state).toBe('na');
    expect(clean.rule('form-tagged').state).toBe('na');
  });

  it('wants a tooltip on every form field, a /Tabs /S on every page with annotations, and says when it stopped counting fields', async () => {
    const widget = (name: string, tooltip?: string) => ({
      subtype: 'Widget',
      field: { name, ...(tooltip === undefined ? {} : { tooltip }) },
    });
    const found = await checked({
      pages: [
        { annots: [widget('plain'), widget('hinted', 'Your name')], tabs: 'S' },
        { annots: [link('x')] },
        { annots: [{ subtype: 'Popup' }] },
        {},
      ],
      acroForm: {},
      tree: doc([]),
    });
    expect(found.rule('form-tooltip')).toMatchObject({
      state: 'fail',
      params: { fields: 2 },
      instances: [{ where: 'field plain', fieldName: 'plain' }],
    });
    // Page 1 has /Tabs /S; page 2 has a link and no /Tabs; page 3 only a popup, which is not a tab stop.
    expect(found.rule('tab-order').instances).toEqual([{ pageIndex: 1 }]);
    expect(found.rule('tab-order').state).toBe('fail');
    expect((await checked({ pages: [PAGE] })).rule('tab-order').state).toBe('na');
    expect((await checked({ pages: [PAGE] })).rule('form-tooltip').state).toBe('na');

    // More fields than the walk reads: the verdict is withheld, not passed.
    const crowded = await checked({
      pages: [PAGE],
      acroForm: {},
      setup: (pdf, root) => {
        const fields = root.get('AcroForm').get('Fields');
        for (let index = 0; index < 3001; index += 1)
          fields.push(pdf.addObject({ FT: 'Tx', T: pdf.newString(`f${index}`), TU: pdf.newString('t') }));
      },
    });
    expect(crowded.rule('form-tooltip')).toMatchObject({
      state: 'unchecked',
      instances: [{ reason: 'truncated', params: { limit: 3000 } }],
    });
  });

  it('puts the rule texts under one key per rule, part and reason', () => {
    expect(ruleKey.name('headings')).toBe('ua.rule.headings.name');
    expect(ruleKey.why('headings')).toBe('ua.rule.headings.why');
    expect(ruleKey.fix('headings')).toBe('ua.rule.headings.fix');
    expect(ruleKey.detail('headings')).toBe('ua.rule.headings.detail');
    expect(ruleKey.detail('headings', 'skip')).toBe('ua.rule.headings.detail.skip');
    expect(ruleKey.group('fonts')).toBe('ua.group.fonts');
  });
});

describe('fixPdfUa fixes', () => {
  const doc = (kids: TNode[]): TNode[] => [{ s: 'Document', k: kids }];
  const fix = async (spec: TSpec, fixes: Parameters<typeof fixPdfUa>[1]) => {
    const built = await buildTagged(spec);
    const out = await fixPdfUa(built.bytes, fixes, run);
    return { built, out, keys: out.report.notes.map((entry) => entry.key) };
  };
  const bytesOf = async (spec: TSpec) => (await buildTagged(spec)).bytes;

  it('refuses an empty title and a language that is not a tag, naming the field', async () => {
    const bytes = await bytesOf({ pages: [PAGE] });
    await expect(fixPdfUa(bytes, [{ kind: 'title', title: '   ' }], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { path: 'fix.title' },
    });
    await expect(fixPdfUa(bytes, [{ kind: 'lang', lang: 'not a tag' }], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { path: 'fix.lang' },
    });
    await expect(
      fixPdfUa(bytes, [{ kind: 'link-contents', objectNumber: 1, text: ' ' }], run),
    ).rejects.toMatchObject({
      details: { path: 'fix.text' },
    });
    await expect(
      fixPdfUa(bytes, [{ kind: 'field-tooltip', name: 'a', text: '' }], run),
    ).rejects.toMatchObject({
      details: { path: 'fix.text' },
    });
  });

  it('edits the title into the XMP packet that is there, and creates a packet when it has no description to edit', async () => {
    const withPacket =
      (packet: string): TSpec['setup'] =>
      (pdf, root) => {
        root.put(
          'Metadata',
          pdf.addRawStream(new TextEncoder().encode(packet), { Type: 'Metadata', Subtype: 'XML' }),
        );
      };
    const edited = await fix({ pages: [PAGE], setup: withPacket(buildUaPacket({ title: 'Old' })) }, [
      { kind: 'title', title: 'New' },
    ]);
    expect(edited.keys).not.toContain('op.note.ua.xmpCreated');
    expect((await catalogFacts(edited.out.bytes)).xmpTitle).toBe('New');
    const same = await fix(
      { pages: [PAGE], title: 'New', setup: withPacket(buildUaPacket({ title: 'New' })) },
      [{ kind: 'title', title: 'New' }],
    );
    expect(same.keys).not.toContain('op.note.ua.xmpCreated');
    expect((await catalogFacts(same.out.bytes)).xmpTitle).toBe('New');
    const created = await fix(
      { pages: [PAGE], setup: withPacket('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>') },
      [{ kind: 'title', title: 'Fresh' }],
    );
    expect(created.keys).toContain('op.note.ua.xmpCreated');
    expect((await catalogFacts(created.out.bytes)).xmpTitle).toBe('Fresh');
  });

  it('turns DisplayDocTitle on inside the viewer preferences the file already has', async () => {
    const out = await fix({ pages: [PAGE], displayTitle: false }, [{ kind: 'display-title' }]);
    expect((await catalogFacts(out.out.bytes)).displayDocTitle).toBe(true);
  });

  it('sets /Tabs /S on the pages that have annotations and no tab order, and only those', async () => {
    const out = await fix(
      {
        pages: [
          { annots: [{ subtype: 'Text' }] },
          { annots: [{ subtype: 'Text' }], tabs: 'S' },
          {},
          { annots: [] },
        ],
      },
      [{ kind: 'tabs' }],
    );
    expect(out.out.report.notes.find((entry) => entry.key === 'op.note.ua.tabsSet')?.params).toEqual({
      count: 1,
    });
    await mutate(out.out.bytes, (pdf) => {
      const found: (string | null)[] = [];
      for (let index = 0; index < 4; index += 1) {
        const value = pdf.findPage(index).get('Tabs');
        found.push(value.isNull() ? null : value.asName());
      }
      expect(found).toEqual(['S', 'S', null, null]);
    });
  });

  it('marks the document only when there is a tree to mark, and creates or updates MarkInfo', async () => {
    const none = await fix({ pages: [PAGE] }, [{ kind: 'marked' }]);
    expect(none.keys).toContain('op.note.ua.markedNoTree');
    expect((await checkPdfUa(none.out.bytes, run)).rules.find((rule) => rule.id === 'marked')?.state).toBe(
      'fail',
    );
    const created = await fix({ pages: [PAGE], tree: doc([]) }, [{ kind: 'marked' }]);
    expect(created.keys).toContain('op.note.ua.markedSet');
    expect((await checkPdfUa(created.out.bytes, run)).rules.find((rule) => rule.id === 'marked')?.state).toBe(
      'pass',
    );
    const updated = await fix({ pages: [PAGE], tree: doc([]), markInfo: false }, [{ kind: 'marked' }]);
    expect((await checkPdfUa(updated.out.bytes, run)).rules.find((rule) => rule.id === 'marked')?.state).toBe(
      'pass',
    );
  });

  it('wraps every unmarked drawn path in an artifact, page by page, and warns when there is none', async () => {
    const drawn = tagged('P', 0, 'BT /F 12 Tf (a) Tj ET');
    const paths = `${drawn}0 0 10 10 re f\nq\n20 20 m 30 30 l S\nQ\n/Artifact BMC 1 1 5 5 re f EMC\n`;
    const out = await fix(
      {
        pages: [
          { content: paths, fonts: { F: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica' } } } },
          { content: drawn, fonts: { F: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica' } } } },
          { content: ']' },
        ],
        tree: doc([]),
      },
      [{ kind: 'artifact-paths' }],
    );
    expect(out.out.report.steps).toContain('ua.artifact');
    expect(out.out.report.notes.find((entry) => entry.key === 'op.note.ua.pathsMarked')?.params).toEqual({
      count: 2,
      pages: 1,
    });
    const before = await checkPdfUa(out.built.bytes, run);
    const after = await checkPdfUa(out.out.bytes, run);
    const unmarkedPaths = (report: PdfUaReport) =>
      report.rules
        .find((rule) => rule.id === 'tagged-content')
        ?.instances.map((entry) => entry.params?.paths);
    expect(unmarkedPaths(before)).toEqual([2, undefined]);
    expect(unmarkedPaths(after)).toEqual([undefined]);
    const nothing = await fix({ pages: [PAGE], tree: doc([]) }, [{ kind: 'artifact-paths' }]);
    expect(nothing.keys).toContain('op.note.ua.pathsNone');
    expect(nothing.out.report.steps).not.toContain('ua.artifact');
  });

  it('writes link contents and field tooltips, and warns about a target that is not there', async () => {
    const spec: TSpec = {
      pages: [
        {
          annots: [{ subtype: 'Link' }, { subtype: 'Text' }, { subtype: 'Widget', field: { name: 'city' } }],
        },
      ],
      acroForm: {},
    };
    const built = await buildTagged(spec);
    const [linkNumber, textNumber] = built.annots[0] ?? [];
    const out = await fixPdfUa(
      built.bytes,
      [
        { kind: 'link-contents', objectNumber: linkNumber as number, text: ' Home page ' },
        { kind: 'link-contents', objectNumber: textNumber as number, text: 'x' },
        { kind: 'link-contents', objectNumber: 99999, text: 'x' },
        { kind: 'field-tooltip', name: 'city', text: 'Your city' },
        { kind: 'field-tooltip', name: 'nowhere', text: 'x' },
      ],
      run,
    );
    const keys = out.report.notes.map((entry) => [entry.key, entry.params]);
    expect(keys).toContainEqual(['op.note.ua.contentsSet', { text: 'Home page' }]);
    expect(keys).toContainEqual(['op.note.ua.tooltipSet', { name: 'city', tooltip: 'Your city' }]);
    expect(out.report.notes.filter((entry) => entry.key === 'op.note.ua.targetMissing')).toHaveLength(3);
    const after = await checkPdfUa(out.bytes, run);
    expect(after.rules.find((rule) => rule.id === 'link-alt')?.state).toBe('pass');
    expect(after.rules.find((rule) => rule.id === 'form-tooltip')?.state).toBe('pass');
  });
});

describe('font facts from odd dictionaries', () => {
  type Doc = import('mupdf').PDFDocument;
  const use = (...names: string[]) =>
    names.map((name, index) => tagged('P', index, `BT /${name} 12 Tf (a) Tj ET`)).join('');
  const cmap = (body: string) => `/CIDInit /ProcSet findresource begin begincmap\n${body}\nendcmap`;
  const withMap = (name: string, program: (doc: Doc) => unknown) => ({
    build: (doc: Doc) =>
      doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: name, ToUnicode: program(doc) } as never),
  });

  it('names a font after its resource when it has no BaseFont, and skips a font the resources do not hold', async () => {
    const direct = (doc: Doc) => {
      const font = doc.newDictionary();
      font.put('Type', doc.newName('Font'));
      font.put('Subtype', doc.newName('Type1'));
      font.put('BaseFont', doc.newName('Direct'));
      return font;
    };
    const found = await checked({
      pages: [
        {
          content: use('Bare', 'Direct', 'Ghost', 'Odd'),
          fonts: { Bare: { dict: {} }, Direct: { build: direct } },
        },
        { content: use('Direct'), fonts: { Direct: { build: direct } } },
      ],
      tree: [{ s: 'Document' }],
    });
    const embedded = found.rule('font-embedded');
    // `Ghost` is not in the resources and `Odd` is not a dictionary: neither is a font to judge. A font
    // written inline is judged once per page, an indirect one once for the whole file.
    expect(embedded.params).toEqual({ fonts: 3 });
    expect(embedded.instances.map((entry) => [entry.where, entry.pageIndex, entry.params?.pages])).toEqual([
      ['font Bare', 0, 1],
      ['font Direct', 0, 1],
      ['font Direct', 1, 1],
    ]);
  });

  it('judges a ToUnicode map by its entries: two-digit targets, empty ones, a stream that cannot be read and one beyond the size cap', async () => {
    const huge = `1 beginbfchar\n<01> <FFFD>\nendbfchar${' '.repeat(3_000_001)}`;
    const fonts = {
      Short: withMap('Short', (doc) => doc.addStream(cmap('1 beginbfchar\n<01> <41>\nendbfchar'), {})),
      EmptyTarget: withMap('EmptyTarget', (doc) =>
        doc.addStream(cmap('1 beginbfchar\n<01> <>\nendbfchar'), {}),
      ),
      EmptySource: withMap('EmptySource', (doc) =>
        doc.addStream(cmap('1 beginbfchar\n<> <0000>\nendbfchar'), {}),
      ),
      Broken: withMap('Broken', (doc) => doc.addRawStream(new Uint8Array([1, 2, 3, 4, 5, 6]), UNDECODABLE)),
      Huge: withMap('Huge', (doc) => doc.addStream(huge, {})),
      Bad: withMap('Bad', (doc) => doc.addStream(cmap('1 beginbfchar\n<01> <FFFD>\nendbfchar'), {})),
    };
    const found = await checked({
      pages: [{ content: use(...Object.keys(fonts)), fonts }],
      tree: [{ s: 'Document' }],
    });
    // Only the map that really sends a code to U+FFFD is bad; the oversized one is not read, so its
    // leading bad entry is not seen.
    expect(found.rule('font-unicode').instances.map((entry) => [entry.params?.font, entry.reason])).toEqual([
      ['Bad', 'bad-map'],
    ]);
  });
});

describe('forms and structure that cannot be walked', () => {
  const doc = (kids: TNode[]): TNode[] => [{ s: 'Document', k: kids }];
  const text = (body: string) => `BT /F 12 Tf 10 100 Td (${body}) Tj ET`;
  const HELV = { F: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } } };

  it('counts a form XObject whose stream cannot be decoded as unmarked content of its own kind', async () => {
    const found = await checked({
      pages: [{ content: '/Fm1 Do' }],
      tree: doc([]),
      setup: (pdf, _root, pages) => {
        const form = pdf.addRawStream(new Uint8Array([9, 9, 9, 9]), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 10, 10],
          ...UNDECODABLE,
        });
        (pages[0] as import('mupdf').PDFObject).put('Resources', pdf.addObject({ XObject: { Fm1: form } }));
      },
    });
    expect(found.rule('tagged-content').instances).toEqual([
      { pageIndex: 0, params: { count: 1, text: 0, paths: 0, images: 0 } },
    ]);
    // MuPDF cannot interpret the page either, so its characters are not measured.
    expect(found.rule('char-mapping')).toMatchObject({
      state: 'unchecked',
      instances: [{ reason: 'unreadable' }],
    });
  });

  it('still finds a page that is one big picture when MuPDF cannot measure its characters', async () => {
    const found = await checked({
      pages: [{ content: '/Artifact BMC q 190 0 0 190 5 5 cm /Im1 Do Q /Fm1 Do EMC', image: true }],
      tree: doc([]),
      setup: (pdf, _root, pages) => {
        const form = pdf.addRawStream(new Uint8Array([9, 9, 9, 9]), {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 10, 10],
          ...UNDECODABLE,
        });
        const page = pages[0] as import('mupdf').PDFObject;
        const xobjects = page.get('Resources').get('XObject');
        xobjects.put('Fm1', form);
      },
    });
    expect(found.rule('char-mapping').state).toBe('unchecked');
    expect(found.rule('image-only').instances).toEqual([{ pageIndex: 0 }]);
  });

  it('says a page is unreadable when a content stream cannot be decoded, not only when its operators are malformed', async () => {
    const found = await checked({
      pages: [{ content: text('x'), fonts: HELV }],
      tree: doc([]),
      setup: (pdf, _root, pages) => {
        (pages[0] as import('mupdf').PDFObject).put(
          'Contents',
          pdf.addRawStream(new Uint8Array([1, 2, 3, 4]), UNDECODABLE),
        );
      },
    });
    expect(found.rule('tagged-content')).toMatchObject({
      state: 'unchecked',
      instances: [{ pageIndex: 0, reason: 'unreadable' }],
    });
  });

  it('checks the annotations that have no object number and a form field that sits on no page', async () => {
    const found = await checked({
      pages: [
        {
          annots: [
            { subtype: 'Link', direct: true },
            { subtype: 'Text', direct: true },
            { subtype: 'Widget', field: { name: 'city' } },
            { subtype: 'Widget', direct: true, field: { name: 'inline' } },
          ],
        },
      ],
      acroForm: {},
      tree: doc([]),
      parentTree: true,
      setup: (pdf, root, pages) => {
        // A field in /Fields that no page lists: its page is unknown.
        const fields = root.get('AcroForm').get('Fields');
        const loose = pdf.addObject({ FT: 'Tx', T: pdf.newString('loose') });
        fields.push(loose);
        // An /Annots entry that is not a dictionary and one with no /Subtype.
        const annots = (pages[0] as import('mupdf').PDFObject).get('Annots');
        annots.push(pdf.newName('Junk'));
        annots.push(pdf.addObject({ Type: 'Annot', Rect: [0, 0, 5, 5] }));
        // The widget names its page with /P; the loose field has none.
        annots.get(2).put('P', pages[0] as import('mupdf').PDFObject);
      },
    });
    expect(found.rule('link-alt').instances).toEqual([{ pageIndex: 0, where: 'annotation' }]);
    expect(found.rule('link-tagged').instances).toEqual([
      { pageIndex: 0, where: 'annotation', reason: 'untagged' },
    ]);
    expect(found.rule('annot-tagged').instances).toEqual([
      { pageIndex: 0, where: 'annotation', reason: 'untagged', params: { subtype: 'Text' } },
      {
        pageIndex: 0,
        where: expect.stringMatching(/^annotation \d+ 0 R$/),
        reason: 'untagged',
        params: { subtype: '' },
      },
    ]);
    expect(found.rule('form-tagged').instances).toEqual([
      { pageIndex: 0, where: expect.stringMatching(/^annotation \d+ 0 R$/), reason: 'untagged' },
      { pageIndex: 0, where: 'annotation', reason: 'untagged' },
    ]);
    expect(found.rule('form-tooltip').instances).toEqual([
      { pageIndex: 0, where: 'field city', fieldName: 'city' },
      { where: 'field inline', fieldName: 'inline' },
      { where: 'field loose', fieldName: 'loose' },
    ]);
  });
});

describe('tag-annots fix', () => {
  const doc = (kids: TNode[]): TNode[] => [{ s: 'Document', k: kids }];
  const fix = async (spec: TSpec) => {
    const built = await buildTagged(spec);
    const out = await fixPdfUa(built.bytes, [{ kind: 'tag-annots' }], run);
    return { built, out, keys: out.report.notes.map((entry) => entry.key) };
  };
  /** Each annotation's `/StructParent`, by object number, and the parent tree's `/Nums` pairs. */
  const keysOf = (bytes: Uint8Array, numbers: readonly number[]) =>
    mutateRead(bytes, (pdf) => {
      const structParents = numbers.map((number) => {
        const value = pdf.newIndirect(number).resolve().get('StructParent');
        return value.isNull() ? null : value.asNumber();
      });
      const treeRoot = pdf.getTrailer().get('Root').get('StructTreeRoot');
      const nums = treeRoot.get('ParentTree').get('Nums');
      const pairs: number[] = [];
      for (let at = 0; at < nums.length; at += 2) {
        if (nums.get(at).isNumber()) pairs.push(nums.get(at).asNumber());
      }
      const next = treeRoot.get('ParentTreeNextKey');
      return { structParents, pairs, next: next.isNull() ? null : next.asNumber() };
    });

  it('puts every visible, unowned annotation into a Link, Annot or Form element and numbers them after the keys in use', async () => {
    const built = await buildTagged({
      pages: [
        {
          structParents: 12,
          annots: [
            { subtype: 'Link', contents: 'Home' }, // 0 -> Link
            { subtype: 'Text' }, // 1 -> Annot
            { subtype: 'Widget', field: { name: 'city' } }, // 2 -> Form
            { subtype: 'Popup' }, // 3
            { subtype: 'Text', flags: 2 }, // 4 hidden
            { subtype: 'Text', flags: 32 }, // 5 no-view
            { subtype: 'Text', direct: true }, // 6 no object number
            { subtype: 'Link' }, // 7 already owned
            { subtype: 'Text' }, // 8 no /Subtype (removed below)
            { subtype: 'PrinterMark' }, // 9
            { subtype: 'TrapNet' }, // 10
          ],
        },
        {},
      ],
      acroForm: {},
      tree: doc([{ s: 'Link', k: [{ objr: [0, 7] }] }]),
      parentTree: true,
      setup: (pdf, root, pages) => {
        const treeRoot = root.get('StructTreeRoot');
        treeRoot.put('ParentTreeNextKey', 3);
        const nums = treeRoot.get('ParentTree').get('Nums');
        nums.push(pdf.newName('NotAKey'));
        nums.push(pdf.newDictionary());
        nums.push(7);
        nums.push(pdf.newDictionary());
        const annots = (pages[0] as import('mupdf').PDFObject).get('Annots');
        annots.get(8).delete('Subtype');
        annots.push(pdf.newName('Junk'));
      },
    });
    const [page] = built.annots;
    const [link, text, widget] = page as number[];
    const out = await fixPdfUa(built.bytes, [{ kind: 'tag-annots' }], run);
    const note = out.report.notes.find((entry) => entry.key === 'op.note.ua.annotsTagged');
    expect(note?.params).toEqual({ count: 3 });

    // Keys: the highest in use is max(NextKey 3, Nums 7 + 1, page 12 + 1) = 13.
    const others = (page as number[]).filter((_number, index) => ![0, 1, 2, 6].includes(index));
    const read = await keysOf(out.bytes, [link, text, widget, ...others] as number[]);
    expect(read.structParents).toEqual([13, 14, 15, null, null, null, null, null, null, null]);
    expect(read.pairs).toEqual([7, 13, 14, 15]);
    expect(read.next).toBe(16);

    const after = await checkPdfUa(out.bytes, run);
    const rule = (id: string) => after.rules.find((entry) => entry.id === id);
    expect(rule('link-tagged')?.instances.map((entry) => entry.where)).toEqual([]);
    expect(rule('form-tagged')?.state).toBe('pass');
    // The Text annotation (1) is now in an Annot element — which still lacks a description; the direct one
    // and the one with no /Subtype were not touched.
    expect(rule('annot-tagged')?.instances.map((entry) => [entry.reason, entry.where])).toEqual([
      ['no-contents', `annotation ${text} 0 R`],
      ['untagged', 'annotation'],
      ['untagged', expect.stringMatching(/^annotation \d+ 0 R$/)],
    ]);
  });

  it('creates the parent tree and puts the annotations in the document element when the tree has neither', async () => {
    const { built, out, keys } = await fix({
      pages: [{ annots: [{ subtype: 'Link' }, { subtype: 'Text' }] }],
      tree: doc([]),
    });
    expect(keys).toContain('op.note.ua.annotsTagged');
    const read = await keysOf(out.bytes, built.annots[0] as number[]);
    expect(read.structParents).toEqual([0, 1]);
    expect(read.pairs).toEqual([0, 1]);
    expect(read.next).toBe(2);
    const after = await checkPdfUa(out.bytes, run);
    expect(after.rules.find((entry) => entry.id === 'link-tagged')?.state).toBe('pass');
    expect(after.rules.find((entry) => entry.id === 'annot-tagged')?.state).toBe('fail');
  });

  it('keeps a document element whose only child is not in an array, and the one root child that is not in an array', async () => {
    const { built, out } = await fix({
      pages: [{ annots: [{ subtype: 'Link', contents: 'x' }] }],
      tree: [{ s: 'Document', single: true, k: [{ s: 'P' }] }],
      parentTree: true,
      setup: (_pdf, root) => {
        const treeRoot = root.get('StructTreeRoot');
        treeRoot.put('K', treeRoot.get('K').get(0));
      },
    });
    const model = (await readStructure(out.bytes, run)).model;
    const document = model.roots[0];
    expect(document?.kids.map((kid) => (kid.kind === 'element' ? kid.node.role : kid.kind))).toEqual([
      'P',
      'Link',
    ]);
    const link = built.annots[0]?.[0] as number;
    expect((await keysOf(out.bytes, [link])).structParents).toEqual([0]);
  });

  it('warns and changes nothing when there is no structure tree, no flat parent tree or no document element', async () => {
    const noTree = await fix({ pages: [{ annots: [{ subtype: 'Link' }] }] });
    expect(noTree.keys).toContain('op.note.ua.annotsNoTree');
    const kids = await fix({
      pages: [{ annots: [{ subtype: 'Link' }] }],
      tree: doc([]),
      parentTree: { kids: true },
    });
    expect(kids.keys).toContain('op.note.ua.annotsTreeShape');
    const noNums = await fix({
      pages: [{ annots: [{ subtype: 'Link' }] }],
      tree: doc([]),
      parentTree: true,
      setup: (_pdf, root) => root.get('StructTreeRoot').get('ParentTree').delete('Nums'),
    });
    expect(noNums.keys).toContain('op.note.ua.annotsTreeShape');
    const noDocument = await fix({ pages: [{ annots: [{ subtype: 'Link' }] }], tree: [] });
    expect(noDocument.keys).toContain('op.note.ua.annotsTreeShape');
    for (const result of [noTree, kids, noNums, noDocument]) {
      expect(result.keys).not.toContain('op.note.ua.annotsTagged');
      expect(
        (await checkPdfUa(result.out.bytes, run)).rules.find((entry) => entry.id === 'link-tagged')?.state,
      ).not.toBe('pass');
    }
  });

  it('warns when no annotation needs an element', async () => {
    const none = await fix({
      pages: [{ annots: [{ subtype: 'Popup' }, { subtype: 'Link', flags: 2 }] }, {}],
      tree: doc([]),
      parentTree: true,
    });
    expect(none.keys).toContain('op.note.ua.annotsNone');
    expect(none.keys).not.toContain('op.note.ua.annotsTagged');
  });
});

describe('verifyFixes', () => {
  const state = (over: Partial<FixState> = {}): FixState => ({
    notes: [],
    steps: [],
    annotTags: [],
    rewrittenPages: new Set(),
    tabPages: [],
    title: null,
    lang: null,
    displayTitle: false,
    marked: false,
    linkContents: [],
    tooltips: [],
    ...over,
  });
  const message = async (bytes: Uint8Array, over: Partial<FixState>) => {
    const failure = await verifyFixes(bytes, state(over)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'verification-failed' });
    return (failure as { details: { engineMessage: string } }).details.engineMessage;
  };
  const withXmp =
    (packet: string): TSpec['setup'] =>
    (pdf, root) => {
      root.put(
        'Metadata',
        pdf.addRawStream(new TextEncoder().encode(packet), { Type: 'Metadata', Subtype: 'XML' }),
      );
    };

  it('accepts a file that says what the fixes wrote', async () => {
    const built = await buildTagged({
      pages: [{ annots: [{ subtype: 'Link', contents: 'Home' }], tabs: 'S' }],
      title: 'Report',
      lang: 'en',
      displayTitle: true,
      markInfo: true,
      tree: [{ s: 'Document' }],
      setup: withXmp(buildUaPacket({ title: 'Report' })),
    });
    await expect(
      verifyFixes(
        built.bytes,
        state({
          title: 'Report',
          lang: 'en',
          displayTitle: true,
          marked: true,
          tabPages: [0],
          linkContents: [{ objectNumber: (built.annots[0] as number[])[0] as number, text: 'Home' }],
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses bytes that do not open', async () => {
    expect(await message(new Uint8Array([1, 2, 3]), {})).toMatch(
      /^the file does not re-open after the fix: /,
    );
  });

  it('names the document fact that did not read back', async () => {
    const bare = (await buildTagged({ pages: [PAGE] })).bytes;
    expect(await message(bare, { title: 'T' })).toBe('the Info title reads back ""');
    const infoOnly = (await buildTagged({ pages: [PAGE], title: 'T' })).bytes;
    expect(await message(infoOnly, { title: 'T' })).toBe('the XMP title reads back ""');
    expect(await message(bare, { lang: 'en' })).toBe('/Lang reads back ""');
    expect(await message(bare, { displayTitle: true })).toBe('/DisplayDocTitle did not read back as true');
    expect(await message(bare, { marked: true })).toBe('/MarkInfo /Marked did not read back as true');
    expect(await message(bare, { tabPages: [0] })).toBe('page 1 has no /Tabs /S');
  });

  it('names the rewritten page that cannot be read, is unbalanced or still has a bare path', async () => {
    const built = await buildTagged({
      pages: [
        { content: tagged('P', 0, '0 0 5 5 re f') },
        { content: '/Artifact BMC\n0 0 5 5 re f' },
        { content: '0 0 5 5 re f\n' },
        { content: ']' },
      ],
      tree: [{ s: 'Document' }],
    });
    const rewritten = (index: number) => ({ rewrittenPages: new Set([index]) });
    await expect(verifyFixes(built.bytes, state(rewritten(0)))).resolves.toBeUndefined();
    expect(await message(built.bytes, rewritten(1))).toBe(
      'page 2 has unbalanced marked content after the write',
    );
    expect(await message(built.bytes, rewritten(2))).toBe('page 3 still has 1 unmarked drawn paths');
    expect(await message(built.bytes, rewritten(3))).toBe('page 4 cannot be read after the write');
    expect(await message(built.bytes, rewritten(9))).toBe('page 10 cannot be read after the write');
    const broken = await buildTagged({
      pages: [{ content: '' }],
      setup: (pdf, _root, pages) => {
        (pages[0] as import('mupdf').PDFObject).put(
          'Contents',
          pdf.addRawStream(new Uint8Array([1, 2, 3, 4]), UNDECODABLE),
        );
      },
    });
    expect(await message(broken.bytes, rewritten(0))).toBe('page 1 cannot be read after the write');
  });

  it('names the annotation that is in the wrong element or has no /StructParent, a link without contents and a field without a tooltip', async () => {
    const built = await buildTagged({
      pages: [
        {
          annots: [
            { subtype: 'Link' },
            { subtype: 'Link' },
            { subtype: 'Widget', field: { name: 'city', tooltip: 'Elsewhere' } },
          ],
        },
      ],
      acroForm: {},
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'Link', k: [{ objr: [0, 0] }] },
            { s: 'Span', k: [{ objr: [0, 1] }] },
          ],
        },
      ],
      parentTree: true,
      setup: (_pdf, _root, pages) => {
        const annots = (pages[0] as import('mupdf').PDFObject).get('Annots');
        annots.get(0).put('StructParent', 0);
        annots.get(1).put('StructParent', 1);
      },
    });
    const [first, second] = built.annots[0] as number[];
    const tags = (...entries: { objectNumber: number; role: string }[]) => ({ annotTags: entries });
    await expect(
      verifyFixes(built.bytes, state(tags({ objectNumber: first as number, role: 'Link' }))),
    ).resolves.toBeUndefined();
    expect(await message(built.bytes, tags({ objectNumber: second as number, role: 'Link' }))).toBe(
      `annotation ${second} is not in a Link element after the write`,
    );
    const unnumbered = await buildTagged({
      pages: [{ annots: [{ subtype: 'Link' }] }],
      tree: [{ s: 'Document', k: [{ s: 'Link', k: [{ objr: [0, 0] }] }] }],
      parentTree: true,
    });
    const only = (unnumbered.annots[0] as number[])[0] as number;
    expect(await message(unnumbered.bytes, tags({ objectNumber: only, role: 'Link' }))).toBe(
      `annotation ${only} has no /StructParent`,
    );
    expect(
      await message(built.bytes, { linkContents: [{ objectNumber: first as number, text: 'Home' }] }),
    ).toBe(`link ${first} has no /Contents after the write`);
    expect(await message(built.bytes, { tooltips: [{ name: 'city', text: 'Your city' }] })).toBe(
      'field city has no /TU after the write',
    );
    expect(await message(built.bytes, { tooltips: [{ name: 'absent', text: 'x' }] })).toBe(
      'field absent has no /TU after the write',
    );
  });
});

describe('verifyUaPart', () => {
  it('accepts a file that declares part 1 and refuses one that declares none or another part', async () => {
    const declare =
      (packet: string): TSpec['setup'] =>
      (pdf, root) => {
        root.put(
          'Metadata',
          pdf.addRawStream(new TextEncoder().encode(packet), { Type: 'Metadata', Subtype: 'XML' }),
        );
      };
    const part1 = await buildTagged({ pages: [PAGE], setup: declare(buildUaPacket({ uaPart: 1 })) });
    await expect(verifyUaPart(part1.bytes)).resolves.toBeUndefined();
    const part2 = await buildTagged({ pages: [PAGE], setup: declare(buildUaPacket({ uaPart: 2 })) });
    await expect(verifyUaPart(part2.bytes)).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: 'pdfuaid:part did not read back as 1' },
    });
    const none = await buildTagged({ pages: [PAGE] });
    await expect(verifyUaPart(none.bytes)).rejects.toMatchObject({ code: 'verification-failed' });
  });
});

describe('fixPdfUa progress and the written identifier', () => {
  it('reports progress as 1 of 3, and 1 and 3 of 4 when the identifier is asked for', async () => {
    const built = await buildTagged({ pages: [PAGE], tree: [{ s: 'Document' }] });
    const events: { done: number; total: number }[] = [];
    const watched: OperationContext = {
      signal: run.signal,
      onProgress: (event) => {
        events.push({ done: event.done ?? 0, total: event.total ?? 0 });
      },
    };
    await fixPdfUa(built.bytes, [{ kind: 'tabs' }], watched);
    expect(events.map((entry) => [entry.done, entry.total])).toEqual([[1, 3]]);
    events.length = 0;
    await fixPdfUa(built.bytes, [{ kind: 'tabs' }, { kind: 'mark-pdfua' }], watched);
    expect(events.map((entry) => [entry.done, entry.total])).toContainEqual([1, 4]);
    expect(events.map((entry) => [entry.done, entry.total])).toContainEqual([3, 4]);
  });

  it('does not rewrite a packet that already says what the title fix would write', async () => {
    const compact = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Same</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const built = await buildTagged({
      pages: [PAGE],
      setup: (pdf, root) => {
        root.put(
          'Metadata',
          pdf.addRawStream(new TextEncoder().encode(compact), { Type: 'Metadata', Subtype: 'XML' }),
        );
      },
    });
    const metadata = (bytes: Uint8Array) =>
      mutateRead(bytes, (pdf) => {
        const entry = pdf.getTrailer().get('Root').get('Metadata');
        return {
          number: entry.asIndirect(),
          text: new TextDecoder().decode(entry.readStream().asUint8Array()),
        };
      });
    const before = await metadata(built.bytes);
    const out = await fixPdfUa(built.bytes, [{ kind: 'title', title: 'Same' }], run);
    const after = await metadata(out.bytes);
    expect(after).toEqual(before);
    expect(after.text).toBe(compact);
  });
});

describe('checkPdfUa abort and fixPdfUa on pages that cannot be read', () => {
  it("stops a check the caller aborts between pages with the caller's own abort", async () => {
    const built = await buildTagged({ pages: [PAGE, PAGE], tree: [{ s: 'Document' }] });
    const controller = new AbortController();
    const context = { signal: controller.signal, onProgress: () => controller.abort() };
    await expect(checkPdfUa(built.bytes, context)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('leaves a page whose content cannot be decoded alone when wrapping paths in artifacts', async () => {
    const built = await buildTagged({
      pages: [{ content: '0 0 5 5 re f' }],
      tree: [{ s: 'Document' }],
      setup: (pdf, _root, pages) => {
        (pages[0] as import('mupdf').PDFObject).put(
          'Contents',
          pdf.addRawStream(new Uint8Array([1, 2]), UNDECODABLE),
        );
      },
    });
    const out = await fixPdfUa(built.bytes, [{ kind: 'artifact-paths' }], run);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.ua.pathsNone');
    expect(out.report.steps).not.toContain('ua.artifact');
  });
});
