/**
 * The PDF/A checker: does this file claim PDF/A, and which of the rules this build can test
 * does it break?
 *
 * **This is not a veraPDF validation.** veraPDF runs several hundred machine-checkable rules,
 * including ones that need the font programs, the ICC profile bodies and the exact file
 * syntax parsed by an engine that does not repair. This module checks the rules that can be
 * decided from the object graph and the content streams, names each one, and returns the
 * list it did **not** run (`notChecked`) with every report, so a clean result is never
 * mistaken for a certificate. The rules were calibrated against veraPDF 1.30 on the fixtures
 * of the conversion (`architecture.md` §5.9): both agree on every one of them, and the cases
 * where this checker is stricter or looser than the standard are named below.
 *
 * ## What is checked
 *
 * Per rule (`PDFA_RULES`), for parts 1, 2 and 3 of ISO 19005 at conformance level B:
 *
 *  - `header`, `trailer`, `encryption`, `structure` — the file's first lines, the trailer's
 *    `/ID`, nothing after `%%EOF`, no `/Encrypt`, and an xref MuPDF did not have to repair;
 *  - `streams` — no LZW, no external stream (`/F`, `/FFilter`), over **every** object;
 *  - `xmp`, `xmp-claim`, `xmp-schemas`, `xmp-info` — the metadata stream, the `pdfaid`
 *    identification, properties from schemas the packet does not describe, and (part 1) the
 *    Information dictionary agreeing with the packet;
 *  - `output-intent` — the profile of each PDF/A output intent (header, class, components);
 *  - `device-colour` — DeviceGray/RGB/CMYK painted without a matching output intent or
 *    `Default*` space, found by reading the content streams (`pdfa-content.ts`);
 *  - `transparency` — part 1: constant alpha, blend modes, soft masks, groups. Parts 2 and 3: a
 *    page that uses transparency without an output intent names no blending colour space;
 *  - `fonts` — every font used to paint visible text is embedded, and a CIDFontType2 has its
 *    `/CIDToGIDMap`;
 *  - `actions`, `annotations`, `forms`, `layers`, `images`, `graphics-state`, `embedded-files`.
 *
 * ## Where it differs from the standard
 *
 *  - A font is judged only when a content stream selects it (`Tf`) and paints with it in a
 *    visible render mode, which is what veraPDF does. A font whose only use is invisible text
 *    (an OCR layer, render mode 3) is exempt in part 2 and 3 and reported in part 1.
 *  - A JavaScript name tree is reported even when no action runs it: a file that carries
 *    script is not what PDF/A is for. veraPDF reports the actions only.
 *  - The ICC profile is read for its header (version, class, colour space), not its tags.
 *
 * The check never changes the document and never loads more than the bytes it is given.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { hexStringToLatin1, loadMupdf, openPdf } from '../engines/mupdf';
import { readName, resolved } from '../engines/mupdf-write';
import { engineFailure } from './accessibility';
import { nameOf, numberOf, type Operand, scanContent } from './pdfa-content';
import { NS_DC, NS_PDF, NS_XMP, parseXmp, type XmpPacket, xmpList, xmpText } from './pdfa-xmp';
import { throwIfAborted } from './types';

export type PdfAPart = 1 | 2 | 3;

export const PDFA_RULE_IDS = [
  'header',
  'trailer',
  'encryption',
  'structure',
  'streams',
  'xmp',
  'xmp-claim',
  'xmp-schemas',
  'xmp-info',
  'output-intent',
  'device-colour',
  'transparency',
  'fonts',
  'images',
  'graphics-state',
  'actions',
  'annotations',
  'forms',
  'layers',
  'embedded-files',
] as const;

export type PdfARuleId = (typeof PDFA_RULE_IDS)[number];

/** The ISO 19005 clause a rule comes from, per part (2 and 3 share their numbering). */
export const PDFA_CLAUSES: Readonly<Record<PdfARuleId, { readonly one: string; readonly two: string }>> = {
  header: { one: '6.1.2', two: '6.1.2' },
  trailer: { one: '6.1.3', two: '6.1.3' },
  encryption: { one: '6.1.3', two: '6.1.3' },
  structure: { one: '6.1.4', two: '6.1.4' },
  streams: { one: '6.1.7 / 6.1.10', two: '6.1.7' },
  xmp: { one: '6.7.2', two: '6.6.2.1' },
  'xmp-claim': { one: '6.7.11', two: '6.6.4' },
  'xmp-schemas': { one: '6.7.8', two: '6.6.2.3' },
  'xmp-info': { one: '6.7.3', two: '6.6.2.3' },
  'output-intent': { one: '6.2.2', two: '6.2.3' },
  'device-colour': { one: '6.2.3.3', two: '6.2.4.3' },
  transparency: { one: '6.4', two: '6.2.10' },
  fonts: { one: '6.3.4', two: '6.2.11.4' },
  images: { one: '6.2.4', two: '6.2.8' },
  'graphics-state': { one: '6.2.8 / 6.2.9', two: '6.2.5 / 6.2.9' },
  actions: { one: '6.6.1', two: '6.5.1' },
  annotations: { one: '6.5', two: '6.3' },
  forms: { one: '6.9', two: '6.4' },
  layers: { one: '6.1.13', two: '6.9' },
  'embedded-files': { one: '6.1.11', two: '6.8' },
};

export type PdfARuleState =
  /** The rule ran and found nothing. */
  | 'pass'
  /** The rule ran and found `count` violations. */
  | 'fail'
  /** The part does not have this rule (`xmp-info` outside part 1, for example). */
  | 'na'
  /** The rule could not run (the file would not open, or a size budget ended it). */
  | 'unchecked';

export interface PdfAViolation {
  readonly pageIndex?: number;
  /** An identifier, not a sentence: a font name, a namespace, an action type. */
  readonly detail?: string;
}

export interface PdfARuleResult {
  readonly id: PdfARuleId;
  readonly state: PdfARuleState;
  /** Violations found; 0 unless `state` is `fail`. */
  readonly count: number;
  /** The first few violations, for the report. */
  readonly samples: readonly PdfAViolation[];
}

export interface PdfAClaim {
  /** `pdfaid:part` as written. */
  readonly part: string | null;
  /** `pdfaid:conformance` as written. */
  readonly conformance: string | null;
}

/** What the file says about itself, against what the checker found. */
export type PdfAVerdict =
  /** No `pdfaid` identification: the file does not claim PDF/A. */
  | 'no-claim'
  /** It claims PDF/A and none of the rules this checker runs failed. */
  | 'claims-and-meets'
  /** It claims PDF/A and breaks at least one rule. */
  | 'claims-with-violations'
  /** It cannot be read at all (a password is needed). */
  | 'unreadable';

export interface PdfACheckReport {
  readonly verdict: PdfAVerdict;
  readonly claim: PdfAClaim | null;
  /** The part and conformance the rules were applied for. */
  readonly target: { readonly part: PdfAPart; readonly conformance: 'A' | 'B' | 'U' };
  /** `true` when `target` came from the file's own claim, `false` when it was asked for or defaulted. */
  readonly targetFromClaim: boolean;
  readonly rules: readonly PdfARuleResult[];
  /** The sum of the failed rules' counts. */
  readonly violations: number;
  readonly pageCount: number;
  /** Rule ids that ran, and ids that could not run on this file. */
  readonly checked: readonly PdfARuleId[];
  readonly unchecked: readonly PdfARuleId[];
  /** The things this checker never looks at, as message keys (always the same list). */
  readonly notChecked: readonly string[];
}

export interface PdfACheckOptions {
  /** Check for this part even when the file claims another or none. */
  readonly part?: PdfAPart;
  /** Content bytes to tokenise at most (default 192 MiB); the rest is reported `unchecked`. */
  readonly contentBudget?: number;
}

const NOT_CHECKED: readonly string[] = [
  'pdfa.notChecked.fontPrograms',
  'pdfa.notChecked.iccBody',
  'pdfa.notChecked.syntax',
  'pdfa.notChecked.xmpValues',
  'pdfa.notChecked.embeddedPdf',
  'pdfa.notChecked.accessibility',
  'pdfa.notChecked.limits',
];

const SAMPLE_LIMIT = 8;
const DEFAULT_CONTENT_BUDGET = 192 * 1024 * 1024;
const OBJECT_SCAN_LIMIT = 400_000;
const MAX_FORM_DEPTH = 24;

const ACTIONS_FORBIDDEN: ReadonlySet<string> = new Set([
  'Launch',
  'Sound',
  'Movie',
  'ResetForm',
  'ImportData',
  'Hide',
  'SetOCGState',
  'Rendition',
  'Trans',
  'GoTo3DView',
  'JavaScript',
  'SetState',
  'NoOp',
]);
const NAMED_ACTIONS_ALLOWED: ReadonlySet<string> = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);

const FORBIDDEN_ANNOTATIONS: ReadonlyMap<PdfAPart, ReadonlySet<string>> = new Map([
  [
    1,
    new Set([
      'Sound',
      'Movie',
      'Screen',
      '3D',
      'RichMedia',
      'FileAttachment',
      'Redact',
      'Watermark',
      'Projection',
    ]),
  ],
  [2, new Set(['Sound', 'Movie', 'Screen', '3D', 'RichMedia', 'Redact', 'Watermark', 'Projection'])],
  [3, new Set(['Sound', 'Movie', 'Screen', '3D', 'RichMedia', 'Redact', 'Watermark', 'Projection'])],
]);

const AF_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'Source',
  'Data',
  'Alternative',
  'Supplement',
  'Unspecified',
]);

type Device = 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK';
type Cs = Device | 'other' | 'unknown';

/** What one rule has collected while the file was walked. */
class Findings {
  readonly #rules = new Map<PdfARuleId, { count: number; samples: PdfAViolation[] }>();
  readonly #seen = new Set<string>();

  add(rule: PdfARuleId, violation: PdfAViolation = {}): void {
    const entry = this.#rules.get(rule) ?? { count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < SAMPLE_LIMIT) entry.samples.push(violation);
    this.#rules.set(rule, entry);
  }

  /** Count a violation once per `key`, however many times the walk meets it. */
  addOnce(rule: PdfARuleId, key: string, violation: PdfAViolation = {}): void {
    const full = `${rule}\u0000${key}`;
    if (this.#seen.has(full)) return;
    this.#seen.add(full);
    this.add(rule, violation);
  }

  get(rule: PdfARuleId): { count: number; samples: PdfAViolation[] } | undefined {
    return this.#rules.get(rule);
  }
}

/** A scope a content stream is read in: the resources its names resolve through. */
interface Scope {
  readonly resources: PDFObject | null;
  readonly pageIndex: number;
  readonly depth: number;
}

interface Graphics {
  fill: Cs;
  stroke: Cs;
  font: string | null;
  mode: number;
}

interface Context {
  readonly part: PdfAPart;
  readonly findings: Findings;
  readonly signal: AbortSignal | undefined;
  readonly outputIntent: { readonly present: boolean; readonly space: 'RGB' | 'CMYK' | 'GRAY' | null };
  /** Indirect form XObjects, patterns and soft-mask groups already read, by object number. */
  readonly visited: Set<number>;
  /** Fonts a content stream selected and painted with, by key, and whether any paint was visible. */
  readonly fonts: Map<string, { readonly font: PDFObject; readonly pageIndex: number; visible: boolean }>;
  /** Graphics states (`gs`) already judged, by object number. */
  readonly states: Set<number>;
  /** The page being read uses transparency (parts 2 and 3 want its blending space named). */
  pageTransparency: boolean;
  budget: number;
  budgetExhausted: boolean;
  unreadable: number;
}

function key(object: PDFObject): number {
  return object.isIndirect() ? object.asIndirect() : -1;
}

function dictionaryAt(parent: PDFObject | null, name: string): PDFObject | null {
  if (parent === null) return null;
  const value = resolved(parent.get(name));
  return value?.isDictionary() === true ? value : null;
}

function nameAt(parent: PDFObject, name: string): string | null {
  return readName(parent.get(name));
}

function numberAt(parent: PDFObject, name: string): number | null {
  const value = resolved(parent.get(name));
  return value?.isNumber() === true ? value.asNumber() : null;
}

function arrayItems(object: PDFObject | null): PDFObject[] {
  const array = resolved(object);
  if (array === null || !array.isArray()) return [];
  const out: PDFObject[] = [];
  for (let index = 0; index < array.length; index += 1) out.push(array.get(index));
  return out;
}

/** The names a `/Filter` entry lists (a name or an array of names). */
function filterNames(parent: PDFObject): string[] {
  const filter = resolved(parent.get('Filter'));
  if (filter === null) return [];
  if (filter.isName()) return [filter.asName()];
  return arrayItems(filter)
    .map((entry) => readName(entry))
    .filter((entry): entry is string => entry !== null);
}

function streamBytes(stream: PDFObject): Uint8Array | null {
  try {
    const buffer = stream.readStream();
    try {
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  } catch {
    return null;
  }
}

/** The decoded bytes of a stream's raw form (undecoded), for the ICC header. */
function leadingBytes(stream: PDFObject, count: number): Uint8Array | null {
  const bytes = streamBytes(stream);
  return bytes === null ? null : bytes.subarray(0, count);
}

/* ------------------------------------------------------------------ *
 * The bytes: header and tail
 * ------------------------------------------------------------------ */

function checkBytes(bytes: Uint8Array, findings: Findings): void {
  const head = hexStringToLatin1(bytes.subarray(0, 32));
  const version = /^%PDF-1\.([0-9])/.exec(head);
  if (version === null) {
    findings.add('header', { detail: 'no %PDF-1.x header at the start of the file' });
  } else if (Number(version[1]) > 7) {
    findings.add('header', { detail: `PDF 1.${version[1]}` });
  }
  // The second line is a comment of at least four bytes above 127, which tells transfer
  // programs that the file is binary (6.1.2).
  let index = head.search(/[\r\n]/);
  if (version !== null && index >= 0) {
    while (index < bytes.length && (bytes[index] === 10 || bytes[index] === 13)) index += 1;
    const comment = bytes[index] === 0x25;
    let high = 0;
    for (let at = index + 1; comment && at < index + 1 + 4; at += 1)
      if ((bytes[at] as number) > 127) high += 1;
    if (!comment || high < 4) findings.add('header', { detail: 'no binary comment on the second line' });
  }

  const tail = hexStringToLatin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const eof = tail.lastIndexOf('%%EOF');
  if (eof < 0) {
    findings.add('trailer', { detail: 'no %%EOF marker' });
  } else if (/[^\r\n\t \0]/.test(tail.slice(eof + 5))) {
    findings.add('trailer', { detail: 'data after %%EOF' });
  }
}

/* ------------------------------------------------------------------ *
 * The object graph, every object: streams
 * ------------------------------------------------------------------ */

function checkAllObjects(doc: PDFDocument, part: PdfAPart, findings: Findings): boolean {
  const count = doc.countObjects();
  const limit = Math.min(count, OBJECT_SCAN_LIMIT);
  for (let number = 1; number < limit; number += 1) {
    // MuPDF reports most objects it cannot load as "not a stream" (junk bodies, bad offsets, a
    // corrupt object stream); an object that makes it throw is skipped all the same, so one
    // damaged object never turns the whole check into an error.
    let entry: PDFObject;
    try {
      entry = doc.newIndirect(number);
      if (!entry.isStream()) continue;
    } catch {
      continue;
    }
    for (const forbidden of ['F', 'FFilter', 'FDecodeParms']) {
      if (!entry.get(forbidden).isNull()) {
        findings.add('streams', { detail: `object ${number}: external stream (/${forbidden})` });
      }
    }
    if (filterNames(entry).some((name) => name === 'LZWDecode' || name === 'LZW')) {
      findings.add('streams', { detail: `object ${number}: LZW` });
    }
    const type = nameAt(entry, 'Type');
    if (part === 1 && (type === 'ObjStm' || type === 'XRef')) {
      findings.add('structure', {
        detail: `object ${number}: ${type === 'ObjStm' ? 'object stream' : 'cross-reference stream'}`,
      });
    }
    if (filterNames(entry).includes('Crypt'))
      findings.add('streams', { detail: `object ${number}: Crypt filter` });
  }
  return count <= OBJECT_SCAN_LIMIT;
}

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

const INFO_KEYS: readonly {
  readonly info: string;
  readonly read: (packet: XmpPacket) => string | null;
}[] = [
  { info: 'Title', read: (packet) => xmpText(packet, NS_DC, 'title') },
  { info: 'Author', read: (packet) => (xmpList(packet, NS_DC, 'creator') ?? []).join(', ') || null },
  { info: 'Subject', read: (packet) => xmpText(packet, NS_DC, 'description') },
  { info: 'Keywords', read: (packet) => xmpText(packet, NS_PDF, 'Keywords') },
  { info: 'Creator', read: (packet) => xmpText(packet, NS_XMP, 'CreatorTool') },
  { info: 'Producer', read: (packet) => xmpText(packet, NS_PDF, 'Producer') },
];

function infoText(info: PDFObject | null, name: string): string | null {
  if (info === null) return null;
  const value = resolved(info.get(name));
  if (value === null || !value.isString()) return null;
  return value.asString();
}

interface LoadedMetadata {
  readonly stream: PDFObject | null;
  readonly bytes: Uint8Array | null;
  readonly packet: XmpPacket | null;
}

function loadMetadata(catalog: PDFObject): LoadedMetadata {
  const metadata = catalog.get('Metadata');
  if (metadata.isNull() || !metadata.isStream()) return { stream: null, bytes: null, packet: null };
  const bytes = streamBytes(metadata);
  return { stream: metadata, bytes, packet: bytes === null ? null : parseXmp(bytes) };
}

function claimOf(packet: XmpPacket | null): PdfAClaim | null {
  if (packet === null || !packet.wellFormed) return null;
  return packet.claim.part === null && packet.claim.conformance === null ? null : packet.claim;
}

function checkMetadata(trailer: PDFObject, loaded: LoadedMetadata, part: PdfAPart, findings: Findings): void {
  const { stream, bytes, packet } = loaded;
  if (stream === null) {
    findings.add('xmp', { detail: 'the catalog has no /Metadata stream' });
    return;
  }
  if (nameAt(stream, 'Type') !== 'Metadata' || nameAt(stream, 'Subtype') !== 'XML') {
    findings.add('xmp', { detail: '/Type /Metadata and /Subtype /XML are required' });
  }
  if (part === 1 && !stream.get('Filter').isNull()) {
    findings.add('xmp', { detail: 'the metadata stream has a /Filter' });
  }
  if (bytes === null || packet === null) {
    findings.add('xmp', { detail: 'the metadata stream cannot be decoded' });
    return;
  }
  if (!packet.wellFormed) {
    findings.add('xmp', { detail: 'the metadata stream is not well-formed XMP' });
    return;
  }
  for (const namespace of packet.undescribedNamespaces) findings.add('xmp-schemas', { detail: namespace });

  if (part === 1) {
    const info = resolved(trailer.get('Info'));
    for (const entry of INFO_KEYS) {
      const fromInfo = infoText(info, entry.info);
      if (fromInfo === null || fromInfo === '') continue;
      const fromXmp = entry.read(packet);
      if (fromXmp === null)
        findings.add('xmp-info', { detail: `${entry.info}: missing from the metadata stream` });
      else if (fromXmp.trim() !== fromInfo.trim()) {
        findings.add('xmp-info', { detail: `${entry.info}: differs from the metadata stream` });
      }
    }
  }
}

function checkClaim(claim: PdfAClaim | null, part: PdfAPart, findings: Findings): void {
  if (claim === null || claim.part === null) {
    findings.add('xmp-claim', { detail: 'no pdfaid:part' });
    return;
  }
  if (claim.part.trim() !== String(part))
    findings.add('xmp-claim', { detail: `pdfaid:part is ${claim.part}, not ${part}` });
  const conformance = claim.conformance?.trim() ?? '';
  const allowed = part === 1 ? ['A', 'B'] : ['A', 'B', 'U'];
  if (conformance === '') findings.add('xmp-claim', { detail: 'no pdfaid:conformance' });
  else if (!allowed.includes(conformance)) {
    findings.add('xmp-claim', { detail: `pdfaid:conformance ${conformance} is not valid in part ${part}` });
  }
}

/* ------------------------------------------------------------------ *
 * Output intent
 * ------------------------------------------------------------------ */

function checkOutputIntents(
  catalog: PDFObject,
  findings: Findings,
): { present: boolean; space: 'RGB' | 'CMYK' | 'GRAY' | null } {
  const intents = arrayItems(catalog.get('OutputIntents'));
  let space: 'RGB' | 'CMYK' | 'GRAY' | null = null;
  let present = false;
  const profiles = new Set<number>();
  for (const intent of intents) {
    const target = resolved(intent);
    if (target === null || !target.isDictionary()) continue;
    if (nameAt(target, 'S') !== 'GTS_PDFA1') continue;
    present = true;
    const profile = target.get('DestOutputProfile');
    if (profile.isNull() || !profile.isStream()) {
      findings.add('output-intent', { detail: 'the PDF/A output intent has no /DestOutputProfile' });
      continue;
    }
    profiles.add(key(profile));
    const header = leadingBytes(profile, 128);
    if (header === null || header.length < 128) {
      findings.add('output-intent', { detail: 'the profile cannot be read as an ICC profile' });
      continue;
    }
    const tag = String.fromCharCode(...header.subarray(36, 40));
    if (tag !== 'acsp') {
      findings.add('output-intent', { detail: 'the profile has no ICC signature' });
      continue;
    }
    const major = header[8] as number;
    const deviceClass = String.fromCharCode(...header.subarray(12, 16));
    const colourSpace = String.fromCharCode(...header.subarray(16, 20)).trim();
    if (major > 4) findings.add('output-intent', { detail: `ICC version ${major}` });
    if (deviceClass !== 'prtr' && deviceClass !== 'mntr') {
      findings.add('output-intent', { detail: `profile class ${deviceClass}` });
    }
    const components = numberAt(profile, 'N');
    const expected =
      colourSpace === 'RGB' ? 3 : colourSpace === 'CMYK' ? 4 : colourSpace === 'GRAY' ? 1 : null;
    if (expected === null) findings.add('output-intent', { detail: `profile colour space ${colourSpace}` });
    else {
      space ??= colourSpace as 'RGB' | 'CMYK' | 'GRAY';
      if (components !== expected)
        findings.add('output-intent', {
          detail: `/N ${components ?? 'missing'} does not match ${colourSpace}`,
        });
    }
  }
  if (profiles.size > 1)
    findings.add('output-intent', { detail: 'the PDF/A output intents use different profiles' });
  return { present, space };
}

/* ------------------------------------------------------------------ *
 * Resources and content
 * ------------------------------------------------------------------ */

function resourceEntry(scope: Scope, category: string, name: string): PDFObject | null {
  const entries = dictionaryAt(scope.resources, category);
  if (entries === null) return null;
  const entry = entries.get(name);
  return entry.isNull() ? null : entry;
}

/** The colour space a name stands for: a device space, or a resource it is looked up in. */
function classifyName(name: string, scope: Scope, depth = 0): Cs {
  if (name === 'DeviceGray' || name === 'G') return 'DeviceGray';
  if (name === 'DeviceRGB' || name === 'RGB') return 'DeviceRGB';
  if (name === 'DeviceCMYK' || name === 'CMYK') return 'DeviceCMYK';
  if (name === 'Pattern') return 'other';
  const entry = resourceEntry(scope, 'ColorSpace', name);
  return entry === null ? 'unknown' : classifySpace(entry, scope, depth + 1);
}

/** The colour space an object stands for, as far as the device question needs. */
function classifySpace(space: PDFObject | null, scope: Scope, depth = 0): Cs {
  if (space === null || depth > 6) return 'unknown';
  const target = resolved(space);
  if (target === null) return 'unknown';
  if (target.isName()) return classifyName(target.asName(), scope, depth);
  if (target.isArray()) {
    const family = readName(target.get(0));
    if (family === 'Indexed' || family === 'I') return classifySpace(target.get(1), scope, depth + 1);
    if (family === 'Pattern')
      return target.length > 1 ? classifySpace(target.get(1), scope, depth + 1) : 'other';
    if (family === 'DeviceGray' || family === 'DeviceRGB' || family === 'DeviceCMYK') return family;
    return 'other';
  }
  return 'unknown';
}

function defaultFor(scope: Scope, device: Device): boolean {
  const name =
    device === 'DeviceGray' ? 'DefaultGray' : device === 'DeviceRGB' ? 'DefaultRGB' : 'DefaultCMYK';
  return resourceEntry(scope, 'ColorSpace', name) !== null;
}

function useDevice(context: Context, scope: Scope, device: Device): void {
  const { outputIntent } = context;
  const covered =
    defaultFor(scope, device) ||
    (outputIntent.present &&
      (device === 'DeviceGray' ||
        (device === 'DeviceRGB' && outputIntent.space === 'RGB') ||
        (device === 'DeviceCMYK' && outputIntent.space === 'CMYK')));
  if (covered) return;
  context.findings.addOnce('device-colour', `${scope.pageIndex}:${device}`, {
    pageIndex: scope.pageIndex,
    detail: device,
  });
}

function useSpace(context: Context, scope: Scope, space: Cs): void {
  if (space === 'DeviceGray' || space === 'DeviceRGB' || space === 'DeviceCMYK')
    useDevice(context, scope, space);
}

function fontKey(entry: PDFObject, scope: Scope, name: string): string {
  const number = key(entry);
  return number >= 0
    ? `#${number}`
    : `${scope.pageIndex}/${scope.depth}/${name}/${entry.toString().slice(0, 80)}`;
}

function blendIsNormal(value: PDFObject): boolean {
  const target = resolved(value);
  if (target === null) return true;
  if (target.isName()) return target.asName() === 'Normal' || target.asName() === 'Compatible';
  if (target.isArray()) {
    const first = readName(target.get(0));
    return first === 'Normal' || first === 'Compatible';
  }
  return true;
}

function checkExtGState(state: PDFObject, context: Context, scope: Scope): void {
  const { findings, part } = context;
  const where = { pageIndex: scope.pageIndex };
  if (part !== 1) {
    const mask = resolved(state.get('SMask'));
    const alpha = [numberAt(state, 'CA'), numberAt(state, 'ca')].some((value) => value !== null && value < 1);
    if (
      alpha ||
      (mask !== null && !(mask.isName() && mask.asName() === 'None')) ||
      !blendIsNormal(state.get('BM'))
    ) {
      context.pageTransparency = true;
    }
  }
  if (part === 1) {
    for (const alpha of ['CA', 'ca']) {
      const value = numberAt(state, alpha);
      if (value !== null && value < 1)
        findings.addOnce('transparency', `${scope.pageIndex}:alpha`, {
          ...where,
          detail: `/${alpha} ${value}`,
        });
    }
    const mask = resolved(state.get('SMask'));
    if (mask !== null && !(mask.isName() && mask.asName() === 'None')) {
      findings.addOnce('transparency', `${scope.pageIndex}:smask`, { ...where, detail: '/SMask' });
    }
    if (!blendIsNormal(state.get('BM')))
      findings.addOnce('transparency', `${scope.pageIndex}:bm`, { ...where, detail: '/BM' });
  }
  if (!state.get('TR').isNull())
    findings.addOnce('graphics-state', `${scope.pageIndex}:TR`, { ...where, detail: '/TR' });
  const transfer = resolved(state.get('TR2'));
  if (transfer !== null && !(transfer.isName() && transfer.asName() === 'Default')) {
    findings.addOnce('graphics-state', `${scope.pageIndex}:TR2`, { ...where, detail: '/TR2' });
  }
  if (!state.get('HTP').isNull())
    findings.addOnce('graphics-state', `${scope.pageIndex}:HTP`, { ...where, detail: '/HTP' });
  const halftone = resolved(state.get('HT'));
  if (halftone?.isDictionary()) {
    const type = numberAt(halftone, 'HalftoneType');
    if (type !== 1 && type !== 5)
      findings.addOnce('graphics-state', `${scope.pageIndex}:HT`, {
        ...where,
        detail: `/HalftoneType ${type ?? '?'}`,
      });
    if (!halftone.get('HalftoneName').isNull())
      findings.addOnce('graphics-state', `${scope.pageIndex}:HTN`, { ...where, detail: '/HalftoneName' });
  }
}

function checkImageDictionary(image: PDFObject, context: Context, scope: Scope): void {
  const { findings, part } = context;
  const where = { pageIndex: scope.pageIndex };
  if (!image.get('Alternates').isNull())
    findings.addOnce('images', `${scope.pageIndex}:alt`, { ...where, detail: '/Alternates' });
  if (!image.get('OPI').isNull())
    findings.addOnce('images', `${scope.pageIndex}:opi`, { ...where, detail: '/OPI' });
  const interpolate = resolved(image.get('Interpolate'));
  if (interpolate?.isBoolean() === true && interpolate.asBoolean()) {
    findings.addOnce('images', `${scope.pageIndex}:interp`, { ...where, detail: '/Interpolate true' });
  }
  if (part !== 1 && (!image.get('SMask').isNull() || (numberAt(image, 'SMaskInData') ?? 0) > 0)) {
    context.pageTransparency = true;
  }
  if (part === 1) {
    if (!image.get('SMask').isNull())
      findings.addOnce('transparency', `${scope.pageIndex}:imgsmask`, { ...where, detail: 'image /SMask' });
    const inData = numberAt(image, 'SMaskInData');
    if (inData !== null && inData > 0)
      findings.addOnce('transparency', `${scope.pageIndex}:smaskindata`, {
        ...where,
        detail: '/SMaskInData',
      });
  }
  if (filterNames(image).some((name) => name === 'LZWDecode' || name === 'LZW')) {
    findings.addOnce('streams', `img${key(image)}`, { detail: 'LZW image' });
  }
}

function scanForm(form: PDFObject, context: Context, parent: Scope): void {
  if (parent.depth >= MAX_FORM_DEPTH) return;
  const number = key(form);
  if (number >= 0) {
    if (context.visited.has(number)) return;
    context.visited.add(number);
  }
  const subtype = nameAt(form, 'Subtype');
  if (subtype === 'PS' || !form.get('PS').isNull()) {
    context.findings.addOnce('graphics-state', `ps${number}`, {
      pageIndex: parent.pageIndex,
      detail: 'PostScript XObject',
    });
    return;
  }
  if (!form.get('Ref').isNull())
    context.findings.addOnce('graphics-state', `ref${number}`, {
      pageIndex: parent.pageIndex,
      detail: '/Ref',
    });
  if (!form.get('OPI').isNull())
    context.findings.addOnce('graphics-state', `opi${number}`, {
      pageIndex: parent.pageIndex,
      detail: '/OPI',
    });
  const group = dictionaryAt(form, 'Group');
  if (context.part === 1 && group !== null && nameAt(group, 'S') === 'Transparency') {
    context.findings.addOnce('transparency', `${parent.pageIndex}:group`, {
      pageIndex: parent.pageIndex,
      detail: 'transparency group',
    });
  }
  if (filterNames(form).some((name) => name === 'LZWDecode' || name === 'LZW')) {
    context.findings.addOnce('streams', `form${number}`, { detail: 'LZW form' });
  }
  const own = dictionaryAt(form, 'Resources');
  const scope: Scope = {
    resources: own ?? parent.resources,
    pageIndex: parent.pageIndex,
    depth: parent.depth + 1,
  };
  scanStream(form, context, scope, 'unknown');
}

/** Read a content stream: colour use, font use, and the objects it paints. */
function scanStream(stream: PDFObject, context: Context, scope: Scope, initial: Cs): void {
  if (context.signal !== undefined) throwIfAborted(context.signal);
  const bytes = streamBytes(stream);
  if (bytes === null) {
    context.unreadable += 1;
    return;
  }
  scanBytes(bytes, context, scope, initial);
}

function scanBytes(bytes: Uint8Array, context: Context, scope: Scope, initial: Cs): void {
  if (context.budget < bytes.length) {
    context.budgetExhausted = true;
    return;
  }
  context.budget -= bytes.length;
  let state: Graphics = { fill: initial, stroke: initial, font: null, mode: 0 };
  const stack: Graphics[] = [];

  const paintFill = (): void => useSpace(context, scope, state.fill);
  const paintStroke = (): void => useSpace(context, scope, state.stroke);

  const select = (operands: readonly Operand[], target: 'fill' | 'stroke'): void => {
    const name = nameOf(operands[0]);
    state = { ...state, [target]: name === null ? 'unknown' : classifyName(name, scope) };
  };

  const paintText = (): void => {
    const visible = state.mode === 0 || state.mode === 2 || state.mode === 4 || state.mode === 6;
    const stroked = state.mode === 1 || state.mode === 2 || state.mode === 5 || state.mode === 6;
    if (visible) paintFill();
    if (stroked) paintStroke();
    if (state.font !== null) {
      const entry = resourceEntry(scope, 'Font', state.font);
      if (entry !== null) {
        const id = fontKey(entry, scope, state.font);
        const known = context.fonts.get(id);
        const visible = state.mode !== 3;
        if (known === undefined) context.fonts.set(id, { font: entry, pageIndex: scope.pageIndex, visible });
        else if (visible) known.visible = true;
      }
    }
  };

  scanContent(bytes, (operator, operands) => {
    switch (operator) {
      case 'q':
        stack.push({ ...state });
        break;
      case 'Q': {
        const previous = stack.pop();
        if (previous !== undefined) state = previous;
        break;
      }
      case 'g':
        state = { ...state, fill: 'DeviceGray' };
        break;
      case 'G':
        state = { ...state, stroke: 'DeviceGray' };
        break;
      case 'rg':
        state = { ...state, fill: 'DeviceRGB' };
        break;
      case 'RG':
        state = { ...state, stroke: 'DeviceRGB' };
        break;
      case 'k':
        state = { ...state, fill: 'DeviceCMYK' };
        break;
      case 'K':
        state = { ...state, stroke: 'DeviceCMYK' };
        break;
      case 'cs':
        select(operands, 'fill');
        break;
      case 'CS':
        select(operands, 'stroke');
        break;
      case 'scn':
      case 'SCN': {
        // A pattern name as the last operand selects a pattern; its content is read once.
        const last = operands[operands.length - 1];
        const patternName = nameOf(last);
        if (patternName !== null) scanPattern(patternName, context, scope);
        break;
      }
      case 'Tf':
        state = { ...state, font: nameOf(operands[0]) };
        break;
      case 'Tr':
        state = { ...state, mode: numberOf(operands[0]) ?? 0 };
        break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"':
        paintText();
        break;
      case 'f':
      case 'F':
      case 'f*':
        paintFill();
        break;
      case 'S':
      case 's':
        paintStroke();
        break;
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        paintFill();
        paintStroke();
        break;
      case 'gs': {
        const name = nameOf(operands[0]);
        const entry = name === null ? null : resourceEntry(scope, 'ExtGState', name);
        if (entry?.isDictionary()) {
          const number = key(entry);
          if (number < 0 || !context.states.has(number)) {
            if (number >= 0) context.states.add(number);
            checkExtGState(entry, context, scope);
            const mask = dictionaryAt(entry, 'SMask');
            const group = mask === null ? null : mask.get('G');
            if (group !== null && !group.isNull() && group.isStream()) scanForm(group, context, scope);
          }
        }
        break;
      }
      case 'sh': {
        const name = nameOf(operands[0]);
        const shading = name === null ? null : resourceEntry(scope, 'Shading', name);
        if (shading !== null)
          useSpace(context, scope, classifySpace(resolved(shading)?.get('ColorSpace') ?? null, scope));
        break;
      }
      case 'Do': {
        const name = nameOf(operands[0]);
        const entry = name === null ? null : resourceEntry(scope, 'XObject', name);
        if (entry === null) break;
        const subtype = nameAt(entry, 'Subtype');
        if (subtype === 'Image') {
          // Every use is read: the colour an image mask paints with and the page's transparency
          // belong to the use, and the findings are counted once per page already.
          checkImageDictionary(entry, context, scope);
          const mask = resolved(entry.get('ImageMask'));
          if (mask?.isBoolean() === true && mask.asBoolean()) paintFill();
          else useSpace(context, scope, classifySpace(entry.get('ColorSpace'), scope));
        } else if (subtype === 'Form' || subtype === 'PS') {
          scanForm(entry, context, scope);
        }
        break;
      }
      case 'BI': {
        // `scanContent` hands `BI` exactly one operand: the inline image's dictionary.
        const { entries } = operands[0] as Extract<Operand, { readonly t: 'dict' }>;
        const mask = entries.get('IM') ?? entries.get('ImageMask');
        if (mask?.t === 'bool' && mask.v) paintFill();
        else {
          const space = entries.get('CS') ?? entries.get('ColorSpace');
          const inline = inlineSpace(space, scope);
          useSpace(context, scope, inline);
        }
        const filter = entries.get('F') ?? entries.get('Filter');
        const names =
          filter?.t === 'name'
            ? [filter.v]
            : filter?.t === 'arr'
              ? filter.items.map((item) => nameOf(item) ?? '')
              : [];
        if (names.some((name) => name === 'LZW' || name === 'LZWDecode')) {
          context.findings.addOnce('streams', `inline${scope.pageIndex}`, {
            pageIndex: scope.pageIndex,
            detail: 'LZW inline image',
          });
        }
        break;
      }
      default:
        break;
    }
  });
}

function inlineSpace(operand: Operand | undefined, scope: Scope): Cs {
  if (operand === undefined) return 'unknown';
  if (operand.t === 'name') return classifyName(operand.v, scope);
  if (operand.t === 'arr') {
    const family = nameOf(operand.items[0]);
    if (family === 'I' || family === 'Indexed') return inlineSpace(operand.items[1], scope);
  }
  return 'other';
}

function scanPattern(name: string, context: Context, scope: Scope): void {
  const entry = resourceEntry(scope, 'Pattern', name);
  if (entry === null) return;
  const type = numberAt(entry, 'PatternType');
  if (type === 2) {
    const shading = dictionaryAt(entry, 'Shading');
    if (shading !== null) useSpace(context, scope, classifySpace(shading.get('ColorSpace'), scope));
    const state = dictionaryAt(entry, 'ExtGState');
    if (state !== null) checkExtGState(state, context, scope);
    return;
  }
  if (!entry.isStream()) return;
  // A stream is always an indirect object, so it has a number.
  const number = key(entry);
  if (context.visited.has(number)) return;
  context.visited.add(number);
  const own = dictionaryAt(entry, 'Resources');
  scanStream(
    entry,
    context,
    { resources: own ?? scope.resources, pageIndex: scope.pageIndex, depth: scope.depth + 1 },
    'unknown',
  );
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

/** `ABCDEF+Name`: the six-letter tag a font subset carries (ISO 32000-1 9.6.4). */
const SUBSET_TAG = /^[A-Z]{6}\+/;

const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3'] as const;

function descriptorEmbeds(descriptor: PDFObject | null): boolean {
  return descriptor !== null && FONT_FILE_KEYS.some((name) => !descriptor.get(name).isNull());
}

function checkFont(font: PDFObject, pageIndex: number, part: PdfAPart, findings: Findings): void {
  if (!font.isDictionary()) return;
  const subtype = nameAt(font, 'Subtype');
  if (subtype === 'Type3') return;
  const baseFont = nameAt(font, 'BaseFont') ?? '(unnamed)';
  if (subtype === 'Type0') {
    const descendant = arrayItems(font.get('DescendantFonts'))
      .map((entry) => resolved(entry))
      .find((entry) => entry?.isDictionary());
    if (descendant === undefined || descendant === null) {
      findings.addOnce('fonts', `${baseFont}:nodescendant`, { pageIndex, detail: baseFont });
      return;
    }
    const descriptor = dictionaryAt(descendant, 'FontDescriptor');
    if (!descriptorEmbeds(descriptor)) {
      findings.addOnce('fonts', baseFont, { pageIndex, detail: baseFont });
      return;
    }
    // Part 1 wants a subset's glyph list in the descriptor: /CIDSet for CID fonts, /CharSet for Type 1.
    if (part === 1 && SUBSET_TAG.test(baseFont) && descriptor?.get('CIDSet').isNull()) {
      findings.addOnce('fonts', `${baseFont}:cidset`, { pageIndex, detail: `${baseFont}: no /CIDSet` });
    }
    if (
      nameAt(descendant, 'Subtype') === 'CIDFontType2' &&
      descriptor !== null &&
      !descriptor.get('FontFile2').isNull()
    ) {
      const map = descendant.get('CIDToGIDMap');
      if (map.isNull())
        findings.addOnce('fonts', `${baseFont}:cidtogid`, {
          pageIndex,
          detail: `${baseFont}: no /CIDToGIDMap`,
        });
    }
    return;
  }
  const descriptor = dictionaryAt(font, 'FontDescriptor');
  if (!descriptorEmbeds(descriptor)) {
    findings.addOnce('fonts', baseFont, { pageIndex, detail: baseFont });
  } else if (
    part === 1 &&
    subtype === 'Type1' &&
    SUBSET_TAG.test(baseFont) &&
    descriptor?.get('CharSet').isNull()
  ) {
    findings.addOnce('fonts', `${baseFont}:charset`, { pageIndex, detail: `${baseFont}: no /CharSet` });
  }
}

/* ------------------------------------------------------------------ *
 * Annotations, actions, forms
 * ------------------------------------------------------------------ */

function checkAction(
  action: PDFObject | null,
  findings: Findings,
  pageIndex: number | undefined,
  depth = 0,
): void {
  const target = resolved(action);
  if (target === null || depth > 16) return;
  if (target.isArray()) return; // a destination
  if (!target.isDictionary()) return;
  const type = nameAt(target, 'S');
  const where = pageIndex === undefined ? {} : { pageIndex };
  if (type !== null && ACTIONS_FORBIDDEN.has(type)) {
    findings.add('actions', { ...where, detail: type });
  } else if (type === 'Named') {
    const named = nameAt(target, 'N');
    if (named === null || !NAMED_ACTIONS_ALLOWED.has(named))
      findings.add('actions', { ...where, detail: `Named ${named ?? '?'}` });
  }
  const next = resolved(target.get('Next'));
  if (next !== null) {
    if (next.isArray())
      for (const entry of arrayItems(next)) checkAction(entry, findings, pageIndex, depth + 1);
    else checkAction(next, findings, pageIndex, depth + 1);
  }
}

function checkAnnotation(annotation: PDFObject, pageIndex: number, context: Context, scope: Scope): void {
  const { findings, part } = context;
  if (!annotation.isDictionary()) return;
  const subtype = nameAt(annotation, 'Subtype') ?? '?';
  const where = { pageIndex };
  if (FORBIDDEN_ANNOTATIONS.get(part)?.has(subtype) === true)
    findings.add('annotations', { ...where, detail: subtype });
  if (subtype !== 'Popup') {
    const flags = numberAt(annotation, 'F');
    // Print (bit 3) set; Invisible (1), Hidden (2) and NoView (6) clear.
    if (flags === null) findings.add('annotations', { ...where, detail: `${subtype}: no /F` });
    else if ((flags & 4) === 0 || (flags & 1) !== 0 || (flags & 2) !== 0 || (flags & 32) !== 0) {
      findings.add('annotations', { ...where, detail: `${subtype}: flags ${flags}` });
    }
  }
  const appearance = dictionaryAt(annotation, 'AP');
  if (subtype !== 'Popup' && subtype !== 'Link') {
    const rect = arrayItems(annotation.get('Rect')).map((entry) => {
      const value = resolved(entry);
      return value?.isNumber() === true ? value.asNumber() : 0;
    });
    const empty = rect.length >= 4 && rect[0] === rect[2] && rect[1] === rect[3];
    if (!empty && (appearance === null || appearance.get('N').isNull())) {
      findings.add('annotations', { ...where, detail: `${subtype}: no appearance stream` });
    }
  }
  if (appearance !== null) {
    if (part === 1) {
      const extra: string[] = [];
      appearance.forEach((_value, name) => {
        if (name !== 'N') extra.push(String(name));
      });
      if (extra.length > 0)
        findings.add('annotations', { ...where, detail: `${subtype}: /AP /${extra.join(' /')}` });
    }
    const normal = appearance.get('N');
    const streams: PDFObject[] = [];
    if (normal.isStream()) streams.push(normal);
    else {
      const states = resolved(normal);
      if (states?.isDictionary() === true) {
        states.forEach((value) => {
          if (value.isStream()) streams.push(value);
        });
      }
    }
    for (const stream of streams) scanForm(stream, context, scope);
  }
  if (subtype === 'Widget') {
    if (!annotation.get('A').isNull() || !annotation.get('AA').isNull()) {
      findings.add('forms', { ...where, detail: 'a widget has /A or /AA' });
    }
  }
  checkAction(annotation.get('A'), findings, pageIndex);
}

function checkForms(catalog: PDFObject, findings: Findings): void {
  const form = dictionaryAt(catalog, 'AcroForm');
  if (form === null) return;
  const needs = resolved(form.get('NeedAppearances'));
  if (needs?.isBoolean() === true && needs.asBoolean())
    findings.add('forms', { detail: 'NeedAppearances is true' });
  if (!form.get('XFA').isNull()) findings.add('forms', { detail: 'the form has XFA data' });
  const seen = new Set<number>();
  const visit = (field: PDFObject, depth: number): void => {
    if (depth > 24) return;
    const number = key(field);
    if (number >= 0) {
      if (seen.has(number)) return;
      seen.add(number);
    }
    const target = resolved(field);
    if (target === null || !target.isDictionary()) return;
    if (!target.get('A').isNull() || !target.get('AA').isNull())
      findings.add('forms', { detail: 'a field has /A or /AA' });
    for (const kid of arrayItems(target.get('Kids'))) visit(kid, depth + 1);
  };
  for (const field of arrayItems(form.get('Fields'))) visit(field, 0);
}

function checkEmbeddedFile(spec: PDFObject, part: PdfAPart, findings: Findings, label: string): void {
  const target = resolved(spec);
  if (target === null || !target.isDictionary()) return;
  const files = dictionaryAt(target, 'EF');
  const stream = files === null ? null : files.get('F').isNull() ? files.get('UF') : files.get('F');
  const mime = stream !== null && !stream.isNull() ? nameAt(stream, 'Subtype') : null;
  if (part === 1) {
    findings.add('embedded-files', { detail: label });
    return;
  }
  if (part === 2) {
    if (mime !== 'application/pdf')
      findings.add('embedded-files', { detail: `${label}: only PDF/A files may be embedded` });
    return;
  }
  const relationship = nameAt(target, 'AFRelationship');
  if (relationship === null || !AF_RELATIONSHIPS.has(relationship)) {
    findings.add('embedded-files', { detail: `${label}: no valid /AFRelationship` });
  }
  if (mime === null)
    findings.add('embedded-files', { detail: `${label}: the embedded stream has no /Subtype` });
}

function checkEmbeddedFiles(doc: PDFDocument, part: PdfAPart, findings: Findings): void {
  let files: Record<string, PDFObject> = {};
  try {
    files = doc.loadNameTree('EmbeddedFiles');
  } catch {
    files = {};
  }
  for (const [name, spec] of Object.entries(files)) checkEmbeddedFile(spec, part, findings, name);
}

function checkLayers(catalog: PDFObject, part: PdfAPart, findings: Findings): void {
  const properties = dictionaryAt(catalog, 'OCProperties');
  if (properties === null) return;
  if (part === 1) {
    findings.add('layers', { detail: '/OCProperties' });
    return;
  }
  const configs = [
    dictionaryAt(properties, 'D'),
    ...arrayItems(properties.get('Configs')).map((entry) => resolved(entry)),
  ];
  for (const config of configs) {
    if (config === null || !config.isDictionary()) continue;
    if (config.get('Name').isNull()) findings.add('layers', { detail: 'a configuration has no /Name' });
    if (!config.get('AS').isNull()) findings.add('layers', { detail: 'a configuration has /AS' });
  }
}

function checkOutlineActions(catalog: PDFObject, findings: Findings): void {
  const outlines = dictionaryAt(catalog, 'Outlines');
  if (outlines === null) return;
  const seen = new Set<number>();
  let steps = 0;
  const stack: PDFObject[] = [outlines.get('First')];
  while (stack.length > 0 && steps < 100_000) {
    steps += 1;
    const item = stack.pop();
    if (item === undefined || item.isNull()) continue;
    const number = key(item);
    if (number >= 0) {
      if (seen.has(number)) continue;
      seen.add(number);
    }
    const target = resolved(item);
    if (target === null || !target.isDictionary()) continue;
    checkAction(target.get('A'), findings, undefined);
    stack.push(target.get('Next'));
    stack.push(target.get('First'));
  }
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

function claimPart(claim: PdfAClaim | null): PdfAPart | null {
  const part = claim?.part?.trim();
  return part === '1' || part === '2' || part === '3' ? (Number(part) as PdfAPart) : null;
}

/**
 * Check `bytes` for the rules above. Never throws for a damaged file (that is a finding); an
 * aborted signal rethrows `AbortError`, and an engine failure becomes a `ToolError`.
 */
export async function checkPdfA(
  bytes: Uint8Array,
  options: PdfACheckOptions = {},
  signal?: AbortSignal,
): Promise<PdfACheckReport> {
  if (signal !== undefined) throwIfAborted(signal);
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    return await run(doc, bytes, options, signal);
  } catch (error) {
    throw engineFailure(error, 'pdfa check');
  } finally {
    doc.destroy();
  }
}

async function run(
  doc: PDFDocument,
  bytes: Uint8Array,
  options: PdfACheckOptions,
  signal: AbortSignal | undefined,
): Promise<PdfACheckReport> {
  const findings = new Findings();
  const trailer = doc.getTrailer();
  const catalog = trailer.get('Root');

  // Encryption: an authenticated owner-only document opens, but it is encrypted all the same.
  if (!trailer.get('Encrypt').isNull()) findings.add('encryption', { detail: '/Encrypt in the trailer' });
  if (doc.needsPassword()) {
    return finish(findings, {
      claim: null,
      target: { part: options.part ?? 2, conformance: 'B' },
      targetFromClaim: false,
      pageCount: 0,
      unreadable: true,
      incomplete: new Set(PDFA_RULE_IDS.filter((rule) => rule !== 'encryption')),
    });
  }

  // Which part the rules are applied for depends on what the file claims, which is read first.
  const loaded = loadMetadata(catalog);
  const claim = claimOf(loaded.packet);
  const claimed = claimPart(claim);
  const part: PdfAPart = options.part ?? claimed ?? 2;
  const conformanceRaw = claim?.conformance?.trim().toUpperCase();
  const conformance = conformanceRaw === 'A' || conformanceRaw === 'U' ? conformanceRaw : 'B';

  const incomplete = new Set<PdfARuleId>();
  checkBytes(bytes, findings);
  if (trailer.get('ID').isNull()) findings.add('trailer', { detail: 'no /ID in the trailer' });
  if (doc.wasRepaired())
    findings.add('structure', { detail: 'the cross-reference table had to be repaired' });
  if (!checkAllObjects(doc, part, findings)) incomplete.add('streams');

  checkMetadata(trailer, loaded, part, findings);
  checkClaim(claim, part, findings);
  const outputIntent = checkOutputIntents(catalog, findings);

  const context: Context = {
    part,
    findings,
    signal,
    outputIntent,
    visited: new Set(),
    fonts: new Map(),
    states: new Set(),
    pageTransparency: false,
    budget: options.contentBudget ?? DEFAULT_CONTENT_BUDGET,
    budgetExhausted: false,
    unreadable: 0,
  };

  // Catalog-level actions and rules.
  if (!catalog.get('AA').isNull()) findings.add('actions', { detail: 'the catalog has /AA' });
  checkAction(catalog.get('OpenAction'), findings, undefined);
  let scripts: Record<string, PDFObject> = {};
  try {
    scripts = doc.loadNameTree('JavaScript');
  } catch {
    scripts = {};
  }
  for (const name of Object.keys(scripts)) findings.add('actions', { detail: `JavaScript: ${name}` });
  checkForms(catalog, findings);
  checkLayers(catalog, part, findings);
  checkOutlineActions(catalog, findings);
  checkEmbeddedFiles(doc, part, findings);

  const pageCount = doc.countPages();
  for (let index = 0; index < pageCount; index += 1) {
    if (signal !== undefined) throwIfAborted(signal);
    const page = doc.findPage(index);
    const resources = resolved(page.getInheritable('Resources'));
    const scope: Scope = {
      resources: resources?.isDictionary() === true ? resources : null,
      pageIndex: index,
      depth: 0,
    };
    const group = dictionaryAt(page, 'Group');
    if (part === 1 && group !== null && nameAt(group, 'S') === 'Transparency') {
      findings.add('transparency', { pageIndex: index, detail: 'page /Group' });
    }
    context.pageTransparency = false;
    if (part === 1 && !page.get('AA').isNull())
      findings.add('actions', { pageIndex: index, detail: 'page /AA' });

    // The page's content streams, as one stream: a token never straddles two of them.
    const contents = page.get('Contents');
    const parts: PDFObject[] = [];
    if (contents.isStream()) parts.push(contents);
    else for (const entry of arrayItems(contents)) if (entry.isStream()) parts.push(entry);
    if (parts.length > 0) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (const stream of parts) {
        const data = streamBytes(stream);
        if (data === null) {
          context.unreadable += 1;
          continue;
        }
        chunks.push(data);
        total += data.length + 1;
      }
      const joined = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        joined[at + chunk.length] = 0x0a;
        at += chunk.length + 1;
      }
      scanBytes(joined, context, scope, 'DeviceGray');
    }

    for (const annotation of arrayItems(page.get('Annots'))) {
      const target = resolved(annotation);
      if (target !== null) checkAnnotation(target, index, context, scope);
    }
    // Without a PDF/A output intent, a page that uses transparency has to name the colour
    // space its groups blend in (`/Group /CS`), which is what 6.2.10 asks for.
    if (
      part !== 1 &&
      context.pageTransparency &&
      !outputIntent.present &&
      (group === null || group.get('CS').isNull())
    ) {
      findings.add('transparency', {
        pageIndex: index,
        detail: 'transparency without an output intent or /Group /CS',
      });
    }
  }

  // Fonts a content stream painted with, judged once each. Part 1 has no exception for
  // invisible text (render mode 3); parts 2 and 3 do, which is what an OCR layer relies on.
  for (const entry of context.fonts.values()) {
    if (entry.visible || part === 1) checkFont(entry.font, entry.pageIndex, part, findings);
  }
  if (context.budgetExhausted || context.unreadable > 0) {
    incomplete.add('device-colour');
    incomplete.add('fonts');
    incomplete.add('transparency');
    incomplete.add('images');
    incomplete.add('graphics-state');
  }

  return finish(findings, {
    claim,
    target: { part, conformance },
    targetFromClaim: options.part === undefined && claimed !== null,
    pageCount,
    unreadable: false,
    incomplete,
  });
}

function finish(
  findings: Findings,
  facts: {
    readonly claim: PdfAClaim | null;
    readonly target: { readonly part: PdfAPart; readonly conformance: 'A' | 'B' | 'U' };
    readonly targetFromClaim: boolean;
    readonly pageCount: number;
    readonly unreadable: boolean;
    readonly incomplete: ReadonlySet<PdfARuleId>;
  },
): PdfACheckReport {
  const rules: PdfARuleResult[] = PDFA_RULE_IDS.map((id) => {
    const found = findings.get(id);
    // `xmp-info` is part 1's; every other rule runs in every part.
    if (id === 'xmp-info' && facts.target.part !== 1) return { id, state: 'na', count: 0, samples: [] };
    if (found !== undefined && found.count > 0)
      return { id, state: 'fail', count: found.count, samples: found.samples };
    if (facts.incomplete.has(id)) return { id, state: 'unchecked', count: 0, samples: [] };
    return { id, state: 'pass', count: 0, samples: [] };
  });
  const violations = rules.reduce((total, rule) => total + rule.count, 0);
  const claims = facts.claim !== null;
  const verdict: PdfAVerdict = facts.unreadable
    ? 'unreadable'
    : !claims
      ? 'no-claim'
      : violations === 0
        ? 'claims-and-meets'
        : 'claims-with-violations';
  return {
    verdict,
    claim: facts.claim,
    target: facts.target,
    targetFromClaim: facts.targetFromClaim,
    rules,
    violations,
    pageCount: facts.pageCount,
    checked: rules.filter((rule) => rule.state === 'pass' || rule.state === 'fail').map((rule) => rule.id),
    unchecked: rules.filter((rule) => rule.state === 'unchecked').map((rule) => rule.id),
    notChecked: NOT_CHECKED,
  };
}

/** The failed rules' ids with their counts, for an error's diagnostic text. */
export function summariseViolations(report: PdfACheckReport): string {
  return report.rules
    .filter((rule) => rule.state === 'fail')
    .map(
      (rule) =>
        `${rule.id}×${rule.count}${rule.samples[0]?.detail === undefined ? '' : ` (${rule.samples[0].detail})`}`,
    )
    .join('; ');
}
