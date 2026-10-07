/**
 * The object-level audit reads raw file bytes, so its fixtures are hand-written PDF text:
 * what is in the string is exactly what the scan sees. The wrong answers that matter: an
 * erased string still present and reported as clean, a finding that quotes the erased text
 * itself, a second revision or an orphan object that goes unmentioned, and an abort that
 * the scan does not honour.
 */

import { describe, expect, it } from 'vitest';
import { auditRedactedDocument } from './redact-audit';

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.charCodeAt(0));

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
