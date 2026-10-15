/**
 * Object-level audit of a produced document (the first redaction safety contract).
 *
 * `ops/redact.ts` checks the marked *areas* (`verifyRedaction`); this module checks
 * the *file*: every place an erased string still appears in the raw bytes, and every
 * structural trace the file carries. It is the report a user reads before sending a
 * redacted document anywhere, so it is built to be read — a check that found nothing
 * reports that it found nothing, in the same shape as a check that found something.
 *
 * **The recipe.** The bytes are read as
 * a latin1 string (`hexStringToLatin1`, `engines/mupdf.ts`) and then scanned with plain
 * `indexOf`/regex passes. That is the point of latin1: one byte is one character, so a
 * needle written as plain bytes is found inside dictionary text and inside undecoded
 * streams alike, without decoding the file as UTF-8 (which replaces exactly the bytes
 * such an occurrence is made of and hides it). Counts are counts, never booleans:
 * "`/EmbeddedFile` once" and "`/EmbeddedFile` four times" are different facts.
 *
 * **Two searches for a needle, and what each one finds.** The raw search above does *not*
 * see a string whose bytes are not the needle's own: a hex string (`<534543524554>` is
 * `SECRET`), a literal written with escapes (`(SEC\122ET)`), or a text string in UTF-16BE
 * — which is what MuPDF writes for any text with a character outside PDFDocEncoding
 * (`ş`, `ğ`, `İ`), in `/Alt`, `/ActualText`, bookmark titles, form `/V` values and every
 * other text string. So the audit also **parses the string objects** the file spells
 * out — literal `(…)` (escapes, octal, line continuations, nesting) and hex `<…>`, in
 * the dictionaries *and* inside streams that carry no `/Filter` — and decodes each one the
 * way a reader does: UTF-16BE after a `FE FF` mark, UTF-8 after an `EF BB BF` mark,
 * PDFDocEncoding otherwise. A needle is searched in that text after NFC normalisation
 * (the needle is normalised too), so `ş` is found whether the file stores it as one
 * character or as `s` plus a combining cedilla. A needle with non-ASCII characters is
 * also searched as its UTF-8 bytes in the raw text, which is how an uncompressed XMP
 * packet or script spells it. An occurrence both searches see (an ASCII literal) is one
 * occurrence, not two. Neither search reads a *filtered* stream or an object stream:
 * nothing here inflates anything (see the next paragraph).
 *
 * **What this scan cannot see, measured.** The file MuPDF writes with
 * `garbage=compact,compress,clean` (like most producers' default export) carries its
 * content and its dictionaries **deflated**. Measured on a three-page fixture: the needle
 * `GIZLI-TOKEN-4711` is in the document and is *not* a plain byte sequence in it, and
 * the redacted export reports exactly what the unredacted original reports. The scan
 * cannot decide that on its own, so it says so instead of implying a clean file: a
 * `/FlateDecode` row whenever the file compresses anything, and — because object
 * streams are the same problem one level up — no orphan verdict at all while they are
 * present (that is not caution for its own sake: reading references out of a compressed
 * object stream is impossible here, and the naive check invented three orphans on a
 * perfectly ordinary four-object fixture). An object-level pass
 * (`newIndirect(n).readStream()` per object)
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

/**
 * Object definitions (`N 0 obj`) and object references (`N 0 R`), file order. A definition
 * opens a line: after a LF (which is also the end of a CRLF), after a lone CR (a file
 * written with CR line ends has no LF at all), or at the very first byte. The line break
 * is a lookbehind, so a match starts at the object number itself.
 */
const DEFINITION = /(?<=^|[\r\n])(\d+) 0 obj/g;
const REFERENCE = /(\d+) 0 R/g;

/**
 * How far into a definition the audit looks for its `/Type`. An object stream's or an
 * xref stream's dictionary opens the object, so a short window cannot miss the type
 * while keeping the scan from reading a content stream's own bytes.
 */
const TYPE_WINDOW = 160;

/** An xref stream is reached through the trailer, never through a `N 0 R` reference. */
const STRUCTURAL_TYPE = /\/(ObjStm|XRef)\b/;

/**
 * `/EmbeddedFile` is the type of an attached file's stream — and the first thirteen
 * characters of `/EmbeddedFiles`, the name-tree key every document with a `/Names`
 * dictionary may carry. After the last attachment is deleted, MuPDF leaves that key behind
 * with an empty tree (`/EmbeddedFiles<</Names[]>>`): there is nothing attached.
 */
const EMBEDDED_FILE = '/EmbeddedFile';

/** A name tree node without a single entry: `<<>>`, `<</Names[]>>`, `<</Kids[]>>` and the like. */
const EMPTY_NAME_TREE = /\s*<<(?:\s*\/(?:Names|Kids)\s*\[\s*\])*\s*>>/y;
const INDIRECT = /\s*(\d+) 0 R/y;
/** What ends a name (§7.2.3): whitespace and the delimiters `()<>[]{}/%`. */
const NAME_END = '\u0000\t\n\f\r ()<>[]{}/%';

/** How many times something occurs in the raw text, and where the first one sits. */
interface Occurrence {
  readonly count: number;
  readonly first: number;
}

/**
 * A check the raw scan can run: one marker, and the two sentences it can produce. `scan`
 * replaces the plain count of `marker` for a check whose marker also spells something
 * that is *not* the trace (see {@link findAttachments}).
 */
interface MarkerCheck {
  readonly kind: AuditFindingKind;
  readonly severity: AuditFinding['severity'];
  readonly marker: string;
  readonly key: string;
  readonly cleanKey: string;
  readonly scan?: (text: string, objects: ObjectIndex) => Occurrence;
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
    marker: EMBEDDED_FILE,
    key: KEYS.attachment,
    cleanKey: KEYS.cleanAttachments,
    scan: findAttachments,
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
 * Object-level audit of a produced document (the first redaction safety contract).
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
  const terms: Term[] = [];
  for (const [index, needle] of needles.entries()) {
    if (needle.length === 0 || checked.has(needle)) continue;
    checked.add(needle);
    terms.push(makeTerm(index + 1, needle));
  }
  let found = 0;
  for (const hit of searchTerms(text, objects, terms)) {
    if (hit.count === 0) continue;
    found += 1;
    findings.push(
      finding(
        'residual-text',
        'content',
        KEYS.residual,
        { term: hit.term.number, count: hit.count },
        locate(objects, hit.first),
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
    const marker = check.scan === undefined ? occurrences(text, check.marker) : check.scan(text, objects);
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
function occurrences(text: string, needle: string): Occurrence {
  let count = 0;
  let first = -1;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    if (first < 0) first = at;
    count += 1;
  }
  return { count, first };
}

/** The earlier of two offsets, where `-1` means "none". */
function earliest(left: number, right: number): number {
  if (left < 0) return right;
  return right < 0 ? left : Math.min(left, right);
}

/**
 * A definition's object number, the byte offset of its number and the offset just past its
 * `obj` keyword (where the object's value begins); the capture group is always digits.
 */
interface ObjectDefinition {
  readonly offset: number;
  readonly number: number;
  readonly body: number;
}

interface ObjectIndex {
  readonly definitions: readonly ObjectDefinition[];
  /** The last definition of each object number: the one a reader takes. */
  readonly byNumber: ReadonlyMap<number, ObjectDefinition>;
  readonly referenced: ReadonlySet<number>;
}

/**
 * One pass for the definitions, one for the references. `N 0 obj` and `N 0 R` are the
 * two notations every producer writes; an object carrying a non-zero generation is
 * outside both counts, and nothing this app writes uses one.
 */
function scanObjects(text: string): ObjectIndex {
  const definitions: ObjectDefinition[] = [];
  const byNumber = new Map<number, ObjectDefinition>();
  for (const match of text.matchAll(DEFINITION)) {
    const definition = {
      offset: match.index,
      number: Number(match[1]),
      body: match.index + match[0].length,
    };
    definitions.push(definition);
    byNumber.set(definition.number, definition);
  }
  const referenced = new Set<number>();
  for (const match of text.matchAll(REFERENCE)) referenced.add(Number(match[1]));
  return { definitions, byNumber, referenced };
}

/**
 * The attachment check. Every `/EmbeddedFile` counts, except the `/EmbeddedFiles` name-tree
 * key whose tree is empty — that is what a deleted last attachment leaves behind, and a
 * check that reports an attachment where there is none is a check nobody trusts. A tree
 * the scan cannot read as empty (entries, an object it cannot find, a shape it does not
 * know) counts: only a positive reading of "nothing in it" clears it.
 */
function findAttachments(text: string, objects: ObjectIndex): Occurrence {
  let count = 0;
  let first = -1;
  for (
    let at = text.indexOf(EMBEDDED_FILE);
    at >= 0;
    at = text.indexOf(EMBEDDED_FILE, at + EMBEDDED_FILE.length)
  ) {
    if (hasEmptyNameTree(text, at + EMBEDDED_FILE.length, objects)) continue;
    if (first < 0) first = at;
    count += 1;
  }
  return { count, first };
}

/**
 * Whether the text from `after` (just past `/EmbeddedFile`) is `s`, the end of that name and
 * an empty name tree — written in place or as the indirect object the key points at.
 */
function hasEmptyNameTree(text: string, after: number, objects: ObjectIndex): boolean {
  const next = text.charAt(after + 1);
  if (text.charAt(after) !== 's' || (next !== '' && !NAME_END.includes(next))) return false;
  const value = after + 1;
  EMPTY_NAME_TREE.lastIndex = value;
  if (EMPTY_NAME_TREE.test(text)) return true;
  INDIRECT.lastIndex = value;
  const target = INDIRECT.exec(text);
  const definition = target === null ? undefined : objects.byNumber.get(Number(target[1]));
  if (definition === undefined) return false;
  EMPTY_NAME_TREE.lastIndex = definition.body;
  return EMPTY_NAME_TREE.test(text);
}

/** A needle the caller asked for: its number in the caller's list and its comparison forms. */
interface Term {
  /** One-based position in the caller's list (empty and repeated needles keep their slots). */
  readonly number: number;
  /** The needle as given: searched in the raw text. */
  readonly needle: string;
  /** The same needle as the raw bytes of its UTF-8 encoding; `null` when that is the needle itself. */
  readonly utf8: string | null;
  /** The needle in NFC: searched in the decoded strings, which are in NFC too. */
  readonly folded: string;
}

/** Where a term occurs in the file (`first` is `-1` when it does not). */
interface TermHit {
  readonly term: Term;
  count: number;
  first: number;
}

function makeTerm(number: number, needle: string): Term {
  const encoded = hexStringToLatin1(new TextEncoder().encode(needle));
  return { number, needle, utf8: encoded === needle ? null : encoded, folded: needle.normalize('NFC') };
}

/**
 * Every term's occurrences in the file, in the term's order. Two searches, and an
 * occurrence both see counts once (see the header):
 *
 * - the raw text, for the needle as given and for its UTF-8 bytes — plain bytes in a
 *   dictionary, in an unfiltered stream, in an uncompressed XMP packet;
 * - the file's string objects, decoded — hex strings, escaped literals, UTF-16BE and
 *   UTF-8 text strings. A string the raw search already counted (an ASCII literal) adds
 *   only what the decoded text has *more* of than the raw bytes inside the string.
 */
function searchTerms(text: string, objects: ObjectIndex, terms: readonly Term[]): TermHit[] {
  if (terms.length === 0) return [];
  // Starts as the raw search's answer; the string pass only adds to it.
  const tally = terms.map((term) => ({ term, ...rawOccurrences(text, term) }));
  const shortest = Math.min(...terms.map((term) => term.folded.length));
  forEachString(text, objects, (start, end, bytes) => {
    // Decoding never makes a string longer than its bytes, so a shorter one holds no needle.
    if (bytes.length < shortest) return;
    const decoded = decodeTextString(bytes);
    for (const slot of tally) {
      const total = occurrences(decoded, slot.term.folded).count;
      if (total === 0) continue;
      const surplus = total - rawOccurrences(text.slice(start, end), slot.term).count;
      if (surplus <= 0) continue;
      slot.count += surplus;
      slot.first = earliest(slot.first, start);
    }
  });
  return tally;
}

/** A term's occurrences as plain bytes: the needle as given plus, when it differs, its UTF-8 bytes. */
function rawOccurrences(text: string, term: Term): Occurrence {
  const plain = occurrences(text, term.needle);
  if (term.utf8 === null) return plain;
  const encoded = occurrences(text, term.utf8);
  return { count: plain.count + encoded.count, first: earliest(plain.first, encoded.first) };
}

/** A string object's bytes, and the index just past its closing delimiter. */
interface StringToken {
  readonly bytes: number[];
  readonly end: number;
}

const BACKSLASH = 0x5c;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const PERCENT = 0x25;
const CR = 0x0d;
const LF = 0x0a;

/** Simple escapes of a literal string (ISO 32000-1 §7.3.4.2); every other `\c` is `c` itself. */
const ESCAPES: Readonly<Record<string, number>> = {
  n: LF,
  r: CR,
  t: 0x09,
  b: 0x08,
  f: 0x0c,
};

/**
 * The next thing the string scan has to look at: the start of a literal string, of a hex
 * string or dictionary (`<`), of a comment, or the `stream` keyword in front of data.
 */
const SCAN_POINTS = /[(<%]|stream(?=[ \t]*[\r\n])/g;
const COMMENT_BODY = /[^\r\n]*/y;

/**
 * How far back from the `stream` keyword the scan looks for `/Filter`. A stream dictionary
 * that long does not exist; the cap keeps a malformed file from turning every stream into
 * a read of everything before it.
 */
const DICTIONARY_WINDOW = 65536;

/**
 * Calls `visit` with the offsets and the bytes of every string object in the text, in file
 * order. The text is walked as PDF syntax outside streams (so a `(` in a comment or a
 * `<` in a dictionary start is read as what it is) and inside the streams that carry no
 * `/Filter` (a content stream's `(…) Tj` and `<…> TJ` strings, an uncompressed object
 * stream); a *filtered* stream is skipped whole, because its bytes are not syntax. A
 * stream's data is its own region: a string inside it never runs past `endstream`.
 */
function forEachString(
  text: string,
  objects: ObjectIndex,
  visit: (start: number, end: number, bytes: number[]) => void,
): void {
  const scan = (source: string, base: number, inStream: boolean): void => {
    const points = new RegExp(SCAN_POINTS);
    for (let match = points.exec(source); match !== null; match = points.exec(source)) {
      const at = match.index;
      const code = source.charCodeAt(at);
      if (code === PERCENT) {
        COMMENT_BODY.lastIndex = at;
        COMMENT_BODY.test(source);
        points.lastIndex = COMMENT_BODY.lastIndex;
      } else if (code === OPEN_PAREN) {
        const token = readLiteral(source, at);
        visit(base + at, base + token.end, token.bytes);
        points.lastIndex = token.end;
      } else if (code === LESS_THAN) {
        if (source.charCodeAt(at + 1) === LESS_THAN) {
          points.lastIndex = at + 2;
          continue;
        }
        const token = readHex(source, at);
        visit(base + at, base + token.end, token.bytes);
        points.lastIndex = token.end;
      } else if (!inStream && isStreamKeyword(source, at)) {
        const data = streamDataStart(source, at);
        const end = source.indexOf('endstream', data);
        const limit = end < 0 ? source.length : end;
        if (!hasFilter(source, objects, at)) scan(source.slice(data, limit), data, true);
        points.lastIndex = limit;
      }
    }
  };
  scan(text, 0, false);
}

/** `stream` as a keyword: after whitespace or the `>>` closing the dictionary, not the end of `endstream`. */
function isStreamKeyword(text: string, at: number): boolean {
  // At the first byte there is no character before it: `NaN` equals nothing below.
  const before = text.charCodeAt(at - 1);
  return before === GREATER_THAN || before === 0x20 || before === CR || before === LF || before === 0x09;
}

/** The first byte of a stream's data: after the keyword and its line break (CRLF, LF or a lone CR). */
function streamDataStart(text: string, keyword: number): number {
  let at = keyword + 'stream'.length;
  while (text.charCodeAt(at) === 0x20 || text.charCodeAt(at) === 0x09) at += 1;
  if (text.charCodeAt(at) === CR) at += 1;
  if (text.charCodeAt(at) === LF) at += 1;
  return at;
}

/** Whether the dictionary in front of the `stream` keyword at `keyword` names a `/Filter`. */
function hasFilter(text: string, objects: ObjectIndex, keyword: number): boolean {
  const opening = enclosingDefinition(objects, keyword)?.offset ?? 0;
  return text.slice(Math.max(opening, keyword - DICTIONARY_WINDOW), keyword).includes('/Filter');
}

/**
 * A literal string starting at the `(` at `at`: its bytes after the escapes (`\n`, `\ddd`
 * octal, `\` before a line break continues the line, `\c` is `c`), a raw line break
 * read as one LF, nested balanced parentheses kept; and where it ends. An unterminated
 * string ends with the text, keeping what it has: a truncated file is the one to audit.
 */
function readLiteral(text: string, at: number): StringToken {
  const bytes: number[] = [];
  let depth = 1;
  let index = at + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    index += 1;
    if (code === BACKSLASH) {
      const next = text.charCodeAt(index);
      index += 1;
      const simple = ESCAPES[text.charAt(index - 1)];
      if (simple !== undefined) {
        bytes.push(simple);
      } else if (next >= 0x30 && next <= 0x37) {
        let value = next - 0x30;
        for (let digits = 1; digits < 3; digits += 1) {
          const octal = text.charCodeAt(index);
          if (octal < 0x30 || octal > 0x37) break;
          value = value * 8 + (octal - 0x30);
          index += 1;
        }
        bytes.push(value & 0xff);
      } else if (next === CR) {
        if (text.charCodeAt(index) === LF) index += 1;
      } else if (next !== LF && !Number.isNaN(next)) {
        bytes.push(next);
      }
    } else if (code === OPEN_PAREN) {
      depth += 1;
      bytes.push(code);
    } else if (code === CLOSE_PAREN) {
      depth -= 1;
      if (depth === 0) return { bytes, end: index };
      bytes.push(code);
    } else if (code === CR) {
      bytes.push(LF);
      if (text.charCodeAt(index) === LF) index += 1;
    } else {
      bytes.push(code);
    }
  }
  return { bytes, end: text.length };
}

/** The value of a hex digit, or `-1` for any other character. */
function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/**
 * A hex string starting at the `<` at `at`: pairs of digits are bytes, whitespace (and
 * anything else that is not a digit) is skipped, and an odd last digit is followed by an
 * implied `0` (§7.3.4.3). An unterminated one ends with the text, keeping what it has.
 */
function readHex(text: string, at: number): StringToken {
  const bytes: number[] = [];
  let high = -1;
  let index = at + 1;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    index += 1;
    if (code === GREATER_THAN) break;
    const digit = hexDigit(code);
    if (digit < 0) continue;
    if (high < 0) {
      high = digit;
    } else {
      bytes.push(high * 16 + digit);
      high = -1;
    }
  }
  if (high >= 0) bytes.push(high * 16);
  return { bytes, end: index };
}

/**
 * PDFDocEncoding (ISO 32000-1 Annex D.2) is latin1 except for these: 0x18–0x1F (accents),
 * 0x80–0x9E (typographic punctuation, ligatures, and the letters `ı Ł ł Œ œ Š š Ÿ Ž ž`) and
 * 0xA0 (the euro sign). `0x9F` is undefined and is left alone. `ş`, `ğ` and `İ` are *not*
 * in it, which is why MuPDF writes a text with any of them as UTF-16BE.
 */
const PDFDOC_UNITS = Uint16Array.from({ length: 256 }, (_unused, byte) => byte);
const PDFDOC_ACCENTS = '\u02D8\u02C7\u02C6\u02D9\u02DD\u02DB\u02DA\u02DC';
const PDFDOC_PUNCTUATION = [
  '\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044\u2039\u203A\u2212\u2030\u201E\u201C\u201D\u2018',
  '\u2019\u201A\u2122\uFB01\uFB02\u0141\u0152\u0160\u0178\u017D\u0131\u0142\u0153\u0161\u017E',
].join('');
for (let index = 0; index < PDFDOC_ACCENTS.length; index += 1) {
  PDFDOC_UNITS[0x18 + index] = PDFDOC_ACCENTS.charCodeAt(index);
}
for (let index = 0; index < PDFDOC_PUNCTUATION.length; index += 1) {
  PDFDOC_UNITS[0x80 + index] = PDFDOC_PUNCTUATION.charCodeAt(index);
}
PDFDOC_UNITS[0xa0] = 0x20ac;
/** The table as a string, so a byte's character is `PDFDOC.charCodeAt(byte)`: always a number. */
const PDFDOC = String.fromCharCode(...PDFDOC_UNITS);

/** A language tag inside a Unicode text string (§7.9.2.2): an ESC, a language (and country) code, an ESC. */
const ESCAPE_CHARACTER = String.fromCharCode(0x1b);
const LANGUAGE_TAG = new RegExp(`${ESCAPE_CHARACTER}[A-Za-z]{2}(?:-?[A-Za-z]{2})?${ESCAPE_CHARACTER}`, 'g');

const UNIT_CHUNK = 0x2000;

/** UTF-16 code units as a string, in chunks: a spread of a long array overflows the argument limit. */
function fromUnits(units: readonly number[]): string {
  let out = '';
  for (let at = 0; at < units.length; at += UNIT_CHUNK) {
    out += String.fromCharCode(...units.slice(at, at + UNIT_CHUNK));
  }
  return out;
}

/**
 * A text string as a reader decodes it (§7.9.2.2): UTF-16BE after the `FE FF` mark, UTF-8
 * after the `EF BB BF` mark (PDF 2.0), PDFDocEncoding when there is no mark; language tags
 * removed, normalised to NFC — the form a typed needle has. An odd trailing byte of a
 * UTF-16BE string is dropped.
 */
function decodeTextString(bytes: readonly number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const view = new DataView(Uint8Array.from(bytes).buffer);
    const units: number[] = [];
    for (let at = 2; at + 1 < bytes.length; at += 2) units.push(view.getUint16(at));
    return normalized(fromUnits(units), true);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return normalized(new TextDecoder('utf-8').decode(Uint8Array.from(bytes.slice(3))), true);
  }
  return normalized(fromUnits(bytes.map((byte) => PDFDOC.charCodeAt(byte))), false);
}

function normalized(decoded: string, unicode: boolean): string {
  return (unicode ? decoded.replace(LANGUAGE_TAG, '') : decoded).normalize('NFC');
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
    // The window stops at the definition's own `endobj`: a short orphan followed by an xref
    // stream must not be read as that xref stream.
    const window = text.slice(definition.offset, definition.offset + TYPE_WINDOW);
    const own = window.indexOf('endobj');
    if (STRUCTURAL_TYPE.test(own < 0 ? window : window.slice(0, own))) continue;
    if (first < 0) first = definition.number;
    count += 1;
  }
  return { count, first };
}

/**
 * Where a byte offset sits: the object definition that encloses it (the last one that
 * starts at or before it), or the offset itself when the occurrence is outside every
 * definition (a header, a free gap). The definitions are in file order, and the audit asks
 * for at most one location per finding.
 */
function locate(objects: ObjectIndex, offset: number): string {
  const enclosing = enclosingDefinition(objects, offset);
  return enclosing === undefined ? `byte ${offset}` : `object ${enclosing.number} 0 R`;
}

/**
 * The last definition that starts at or before `offset`, by bisection: the string scan asks
 * once per stream, and a file can hold tens of thousands of them.
 */
function enclosingDefinition(objects: ObjectIndex, offset: number): ObjectDefinition | undefined {
  let found: ObjectDefinition | undefined;
  let low = 0;
  let high = objects.definitions.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    // `low <= middle <= high` and `high` starts at the last index: always a definition.
    const definition = objects.definitions[middle] as ObjectDefinition;
    if (definition.offset <= offset) {
      found = definition;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
