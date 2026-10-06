/**
 * XFDF: comments as XML (ISO 19444-1), the format review tools exchange — Acrobat's
 * “Export comments to data file”, Foxit, PDF-XChange, Okular and pdf.js-based tools all
 * read and write it.
 *
 * ## Export
 *
 * One file carries the whole review: the annotations **the file already has**
 * (`readAnnotations`) and the marks **the session holds** but has not written yet, each
 * with its replies and review states. Every element names its annotation (`name`), and
 * a reply or a state names the one it answers (`inreplyto`), so a thread comes back as a
 * thread. Coordinates are PDF user space, as the format requires: the session's marks
 * are turned through their page's top edge on the way out.
 *
 * Written: `highlight`, `underline`, `strikeout`, `squiggly` (with `coords`), `ink`
 * (`inklist`/`gesture`), `square`, `circle`, `line` (`start`/`end`), `text` and
 * `freetext`. A note this app makes is a sticky note (`text`); its typed text is a
 * `freetext`. An annotation of another kind (a stamp, a link, a form widget) is not a
 * comment the format can carry faithfully and is counted instead.
 *
 * ## Import
 *
 * The same elements come back as session marks — in PDF user space, so the importer
 * turns them through each page's top edge (`toAppSpace`) — and a reply or a review
 * state is attached to the mark its `inreplyto` chain ends at. A record whose comment is
 * not in the file is counted as skipped, as is a `Marked` state (a private check mark
 * this model does not hold), never dropped in silence.
 *
 * ## What does not travel
 *
 * Appearance streams (`appearance`), rich text styling (`contents-richtext` is read as
 * plain text) and a mark's quarter turn: a rotated session mark is exported with the
 * geometry it was drawn with.
 */

import { ToolError } from 'pdf-shared';
import type { AnnotationDataResult } from './annotation-data';
import { isoFromAcrobatDate } from './annotation-data';
import { commentThreads } from './annotation-threads';
import {
  type AnnotationKind,
  type AnnotationMark,
  boxesOf,
  type CommentReply,
  type CommentReview,
  type ExistingAnnotation,
  type MarkBox,
  markQuadPoints,
  markRect,
  REVIEW_STATES,
  type ReviewState,
} from './annotations';

const XFDF_NAMESPACE = 'http://ns.adobe.com/xfdf/';

/** Text-markup kinds and their XFDF element names. */
const MARKUP_ELEMENTS: Partial<Record<AnnotationKind, string>> = {
  highlight: 'highlight',
  underline: 'underline',
  strikeout: 'strikeout',
  squiggly: 'squiggly',
};

/** File `/Subtype`s the export writes, and the element each becomes. */
const SUBTYPE_ELEMENTS: Readonly<Record<string, string>> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'squiggly',
  Ink: 'ink',
  Square: 'square',
  Circle: 'circle',
  Line: 'line',
  Text: 'text',
  FreeText: 'freetext',
};

export interface XfdfExportInput {
  /** Session marks, in the app's page space (top-left origin). */
  readonly marks: readonly AnnotationMark[];
  /** The file's own annotations, in PDF user space, as `readAnnotations` reports them. */
  readonly existing: readonly ExistingAnnotation[];
  /** A page's top edge (`viewBox[3]`), or `null` when the page cannot be measured. */
  readonly pageTop: (pageIndex: number) => number | null;
  /** The PDF the comments belong to, written as `<f href>`. */
  readonly fileName?: string;
}

export interface XfdfExport {
  readonly bytes: Uint8Array;
  /** Comments written (replies and states not counted). */
  readonly count: number;
  /**
   * Annotations that are not comments the format can carry (stamps, links, widgets…). A
   * comment's popup is part of the comment and is not counted.
   */
  readonly skipped: number;
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // XML 1.0 cannot carry most control characters at all, escaped or not.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  );
}

function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** `D:YYYYMMDDHHmmSSZ` from ISO 8601 — the form XFDF dates take. */
function xfdfDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
    date.getUTCHours(),
  )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** A pdf.js date (`D:…`) passed through, or written from ISO 8601. */
function fileDate(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '';
  return raw.startsWith('D:') ? raw : xfdfDate(raw);
}

interface ElementSpec {
  readonly element: string;
  readonly attributes: Record<string, string | undefined>;
  readonly contents: string;
  /** Inner XML other than `<contents>` (ink gestures), already escaped. */
  readonly inner?: string;
}

function render(spec: ElementSpec): string {
  const attributes = Object.entries(spec.attributes)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('');
  const body = `${spec.inner ?? ''}${spec.contents === '' ? '' : `<contents>${escapeXml(spec.contents)}</contents>`}`;
  return body === ''
    ? `<${spec.element}${attributes}/>`
    : `<${spec.element}${attributes}>${body}</${spec.element}>`;
}

function rectText(rect: readonly number[]): string {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = rect;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)].map(num).join(',');
}

function gestures(strokes: readonly (readonly number[])[]): string {
  const runs = strokes.map((stroke) => {
    const points: string[] = [];
    for (let index = 0; index + 1 < stroke.length; index += 2) {
      points.push(`${num(stroke[index] ?? 0)},${num(stroke[index + 1] ?? 0)}`);
    }
    return `<gesture>${points.join(';')}</gesture>`;
  });
  return `<inklist>${runs.join('')}</inklist>`;
}

/** Replies and a review state as `text` elements answering `parent`. */
function threadElements(
  parent: string,
  page: number,
  rect: string,
  replies: readonly CommentReply[],
  review: CommentReview | undefined,
): string[] {
  const out = replies.map((reply) =>
    render({
      element: 'text',
      attributes: {
        page: String(page),
        rect,
        name: reply.id,
        inreplyto: parent,
        title: reply.author,
        date: xfdfDate(reply.createdAt),
        creationdate: xfdfDate(reply.createdAt),
        flags: 'print,nozoom,norotate',
        icon: 'Comment',
      },
      contents: reply.contents,
    }),
  );
  if (review !== undefined && review.state !== 'None') {
    out.push(
      render({
        element: 'text',
        attributes: {
          page: String(page),
          rect,
          name: `${parent}-state`,
          inreplyto: parent,
          title: review.author,
          date: xfdfDate(review.at),
          creationdate: xfdfDate(review.at),
          flags: 'hidden,print,nozoom,norotate',
          icon: 'Comment',
          state: review.state,
          statemodel: 'Review',
        },
        contents: `${review.state} set by ${review.author}`,
      }),
    );
  }
  return out;
}

/** One session mark (app space) as XFDF elements, or `null` when its page cannot be measured. */
function markElements(mark: AnnotationMark, pageTop: number): string[] {
  const rect = markRect(mark, pageTop);
  const common = {
    page: String(mark.pageIndex),
    rect: rectText(rect),
    name: mark.id,
    title: mark.author,
    date: xfdfDate(mark.createdAt),
    creationdate: xfdfDate(mark.createdAt),
    color: mark.color.toUpperCase(),
    opacity: num(mark.opacity),
    flags: 'print',
  };
  let element: ElementSpec;
  const markup = MARKUP_ELEMENTS[mark.kind];
  if (markup !== undefined && (mark.strokes?.length ?? 0) === 0) {
    element = {
      element: markup,
      attributes: { ...common, coords: markQuadPoints(mark, pageTop).map(num).join(',') },
      contents: mark.contents,
    };
  } else if (mark.kind === 'ink' || mark.kind === 'highlight') {
    // A marker stroke is a highlight drawn as a path: XFDF's nearest is ink.
    const strokes = (mark.strokes ?? []).map((stroke) =>
      stroke.map((value, index) => (index % 2 === 1 ? pageTop - value : value)),
    );
    element = {
      element: 'ink',
      attributes: { ...common, width: num(mark.thickness ?? 2) },
      contents: mark.contents,
      inner: gestures(strokes),
    };
  } else if (mark.kind === 'shapes') {
    const box = boxesOf(mark)[0] as MarkBox;
    const width = num(mark.thickness ?? 2);
    element =
      mark.shape === 'line'
        ? {
            element: 'line',
            attributes: {
              ...common,
              width,
              start: `${num(box[0])},${num(pageTop - box[1])}`,
              end: `${num(box[2])},${num(pageTop - box[3])}`,
            },
            contents: mark.contents,
          }
        : {
            element: mark.shape === 'circle' ? 'circle' : 'square',
            attributes: { ...common, width },
            contents: mark.contents,
          };
  } else if (mark.kind === 'freetext') {
    const size = num(mark.fontSize ?? 12);
    element = {
      element: 'freetext',
      attributes: { ...common, color: undefined },
      contents: mark.contents,
      inner: `<defaultappearance>/Helv ${size} Tf ${colourOperands(mark.color)} rg</defaultappearance>`,
    };
  } else {
    element = { element: 'text', attributes: { ...common, icon: 'Comment' }, contents: mark.contents };
  }
  return [
    render(element),
    ...threadElements(mark.id, mark.pageIndex, common.rect, mark.replies ?? [], mark.review),
  ];
}

function colourOperands(hex: string): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(value)) return '0 0 0';
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
    .map((channel) => num(channel / 255))
    .join(' ');
}

/** One annotation of the file as an XFDF element, or `null` when the format cannot carry it. */
function existingElement(annotation: ExistingAnnotation, parentName: string | undefined): string | null {
  const element = SUBTYPE_ELEMENTS[annotation.subtype];
  if (element === undefined || annotation.rect === null) return null;
  const attributes: Record<string, string | undefined> = {
    page: String(annotation.pageIndex),
    rect: rectText(annotation.rect),
    name: annotation.id,
    title: annotation.author,
    date: fileDate(annotation.modified),
    creationdate: fileDate(annotation.created),
    color: annotation.color?.toUpperCase(),
    opacity: annotation.opacity === undefined ? undefined : num(annotation.opacity),
    width: annotation.thickness === undefined ? undefined : num(annotation.thickness),
    inreplyto: parentName,
    state: annotation.state,
    statemodel: annotation.state === undefined ? undefined : (annotation.stateModel ?? 'Review'),
  };
  if (parentName !== undefined) {
    attributes.flags =
      annotation.state === undefined ? 'print,nozoom,norotate' : 'hidden,print,nozoom,norotate';
  }
  let inner: string | undefined;
  if (annotation.quadPoints !== undefined && element !== 'text' && element !== 'freetext') {
    attributes.coords = annotation.quadPoints.map(num).join(',');
  }
  if (element === 'ink') inner = gestures(annotation.inkLists ?? []);
  if (element === 'line') {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = annotation.vertices ?? [];
    attributes.start = `${num(x1)},${num(y1)}`;
    attributes.end = `${num(x2)},${num(y2)}`;
  }
  if (element === 'text') attributes.icon = 'Comment';
  return render({
    element,
    attributes,
    contents: annotation.contents,
    ...(inner === undefined ? {} : { inner }),
  });
}

/**
 * The review as XFDF: the file's comments (with their threads) first, then the
 * session's marks (with theirs). Widgets, links and stamps are not comments XFDF can
 * carry here and are counted in `skipped`; a popup is part of its comment, not counted.
 */
export function serializeXfdf(input: XfdfExportInput): XfdfExport {
  const parts: string[] = [];
  let count = 0;
  let skipped = 0;
  const { records } = commentThreads(input.existing);
  for (const annotation of input.existing) {
    if (annotation.subtype === 'Popup') continue;
    if (annotation.subtype === 'Widget' || annotation.subtype === 'Link') {
      skipped += 1;
      continue;
    }
    const parent = records.has(annotation.id) ? annotation.inReplyTo : undefined;
    const element = existingElement(annotation, parent);
    if (element === null) {
      skipped += 1;
      continue;
    }
    parts.push(element);
    if (parent === undefined) count += 1;
  }
  for (const mark of input.marks) {
    const top = input.pageTop(mark.pageIndex);
    if (top === null) {
      skipped += 1;
      continue;
    }
    parts.push(...markElements(mark, top));
    count += 1;
  }
  const file = input.fileName === undefined ? '' : `<f href="${escapeXml(input.fileName)}"/>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="${XFDF_NAMESPACE}" xml:space="preserve"><annots>${parts.join(
    '\n',
  )}</annots>${file}</xfdf>\n`;
  return { bytes: new TextEncoder().encode(xml), count, skipped };
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** XFDF element names this model holds, and the mark kind each becomes. */
const ELEMENT_KINDS: Readonly<
  Record<string, { readonly kind: AnnotationKind; readonly shape?: 'square' | 'circle' | 'line' }>
> = {
  highlight: { kind: 'highlight' },
  underline: { kind: 'underline' },
  strikeout: { kind: 'strikeout' },
  squiggly: { kind: 'squiggly' },
  ink: { kind: 'ink' },
  square: { kind: 'shapes', shape: 'square' },
  circle: { kind: 'shapes', shape: 'circle' },
  line: { kind: 'shapes', shape: 'line' },
  text: { kind: 'note' },
  freetext: { kind: 'freetext' },
};

/** Whether bytes look like XFDF: an XML document whose root is `xfdf`. */
export function isXfdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 512)).replace(/^\uFEFF/, '');
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<xfdf[\s>]/.test(head);
}

interface Parser {
  parseFromString(text: string, type: string): Document;
}

/** The browser's own parser; the XML package only where there is none (Node). */
async function xmlParser(onError: (message: string) => void): Promise<Parser> {
  if (typeof globalThis.DOMParser === 'function') return new globalThis.DOMParser();
  const { DOMParser } = await import('@xmldom/xmldom');
  return new DOMParser({
    // xmldom 0.8 reads `errorHandler` (an `onError` key is ignored) and reports a
    // mismatched or unclosed tag only as a warning; the browser's parser refuses such a
    // file, so every level fails here too.
    errorHandler: (_level: string, message: string) => onError(message),
  } as never) as unknown as Parser;
}

function numbers(value: string | null): number[] {
  if (value === null) return [];
  return value
    .split(/[\s,;]+/)
    .map((part) => Number.parseFloat(part))
    .filter((part) => Number.isFinite(part));
}

/** `#RRGGBB` (any case) → `#rrggbb`; anything else → `fallback`. */
function hexColour(value: string | null, fallback: string): string {
  return value !== null && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

/**
 * An attribute, or `null` when the element does not have it. Some DOM implementations
 * (the XML package used outside a browser) answer `''` for a missing attribute, and an
 * empty `inreplyto` is not a reply.
 */
function attr(element: Element, name: string): string | null {
  return element.hasAttribute(name) ? element.getAttribute(name) : null;
}

function childElements(parent: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as Element).localName === name) out.push(node as Element);
  }
  return out;
}

/** `<contents>`, or the plain text of `<contents-richtext>`, or the `contents` attribute. */
function contentsOf(element: Element): string {
  const plain = childElements(element, 'contents')[0];
  if (plain !== undefined) return plain.textContent ?? '';
  const rich = childElements(element, 'contents-richtext')[0];
  if (rich !== undefined) return (rich.textContent ?? '').trim();
  return attr(element, 'contents') ?? '';
}

function isoDate(value: string | null): string {
  return value === null || value === '' ? new Date().toISOString() : isoFromAcrobatDate(value);
}

/** One XFDF element read as a mark in PDF user space, or `null` when it is not usable. */
function markFromElement(element: Element, kind: (typeof ELEMENT_KINDS)[string]): AnnotationMark | null {
  const rect = numbers(attr(element, 'rect'));
  if (rect.length < 4) return null;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = rect;
  const box: MarkBox = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  const page = Number.parseInt(attr(element, 'page') ?? '', 10);
  const contents = contentsOf(element);
  const created = attr(element, 'creationdate') ?? attr(element, 'date');
  const width = numbers(attr(element, 'width'))[0];
  const opacity = numbers(attr(element, 'opacity'))[0];
  const base = {
    id: attr(element, 'name') || crypto.randomUUID(),
    kind: kind.kind,
    pageIndex: Number.isFinite(page) && page >= 0 ? page : 0,
    color: hexColour(attr(element, 'color'), kind.kind === 'highlight' ? '#ffd400' : '#e5484d'),
    opacity: opacity === undefined ? 1 : Math.min(Math.max(opacity, 0.02), 1),
    contents,
    author: attr(element, 'title') ?? '',
    createdAt: isoDate(created),
    ...(width === undefined ? {} : { thickness: width }),
  };
  switch (kind.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const coords = numbers(attr(element, 'coords'));
      const quads: MarkBox[] = [];
      for (let at = 0; at + 7 < coords.length; at += 8) {
        const xs = [coords[at], coords[at + 2], coords[at + 4], coords[at + 6]] as number[];
        const ys = [coords[at + 1], coords[at + 3], coords[at + 5], coords[at + 7]] as number[];
        quads.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
      return { ...base, quads: quads.length > 0 ? quads : [box] };
    }
    case 'ink': {
      const list = childElements(element, 'inklist')[0];
      const strokes = (list === undefined ? [] : childElements(list, 'gesture'))
        .map((gesture) => numbers(gesture.textContent))
        .filter((stroke) => stroke.length >= 4 && stroke.length % 2 === 0);
      if (strokes.length === 0) return null;
      return { ...base, quads: [box], strokes, thickness: width ?? 2 };
    }
    case 'shapes': {
      if (kind.shape === 'line') {
        const start = numbers(attr(element, 'start'));
        const end = numbers(attr(element, 'end'));
        if (start.length < 2 || end.length < 2) return null;
        const ends: MarkBox = [start[0] ?? 0, start[1] ?? 0, end[0] ?? 0, end[1] ?? 0];
        return { ...base, quads: [box], shape: 'line', rect: ends };
      }
      return { ...base, quads: [box], shape: kind.shape ?? 'square', rect: box };
    }
    case 'freetext': {
      const appearance = childElements(element, 'defaultappearance')[0]?.textContent ?? '';
      const size = /([\d.]+)\s+Tf/.exec(appearance);
      const ink = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(appearance);
      const colour =
        ink === null
          ? '#000000'
          : `#${[ink[1], ink[2], ink[3]]
              .map((part) =>
                Math.max(0, Math.min(255, Math.round(Number(part) * 255)))
                  .toString(16)
                  .padStart(2, '0'),
              )
              .join('')}`;
      if (contents.trim() === '') return null;
      return {
        ...base,
        color: colour,
        quads: [],
        rect: box,
        ...(size === null ? {} : { fontSize: Number(size[1]) }),
      };
    }
    default:
      return { ...base, quads: [], rect: box };
  }
}

/**
 * XFDF → session marks in PDF user space, each with the replies and the review state
 * that answer it. Every mark and reply gets a fresh id.
 */
export async function parseXfdf(bytes: Uint8Array): Promise<AnnotationDataResult> {
  const source = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  let failure: string | null = null;
  const parser = await xmlParser((message) => {
    failure = message;
  });
  const document = parser.parseFromString(source, 'application/xml');
  const root = document.documentElement;
  const parseError = document.getElementsByTagName('parsererror').length > 0;
  if (failure !== null || parseError || root === null || root.localName !== 'xfdf') {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: failure ?? 'not an XFDF document',
    });
  }
  const annots = childElements(root, 'annots')[0];
  const elements: Element[] = [];
  if (annots !== undefined) {
    for (let node = annots.firstChild; node !== null; node = node.nextSibling) {
      if (node.nodeType === 1) elements.push(node as Element);
    }
  }

  const marks = new Map<string, AnnotationMark>();
  const order: string[] = [];
  const answers: Element[] = [];
  let skipped = 0;
  let pageUnknown = 0;
  for (const element of elements) {
    if (attr(element, 'inreplyto') !== null && attr(element, 'replyType') !== 'group') {
      answers.push(element);
      continue;
    }
    const kind = ELEMENT_KINDS[element.localName];
    const mark = kind === undefined ? null : markFromElement(element, kind);
    if (mark === null || marks.has(mark.id)) {
      skipped += 1;
      continue;
    }
    if (attr(element, 'page') === null) pageUnknown += 1;
    marks.set(mark.id, mark);
    order.push(mark.id);
  }

  // A reply may answer a reply: each record is attached to the comment its chain ends at.
  const parentOf = new Map<string, string>();
  for (const element of answers) {
    const name = attr(element, 'name');
    const parent = attr(element, 'inreplyto');
    if (name !== null && parent !== null) parentOf.set(name, parent);
  }
  const rootOf = (start: string): string | null => {
    let current: string | undefined = start;
    const seen = new Set<string>();
    while (current !== undefined && !marks.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentOf.get(current);
    }
    return current !== undefined && marks.has(current) ? current : null;
  };
  const replies = new Map<string, CommentReply[]>();
  const reviews = new Map<string, CommentReview>();
  for (const element of answers) {
    const root = rootOf(attr(element, 'inreplyto') ?? '');
    const state = attr(element, 'state');
    const model = attr(element, 'statemodel') ?? 'Review';
    if (root === null || (state !== null && model !== 'Review')) {
      skipped += 1;
      continue;
    }
    const author = attr(element, 'title') ?? '';
    const at = isoDate(attr(element, 'date') ?? attr(element, 'creationdate'));
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
    const contents = contentsOf(element);
    if (contents.trim() === '') {
      skipped += 1;
      continue;
    }
    const list = replies.get(root) ?? [];
    list.push({ id: crypto.randomUUID(), author, contents, createdAt: at });
    replies.set(root, list);
  }

  // The file's names only link a thread together. The marks get ids of their own: an
  // import is a new review, and a name like `5R` is the object number of an annotation
  // in some file — possibly the one on screen, whose own comment already has that id.
  const result: AnnotationMark[] = order.map((id) => {
    const mark = marks.get(id) as AnnotationMark;
    const thread = (replies.get(id) ?? []).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const review = reviews.get(id);
    return {
      ...mark,
      id: crypto.randomUUID(),
      ...(thread.length === 0 ? {} : { replies: thread }),
      ...(review === undefined ? {} : { review }),
    };
  });
  return { marks: result, skipped, pageCount: null, pageUnknown, space: 'pdf-user' };
}
