/**
 * Form v2 (`PLAN.md §5/Phase 3`, §6 A11): field inventory, filling, validation,
 * locking, **creation**, flattening and simple calculation fields.
 *
 * MuPDF's object model carries every write here (`engines/mupdf-write.ts`); the field
 * tree is walked by this file, not by an engine facade. Three rules shape the code:
 *
 *  - **The field tree is read the way the format defines it.** A terminal field is a
 *    dictionary with a `/T` whose kids (if any) are widgets; `/FT`, `/Ff`, `/V`, `/DA`,
 *    `/Q` and `/MaxLen` are inherited through `/Parent`; a field's page is its widget's
 *    `/P`, matched by object number (and, without `/P`, by the page whose `/Annots`
 *    holds the widget).
 *  - **Every appearance this file writes is drawn with the embedded Noto Sans**
 *    (`embedNotoSans`), registered in `/AcroForm /DR` as `/NotoForm` and named in the
 *    field's `/DA`: Turkish needs `ş ğ ı İ`, which the WinAnsi Helvetica most forms
 *    name cannot encode. MuPDF's own appearance synthesis was measured and not used: it
 *    embeds a Nimbus face but places the baseline outside the widget box, so the value
 *    it draws is clipped away.
 *  - **A value and its appearance are two different writes.** Setting the value is
 *    what a reader reads; the appearance is what it draws. A checkbox or radio button
 *    keeps the on/off appearances its producer drew when they exist — only the state
 *    moves; text and choice fields are redrawn, because their drawn value changed.
 *
 * `readFormFields` and `exportFormData` are pure reads: they never rewrite the
 * document, so listing a form cannot end the incremental fast path.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  addPageResource,
  annotsOf,
  appendPageContent,
  arrayIn,
  dictionaryIn,
  type EmbeddedFace,
  embedNotoSans,
  pdfNumber as num,
  openForWrite,
  pageObjects,
  text as pdfText,
  readName,
  readNumbers,
  readText,
  resolved,
  saveRewrite,
  type WritableDocument,
} from '../engines/mupdf-write';
import { type FormDataRecord, parseFdf, parseFormJson, serializeFdf, serializeFormJson } from './form-data';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

export type FormFieldKind =
  | 'text'
  | 'checkbox'
  | 'dropdown'
  | 'radio'
  | 'optionlist'
  | 'button'
  | 'signature'
  | 'unknown';

export interface FormFieldInfo {
  /** Fully qualified name (dotted path for a child field). */
  readonly name: string;
  readonly kind: FormFieldKind;
  readonly value: string | readonly string[] | boolean | null;
  readonly readOnly: boolean;
  readonly required: boolean;
  readonly maxLength: number | null;
  /** Choice options, or the radio group's options; `null` for other kinds. */
  readonly options: readonly string[] | null;
  /** 0-based page of the field's first widget, `null` when it cannot be resolved. */
  readonly pageIndex: number | null;
}

/**
 * A field's value as one line of text: the panel renders it, and the app compares it
 * against an incoming write so a fill that would repeat the document's own value is not
 * written at all (`App.tsx` `fillField`, `WORKLOG.md §4`).
 *
 * `Array.isArray` does not narrow a `readonly string[]` union member, so the array case is
 * reached by elimination.
 */
export function fieldValueText(value: FormFieldInfo['value']): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? '✓' : '';
  return typeof value === 'string' ? value : value.join(', ');
}

export interface FormFill {
  readonly name: string;
  readonly value: string | readonly string[] | boolean;
}

export interface FieldCreation {
  readonly kind: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'optionlist';
  readonly name: string;
  /** 0-based page. */
  readonly pageIndex: number;
  /** `x, y, width, height` in PDF user space (lower-left origin, points). */
  readonly rect: readonly [number, number, number, number];
  readonly defaultValue?: string;
  readonly options?: readonly string[];
  readonly fontSize?: number;
  readonly required?: boolean;
}

export interface FormCalculation {
  readonly target: string;
  /** Arithmetic over field names: see {@link evaluateCalculation}. */
  readonly expression: string;
}

/** Font bounds a form widget can render legibly; outside this a value is refused. */
const MIN_FONT_SIZE = 4;
const MAX_FONT_SIZE = 72;
/** The size an automatic (`0 Tf`) field is drawn at, at most. */
const AUTO_FONT_SIZE = 12;
/** The `/DR /Font` name the embedded face is registered under. */
const FORM_FONT = 'NotoForm';

/** Field flags (ISO 32000-2 §12.7.4). */
const FF = {
  readOnly: 1 << 0,
  required: 1 << 1,
  multiline: 1 << 12,
  password: 1 << 13,
  noToggleToOff: 1 << 14,
  radio: 1 << 15,
  pushButton: 1 << 16,
  combo: 1 << 17,
  multiSelect: 1 << 21,
  edit: 1 << 18,
  comb: 1 << 24,
} as const;

// ---------------------------------------------------------------------------
// the field tree
// ---------------------------------------------------------------------------

/** One terminal field: its dictionary, its entry (for removal) and its widgets. */
interface FieldNode {
  readonly name: string;
  readonly dict: PDFObject;
  /** The entry that names this field in its parent's `/Kids` or in `/AcroForm /Fields`. */
  readonly entry: PDFObject;
  /** The array holding `entry`. */
  readonly holder: PDFObject;
  /** Widget annotations: the kids that carry no `/T`, or the field itself when merged. */
  readonly widgets: readonly { readonly dict: PDFObject; readonly entry: PDFObject }[];
}

function acroFormOf(doc: PDFDocument): PDFObject | null {
  const catalog = resolved(doc.getTrailer().get('Root'));
  const form = catalog === null ? null : resolved(catalog.get('AcroForm'));
  return form?.isDictionary() === true ? form : null;
}

/** An inheritable field attribute: the field's own, else its nearest ancestor's. */
function inherited(dict: PDFObject, key: string): PDFObject | null {
  let node: PDFObject | null = dict;
  for (let depth = 0; node !== null && depth < 32; depth += 1) {
    const value = resolved(node.get(key));
    if (value !== null) return value;
    node = resolved(node.get('Parent'));
  }
  return null;
}

function flagsOf(dict: PDFObject): number {
  const value = inherited(dict, 'Ff');
  return value?.isNumber() === true ? value.asNumber() : 0;
}

/** Every terminal field, in the order `/AcroForm /Fields` and each `/Kids` list them. */
function collectFields(doc: PDFDocument): FieldNode[] {
  const form = acroFormOf(doc);
  const fields = form === null ? null : resolved(form.get('Fields'));
  if (fields === null || !fields.isArray()) return [];
  const out: FieldNode[] = [];
  const seen = new Set<number>();
  const walk = (holder: PDFObject, index: number, prefix: string, depth: number): void => {
    const entry = holder.get(index);
    const dict = resolved(entry);
    if (dict === null || !dict.isDictionary() || depth > 32) return;
    if (entry.isIndirect()) {
      if (seen.has(entry.asIndirect())) return;
      seen.add(entry.asIndirect());
    }
    const partial = readText(dict.get('T'));
    const name = partial === null ? prefix : prefix === '' ? partial : `${prefix}.${partial}`;
    const kids = resolved(dict.get('Kids'));
    const widgets: { dict: PDFObject; entry: PDFObject }[] = [];
    if (kids?.isArray() === true) {
      for (let kid = 0; kid < kids.length; kid += 1) {
        const kidDict = resolved(kids.get(kid));
        if (kidDict === null || !kidDict.isDictionary()) continue;
        if (kidDict.get('T').isNull()) widgets.push({ dict: kidDict, entry: kids.get(kid) });
        else walk(kids, kid, name, depth + 1);
      }
    } else if (readName(dict.get('Subtype')) === 'Widget') {
      widgets.push({ dict, entry });
    }
    const hasChildFields = kids?.isArray() === true && widgets.length < kids.length;
    if (partial !== null && (!hasChildFields || widgets.length > 0)) {
      out.push({ name, dict, entry, holder, widgets });
    }
  };
  for (let index = 0; index < fields.length; index += 1) walk(fields, index, '', 0);
  return out;
}

function kindOf(field: FieldNode): FormFieldKind {
  const type = readName(inherited(field.dict, 'FT'));
  const flags = flagsOf(field.dict);
  switch (type) {
    case 'Tx':
      return 'text';
    case 'Btn':
      if ((flags & FF.pushButton) !== 0) return 'button';
      return (flags & FF.radio) !== 0 ? 'radio' : 'checkbox';
    case 'Ch':
      return (flags & FF.combo) !== 0 ? 'dropdown' : 'optionlist';
    case 'Sig':
      return 'signature';
    default:
      return 'unknown';
  }
}

/** The on-state of a button widget: its first normal appearance that is not `Off`. */
function onStateOf(widget: PDFObject): string | null {
  const appearances = resolved(widget.get('AP'));
  const normal = appearances === null ? null : resolved(appearances.get('N'));
  if (normal === null || !normal.isDictionary()) return null;
  let found: string | null = null;
  normal.forEach((_value, key) => {
    if (found === null && String(key) !== 'Off') found = String(key);
  });
  return found;
}

/** `/Opt` as `{ exported, shown }` pairs: a string, or an `[export display]` pair. */
function optionPairs(field: FieldNode): { exported: string; shown: string }[] {
  const options = inherited(field.dict, 'Opt');
  if (options === null || !options.isArray()) return [];
  const pairs: { exported: string; shown: string }[] = [];
  for (let index = 0; index < options.length; index += 1) {
    const entry = resolved(options.get(index));
    if (entry === null) continue;
    if (entry.isArray()) {
      const exported = readText(entry.get(0)) ?? '';
      pairs.push({ exported, shown: readText(entry.get(1)) ?? exported });
    } else {
      const value = readText(entry) ?? '';
      pairs.push({ exported: value, shown: value });
    }
  }
  return pairs;
}

/** A radio group's options: `/Opt` texts where present, else its on-state names. */
function radioOptions(field: FieldNode): { option: string; state: string }[] {
  const exported = optionPairs(field).map((pair) => pair.exported);
  const out: { option: string; state: string }[] = [];
  for (const [index, widget] of field.widgets.entries()) {
    const state = onStateOf(widget.dict);
    if (state === null) continue;
    const option = exported[index] ?? state;
    if (!out.some((entry) => entry.state === state)) out.push({ option, state });
  }
  return out;
}

/** `/V` as a list of texts (a choice field's value may be one string or an array). */
function textsOf(value: PDFObject | null): string[] {
  if (value === null) return [];
  if (value.isArray()) {
    const out: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const entry = readText(value.get(index));
      if (entry !== null) out.push(entry);
    }
    return out;
  }
  const single = readText(value);
  return single === null ? [] : [single];
}

function readFieldValue(field: FieldNode): string | readonly string[] | boolean | null {
  const value = inherited(field.dict, 'V');
  switch (kindOf(field)) {
    case 'text':
      return readText(value);
    case 'checkbox': {
      const state = readName(value);
      return state !== null && state !== 'Off';
    }
    case 'radio': {
      const state = readName(value);
      if (state === null || state === 'Off') return null;
      return radioOptions(field).find((entry) => entry.state === state)?.option ?? state;
    }
    case 'dropdown':
    case 'optionlist':
      return textsOf(value);
    default:
      return null;
  }
}

function optionsOf(field: FieldNode): readonly string[] | null {
  const kind = kindOf(field);
  if (kind === 'dropdown' || kind === 'optionlist') return optionPairs(field).map((pair) => pair.shown);
  if (kind === 'radio') return radioOptions(field).map((entry) => entry.option);
  return null;
}

/** Page object number → 0-based index. */
function pageIndexMap(doc: PDFDocument): Map<number, number> {
  const map = new Map<number, number>();
  for (const [index, page] of pageObjects(doc).entries()) {
    if (page.isIndirect()) map.set(page.asIndirect(), index);
  }
  return map;
}

/** The page a widget sits on: its `/P`, else the page whose `/Annots` holds it. */
function widgetPage(
  doc: PDFDocument,
  pages: Map<number, number>,
  widget: { dict: PDFObject; entry: PDFObject },
): number | null {
  const holder = widget.dict.get('P');
  if (holder.isIndirect()) {
    const index = pages.get(holder.asIndirect());
    if (index !== undefined) return index;
  }
  if (!widget.entry.isIndirect()) return null;
  const number = widget.entry.asIndirect();
  for (const [index, page] of pageObjects(doc).entries()) {
    const annots = annotsOf(doc, page);
    if (annots === null) continue;
    for (let position = 0; position < annots.length; position += 1) {
      const entry = annots.get(position);
      if (entry.isIndirect() && entry.asIndirect() === number) return index;
    }
  }
  return null;
}

function describeField(doc: PDFDocument, pages: Map<number, number>, field: FieldNode): FormFieldInfo {
  const flags = flagsOf(field.dict);
  const kind = kindOf(field);
  const maxLength = kind === 'text' ? inherited(field.dict, 'MaxLen') : null;
  let pageIndex: number | null = null;
  for (const widget of field.widgets) {
    pageIndex = widgetPage(doc, pages, widget);
    if (pageIndex !== null) break;
  }
  return {
    name: field.name,
    kind,
    value: readFieldValue(field),
    readOnly: (flags & FF.readOnly) !== 0,
    required: (flags & FF.required) !== 0,
    maxLength: maxLength?.isNumber() === true ? maxLength.asNumber() : null,
    options: optionsOf(field),
    pageIndex,
  };
}

// ---------------------------------------------------------------------------
// appearances
// ---------------------------------------------------------------------------

/** What a widget is drawn with: the embedded face, the size and colour its `/DA` names. */
interface Style {
  readonly face: EmbeddedFace;
  /** 0 = automatic. */
  readonly size: number;
  readonly color: string;
}

/** Size and colour out of a `/DA` string (`/Helv 12 Tf 0 g`). */
function parseDa(da: string | null): { readonly size: number; readonly color: string } {
  const tokens = (da ?? '').trim().split(/\s+/);
  let size = 0;
  let color = '0 g';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === 'Tf') size = Number.parseFloat(tokens[index - 1] ?? '0') || 0;
    const arity = token === 'g' ? 1 : token === 'rg' ? 3 : token === 'k' ? 4 : 0;
    if (arity > 0 && index >= arity) {
      const operands = tokens.slice(index - arity, index);
      if (operands.every((operand) => Number.isFinite(Number.parseFloat(operand)))) {
        color = `${operands.join(' ')} ${token}`;
      }
    }
  }
  return { size: Math.max(0, size), color };
}

/** An `/MK` colour array as a fill (`g`/`rg`/`k`) or stroke operator, or `null`. */
function colorOperator(value: PDFObject | null, stroke: boolean): string | null {
  const numbers = readNumbers(value);
  const operator =
    numbers.length === 1 ? 'g' : numbers.length === 3 ? 'rg' : numbers.length === 4 ? 'k' : null;
  if (operator === null) return null;
  return `${numbers.map(num).join(' ')} ${stroke ? operator.toUpperCase() : operator}`;
}

/** Box, rotation and chrome (background, border) of one widget. */
interface WidgetFrame {
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly chrome: string[];
  readonly border: number;
}

function frameOf(widget: PDFObject): WidgetFrame {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = readNumbers(widget.get('Rect'));
  const characteristics = resolved(widget.get('MK'));
  const turn = characteristics === null ? null : resolved(characteristics.get('R'));
  const rotation = ((((turn?.isNumber() === true ? turn.asNumber() : 0) % 360) + 360) % 360) as
    | 0
    | 90
    | 180
    | 270;
  const across = rotation === 90 || rotation === 270;
  const width = across ? Math.abs(y1 - y0) : Math.abs(x1 - x0);
  const height = across ? Math.abs(x1 - x0) : Math.abs(y1 - y0);
  const style = resolved(widget.get('BS'));
  const declared = style === null ? null : resolved(style.get('W'));
  const background =
    characteristics === null ? null : colorOperator(resolved(characteristics.get('BG')), false);
  const borderColor =
    characteristics === null ? null : colorOperator(resolved(characteristics.get('BC')), true);
  const border = borderColor === null ? 0 : declared?.isNumber() === true ? declared.asNumber() : 1;
  const chrome: string[] = [];
  if (background !== null) chrome.push(`${background} 0 0 ${num(width)} ${num(height)} re f`);
  if (borderColor !== null && border > 0) {
    const inset = border / 2;
    chrome.push(
      `${borderColor} ${num(border)} w ${num(inset)} ${num(inset)} ${num(width - border)} ${num(height - border)} re S`,
    );
  }
  return { width, height, rotation, chrome, border };
}

/** `/Matrix` turning the drawn box by the widget's `/MK /R`. */
function rotationMatrix(rotation: 0 | 90 | 180 | 270): number[] {
  switch (rotation) {
    case 90:
      return [0, 1, -1, 0, 0, 0];
    case 180:
      return [-1, 0, 0, -1, 0, 0];
    case 270:
      return [0, -1, 1, 0, 0, 0];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

function formXObject(
  doc: PDFDocument,
  frame: WidgetFrame,
  content: string,
  face: EmbeddedFace | null,
): PDFObject {
  return doc.addStream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, frame.width, frame.height],
    Matrix: rotationMatrix(frame.rotation),
    Resources: face === null ? {} : { Font: { [FORM_FONT]: face.ref } },
  });
}

/** Greedy word wrap to `width`; a word wider than the line is broken between characters. */
function wrapLines(value: string, width: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measure(candidate) <= width || (line === '' && measure(word) <= width)) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      line = '';
      for (const character of word) {
        if (line !== '' && measure(line + character) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** One line of text at `(x, baseline)`. */
function textRun(style: Style, size: number, x: number, baseline: number, value: string): string {
  return `BT /${FORM_FONT} ${num(size)} Tf ${style.color} ${num(x)} ${num(baseline)} Td ${style.face.encode(value)} Tj ET`;
}

/** The normal appearance of a text field (or a dropdown's shown value). */
function textAppearance(field: FieldNode, frame: WidgetFrame, style: Style, value: string): string {
  const flags = flagsOf(field.dict);
  const pad = 2 + frame.border;
  const inner = { width: Math.max(1, frame.width - 2 * pad), height: Math.max(1, frame.height - 2 * pad) };
  const shown = (flags & FF.password) !== 0 ? '•'.repeat([...value].length) : value;
  const alignment = inherited(field.dict, 'Q');
  const quadding = alignment?.isNumber() === true ? alignment.asNumber() : 0;
  const lineRatio = style.face.heightAtSize(1);
  const operators = ['/Tx BMC', 'q', ...frame.chrome];
  operators.push(`${num(pad)} ${num(pad)} ${num(inner.width)} ${num(inner.height)} re W n`);

  const maxLength = inherited(field.dict, 'MaxLen');
  if ((flags & FF.comb) !== 0 && maxLength?.isNumber() === true && maxLength.asNumber() > 0) {
    const cells = maxLength.asNumber();
    const cell = frame.width / cells;
    const size = style.size > 0 ? style.size : Math.min(AUTO_FONT_SIZE, (frame.height - 2 * pad) / lineRatio);
    const baseline =
      (frame.height - lineRatio * size) / 2 +
      (lineRatio - style.face.heightAtSize(1, { descender: false })) * size;
    [...shown].slice(0, cells).forEach((character, index) => {
      const width = style.face.widthOfTextAtSize(character, size);
      operators.push(textRun(style, size, index * cell + (cell - width) / 2, baseline, character));
    });
  } else if ((flags & FF.multiline) !== 0) {
    let size = style.size > 0 ? style.size : AUTO_FONT_SIZE;
    let lines = wrapLines(shown, inner.width, (text) => style.face.widthOfTextAtSize(text, size));
    while (style.size === 0 && size > MIN_FONT_SIZE && lines.length * size * 1.2 > inner.height) {
      size -= 0.5;
      lines = wrapLines(shown, inner.width, (text) => style.face.widthOfTextAtSize(text, size));
    }
    const ascent = style.face.heightAtSize(size, { descender: false });
    lines.forEach((line, index) => {
      const width = style.face.widthOfTextAtSize(line, size);
      const x =
        quadding === 1 ? pad + (inner.width - width) / 2 : quadding === 2 ? pad + inner.width - width : pad;
      operators.push(textRun(style, size, x, frame.height - pad - ascent - index * size * 1.2, line));
    });
  } else {
    let size = style.size > 0 ? style.size : Math.min(AUTO_FONT_SIZE, inner.height / lineRatio);
    if (style.size === 0) {
      const width = style.face.widthOfTextAtSize(shown, 1);
      if (width > 0) size = Math.min(size, inner.width / width);
      size = Math.max(MIN_FONT_SIZE, size);
    }
    const descent = (lineRatio - style.face.heightAtSize(1, { descender: false })) * size;
    const baseline = (frame.height - lineRatio * size) / 2 + descent;
    const width = style.face.widthOfTextAtSize(shown, size);
    const x = quadding === 1 ? (frame.width - width) / 2 : quadding === 2 ? frame.width - pad - width : pad;
    operators.push(textRun(style, size, x, baseline, shown));
  }
  operators.push('Q', 'EMC');
  return operators.join('\n');
}

/** An option list: every option, the selected ones on a highlight. */
function listAppearance(
  field: FieldNode,
  frame: WidgetFrame,
  style: Style,
  selected: readonly string[],
): string {
  const pad = 2 + frame.border;
  const size = style.size > 0 ? style.size : AUTO_FONT_SIZE;
  const pitch = size * 1.2;
  const ascent = style.face.heightAtSize(size, { descender: false });
  const operators = ['/Tx BMC', 'q', ...frame.chrome];
  operators.push(
    `${num(pad)} ${num(pad)} ${num(frame.width - 2 * pad)} ${num(frame.height - 2 * pad)} re W n`,
  );
  optionPairs(field).forEach((pair, index) => {
    const top = frame.height - pad - index * pitch;
    if (selected.includes(pair.exported)) {
      operators.push(
        `0.6 0.75 0.85 rg ${num(pad)} ${num(top - pitch)} ${num(frame.width - 2 * pad)} ${num(pitch)} re f`,
      );
    }
    operators.push(textRun(style, size, pad, top - (pitch - size) / 2 - ascent, pair.shown));
  });
  operators.push('Q', 'EMC');
  return operators.join('\n');
}

/** A check mark (on) or nothing (off) over the widget's chrome. */
function checkAppearance(frame: WidgetFrame, color: string, on: boolean): string {
  const operators = ['q', ...frame.chrome];
  if (on) {
    const w = frame.width;
    const h = frame.height;
    const stroke = color.replace(/ (g|rg|k)$/, (match) => match.toUpperCase());
    operators.push(
      `${stroke} ${num(Math.max(1, Math.min(w, h) * 0.1))} w 1 J 1 j`,
      `${num(w * 0.22)} ${num(h * 0.52)} m ${num(w * 0.42)} ${num(h * 0.28)} l ${num(w * 0.8)} ${num(h * 0.76)} l S`,
    );
  }
  operators.push('Q');
  return operators.join('\n');
}

/** A filled dot (on) or nothing (off) over the widget's chrome. */
function radioAppearance(frame: WidgetFrame, color: string, on: boolean): string {
  const operators = ['q', ...frame.chrome];
  if (on) {
    const r = Math.min(frame.width, frame.height) * 0.25;
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const k = r * 0.5523;
    operators.push(
      color,
      `${num(cx + r)} ${num(cy)} m`,
      `${num(cx + r)} ${num(cy + k)} ${num(cx + k)} ${num(cy + r)} ${num(cx)} ${num(cy + r)} c`,
      `${num(cx - k)} ${num(cy + r)} ${num(cx - r)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} c`,
      `${num(cx - r)} ${num(cy - k)} ${num(cx - k)} ${num(cy - r)} ${num(cx)} ${num(cy - r)} c`,
      `${num(cx + k)} ${num(cy - r)} ${num(cx + r)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} c f`,
    );
  }
  operators.push('Q');
  return operators.join('\n');
}

/** The embedded face, registered once per operation in `/AcroForm /DR /Font`. */
class FormFace {
  private face: EmbeddedFace | null = null;

  constructor(private readonly opened: WritableDocument) {}

  async get(): Promise<EmbeddedFace> {
    if (this.face !== null) return this.face;
    const { mupdf, doc } = this.opened;
    const face = await embedNotoSans(mupdf, doc);
    const form = ensureAcroForm(doc);
    dictionaryIn(doc, dictionaryIn(doc, form, 'DR'), 'Font').put(FORM_FONT, face.ref);
    this.face = face;
    return face;
  }
}

/** `/AcroForm`, created (with a default appearance naming the embedded face) when missing. */
function ensureAcroForm(doc: PDFDocument): PDFObject {
  const existing = acroFormOf(doc);
  if (existing !== null) return existing;
  const catalog = resolved(doc.getTrailer().get('Root'));
  if (catalog === null)
    throw new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'no /Root' });
  catalog.put('AcroForm', doc.addObject({ Fields: [], DA: pdfText(doc, `/${FORM_FONT} 0 Tf 0 g`) }));
  const form = acroFormOf(doc);
  if (form === null)
    throw new ToolError('internal', { engine: 'mupdf', engineMessage: 'AcroForm not created' });
  return form;
}

/**
 * Redraw a field's widgets from its current value. Text and choice widgets are redrawn
 * with the embedded face, and their `/DA` names it; a button keeps the on/off
 * appearances it has and only gets drawn ones where they are missing.
 */
async function updateAppearances(doc: PDFDocument, fonts: FormFace, field: FieldNode): Promise<void> {
  const kind = kindOf(field);
  const da = parseDa(readText(inherited(field.dict, 'DA')));
  if (kind === 'checkbox' || kind === 'radio') {
    const value = readName(inherited(field.dict, 'V'));
    for (const widget of field.widgets) {
      const state = onStateOf(widget.dict) ?? 'Yes';
      const appearances = resolved(widget.dict.get('AP'));
      const normal = appearances === null ? null : resolved(appearances.get('N'));
      if (
        normal === null ||
        !normal.isDictionary() ||
        normal.get(state).isNull() ||
        normal.get('Off').isNull()
      ) {
        const frame = frameOf(widget.dict);
        const draw = kind === 'checkbox' ? checkAppearance : radioAppearance;
        widget.dict.put('AP', {
          N: {
            [state]: formXObject(doc, frame, draw(frame, da.color, true), null),
            Off: formXObject(doc, frame, draw(frame, da.color, false), null),
          },
        });
      }
      widget.dict.put('AS', value === state ? state : 'Off');
    }
    return;
  }
  if (kind !== 'text' && kind !== 'dropdown' && kind !== 'optionlist') return;
  const face = await fonts.get();
  const style: Style = { face, size: da.size, color: da.color };
  const value = inherited(field.dict, 'V');
  const pairs = optionPairs(field);
  for (const widget of field.widgets) {
    const frame = frameOf(widget.dict);
    let content: string;
    if (kind === 'optionlist') {
      content = listAppearance(field, frame, style, textsOf(value));
    } else {
      const raw = kind === 'text' ? (readText(value) ?? '') : (textsOf(value)[0] ?? '');
      const shown = kind === 'dropdown' ? (pairs.find((pair) => pair.exported === raw)?.shown ?? raw) : raw;
      content = textAppearance(field, frame, style, shown);
    }
    widget.dict.put('AP', { N: formXObject(doc, frame, content, face) });
    widget.dict.put('DA', pdfText(doc, `/${FORM_FONT} ${num(da.size)} Tf ${da.color}`));
  }
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

/** Run `body` on an opened document; the document is always destroyed. */
async function withDocument<T>(
  bytes: Uint8Array,
  context: string,
  body: (opened: WritableDocument) => Promise<T>,
): Promise<T> {
  const opened = await openForWrite(bytes);
  try {
    return await body(opened);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, context);
  } finally {
    opened.doc.destroy();
  }
}

/**
 * Every field of the document, in the form's own order.
 *
 * A read: the document is opened and never saved, so a form with a hundred fields
 * costs one parse and nothing else.
 */
export async function readFormFields(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<readonly FormFieldInfo[]> {
  return await withDocument(bytes, 'form.read', async ({ doc }) => {
    const pages = pageIndexMap(doc);
    const result: FormFieldInfo[] = [];
    for (const field of collectFields(doc)) {
      if (signal?.aborted === true) break;
      result.push(describeField(doc, pages, field));
    }
    return result;
  });
}

function refuseValue(name: string, message: string): never {
  throw new ToolError('value-out-of-range', {
    engine: 'mupdf',
    engineMessage: `form.fill(${name}): ${message}`,
  });
}

/** Write one fill into its field; `false` when the value does not fit the field's kind. */
function writeValue(doc: PDFDocument, field: FieldNode, value: FormFill['value']): boolean {
  const kind = kindOf(field);
  if (kind === 'text' && typeof value === 'string') {
    const maxLength = inherited(field.dict, 'MaxLen');
    if (maxLength?.isNumber() === true && [...value].length > maxLength.asNumber()) {
      refuseValue(field.name, `${[...value].length} characters exceed /MaxLen ${maxLength.asNumber()}`);
    }
    field.dict.put('V', pdfText(doc, value));
    return true;
  }
  if (kind === 'checkbox' && typeof value === 'boolean') {
    const state =
      field.widgets.map((widget) => onStateOf(widget.dict)).find((entry) => entry !== null) ?? 'Yes';
    field.dict.put('V', value ? state : 'Off');
    return true;
  }
  if ((kind === 'dropdown' || kind === 'optionlist') && typeof value !== 'boolean') {
    const chosen = typeof value === 'string' ? [value] : [...value];
    const pairs = optionPairs(field);
    const editable = kind === 'dropdown' && (flagsOf(field.dict) & FF.edit) !== 0;
    const exported = chosen.map(
      (entry) => pairs.find((pair) => pair.shown === entry || pair.exported === entry)?.exported,
    );
    if (!editable && exported.some((entry) => entry === undefined))
      refuseValue(field.name, 'not one of the options');
    const values = exported.map((entry, index) => entry ?? chosen[index] ?? '');
    if (values.length > 1 && (flagsOf(field.dict) & FF.multiSelect) === 0)
      refuseValue(field.name, 'one option only');
    field.dict.put(
      'V',
      values.length === 1 ? pdfText(doc, values[0] ?? '') : values.map((entry) => pdfText(doc, entry)),
    );
    field.dict.delete('I');
    return true;
  }
  if (kind === 'radio' && typeof value === 'string') {
    const option = radioOptions(field).find((entry) => entry.option === value);
    if (option === undefined) refuseValue(field.name, 'not one of the options');
    field.dict.put('V', option.state);
    return true;
  }
  return false;
}

/**
 * Fill the named fields.
 *
 * Unknown names are reported rather than ignored: an FDF round trip against the
 * wrong document is a real failure mode, and a silently dropped value is the one
 * outcome a form tool must not produce. Appearance updates are attempted once per
 * written field (one embedded font), and their failure is a warning, not a lost value.
 */
export async function fillFormFields(
  bytes: Uint8Array,
  fills: readonly FormFill[],
  context: OperationContext,
): Promise<OperationOutcome> {
  return await withDocument(bytes, 'form.fill', async (opened) => {
    const { doc } = opened;
    const fields = collectFields(doc);
    const notes: ReturnType<typeof note>[] = [];
    const applied: FieldNode[] = [];
    const missing: string[] = [];

    for (const [index, fill] of fills.entries()) {
      throwIfAborted(context.signal);
      const field = fields.find((candidate) => candidate.name === fill.name);
      if (field === undefined || !writeValue(doc, field, fill.value)) {
        missing.push(fill.name);
        continue;
      }
      applied.push(field);
      context.onProgress?.({
        phase: 'forms',
        labelKey: 'op.progress.forms',
        done: index + 1,
        total: fills.length,
      });
    }

    let appearancesUpdated = false;
    if (applied.length > 0) {
      try {
        const fonts = new FormFace(opened);
        for (const field of applied) await updateAppearances(doc, fonts, field);
        appearancesUpdated = true;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        // A missing font asset must not lose the value the user typed: the value is
        // already in the field dictionary and only the drawn form is stale.
      }
    }

    const saved = saveRewrite(doc, 'form.save');
    notes.push(note('changed', 'form.note.filled', { count: applied.length }));
    notes.push(note('preserved', 'form.note.structure'));
    if (missing.length > 0) notes.push(note('warning', 'form.note.missing', { count: missing.length }));
    notes.push(
      appearancesUpdated
        ? note('preserved', 'form.note.appearanceNoto')
        : note('warning', 'form.note.appearance'),
    );
    return {
      bytes: saved,
      report: {
        engine: 'mupdf',
        steps: ['load', 'form.setText', 'save'],
        notes,
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: doc.countPages(),
        incremental: false,
      },
    };
  });
}

/**
 * Create fields (`PLAN.md §5/Phase 3`: "creation").
 *
 * Every widget gets a black border on white and an appearance drawn with the embedded
 * Noto Sans, so a Turkish default value is legible and encodable. (The pdf-lib writer
 * refused every text field it was asked to create: its font-size setter needs a `/DA`
 * the new field did not have yet.)
 */
export async function createFormFields(
  bytes: Uint8Array,
  fields: readonly FieldCreation[],
  context: OperationContext,
): Promise<OperationOutcome> {
  return await withDocument(bytes, 'form.create', async (opened) => {
    const { doc } = opened;
    const pages = pageObjects(doc);
    const pageCount = pages.length;
    const created: string[] = [];
    const fonts = new FormFace(opened);

    for (const [index, spec] of fields.entries()) {
      throwIfAborted(context.signal);
      const page = pages[spec.pageIndex];
      if (page === undefined || spec.pageIndex < 0) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          engineMessage: `field ${spec.name} targets page ${spec.pageIndex + 1} of ${pageCount}`,
        });
      }
      const [x, y, width, height] = spec.rect;
      if (width <= 0 || height <= 0) {
        throw new ToolError('value-out-of-range', {
          engine: 'mupdf',
          engineMessage: `field ${spec.name} has a non-positive size (${width}x${height})`,
        });
      }
      if (spec.name.trim() === '' || spec.name.includes('.')) {
        throw new ToolError('value-out-of-range', {
          engine: 'mupdf',
          engineMessage: `field name "${spec.name}" is empty or contains a period`,
        });
      }
      if (collectFields(doc).some((field) => field.name === spec.name)) {
        throw new ToolError('value-out-of-range', {
          engine: 'mupdf',
          engineMessage: `a field named ${spec.name} already exists`,
        });
      }
      await fonts.get();
      const form = ensureAcroForm(doc);
      const size = Math.min(Math.max(spec.fontSize ?? 12, MIN_FONT_SIZE), MAX_FONT_SIZE);
      const chrome = { MK: { BC: [0, 0, 0], BG: [1, 1, 1] }, BS: { W: 1 } };
      const widget = (rect: readonly number[], extra: Record<string, unknown>) =>
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [...rect],
          P: page,
          F: 4,
          ...chrome,
          ...extra,
        });
      const required = spec.required === true ? FF.required : 0;
      const rect = [x, y, x + width, y + height];
      const options = spec.options ?? [];
      const da = pdfText(doc, `/${FORM_FONT} ${num(size)} Tf 0 g`);
      const title = pdfText(doc, spec.name);
      let entry: PDFObject;
      let widgets: PDFObject[];

      switch (spec.kind) {
        case 'checkbox': {
          const checked = spec.defaultValue === 'true' || spec.defaultValue === '1';
          entry = widget(rect, { FT: 'Btn', T: title, Ff: required, V: checked ? 'Yes' : 'Off', DA: da });
          widgets = [entry];
          break;
        }
        case 'radio': {
          if (options.length === 0) {
            throw new ToolError('selection-empty', {
              engine: 'mupdf',
              engineMessage: `radio group ${spec.name} was created without options`,
            });
          }
          // One option per slot so the group is usable the moment it exists; a single
          // widget per option is what a reader expects from a group. The on-states are
          // indices and `/Opt` carries the option texts, so any option text works.
          const chosen = spec.defaultValue === undefined ? -1 : options.indexOf(spec.defaultValue);
          entry = doc.addObject({
            FT: 'Btn',
            T: title,
            Ff: FF.radio | FF.noToggleToOff | required,
            V: chosen < 0 ? 'Off' : String(chosen),
            Opt: options.map((option) => pdfText(doc, option)),
            DA: da,
            Kids: [],
          });
          const slot = Math.max(height / options.length, 12);
          widgets = options.map((_option, optionIndex) => {
            const top = y + height - optionIndex * slot;
            const kid = widget([x, top - slot, x + Math.min(width, slot), top], { Parent: entry });
            entry.get('Kids').push(kid);
            return kid;
          });
          // Each kid's on-state is its index: drawn here, because a button's on-state is
          // read from the appearance it has.
          for (const [optionIndex, kid] of widgets.entries()) {
            const frame = frameOf(kid);
            kid.put('AP', {
              N: {
                [String(optionIndex)]: formXObject(doc, frame, radioAppearance(frame, '0 g', true), null),
                Off: formXObject(doc, frame, radioAppearance(frame, '0 g', false), null),
              },
            });
          }
          break;
        }
        case 'dropdown':
        case 'optionlist': {
          const selected = spec.defaultValue !== undefined && options.includes(spec.defaultValue);
          entry = widget(rect, {
            FT: 'Ch',
            T: title,
            Ff: (spec.kind === 'dropdown' ? FF.combo : 0) | required,
            Opt: options.map((option) => pdfText(doc, option)),
            DA: da,
            ...(selected ? { V: pdfText(doc, spec.defaultValue ?? '') } : {}),
          });
          widgets = [entry];
          break;
        }
        default: {
          entry = widget(rect, {
            FT: 'Tx',
            T: title,
            Ff: required,
            DA: da,
            ...(spec.defaultValue === undefined ? {} : { V: pdfText(doc, spec.defaultValue) }),
          });
          widgets = [entry];
          break;
        }
      }

      arrayIn(doc, form, 'Fields').push(entry);
      const annots = annotsOf(doc, page, true);
      for (const kid of widgets) annots?.push(kid);
      const node = collectFields(doc).find((field) => field.name === spec.name);
      if (node !== undefined) await updateAppearances(doc, fonts, node);
      created.push(spec.name);
      context.onProgress?.({
        phase: 'forms',
        labelKey: 'op.progress.forms',
        done: index + 1,
        total: fields.length,
      });
    }

    const saved = saveRewrite(doc, 'form.save');
    return {
      bytes: saved,
      report: {
        engine: 'mupdf',
        steps: ['load', 'form.createField', 'save'],
        notes: [
          note('changed', 'form.note.created', { count: created.length }),
          note('warning', 'form.note.createdAppearance'),
        ],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount,
        incremental: false,
      },
    };
  });
}

/** Lock or require fields (`PLAN.md §5/Phase 3`: "locking"). */
export async function setFieldFlags(
  bytes: Uint8Array,
  names: readonly string[],
  flags: { readonly readOnly?: boolean; readonly required?: boolean },
  context: OperationContext,
): Promise<OperationOutcome> {
  return await withDocument(bytes, 'form.flags', async ({ doc }) => {
    const fields = collectFields(doc);
    const changed: string[] = [];
    for (const [index, name] of names.entries()) {
      throwIfAborted(context.signal);
      const field = fields.find((candidate) => candidate.name === name);
      if (field === undefined) continue;
      let value = flagsOf(field.dict);
      if (flags.readOnly !== undefined) value = flags.readOnly ? value | FF.readOnly : value & ~FF.readOnly;
      if (flags.required !== undefined) value = flags.required ? value | FF.required : value & ~FF.required;
      field.dict.put('Ff', value);
      changed.push(name);
      context.onProgress?.({
        phase: 'forms',
        labelKey: 'op.progress.forms',
        done: index + 1,
        total: names.length,
      });
    }
    const saved = saveRewrite(doc, 'form.save');
    return {
      bytes: saved,
      report: {
        engine: 'mupdf',
        steps: ['load', 'form.setFlags', 'save'],
        notes: [note('changed', 'form.note.flagged', { count: changed.length })],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: doc.countPages(),
        incremental: false,
      },
    };
  });
}

/** The appearance stream a widget shows now: `/AP /N`, through `/AS` when it is a state dictionary. */
function shownAppearance(widget: PDFObject): PDFObject | null {
  const appearances = resolved(widget.get('AP'));
  if (appearances === null) return null;
  const normal = appearances.get('N');
  if (normal.isStream()) return normal;
  const states = resolved(normal);
  const state = readName(widget.get('AS'));
  if (states === null || !states.isDictionary() || state === null) return null;
  const chosen = states.get(state);
  return chosen.isStream() ? chosen : null;
}

/** Remove the entry numbered `number` from an array; `true` when it was there. */
function removeEntry(array: PDFObject | null, number: number): boolean {
  if (array === null || !array.isArray()) return false;
  for (let index = array.length - 1; index >= 0; index -= 1) {
    const entry = array.get(index);
    if (entry.isIndirect() && entry.asIndirect() === number) {
      array.delete(index);
      return true;
    }
  }
  return false;
}

/**
 * Flatten fields into the page content.
 *
 * `names: null` selects every field. Unsupported fields and appearance failures
 * refuse the entire operation; only the disposable document is ever mutated.
 * Selected widgets are painted before removal; other fields stay editable.
 */
export async function flattenForm(
  bytes: Uint8Array,
  names: readonly string[] | null,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  return await withDocument(bytes, 'form.flatten', async (opened) => {
    const { doc } = opened;
    const form = acroFormOf(doc);
    if (form !== null && !form.get('XFA').isNull()) {
      throw new ToolError('unsupported', { engine: 'mupdf', engineMessage: 'XFA flatten is unsupported' });
    }
    const fields = collectFields(doc);
    const selected =
      names === null
        ? fields
        : [...new Set(names)].map((name) => {
            const field = fields.find((candidate) => candidate.name === name);
            if (field === undefined) {
              throw new ToolError('selection-empty', {
                engine: 'mupdf',
                engineMessage: `no field named ${name}`,
              });
            }
            return field;
          });
    if (selected.length === 0) throw new ToolError('selection-empty', { engine: 'mupdf' });
    const flattenable: readonly FormFieldKind[] = ['text', 'checkbox', 'dropdown', 'radio', 'optionlist'];
    if (selected.some((field) => !flattenable.includes(kindOf(field)))) {
      throw new ToolError('unsupported', {
        engine: 'mupdf',
        engineMessage: 'Unsupported flatten field or XFA form',
      });
    }

    const pages = pageObjects(doc);
    const pageNumbers = pageIndexMap(doc);
    const fonts = new FormFace(opened);
    let appearancesUpdated = false;
    for (const field of selected) {
      throwIfAborted(context.signal);
      // Existing appearances carry document-specific styling; only missing ones are
      // drawn, with the face that can encode Turkish values.
      if (field.widgets.some((widget) => shownAppearance(widget.dict) === null)) {
        await updateAppearances(doc, fonts, field);
        appearancesUpdated = true;
      }
      if (field.widgets.length === 0) {
        throw new ToolError('unsupported', {
          engine: 'mupdf',
          engineMessage: 'Field has no visible widgets',
        });
      }
      for (const widget of field.widgets) {
        const pageIndex = widgetPage(doc, pageNumbers, widget);
        const page = pageIndex === null ? undefined : pages[pageIndex];
        if (page === undefined) {
          throw new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'Widget page missing' });
        }
        const appearance = shownAppearance(widget.dict);
        // An off-state button with no drawn off appearance simply shows nothing.
        if (appearance !== null) {
          const stream = resolved(appearance);
          const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = readNumbers(stream?.get('BBox'));
          const matrix = readNumbers(stream?.get('Matrix'));
          const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] =
            matrix.length === 6 ? matrix : [1, 0, 0, 1, 0, 0];
          const corners = [
            [bx0, by0],
            [bx1, by0],
            [bx0, by1],
            [bx1, by1],
          ] as const;
          const xs = corners.map(([x, y]) => a * x + c * y + e);
          const ys = corners.map(([x, y]) => b * x + d * y + f);
          const x0 = Math.min(...xs);
          const y0 = Math.min(...ys);
          const width = Math.max(...xs) - x0;
          const height = Math.max(...ys) - y0;
          const [rx0 = 0, ry0 = 0, rx1 = 0, ry1 = 0] = readNumbers(widget.dict.get('Rect'));
          const rect = {
            x: Math.min(rx0, rx1),
            y: Math.min(ry0, ry1),
            width: Math.abs(rx1 - rx0),
            height: Math.abs(ry1 - ry0),
          };
          if (
            ![width, height, rect.width, rect.height].every((value) => Number.isFinite(value) && value > 0)
          ) {
            throw new ToolError('corrupt-document', {
              engine: 'mupdf',
              engineMessage: 'Invalid widget appearance bounds',
            });
          }
          const sx = rect.width / width;
          const sy = rect.height / height;
          const key = addPageResource(doc, page, 'XObject', 'FlatWidget', appearance);
          appendPageContent(
            doc,
            page,
            `q ${num(sx)} 0 0 ${num(sy)} ${num(rect.x - sx * x0)} ${num(rect.y - sy * y0)} cm /${key} Do Q`,
          );
        }
        if (widget.entry.isIndirect()) removeEntry(annotsOf(doc, page), widget.entry.asIndirect());
      }
      if (field.entry.isIndirect()) removeEntry(field.holder, field.entry.asIndirect());
    }
    throwIfAborted(context.signal);

    const saved = saveRewrite(doc, 'form.save');
    return {
      bytes: saved,
      report: {
        engine: 'mupdf',
        steps: ['load', 'form.flatten', 'save'],
        notes: [
          note('changed', 'form.note.flattened', { count: selected.length }),
          note('lost', 'form.note.flattenFieldsGone'),
          ...(appearancesUpdated ? [note('preserved', 'form.note.appearanceNoto')] : []),
        ],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: doc.countPages(),
        incremental: false,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// calculation fields
// ---------------------------------------------------------------------------

/**
 * A four-function calculator over the form's own fields — the *simple* subset
 * `PLAN.md §5/Phase 3` asks for, and no more.
 *
 * Grammar, in full:
 *
 * ```
 * expr    := term (('+' | '-') term)*
 * term    := unary (('*' | '/') unary)*
 * unary   := '-' unary | primary
 * primary := number | ident | 'min' '(' expr ',' expr ')' | 'max' '(' expr ',' expr ')' | '(' expr ')'
 * number  := [0-9]+ ('.' [0-9]+)?
 * ident   := [A-Za-z_] [A-Za-z0-9_.]*
 * ```
 *
 * An undefined identifier is `0` (a form with an empty optional field must still
 * compute), a division by zero is `0` rather than `Infinity`, and any
 * non-finite result is `0` — a field that shows `NaN` is worse than a field that
 * shows nothing. A malformed expression throws `value-out-of-range` naming the
 * offending token, because "the calculation is broken" is not a user sentence.
 *
 * Deliberately not implemented: PDF JavaScript (`AFSimple_Calculate`) and the
 * full Acrobat formula language. Executing embedded form scripts is off by
 * decision (`PLAN.md §3.7`), and a calculator we cannot test is not worth
 * shipping.
 */
export function evaluateCalculation(expression: string, values: Readonly<Record<string, number>>): number {
  const tokens = tokenize(expression);
  let position = 0;

  const peek = (): string | undefined => tokens[position];
  const next = (): string | undefined => {
    const token = tokens[position];
    position += 1;
    return token;
  };
  const fail = (token: string | undefined): never => {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `calculation: unexpected token "${token ?? 'end of expression'}"`,
    });
  };

  const primary = (): number => {
    const token = next();
    if (token === undefined) return fail(token);
    if (token === '-') return -primary();
    if (token === '(') {
      const value = sum();
      if (peek() !== ')') fail(peek());
      next();
      return value;
    }
    if (token === 'min' || token === 'max') {
      const open = next();
      if (open !== '(') return fail(open);
      const a = sum();
      const comma = next();
      if (comma !== ',') return fail(comma);
      const b = sum();
      const close = next();
      if (close !== ')') return fail(close);
      return token === 'min' ? Math.min(a, b) : Math.max(a, b);
    }
    if (/^[0-9]/.test(token)) return Number.parseFloat(token);
    if (/^[A-Za-z_]/.test(token)) return values[token] ?? 0;
    return fail(token);
  };

  const product = (): number => {
    let value = primary();
    for (;;) {
      const token = peek();
      if (token === '*') {
        next();
        value *= primary();
        continue;
      }
      if (token === '/') {
        next();
        const divisor = primary();
        value = divisor === 0 ? 0 : value / divisor;
        continue;
      }
      return value;
    }
  };

  const sum = (): number => {
    let value = product();
    for (;;) {
      const token = peek();
      if (token === '+') {
        next();
        value += product();
        continue;
      }
      if (token === '-') {
        next();
        value -= product();
        continue;
      }
      return value;
    }
  };

  const result = sum();
  if (position !== tokens.length) fail(peek());
  return Number.isFinite(result) ? result : 0;
}

/** Numbers, identifiers, the four operators, parentheses and the comma. */
function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let end = index;
      while (end < expression.length && /[0-9.]/.test(expression[end] as string)) end += 1;
      const text = expression.slice(index, end);
      if (Number.isNaN(Number.parseFloat(text))) {
        throw new ToolError('value-out-of-range', {
          engine: 'model',
          engineMessage: `calculation: malformed number "${text}"`,
        });
      }
      tokens.push(text);
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < expression.length && /[A-Za-z0-9_.]/.test(expression[end] as string)) end += 1;
      tokens.push(expression.slice(index, end));
      index = end;
      continue;
    }
    if ('+-*/(),'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `calculation: unexpected character "${char}"`,
    });
  }
  if (tokens.length === 0) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: 'calculation: empty expression',
    });
  }
  return tokens;
}

/** Read the current values as numbers, then write each target's result. */
export async function applyCalculations(
  bytes: Uint8Array,
  calculations: readonly FormCalculation[],
  context: OperationContext,
): Promise<OperationOutcome & { readonly results: Readonly<Record<string, string>> }> {
  return await withDocument(bytes, 'form.calculate', async (opened) => {
    const { doc } = opened;
    const fields = collectFields(doc);
    const values: Record<string, number> = {};
    for (const field of fields) {
      const raw = readFieldValue(field);
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('') : '';
      const parsed = Number.parseFloat(text.replace(',', '.'));
      values[field.name] = Number.isFinite(parsed) ? parsed : 0;
    }

    const results: Record<string, string> = {};
    const written: FieldNode[] = [];
    for (const [index, calculation] of calculations.entries()) {
      throwIfAborted(context.signal);
      const result = evaluateCalculation(calculation.expression, values);
      // Two decimals, trailing zeros removed: a money field and a page count both
      // read naturally and neither gains fake precision.
      const text = Number.isInteger(result)
        ? String(result)
        : result.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
      const field = fields.find((candidate) => candidate.name === calculation.target);
      if (field !== undefined && kindOf(field) === 'text') {
        field.dict.put('V', pdfText(doc, text));
        written.push(field);
      }
      values[calculation.target] = result;
      results[calculation.target] = text;
      context.onProgress?.({
        phase: 'forms',
        labelKey: 'op.progress.forms',
        done: index + 1,
        total: calculations.length,
      });
    }

    try {
      const fonts = new FormFace(opened);
      for (const field of written) await updateAppearances(doc, fonts, field);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Same rule as `fillFormFields`: the value lands, the drawn form may lag.
    }

    const saved = saveRewrite(doc, 'form.save');
    return {
      bytes: saved,
      results,
      report: {
        engine: 'mupdf',
        steps: ['load', 'form.calculate', 'save'],
        notes: [note('changed', 'form.note.calculated', { count: Object.keys(results).length })],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: doc.countPages(),
        incremental: false,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/**
 * The rules a value must satisfy before it is written. `reasonKey` is a
 * dictionary key, so a refusal is a sentence the user reads rather than a
 * boolean the UI has to explain.
 */
export function validateField(
  field: FormFieldInfo,
  value: string | readonly string[] | boolean,
): { readonly ok: boolean; readonly reasonKey?: MessageKey } {
  if (field.readOnly) return { ok: false, reasonKey: 'form.reason.readOnly' };
  if (field.kind === 'text') {
    const text = typeof value === 'string' ? value : '';
    if (field.required && text.trim().length === 0) return { ok: false, reasonKey: 'form.reason.required' };
    if (field.maxLength !== null && text.length > field.maxLength) {
      return { ok: false, reasonKey: 'form.reason.maxLength' };
    }
    return { ok: true };
  }
  if (field.kind === 'checkbox') {
    if (field.required && value !== true) return { ok: false, reasonKey: 'form.reason.required' };
    return { ok: true };
  }
  if (field.kind === 'dropdown' || field.kind === 'optionlist' || field.kind === 'radio') {
    const chosen = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    if (chosen.length === 0) {
      // An unfilled choice field is only an error when the form requires it.
      return field.required ? { ok: false, reasonKey: 'form.reason.required' } : { ok: true };
    }
    const options = field.options ?? [];
    for (const option of chosen) {
      if (!options.includes(option)) return { ok: false, reasonKey: 'form.reason.notAnOption' };
    }
    return { ok: true };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// data interchange
// ---------------------------------------------------------------------------

function recordsOf(doc: PDFDocument): readonly FormDataRecord[] {
  const records: FormDataRecord[] = [];
  for (const field of collectFields(doc)) {
    const value = readFieldValue(field);
    if (value === null) continue;
    records.push({ name: field.name, value });
  }
  return records;
}

/** Fields + values as FDF or JSON (`REPORT.md §3` A11's interchange requirement). */
export async function exportFormData(
  bytes: Uint8Array,
  format: 'fdf' | 'json',
  signal?: AbortSignal,
): Promise<{
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly name: string;
  readonly fields: number;
}> {
  const records = await withDocument(bytes, 'form.export', async ({ doc }) => {
    if (signal?.aborted === true) {
      throw new ToolError('aborted', { engine: 'mupdf', engineMessage: 'export aborted' });
    }
    return recordsOf(doc);
  });
  return format === 'fdf'
    ? { bytes: serializeFdf(records), mime: 'application/vnd.fdf', name: 'form.fdf', fields: records.length }
    : {
        bytes: serializeFormJson(records, true),
        mime: 'application/json',
        name: 'form.json',
        fields: records.length,
      };
}

/** Import values from an FDF or JSON file; unknown names are reported, not dropped. */
export async function importFormData(
  bytes: Uint8Array,
  data: Uint8Array | string,
  format: 'fdf' | 'json',
  context: OperationContext,
): Promise<OperationOutcome & { readonly applied: number; readonly missing: readonly string[] }> {
  const records =
    format === 'fdf'
      ? parseFdf(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      : parseFormJson(typeof data === 'string' ? data : new TextDecoder().decode(data));

  const present = new Set((await readFormFields(bytes)).map((field) => field.name));
  const missing = records.filter((record) => !present.has(record.name)).map((record) => record.name);
  const outcome = await fillFormFields(
    bytes,
    records
      .filter((record) => present.has(record.name))
      .map((record) => ({ name: record.name, value: record.value })),
    context,
  );
  return {
    ...outcome,
    applied: records.length - missing.length,
    missing,
  };
}
