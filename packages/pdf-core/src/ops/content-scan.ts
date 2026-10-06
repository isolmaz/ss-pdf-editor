/**
 * Marked content in a page's content stream: which painting operators sit inside which
 * `BDC … EMC` sequence, and where on the page they paint.
 *
 * ## Why this exists
 *
 * Two questions about a tagged file cannot be answered from the structure tree alone:
 *
 *   - *is every piece of real content tagged?* — a structure tree can be perfect and still
 *     leave half the page's text outside any marked-content sequence, which is the single
 *     most common reason a "tagged" file fails PDF/UA (Matterhorn checkpoint 01);
 *   - *where on the page is this structure element?* — the tree names MCIDs, the page
 *     draws them, and only the content stream says which glyphs and pictures a given MCID
 *     covers.
 *
 * `scanContent` answers both from one pass over the decoded operators, using the
 * tokenizer `accessibility.ts` already owns (strings, hex strings, arrays, dictionaries and
 * inline images are delimited, so no operand can be mistaken for an operator). It does
 * **not** modify anything: the writers that splice marked content (`structure.ts`) use the
 * instruction ranges it reports.
 *
 * ## What is a "painting" operator
 *
 * The operators that put ink on the page: the text-showing operators (`Tj`, `TJ`, `'`,
 * `"`) unless the text render mode is 7 (clip only), the path-painting operators (`S`, `s`,
 * `f`, `F`, `f*`, `B`, `B*`, `b`, `b*`), `sh`, `Do` and inline images. `n` ends a path
 * without painting it, and `W`/`W*` only set a clip, so neither counts — an invisible clip
 * is not content. Invisible text (render mode 3, the OCR layer) **does** count: it is read
 * aloud, so it has to be tagged like any other text.
 *
 * ## Limits
 *
 * Rects are bounding boxes of the *geometry the stream constructs*: a text operator has
 * only its origin here (advances would need the font's widths — the page's text model
 * supplies glyph boxes where those are wanted), a path has the box of its points, an image
 * the unit square under the CTM. A control point of a Bézier curve is counted as a point,
 * so a curved shape's box can be slightly larger than its ink.
 */

import {
  concatMatrix,
  IDENTITY,
  type Instruction,
  type Matrix,
  numbersOf,
  transformPoint,
} from './accessibility';

/** `[x0, y0, x1, y1]` in the page's user space, y up (the stream's own space). */
export type UserRect = readonly [number, number, number, number];

export type PaintKind = 'text' | 'path' | 'image' | 'form' | 'shading' | 'inline-image';

/** One marked-content sequence. */
export interface ContentSpan {
  readonly id: number;
  /** The tag (`P`, `Span`, `Artifact`, `OC`, …), without the slash. */
  readonly tag: string;
  /** The `/MCID` of its property list, when it has one. */
  readonly mcid: number | null;
  /** The enclosing span, `-1` at the top level. */
  readonly parent: number;
  /** Instruction index of the `BDC`/`BMC`. */
  readonly open: number;
  /** Instruction index of the matching `EMC`; `-1` when the stream never closes it. */
  readonly close: number;
}

/** One painting operator. */
export interface PaintOp {
  /** Instruction index. */
  readonly index: number;
  readonly kind: PaintKind;
  /** The innermost span the operator sits in, `-1` at the top level. */
  readonly span: number;
  /** The `Do` operand, for `image` and `form`. */
  readonly name: string | null;
  /** Text origin through the text matrix and the CTM (user space), for `text`. */
  readonly origin: { readonly x: number; readonly y: number } | null;
  /** The size in force (`Tf`), `0` when the stream never set one. */
  readonly fontSize: number;
  /** The painted box, or `null` when this scanner cannot bound it (`sh`, text). */
  readonly bbox: UserRect | null;
}

export interface ContentMarks {
  readonly spans: readonly ContentSpan[];
  readonly paints: readonly PaintOp[];
  /** An `EMC` with no open sequence, or a sequence still open at the end of the stream. */
  readonly unbalanced: boolean;
  /** The resource names of every font a `Tf` selects in this stream. */
  readonly fonts: ReadonlySet<string>;
}

/** What `Do` names, as the consumer knows it from the resource dictionary. */
export interface XObjectInfo {
  readonly kind: 'image' | 'form' | 'other';
  /** A form's `/BBox` and `/Matrix`, for its painted box. */
  readonly bbox?: UserRect;
  readonly matrix?: Matrix;
}

export interface ContentHooks {
  /** `/Properties` lookup for the `BDC /Tag /Name` form: the property list's `/MCID`. */
  readonly properties?: (name: string) => number | null;
  readonly xobject?: (name: string) => XObjectInfo | null;
}

export const PATH_CONSTRUCTION = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
export const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

/** `(…)` blanked out so a `/MCID` spelled inside an `/ActualText` string is not read. */
function withoutStrings(text: string): string {
  let out = '';
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (depth > 0) {
      if (char === '\\') index += 1;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      continue;
    }
    if (char === '(') {
      depth = 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** The `/MCID` an inline property dictionary carries (`<</MCID 3>>`), or `null`. */
export function mcidOfInstruction(bytes: Uint8Array, instruction: Instruction): number | null {
  let text = '';
  for (let index = instruction.start; index < instruction.end; index += 1) {
    text += String.fromCharCode(bytes[index] as number);
  }
  const match = /\/MCID\s+(\d+)/.exec(withoutStrings(text));
  return match === null ? null : Number(match[1]);
}

function boxOf(points: readonly (readonly [number, number])[]): UserRect | null {
  if (points.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1)
    ? [x0, y0, x1, y1]
    : null;
}

function mapRect(matrix: Matrix, rect: UserRect): UserRect | null {
  const [x0, y0, x1, y1] = rect;
  const corners = [
    transformPoint(matrix, x0, y0),
    transformPoint(matrix, x1, y0),
    transformPoint(matrix, x1, y1),
    transformPoint(matrix, x0, y1),
  ];
  return boxOf(corners.map((corner) => [corner.x, corner.y] as const));
}

/**
 * Scan decoded content-stream instructions for marked content and painting operators.
 * The graphics state is followed far enough to place each operator: `q`/`Q`, `cm`, the
 * text matrices and the path under construction.
 */
export function scanContent(
  bytes: Uint8Array,
  instructions: readonly Instruction[],
  hooks: ContentHooks = {},
): ContentMarks {
  const spans: ContentSpan[] = [];
  const paints: PaintOp[] = [];
  const fonts = new Set<string>();
  const open: number[] = [];
  let unbalanced = false;

  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  let fontSize = 0;
  let renderMode = 0;
  let path: (readonly [number, number])[] = [];

  const current = (): number => open[open.length - 1] ?? -1;
  const addPoint = (x: number, y: number): void => {
    const point = transformPoint(ctm, x, y);
    path.push([point.x, point.y]);
  };

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index] as Instruction;
    switch (instruction.operator) {
      case 'BMC':
      case 'BDC': {
        const tagOperand = instruction.operands[0];
        const tag = tagOperand?.kind === 'name' ? tagOperand.name : '';
        let mcid: number | null = null;
        if (instruction.operator === 'BDC') {
          const props = instruction.operands[1];
          if (props?.kind === 'name') mcid = hooks.properties?.(props.name) ?? null;
          else mcid = mcidOfInstruction(bytes, instruction);
        }
        const id = spans.length;
        spans.push({ id, tag, mcid, parent: current(), open: index, close: -1 });
        open.push(id);
        break;
      }
      case 'EMC': {
        const id = open.pop();
        if (id === undefined) {
          unbalanced = true;
          break;
        }
        const span = spans[id] as ContentSpan;
        spans[id] = { ...span, close: index };
        break;
      }
      case 'q':
        stack.push(ctm);
        break;
      case 'Q': {
        const saved = stack.pop();
        if (saved !== undefined) ctm = saved;
        break;
      }
      case 'cm': {
        const values = numbersOf(instruction, 6);
        if (values !== null) {
          ctm = concatMatrix(
            [
              values[0] as number,
              values[1] as number,
              values[2] as number,
              values[3] as number,
              values[4] as number,
              values[5] as number,
            ],
            ctm,
          );
        }
        break;
      }
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf': {
        const name = instruction.operands[0];
        if (name !== undefined && name.kind === 'name') fonts.add(name.name);
        const size = instruction.operands[1];
        if (size !== undefined && size.kind === 'number') fontSize = size.number;
        break;
      }
      case 'Tr': {
        const mode = instruction.operands[0];
        if (mode !== undefined && mode.kind === 'number') renderMode = mode.number;
        break;
      }
      case 'TL': {
        const value = instruction.operands[0];
        if (value !== undefined && value.kind === 'number') leading = value.number;
        break;
      }
      case 'TD':
      case 'Td': {
        const values = numbersOf(instruction, 2);
        if (values === null) break;
        if (instruction.operator === 'TD') leading = -(values[1] as number);
        tlm = concatMatrix([1, 0, 0, 1, values[0] as number, values[1] as number], tlm);
        tm = tlm;
        break;
      }
      case 'Tm': {
        const values = numbersOf(instruction, 6);
        if (values !== null) {
          tm = [
            values[0] as number,
            values[1] as number,
            values[2] as number,
            values[3] as number,
            values[4] as number,
            values[5] as number,
          ];
          tlm = tm;
        }
        break;
      }
      case 'T*':
      case "'":
      case '"':
      case 'Tj':
      case 'TJ': {
        if (instruction.operator === 'T*' || instruction.operator === "'" || instruction.operator === '"') {
          tlm = concatMatrix([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
        }
        if (instruction.operator === 'T*' || renderMode === 7) break;
        const point = transformPoint(concatMatrix(tm, ctm), 0, 0);
        paints.push({
          index,
          kind: 'text',
          span: current(),
          name: null,
          origin: { x: point.x, y: point.y },
          fontSize,
          bbox: null,
        });
        break;
      }
      case 'm':
      case 'l': {
        const values = numbersOf(instruction, 2);
        if (values !== null) addPoint(values[0] as number, values[1] as number);
        break;
      }
      case 'c': {
        const values = numbersOf(instruction, 6);
        if (values !== null) {
          addPoint(values[0] as number, values[1] as number);
          addPoint(values[2] as number, values[3] as number);
          addPoint(values[4] as number, values[5] as number);
        }
        break;
      }
      case 'v':
      case 'y': {
        const values = numbersOf(instruction, 4);
        if (values !== null) {
          addPoint(values[0] as number, values[1] as number);
          addPoint(values[2] as number, values[3] as number);
        }
        break;
      }
      case 're': {
        const values = numbersOf(instruction, 4);
        if (values !== null) {
          const [x, y, w, h] = values as [number, number, number, number];
          addPoint(x, y);
          addPoint(x + w, y);
          addPoint(x + w, y + h);
          addPoint(x, y + h);
        }
        break;
      }
      case 'n':
        path = [];
        break;
      case 'sh':
        paints.push({
          index,
          kind: 'shading',
          span: current(),
          name: null,
          origin: null,
          fontSize,
          bbox: null,
        });
        break;
      case 'BI': {
        paints.push({
          index,
          kind: 'inline-image',
          span: current(),
          name: null,
          origin: null,
          fontSize,
          bbox: mapRect(ctm, [0, 0, 1, 1]),
        });
        break;
      }
      case 'Do': {
        const operand = instruction.operands[0];
        if (operand === undefined || operand.kind !== 'name') break;
        const info = hooks.xobject?.(operand.name) ?? null;
        if (info?.kind === 'other') break;
        const isForm = info?.kind === 'form';
        let bbox: UserRect | null = null;
        if (isForm) {
          if (info.bbox !== undefined) {
            bbox = mapRect(concatMatrix(info.matrix ?? IDENTITY, ctm), info.bbox);
          }
        } else {
          bbox = mapRect(ctm, [0, 0, 1, 1]);
        }
        paints.push({
          index,
          kind: isForm ? 'form' : 'image',
          span: current(),
          name: operand.name,
          origin: null,
          fontSize,
          bbox,
        });
        break;
      }
      default:
        if (PATH_PAINT.has(instruction.operator)) {
          paints.push({
            index,
            kind: 'path',
            span: current(),
            name: null,
            origin: null,
            fontSize,
            bbox: boxOf(path),
          });
          path = [];
        }
        break;
    }
  }
  if (open.length > 0) unbalanced = true;
  return { spans, paints, unbalanced, fonts };
}

/** The spans enclosing `span`, innermost first (the span itself included). */
export function enclosing(marks: ContentMarks, span: number): readonly ContentSpan[] {
  const chain: ContentSpan[] = [];
  let cursor = span;
  while (cursor >= 0) {
    const entry = marks.spans[cursor];
    if (entry === undefined) break;
    chain.push(entry);
    cursor = entry.parent;
  }
  return chain;
}

/**
 * How a painting operator is marked: inside a sequence with an `/MCID` (`tagged`), inside
 * an `/Artifact` (`artifact`), both at once (`conflict` — Matterhorn 01-002/01-003), or
 * neither (`unmarked`, which is real content outside the structure tree). Wrapper
 * sequences without either — `/OC` optional content, `/Span` with only an `/ActualText` —
 * are transparent: content inside them is as unmarked as content outside.
 */
export function coverageOf(
  marks: ContentMarks,
  op: PaintOp,
): 'tagged' | 'artifact' | 'conflict' | 'unmarked' {
  let tagged = false;
  let artifact = false;
  for (const span of enclosing(marks, op.span)) {
    if (span.mcid !== null) tagged = true;
    if (span.tag === 'Artifact') artifact = true;
  }
  if (tagged && artifact) return 'conflict';
  if (tagged) return 'tagged';
  if (artifact) return 'artifact';
  return 'unmarked';
}

/** The innermost `/MCID` an operator sits in, or `null`. */
export function mcidOf(marks: ContentMarks, op: PaintOp): number | null {
  for (const span of enclosing(marks, op.span)) {
    if (span.mcid !== null) return span.mcid;
  }
  return null;
}
