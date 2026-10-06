/**
 * Annotations and comments.
 *
 * ## Where the geometry comes from
 *
 * Every mark is expressed in the same space the viewer's own pointer conversion
 * produces (`ViewerApi.pointToPage`): **unrotated user space, origin top-left,
 * y growing downward, in points**. One rule for the overlay, the writer and the
 * comment panel — a mark cannot be drawn at one place and written to another.
 *
 * ## Who writes the bytes
 *
 * pdf.js owns the geometry write. `AnnotationStorage` is the engine's own channel
 * for *new* annotations: `saveDocument()` sends storage entries whose key starts
 * `pdfjs_internal_editor_` to the worker's `AnnotationFactory.saveNewAnnotations`,
 * which builds the annotation dictionaries **and their appearance streams** and
 * appends them to the page's `/Annots` array — the same path the engine's own
 * editor layer uses. Reusing it means a highlight's appearance is the engine's,
 * not an approximation of ours, and the file stays an incremental update.
 *
 * The entry shapes below are the ones the worker's creator consumes, read from
 * `build/pdf.worker.mjs` rather than guessed:
 *  - `HIGHLIGHT` (9) needs `quadPoints` (8 numbers per quad, in PDF user space,
 *    lower corner first) *and* `outlines` (polygons in page points, used to build
 *    the appearance stream). Missing `outlines` makes the worker throw
 *    `outlines is not iterable`; missing `quadPoints` silently produces an
 *    **ink** annotation instead of a highlight.
 *  - `INK` (15) needs `paths` — an array of strokes, each a flat `[x, y, x, y, …]`
 *    array in PDF user space — plus `thickness`.
 *  - `FREETEXT` (3) needs `value`, `fontSize` and a rectangle.
 *
 * The worker also has a second half, and the two subtypes it does **not** build
 * are the missing half of this capability: `saveNewAnnotations` only dispatches
 * Highlight/Ink/FreeText/Stamp/Signature, and `HighlightAnnotation.createNewDict`
 * hard-codes `/Subtype /Highlight`. **Underline, strikeout, squiggly and the
 * geometric shapes are therefore finished by `ops/annotation-shapes.ts`**, which
 * rewrites the subtype of a text mark and builds a shape's dictionary plus its
 * appearance stream through MuPDF (`engines/mupdf-write.ts`). The engine writes the geometry; we own the four
 * types it cannot write.
 *
 * ## The comment
 *
 * A mark's text travels as the annotation's popup (`contents` + `popupRef`),
 * which the worker writes as `/Contents` — what every reader shows as the note.
 * The body is prefixed with `pdf-editor-ann:<id>` so a re-read can tell our
 * annotations from the document's own; that marker is also what makes the
 * acceptance round trip checkable.
 *
 * ## Rotation
 *
 * A mark may carry `rotation`, a clockwise quarter turn about its own
 * bounding-box centre, and its stored geometry stays unrotated
 * (`ops/annotation-transform.ts`). A PDF annotation has no rotation of its own —
 * a reader draws its `/AP` — so the writers here write the **unturned** copy and
 * `writeAnnotationsToFile` then hands the new annotations to
 * `transformPdfAnnotations`, which turns the geometry keys and the appearance
 * together. Turning only the fields would leave a note's text upright, an
 * underline's bar flat and a `/Line`'s diagonal pointing the old way, because
 * those boxes map onto themselves at 90°.
 */

import type { PDFObject } from 'mupdf';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  pageObjects,
  readName,
  readText,
  resolved,
  saveRewrite,
  visibleBox,
} from '../engines/mupdf-write';
import type { PdfDocumentHandle } from '../engines/pdfjs-handle';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

/** pdf.js `AnnotationEditorType` values that can become new annotations. */
const EDITOR_HIGHLIGHT = 9;
const EDITOR_INK = 15;

/** pdf.js keys every **new** annotation with this prefix (`build/pdf.mjs:55`). */
export const ANNOTATION_EDITOR_PREFIX = 'pdfjs_internal_editor_';

export type AnnotationKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'ink'
  | 'shapes'
  | 'note'
  | 'freetext';

/**
 * The review states a reader offers for a comment (`/StateModel /Review`, ISO 32000-2
 * §12.5.6.3). `None` is a state of its own: it is how a reviewer takes a state back.
 */
export type ReviewState = 'Accepted' | 'Rejected' | 'Cancelled' | 'Completed' | 'None';

export const REVIEW_STATES: readonly ReviewState[] = [
  'None',
  'Accepted',
  'Rejected',
  'Cancelled',
  'Completed',
];

/**
 * A reply to a comment. In the file it becomes a `/Text` annotation whose `/IRT` names
 * the comment it answers (`ops/annotation-review.ts`); in the session it travels with
 * the mark it answers, so a reply to a comment that is not written yet is not lost.
 */
export interface CommentReply {
  readonly id: string;
  readonly author: string;
  readonly contents: string;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** The latest review state set on a comment, by whom and when (ISO 8601). */
export interface CommentReview {
  readonly state: ReviewState;
  readonly author: string;
  readonly at: string;
}

/** Mark kinds the pdf.js writer cannot finish and the MuPDF step takes over. */
export const OWNED_KINDS: readonly AnnotationKind[] = ['underline', 'strikeout', 'squiggly', 'shapes'];

/**
 * A markup mark over text: one quad per selected line run.
 *
 * `quads` are `[x0, y0, x1, y1]` boxes in the module's coordinate space (top-left
 * origin). They become PDF `QuadPoints` on the way out, which is what makes
 * underline/strikeout/squiggly indistinguishable from highlight at the geometry
 * level: the subtype alone decides how a reader draws them.
 */
export interface AnnotationMark {
  readonly id: string;
  readonly kind: AnnotationKind;
  /** 0-based. */
  readonly pageIndex: number;
  /** One box per line run, ascending, `[x0, y0, x1, y1]` (top-left origin). */
  readonly quads: readonly (readonly [number, number, number, number])[];
  /** `#rrggbb`. */
  readonly color: string;
  /** 0 … 1. */
  readonly opacity: number;
  /** Comment body; it reaches the file as the annotation's `/Contents`. */
  readonly contents: string;
  readonly author: string;
  /** ISO 8601, fixed at creation so a draft round-trip keeps the original date. */
  readonly createdAt: string;
  /** Stroke width for ink and shapes, in points. */
  readonly thickness?: number;
  /** Shape subtype for `kind: 'shapes'`. */
  readonly shape?: 'square' | 'circle' | 'line';
  /**
   * `[x0, y0, x1, y1]` for shapes, notes and typed text; `quads[0]` when omitted. For
   * typed text the top-left corner and the width are the user's, and the height follows
   * the wrapped lines (`annotation-freetext.ts`).
   */
  readonly rect?: readonly [number, number, number, number];
  /**
   * Typed text only: the size in points. For that kind `contents` is the visible text
   * itself, not a comment about something else on the page.
   */
  readonly fontSize?: number;
  /** Ink strokes: flat `[x, y, …]` arrays in the same space as `quads`. */
  readonly strokes?: readonly (readonly number[])[];
  /**
   * A clockwise quarter turn about the mark's own bounding-box centre; absent
   * means 0. The geometry above stays exactly as it was drawn: the overlay turns
   * the drawn boxes, and the writer turns the annotation and its appearance on the
   * way out (`ops/annotation-transform.ts`), so a mark never has two geometries to
   * keep in step.
   */
  readonly rotation?: 0 | 90 | 180 | 270;
  /** Replies, oldest first; written as `/IRT` replies when the mark is written. */
  readonly replies?: readonly CommentReply[];
  /** The review state, written as a `/State` record when the mark is written. */
  readonly review?: CommentReview;
}

/**
 * pdf.js `AnnotationType` (`build/pdf.worker.mjs`) → the `/Subtype` name a file
 * spells. The engine reports the dictionary name for an annotation it read from a
 * page, but its numeric type is what every record carries — including the ones the
 * engine's own editor makes — so a reader that has only the number can still name
 * the kind. `20` (Widget) and `16` (Popup) are the two a selection has to be able to
 * tell apart from a comment.
 */
const SUBTYPE_BY_TYPE: Readonly<Record<number, string>> = {
  1: 'Text',
  2: 'Link',
  3: 'FreeText',
  4: 'Line',
  5: 'Square',
  6: 'Circle',
  7: 'Polygon',
  8: 'PolyLine',
  9: 'Highlight',
  10: 'Underline',
  11: 'Squiggly',
  12: 'StrikeOut',
  13: 'Stamp',
  14: 'Caret',
  15: 'Ink',
  16: 'Popup',
  17: 'FileAttachment',
  18: 'Sound',
  19: 'Movie',
  20: 'Widget',
  21: 'Screen',
  22: 'PrinterMark',
  23: 'TrapNet',
  24: 'Watermark',
  25: '3D',
  26: 'Redact',
  27: 'RichMedia',
};

/**
 * An annotation that already exists in the file, as the engine reports it.
 *
 * ## Coordinates
 *
 * `rect` and every geometry field below are **PDF user space, lower-left origin**,
 * exactly as the engine reports them — the space `/Rect`, `/QuadPoints` and
 * `/InkList` live in, and the same space `AnnotationMark` reaches through
 * `markRect`/`boxToQuad`. A caller that needs the module's top-left page space
 * flips through the page's own box (`pageTop − y`); nothing here is pre-converted,
 * so a caller cannot end up comparing two different spaces by accident.
 *
 * ## What is optional
 *
 * Every field after `modified` is present only when the engine's record carries it:
 * a highlight has `quadPoints` and no `inkLists`, an ink stroke the other way
 * round, a `/Line` or `/PolyLine` (a measurement) has `vertices`. Absent data stays
 * absent rather than being filled in with a plausible-looking default, which is what
 * makes a hit test able to tell "this annotation has no geometry I understand" from
 * "this annotation is at the origin".
 */
export interface ExistingAnnotation {
  readonly id: string;
  /**
   * The file's `/Subtype` name (`Highlight`, `Widget`, `Popup`), or the name pdf.js's
   * numeric `annotationType` maps to when the record carries no dictionary name —
   * `''` only when the engine named the annotation in neither way.
   */
  readonly subtype: string;
  readonly pageIndex: number;
  readonly kind: AnnotationKind | null;
  /** `/Rect` in PDF user space, lower-left first; `null` when absent or malformed. */
  readonly rect: readonly [number, number, number, number] | null;
  readonly contents: string;
  readonly author: string;
  readonly modified: string | null;
  /** pdf.js `AnnotationType` (`20` = Widget, `16` = Popup), when the record has it. */
  readonly annotationType?: number;
  /**
   * The page's view box (`/CropBox` intersected with `/MediaBox`), PDF user space,
   * lower-left first — the frame every coordinate above is measured in. Read from
   * the page the annotations came from, so a caller can convert a persisted
   * annotation before that page has ever been rendered (a viewer that is showing
   * another page still knows this page's real box).
   */
  readonly pageBox?: readonly [number, number, number, number];
  /** Raw `/QuadPoints`: 8 numbers per quad, PDF user space, upper edge first. */
  readonly quadPoints?: readonly number[];
  /** Raw `/InkList`: one flat `[x, y, …]` run per stroke, PDF user space. */
  readonly inkLists?: readonly (readonly number[])[];
  /**
   * Vertices of a `/Line`, `/PolyLine` or `/Polygon` in PDF user space, flattened
   * `x, y` pairs — a measurement's own geometry. A `/Line` has no `/Vertices` key,
   * so its `/L` endpoints are read into the same field.
   */
  readonly vertices?: readonly number[];
  /**
   * `/C` as `#rrggbb`. pdf.js reports the colour a *reader* uses, so an annotation
   * with no `/C` arrives as black rather than as absent.
   */
  readonly color?: string;
  /** `/CA`, 0…1. */
  readonly opacity?: number;
  /**
   * Stroke width in points: `/BS /W` (or `/Border`), where pdf.js fills in the
   * reader's 1 pt default for an annotation whose file has neither.
   */
  readonly thickness?: number;
  /**
   * `/IRT`: the id of the annotation this one answers, in the same `17R` spelling as
   * `id`. Present for replies and review-state records (`replyType` `R`) and for
   * annotations grouped with another one (`replyType` `Group`).
   */
  readonly inReplyTo?: string;
  readonly replyType?: 'R' | 'Group';
  /** `/State` of a review record (`Accepted`, `Marked`, …), as the file spells it. */
  readonly state?: string;
  /** `/StateModel` of a review record: `Review` or `Marked`. */
  readonly stateModel?: string;
  /** `/CreationDate`, as the engine reports it. */
  readonly created?: string;
}

/** The pdf.js surface these operations need, as `PdfDocumentHandle` exposes it. */
export interface AnnotationWriteHandle extends PdfDocumentHandle {
  readonly pageCount: number;
}

export interface WriteAnnotationsOptions {
  readonly marks: readonly AnnotationMark[];
  /** Annotation ids already in the document, so a re-applied mark is not written twice. */
  readonly skipIds?: readonly string[];
  /** Bytes the report compares against; the caller owns the working version. */
  readonly inputBytes?: number;
}

// ---------------------------------------------------------------------------
// colour
// ---------------------------------------------------------------------------

/**
 * `#rrggbb` → three 0…1 components. The palette is authored as hex because that
 * is what a colour input produces; a malformed value must fail loudly rather
 * than paint black.
 */
export function hexToRgb(hex: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) {
    throw new ToolError('internal', {
      engine: 'ui',
      engineMessage: `annotation colour is not #rrggbb: ${hex}`,
    });
  }
  const value = Number.parseInt(match[1] as string, 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** Three 0…1 components (or a reader's array shape) → `#rrggbb`. */
export function rgbToHex(color: readonly number[]): string {
  const component = (value: number | undefined): string => {
    const scaled = Math.round(Math.min(Math.max(value ?? 0, 0), 1) * 255);
    return scaled.toString(16).padStart(2, '0');
  };
  return `#${component(color[0])}${component(color[1])}${component(color[2])}`;
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** `[x0, y0, x1, y1]` in the module's coordinate space (top-left origin). */
export type MarkBox = readonly [number, number, number, number];

/** A top-left-origin box in page points → PDF `QuadPoints`, lower corner first. */
export function boxToQuad(box: MarkBox, pageHeight: number): number[] {
  const [x0, y0, x1, y1] = box;
  const blX = Math.min(x0, x1);
  const trX = Math.max(x0, x1);
  // Top-left origin runs downward; PDF's `QuadPoints` start at the lower corner.
  const topY = pageHeight - Math.min(y0, y1);
  const bottomY = pageHeight - Math.max(y0, y1);
  return [blX, topY, trX, topY, blX, bottomY, trX, bottomY];
}

/** All quads of one mark, flattened — the shape the worker's writer expects. */
export function markQuadPoints(mark: AnnotationMark, pageHeight: number): number[] {
  const points: number[] = [];
  for (const box of boxesOf(mark)) points.push(...boxToQuad(box, pageHeight));
  return points;
}

/**
 * The rectangles a mark occupies, in page points with a top-left origin.
 *
 * A mark drawn as a stroke — the marker, and ink — has no line boxes to speak of:
 * its single box is the one around the sampled path, which is what its `/Rect` and
 * its hit test are measured from.
 */
export function boxesOf(mark: AnnotationMark): readonly MarkBox[] {
  if (mark.kind === 'shapes' || mark.kind === 'note' || mark.kind === 'freetext') {
    const rect = mark.rect ?? mark.quads[0];
    if (rect === undefined) {
      throw new ToolError('selection-empty', {
        engine: 'ui',
        engineMessage: `annotation ${mark.id} (${mark.kind}) carries no rectangle`,
      });
    }
    return [rect];
  }
  if (mark.quads.length > 0) return mark.quads;
  const strokes = boundsOfRuns(mark.strokes ?? []);
  if (strokes !== null) return [strokes];
  throw new ToolError('selection-empty', {
    engine: 'ui',
    engineMessage: `annotation ${mark.id} (${mark.kind}) carries no quad`,
  });
}

/** The box around one or more flat `[x, y, …]` runs, or `null` when none has a point. */
function boundsOfRuns(runs: readonly (readonly number[])[]): MarkBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    for (let index = 0; index + 1 < run.length; index += 2) {
      const x = run[index] ?? 0;
      const y = run[index + 1] ?? 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Whether a mark is the marker's own shape: a highlight painted as the stroke the
 * pointer drew rather than as the line boxes a text selection gives.
 *
 * `ops/annotation-shapes` owns its dictionary and appearance (`writeStrokeHighlights`),
 * because the engine's highlight writer fills polygons: handing it a stroke's box
 * would paint one solid rectangle instead of the band the user drew.
 */
export function isStrokedHighlight(mark: AnnotationMark): boolean {
  return mark.kind === 'highlight' && (mark.strokes?.length ?? 0) > 0;
}

/**
 * The annotation's `/Rect`, in PDF user space and **lower-left first**.
 *
 * Grown by half the stroke width so a squiggly's zigzag and a shape's stroke are
 * not clipped by their own bounding box.
 */
export function markRect(mark: AnnotationMark, pageHeight: number): number[] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x0, y0, x1, y1] of boxesOf(mark)) {
    minX = Math.min(minX, x0, x1);
    maxX = Math.max(maxX, x0, x1);
    minY = Math.min(minY, y0, y1);
    maxY = Math.max(maxY, y0, y1);
  }
  const pad = (mark.thickness ?? 0) / 2;
  return [minX - pad, pageHeight - maxY - pad, maxX + pad, pageHeight - minY + pad];
}

/**
 * Highlight polygons in PDF user space, matching the worker's untransformed
 * appearance BBox. Retagging must replace the highlight appearance as well.
 */
export function markOutlines(mark: AnnotationMark, pageTop: number): number[][] {
  return boxesOf(mark).map(([x0, y0, x1, y1]) => {
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = pageTop - Math.min(y0, y1);
    const bottom = pageTop - Math.max(y0, y1);
    return [left, top, right, top, right, bottom, left, bottom];
  });
}

// ---------------------------------------------------------------------------
// storage entries
// ---------------------------------------------------------------------------

/**
 * A mark in the shape pdf.js's writer consumes. The three text-line kinds that
 * are ours (underline, strikeout, squiggly) ride the `HIGHLIGHT` entry — the only
 * editor type whose writer reads `quadPoints` — and are re-tagged by
 * `ops/annotation-shapes.ts` afterwards.
 */
export interface StorageEntry {
  readonly id: string;
  /** pdf.js `AnnotationEditorType`. */
  readonly annotationType: number;
  readonly pageIndex: number;
  /** PDF user space, lower-left origin. */
  readonly rect: number[];
  readonly rotation: number;
  readonly color: readonly number[];
  readonly opacity: number;
  readonly contents: string;
  readonly popup: { readonly contents: string };
  readonly creationDate: string;
  readonly user: string;
  readonly quadPoints?: number[];
  readonly outlines?: number[][];
  readonly paths?: { readonly lines: number[][]; readonly points: number[][] };
  readonly inkLists?: number[][];
  readonly thickness?: number;
  readonly value?: string;
  readonly fontSize?: number;
}

/** Marker prefix inside an annotation's `/Contents`; identifies our writes. */
const MARKER_PREFIX = 'pdf-editor-ann:';

export function markerFor(id: string): string {
  return `${MARKER_PREFIX}${id}`;
}

/**
 * The comment a reader wrote, without this app's marker. `/Contents` carries the marker
 * ahead of the text so a later edit can find the annotation (`contentsFor`); it is an
 * identity, not words, and a comment list that printed it showed the user an opaque id.
 */
export function commentText(contents: string): string {
  const id = markerId(contents);
  return id === null ? contents : contents.replace(`${MARKER_PREFIX}${id}`, '').trim();
}

/** The id inside a marker line, or `null` when the annotation is not ours. */
export function markerId(contents: string): string | null {
  const index = contents.indexOf(MARKER_PREFIX);
  if (index < 0) return null;
  const rest = contents.slice(index + MARKER_PREFIX.length);
  const end = rest.search(/\s/);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The comment body an annotation carries: our marker first, then the author's
 * text. A reader shows the whole string, which is honest — the id is what makes
 * the round trip checkable, and hiding it would make a re-read guesswork.
 */
export function contentsFor(mark: AnnotationMark): string {
  const body = mark.contents.trim();
  return body.length === 0 ? markerFor(mark.id) : `${markerFor(mark.id)} ${body}`;
}

/**
 * Storage entries for one mark.
 *
 * Text marks produce one entry (the worker accepts an arbitrary quad list), ink
 * produces one — and notes and shapes produce **none**: the engine has no writer for
 * them, so `writeNoteAnnotations` and `writeShapeAnnotations` build those dictionaries
 * themselves.
 *
 * The geometry here is the mark's **stored** geometry: a mark's own `rotation` is
 * not baked in, because turning these fields is not the same as turning the mark —
 * a note's box, an underline's bar and a `/Line`'s diagonal all map onto themselves
 * at 90°. `writeAnnotationsToFile` writes the unturned copy and then hands the
 * resulting annotation to `ops/annotation-transform`, which turns the geometry and
 * the appearance together.
 */
export function storageEntriesFor(
  mark: AnnotationMark,
  pageHeight: number,
  pageRotation = 0,
): StorageEntry[] {
  const base = {
    id: mark.id,
    pageIndex: mark.pageIndex,
    rotation: pageRotation,
    color: hexToRgb(mark.color).map((channel) => Math.round(channel * 255)),
    opacity: mark.opacity,
    contents: contentsFor(mark),
    popup: { contents: contentsFor(mark) },
    creationDate: mark.createdAt,
    user: mark.author,
  } as const;

  // A stroked highlight (the marker) is written by `writeStrokeHighlights`, which
  // builds a stroke appearance; the engine has no writer for one.
  if (isStrokedHighlight(mark)) return [];

  switch (mark.kind) {
    case 'ink': {
      const strokes = (mark.strokes ?? []).map((stroke) => [...stroke]);
      if (strokes.length === 0) {
        throw new ToolError('selection-empty', {
          engine: 'ui',
          engineMessage: `ink annotation ${mark.id} carries no stroke`,
        });
      }
      // Everything ink leaves in **PDF user space** (`/InkList` and the
      // appearance both land there). `paths.lines` is the worker appearance
      // format (`writeLineToCurveToAppearance`): a leading NaN moveto group,
      // then 4 NaN padding + one coordinate pair per following point — a flat
      // stroke list or a trailing phantom group crashes the writer on
      // `undefined.toFixed` (measured). `paths.points` becomes `/InkList`
      // (`createNewDict`), and pdf.js's own serializer writes both
      // (`build/pdf.mjs:25002`).
      const userStrokes = strokes.map((stroke) =>
        stroke.map((value, index) => (index % 2 === 1 ? pageHeight - (value ?? 0) : value)),
      );
      const lines = userStrokes.map((stroke) => {
        const line: number[] = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
        for (let index = 0; index < stroke.length; index += 2) {
          if (index > 0) line.push(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
          line.push(stroke[index] as number, stroke[index + 1] as number);
        }
        return line;
      });
      return [
        {
          ...base,
          annotationType: EDITOR_INK,
          rect: markRect(mark, pageHeight),
          thickness: mark.thickness ?? 2,
          paths: { lines, points: userStrokes },
          inkLists: userStrokes,
        },
      ];
    }
    // A note is a `/Text` with its own icon, written by `writeNoteAnnotations`: the engine's
    // only writer for it was an empty `/FreeText`, which draws nothing.
    case 'note':
    case 'shapes':
    // Typed text needs a font that spells Turkish, which the engine's writer does not
    // have: `annotation-freetext.ts` writes these with an embedded Noto Sans.
    case 'freetext':
      return [];
    default:
      return [
        {
          ...base,
          annotationType: EDITOR_HIGHLIGHT,
          rect: markRect(mark, pageHeight),
          quadPoints: markQuadPoints(mark, pageHeight),
          outlines: markOutlines(mark, pageHeight),
          thickness: mark.thickness ?? 0,
        },
      ];
  }
}

/** `/Subtype` for each text-line kind this module retags. */
const RETAG_SUBTYPES: Readonly<Record<string, string>> = {
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
};

export interface RetagOutcome extends OperationOutcome {
  /** Marker lines of the annotations whose subtype was rewritten. */
  readonly retagged: readonly string[];
}

/**
 * Rewrite the subtype of the text marks this session just wrote.
 *
 * The engine writes every quad-list mark as `/Highlight` — its highlight builder
 * hard-codes the subtype and `AnnotationEditorType` has no entry for the other
 * three (verified against 6.3.289). The geometry is already right, so the only
 * work left is the dictionary key: a reader draws the same `/QuadPoints` as a bar
 * through the middle of the line, at its baseline, or as the zigzag purely from
 * the subtype. Matching is by the `/Contents` marker line, never by page or
 * position, so an unrelated annotation is untouched.
 */
export async function retagTextMarkup(
  bytes: Uint8Array,
  marks: readonly AnnotationMark[],
  context: OperationContext,
): Promise<RetagOutcome> {
  const targets = new Map<string, AnnotationMark>();
  for (const mark of marks) {
    // The appearance built below is a bar or a zigzag inside the annotation's own
    // box, drawn from the mark's stored geometry: a turned mark gets its appearance
    // turned afterwards by `ops/annotation-transform`, together with the fields, so
    // nothing is baked twice (`writeAnnotationsToFile`).
    if (RETAG_SUBTYPES[mark.kind] !== undefined) targets.set(markerFor(mark.id), mark);
  }
  if (targets.size === 0) return { ...nothingToDo(bytes, 'retag'), retagged: [] };

  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const retagged: string[] = [];
    try {
      for (const [index, page] of pages.entries()) {
        throwIfAborted(context.signal);
        const annots = annotsOf(doc, page);
        if (annots === null) continue;
        for (let position = 0; position < annots.length; position += 1) {
          const dict = resolved(annots.get(position));
          if (dict === null || !dict.isDictionary()) continue;
          const text = readText(dict.get('Contents')) ?? undefined;
          const id = text === undefined ? null : markerId(text);
          const mark = id === null ? undefined : targets.get(markerFor(id));
          if (mark === undefined || text === undefined) continue;
          // Popup records can carry the parent's comment; never retag the sibling.
          if (readName(dict.get('Subtype')) !== 'Highlight') continue;
          const subtype = RETAG_SUBTYPES[mark.kind];
          if (subtype === undefined) continue;
          const crop = visibleBox(page);
          const pageTop = crop.y + crop.height;
          // `Rect` was already written by the engine's writer; recompute it with
          // the same helper and the same defaults so a retag never moves it.
          const rect = markRect(mark, pageTop);
          const [left = 0, bottom = 0, right = 0, top = 0] = rect;
          const stroke = mark.thickness ?? 2;
          const commands = [`${hexToRgb(mark.color).join(' ')} RG`, `${stroke} w`, '1 J', '1 j'];
          for (const [x0, y0, x1, y1] of boxesOf(mark)) {
            const x = Math.min(x0, x1) - left;
            const end = Math.max(x0, x1) - left;
            const baseline = pageTop - Math.max(y0, y1) - bottom;
            const y = mark.kind === 'strikeout' ? pageTop - (y0 + y1) / 2 - bottom : baseline;
            commands.push(`${x} ${y} m`);
            if (mark.kind === 'squiggly') {
              const step = Math.max(stroke, 1);
              let raised = true;
              for (let next = x + step; next < end; next += step) {
                commands.push(`${next} ${y + (raised ? step : 0)} l`);
                raised = !raised;
              }
            }
            commands.push(`${end} ${y} l`, 'S');
          }
          const appearance = doc.addStream(commands.join('\n'), {
            Type: 'XObject',
            Subtype: 'Form',
            FormType: 1,
            BBox: [0, 0, right - left, top - bottom],
            Matrix: [1, 0, 0, 1, 0, 0],
          });
          dict.put('Subtype', subtype);
          dict.put('Rect', rect);
          const ap = doc.newDictionary();
          ap.put('N', appearance);
          dict.put('AP', ap);
          retagged.push(text);
        }
        context.onProgress?.({
          phase: 'annotate',
          labelKey: 'op.progress.annotate.retag',
          done: index + 1,
          total: pages.length,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.retag');
    }
    const saved = saveRewrite(doc, 'annotations.retag');
    return {
      bytes: saved,
      retagged,
      report: {
        engine: 'mupdf',
        steps: ['load', 'annotations.retag', 'save'],
        notes: [note('changed', 'op.note.annotate.retagged', { count: retagged.length })],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: pages.length,
        incremental: false,
      },
    };
  } finally {
    doc.destroy();
  }
}

/** A step that had nothing to write: same bytes, and the report says so. */
function nothingToDo(bytes: Uint8Array, step: string): OperationOutcome {
  return {
    bytes,
    report: {
      engine: 'mupdf',
      steps: [`annotations.${step}.skipped`],
      notes: [note('warning', 'op.note.annotate.nothing')],
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: 0,
      incremental: true,
    },
  };
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

interface AnnotationStoragePort {
  setValue(key: string, value: unknown): void;
  readonly size: number;
}

/** The engine's storage, or `undefined` when the document cannot carry annotations. */
export function annotationStorageOf(handle: PdfDocumentHandle): AnnotationStoragePort | undefined {
  const storage: unknown = handle.raw.annotationStorage;
  if (storage === null || typeof storage !== 'object') return undefined;
  if (!('setValue' in storage) || !('size' in storage)) return undefined;
  const { setValue, size } = storage;
  if (typeof setValue !== 'function' || typeof size !== 'number') return undefined;
  return {
    setValue: (key, value) => setValue.call(storage, key, value),
    get size() {
      return (storage as { readonly size: number }).size;
    },
  };
}

/**
 * Write the session's text-markup and ink marks through the engine's own writer.
 *
 * One call to the engine plus the caller's verification — no second parser, no
 * second writer, no appearance streams of our own. Returns the produced bytes
 * **and the ids the engine accepted**, because a mark the engine skipped must
 * stay in the session rather than vanish.
 */
export async function writeAnnotations(
  handle: AnnotationWriteHandle,
  options: WriteAnnotationsOptions,
  context: OperationContext,
): Promise<OperationOutcome & { readonly written: readonly string[] }> {
  const { marks, skipIds = [] } = options;
  const skipped = new Set(skipIds);
  const storage = annotationStorageOf(handle);
  if (storage === undefined) {
    throw new ToolError('unsupported', {
      engine: 'pdfjs',
      engineMessage: 'the document exposes no annotation storage',
    });
  }

  const written: string[] = [];
  /** Page heights are conversion constants; a page never needs a second read. */
  const heights = new Map<number, number>();

  for (const mark of marks) {
    throwIfAborted(context.signal);
    if (skipped.has(mark.id)) continue;
    if (mark.pageIndex < 0 || mark.pageIndex >= handle.pageCount) {
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `annotation ${mark.id} targets page ${mark.pageIndex + 1} of ${handle.pageCount}`,
      });
    }
    let top = heights.get(mark.pageIndex);
    if (top === undefined) {
      // Marks are stored in **unrotated PDF user space**: the conversion constant
      // is the crop box's absolute top (`view[3]`), not the rotated viewport
      // height `getPageSize` returns — with a CropBox origin the two differ by
      // exactly that offset, and a rect built from the viewport height lands
      // offset points away from the mark (measured).
      const page = await handle.raw.getPage(mark.pageIndex + 1);
      top = page.view[3] ?? 0;
      heights.set(mark.pageIndex, top);
    }
    for (const entry of storageEntriesFor(mark, top)) {
      storage.setValue(`${ANNOTATION_EDITOR_PREFIX}${entry.id}`, entry);
      written.push(mark.id);
    }
    context.onProgress?.({
      phase: 'annotate',
      labelKey: 'op.progress.annotate',
      done: written.length,
      total: marks.length,
    });
  }

  throwIfAborted(context.signal);
  const bytes = await handle.saveDocument();
  return {
    bytes,
    written,
    report: {
      engine: 'pdfjs',
      steps: ['pdfjs.saveDocument', 'annotations.new'],
      notes: [
        note('preserved', 'op.note.annotate.engine', { count: written.length }),
        note('changed', 'op.note.annotate.incremental'),
      ],
      inputBytes: options.inputBytes ?? bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: handle.pageCount,
      // Annotations ride the incremental writer.
      incremental: true,
    },
  };
}

// ---------------------------------------------------------------------------
// reading back
// ---------------------------------------------------------------------------

/** The subset of pdf.js's annotation record this module reads. */
interface EngineAnnotationRecord {
  readonly id?: unknown;
  readonly subtype?: unknown;
  readonly annotationType?: unknown;
  readonly rect?: unknown;
  readonly quadPoints?: unknown;
  readonly inkLists?: unknown;
  readonly vertices?: unknown;
  readonly lineCoordinates?: unknown;
  readonly color?: unknown;
  readonly opacity?: unknown;
  readonly borderStyle?: unknown;
  readonly contents?: unknown;
  readonly contentsObj?: unknown;
  readonly titleObj?: unknown;
  readonly modificationDate?: unknown;
  readonly creationDate?: unknown;
  readonly inReplyTo?: unknown;
  readonly replyType?: unknown;
  readonly state?: unknown;
  readonly stateModel?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A PDF name the engine passed through as its own `Name` object — `/State` and
 * `/StateModel` arrive as `{ name: 'Accepted' }`, not as a string — or a plain string.
 */
function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
    return value.name;
  }
  return null;
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    numbers.push(item);
  }
  return numbers;
}

/** A finite number out of an untyped record field, or `undefined`. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The engine hands geometry back as plain arrays **or** typed arrays — its own
 * editor serializer allocates a `Float32Array` per rescaled run (`Outline._rescale`,
 * `build/pdf.mjs`) while a file's annotation record carries plain arrays — so both
 * flatten alike.
 */
function asNumberList(value: unknown): number[] | null {
  if (ArrayBuffer.isView(value)) {
    return asNumberArray(Array.from(value as unknown as ArrayLike<number>));
  }
  return asNumberArray(value);
}

/**
 * A run of numbers **with its gaps kept**.
 *
 * The engine's path format separates a moveto or a line from its point with four
 * `NaN` placeholders (`FreeHighlightOutline`), so a reader that rejects non-finite
 * values cannot see such a run at all — `asNumberList` above is the one for runs
 * of real ordinates. Every entry still has to be a number: a string or an object
 * means this is not a run.
 */
function asNumberListPreservingNaN(value: unknown): number[] | null {
  const source = ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<unknown>) : value;
  if (!Array.isArray(source)) return null;
  const numbers: number[] = [];
  for (const item of source) {
    if (typeof item !== 'number') return null;
    numbers.push(item);
  }
  return numbers;
}

/** `/InkList`: one stroke per entry, each a flat `[x, y, …]` run in PDF user space. */
function asStrokeList(value: unknown): readonly (readonly number[])[] | null {
  if (!Array.isArray(value)) return null;
  const strokes: number[][] = [];
  for (const raw of value) {
    const stroke = asNumberList(raw);
    if (stroke !== null && stroke.length >= 2) strokes.push(stroke);
  }
  return strokes.length === 0 ? null : strokes;
}

/** `/C` as `#rrggbb`: pdf.js reports 0…255 bytes, the module speaks hex. */
function asHexColor(value: unknown): string | null {
  if (!Array.isArray(value) && !(value instanceof Uint8ClampedArray)) return null;
  const bytes = Array.from(value as ArrayLike<unknown>).slice(0, 3);
  if (bytes.length < 3) return null;
  let hex = '#';
  for (const byte of bytes) {
    if (typeof byte !== 'number' || !Number.isFinite(byte)) return null;
    hex += Math.max(0, Math.min(255, Math.round(byte)))
      .toString(16)
      .padStart(2, '0');
  }
  return hex;
}

/** pdf.js's `contentsObj`/`titleObj` are `{ str }` carriers in 6.x. */
function strOf(value: unknown): string {
  if (value === null || typeof value !== 'object' || !('str' in value)) return '';
  const inner = value.str;
  return typeof inner === 'string' ? inner : '';
}

/**
 * Existing annotations, page by page, through pdf.js's own annotation reader.
 *
 * Used twice: the comment panel lists what the document already carries, and the
 * writer skips the ids it can already see so a re-applied mark cannot become two
 * annotations (the engine's writer appends unconditionally).
 */
export async function readAnnotations(
  handle: PdfDocumentHandle,
  context: OperationContext,
): Promise<readonly ExistingAnnotation[]> {
  const result: ExistingAnnotation[] = [];
  for (let pageIndex = 0; pageIndex < handle.pageCount; pageIndex += 1) {
    throwIfAborted(context.signal);
    const page = await handle.raw.getPage(pageIndex + 1);
    const view = page.view;
    const pageBox: readonly [number, number, number, number] | undefined =
      view.length >= 4 && view.every((value) => Number.isFinite(value))
        ? [view[0] ?? 0, view[1] ?? 0, view[2] ?? 0, view[3] ?? 0]
        : undefined;
    const annotations = (await page.getAnnotations({ intent: 'display' })) as readonly unknown[];
    for (const raw of annotations) {
      if (raw === null || typeof raw !== 'object') continue;
      const record = raw as EngineAnnotationRecord;
      const rawSubtype = asString(record.subtype) ?? '';
      const rawRect = asNumberArray(record.rect);
      const rect: readonly [number, number, number, number] | null =
        rawRect !== null && rawRect.length >= 4
          ? [rawRect[0] ?? 0, rawRect[1] ?? 0, rawRect[2] ?? 0, rawRect[3] ?? 0]
          : null;
      const annotationType = finiteNumber(record.annotationType);
      // The dictionary name is the file's own word; the numeric type is the fallback for
      // a record that has none (pdf.js sets it for every annotation it builds), and both
      // the name and the app's own kind are read off the one that came out.
      const subtype = rawSubtype.length > 0 ? rawSubtype : (SUBTYPE_BY_TYPE[annotationType ?? 0] ?? '');
      const quadPoints = asNumberList(record.quadPoints);
      const inkLists = asStrokeList(record.inkLists);
      // `/Line` carries `/L`, not `/Vertices`; both arrive as the same flat pair run.
      const vertices = asNumberList(record.vertices) ?? asNumberList(record.lineCoordinates);
      const color = asHexColor(record.color);
      const opacity = finiteNumber(record.opacity);
      const style = record.borderStyle;
      const borderWidth =
        style !== null && typeof style === 'object' && 'width' in style ? style.width : undefined;
      const thickness = finiteNumber(borderWidth);
      const inReplyTo = asString(record.inReplyTo);
      const replyType = record.replyType === 'Group' ? 'Group' : inReplyTo === null ? undefined : 'R';
      const state = nameOf(record.state);
      const stateModel = nameOf(record.stateModel);
      const created = asString(record.creationDate);
      result.push({
        id: asString(record.id) ?? `${pageIndex}-${result.length}`,
        subtype,
        pageIndex,
        kind: kindForSubtype(subtype),
        rect,
        contents: strOf(record.contentsObj) || (asString(record.contents) ?? ''),
        author: strOf(record.titleObj),
        modified: asString(record.modificationDate),
        ...(annotationType === undefined ? {} : { annotationType }),
        ...(pageBox === undefined ? {} : { pageBox }),
        ...(quadPoints === null ? {} : { quadPoints }),
        ...(inkLists === null ? {} : { inkLists }),
        ...(vertices === null ? {} : { vertices }),
        ...(color === null ? {} : { color }),
        ...(opacity === undefined ? {} : { opacity }),
        ...(thickness === undefined || thickness <= 0 ? {} : { thickness }),
        ...(inReplyTo === null ? {} : { inReplyTo }),
        ...(replyType === undefined ? {} : { replyType }),
        ...(state === null ? {} : { state }),
        ...(stateModel === null ? {} : { stateModel }),
        ...(created === null ? {} : { created }),
      });
    }
  }
  return result;
}

/**
 * The reference ids the file now carries for the annotations we just wrote.
 *
 * The writers report the id *we* gave a mark (`pdf-editor-ann:<uuid>` inside
 * `/Contents`); a transform addresses an annotation by the object reference the
 * file gave it (`17R`), because that is the only stable identity a page's
 * `/Annots` array offers. The two are joined here on the marker line — the same
 * join `retagTextMarkup` matches on, and never on page order or position, so a
 * marker that is not in the file is simply left out rather than guessed at.
 *
 * Used by `writeAnnotationsToFile` to turn the marks of a rotated selection: what
 * it wrote is unturned, and the reference id is what the turn addresses.
 */
export async function markerTargets(
  bytes: Uint8Array,
  markers: readonly { readonly pageIndex: number; readonly id: string }[],
  context: OperationContext,
): Promise<readonly { readonly pageIndex: number; readonly id: string; readonly markId: string }[]> {
  if (markers.length === 0) return [];
  const wanted = new Map<string, string>();
  for (const marker of markers) wanted.set(`${marker.pageIndex}|${markerFor(marker.id)}`, marker.id);
  const { doc } = await openForWrite(bytes);
  try {
    const found: { pageIndex: number; id: string; markId: string }[] = [];
    for (const [pageIndex, page] of pageObjects(doc).entries()) {
      throwIfAborted(context.signal);
      const annots = annotsOf(doc, page);
      if (annots === null) continue;
      for (let position = 0; position < annots.length; position += 1) {
        const entry = annots.get(position);
        if (!entry.isIndirect()) continue;
        const dict = resolved(entry);
        if (dict === null || !dict.isDictionary()) continue;
        // A popup can carry its parent's comment — the same reason `retagTextMarkup`
        // checks the subtype before touching a match. Resolving one here would hand
        // `transformPdfAnnotations` a `/Popup` target, which it must refuse.
        if (readName(dict.get('Subtype')) === 'Popup') continue;
        const text = readText(dict.get('Contents'));
        const marker = text === null ? null : markerId(text);
        if (marker === null) continue;
        const id = wanted.get(`${pageIndex}|${markerFor(marker)}`);
        if (id === undefined) continue;
        found.push({ pageIndex, id: referenceOf(entry), markId: id });
      }
    }
    return found;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'annotations.markers');
  } finally {
    doc.destroy();
  }
}

/** The pdf.js spelling of an object reference: `17R` for generation 0 (`Ref.toString`). */
export function referenceOf(entry: PDFObject): string {
  // `asIndirect()` answers only the number; the engine's own `17 5 R` carries the generation.
  const match = /^(\d+) (\d+) R$/.exec(entry.toString());
  const objectNumber = match === null ? entry.asIndirect() : Number(match[1]);
  const generationNumber = match === null ? 0 : Number(match[2]);
  return generationNumber === 0 ? `${objectNumber}R` : `${objectNumber}R${generationNumber}`;
}

/**
 * Existing annotation ids, so a mark the file already carries is not written a
 * second time: the engine's writer appends unconditionally (`writeAnnotations`).
 */
export function annotationIdsOf(existing: readonly ExistingAnnotation[]): readonly string[] {
  return existing.flatMap((annotation) => {
    const id = markerId(annotation.contents);
    return id === null ? [annotation.id] : [annotation.id, id];
  });
}

/**
 * Engine annotations → the session's own marks.
 *
 * Recovered drafts may contain native highlight or ink records in annotation storage.
 * New gestures already belong to the controlled layer. Recovery takes these old
 * records over before `saveDocument()` can write them: the journal
 * must know what the document gained, the comment panel must list it, and the
 * retag step must be able to change its subtype — and then removes the storage entry
 * (`dropAnnotationEntry`), or the same annotation would be written twice.
 *
 * Geometry arrives in PDF user space, the space `QuadPoints` and `InkList` live in,
 * whose origin is the bottom-left corner; the app's marks use a top-left origin, so
 * every ordinate is flipped by the page box's top edge.
 */
export function marksFromEngineEntries(
  entries: readonly { readonly id: string; readonly value: Record<string, unknown> }[],
  pageBoxes: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }[],
  defaults: { readonly color: string; readonly opacity: number; readonly author: string },
): readonly AnnotationMark[] {
  const marks: AnnotationMark[] = [];
  for (const entry of entries) {
    const value = entry.value;
    // A native record with an existing PDF id updates that original annotation.
    // Turning it into a new overlay would duplicate it instead of editing it.
    if (typeof value.id === 'string' && value.id.length > 0) continue;
    if (value.annotationType !== EDITOR_HIGHLIGHT && value.annotationType !== EDITOR_INK) continue;
    const rawPage = value.pageIndex;
    if (typeof rawPage !== 'number') continue;
    const pageIndex: number = rawPage;
    const box = pageBoxes[pageIndex];
    if (box === undefined) continue;
    const top = box.y + box.height;
    const colour =
      Array.isArray(value.color) && value.color.every((part) => typeof part === 'number')
        ? rgbToHex((value.color as readonly number[]).map((component) => component / 255))
        : defaults.color;
    const opacity = typeof value.opacity === 'number' ? value.opacity : defaults.opacity;
    const thickness = typeof value.thickness === 'number' ? value.thickness : undefined;
    const contents = typeof value.contents === 'string' ? value.contents : '';
    const author = typeof value.user === 'string' ? value.user : defaults.author;
    const createdAt =
      typeof value.creationDate === 'string' ? normaliseDate(value.creationDate) : new Date().toISOString();

    if (value.annotationType === EDITOR_HIGHLIGHT) {
      // A **free** highlight — the marker drawn over a scan — is a stroke, and its
      // `quadPoints` is `null`: `FreeHighlightOutline.serialize` hands over the
      // sampled runs (`outlines.points`) and the drawn path (`outlines.outline`).
      // Reading that path as quads is what turned every free highlight into a row of
      // disconnected boxes, so the strokes are taken
      // first and the outline is only decoded when no sampled run survives.
      const sampled = outlinePoints(value.outlines, top);
      const drawnStrokes = sampled.length > 0 ? sampled : [drawnPath(value.outlines, top)];
      const strokes = drawnStrokes.filter((stroke): stroke is number[] => stroke !== null);
      const strokeBox = boundsOfRuns(strokes);
      const fromSelection = quadsFromCorners(value.quadPoints, top);
      const quads =
        fromSelection.length > 0
          ? fromSelection
          : strokeBox !== null
            ? [strokeBox]
            : quadsFromCorners(outlineCorners(value.outlines), top);
      if (quads.length > 0 || strokes.length > 0) {
        marks.push({
          id: entry.id,
          kind: 'highlight',
          pageIndex,
          quads,
          ...(strokes.length === 0 ? {} : { strokes }),
          color: colour,
          opacity,
          contents,
          author,
          createdAt,
          ...(thickness === undefined ? {} : { thickness }),
        });
      }
      continue;
    }
    const paths = value.paths;
    const inkPoints =
      paths !== null && typeof paths === 'object' && 'points' in paths ? paths.points : value.inkLists;
    const strokes = strokesFromInkLists(inkPoints, top);
    const inkBox = boundsOfRuns(strokes);
    if (inkBox === null) continue;
    marks.push({
      id: entry.id,
      kind: 'ink',
      pageIndex,
      quads: [inkBox],
      strokes,
      color: colour,
      opacity,
      contents,
      author,
      createdAt,
      thickness: thickness ?? 2,
    });
  }
  return marks;
}

/**
 * A flat run of 8-number quads in PDF user space → top-left-origin boxes.
 *
 * This is what a *text-selection* highlight serialises to
 * (`HighlightEditor.serializeQuadPoints`): 8 numbers per quad, the first four the
 * upper edge (`x0, yTop, x1, yTop`) and the next four the lower edge
 * (`x0, yBottom`, `x1, yBottom`).
 *
 * A **free** highlight — the marker drawn over a scan — is *not* this shape: its
 * `quadPoints` is `null` and its `outlines` is a path plus the sampled runs
 * (`outlines.points`), which the takeover reads as strokes. Reading that path as
 * quads is the mistake that made every marker stroke come back as a row of
 * disconnected boxes, so the first four numbers being skipped here is about a
 * different record: the outliner emits `[null, null, null, null, …]` for a path,
 * and a path is refused by `isDrawnPath` before this function ever sees it.
 */
function quadsFromCorners(value: unknown, pageTop: number): readonly MarkBox[] {
  if (value instanceof Float32Array || value instanceof Float64Array) value = Array.from(value);
  if (!Array.isArray(value)) return [];
  // A drawn path is not a quad list. Its placeholder `NaN`s are dropped below, so
  // what is left looks like a run of coordinates and boxes up into the
  // disconnected rows the marker used to be drawn as — refuse it here, where the
  // two shapes are still tellable apart.
  if (isDrawnPath(value as number[])) return [];
  const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  const boxes: MarkBox[] = [];
  for (let index = 0; index + 7 < numbers.length; index += 8) {
    const x0 = numbers[index] ?? 0;
    const x1 = numbers[index + 2] ?? 0;
    const yTop = numbers[index + 1] ?? 0;
    const yBottom = numbers[index + 5] ?? 0;
    // User space grows upward; the model's boxes grow downward from the page top.
    boxes.push([
      Math.min(x0, x1),
      pageTop - Math.max(yTop, yBottom),
      Math.max(x0, x1),
      pageTop - Math.min(yTop, yBottom),
    ]);
  }
  return boxes;
}

/**
 * The *legacy* reading of a highlight's `outlines`: a flat run of 8-number quads.
 *
 * A text-selection highlight's `outlines` is an array of polygon runs rather than
 * a flat list, and a free highlight's is a path — neither reaches this, because
 * `quadPoints` or the sampled runs answer first. It stays for the shape an older
 * file or a hand-built entry can carry: `{ outline: [x0, yTop, x1, yTop, …] }`.
 */
function outlineCorners(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || !('outline' in value)) return null;
  return (value as { outline?: unknown }).outline ?? null;
}

/** A free highlight's sampled runs — `outlines.points`, one flat run per stroke. */
function outlinePoints(value: unknown, pageTop: number): readonly (readonly number[])[] {
  if (value === null || typeof value !== 'object' || !('points' in value)) return [];
  return strokesFromInkLists((value as { points?: unknown }).points, pageTop);
}

/**
 * Whether a run is the engine's **path** format rather than a list of coordinates.
 *
 * `FreeHighlightOutline.serialize` (`build/pdf.mjs`) writes a path as a moveto
 * group of four non-finite placeholders followed by the point (`[NaN, NaN, NaN,
 * NaN, x, y]`), then one six-number group per following point: `[NaN, NaN, NaN,
 * NaN, x, y]` for a straight run, `[c1x, c1y, c2x, c2y, x, y]` for a curve. A quad
 * list starts with finite ordinates, so the first four entries tell the two apart —
 * and reading the path as quads is exactly what used to turn a marker stroke into
 * a row of disconnected boxes.
 */
function isDrawnPath(run: readonly number[]): boolean {
  if (run.length < 6) return false;
  for (let index = 0; index < 4; index += 1) {
    if (Number.isFinite(run[index])) return false;
  }
  return true;
}

/**
 * The engine's path format → one top-left-origin polyline.
 *
 * The worker's own decoder is the specification (`writeLineToCurveToAppearance`,
 * `build/pdf.worker.mjs`): a moveto at indices 4 and 5, then one six-number group
 * per following point, where a group whose first entry is non-finite is a line to
 * `[i+4, i+5]` and anything else is a curve ending there. The control points are
 * dropped: the mark carries the samples the outliner took, and the difference
 * between the curve and its samples is below the width that paints it.
 */
function pathRun(value: unknown, pageTop: number): number[] | null {
  const run = asNumberListPreservingNaN(value);
  if (run === null || !isDrawnPath(run)) return null;
  const points: number[] = [run[4] ?? 0, pageTop - (run[5] ?? 0)];
  for (let index = 6; index + 5 < run.length; index += 6) {
    points.push(run[index + 4] ?? 0, pageTop - (run[index + 5] ?? 0));
  }
  return points.length >= 4 ? points : null;
}

/** The drawn path of a free highlight, whichever of the two shapes it arrived in. */
function drawnPath(value: unknown, pageTop: number): number[] | null {
  if (value === null || typeof value !== 'object') return null;
  const outline = 'outline' in value ? (value as { outline?: unknown }).outline : null;
  return outline === null ? null : pathRun(outline, pageTop);
}

/** `InkList` (one flat `[x, y, …]` run per stroke) → top-left-origin strokes. */
function strokesFromInkLists(value: unknown, pageTop: number): readonly (readonly number[])[] {
  if (!Array.isArray(value)) return [];
  const strokes: number[][] = [];
  for (const raw of value) {
    // The run itself is a `Float32Array` when it came from the engine's own editor
    // (`InkDrawOutline.serialize` → `Outline._rescale`, `build/pdf.mjs`) and a plain
    // array when it came from a file's `/InkList`; `asNumberList` reads both, and
    // `null` means this entry is not a run of finite numbers at all.
    const stroke = asNumberList(raw);
    if (stroke === null || stroke.length < 2 || stroke.length % 2 !== 0) continue;
    for (let index = 1; index < stroke.length; index += 2) {
      stroke[index] = pageTop - (stroke[index] ?? 0);
    }
    strokes.push(stroke);
  }
  return strokes;
}

/** pdf.js writes `D:YYYYMMDDHHmmSS…`; the model keeps ISO 8601. */
function normaliseDate(raw: string): string {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw.trim());
  if (match === null) return new Date().toISOString();
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month ?? '01'}-${day ?? '01'}T${hour ?? '00'}:${minute ?? '00'}:${second ?? '00'}.000Z`;
}

/** PDF `/Subtype` → the app's annotation vocabulary. */
export function kindForSubtype(subtype: string): AnnotationKind | null {
  switch (subtype.toLowerCase()) {
    case 'highlight':
      return 'highlight';
    case 'underline':
      return 'underline';
    case 'strikeout':
      return 'strikeout';
    case 'squiggly':
      return 'squiggly';
    case 'ink':
      return 'ink';
    case 'square':
    case 'circle':
    case 'line':
      return 'shapes';
    case 'text':
    case 'freetext':
      return 'note';
    default:
      return null;
  }
}

/** Localised name key for a mark kind, shared by the panel and the journal. */
export function annotationKindKey(kind: AnnotationKind): MessageKey {
  const KEYS: Record<AnnotationKind, MessageKey> = {
    highlight: 'ann.kind.highlight',
    underline: 'ann.kind.underline',
    strikeout: 'ann.kind.strikeout',
    squiggly: 'ann.kind.squiggly',
    ink: 'ann.kind.ink',
    shapes: 'ann.kind.shapes',
    note: 'ann.kind.note',
    freetext: 'ann.kind.freetext',
  };
  return KEYS[kind];
}
