/**
 * The PDF/UA check and its quick fixes against real bytes. What matters: an untagged file fails
 * the tagging rules and a tagged one passes them, manual rules are never reported as passed, each
 * fix is read back from the file (Info, XMP, catalog) and not from the report, and the
 * `pdfuaid` identifier is written only when every automated rule passes.
 */

import { describe, expect, it } from 'vitest';
import { readXmpPacket } from './accessibility';
import { checkPdfUa, fixPdfUa, type PdfUaReport, UA_RULES } from './pdfua';
import { editStructure, readStructure } from './structure';
import { run, taggedFixture, untaggedFixture } from './ua.fixtures';
import { readUaPart, readXmpTitle } from './ua-xmp';

const states = (report: PdfUaReport): Record<string, string> =>
  Object.fromEntries(report.rules.map((rule) => [rule.id, rule.state]));

async function open(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  return doc;
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
