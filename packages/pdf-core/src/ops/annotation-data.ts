/**
 * Annotation data interchange: JSON and FDF (the annotation
 * bullet's “import/export (JSON/FDF)”).
 *
 * Why it exists at all: a mark this app owns (underline, strikeout, squiggly,
 * shape) lives in the **session model** until a save writes it, and a mark the
 * engine drew lives in the engine's storage. Neither travels with the PDF the way
 * a form value does, so a review that has to move between machines — or between a
 * draft and a clean copy — needs a file of its own.
 *
 * Two formats:
 *
 *  - **JSON** is the lossless one, and it is ours: `{ version, pageCount, marks }`.
 *    Everything the model carries (kind, page, quads, colour, opacity, thickness,
 *    shape, ink strokes, contents, author, createdAt, replies, review state)
 *    round-trips exactly.
 *  - **FDF** is the container Acrobat's own “Export comments” writes and reads (ISO 32000-1
 *    §12.7.7): `%FDF-1.2`, one catalog `<< /FDF << /Annots [ … ] /F (file.pdf) /ID [<…><…>] >> >>`,
 *    and every annotation as an indirect object holding its own dictionary — `/Type /Annot`,
 *    `/Subtype`, `/Page` (0-based), `/Rect`, `/C`, `/CA`, `/Contents`, `/T`, `/M`,
 *    `/QuadPoints`, `/InkList`, `/L`, `/BS`, a `/Popup` for the comment and, for a reply or a
 *    review state, `/IRT` naming the object it answers. The geometry is PDF **user space**, so a
 *    file leaves through each page's top edge (`pageTop`) and comes back through it
 *    ({@link toAppSpace}), as XFDF's does.
 *
 * What the FDF carries is the comment, not its look: appearance streams are not written (a
 * reader that opens the file builds them), and are skipped when an Acrobat file carries them.
 * A mark's quarter turn, a marker stroke's “highlight” kind (it is written as the `/Ink` it
 * is drawn as) and a text box's font do not travel; JSON keeps them all.
 *
 * **The reader takes three shapes**, told apart by the file itself (`parseAnnotationData`):
 * JSON; an FDF with `/Annots` (what Acrobat and this app write now); and the FDF this app
 * wrote before it wrote Acrobat's, whose `/Fields` hold `ann.<index>.<field>` records. Those
 * older files are still read, through the same record reader JSON uses (`markFromRecords`).
 *
 * XFDF, the XML form every review tool exchanges, is `annotation-xfdf.ts`: it carries
 * the file's own annotations as well as the session's, with their replies and states.
 */

import { ToolError } from 'pdf-shared';
import { stateContents } from './annotation-review';
import { formatPdfDate, parsePdfDate } from './annotation-threads';
import {
  type AnnotationKind,
  type AnnotationMark,
  boxesOf,
  type CommentReply,
  type CommentReview,
  hexToRgb,
  isStrokedHighlight,
  type MarkBox,
  markQuadPoints,
  markRect,
  REVIEW_STATES,
  type ReviewState,
} from './annotations';
import {
  bytesAsCharacters,
  escapeFdfString,
  type FdfDictionary,
  type FdfFile,
  type FdfObject,
  type FormDataRecord,
  parseFdf,
  readFdfFile,
  resolveFdf,
  tokenizePdfSource,
} from './form-data';

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

type Shape = NonNullable<AnnotationMark['shape']>;

const SHAPES: readonly Shape[] = ['square', 'circle', 'line'];

/** What a mark's colour is when a file carries none that is `#rrggbb`. */
const DEFAULT_COLOUR = '#ffd400';

export interface AnnotationDataResult {
  /** Marks that parsed, in file order. Ids are fresh: an import is a new review. */
  readonly marks: readonly AnnotationMark[];
  /** Records the file carried but that could not be read; reported, never silent. */
  readonly skipped: number;
  /** Page count the file was written against, when it says so. */
  readonly pageCount: number | null;
  /**
   * Comments whose page the file did not name, and which were therefore placed on page 1.
   * Acrobat's FDF names the page of every comment (`/Page`, required in an FDF annotation) and
   * so does XFDF's `page`; a file from another producer may not, and the number is what the
   * report shows instead of pretending the placement is right.
   */
  readonly pageUnknown?: number;
  /**
   * The space the geometry is in. This app's own JSON and its older FDF records are written
   * in the app's page space (top-left origin, y down). Acrobat's comment FDF (the one this
   * app writes now too) and XFDF carry PDF **user space** (bottom-left origin, y up), and
   * only the importer, which knows each page's top edge, can turn it the right way up
   * ({@link toAppSpace}).
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
  // A line's `rect` is its two ends in drag order (`lineEndpoints`), not a box: each
  // point is mirrored where it is, or the line would come back pointing the other way.
  const line = mark.kind === 'shapes' && mark.shape === 'line';
  const flipPoints = (box: MarkBox): MarkBox => [box[0], pageTop - box[1], box[2], pageTop - box[3]];
  return {
    ...mark,
    quads: mark.quads.map(flip),
    ...(mark.rect === undefined ? {} : { rect: line ? flipPoints(mark.rect) : flip(mark.rect) }),
    ...(mark.strokes === undefined
      ? {}
      : {
          strokes: mark.strokes.map((stroke) =>
            stroke.map((value, index) => (index % 2 === 1 ? pageTop - value : value)),
          ),
        }),
  };
}

/**
 * The marks of an import that a document of `pageCount` pages can hold. A mark on a page the
 * document does not have cannot be written (`writeAnnotations` refuses it, and every save
 * after the import would fail with it), so it is left out and added to `skipped`, which is
 * what the import's notice reports.
 */
export function keepMarksOnPages(result: AnnotationDataResult, pageCount: number): AnnotationDataResult {
  const marks = result.marks.filter(
    (mark) => Number.isInteger(mark.pageIndex) && mark.pageIndex >= 0 && mark.pageIndex < pageCount,
  );
  if (marks.length === result.marks.length) return result;
  return { ...result, marks, skipped: result.skipped + result.marks.length - marks.length };
}

// ---------------------------------------------------------------------------
// The record model (JSON, and the FDF this app wrote before Acrobat's form)
// ---------------------------------------------------------------------------

/** A quad as one string: `x0 y0 x1 y1`, the form the JSON carries. */
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
    // At least four numbers were read, so the first four exist.
    boxes.push([numbers[0] as number, numbers[1] as number, numbers[2] as number, numbers[3] as number]);
  }
  return boxes;
}

/** A reply as a file carries it; the id is the session's own and is minted again on import. */
function replyRecord(reply: CommentReply): Omit<CommentReply, 'id'> {
  return { author: reply.author, contents: reply.contents, createdAt: reply.createdAt };
}

/** Replies out of their JSON texts; an entry that is not one is dropped. */
function decodeReplies(values: readonly string[]): readonly CommentReply[] {
  const replies: CommentReply[] = [];
  for (const value of values) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed === null || typeof parsed !== 'object') continue;
      const { author, contents, createdAt } = parsed as Record<string, unknown>;
      if (typeof contents !== 'string' || contents.trim() === '') continue;
      replies.push({
        id: crypto.randomUUID(),
        author: typeof author === 'string' ? author : '',
        contents,
        createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
      });
    } catch {
      // Not a reply record; the mark itself still imports.
    }
  }
  return replies;
}

/** The review state out of its JSON text, or `null` when it is not one. */
function decodeReview(value: string | null): CommentReview | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object') return null;
    const { state, author, at } = parsed as Record<string, unknown>;
    if (typeof state !== 'string' || !REVIEW_STATES.includes(state as ReviewState)) return null;
    return {
      state: state as ReviewState,
      author: typeof author === 'string' ? author : '',
      at: typeof at === 'string' ? at : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Rebuilds one mark from its records; `null` when the record set is unusable.
 *
 * A file is not trusted to have written what the writer would: every value that a later
 * save would refuse is settled here, where the import can still say so. A colour that is
 * not `#rrggbb` becomes the default colour (the comment is still worth reading), and a
 * shape this app cannot draw, a page that is not a whole number from 0, a quarter turn
 * that is not one, or a record with nothing to draw makes the record unusable — it is
 * skipped and counted, never carried into the session to fail the next save.
 */
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
  if (pageIndex === null || !Number.isInteger(pageIndex) || pageIndex < 0) return null;
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
  // Only a shape has one, and only one of the three this app draws: the writer has no
  // subtype for any other name (`constructor` included).
  const shape = kind === 'shapes' ? text('shape') : null;
  if (shape !== null && !SHAPES.includes(shape as Shape)) return null;
  const colour = text('color')?.trim() ?? '';
  const createdAt = text('created') ?? text('createdAt');
  const replies = decodeReplies(list('replies'));
  const review = decodeReview(text('review'));
  return {
    id: crypto.randomUUID(),
    kind: kind as AnnotationKind,
    pageIndex,
    quads,
    color: /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : DEFAULT_COLOUR,
    opacity: opacity === null ? 0.4 : Math.min(Math.max(opacity, 0.02), 1),
    contents: text('contents') ?? '',
    author: text('author') ?? '',
    createdAt: createdAt ?? new Date().toISOString(),
    ...(thickness === null ? {} : { thickness }),
    ...(rotation === 0 ? {} : { rotation }),
    ...(shape === null ? {} : { shape: shape as Shape }),
    ...(strokes.length === 0 ? {} : { strokes }),
    ...(rect === undefined ? {} : { rect }),
    ...(fontSize === null ? {} : { fontSize }),
    ...(replies.length === 0 ? {} : { replies }),
    ...(review === null ? {} : { review }),
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
      ...(mark.replies === undefined || mark.replies.length === 0
        ? {}
        : { replies: mark.replies.map(replyRecord) }),
      ...(mark.review === undefined ? {} : { review: mark.review }),
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
        // Replies are objects in the JSON and JSON texts in the record model.
        fields.set(
          key,
          value.flatMap((item) =>
            typeof item === 'string'
              ? [item]
              : item !== null && typeof item === 'object'
                ? [JSON.stringify(item)]
                : [],
          ),
        );
      } else if (value !== null && typeof value === 'object') fields.set(key, JSON.stringify(value));
    }
    const mark = markFromRecords(fields);
    if (mark === null) skipped += 1;
    else marks.push(mark);
  }
  const pageCount = typeof container.pageCount === 'number' ? container.pageCount : null;
  return { marks, skipped, pageCount, space: 'app' };
}

// ---------------------------------------------------------------------------
// FDF: writing Acrobat's comment container
// ---------------------------------------------------------------------------

export interface AnnotationFdfInput {
  /** Session marks, in the app's page space (top-left origin). */
  readonly marks: readonly AnnotationMark[];
  /** A page's top edge (`viewBox[3]`), or `null` when the page cannot be measured. */
  readonly pageTop: (pageIndex: number) => number | null;
  /** The PDF the comments belong to, written as `/F` and `/UF`. */
  readonly fileName?: string;
  /**
   * The PDF's `/ID` as two strings of hex digits (the engine's fingerprints of the file),
   * written as the FDF's own `/ID`. Left out of the file when it is not given: an identifier
   * that names no file is worse than none.
   */
  readonly fileId?: readonly [string, string];
}

export interface AnnotationFdfExport {
  readonly bytes: Uint8Array;
  /** Comments written (their replies, review states and popups are not counted). */
  readonly count: number;
  /** Marks on a page that could not be measured: left out, never written at a guessed place. */
  readonly skipped: number;
}

/** `/Subtype` for each way a mark is drawn. A marker stroke (a highlight painted as a path) is an ink. */
function acrobatSubtype(mark: AnnotationMark): string {
  if (isStrokedHighlight(mark)) return 'Ink';
  switch (mark.kind) {
    case 'ink':
      return 'Ink';
    case 'highlight':
      return 'Highlight';
    case 'underline':
      return 'Underline';
    case 'strikeout':
      return 'StrikeOut';
    case 'squiggly':
      return 'Squiggly';
    case 'freetext':
      return 'FreeText';
    case 'note':
      return 'Text';
    case 'shapes':
      return mark.shape === 'circle' ? 'Circle' : mark.shape === 'line' ? 'Line' : 'Square';
  }
}

function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** A PDF string, escaped (and written as UTF-16BE when it is not ASCII) by the form-data writer. */
function pdfString(value: string): string {
  return `(${escapeFdfString(value)})`;
}

function pdfNumbers(values: readonly number[]): string {
  return `[${values.map(num).join(' ')}]`;
}

/** One dictionary; an entry whose value is `undefined` is not written. */
function pdfDictionary(entries: readonly (readonly [string, string | undefined])[]): string {
  const written = entries.flatMap(([key, value]) => (value === undefined ? [] : [`/${key} ${value}`]));
  return `<< ${written.join(' ')} >>`;
}

/** `D:YYYYMMDDHHmmSSZ` for an ISO 8601 time, or `undefined` when it names no time. */
function pdfDateString(iso: string): string | undefined {
  const date = formatPdfDate(Date.parse(iso));
  return date === null ? undefined : pdfString(date);
}

/** The shape of every annotation's own entries, in the order Acrobat writes them. */
function commonEntries(
  page: number,
  rect: readonly number[],
  who: { readonly id: string; readonly author: string; readonly contents: string; readonly at: string },
  flags: number,
): (readonly [string, string | undefined])[] {
  const date = pdfDateString(who.at);
  return [
    ['Type', '/Annot'],
    ['Page', String(page)],
    ['Rect', pdfNumbers(rect)],
    ['NM', pdfString(who.id)],
    ['T', who.author === '' ? undefined : pdfString(who.author)],
    ['Contents', who.contents === '' ? undefined : pdfString(who.contents)],
    ['M', date],
    ['CreationDate', date],
    ['F', String(flags)],
  ];
}

/** The entries one session mark adds to the common ones, by the subtype it is drawn as. */
function markEntries(
  mark: AnnotationMark,
  subtype: string,
  top: number,
): (readonly [string, string | undefined])[] {
  const entries: (readonly [string, string | undefined])[] = [['Subtype', `/${subtype}`]];
  const border = (): readonly [string, string] => [
    'BS',
    `<< /Type /Border /W ${num(mark.thickness ?? 2)} /S /S >>`,
  ];
  switch (subtype) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly':
      entries.push(['QuadPoints', pdfNumbers(markQuadPoints(mark, top))]);
      break;
    case 'Ink': {
      // Each stroke is flat `x y x y …`; only the y of a pair is mirrored.
      const runs = (mark.strokes ?? []).map((stroke) =>
        pdfNumbers(stroke.map((value, index) => (index % 2 === 1 ? top - value : value))),
      );
      entries.push(['InkList', `[${runs.join(' ')}]`], border());
      break;
    }
    case 'Line': {
      // A line's `rect` is its two ends in drag order: `/L` keeps the direction `/Rect` cannot.
      const [x0, y0, x1, y1] = boxesOf(mark)[0] as MarkBox;
      entries.push(['L', pdfNumbers([x0, top - y0, x1, top - y1])], border());
      break;
    }
    case 'Square':
    case 'Circle':
      entries.push(border());
      break;
    case 'FreeText':
      entries.push([
        'DA',
        pdfString(`/Helv ${num(mark.fontSize ?? 12)} Tf ${hexToRgb(mark.color).map(num).join(' ')} rg`),
      ]);
      break;
    default:
      // `Text`: the sticky note's icon, as Acrobat names it.
      entries.push(['Name', '/Comment']);
  }
  // A typed text box has no ground colour: `/C` would paint its background, not its ink.
  if (subtype !== 'FreeText') entries.push(['C', pdfNumbers(hexToRgb(mark.color))]);
  entries.push(['CA', num(mark.opacity)]);
  return entries;
}

/**
 * The marks as Acrobat's “comments” FDF: every annotation an indirect object, listed in
 * `/FDF /Annots`. A mark is its annotation, a `/Popup` for its comment, one `/Text` per
 * reply (`/IRT` → the comment, or the reply it answers) and one for its review state
 * (`/State`, `/StateModel`, hidden), exactly the records Acrobat writes and reads back as a
 * thread. Coordinates are PDF user space, turned through each page's top edge; a mark on a
 * page `pageTop` cannot measure is counted in `skipped` instead of being written at a guess.
 */
export function serializeAnnotationsFdf(input: AnnotationFdfInput): AnnotationFdfExport {
  const objects: string[] = [];
  const listed: number[] = [];
  let next = 2;
  /** One indirect object (number 1 is the catalog); answers its number. */
  const emit = (body: string): number => {
    const number = next;
    next += 1;
    listed.push(number);
    objects.push(`${number} 0 obj`, body, 'endobj');
    return number;
  };

  let count = 0;
  let skipped = 0;
  for (const mark of input.marks) {
    const top = input.pageTop(mark.pageIndex);
    if (top === null) {
      skipped += 1;
      continue;
    }
    const subtype = acrobatSubtype(mark);
    // A stroked mark's rectangle holds the whole stroke (`markRect` grows it by half the
    // width), and the reader takes that half off again.
    const stroked = subtype === 'Ink' || mark.kind === 'shapes';
    const rect = markRect(stroked ? { ...mark, thickness: mark.thickness ?? 2 } : mark, top);
    const withPopup = subtype !== 'FreeText';
    const parent = next;
    emit(
      pdfDictionary([
        ...commonEntries(
          mark.pageIndex,
          rect,
          { id: mark.id, author: mark.author, contents: mark.contents, at: mark.createdAt },
          4,
        ),
        ...markEntries(mark, subtype, top),
        ['Popup', withPopup ? `${parent + 1} 0 R` : undefined],
      ]),
    );
    if (withPopup) {
      // The window the comment opens in, beside the annotation: 180 × 100 points from its upper-right corner.
      const [, , right = 0, upper = 0] = rect;
      emit(
        pdfDictionary([
          ['Type', '/Annot'],
          ['Subtype', '/Popup'],
          ['Page', String(mark.pageIndex)],
          ['Parent', `${parent} 0 R`],
          ['Open', 'false'],
          ['Rect', pdfNumbers([right, upper - 100, right + 180, upper])],
        ]),
      );
    }
    // A reply is a small note at the comment's corner; where it sits is not what it says.
    const [left = 0, , , corner = 0] = rect;
    const small = [left, corner - 20, left + 20, corner];
    for (const reply of mark.replies ?? []) {
      emit(
        pdfDictionary([
          ...commonEntries(
            mark.pageIndex,
            small,
            { id: reply.id, author: reply.author, contents: reply.contents, at: reply.createdAt },
            28,
          ),
          ['Subtype', '/Text'],
          ['Name', '/Comment'],
          ['IRT', `${parent} 0 R`],
          ['RT', '/R'],
        ]),
      );
    }
    if (mark.review !== undefined && mark.review.state !== 'None') {
      emit(
        pdfDictionary([
          ...commonEntries(
            mark.pageIndex,
            small,
            {
              id: `${mark.id}-state`,
              author: mark.review.author,
              contents: stateContents(mark.review.state, mark.review.author),
              at: mark.review.at,
            },
            // Print, no-zoom, no-rotate and hidden: a state is not a second icon on the page.
            30,
          ),
          ['Subtype', '/Text'],
          ['Name', '/Comment'],
          ['IRT', `${parent} 0 R`],
          ['RT', '/R'],
          // Text strings (ISO 32000-1 Table 172), not names.
          ['State', pdfString(mark.review.state)],
          ['StateModel', pdfString('Review')],
        ]),
      );
    }
    count += 1;
  }

  const fileName = input.fileName === undefined ? undefined : pdfString(input.fileName);
  const [first, second] = input.fileId ?? [];
  const hex = /^(?:[0-9a-f]{2})+$/i;
  const fileId =
    first !== undefined && second !== undefined && hex.test(first) && hex.test(second)
      ? `[<${first}><${second}>]`
      : undefined;
  const catalog = pdfDictionary([
    [
      'FDF',
      pdfDictionary([
        ['Annots', `[${listed.map((number) => `${number} 0 R`).join(' ')}]`],
        ['F', fileName],
        ['UF', fileName],
        ['ID', fileId],
      ]),
    ],
    ['Type', '/Catalog'],
  ]);
  const lines = ['%FDF-1.2', '1 0 obj', catalog, 'endobj', ...objects, 'trailer', '<< /Root 1 0 R >>'];
  return { bytes: new TextEncoder().encode(`${lines.join('\n')}\n%%EOF\n`), count, skipped };
}

// ---------------------------------------------------------------------------
// FDF: reading
// ---------------------------------------------------------------------------

/**
 * The FDF this app wrote before it wrote Acrobat's: `ann.<index>.<field>` form records.
 * Read for the files that are already out there; nothing writes it any more.
 */
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
    // Both groups took part in the match; a digit run long enough to overflow is not an index.
    const index = Number.parseInt(match[1] as string, 10);
    const field = match[2] as string;
    if (!Number.isFinite(index)) continue;
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
  for (const [, fields] of [...perMark.entries()].sort(([a], [b]) => a - b)) {
    const mark = markFromRecords(fields);
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
    // Acrobat's comment file (and this app's now) holds `/Annots`; the one this app wrote
    // before holds `ann.*` records under `/Fields`. The file itself says which it is.
    const file = readCommentFile(bytes);
    const annots = fdfAnnotsOf(file);
    if (annots !== null) return commentsFromFile(file, annots);
    try {
      return parseAnnotationsFdf(bytes);
    } catch (error) {
      // The bytes were read as objects above, so what is left to refuse is a file with
      // neither kind of content: a form-data FDF, or one with nothing in it we know.
      throw new ToolError(
        'unsupported-format',
        { engine: 'model', engineMessage: 'the FDF carries neither /Annots comments nor ann.* records' },
        { cause: error },
      );
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
 * Acrobat's “export comments” container: `/FDF << /Annots [ 2 0 R 3 0 R … ] /F (file.pdf)
 * /ID [<…><…>] >>`, every annotation an indirect object (or, from another producer, a
 * dictionary in the array itself).
 *
 * **What is read.** `/Highlight`, `/Underline`, `/StrikeOut`, `/Squiggly`, `/Ink`, `/Square`,
 * `/Circle`, `/Line`, `/Text` and `/FreeText` become session marks in PDF user space (the
 * importer turns them through each page's top edge, `toAppSpace`), with the page from `/Page`
 * (0-based; ISO 32000-1 requires it in an FDF), the colour from `/C`, the words from
 * `/Contents`, the author from `/T` and the date from `/CreationDate` or `/M` (zone
 * applied). An annotation with `/IRT` is a reply — or, with `/State`, a review state — and is
 * attached to the comment its chain of `/IRT`s ends at. A `/Popup` is part of its comment and
 * is not counted.
 *
 * **What is counted instead of read.** An annotation of another subtype (a stamp, a polygon, a
 * file attachment…), one with nothing this model can draw, a reply to a comment that is not in
 * the file, a state of a model other than `/Review`: each adds one to `skipped`. A comment
 * without `/Page` goes to page 1 and is counted in `pageUnknown`. Appearance streams are
 * skipped over, not read — the writer builds a new one when the comment is saved — and a
 * file's names (`/NM`) only link a thread together: every mark and reply gets a fresh id.
 */
export function parseAcrobatCommentsFdf(bytes: Uint8Array): AnnotationDataResult {
  const file = readCommentFile(bytes);
  const annots = fdfAnnotsOf(file);
  if (annots === null) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'the FDF carries no /FDF /Annots array',
    });
  }
  return commentsFromFile(file, annots);
}

/** An FDF's objects, read as bytes (PDFDocEncoding strings, stream bodies skipped over). */
function readCommentFile(bytes: Uint8Array): FdfFile {
  const source = bytesAsCharacters(bytes);
  if (!source.slice(0, 16).trimStart().startsWith('%FDF')) {
    throw new ToolError('unsupported-format', { engine: 'model', engineMessage: 'not an FDF file' });
  }
  return readFdfFile(tokenizePdfSource(source, { bytes: true }));
}

/** `/Annots` of the FDF dictionary: `/FDF` of a top-level dictionary, or the dictionary itself. */
function fdfAnnotsOf(file: FdfFile): readonly FdfObject[] | null {
  for (const root of file.roots) {
    const fdf = resolveFdf(file, root.entries.get('FDF'));
    const container = fdf?.type === 'dict' ? fdf : root;
    const annots = resolveFdf(file, container.entries.get('Annots'));
    if (annots?.type === 'array') return annots.items;
  }
  return null;
}

/** Acrobat's `/Subtype` names, mapped onto the kinds this model holds. */
interface AcrobatKind {
  readonly kind: AnnotationKind;
  readonly shape?: Shape;
}

/**
 * A `Map`, because the key is a name out of a file: `constructor` or `__proto__` is found on a
 * plain object's prototype and used to import as a mark of no kind at all.
 */
const ACROBAT_KINDS: ReadonlyMap<string, AcrobatKind> = new Map<string, AcrobatKind>([
  ['Highlight', { kind: 'highlight' }],
  ['Underline', { kind: 'underline' }],
  ['StrikeOut', { kind: 'strikeout' }],
  ['Squiggly', { kind: 'squiggly' }],
  ['Text', { kind: 'note' }],
  ['Ink', { kind: 'ink' }],
  // Acrobat's free-text box becomes typed text at the same place with the same words.
  // Its size and colour come from `/DA` when the file states them; its font and border do
  // not survive — the text is re-drawn in the embedded Noto Sans every typed box uses.
  ['FreeText', { kind: 'freetext' }],
  ['Square', { kind: 'shapes', shape: 'square' }],
  ['Circle', { kind: 'shapes', shape: 'circle' }],
  ['Line', { kind: 'shapes', shape: 'line' }],
]);

/** How the values of one comment file are read: references followed, a wrong type is "nothing". */
interface CommentValues {
  /** An entry of a dictionary, its reference followed. */
  readonly get: (dict: FdfDictionary, key: string) => FdfObject | undefined;
  /** A finite number; a string that starts with one is read as it (`(2)`). */
  readonly number: (value: FdfObject | undefined) => number | null;
  /** The numbers of an array, the items that are not one skipped. */
  readonly numbers: (value: FdfObject | undefined) => readonly number[];
  /** A string, or a number as its digits; anything else is no text (`''`). */
  readonly text: (value: FdfObject | undefined) => string;
  /** A name's text, or `null` for anything but a name. */
  readonly name: (value: FdfObject | undefined) => string | null;
  /** A text string or a name: `/State` is written as either (ISO 32000-1 Table 172). */
  readonly label: (value: FdfObject | undefined) => string | null;
}

function commentValues(file: FdfFile): CommentValues {
  const get = (dict: FdfDictionary, key: string): FdfObject | undefined =>
    resolveFdf(file, dict.entries.get(key));
  const number = (value: FdfObject | undefined): number | null => {
    const resolved = resolveFdf(file, value);
    if (resolved?.type === 'number') return Number.isFinite(resolved.value) ? resolved.value : null;
    if (resolved?.type === 'string') {
      const parsed = Number.parseFloat(resolved.text);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  const numbers = (value: FdfObject | undefined): readonly number[] => {
    const array = resolveFdf(file, value);
    if (array?.type !== 'array') return [];
    return array.items.flatMap((item) => {
      const parsed = number(item);
      return parsed === null ? [] : [parsed];
    });
  };
  const text = (value: FdfObject | undefined): string => {
    const resolved = resolveFdf(file, value);
    if (resolved?.type === 'string') return resolved.text;
    if (resolved?.type === 'number') return String(resolved.value);
    return '';
  };
  const name = (value: FdfObject | undefined): string | null => {
    const resolved = resolveFdf(file, value);
    return resolved?.type === 'name' ? resolved.text : null;
  };
  const label = (value: FdfObject | undefined): string | null => {
    const resolved = resolveFdf(file, value);
    return resolved?.type === 'string' || resolved?.type === 'name' ? resolved.text : null;
  };
  return { get, number, numbers, text, name, label };
}

/** `[r g b]` (0…1) or a single grey value → `#rrggbb`; no colour at all is the default amber. */
function colourOf(parts: readonly number[]): string {
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
 * model wants one box per line run, which is what this makes. Acrobat writes the points in an
 * order that varies by producer, so the box is the bounding box of each group of four — the
 * alternative is guessing which corner comes first, and a bounding box is wrong only by the
 * skew of a rotated quad. A trailing group of fewer than eight numbers is not a quad.
 */
function quadBoxes(points: readonly number[]): readonly MarkBox[] {
  const boxes: MarkBox[] = [];
  for (let at = 0; at + 7 < points.length; at += 8) {
    // `at + 7 < points.length` bounds every read.
    const xs = [
      points[at] as number,
      points[at + 2] as number,
      points[at + 4] as number,
      points[at + 6] as number,
    ];
    const ys = [
      points[at + 1] as number,
      points[at + 3] as number,
      points[at + 5] as number,
      points[at + 7] as number,
    ];
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return boxes;
}

/** The box with its corners in order, from the first four numbers of a `/Rect`. */
function orderedBox(rect: readonly number[]): MarkBox | null {
  if (rect.length < 4) return null;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = rect;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** The box around flat `[x, y, …]` runs of at least one point each (an ink's strokes). */
function boundsOfRuns(runs: readonly (readonly number[])[]): MarkBox {
  const flat = runs.flat();
  const xs = flat.filter((_, index) => index % 2 === 0);
  const ys = flat.filter((_, index) => index % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * One annotation dictionary as a mark in PDF user space, or `null` when it holds nothing this
 * model can draw (no place, a stroke with no points, a text box with no words, a line with no
 * ends). The stroke of a shape or an ink is the border's width: its `/Rect` holds the whole
 * stroke, so half of it is taken off to get the mark's own box back (`markRect` grows by it).
 */
function markFromAnnotation(
  values: CommentValues,
  dict: FdfDictionary,
  mapped: AcrobatKind,
): AnnotationMark | null {
  const box = orderedBox(values.numbers(values.get(dict, 'Rect')));
  const style = values.get(dict, 'BS');
  const width =
    (style?.type === 'dict' ? values.number(style.entries.get('W')) : null) ??
    values.numbers(values.get(dict, 'Border'))[2];
  const stroke = Math.max(width ?? 2, 0);
  const inset = (outer: MarkBox): MarkBox => {
    const x = Math.min(stroke / 2, (outer[2] - outer[0]) / 2);
    const y = Math.min(stroke / 2, (outer[3] - outer[1]) / 2);
    return [outer[0] + x, outer[1] + y, outer[2] - x, outer[3] - y];
  };
  // `/C` is `[r g b]`; a single number is a grey, and no colour is the default.
  const colour = values.get(dict, 'C');
  let channels: readonly number[] = [];
  if (colour?.type === 'array') channels = values.numbers(colour);
  else if (colour !== undefined) channels = [values.number(colour) ?? 0];
  const page = values.number(dict.entries.get('Page'));
  const opacity = values.number(dict.entries.get('CA'));
  const created = values.text(values.get(dict, 'CreationDate')) || values.text(values.get(dict, 'M'));
  const base = {
    id: crypto.randomUUID(),
    kind: mapped.kind,
    pageIndex: page === null ? 0 : Math.max(0, Math.trunc(page)),
    color: colourOf(channels),
    opacity: Math.max(0, Math.min(1, opacity ?? 1)),
    contents: values.text(values.get(dict, 'Contents')),
    author: values.text(values.get(dict, 'T')),
    createdAt: isoFromAcrobatDate(created),
    ...(width === undefined ? {} : { thickness: width }),
  };
  switch (mapped.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      // No quad points: the rectangle is the one box (a comment with neither has no place).
      const quads = quadBoxes(values.numbers(values.get(dict, 'QuadPoints')));
      if (quads.length > 0) return { ...base, quads };
      return box === null ? null : { ...base, quads: [box] };
    }
    case 'ink': {
      const list = values.get(dict, 'InkList');
      const items: readonly FdfObject[] = list?.type === 'array' ? list.items : [];
      const runs = items
        .map((item) => values.numbers(item))
        // A stroke needs two points, and a point is a pair: an odd last number is dropped.
        .filter((points) => points.length >= 4)
        .map((points) => points.slice(0, points.length - (points.length % 2)));
      if (runs.length === 0) return null;
      // Without a `/Rect` the box is the one around the strokes themselves.
      return { ...base, quads: [inset(box ?? boundsOfRuns(runs))], strokes: runs, thickness: stroke };
    }
    case 'shapes': {
      if (mapped.shape === 'line') {
        const ends = values.numbers(values.get(dict, 'L'));
        if (ends.length < 4) return null;
        // `/L` is the two ends in drag order, which is what the mark's `rect` is for a line.
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = ends;
        // Without a `/Rect` the box is the one around the two ends (four numbers, checked above).
        const around = box ?? (orderedBox(ends) as MarkBox);
        return { ...base, quads: [around], shape: 'line', rect: [x0, y0, x1, y1] };
      }
      if (box === null) return null;
      return {
        ...base,
        quads: [inset(box)],
        shape: mapped.shape as Shape,
        rect: inset(box),
        thickness: stroke,
      };
    }
    case 'freetext': {
      // A typed box states its size and ink in `/DA` (`/Helv 12 Tf 0 0 1 rg`); its `/C` is
      // the background, not the ink. A box without words is not a mark.
      if (box === null || base.contents.trim() === '') return null;
      const appearance = values.text(values.get(dict, 'DA'));
      const size = /([\d.]+)\s+Tf/.exec(appearance);
      const ink = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(appearance);
      return {
        ...base,
        color: ink === null ? '#000000' : colourOf([Number(ink[1]), Number(ink[2]), Number(ink[3])]),
        quads: [],
        rect: box,
        ...(size === null ? {} : { fontSize: Number(size[1]) }),
      };
    }
    case 'note':
      return box === null ? null : { ...base, quads: [], rect: box };
  }
}

/** `/M` in Acrobat's own date form; anything else becomes “now”, which is a fact about the
 * import and is why the panel shows the date the file carried when it carried one. */
export function isoFromAcrobatDate(value: string): string {
  return new Date(parsePdfDate(value) ?? Date.now()).toISOString();
}

/**
 * The annotations of a comment file as marks, with the replies and the review state that
 * answer them. Everything that is not a mark, a reply or a popup is counted, never dropped
 * in silence.
 */
function commentsFromFile(file: FdfFile, annots: readonly FdfObject[]): AnnotationDataResult {
  const values = commentValues(file);
  /** The comments by their dictionary: a reply's `/IRT` is resolved to the same object. */
  const roots = new Map<FdfDictionary, AnnotationMark>();
  const answers: FdfDictionary[] = [];
  let skipped = 0;
  let pageUnknown = 0;
  const seen = new Set<FdfDictionary>();
  for (const item of annots) {
    const dict = resolveFdf(file, item);
    if (dict?.type !== 'dict') {
      skipped += 1;
      continue;
    }
    // An object listed twice is one annotation.
    if (seen.has(dict)) continue;
    seen.add(dict);
    const subtype = values.name(dict.entries.get('Subtype'));
    // A popup is the window of its comment, not a comment.
    if (subtype === 'Popup') continue;
    // `/RT /Group` is grouped with another annotation, not an answer to it.
    if (dict.entries.has('IRT') && values.name(dict.entries.get('RT')) !== 'Group') {
      answers.push(dict);
      continue;
    }
    const mapped = subtype === null ? undefined : ACROBAT_KINDS.get(subtype);
    const mark = mapped === undefined ? null : markFromAnnotation(values, dict, mapped);
    if (mark === null) {
      skipped += 1;
      continue;
    }
    if (values.number(dict.entries.get('Page')) === null) pageUnknown += 1;
    roots.set(dict, mark);
  }

  /** The comment a reply's chain of `/IRT`s ends at; `null` for one that ends elsewhere or loops. */
  const rootOf = (start: FdfDictionary): FdfDictionary | null => {
    let current: FdfDictionary | undefined = start;
    const visited = new Set<FdfDictionary>();
    while (current !== undefined && !roots.has(current) && !visited.has(current)) {
      visited.add(current);
      const parent: FdfObject | undefined = values.get(current, 'IRT');
      current = parent?.type === 'dict' ? parent : undefined;
    }
    return current !== undefined && roots.has(current) ? current : null;
  };
  const replies = new Map<FdfDictionary, CommentReply[]>();
  const reviews = new Map<FdfDictionary, CommentReview>();
  for (const answer of answers) {
    const root = rootOf(answer);
    const state = values.label(answer.entries.get('State'));
    const model = values.label(answer.entries.get('StateModel')) ?? 'Review';
    // A model other than `Review` (Acrobat's private “Marked” check) is not held by this model.
    if (root === null || (state !== null && model !== 'Review')) {
      skipped += 1;
      continue;
    }
    const author = values.text(values.get(answer, 'T'));
    const at = isoFromAcrobatDate(
      values.text(values.get(answer, 'CreationDate')) || values.text(values.get(answer, 'M')),
    );
    if (state !== null) {
      if (!REVIEW_STATES.includes(state as ReviewState)) {
        skipped += 1;
        continue;
      }
      const previous = reviews.get(root);
      if (previous === undefined || Date.parse(previous.at) <= Date.parse(at)) {
        reviews.set(root, { state: state as ReviewState, author, at });
      }
      continue;
    }
    const contents = values.text(values.get(answer, 'Contents'));
    if (contents.trim() === '') {
      skipped += 1;
      continue;
    }
    const list = replies.get(root) ?? [];
    list.push({ id: crypto.randomUUID(), author, contents, createdAt: at });
    replies.set(root, list);
  }

  const marks = [...roots].map(([dict, mark]) => {
    const thread = [...(replies.get(dict) ?? [])].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    const review = reviews.get(dict);
    return {
      ...mark,
      ...(thread.length === 0 ? {} : { replies: thread }),
      ...(review === undefined ? {} : { review }),
    };
  });
  return { marks, skipped, pageCount: null, pageUnknown, space: 'pdf-user' };
}
