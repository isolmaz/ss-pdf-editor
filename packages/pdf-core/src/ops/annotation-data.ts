/**
 * Annotation data interchange: JSON and FDF (`PLAN.md §5/Phase 3`, the annotation
 * bullet's “import/export (JSON/FDF)”).
 *
 * Why it exists at all: a mark this app owns (underline, strikeout, squiggly,
 * shape) lives in the **session model** until a save writes it, and a mark the
 * engine drew lives in the engine's storage. Neither travels with the PDF the way
 * a form value does, so a review that has to move between machines — or between a
 * draft and a clean copy — needs a file of its own.
 *
 * Two formats, one record model:
 *
 *  - **JSON** is the lossless one, and it is ours: `{ version, pageCount, marks }`.
 *    Everything the model carries (kind, page, quads, colour, opacity, thickness,
 *    shape, ink strokes, contents, author, createdAt) round-trips exactly.
 *  - **FDF** is the container Acrobat's own “export comments” writes, and it is
 *    reused here through the **same** writer/parser the form-data interchange uses
 *    (`form-data.ts`). The records are keyed `ann.<index>.<field>`; an exported file
 *    is a valid FDF 1.2 document that any FDF reader will list.
 *
 * **What the FDF form is not:** Acrobat's comment FDF puts real annotation
 * dictionaries under `/Annots`, appearance streams included. Writing that from here
 * would mean re-deriving `/AP` streams the PDF engine already builds, and importing
 * one would mean parsing arbitrary annotation dictionaries — a fidelity claim this
 * module does not make. The FDF written here carries the same *records* as the JSON
 * (geometry included, so the round trip is lossless for our own files); reading
 * Acrobat's comment FDF is a Phase 4 item, recorded in `WORKLOG.md §4`.
 */

import { ToolError } from 'pdf-shared';
import type { AnnotationKind, AnnotationMark, MarkBox } from './annotations';
import { type FdfToken, type FormDataRecord, parseFdf, serializeFdf, tokenizePdfSource } from './form-data';

/** The JSON envelope's version, bumped when the record shape changes meaning. */
const ANNOTATION_DATA_VERSION = 1;

const KINDS: readonly AnnotationKind[] = [
  'highlight',
  'underline',
  'strikeout',
  'squiggly',
  'ink',
  'shapes',
  'note',
  'freetext',
];

export interface AnnotationDataResult {
  /** Marks that parsed, in file order. Ids are fresh: an import is a new review. */
  readonly marks: readonly AnnotationMark[];
  /** Records the file carried but that could not be read; reported, never silent. */
  readonly skipped: number;
  /** Page count the file was written against, when it says so. */
  readonly pageCount: number | null;
  /**
   * Comments whose page the file did not name, and which were therefore placed on page 1.
   * Acrobat's own comment export does not write `/Page`, so this is normally the whole
   * file: the number is what the report shows instead of pretending the placement is right.
   */
  readonly pageUnknown?: number;
  /**
   * The space the geometry is in. This app's own JSON and FDF records are written in the
   * app's page space (top-left origin, y down). Acrobat's comment FDF carries PDF **user
   * space** (bottom-left origin, y up), and only the importer, which knows each page's
   * top edge, can turn it the right way up ({@link toAppSpace}).
   */
  readonly space: 'app' | 'pdf-user';
}

/**
 * One mark from PDF user space into the app's page space, given the page's top edge
 * (`viewBox[3]`): every y is mirrored and each box is re-ordered so y0 is its top.
 * An Acrobat import that skipped this landed every comment mirrored about the page's
 * middle — a note at the top of a page arrived at the bottom.
 */
export function toAppSpace(mark: AnnotationMark, pageTop: number): AnnotationMark {
  const flip = (box: MarkBox): MarkBox => [
    Math.min(box[0], box[2]),
    pageTop - Math.max(box[1], box[3]),
    Math.max(box[0], box[2]),
    pageTop - Math.min(box[1], box[3]),
  ];
  return {
    ...mark,
    quads: mark.quads.map(flip),
    ...(mark.rect === undefined ? {} : { rect: flip(mark.rect) }),
    ...(mark.strokes === undefined
      ? {}
      : {
          strokes: mark.strokes.map((stroke) =>
            stroke.map((value, index) => (index % 2 === 1 ? pageTop - value : value)),
          ),
        }),
  };
}

// ---------------------------------------------------------------------------
// The record model (shared by both formats)
// ---------------------------------------------------------------------------

/** A quad as one string: `x0 y0 x1 y1`, the form both FDF arrays and JSON carry. */
function encodeQuads(boxes: readonly MarkBox[]): readonly string[] {
  return boxes.map((box) => box.map((value) => Number(value.toFixed(3))).join(' '));
}

function decodeQuads(values: readonly string[]): readonly MarkBox[] {
  const boxes: MarkBox[] = [];
  for (const value of values) {
    const numbers = value
      .split(/[\s,]+/)
      .map((part) => Number.parseFloat(part))
      .filter((number) => Number.isFinite(number));
    if (numbers.length < 4) continue;
    boxes.push([numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0]);
  }
  return boxes;
}

/** One mark as key/value records, in the order both writers keep. */
function recordsFor(index: number, mark: AnnotationMark): readonly FormDataRecord[] {
  const prefix = `ann.${index}`;
  const records: FormDataRecord[] = [
    { name: `${prefix}.kind`, value: mark.kind },
    { name: `${prefix}.page`, value: String(mark.pageIndex) },
    { name: `${prefix}.quads`, value: encodeQuads(mark.quads) },
    { name: `${prefix}.color`, value: mark.color },
    { name: `${prefix}.opacity`, value: String(mark.opacity) },
    { name: `${prefix}.contents`, value: mark.contents },
    { name: `${prefix}.author`, value: mark.author },
    { name: `${prefix}.created`, value: mark.createdAt },
  ];
  if (mark.thickness !== undefined) {
    records.push({ name: `${prefix}.thickness`, value: String(mark.thickness) });
  }
  if (mark.rotation !== undefined) {
    records.push({ name: `${prefix}.rotation`, value: String(mark.rotation) });
  }
  if (mark.shape !== undefined) records.push({ name: `${prefix}.shape`, value: mark.shape });
  // A note carries its place in `rect` alone (its `quads` are empty), so without this
  // record a note came back from its own export with no place on the page at all.
  if (mark.rect !== undefined) records.push({ name: `${prefix}.rect`, value: encodeQuads([mark.rect]) });
  if (mark.fontSize !== undefined) records.push({ name: `${prefix}.fontSize`, value: String(mark.fontSize) });
  if (mark.strokes !== undefined) {
    records.push({
      name: `${prefix}.strokes`,
      value: mark.strokes.map((stroke) => stroke.map((value) => Number(value.toFixed(3))).join(' ')),
    });
  }
  return records;
}

/** Rebuilds one mark from its records; `null` when the record set is unusable. */
function markFromRecords(
  records: ReadonlyMap<string, string | readonly string[] | boolean>,
): AnnotationMark | null {
  const text = (field: string): string | null => {
    const value = records.get(field);
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean' || value === undefined) return null;
    return value[0] ?? null;
  };
  const list = (field: string): readonly string[] => {
    const value = records.get(field);
    if (typeof value === 'string') return value.length === 0 ? [] : [value];
    if (typeof value === 'boolean' || value === undefined) return [];
    return value;
  };
  const number = (field: string): number | null => {
    const raw = text(field);
    if (raw === null) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const kind = text('kind');
  if (kind === null || !KINDS.includes(kind as AnnotationKind)) return null;
  // The FDF records are abbreviated (`page`, `created`); the JSON is spelled out
  // (`pageIndex`, `createdAt`). One reader takes both, so neither writer has to be
  // the canonical one — and a file written by either round-trips through both.
  const pageIndex = number('page') ?? number('pageIndex');
  if (pageIndex === null || pageIndex < 0) return null;
  const quads = decodeQuads(list('quads'));
  const rect = decodeQuads(list('rect'))[0];
  // A note or a text box carries its place in `rect`, every other kind in `quads`.
  // A mark with neither is not drawable and is skipped.
  if (quads.length === 0 && rect === undefined) return null;
  const fontSize = number('fontSize');

  const strokes = list('strokes').map((stroke) =>
    stroke
      .split(/[\s,]+/)
      .map((part) => Number.parseFloat(part))
      .filter((value) => Number.isFinite(value)),
  );
  const opacity = number('opacity');
  const thickness = number('thickness');
  // Invalid geometry is reported as skipped; silently replacing a turn would
  // import a mark at a different orientation than the review describes.
  const rawRotation = text('rotation');
  const rotation = rawRotation === null ? 0 : Number(rawRotation);
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) return null;
  const shape = text('shape');
  const createdAt = text('created') ?? text('createdAt');
  return {
    id: crypto.randomUUID(),
    kind: kind as AnnotationKind,
    pageIndex,
    quads,
    color: text('color') ?? '#ffd400',
    opacity: opacity === null ? 0.4 : Math.min(Math.max(opacity, 0.02), 1),
    contents: text('contents') ?? '',
    author: text('author') ?? '',
    createdAt: createdAt ?? new Date().toISOString(),
    ...(thickness === null ? {} : { thickness }),
    ...(rotation === 0 ? {} : { rotation }),
    ...(shape === null ? {} : { shape: shape as NonNullable<AnnotationMark['shape']> }),
    ...(strokes.length === 0 ? {} : { strokes }),
    ...(rect === undefined ? {} : { rect }),
    ...(fontSize === null ? {} : { fontSize }),
  };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** The lossless form: `{ version, pageCount, marks: [{ …record }] }`. */
export function serializeAnnotationsJson(
  marks: readonly AnnotationMark[],
  pageCount: number,
  pretty = true,
): Uint8Array {
  const payload = {
    version: ANNOTATION_DATA_VERSION,
    pageCount,
    marks: marks.map((mark) => ({
      kind: mark.kind,
      pageIndex: mark.pageIndex,
      quads: encodeQuads(mark.quads),
      color: mark.color,
      opacity: mark.opacity,
      contents: mark.contents,
      author: mark.author,
      createdAt: mark.createdAt,
      ...(mark.thickness === undefined ? {} : { thickness: mark.thickness }),
      ...(mark.shape === undefined ? {} : { shape: mark.shape }),
      ...(mark.rotation === undefined ? {} : { rotation: mark.rotation }),
      ...(mark.rect === undefined ? {} : { rect: encodeQuads([mark.rect]) }),
      ...(mark.fontSize === undefined ? {} : { fontSize: mark.fontSize }),
      ...(mark.strokes === undefined
        ? {}
        : {
            strokes: mark.strokes.map((stroke) => stroke.map((value) => Number(value.toFixed(3))).join(' ')),
          }),
    })),
  };
  return new TextEncoder().encode(pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
}

export function parseAnnotationsJson(text: string): AnnotationDataResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ToolError(
      'unsupported-format',
      { engine: 'model', engineMessage: `annotation JSON is not parseable: ${String(error)}` },
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'annotation JSON must be an object',
    });
  }
  const container = parsed as { readonly marks?: unknown; readonly pageCount?: unknown };
  if (!Array.isArray(container.marks)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'annotation JSON carries no marks array',
    });
  }
  const marks: AnnotationMark[] = [];
  let skipped = 0;
  for (const entry of container.marks) {
    if (entry === null || typeof entry !== 'object') {
      skipped += 1;
      continue;
    }
    const fields = new Map<string, string | readonly string[] | boolean>();
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'boolean') fields.set(key, value);
      else if (typeof value === 'number') fields.set(key, String(value));
      else if (Array.isArray(value)) {
        fields.set(
          key,
          value.filter((item): item is string => typeof item === 'string'),
        );
      }
    }
    const mark = markFromRecords(fields);
    if (mark === null) skipped += 1;
    else marks.push(mark);
  }
  const pageCount = typeof container.pageCount === 'number' ? container.pageCount : null;
  return { marks, skipped, pageCount, space: 'app' };
}

// ---------------------------------------------------------------------------
// FDF
// ---------------------------------------------------------------------------

/**
 * The same marks in the FDF container Acrobat's “export comments” produces, written
 * through the form-data writer so string escaping, arrays and the trailer are the
 * ones already verified for form data.
 */
export function serializeAnnotationsFdf(marks: readonly AnnotationMark[], pageCount: number): Uint8Array {
  const records: FormDataRecord[] = [
    { name: 'ann.version', value: String(ANNOTATION_DATA_VERSION) },
    { name: 'ann.pageCount', value: String(pageCount) },
    { name: 'ann.count', value: String(marks.length) },
  ];
  for (const [index, mark] of marks.entries()) records.push(...recordsFor(index, mark));
  return serializeFdf(records);
}

export function parseAnnotationsFdf(bytes: Uint8Array): AnnotationDataResult {
  const records = parseFdf(bytes);
  return annotationsFromRecords(records, 'FDF');
}

/** Groups `ann.<index>.<field>` records per mark and rebuilds them. */
function annotationsFromRecords(records: readonly FormDataRecord[], format: string): AnnotationDataResult {
  const perMark = new Map<number, Map<string, string | readonly string[] | boolean>>();
  let pageCount: number | null = null;
  let sawAnnotation = false;
  for (const record of records) {
    const match = /^ann\.(\d+)\.(.+)$/.exec(record.name);
    if (match === null) {
      if (record.name === 'ann.pageCount' && typeof record.value === 'string') {
        const parsed = Number.parseInt(record.value, 10);
        if (Number.isFinite(parsed)) pageCount = parsed;
      }
      continue;
    }
    sawAnnotation = true;
    const index = Number.parseInt(match[1] ?? '', 10);
    const field = match[2] ?? '';
    if (!Number.isFinite(index) || field.length === 0) continue;
    const fields = perMark.get(index) ?? new Map<string, string | readonly string[] | boolean>();
    fields.set(field, record.value);
    perMark.set(index, fields);
  }
  if (!sawAnnotation && records.length > 0) {
    // A valid FDF with different keys is **not** an annotation file: saying so is
    // more useful than importing nothing.
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: `${format} file carries no ann.* records`,
    });
  }
  const marks: AnnotationMark[] = [];
  let skipped = 0;
  for (const index of [...perMark.keys()].sort((a, b) => a - b)) {
    const mark = markFromRecords(perMark.get(index) ?? new Map());
    if (mark === null) skipped += 1;
    else marks.push(mark);
  }
  return { marks, skipped, pageCount, space: 'app' };
}

/**
 * The format a file is in, from its own bytes rather than from its name: an FDF
 * starts with its header, JSON with `{`. A file that is neither is refused with the
 * format contract's own error instead of importing nothing.
 */
export function parseAnnotationData(bytes: Uint8Array): AnnotationDataResult {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 16)).trimStart();
  if (head.startsWith('%FDF')) {
    // Our own container carries `ann.*` records; Acrobat's carries annotation objects. The
    // file itself says which it is, and the two are told apart by trying the *record* shape
    // first — a file that has neither is refused by both readers, loudly.
    try {
      return parseAnnotationsFdf(bytes);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return parseAcrobatCommentsFdf(bytes);
    }
  }
  if (head.startsWith('{')) return parseAnnotationsJson(new TextDecoder('utf-8').decode(bytes));
  throw new ToolError('unsupported-format', {
    engine: 'model',
    engineMessage: 'not an annotation data file (neither JSON nor FDF)',
  });
}

// ---------------------------------------------------------------------------
// Acrobat's comment FDF
// ---------------------------------------------------------------------------

/**
 * Acrobat's “export comments” container (`PLAN.md §5/Phase 3`, the carried item in
 * `WORKLOG.md §4`).
 *
 * It is an FDF whose `/Fields` entries are **annotations**, not form values, and the
 * annotation travels as a PDF object: either as a `/V` **string** whose text is the
 * annotation's dictionary (`<< /Subtype /Highlight … >>`), which is what Acrobat writes,
 * or — from other producers — as a `/V` dictionary directly. Both are read here.
 *
 * **What this reader knows and what it does not.** The shape above is the documented one,
 * and the check that covers it builds a file in exactly that shape (`tools/spikes/
 * annotation-data-probe.mjs`); a file **exported by a real Acrobat** has not been run
 * through it, because the tree has none and test corpora come from the owner (`K28`). The
 * honest consequences are visible in the result: values that do not parse are *skipped and
 * counted*, a subtype this model cannot hold is counted too, and the page a comment sits on
 * is taken from `/Page` when the producer wrote it — Acrobat's own export does not, and a
 * comment whose page is unknown lands on page 1 with a note that says so.
 */
export function parseAcrobatCommentsFdf(bytes: Uint8Array): AnnotationDataResult {
  const source = new TextDecoder('latin1').decode(bytes);
  if (!source.startsWith('%FDF')) {
    throw new ToolError('unsupported-format', { engine: 'model', engineMessage: 'not an FDF file' });
  }
  const tokens = tokenizePdfSource(source);
  const { entries, unreadable } = readCommentEntries(tokens);
  // No annotation at all — not even a broken one — is a different answer from "some of
  // them were unreadable": the first is not this file's format, the second is a review
  // that arrived damaged. (`unreadable` on its own is still reported below.)
  if (entries.length === 0) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'the FDF carries no /Fields entries that look like annotations',
    });
  }

  const marks: AnnotationMark[] = [];
  // Both kinds of loss are counted: an entry whose value is not a dictionary at all
  // (`unreadable`) and one whose dictionary names a subtype this model cannot hold.
  let skipped = unreadable;
  let pageUnknown = 0;
  for (const [index, entry] of entries.entries()) {
    const mark = markFromAcrobat(index, entry);
    if (mark === null) skipped += 1;
    else {
      if (entry.pageIndex === null) pageUnknown += 1;
      marks.push(mark);
    }
  }
  return { marks, skipped, pageCount: null, pageUnknown, space: 'pdf-user' };
}

/** Acrobat's `/Subtype` names, mapped onto the kinds this model holds. */
const ACROBAT_KINDS: Record<
  string,
  { readonly kind: AnnotationKind; readonly shape?: 'square' | 'circle' | 'line' }
> = {
  Highlight: { kind: 'highlight' },
  Underline: { kind: 'underline' },
  StrikeOut: { kind: 'strikeout' },
  Squiggly: { kind: 'squiggly' },
  Text: { kind: 'note' },
  Ink: { kind: 'ink' },
  /**
   * Acrobat's free-text box becomes typed text at the same place with the same words.
   * Its size comes from `/DA` when the file states one; its font and border do not
   * survive — the text is re-drawn in the embedded Noto Sans every typed box uses.
   */
  FreeText: { kind: 'freetext' },
  Square: { kind: 'shapes', shape: 'square' },
  Circle: { kind: 'shapes', shape: 'circle' },
  Line: { kind: 'shapes', shape: 'line' },
};

interface CommentEntry {
  readonly dictionary: Record<string, PdfValue>;
  readonly pageIndex: number | null;
  readonly fallbackId: string;
}

type PdfValue =
  | string
  | number
  | null
  | readonly PdfValue[]
  | { readonly [key: string]: PdfValue }
  | { readonly name: string };

function isName(value: PdfValue | undefined): value is { readonly name: string } {
  return typeof value === 'object' && value !== null && 'name' in value;
}

function numberOf(value: PdfValue | undefined): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function numbersOf(value: PdfValue | undefined): readonly number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const parsed = numberOf(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function textOf(value: PdfValue | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** `[/C [r g b]]` (0…1) or a single grey value → `#rrggbb`. */
function colourOf(value: PdfValue | undefined): string {
  const parts = Array.isArray(value) ? numbersOf(value) : value === undefined ? [] : [numberOf(value) ?? 0];
  if (parts.length === 0) return '#f5c400';
  const [first = 0, second, third] = parts;
  const to255 = (component: number): number => Math.max(0, Math.min(255, Math.round(component * 255)));
  const channels =
    second === undefined || third === undefined
      ? [to255(first), to255(first), to255(first)]
      : [to255(first), to255(second), to255(third)];
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `/QuadPoints` is `x1 y1 x2 y2 x3 y3 x4 y4` per line, in **bottom-left** user space; the
 * model wants one box per line run in top-left space, which is what this converts. Acrobat
 * writes the points in an order that varies by producer, so the box is taken as the
 * bounding box of each group of four — the alternative is guessing which corner comes
 * first, and a bounding box is wrong only by the skew of a rotated quad.
 */
function quadsOf(value: PdfValue | undefined, rect: readonly number[]): readonly MarkBox[] {
  const points = numbersOf(value);
  const boxes: MarkBox[] = [];
  for (let at = 0; at + 7 < points.length; at += 8) {
    const xs = [points[at] ?? 0, points[at + 2] ?? 0, points[at + 4] ?? 0, points[at + 6] ?? 0];
    const ys = [points[at + 1] ?? 0, points[at + 3] ?? 0, points[at + 5] ?? 0, points[at + 7] ?? 0];
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  if (boxes.length > 0) return boxes;
  if (rect.length === 4) return [[rect[0] ?? 0, rect[1] ?? 0, rect[2] ?? 0, rect[3] ?? 0]];
  return [];
}

/** `/InkList` is `[[x y x y …] …]` per stroke, in user space. */
function strokesOf(value: PdfValue | undefined): readonly (readonly number[])[] {
  if (!Array.isArray(value)) return [];
  const strokes: number[][] = [];
  for (const stroke of value) {
    const points = numbersOf(stroke);
    if (points.length >= 4) strokes.push([...points]);
  }
  return strokes;
}

function markFromAcrobat(index: number, entry: CommentEntry): AnnotationMark | null {
  const { dictionary } = entry;
  const subtype = isName(dictionary.Subtype) ? dictionary.Subtype.name : '';
  const mapped = ACROBAT_KINDS[subtype];
  if (mapped === undefined) return null;
  const rect = numbersOf(dictionary.Rect);
  const quads = quadsOf(dictionary.QuadPoints, rect);
  if (quads.length === 0) return null;
  const date = textOf(dictionary.M);
  // A free text box states its text size and colour in `/DA` (`/Helv 12 Tf 0 0 1 rg`);
  // its `/C` is the box's background, not the ink.
  const appearance = mapped.kind === 'freetext' ? textOf(dictionary.DA) : '';
  const size = /([\d.]+)\s+Tf/.exec(appearance);
  const ink = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(appearance);
  const textColour = ink === null ? '#000000' : colourOf([Number(ink[1]), Number(ink[2]), Number(ink[3])]);
  return {
    id: textOf(dictionary.NM) || entry.fallbackId || `acrobat-${index}`,
    kind: mapped.kind,
    pageIndex: entry.pageIndex ?? 0,
    quads,
    color: mapped.kind === 'freetext' ? textColour : colourOf(dictionary.C),
    ...(size === null ? {} : { fontSize: Number(size[1]) }),
    opacity: Math.max(0, Math.min(1, numberOf(dictionary.CA) ?? 1)),
    contents: textOf(dictionary.Contents),
    author: textOf(dictionary.T),
    createdAt: isoFromAcrobatDate(date),
    ...(mapped.shape === undefined ? {} : { shape: mapped.shape }),
    ...(mapped.kind === 'ink' ? { strokes: strokesOf(dictionary.InkList) } : {}),
    ...(rect.length === 4 ? { rect: [rect[0] ?? 0, rect[1] ?? 0, rect[2] ?? 0, rect[3] ?? 0] as const } : {}),
  };
}

/** `/M` in Acrobat's own date form; anything else becomes “now”, which is a fact about the
 * import and is why the panel shows the date the file carried when it carried one. */
function isoFromAcrobatDate(value: string): string {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value.trim());
  if (match === null) return new Date().toISOString();
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00'] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`).toISOString();
}

/**
 * The `/Fields` entries, each read into an object graph or counted as unreadable.
 *
 * `/Page`, when a producer writes it, is read as the **0-based** index this model uses —
 * the PDF convention. A producer that wrote 1-based numbers is indistinguishable from one
 * that wrote 0-based ones, and the consequence (a comment one page later) is recorded in
 * this module's header rather than guessed at twice. When the key is absent the comment is
 * placed on page 1 and counted in `pageUnknown`.
 */
function readCommentEntries(tokens: readonly FdfToken[]): {
  readonly entries: readonly CommentEntry[];
  readonly unreadable: number;
} {
  const out: CommentEntry[] = [];
  let unreadable = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'name' || token.text !== 'T') continue;
    const nameToken = tokens[index + 1];
    const valueName = tokens[index + 2];
    if (nameToken?.kind !== 'string' || valueName?.kind !== 'name' || valueName.text !== 'V') continue;
    const value = tokens[index + 3];
    if (value === undefined) continue;
    let dictionary: Record<string, PdfValue> | null = null;
    if (value.kind === 'dict-open') {
      const read = readValue(tokens, index + 3);
      dictionary =
        typeof read.value === 'object' && read.value !== null && !Array.isArray(read.value)
          ? (read.value as Record<string, PdfValue>)
          : null;
    } else if (value.kind === 'string' && value.text.trimStart().startsWith('<<')) {
      const inner = readValue(tokenizePdfSource(value.text), 0);
      dictionary =
        typeof inner.value === 'object' && inner.value !== null && !Array.isArray(inner.value)
          ? (inner.value as Record<string, PdfValue>)
          : null;
    }
    if (dictionary === null) {
      // A `/T`-`/V` record that is not an annotation: counted, never silently dropped.
      unreadable += 1;
      continue;
    }
    const page = numberOf(dictionary.Page);
    out.push({
      dictionary,
      pageIndex: page === null ? null : Math.max(0, Math.trunc(page)),
      fallbackId: nameToken.text,
    });
  }
  return { entries: out, unreadable };
}

/** One PDF object out of tokens: a dictionary, an array, a name, a string or a number. */
function readValue(
  tokens: readonly FdfToken[],
  start: number,
): { readonly value: PdfValue; readonly next: number } {
  const token = tokens[start];
  if (token === undefined) return { value: null, next: start + 1 };
  if (token.kind === 'dict-open') {
    const out: Record<string, PdfValue> = {};
    let at = start + 1;
    while (at < tokens.length && tokens[at]?.kind !== 'dict-close') {
      const key = tokens[at];
      if (key?.kind !== 'name') {
        at += 1;
        continue;
      }
      const read = readValue(tokens, at + 1);
      out[key.text] = read.value;
      at = read.next;
    }
    return { value: out, next: at + 1 };
  }
  if (token.kind === 'array-open') {
    const items: PdfValue[] = [];
    let at = start + 1;
    while (at < tokens.length && tokens[at]?.kind !== 'array-close') {
      const read = readValue(tokens, at);
      items.push(read.value);
      at = read.next;
    }
    return { value: items, next: at + 1 };
  }
  if (token.kind === 'string') return { value: token.text, next: start + 1 };
  if (token.kind === 'name') {
    const numeric = Number.parseFloat(token.text);
    if (Number.isFinite(numeric) && /^[-+]?[\d.]/.test(token.text))
      return { value: numeric, next: start + 1 };
    return { value: { name: token.text }, next: start + 1 };
  }
  return { value: null, next: start + 1 };
}
