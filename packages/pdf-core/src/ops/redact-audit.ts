/**
 * Object-level audit of a produced document (`PLAN.md §9/K16` first safety contract,
 * `§5/Phase 3`).
 *
 * `ops/redact.ts` checks the marked *areas* (`verifyRedaction`); this module checks
 * the *file*: every place an erased string still appears in the raw bytes, and every
 * structural trace the file carries. It is the report a user reads before sending a
 * redacted document anywhere, so it is built to be read — a check that found nothing
 * reports that it found nothing, in the same shape as a check that found something.
 *
 * **The recipe, measured in archived spike `redaction/audit.ts`.** The bytes are read as
 * a latin1 string (`hexStringToLatin1`, `engines/mupdf.ts`) and then scanned with plain
 * `indexOf`/regex passes. That is the point of latin1: one byte is one character, so a
 * needle is found inside dictionary text, inside hex strings and inside undecoded
 * streams alike, without decoding the file as UTF-8 (which replaces exactly the bytes
 * such an occurrence is made of and hides it). Counts are counts, never booleans:
 * "`/EmbeddedFile` once" and "`/EmbeddedFile` four times" are different facts.
 *
 * **What this scan cannot see, measured.** A pdf-lib export (default options) and the
 * file MuPDF writes with `garbage=compact,compress,clean` both carry their content and
 * their dictionaries **deflated**. Measured on a three-page fixture: the needle
 * `GIZLI-TOKEN-4711` is in the document and is *not* a plain byte sequence in it, and
 * the redacted export reports exactly what the unredacted original reports. The scan
 * cannot decide that on its own, so it says so instead of implying a clean file: a
 * `/FlateDecode` row whenever the file compresses anything, and — because object
 * streams are the same problem one level up — no orphan verdict at all while they are
 * present (that is not caution for its own sake: reading references out of a compressed
 * object stream is impossible here, and the naive check invented three orphans on a
 * perfectly ordinary four-object fixture). The spike's object-level pass
 * (archived spike `redaction/audit.ts:205-263`: `newIndirect(n).readStream()` per object)
 * is the layer that sees inside; it needs the engine in the loop, which this scan
 * deliberately does not.
 *
 * **The checks and their severity.** `content` means *the erased bytes themselves may
 * still be in this file*: residual text, an earlier revision (`startxref`/`/Prev`), an
 * object definition nothing points at. `warning` means the file still carries a
 * structure that can hold content the user has not seen — Info, XMP, attachments,
 * JavaScript, annotations — or that a check had to be skipped. `info` is shape and
 * clean rows, including the name tree. Every check that found nothing reports a clean
 * row of the same shape as a finding, which is what makes the report readable.
 *
 * **Nothing here reports content.** A finding that names a document-content string
 * reports its count and where it sits (an object number, or a byte offset when the
 * occurrence is outside every object definition) and never the string itself: the audit
 * must not become a second place the erased text lives. `where` carries PDF notation
 * and offsets only — identifiers, never prose, so it cannot smuggle English copy into a
 * Turkish interface either.
 */

import type { MessageKey } from 'pdf-shared';
import { hexStringToLatin1 } from '../engines/mupdf';
import { throwIfAborted } from './types';

export type AuditFindingKind =
  | 'residual-text'
  | 'previous-revision'
  | 'orphan-object'
  | 'metadata'
  | 'attachment'
  | 'annotation'
  | 'javascript'
  | 'xmp'
  | 'structure'
  | 'clean';

export interface AuditFinding {
  readonly kind: AuditFindingKind;
  readonly severity: 'info' | 'warning' | 'content';
  /** i18n note key. */
  readonly key: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
  /** Where the finding was seen, when the engine can say (e.g. `object 12 0 R`). */
  readonly where?: string;
}

export interface RedactionAudit {
  readonly findings: readonly AuditFinding[];
  readonly objectCount: number;
  readonly revisionCount: number;
  readonly incrementalChains: number;
  readonly bytes: number;
}

/**
 * The audit's sentence keys. `parts/audit.ts` is folded into `tr.ts` by the
 * integration owner, so `MessageKey` cannot name these literals yet — `finding()` is
 * this file's single assertion seam, and every key below is a key of that part.
 */
const KEYS = {
  residual: 'audit.residual',
  cleanText: 'audit.clean.text',
  cleanTextRest: 'audit.clean.textRest',
  revision: 'audit.revision',
  cleanRevisions: 'audit.clean.revisions',
  orphan: 'audit.orphan',
  cleanOrphans: 'audit.clean.orphans',
  orphansSkipped: 'audit.orphans.skipped',
  compressed: 'audit.compressed',
  cleanCompressed: 'audit.clean.compressed',
  metadata: 'audit.metadata',
  cleanMetadata: 'audit.clean.metadata',
  xmp: 'audit.xmp',
  cleanXmp: 'audit.clean.xmp',
  attachment: 'audit.attachment',
  cleanAttachments: 'audit.clean.attachments',
  annotation: 'audit.annotation',
  cleanAnnotations: 'audit.clean.annotations',
  javascript: 'audit.javascript',
  cleanJavascript: 'audit.clean.javascript',
  names: 'audit.names',
  cleanNames: 'audit.clean.names',
};

/** Object definitions (`\nN 0 obj`) and object references (`N 0 R`), file order. */
const DEFINITION = /\n(\d+) 0 obj/g;
const REFERENCE = /(\d+) 0 R/g;

/**
 * How far into a definition the audit looks for its `/Type`. An object stream's or an
 * xref stream's dictionary opens the object, so a short window cannot miss the type
 * while keeping the scan from reading a content stream's own bytes.
 */
const TYPE_WINDOW = 160;

/** An xref stream is reached through the trailer, never through a `N 0 R` reference. */
const STRUCTURAL_TYPE = /\/(ObjStm|XRef)\b/;

/** A check the raw scan can run: one marker, and the two sentences it can produce. */
interface MarkerCheck {
  readonly kind: AuditFindingKind;
  readonly severity: AuditFinding['severity'];
  readonly marker: string;
  readonly key: string;
  readonly cleanKey: string;
}

/**
 * Every structural trace, in report order. `/Info` and `<?xpacket` are the metadata
 * dictionaries, `/EmbeddedFile` an attached file, `/JavaScript` executable content,
 * `/Annots` the page annotation arrays (visible structure that can carry comments; the
 * array may be empty and this scan cannot tell), `/Names` the name tree.
 */
const MARKER_CHECKS: readonly MarkerCheck[] = [
  {
    kind: 'metadata',
    severity: 'warning',
    marker: '/Info',
    key: KEYS.metadata,
    cleanKey: KEYS.cleanMetadata,
  },
  { kind: 'xmp', severity: 'warning', marker: '<?xpacket', key: KEYS.xmp, cleanKey: KEYS.cleanXmp },
  {
    kind: 'attachment',
    severity: 'warning',
    marker: '/EmbeddedFile',
    key: KEYS.attachment,
    cleanKey: KEYS.cleanAttachments,
  },
  {
    kind: 'annotation',
    severity: 'warning',
    marker: '/Annots',
    key: KEYS.annotation,
    cleanKey: KEYS.cleanAnnotations,
  },
  {
    kind: 'javascript',
    severity: 'warning',
    marker: '/JavaScript',
    key: KEYS.javascript,
    cleanKey: KEYS.cleanJavascript,
  },
  { kind: 'structure', severity: 'info', marker: '/Names', key: KEYS.names, cleanKey: KEYS.cleanNames },
];

/**
 * Object-level audit of a produced document (`PLAN.md §9/K16` first safety contract).
 * `needles` are the strings the user asked to erase; the audit reports every place
 * they still appear in the raw bytes, and every structural trace the file carries.
 *
 * An empty needle is skipped — it has no occurrences to count — and a repeated needle
 * is checked once, so the `term` parameter always names the caller's own list.
 */
export async function auditRedactedDocument(
  bytes: Uint8Array,
  needles: readonly string[],
  signal?: AbortSignal,
): Promise<RedactionAudit> {
  if (signal !== undefined) throwIfAborted(signal);
  const text = hexStringToLatin1(bytes);
  const objects = scanObjects(text);
  const findings: AuditFinding[] = [];

  const checked = new Set<string>();
  let found = 0;
  for (const [index, needle] of needles.entries()) {
    if (needle.length === 0 || checked.has(needle)) continue;
    checked.add(needle);
    const hits = occurrences(text, needle);
    if (hits.count === 0) continue;
    found += 1;
    findings.push(
      finding(
        'residual-text',
        'content',
        KEYS.residual,
        { term: index + 1, count: hits.count },
        locate(objects, hits.first),
      ),
    );
  }
  if (found === 0) {
    findings.push(finding('clean', 'info', KEYS.cleanText, { terms: checked.size }));
  } else if (found < checked.size) {
    // The terms that were *not* found are an answer too, and a missing row would read
    // as "not checked".
    findings.push(finding('clean', 'info', KEYS.cleanTextRest, { terms: checked.size - found }));
  }

  if (signal !== undefined) throwIfAborted(signal);
  const startxref = occurrences(text, 'startxref');
  const prev = occurrences(text, '/Prev');
  if (startxref.count > 1 || prev.count > 0) {
    findings.push(
      finding(
        'previous-revision',
        'content',
        KEYS.revision,
        { revisions: startxref.count, chains: prev.count },
        locate(objects, startxref.first),
      ),
    );
  } else {
    findings.push(finding('clean', 'info', KEYS.cleanRevisions));
  }

  const objectStreams = occurrences(text, '/ObjStm');
  if (objectStreams.count > 0) {
    findings.push(
      finding(
        'structure',
        'warning',
        KEYS.orphansSkipped,
        { streams: objectStreams.count },
        locate(objects, objectStreams.first),
      ),
    );
  } else {
    const orphans = findOrphans(text, objects);
    if (orphans.count > 0) {
      findings.push(
        finding(
          'orphan-object',
          'content',
          KEYS.orphan,
          { count: orphans.count },
          `object ${orphans.first} 0 R`,
        ),
      );
    } else {
      findings.push(finding('clean', 'info', KEYS.cleanOrphans));
    }
  }

  const compressed = occurrences(text, '/FlateDecode');
  if (compressed.count === 0) {
    findings.push(finding('clean', 'info', KEYS.cleanCompressed));
  } else {
    findings.push(
      finding(
        'structure',
        'warning',
        KEYS.compressed,
        { count: compressed.count },
        locate(objects, compressed.first),
      ),
    );
  }

  for (const check of MARKER_CHECKS) {
    if (signal !== undefined) throwIfAborted(signal);
    const marker = occurrences(text, check.marker);
    if (marker.count === 0) {
      findings.push(finding(check.kind, 'info', check.cleanKey));
      continue;
    }
    findings.push(
      finding(check.kind, check.severity, check.key, { count: marker.count }, locate(objects, marker.first)),
    );
  }

  return {
    findings,
    objectCount: objects.definitions.length,
    revisionCount: startxref.count,
    incrementalChains: prev.count,
    bytes: bytes.byteLength,
  };
}

/**
 * One finding. `key` is typed `string` and asserted here: the audit's sentences live in
 * `packages/shared/src/i18n/parts/audit.ts`, which is merged into `tr.ts` by the
 * integration owner, so `MessageKey` cannot name them in this file yet. `undefined`
 * never lands in the object — a finding is data another layer may serialize.
 */
function finding(
  kind: AuditFindingKind,
  severity: AuditFinding['severity'],
  key: string,
  params?: Readonly<Record<string, string | number>>,
  where?: string,
): AuditFinding {
  const found: AuditFinding = {
    kind,
    severity,
    key: key as MessageKey,
    ...(params === undefined ? {} : { params }),
  };
  return where === undefined ? found : { ...found, where };
}

/** Occurrences of a literal in the raw text: how many, and where the first one sits. */
function occurrences(text: string, needle: string): { readonly count: number; readonly first: number } {
  let count = 0;
  let first = -1;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    if (first < 0) first = at;
    count += 1;
  }
  return { count, first };
}

/** A definition's byte offset and object number; the capture group is always digits. */
interface ObjectDefinition {
  readonly offset: number;
  readonly number: number;
}

interface ObjectIndex {
  readonly definitions: readonly ObjectDefinition[];
  readonly referenced: ReadonlySet<number>;
}

/**
 * One pass for the definitions, one for the references. `N 0 obj` and `N 0 R` are the
 * two notations every producer writes; an object carrying a non-zero generation is
 * outside both counts, and nothing this app writes uses one.
 */
function scanObjects(text: string): ObjectIndex {
  const definitions: ObjectDefinition[] = [];
  for (const match of text.matchAll(DEFINITION)) {
    definitions.push({ offset: match.index ?? 0, number: Number(match[1]) });
  }
  const referenced = new Set<number>();
  for (const match of text.matchAll(REFERENCE)) referenced.add(Number(match[1]));
  return { definitions, referenced };
}

/**
 * Definitions no dictionary points at — where a stranded copy of erased content would
 * sit, and the trace `garbage=compact` removes. A definition whose dictionary declares
 * itself an object stream or an xref stream is structure, not an orphan. Only called
 * for a file without object streams: their references live inside a compressed stream
 * and would be invisible here (see the header).
 */
function findOrphans(text: string, objects: ObjectIndex): { readonly count: number; readonly first: number } {
  let count = 0;
  let first = -1;
  for (const definition of objects.definitions) {
    if (objects.referenced.has(definition.number)) continue;
    if (STRUCTURAL_TYPE.test(text.slice(definition.offset, definition.offset + TYPE_WINDOW))) continue;
    if (first < 0) first = definition.number;
    count += 1;
  }
  return { count, first };
}

/**
 * Where a byte offset sits: the object definition that encloses it, or the offset
 * itself when the occurrence is outside every definition (a trailer, a free gap).
 * Binary search, because a large file has thousands of definitions and every finding
 * asks once.
 */
function locate(objects: ObjectIndex, offset: number): string {
  let low = 0;
  let high = objects.definitions.length - 1;
  let enclosing = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const definition = objects.definitions[middle];
    if (definition === undefined) break;
    if (definition.offset <= offset) {
      enclosing = definition.number;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return enclosing < 0 ? `byte ${offset}` : `object ${enclosing} 0 R`;
}
