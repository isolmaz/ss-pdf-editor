/**
 * A PDF/UA-1 (ISO 14289-1) check: the requirements of the standard that can be decided
 * from the file alone, each with its own verdict, the places that fail, and a way to fix
 * them — and an honest list of what a program cannot decide.
 *
 * ## Modelled on
 *
 * The Matterhorn Protocol's checkpoints (the PDF Association's machine/human split of
 * ISO 14289-1, whose checkpoint *groups* — 01 real content tagged, 06 metadata, 11 natural
 * language, 13 graphics, 14 headings, 15 tables, 16 lists, 28 annotations, 31 fonts … — are
 * cited per rule), and on what Acrobat's accessibility check and the PDF Association's PAC
 * report. The rules were written from the standard's text and from reading how veraPDF
 * states them; **this is not a certified validator**, and the report says so (a passing
 * automated check is necessary, not sufficient).
 *
 * ## Four verdicts, never a score
 *
 *   - `pass` — the check ran and the requirement holds;
 *   - `fail` — it ran and found the instances listed (with the page or element);
 *   - `manual` — a human has to decide (reading order, alt-text quality, colour contrast,
 *     language of passages): a program can only point at where to look;
 *   - `na` — nothing in the file is subject to the rule (no tables, no forms);
 *   - `unchecked` — the check could not run (an unreadable page, no structure tree to walk).
 *
 * `unchecked` is not `pass`: a document without a structure tree has *unknown* tables, not
 * zero of them.
 *
 * ## Colour contrast is out of scope
 *
 * PDF/UA does not state a contrast ratio; WCAG does, and measuring it means rendering and
 * sampling, which this check does not do. The rule is listed as `manual` so the report
 * cannot be read as having looked.
 *
 * ## The identifier
 *
 * `markPdfUa` writes `pdfuaid:part` only when every *automated* rule passes, re-checked at
 * write time, and says in its notes that the manual rules remain the author's. A file that
 * fails a rule is never labelled.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import { openForWrite, pageObjects, resolved, saveRewrite, text, visibleBox } from '../engines/mupdf-write';
import {
  type Claim,
  catalogOf,
  decodeStream,
  dictOf,
  FIELD_WALK_LIMIT,
  FINDING_ROW_LIMIT,
  FORM_DEPTH_LIMIT,
  findField,
  intOf,
  isAbort,
  latin1,
  nameOf,
  pageContent,
  pageNumbers,
  readFields,
  readInstructions,
  readXmpPacket,
  spliceMarkedContent,
  textOf,
} from './accessibility';
import { type ContentMarks, coverageOf, enclosing, PATH_CONSTRUCTION, scanContent } from './content-scan';
import { PRODUCER_LINE } from './metadata';
import { contentHooks, resourceHooks } from './structure';
import {
  elementKids,
  nodePages,
  readStructureModel,
  resolveRole,
  STANDARD_ROLES,
  type StructNode,
  type StructureModel,
  walkNodes,
} from './structure-model';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';
import { buildUaPacket, editUaPacket, readUaPart, readXmpTitle } from './ua-xmp';

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

export type UaState = 'pass' | 'fail' | 'manual' | 'na' | 'unchecked';

export type UaGroup =
  | 'document'
  | 'structure'
  | 'content'
  | 'graphics'
  | 'tables'
  | 'lists'
  | 'links'
  | 'forms'
  | 'fonts'
  | 'navigation';

/** The quick fixes `fixPdfUa` knows. */
export type UaFixKind =
  | 'title'
  | 'display-title'
  | 'lang'
  | 'tabs'
  | 'marked'
  | 'artifact-paths'
  | 'link-contents'
  | 'field-tooltip'
  | 'tag-annots'
  | 'mark-pdfua';

interface UaRuleMeta {
  readonly id: string;
  readonly group: UaGroup;
  /** The Matterhorn Protocol checkpoint group the rule belongs to. */
  readonly matterhorn: string;
  /** The ISO 14289-1 clause. */
  readonly iso: string;
  readonly fix?: UaFixKind;
  /** A rule only a person can decide. */
  readonly manual?: boolean;
}

/** Every rule, in the order the report shows them. */
export const UA_RULES = [
  { id: 'marked', group: 'document', matterhorn: '06', iso: '7.1', fix: 'marked' },
  { id: 'title', group: 'document', matterhorn: '06', iso: '7.1', fix: 'title' },
  { id: 'display-title', group: 'document', matterhorn: '07', iso: '7.1', fix: 'display-title' },
  { id: 'lang', group: 'document', matterhorn: '11', iso: '7.2', fix: 'lang' },
  { id: 'pdfua-id', group: 'document', matterhorn: '06', iso: '5', fix: 'mark-pdfua' },
  { id: 'encryption', group: 'document', matterhorn: '26', iso: '7.16' },
  { id: 'xfa', group: 'document', matterhorn: '25', iso: '7.15' },
  { id: 'struct-tree', group: 'structure', matterhorn: '01', iso: '7.1' },
  { id: 'role-map', group: 'structure', matterhorn: '02', iso: '7.1' },
  { id: 'artifact-nesting', group: 'structure', matterhorn: '01', iso: '7.1' },
  { id: 'headings', group: 'structure', matterhorn: '14', iso: '7.4' },
  { id: 'reading-order', group: 'structure', matterhorn: '09', iso: '7.2', manual: true },
  { id: 'tagged-content', group: 'content', matterhorn: '01', iso: '7.1', fix: 'artifact-paths' },
  { id: 'mcid-references', group: 'content', matterhorn: '01', iso: '7.1' },
  { id: 'image-only', group: 'content', matterhorn: '08', iso: '7.1' },
  { id: 'figure-alt', group: 'graphics', matterhorn: '13', iso: '7.3' },
  { id: 'alt-quality', group: 'graphics', matterhorn: '13', iso: '7.3', manual: true },
  { id: 'contrast', group: 'graphics', matterhorn: '04', iso: '7.1', manual: true },
  { id: 'table-structure', group: 'tables', matterhorn: '15', iso: '7.5' },
  { id: 'table-headers', group: 'tables', matterhorn: '15', iso: '7.5' },
  { id: 'table-scope', group: 'tables', matterhorn: '15', iso: '7.5' },
  { id: 'table-regular', group: 'tables', matterhorn: '15', iso: '7.5' },
  { id: 'list-structure', group: 'lists', matterhorn: '16', iso: '7.6' },
  { id: 'link-tagged', group: 'links', matterhorn: '28', iso: '7.18.5', fix: 'tag-annots' },
  { id: 'link-alt', group: 'links', matterhorn: '28', iso: '7.18.5', fix: 'link-contents' },
  { id: 'annot-tagged', group: 'forms', matterhorn: '28', iso: '7.18.1', fix: 'tag-annots' },
  { id: 'form-tagged', group: 'forms', matterhorn: '28', iso: '7.18.4', fix: 'tag-annots' },
  { id: 'form-tooltip', group: 'forms', matterhorn: '28', iso: '7.18.1', fix: 'field-tooltip' },
  { id: 'tab-order', group: 'forms', matterhorn: '28', iso: '7.18.3', fix: 'tabs' },
  { id: 'font-embedded', group: 'fonts', matterhorn: '31', iso: '7.21.4.1' },
  { id: 'font-unicode', group: 'fonts', matterhorn: '31', iso: '7.21.7' },
  { id: 'char-mapping', group: 'fonts', matterhorn: '10', iso: '7.2' },
  { id: 'lang-parts', group: 'document', matterhorn: '11', iso: '7.2', manual: true },
  { id: 'bookmarks', group: 'navigation', matterhorn: '27', iso: '7.17' },
] as const satisfies readonly UaRuleMeta[];

export type UaRuleId = (typeof UA_RULES)[number]['id'];

/** Documents with more pages than this are expected to carry bookmarks (Acrobat's own limit). */
export const BOOKMARK_PAGE_THRESHOLD = 20;

/** The `MessageKey` seam of this module: every key is declared in `parts/uatags.ts` / `en-parts/uatags.ts`. */
function dictKey(value: string): MessageKey {
  return value as MessageKey;
}

export const ruleKey = {
  name: (id: string): MessageKey => dictKey(`ua.rule.${id}.name`),
  why: (id: string): MessageKey => dictKey(`ua.rule.${id}.why`),
  fix: (id: string): MessageKey => dictKey(`ua.rule.${id}.fix`),
  /** The sentence for one failing instance; `reason` picks a variant of the rule's detail. */
  detail: (id: string, reason?: string): MessageKey =>
    dictKey(reason === undefined ? `ua.rule.${id}.detail` : `ua.rule.${id}.detail.${reason}`),
  group: (group: UaGroup): MessageKey => dictKey(`ua.group.${group}`),
};

/** One place a rule fails (or, for a manual rule, one place to look). */
export interface UaInstance {
  readonly pageIndex?: number;
  /** The structure element, to open in the tags panel. */
  readonly nodeKey?: string;
  /** PDF notation (`annotation 12 0 R`, `font F1`): identifiers, never prose. */
  readonly where?: string;
  /** Picks the variant of the rule's detail sentence. */
  readonly reason?: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** The annotation an inline fix writes to. */
  readonly objectNumber?: number;
  /** A form field's fully qualified name, for the tooltip fix. */
  readonly fieldName?: string;
}

export interface UaRule {
  readonly id: UaRuleId;
  readonly group: UaGroup;
  readonly matterhorn: string;
  readonly iso: string;
  readonly state: UaState;
  /** Failing instances found; `instances` lists the first of them. */
  readonly count: number;
  readonly instances: readonly UaInstance[];
  /** Values the rule's own sentences quote (`{lang}`, `{part}`). */
  readonly params?: Readonly<Record<string, string | number>>;
  readonly fix?: UaFixKind;
  readonly manual: boolean;
}

export interface PdfUaSummary {
  readonly pass: number;
  readonly fail: number;
  readonly manual: number;
  readonly na: number;
  readonly unchecked: number;
}

export interface PdfUaReport {
  readonly pageCount: number;
  readonly rules: readonly UaRule[];
  readonly summary: PdfUaSummary;
  /**
   * Every automated rule (all but `pdfua-id` itself) passed: the only state in which the
   * identifier may be written. Manual rules never enter it.
   */
  readonly automatedPass: boolean;
  /** The file already declares `pdfuaid:part`. */
  readonly declaredPart: number | null;
  readonly tagged: boolean;
  readonly title: string | null;
  readonly lang: string | null;
}

/* ------------------------------------------------------------------ *
 * Pure structure rules
 * ------------------------------------------------------------------ */

function instanceAt(node: StructNode, extra: Omit<UaInstance, 'nodeKey' | 'pageIndex'> = {}): UaInstance {
  const page = node.pageIndex ?? nodePages(node)[0];
  return { nodeKey: node.key, ...(page === undefined ? {} : { pageIndex: page }), ...extra };
}

/** Every element with the standard type it resolves to, parents first. */
function allNodes(
  model: StructureModel,
): readonly { readonly node: StructNode; readonly parent: StructNode | null }[] {
  const list: { node: StructNode; parent: StructNode | null }[] = [];
  walkNodes(model, (node, parent) => list.push({ node, parent }));
  return list;
}

/** Figures and formulas without alternative text (13: graphics). */
export function figureFindings(model: StructureModel): {
  readonly figures: number;
  readonly withAlt: number;
  readonly instances: readonly UaInstance[];
} {
  let figures = 0;
  let withAlt = 0;
  const instances: UaInstance[] = [];
  for (const { node } of allNodes(model)) {
    if (node.standard !== 'Figure' && node.standard !== 'Formula') continue;
    figures += 1;
    if (node.alt !== null || node.actualText !== null) withAlt += 1;
    else instances.push(instanceAt(node, { params: { role: node.role } }));
  }
  return { figures, withAlt, instances };
}

/** Heading levels: no `H` mixed with `H1…H6`, the first heading `H1`, no level skipped (14). */
export function headingFindings(model: StructureModel): {
  readonly headings: number;
  readonly instances: readonly UaInstance[];
} {
  const headings: { node: StructNode; level: number }[] = [];
  for (const { node } of allNodes(model)) {
    if (node.standard === 'H') headings.push({ node, level: 0 });
    else if (node.standard !== null && /^H[1-6]$/.test(node.standard)) {
      headings.push({ node, level: Number(node.standard.slice(1)) });
    }
  }
  const instances: UaInstance[] = [];
  const numbered = headings.filter((heading) => heading.level > 0);
  const plain = headings.filter((heading) => heading.level === 0);
  if (numbered.length > 0 && plain.length > 0) {
    instances.push(instanceAt((plain[0] as { node: StructNode }).node, { reason: 'mixed' }));
  }
  let previous = 0;
  for (const heading of numbered) {
    if (previous === 0 && heading.level !== 1) {
      instances.push(instanceAt(heading.node, { reason: 'first', params: { level: heading.level } }));
    } else if (previous > 0 && heading.level > previous + 1) {
      instances.push(
        instanceAt(heading.node, { reason: 'skip', params: { from: previous, to: heading.level } }),
      );
    }
    previous = heading.level;
  }
  return { headings: headings.length, instances };
}

const TABLE_PARTS = new Set(['THead', 'TBody', 'TFoot']);

interface Cell {
  readonly node: StructNode;
  readonly header: boolean;
}

function rowsOf(table: StructNode): readonly (readonly Cell[])[] {
  const rows: Cell[][] = [];
  const addRow = (row: StructNode): void => {
    const cells: Cell[] = [];
    for (const kid of elementKids(row)) {
      if (kid.standard === 'TH' || kid.standard === 'TD')
        cells.push({ node: kid, header: kid.standard === 'TH' });
    }
    rows.push(cells);
  };
  for (const kid of elementKids(table)) {
    if (kid.standard === 'TR') addRow(kid);
    else if (kid.standard !== null && TABLE_PARTS.has(kid.standard)) {
      for (const row of elementKids(kid)) if (row.standard === 'TR') addRow(row);
    }
  }
  return rows;
}

/** Whether a table's cells form a rectangle once row and column spans are laid out. */
export function isRegularTable(rows: readonly (readonly Cell[])[]): boolean {
  const taken = new Set<string>();
  const at = (row: number, column: number): string => `${String(row)}:${String(column)}`;
  for (const [rowIndex, row] of rows.entries()) {
    let column = 0;
    for (const cell of row) {
      while (taken.has(at(rowIndex, column))) column += 1;
      const columns = Math.max(1, cell.node.colSpan);
      const height = Math.max(1, cell.node.rowSpan);
      for (let down = 0; down < height; down += 1) {
        for (let across = 0; across < columns; across += 1) taken.add(at(rowIndex + down, column + across));
      }
      column += columns;
    }
  }
  const widths = rows.map((_row, rowIndex) => {
    let width = 0;
    for (let column = 0; column < 256; column += 1) {
      if (taken.has(at(rowIndex, column))) width = column + 1;
    }
    return width;
  });
  const full = widths[0] ?? 0;
  return rows.every((_row, rowIndex) => {
    if (widths[rowIndex] !== full) return false;
    for (let column = 0; column < full; column += 1) {
      if (!taken.has(at(rowIndex, column))) return false;
    }
    return true;
  });
}

/** Tables: structure, header cells, scope or `/Headers`, and regularity (15). */
export function tableFindings(model: StructureModel): {
  readonly tables: number;
  readonly structure: readonly UaInstance[];
  readonly headers: readonly UaInstance[];
  readonly scope: readonly UaInstance[];
  readonly regular: readonly UaInstance[];
} {
  let tables = 0;
  const structure: UaInstance[] = [];
  const headers: UaInstance[] = [];
  const scope: UaInstance[] = [];
  const regular: UaInstance[] = [];
  for (const { node, parent } of allNodes(model)) {
    const std = node.standard;
    if (std === 'TH' || std === 'TD') {
      if (parent?.standard !== 'TR') {
        structure.push(instanceAt(node, { reason: 'cell-outside-row', params: { role: node.role } }));
      }
      continue;
    }
    if (std === 'TR') {
      const allowed =
        parent?.standard === 'Table' ||
        (parent?.standard !== undefined && parent.standard !== null && TABLE_PARTS.has(parent.standard));
      if (!allowed) structure.push(instanceAt(node, { reason: 'row-outside-table' }));
      for (const kid of elementKids(node)) {
        if (kid.standard !== 'TH' && kid.standard !== 'TD') {
          structure.push(instanceAt(kid, { reason: 'row-child', params: { role: kid.role } }));
        }
      }
      continue;
    }
    if (std !== null && TABLE_PARTS.has(std)) {
      for (const kid of elementKids(node)) {
        if (kid.standard !== 'TR')
          structure.push(instanceAt(kid, { reason: 'part-child', params: { role: kid.role } }));
      }
      continue;
    }
    if (std !== 'Table') continue;
    tables += 1;
    for (const kid of elementKids(node)) {
      const kidStd = kid.standard;
      if (kidStd === 'TR' || kidStd === 'Caption' || (kidStd !== null && TABLE_PARTS.has(kidStd))) continue;
      structure.push(instanceAt(kid, { reason: 'table-child', params: { role: kid.role } }));
    }
    const rows = rowsOf(node);
    const cells = rows.flat();
    if (!cells.some((cell) => cell.header)) headers.push(instanceAt(node));
    const referenced = new Set<string>();
    for (const cell of cells) for (const id of cell.node.headers) referenced.add(id);
    const unlinked = cells.filter(
      (cell) =>
        cell.header &&
        cell.node.scope === null &&
        !(cell.node.elementId !== null && referenced.has(cell.node.elementId)),
    );
    if (unlinked.length > 0) scope.push(instanceAt(node, { params: { count: unlinked.length } }));
    if (rows.length > 0 && !isRegularTable(rows)) {
      const lacking = cells.filter((cell) => !cell.header && cell.node.headers.length === 0);
      if (lacking.length > 0) regular.push(instanceAt(node, { params: { count: lacking.length } }));
    }
  }
  return { tables, structure, headers, scope, regular };
}

/** Lists: `L` holds `LI`, `LI` holds `Lbl` and `LBody` (16). */
export function listFindings(model: StructureModel): {
  readonly lists: number;
  readonly instances: readonly UaInstance[];
} {
  let lists = 0;
  const instances: UaInstance[] = [];
  for (const { node, parent } of allNodes(model)) {
    const std = node.standard;
    if (std === 'L') {
      lists += 1;
      for (const kid of elementKids(node)) {
        if (kid.standard !== 'LI')
          instances.push(instanceAt(kid, { reason: 'list-child', params: { role: kid.role } }));
      }
    } else if (std === 'LI') {
      if (parent?.standard !== 'L') instances.push(instanceAt(node, { reason: 'item-outside-list' }));
      const kids = elementKids(node);
      for (const kid of kids) {
        if (kid.standard !== 'Lbl' && kid.standard !== 'LBody') {
          instances.push(instanceAt(kid, { reason: 'item-child', params: { role: kid.role } }));
        }
      }
      if (!kids.some((kid) => kid.standard === 'LBody'))
        instances.push(instanceAt(node, { reason: 'no-body' }));
    } else if ((std === 'Lbl' || std === 'LBody') && parent?.standard !== 'LI') {
      instances.push(instanceAt(node, { reason: 'part-outside-item', params: { role: node.role } }));
    }
  }
  return { lists, instances };
}

/** Role map: custom types mapped to a standard one, no loops, no standard type remapped (02). */
export function roleMapFindings(model: StructureModel): readonly UaInstance[] {
  const instances: UaInstance[] = [];
  for (const [from, to] of Object.entries(model.roleMap)) {
    if (STANDARD_ROLES.has(from)) {
      instances.push({ reason: 'remapped', params: { role: from, to } });
    } else if (resolveRole(from, model.roleMap) === null) {
      instances.push({ reason: 'unresolved', params: { role: from, to } });
    }
  }
  const reported = new Set<string>();
  for (const { node } of allNodes(model)) {
    if (node.role === '' || node.standard !== null || reported.has(node.role)) continue;
    if (node.role in model.roleMap) continue;
    reported.add(node.role);
    instances.push(instanceAt(node, { reason: 'unmapped', params: { role: node.role } }));
  }
  return instances;
}

/* ------------------------------------------------------------------ *
 * Fonts
 * ------------------------------------------------------------------ */

interface FontFacts {
  readonly name: string;
  readonly subtype: string;
  readonly embedded: boolean;
  readonly unicode: 'to-unicode' | 'implicit' | 'none';
  /** The ToUnicode map sends a code to U+0000, U+FFFD, U+FFFE or U+FFFF. */
  readonly badMapping: boolean;
  readonly pages: Set<number>;
}

const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3'] as const;
const STANDARD_FONT = /^(Helvetica|Times|Courier|Arial|TimesNewRoman|Symbol|ZapfDingbats)/;
const UNICODE_ORDERINGS = new Set(['Japan1', 'GB1', 'CNS1', 'Korea1']);

function hasFontFile(descriptor: PDFObject | null): boolean {
  if (descriptor === null) return false;
  return FONT_FILE_KEYS.some((key) => resolved(descriptor.get(key)) !== null);
}

function descendantOf(font: PDFObject): PDFObject | null {
  const descendants = resolved(font.get('DescendantFonts'));
  if (descendants?.isArray() !== true) return null;
  return dictOf(descendants.get(0));
}

function toUnicodeIsBad(stream: PDFObject): boolean {
  const bytes = decodeStream(stream);
  if (bytes === null || bytes.length > 3_000_000) return false;
  const source = latin1(bytes);
  const bad = (hex: string, source_: string): boolean => {
    const digits = hex.replace(/\s+/g, '');
    if (digits === '') return false;
    const unit = digits.length <= 2 ? Number.parseInt(digits, 16) : Number.parseInt(digits.slice(0, 4), 16);
    if (unit === 0xfffd || unit === 0xfffe || unit === 0xffff) return true;
    return unit === 0 && Number.parseInt(source_.replace(/\s+/g, '') || '0', 16) !== 0;
  };
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const line of (block[1] as string).split(/\r?\n/)) {
      const hexes = [...line.matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((entry) => entry[1] as string);
      if (hexes.length >= 2 && bad(hexes[1] as string, hexes[0] as string)) return true;
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of (block[1] as string).split(/\r?\n/)) {
      const hexes = [...line.matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((entry) => entry[1] as string);
      if (hexes.length < 3) continue;
      for (const target of hexes.slice(2)) if (bad(target, hexes[0] as string)) return true;
    }
  }
  return false;
}

function describeFont(font: PDFObject, fallbackName: string): Omit<FontFacts, 'pages'> {
  const subtype = nameOf(font.get('Subtype')) ?? '';
  const baseFont = nameOf(font.get('BaseFont')) ?? fallbackName;
  const name = baseFont.replace(/^[A-Z]{6}\+/, '');
  const type3 = subtype === 'Type3';
  const descendant = subtype === 'Type0' ? descendantOf(font) : null;
  const descriptor = dictOf((descendant ?? font).get('FontDescriptor'));
  const embedded =
    type3 ||
    hasFontFile(descriptor) ||
    (descendant !== null && hasFontFile(dictOf(descendant.get('FontDescriptor'))));

  const toUnicode = font.get('ToUnicode');
  if (!toUnicode.isNull() && toUnicode.isStream()) {
    return { name, subtype, embedded, unicode: 'to-unicode', badMapping: toUnicodeIsBad(toUnicode) };
  }

  if (subtype === 'Type0') {
    const encoding = resolved(font.get('Encoding'));
    const encodingName =
      encoding?.isName() === true ? encoding.asName() : (nameOf(dictOf(encoding)?.get('CMapName')) ?? '');
    const system = dictOf(descendant?.get('CIDSystemInfo'));
    const ordering = system === null ? '' : (textOf(system.get('Ordering')) ?? '');
    const implicit = /^Uni/.test(encodingName) || UNICODE_ORDERINGS.has(ordering);
    return { name, subtype, embedded, unicode: implicit ? 'implicit' : 'none', badMapping: false };
  }

  const flags = intOf(descriptor, 'Flags') ?? 0;
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  if (symbolic && !STANDARD_FONT.test(name)) {
    return { name, subtype, embedded, unicode: 'none', badMapping: false };
  }
  const encoding = resolved(font.get('Encoding'));
  const named = encoding?.isName() === true ? encoding.asName() : null;
  if (named !== null) {
    const known = ['WinAnsiEncoding', 'MacRomanEncoding', 'MacExpertEncoding', 'StandardEncoding'].includes(
      named,
    );
    return { name, subtype, embedded, unicode: known ? 'implicit' : 'none', badMapping: false };
  }
  if (encoding?.isDictionary() === true) {
    const base = nameOf(encoding.get('BaseEncoding'));
    const differences = resolved(encoding.get('Differences'));
    let plausible =
      base === null || ['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding'].includes(base);
    if (differences?.isArray() === true) {
      for (let index = 0; index < differences.length; index += 1) {
        const entry = resolved(differences.get(index));
        if (entry?.isName() !== true) continue;
        const glyph = entry.asName();
        if (glyph === '.notdef') continue;
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(glyph) || /^(g|glyph|cid|index|char|c)\d+$/i.test(glyph))
          plausible = false;
      }
    }
    return { name, subtype, embedded, unicode: plausible ? 'implicit' : 'none', badMapping: false };
  }
  const standard = STANDARD_FONT.test(name) && !symbolic;
  return { name, subtype, embedded, unicode: standard ? 'implicit' : 'none', badMapping: false };
}

/* ------------------------------------------------------------------ *
 * Per-page facts
 * ------------------------------------------------------------------ */

interface PageFacts {
  readonly pageIndex: number;
  readonly readable: boolean;
  readonly marks: ContentMarks | null;
  readonly unmarked: { text: number; path: number; image: number; other: number };
  /** Marked-content sequences nested the forbidden way (artifact in tagged, tagged in artifact). */
  readonly conflicts: number;
  readonly hasText: boolean;
  readonly largeImage: boolean;
  /** Non-whitespace characters MuPDF extracted, and how many have no Unicode value. */
  chars: number | null;
  replacement: number;
}

interface ScanAccumulator {
  unmarked: { text: number; path: number; image: number; other: number };
  conflicts: number;
  hasText: boolean;
  largeImage: boolean;
  readable: boolean;
  topMarks: ContentMarks | null;
}

function collectFonts(
  marks: ContentMarks,
  resources: PDFObject | null,
  pageIndex: number,
  fonts: Map<string, FontFacts>,
  depth: number,
): void {
  const dict = dictOf(resources?.get('Font'));
  if (dict === null) return;
  for (const name of marks.fonts) {
    const entry = dict.get(name);
    const font = dictOf(entry);
    if (font === null) continue;
    const key = entry.isIndirect()
      ? `o${String(entry.asIndirect())}`
      : `d${String(depth)}:${String(pageIndex)}:${name}`;
    const known = fonts.get(key);
    if (known !== undefined) {
      known.pages.add(pageIndex);
      continue;
    }
    fonts.set(key, { ...describeFont(font, name), pages: new Set([pageIndex]) });
  }
}

function scanStream(
  bytes: Uint8Array,
  resources: PDFObject | null,
  pageIndex: number,
  area: number,
  depth: number,
  visited: Set<number>,
  acc: ScanAccumulator,
  fonts: Map<string, FontFacts>,
  top: boolean,
): void {
  const instructions = readInstructions(bytes);
  if (instructions === null) {
    acc.readable = false;
    return;
  }
  const marks = scanContent(bytes, instructions, resourceHooks(resources));
  if (top) acc.topMarks = marks;
  collectFonts(marks, resources, pageIndex, fonts, depth);
  for (const span of marks.spans) {
    const chain = enclosing(marks, span.id).slice(1);
    if (span.tag === 'Artifact' && (span.mcid !== null || chain.some((entry) => entry.mcid !== null)))
      acc.conflicts += 1;
    else if (span.mcid !== null && chain.some((entry) => entry.tag === 'Artifact')) acc.conflicts += 1;
  }
  for (const paint of marks.paints) {
    const coverage = coverageOf(marks, paint);
    if (paint.kind === 'text') acc.hasText = true;
    if (paint.bbox !== null && (paint.kind === 'image' || paint.kind === 'inline-image')) {
      const [x0, y0, x1, y1] = paint.bbox;
      if (area > 0 && ((x1 - x0) * (y1 - y0)) / area >= 0.8) acc.largeImage = true;
    }
    if (coverage !== 'unmarked') continue;
    if (paint.kind === 'form' && paint.name !== null) {
      const xobjects = dictOf(resources?.get('XObject'));
      const entry = xobjects?.get(paint.name);
      const form = entry === undefined ? null : resolved(entry);
      const number = entry?.isIndirect() === true ? entry.asIndirect() : null;
      if (
        entry !== undefined &&
        form !== null &&
        depth < FORM_DEPTH_LIMIT &&
        (number === null || !visited.has(number))
      ) {
        if (number !== null) visited.add(number);
        const decoded = decodeStream(entry);
        if (decoded !== null) {
          scanStream(
            decoded,
            dictOf(form.get('Resources')) ?? resources,
            pageIndex,
            area,
            depth + 1,
            visited,
            acc,
            fonts,
            false,
          );
          continue;
        }
      }
      acc.unmarked.other += 1;
      continue;
    }
    if (paint.kind === 'text') acc.unmarked.text += 1;
    else if (paint.kind === 'path' || paint.kind === 'shading') acc.unmarked.path += 1;
    else if (paint.kind === 'image' || paint.kind === 'inline-image') acc.unmarked.image += 1;
    else acc.unmarked.other += 1;
  }
}

function analysePage(page: PDFObject, pageIndex: number, fonts: Map<string, FontFacts>): PageFacts {
  const content = pageContent(page);
  const box = visibleBox(page);
  const acc: ScanAccumulator = {
    unmarked: { text: 0, path: 0, image: 0, other: 0 },
    conflicts: 0,
    hasText: false,
    largeImage: false,
    readable: content !== null,
    topMarks: null,
  };
  if (content !== null) {
    scanStream(
      content.bytes,
      dictOf(page.getInheritable('Resources')),
      pageIndex,
      box.width * box.height,
      0,
      new Set(),
      acc,
      fonts,
      true,
    );
  }
  return {
    pageIndex,
    readable: acc.readable,
    marks: acc.topMarks,
    unmarked: acc.unmarked,
    conflicts: acc.conflicts,
    hasText: acc.hasText,
    largeImage: acc.largeImage,
    chars: null,
    replacement: 0,
  };
}

/** Characters MuPDF extracts from a page and how many have no Unicode value (U+FFFD). */
function readCharacters(doc: PDFDocument, pageIndex: number): { chars: number; replacement: number } | null {
  try {
    const page = doc.loadPage(pageIndex);
    try {
      const extracted = page.toStructuredText('preserve-whitespace');
      try {
        let chars = 0;
        let replacement = 0;
        extracted.walk({
          onChar(char) {
            if (char.trim() === '') return;
            chars += 1;
            if (char === '�') replacement += 1;
          },
        });
        return { chars, replacement };
      } finally {
        extracted.destroy();
      }
    } finally {
      page.destroy();
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Annotations
 * ------------------------------------------------------------------ */

interface AnnotFact {
  readonly pageIndex: number;
  readonly objectNumber: number | null;
  readonly subtype: string;
  readonly contents: string | null;
  readonly hidden: boolean;
}

function readAnnotations(pages: readonly PDFObject[], context: OperationContext): readonly AnnotFact[] {
  const facts: AnnotFact[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    throwIfAborted(context.signal);
    const annots = resolved(page.get('Annots'));
    if (annots?.isArray() !== true) continue;
    for (let position = 0; position < annots.length; position += 1) {
      const entry = annots.get(position);
      const dict = dictOf(entry);
      if (dict === null) continue;
      const flags = intOf(dict, 'F') ?? 0;
      facts.push({
        pageIndex,
        objectNumber: entry.isIndirect() ? entry.asIndirect() : null,
        subtype: nameOf(dict.get('Subtype')) ?? '',
        contents: textOf(dict.get('Contents')),
        // Hidden (bit 2) and NoView (bit 6) annotations never reach a reader's screen.
        hidden: (flags & 2) !== 0 || (flags & 32) !== 0,
      });
    }
  }
  return facts;
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

interface RuleResult {
  state: UaState;
  count: number;
  instances: UaInstance[];
  params?: Readonly<Record<string, string | number>>;
}

class Results {
  private readonly map = new Map<string, RuleResult>();

  set(
    id: UaRuleId,
    state: UaState,
    instances: readonly UaInstance[] = [],
    params?: Readonly<Record<string, string | number>>,
  ): void {
    const result: RuleResult = {
      state,
      count: instances.length,
      instances: instances.slice(0, FINDING_ROW_LIMIT),
    };
    if (params !== undefined) result.params = params;
    this.map.set(id, result);
  }

  /** `fail` with `instances`, or `pass` when there are none. */
  verdict(
    id: UaRuleId,
    instances: readonly UaInstance[],
    passParams?: Readonly<Record<string, string | number>>,
  ): void {
    this.set(id, instances.length > 0 ? 'fail' : 'pass', instances, passParams);
  }

  get(id: string): RuleResult | undefined {
    return this.map.get(id);
  }
}

function _pdfPart(entry: PDFObject): string {
  return entry.isIndirect() ? `${String(entry.asIndirect())} 0 R` : '?';
}

/**
 * Check a file against the PDF/UA-1 rules a program can decide. `bytes` are never
 * modified. Progress is reported per page; an abort throws the caller's own `AbortError`.
 */
export async function checkPdfUa(bytes: Uint8Array, context: OperationContext): Promise<PdfUaReport> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  try {
    return inspectUa(doc, context);
  } catch (error) {
    if (isAbort(error) || error instanceof ToolError) throw error;
    throw mapMupdfError(error, 'check PDF/UA');
  } finally {
    doc.destroy();
  }
}

/** The facts the rules need that do not depend on the pages' content. */
function documentFacts(doc: PDFDocument, catalog: PDFObject) {
  const info = dictOf(doc.getTrailer().get('Info'));
  const infoTitle = info === null ? null : textOf(info.get('Title'));
  const packet = readXmpPacket(catalog);
  const markInfo = dictOf(catalog.get('MarkInfo'));
  const markedValue = markInfo === null ? null : resolved(markInfo.get('Marked'));
  const viewer = dictOf(catalog.get('ViewerPreferences'));
  const display = viewer === null ? null : resolved(viewer.get('DisplayDocTitle'));
  return {
    infoTitle,
    packet,
    xmpTitle: packet === null ? null : readXmpTitle(packet),
    uaPart: packet === null ? null : readUaPart(packet),
    marked: markedValue?.isBoolean() === true && markedValue.asBoolean(),
    displayTitle: display?.isBoolean() === true && display.asBoolean(),
    lang: textOf(catalog.get('Lang')),
  };
}

const LANGUAGE_TAG = /^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|[ix]-[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*)$/;

function inspectUa(doc: PDFDocument, context: OperationContext): PdfUaReport {
  const pages = pageObjects(doc);
  const pageCount = pages.length;
  const catalog = catalogOf(doc);
  const results = new Results();
  const total = pageCount * 2 + 4;
  let step = 0;
  const progress = (): void => {
    step += 1;
    context.onProgress?.({ phase: 'ua', labelKey: dictKey('op.progress.ua.check'), done: step, total });
  };
  progress();

  const facts = documentFacts(doc, catalog);
  const model = readStructureModel(doc, pages);
  const hasTree = model.present && model.readable;
  const modelUsable = hasTree && !model.truncated;

  /* ---- document ---- */
  results.verdict('marked', facts.marked ? [] : [{}]);
  if (facts.xmpTitle !== null) results.set('title', 'pass');
  else if (facts.infoTitle !== null) {
    results.set('title', 'fail', [{ reason: facts.packet === null ? 'info-only-no-xmp' : 'info-only' }], {
      title: facts.infoTitle,
    });
  } else results.set('title', 'fail', [{ reason: 'none' }]);
  results.verdict('display-title', facts.displayTitle ? [] : [{}]);
  if (facts.lang === null) results.set('lang', 'fail', [{ reason: 'missing' }]);
  else if (!LANGUAGE_TAG.test(facts.lang))
    results.set('lang', 'fail', [{ reason: 'invalid', params: { lang: facts.lang } }]);
  else results.set('lang', 'pass', [], { lang: facts.lang });
  results.verdict(
    'pdfua-id',
    facts.uaPart === 1
      ? []
      : [{ reason: facts.uaPart === null ? 'none' : 'other', params: { part: facts.uaPart ?? 0 } }],
  );
  const encrypt = dictOf(doc.getTrailer().get('Encrypt'));
  if (encrypt === null) results.set('encryption', 'na');
  else {
    const permissions = intOf(encrypt, 'P');
    results.verdict('encryption', permissions !== null && (permissions & 512) === 0 ? [{}] : []);
  }
  const acro = dictOf(catalog.get('AcroForm'));
  if (acro === null) results.set('xfa', 'na');
  else results.verdict('xfa', acro.get('XFA').isNull() ? [] : [{}]);

  /* ---- structure ---- */
  results.set(
    'struct-tree',
    hasTree ? 'pass' : 'fail',
    hasTree ? [] : [{ reason: model.present ? 'unreadable' : 'none' }],
    {
      elements: model.nodeCount,
    },
  );
  const unchecked = (id: UaRuleId): void => {
    results.set(id, 'unchecked', [{ reason: hasTree ? 'truncated' : 'untagged' }]);
  };
  if (modelUsable) {
    results.verdict('role-map', roleMapFindings(model));
    const headings = headingFindings(model);
    if (headings.headings === 0) results.set('headings', 'na');
    else results.verdict('headings', headings.instances);
    const figures = figureFindings(model);
    if (figures.figures === 0) results.set('figure-alt', 'na');
    else results.verdict('figure-alt', figures.instances, { figures: figures.figures });
    const tables = tableFindings(model);
    if (tables.tables === 0 && tables.structure.length === 0) {
      for (const id of ['table-structure', 'table-headers', 'table-scope', 'table-regular'] as const)
        results.set(id, 'na');
    } else {
      results.verdict('table-structure', tables.structure, { tables: tables.tables });
      results.verdict('table-headers', tables.headers);
      results.verdict('table-scope', tables.scope);
      results.verdict('table-regular', tables.regular);
    }
    const lists = listFindings(model);
    if (lists.lists === 0 && lists.instances.length === 0) results.set('list-structure', 'na');
    else results.verdict('list-structure', lists.instances, { lists: lists.lists });
  } else {
    for (const id of [
      'role-map',
      'headings',
      'figure-alt',
      'table-structure',
      'table-headers',
      'table-scope',
      'table-regular',
      'list-structure',
    ] as const) {
      unchecked(id);
    }
  }
  results.set('reading-order', 'manual', hasTree ? [] : [{ reason: 'untagged' }]);
  results.set('contrast', 'manual');
  results.set('lang-parts', 'manual');
  const figuresPresent = modelUsable && figureFindings(model).withAlt > 0;
  results.set('alt-quality', figuresPresent ? 'manual' : 'na');
  progress();

  /* ---- pages: content, fonts, characters ---- */
  const fonts = new Map<string, FontFacts>();
  const pageFacts: PageFacts[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    throwIfAborted(context.signal);
    const analysed = analysePage(page, pageIndex, fonts);
    const chars = readCharacters(doc, pageIndex);
    if (chars !== null) {
      analysed.chars = chars.chars;
      analysed.replacement = chars.replacement;
    }
    pageFacts.push(analysed);
    progress();
  }

  const unreadable = pageFacts.filter((entry) => !entry.readable);
  const taggedInstances: UaInstance[] = [];
  for (const entry of pageFacts) {
    if (!entry.readable) {
      taggedInstances.push({ pageIndex: entry.pageIndex, reason: 'unreadable' });
      continue;
    }
    const sum = entry.unmarked.text + entry.unmarked.path + entry.unmarked.image + entry.unmarked.other;
    if (sum > 0) {
      taggedInstances.push({
        pageIndex: entry.pageIndex,
        params: {
          count: sum,
          text: entry.unmarked.text,
          paths: entry.unmarked.path,
          images: entry.unmarked.image,
        },
      });
    }
  }
  if (unreadable.length > 0 && taggedInstances.every((entry) => entry.reason === 'unreadable')) {
    results.set('tagged-content', 'unchecked', taggedInstances);
  } else {
    results.verdict('tagged-content', taggedInstances);
  }
  results.verdict(
    'artifact-nesting',
    pageFacts
      .filter((entry) => entry.conflicts > 0)
      .map((entry) => ({ pageIndex: entry.pageIndex, params: { count: entry.conflicts } })),
  );

  /* ---- MCID references between content and tree ---- */
  if (!modelUsable) {
    unchecked('mcid-references');
  } else {
    const inTree = new Map<number, Map<number, number>>();
    walkNodes(model, (node) => {
      for (const kid of node.kids) {
        if (
          kid.kind !== 'content' ||
          kid.item.kind !== 'mcid' ||
          kid.item.inStream ||
          kid.item.pageIndex === null
        )
          continue;
        const perPage = inTree.get(kid.item.pageIndex) ?? new Map<number, number>();
        perPage.set(kid.item.mcid, (perPage.get(kid.item.mcid) ?? 0) + 1);
        inTree.set(kid.item.pageIndex, perPage);
      }
    });
    const instances: UaInstance[] = [];
    if (!model.hasParentTree) instances.push({ reason: 'no-parent-tree' });
    for (const entry of pageFacts) {
      if (entry.marks === null) continue;
      const wanted = inTree.get(entry.pageIndex) ?? new Map<number, number>();
      const onPage = new Set<number>();
      for (const span of entry.marks.spans) if (span.mcid !== null) onPage.add(span.mcid);
      const orphan = [...onPage].filter((mcid) => !wanted.has(mcid)).length;
      const dangling = [...wanted.keys()].filter((mcid) => !onPage.has(mcid)).length;
      const duplicated = [...wanted.values()].filter((count) => count > 1).length;
      if (orphan > 0)
        instances.push({ pageIndex: entry.pageIndex, reason: 'orphan', params: { count: orphan } });
      if (dangling > 0)
        instances.push({ pageIndex: entry.pageIndex, reason: 'dangling', params: { count: dangling } });
      if (duplicated > 0)
        instances.push({ pageIndex: entry.pageIndex, reason: 'duplicate', params: { count: duplicated } });
      const page = pages[entry.pageIndex];
      if (wanted.size > 0 && page !== undefined && intOf(page, 'StructParents') === null) {
        instances.push({ pageIndex: entry.pageIndex, reason: 'no-struct-parents' });
      }
    }
    results.verdict('mcid-references', instances);
  }

  const imageOnly = pageFacts.filter(
    (entry) => entry.readable && entry.largeImage && (entry.chars ?? 0) === 0 && !entry.hasText,
  );
  results.verdict(
    'image-only',
    imageOnly.map((entry) => ({ pageIndex: entry.pageIndex })),
  );

  /* ---- annotations, links, forms ---- */
  const annots = readAnnotations(pages, context);
  const owners = new Map<number, StructNode>();
  if (hasTree) {
    walkNodes(model, (node) => {
      for (const kid of node.kids) {
        if (kid.kind === 'content' && kid.item.kind === 'objr' && kid.item.objectNumber !== null) {
          owners.set(kid.item.objectNumber, node);
        }
      }
    });
  }
  const refOf = (fact: AnnotFact): string =>
    fact.objectNumber === null ? 'annotation' : `annotation ${String(fact.objectNumber)} 0 R`;
  const links = annots.filter((fact) => fact.subtype === 'Link' && !fact.hidden);
  if (links.length === 0 && !(modelUsable && allNodes(model).some(({ node }) => node.standard === 'Link'))) {
    results.set('link-tagged', 'na');
    results.set('link-alt', 'na');
  } else if (!modelUsable) {
    unchecked('link-tagged');
    results.verdict(
      'link-alt',
      links
        .filter((fact) => fact.contents === null)
        .map((fact) => ({
          pageIndex: fact.pageIndex,
          where: refOf(fact),
          ...(fact.objectNumber === null ? {} : { objectNumber: fact.objectNumber }),
        })),
    );
  } else {
    const tagged: UaInstance[] = [];
    const alt: UaInstance[] = [];
    for (const fact of links) {
      const owner = fact.objectNumber === null ? undefined : owners.get(fact.objectNumber);
      if (owner === undefined || owner.standard !== 'Link') {
        tagged.push({
          pageIndex: fact.pageIndex,
          where: refOf(fact),
          reason: owner === undefined ? 'untagged' : 'wrong-element',
          ...(owner === undefined ? {} : { nodeKey: owner.key, params: { role: owner.role } }),
        });
      }
      if (fact.contents === null && (owner?.alt ?? null) === null) {
        alt.push({
          pageIndex: fact.pageIndex,
          where: refOf(fact),
          ...(fact.objectNumber === null ? {} : { objectNumber: fact.objectNumber }),
        });
      }
    }
    for (const { node } of allNodes(model)) {
      if (node.standard !== 'Link') continue;
      const hasAnnotation = node.kids.some((kid) => kid.kind === 'content' && kid.item.kind === 'objr');
      if (!hasAnnotation) tagged.push(instanceAt(node, { reason: 'no-annotation' }));
    }
    results.verdict('link-tagged', tagged, { links: links.length });
    results.verdict('link-alt', alt, { links: links.length });
  }

  const others = annots.filter(
    (fact) => !fact.hidden && !['Link', 'Widget', 'Popup', 'PrinterMark', 'TrapNet'].includes(fact.subtype),
  );
  if (others.length === 0) results.set('annot-tagged', 'na');
  else if (!modelUsable) unchecked('annot-tagged');
  else {
    const instances: UaInstance[] = [];
    for (const fact of others) {
      const owner = fact.objectNumber === null ? undefined : owners.get(fact.objectNumber);
      if (owner === undefined) {
        instances.push({
          pageIndex: fact.pageIndex,
          where: refOf(fact),
          reason: 'untagged',
          params: { subtype: fact.subtype },
        });
      } else if (owner.standard !== 'Annot') {
        instances.push({
          pageIndex: fact.pageIndex,
          nodeKey: owner.key,
          where: refOf(fact),
          reason: 'wrong-element',
          params: { role: owner.role },
        });
      } else if (fact.contents === null && owner.alt === null) {
        instances.push({
          pageIndex: fact.pageIndex,
          nodeKey: owner.key,
          where: refOf(fact),
          reason: 'no-contents',
          params: { subtype: fact.subtype },
        });
      }
    }
    results.verdict('annot-tagged', instances, { annotations: others.length });
  }

  const widgets = annots.filter((fact) => fact.subtype === 'Widget' && !fact.hidden);
  if (widgets.length === 0) results.set('form-tagged', 'na');
  else if (!modelUsable) unchecked('form-tagged');
  else {
    const instances: UaInstance[] = [];
    for (const fact of widgets) {
      const owner = fact.objectNumber === null ? undefined : owners.get(fact.objectNumber);
      if (owner === undefined)
        instances.push({ pageIndex: fact.pageIndex, where: refOf(fact), reason: 'untagged' });
      else if (owner.standard !== 'Form') {
        instances.push({
          pageIndex: fact.pageIndex,
          nodeKey: owner.key,
          where: refOf(fact),
          reason: 'wrong-element',
          params: { role: owner.role },
        });
      }
    }
    results.verdict('form-tagged', instances, { widgets: widgets.length });
  }

  const fields = readFields(catalog, pageNumbers(pages), context);
  if (fields.items.length === 0) results.set('form-tooltip', 'na');
  else {
    results.verdict(
      'form-tooltip',
      fields.items
        .filter((field) => field.tooltip === null)
        .map((field) => ({
          ...(field.pageIndex === null ? {} : { pageIndex: field.pageIndex }),
          where: `field ${field.name}`,
          fieldName: field.name,
        })),
      { fields: fields.items.length },
    );
    if (fields.truncated) {
      results.set('form-tooltip', 'unchecked', [
        { reason: 'truncated', params: { limit: FIELD_WALK_LIMIT } },
      ]);
    }
  }

  const pagesWithAnnots = new Set(
    annots.filter((fact) => fact.subtype !== 'Popup').map((fact) => fact.pageIndex),
  );
  if (pagesWithAnnots.size === 0) results.set('tab-order', 'na');
  else {
    results.verdict(
      'tab-order',
      [...pagesWithAnnots]
        .sort((left, right) => left - right)
        .filter((pageIndex) => nameOf(pages[pageIndex]?.get('Tabs')) !== 'S')
        .map((pageIndex) => ({ pageIndex })),
    );
  }
  progress();

  /* ---- fonts ---- */
  const used = [...fonts.values()];
  if (used.length === 0) {
    results.set('font-embedded', 'na');
    results.set('font-unicode', 'na');
  } else {
    results.verdict(
      'font-embedded',
      used
        .filter((font) => !font.embedded)
        .map((font) => ({
          pageIndex: Math.min(...font.pages),
          where: `font ${font.name}`,
          params: { font: font.name, pages: font.pages.size },
        })),
      { fonts: used.length },
    );
    results.verdict(
      'font-unicode',
      used
        .filter((font) => font.unicode === 'none' || font.badMapping)
        .map((font) => ({
          pageIndex: Math.min(...font.pages),
          where: `font ${font.name}`,
          reason: font.badMapping ? 'bad-map' : 'no-map',
          params: { font: font.name, pages: font.pages.size },
        })),
      { fonts: used.length },
    );
  }
  const unmapped = pageFacts.filter((entry) => entry.replacement > 0);
  const measured = pageFacts.filter((entry) => entry.chars !== null);
  if (measured.length === 0 && pageCount > 0)
    results.set('char-mapping', 'unchecked', [{ reason: 'unreadable' }]);
  else if (measured.every((entry) => (entry.chars ?? 0) === 0)) results.set('char-mapping', 'na');
  else {
    results.verdict(
      'char-mapping',
      unmapped.map((entry) => ({ pageIndex: entry.pageIndex, params: { count: entry.replacement } })),
    );
  }

  /* ---- navigation ---- */
  const outlines = dictOf(catalog.get('Outlines'));
  const hasOutline = outlines !== null && !outlines.get('First').isNull();
  if (pageCount <= BOOKMARK_PAGE_THRESHOLD) results.set('bookmarks', hasOutline ? 'pass' : 'na');
  else
    results.verdict('bookmarks', hasOutline ? [] : [{ params: { pages: pageCount } }], { pages: pageCount });
  progress();

  /* ---- assemble ---- */
  const rules: UaRule[] = UA_RULES.map((meta) => {
    const result = results.get(meta.id) ?? { state: 'unchecked' as const, count: 0, instances: [] };
    const base = {
      id: meta.id,
      group: meta.group,
      matterhorn: meta.matterhorn,
      iso: meta.iso,
      state: result.state,
      count: result.count,
      instances: result.instances,
      manual: 'manual' in meta ? meta.manual === true : false,
    };
    return {
      ...base,
      ...(result.params === undefined ? {} : { params: result.params }),
      ...('fix' in meta ? { fix: meta.fix } : {}),
    };
  });
  const summary: PdfUaSummary = {
    pass: rules.filter((rule) => rule.state === 'pass').length,
    fail: rules.filter((rule) => rule.state === 'fail').length,
    manual: rules.filter((rule) => rule.state === 'manual').length,
    na: rules.filter((rule) => rule.state === 'na').length,
    unchecked: rules.filter((rule) => rule.state === 'unchecked').length,
  };
  const automated = rules.filter((rule) => !rule.manual && rule.id !== 'pdfua-id');
  return {
    pageCount,
    rules,
    summary,
    automatedPass: automated.every((rule) => rule.state === 'pass' || rule.state === 'na'),
    declaredPart: facts.uaPart,
    tagged: hasTree,
    title: facts.xmpTitle ?? facts.infoTitle,
    lang: facts.lang,
  };
}

/* ------------------------------------------------------------------ *
 * Fixes
 * ------------------------------------------------------------------ */

export type UaFix =
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'display-title' }
  | { readonly kind: 'lang'; readonly lang: string }
  | { readonly kind: 'tabs' }
  | { readonly kind: 'marked' }
  | { readonly kind: 'artifact-paths' }
  | { readonly kind: 'link-contents'; readonly objectNumber: number; readonly text: string }
  | { readonly kind: 'field-tooltip'; readonly name: string; readonly text: string }
  | { readonly kind: 'tag-annots' }
  | { readonly kind: 'mark-pdfua' };

export const UA_FIX_KEYS = {
  progressFix: dictKey('op.progress.ua.fix'),
  titleSet: dictKey('op.note.ua.titleSet'),
  xmpCreated: dictKey('op.note.ua.xmpCreated'),
  displayTitleSet: dictKey('op.note.ua.displayTitleSet'),
  langSet: dictKey('op.note.ua.langSet'),
  tabsSet: dictKey('op.note.ua.tabsSet'),
  markedSet: dictKey('op.note.ua.markedSet'),
  markedNoTree: dictKey('op.note.ua.markedNoTree'),
  pathsMarked: dictKey('op.note.ua.pathsMarked'),
  pathsNone: dictKey('op.note.ua.pathsNone'),
  contentsSet: dictKey('op.note.ua.contentsSet'),
  tooltipSet: dictKey('op.note.ua.tooltipSet'),
  annotsTagged: dictKey('op.note.ua.annotsTagged'),
  annotsNone: dictKey('op.note.ua.annotsNone'),
  annotsNoTree: dictKey('op.note.ua.annotsNoTree'),
  annotsTreeShape: dictKey('op.note.ua.annotsTreeShape'),
  targetMissing: dictKey('op.note.ua.targetMissing'),
  uaMarked: dictKey('op.note.ua.uaMarked'),
  uaKept: dictKey('op.note.ua.uaKept'),
  markRefused: dictKey('op.note.ua.markRefused'),
  manualRemain: dictKey('op.note.ua.manualRemain'),
} as const;

const PATH_UNIT_OPERATORS = new Set<string>([...PATH_CONSTRUCTION, 'W', 'W*']);
const PATH_PAINT_OPERATORS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

function wrongValue(path: string, message: string): ToolError {
  return new ToolError('value-out-of-range', { engine: 'model', path, engineMessage: message });
}

function setInfoTitle(doc: PDFDocument, title: string): void {
  const trailer = doc.getTrailer();
  let info = dictOf(trailer.get('Info'));
  if (info === null) {
    const created = doc.addObject(doc.newDictionary());
    trailer.put('Info', created);
    info = resolved(created) ?? created;
  }
  info.put('Title', text(doc, title));
}

/**
 * Write the XMP packet: the title and/or the identifier. A file with a packet gets a narrow
 * edit of its first description; a file without one gets a fresh packet.
 */
function writeXmp(
  doc: PDFDocument,
  catalog: PDFObject,
  properties: { readonly title?: string; readonly uaPart?: number },
): 'edited' | 'created' | 'unchanged' {
  const existing = readXmpPacket(catalog);
  let packet: string | null = null;
  let kind: 'edited' | 'created' = 'edited';
  if (existing !== null) packet = editUaPacket(existing, properties);
  if (packet === null) {
    kind = 'created';
    packet = buildUaPacket(properties);
  }
  if (packet === existing) return 'unchanged';
  const stream = doc.addRawStream(new TextEncoder().encode(packet), { Type: 'Metadata', Subtype: 'XML' });
  catalog.put('Metadata', stream);
  return kind;
}

/** Wrap every unmarked, self-contained path-painting unit of a page in `/Artifact BMC … EMC`. */
function artifactPathsOnPage(doc: PDFDocument, page: PDFObject): number {
  const content = pageContent(page);
  const instructions = content === null ? null : readInstructions(content.bytes);
  if (content === null || instructions === null) return 0;
  const marks = scanContent(content.bytes, instructions, contentHooks(page));
  const claims: Claim[] = [];
  let cursor = -1;
  for (const paint of marks.paints) {
    if (paint.kind !== 'path' || coverageOf(marks, paint) !== 'unmarked') continue;
    if (!PATH_PAINT_OPERATORS.has((instructions[paint.index] as { operator: string }).operator)) continue;
    let first = paint.index;
    while (
      first - 1 > cursor &&
      PATH_UNIT_OPERATORS.has((instructions[first - 1] as { operator: string }).operator)
    )
      first -= 1;
    claims.push({ first, last: paint.index, role: 'Artifact', blockId: '', alt: null, mcid: -1 });
    cursor = paint.index;
  }
  if (claims.length === 0) return 0;
  const spliced = spliceMarkedContent({ bytes: content.bytes, instructions, shows: [], draws: [] }, claims);
  resolved(page)?.put('Contents', doc.addStream(spliced.bytes, {}));
  return claims.length;
}

/** The element type an annotation belongs in, `null` for the kinds that need none. */
function annotationRole(subtype: string): 'Link' | 'Form' | 'Annot' | null {
  if (subtype === 'Popup' || subtype === 'PrinterMark' || subtype === 'TrapNet' || subtype === '')
    return null;
  if (subtype === 'Link') return 'Link';
  if (subtype === 'Widget') return 'Form';
  return 'Annot';
}

/**
 * Put every visible annotation that no structure element owns into the tree: a `Link`,
 * `Form` or `Annot` element holding an `OBJR` to the annotation, a `/StructParent` on the
 * annotation, and the matching `ParentTree` entry (§14.7.4.4). The elements are appended to
 * the document element — the position of an annotation in the reading order is the user's
 * call, and the tags view moves them. A tree whose `ParentTree` is not a flat `Nums` array
 * is left alone and said so, rather than patched blind.
 */
function tagAnnotations(
  doc: PDFDocument,
  catalog: PDFObject,
  pages: readonly PDFObject[],
): {
  readonly tagged: readonly { readonly objectNumber: number; readonly role: string }[];
  readonly problem: 'no-tree' | 'tree-shape' | null;
} {
  const root = dictOf(catalog.get('StructTreeRoot'));
  if (root === null) return { tagged: [], problem: 'no-tree' };
  const model = readStructureModel(doc, pages);
  if (!model.readable) return { tagged: [], problem: 'tree-shape' };
  const owned = new Set<number>();
  walkNodes(model, (node) => {
    for (const kid of node.kids) {
      if (kid.kind === 'content' && kid.item.kind === 'objr' && kid.item.objectNumber !== null) {
        owned.add(kid.item.objectNumber);
      }
    }
  });
  let parentTree = dictOf(root.get('ParentTree'));
  if (parentTree === null) {
    root.put('ParentTree', doc.addObject({ Nums: [] }));
    parentTree = dictOf(root.get('ParentTree'));
  }
  const nums = parentTree === null ? null : resolved(parentTree.get('Nums'));
  if (nums?.isArray() !== true || !parentTree?.get('Kids').isNull()) {
    return { tagged: [], problem: 'tree-shape' };
  }
  let nextKey = intOf(root, 'ParentTreeNextKey') ?? 0;
  for (let at = 0; at < nums.length; at += 2) {
    const key = nums.get(at);
    if (key.isNumber()) nextKey = Math.max(nextKey, key.asNumber() + 1);
  }
  for (const page of pages) nextKey = Math.max(nextKey, (intOf(page, 'StructParents') ?? -1) + 1);

  const rootK = resolved(root.get('K'));
  const documentValue = rootK?.isArray() === true ? rootK.get(0) : (rootK ?? null);
  const holder = dictOf(documentValue ?? null);
  if (holder === null) return { tagged: [], problem: 'tree-shape' };
  let holderKids = resolved(holder.get('K'));
  if (holderKids?.isArray() !== true) {
    const kids = doc.newArray();
    if (holderKids !== null && !holderKids.isNull()) kids.push(holder.get('K'));
    holder.put('K', kids);
    holderKids = resolved(holder.get('K'));
  }
  if (holderKids?.isArray() !== true) return { tagged: [], problem: 'tree-shape' };

  const tagged: { objectNumber: number; role: string }[] = [];
  for (const page of pages) {
    const annots = resolved(page.get('Annots'));
    if (annots?.isArray() !== true) continue;
    for (let position = 0; position < annots.length; position += 1) {
      const entry = annots.get(position);
      const dict = dictOf(entry);
      if (dict === null || !entry.isIndirect() || owned.has(entry.asIndirect())) continue;
      const flags = intOf(dict, 'F') ?? 0;
      if ((flags & 2) !== 0 || (flags & 32) !== 0) continue;
      const role = annotationRole(nameOf(dict.get('Subtype')) ?? '');
      if (role === null) continue;
      const element = doc.addObject({
        Type: 'StructElem',
        S: role,
        P: documentValue,
        Pg: page,
        K: [{ Type: 'OBJR', Pg: page, Obj: entry }],
      });
      holderKids.push(element);
      dict.put('StructParent', nextKey);
      nums.push(nextKey);
      nums.push(element);
      nextKey += 1;
      tagged.push({ objectNumber: entry.asIndirect(), role });
    }
  }
  root.put('ParentTreeNextKey', nextKey);
  return { tagged, problem: null };
}

interface FixState {
  readonly notes: OperationNote[];
  readonly steps: string[];
  /** Annotations given a structure element, for the read-back. */
  readonly annotTags: { readonly objectNumber: number; readonly role: string }[];
  /** Pages whose `/Contents` were rewritten, for the read-back. */
  readonly rewrittenPages: Set<number>;
  readonly tabPages: number[];
  title: string | null;
  lang: string | null;
  displayTitle: boolean;
  marked: boolean;
  readonly linkContents: { readonly objectNumber: number; readonly text: string }[];
  readonly tooltips: { readonly name: string; readonly text: string }[];
}

function applyFixes(doc: PDFDocument, fixes: readonly UaFix[], context: OperationContext): FixState {
  const catalog = catalogOf(doc);
  const pages = pageObjects(doc);
  const state: FixState = {
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
  };
  for (const fix of fixes) {
    throwIfAborted(context.signal);
    switch (fix.kind) {
      case 'title': {
        const title = fix.title.trim();
        if (title === '') throw wrongValue('fix.title', 'a document title cannot be empty');
        setInfoTitle(doc, title);
        const how = writeXmp(doc, catalog, { title });
        state.title = title;
        state.notes.push(note('changed', UA_FIX_KEYS.titleSet, { title }));
        if (how === 'created') state.notes.push(note('changed', UA_FIX_KEYS.xmpCreated));
        break;
      }
      case 'display-title': {
        let viewer = dictOf(catalog.get('ViewerPreferences'));
        if (viewer === null) {
          catalog.put('ViewerPreferences', doc.newDictionary());
          viewer = catalog.get('ViewerPreferences');
        }
        viewer.put('DisplayDocTitle', doc.newBoolean(true));
        state.displayTitle = true;
        state.notes.push(note('changed', UA_FIX_KEYS.displayTitleSet));
        break;
      }
      case 'lang': {
        const lang = fix.lang.trim();
        if (!LANGUAGE_TAG.test(lang)) throw wrongValue('fix.lang', `${lang} is not a language tag`);
        catalog.put('Lang', text(doc, lang));
        state.lang = lang;
        state.notes.push(note('changed', UA_FIX_KEYS.langSet, { lang }));
        break;
      }
      case 'tabs': {
        for (const [pageIndex, page] of pages.entries()) {
          const annots = resolved(page.get('Annots'));
          if (annots?.isArray() !== true || annots.length === 0) continue;
          if (nameOf(page.get('Tabs')) === 'S') continue;
          page.put('Tabs', doc.newName('S'));
          state.tabPages.push(pageIndex);
        }
        state.notes.push(note('changed', UA_FIX_KEYS.tabsSet, { count: state.tabPages.length }));
        break;
      }
      case 'marked': {
        if (dictOf(catalog.get('StructTreeRoot')) === null) {
          state.notes.push(note('warning', UA_FIX_KEYS.markedNoTree));
          break;
        }
        let markInfo = dictOf(catalog.get('MarkInfo'));
        if (markInfo === null) {
          catalog.put('MarkInfo', doc.newDictionary());
          markInfo = catalog.get('MarkInfo');
        }
        markInfo.put('Marked', doc.newBoolean(true));
        state.marked = true;
        state.notes.push(note('changed', UA_FIX_KEYS.markedSet));
        break;
      }
      case 'artifact-paths': {
        let wrapped = 0;
        for (const [pageIndex, page] of pages.entries()) {
          const count = artifactPathsOnPage(doc, page);
          if (count > 0) {
            wrapped += count;
            state.rewrittenPages.add(pageIndex);
          }
        }
        state.notes.push(
          wrapped > 0
            ? note('changed', UA_FIX_KEYS.pathsMarked, { count: wrapped, pages: state.rewrittenPages.size })
            : note('warning', UA_FIX_KEYS.pathsNone),
        );
        break;
      }
      case 'link-contents': {
        const value = fix.text.trim();
        if (value === '') throw wrongValue('fix.text', 'an empty description is worse than none');
        const annot = resolved(doc.newIndirect(fix.objectNumber));
        if (annot === null || nameOf(annot.get('Subtype')) !== 'Link') {
          state.notes.push(note('warning', UA_FIX_KEYS.targetMissing, { count: 1 }));
          break;
        }
        annot.put('Contents', text(doc, value));
        state.linkContents.push({ objectNumber: fix.objectNumber, text: value });
        state.notes.push(note('changed', UA_FIX_KEYS.contentsSet, { text: value }));
        break;
      }
      case 'field-tooltip': {
        const value = fix.text.trim();
        if (value === '') throw wrongValue('fix.text', 'an empty tooltip is worse than none');
        const field = findField(catalog, fix.name);
        if (field === null) {
          state.notes.push(note('warning', UA_FIX_KEYS.targetMissing, { count: 1 }));
          break;
        }
        field.put('TU', text(doc, value));
        state.tooltips.push({ name: fix.name, text: value });
        state.notes.push(note('changed', UA_FIX_KEYS.tooltipSet, { name: fix.name, tooltip: value }));
        break;
      }
      case 'tag-annots': {
        const result = tagAnnotations(doc, catalog, pages);
        if (result.problem === 'no-tree') state.notes.push(note('warning', UA_FIX_KEYS.annotsNoTree));
        else if (result.problem === 'tree-shape') {
          state.notes.push(note('warning', UA_FIX_KEYS.annotsTreeShape));
        } else if (result.tagged.length === 0) state.notes.push(note('warning', UA_FIX_KEYS.annotsNone));
        else {
          state.annotTags.push(...result.tagged);
          state.notes.push(note('changed', UA_FIX_KEYS.annotsTagged, { count: result.tagged.length }));
        }
        break;
      }
      case 'mark-pdfua':
        // Written by `fixPdfUa` after the other fixes were saved and re-checked.
        break;
    }
  }
  return state;
}

/** Read the file back and confirm each fix is what the file now says. */
async function verifyFixes(produced: Uint8Array, state: FixState): Promise<void> {
  let opened: Awaited<ReturnType<typeof openForWrite>>;
  try {
    opened = await openForWrite(produced);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `the file does not re-open after the fix: ${message}`,
    });
  }
  const { doc } = opened;
  const fail = (message: string): never => {
    throw new ToolError('verification-failed', { engine: 'mupdf', engineMessage: message });
  };
  try {
    const catalog = catalogOf(doc);
    const pages = pageObjects(doc);
    const facts = documentFacts(doc, catalog);
    if (state.title !== null) {
      if (facts.infoTitle !== state.title) fail(`the Info title reads back "${facts.infoTitle ?? ''}"`);
      if (facts.xmpTitle !== state.title) fail(`the XMP title reads back "${facts.xmpTitle ?? ''}"`);
    }
    if (state.lang !== null && facts.lang !== state.lang) fail(`/Lang reads back "${facts.lang ?? ''}"`);
    if (state.displayTitle && !facts.displayTitle) fail('/DisplayDocTitle did not read back as true');
    if (state.marked && !facts.marked) fail('/MarkInfo /Marked did not read back as true');
    for (const pageIndex of state.tabPages) {
      if (nameOf(pages[pageIndex]?.get('Tabs')) !== 'S') fail(`page ${pageIndex + 1} has no /Tabs /S`);
    }
    for (const pageIndex of state.rewrittenPages) {
      const page = pages[pageIndex];
      const content = page === undefined ? null : pageContent(page);
      const instructions = content === null ? null : readInstructions(content.bytes);
      if (page === undefined || content === null || instructions === null)
        fail(`page ${pageIndex + 1} cannot be read after the write`);
      else {
        const marks = scanContent(content.bytes, instructions, contentHooks(page));
        if (marks.unbalanced) fail(`page ${pageIndex + 1} has unbalanced marked content after the write`);
        const left = marks.paints.filter(
          (paint) => paint.kind === 'path' && coverageOf(marks, paint) === 'unmarked',
        ).length;
        if (left > 0) fail(`page ${pageIndex + 1} still has ${left} unmarked drawn paths`);
      }
    }
    if (state.annotTags.length > 0) {
      const model = readStructureModel(doc, pages);
      const roles = new Map<number, string>();
      walkNodes(model, (node) => {
        for (const kid of node.kids) {
          if (kid.kind === 'content' && kid.item.kind === 'objr' && kid.item.objectNumber !== null) {
            roles.set(kid.item.objectNumber, node.role);
          }
        }
      });
      for (const entry of state.annotTags) {
        if (roles.get(entry.objectNumber) !== entry.role) {
          fail(`annotation ${entry.objectNumber} is not in a ${entry.role} element after the write`);
        }
        const annot = resolved(doc.newIndirect(entry.objectNumber));
        if (intOf(annot, 'StructParent') === null)
          fail(`annotation ${entry.objectNumber} has no /StructParent`);
      }
    }
    for (const entry of state.linkContents) {
      const annot = resolved(doc.newIndirect(entry.objectNumber));
      if (textOf(annot?.get('Contents')) !== entry.text)
        fail(`link ${entry.objectNumber} has no /Contents after the write`);
    }
    for (const entry of state.tooltips) {
      const field = findField(catalog, entry.name);
      if (textOf(field?.get('TU')) !== entry.text) fail(`field ${entry.name} has no /TU after the write`);
    }
  } finally {
    doc.destroy();
  }
}

/**
 * Apply PDF/UA quick fixes and verify each by reading the file back.
 *
 * `mark-pdfua` is applied last and only when the **saved result of the other fixes** passes
 * every automated rule: the file is re-checked here, not trusted from the panel. When it
 * does not, the identifier is withheld, the other fixes still land, and a note says how many
 * rules still fail.
 */
export async function fixPdfUa(
  bytes: Uint8Array,
  fixes: readonly UaFix[],
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (fixes.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      path: 'fixes',
      engineMessage: 'no fixes requested',
    });
  }
  const wantsMark = fixes.some((fix) => fix.kind === 'mark-pdfua');
  const pageCount = await countPages(bytes);
  const { doc } = await openForWrite(bytes);
  let state: FixState;
  let first: Uint8Array;
  try {
    context.onProgress?.({
      phase: 'ua',
      labelKey: UA_FIX_KEYS.progressFix,
      done: 1,
      total: wantsMark ? 4 : 3,
    });
    state = applyFixes(doc, fixes, context);
    state.steps.push('ua');
    if (state.rewrittenPages.size > 0) state.steps.push('ua.artifact');
    first = saveRewrite(doc, 'PDF/UA fixes');
  } catch (error) {
    if (isAbort(error) || error instanceof ToolError) throw error;
    throw mapMupdfError(error, 'PDF/UA fixes');
  } finally {
    doc.destroy();
  }
  await verifyFixes(first, state);

  let out = first;
  const notes = [...state.notes];
  const steps = ['load', ...state.steps, 'producer', 'save', 'verify'];
  if (wantsMark) {
    context.onProgress?.({ phase: 'ua', labelKey: UA_FIX_KEYS.progressFix, done: 3, total: 4 });
    const report = await checkPdfUa(first, context);
    const failing = report.rules.filter(
      (rule) =>
        !rule.manual && rule.id !== 'pdfua-id' && (rule.state === 'fail' || rule.state === 'unchecked'),
    );
    if (failing.length > 0) {
      notes.push(note('warning', UA_FIX_KEYS.markRefused, { count: failing.length }));
    } else if (report.declaredPart !== null) {
      notes.push(note('preserved', UA_FIX_KEYS.uaKept, { part: report.declaredPart }));
    } else {
      const reopened = await openForWrite(first);
      try {
        writeXmp(reopened.doc, catalogOf(reopened.doc), { uaPart: 1 });
        out = saveRewrite(reopened.doc, 'declare PDF/UA');
      } catch (error) {
        if (isAbort(error) || error instanceof ToolError) throw error;
        throw mapMupdfError(error, 'declare PDF/UA');
      } finally {
        reopened.doc.destroy();
      }
      const confirm = await openForWrite(out);
      try {
        const packet = readXmpPacket(catalogOf(confirm.doc));
        if (packet === null || readUaPart(packet) !== 1) {
          throw new ToolError('verification-failed', {
            engine: 'mupdf',
            engineMessage: 'pdfuaid:part did not read back as 1',
          });
        }
      } finally {
        confirm.doc.destroy();
      }
      steps.push('ua.id');
      notes.push(note('changed', UA_FIX_KEYS.uaMarked));
      notes.push(note('warning', UA_FIX_KEYS.manualRemain));
    }
  }
  notes.push(note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }));
  return {
    bytes: out,
    report: {
      engine: 'mupdf',
      steps,
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: out.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

async function countPages(bytes: Uint8Array): Promise<number> {
  const { doc } = await openForWrite(bytes);
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}
