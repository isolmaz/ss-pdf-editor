/**
 * XFA data: the `datasets` packet and how a static form's AcroForm fields bind to it.
 *
 * An XFA form keeps its **data** apart from its **template**. Acrobat and every other
 * XFA-aware reader draw a form from the template and fill it from `xfa:datasets/xfa:data`;
 * the AcroForm widgets of a *static* XFA form are only the picture of that. So a tool that
 * changes a widget's `/V` and nothing else leaves the XFA data stale, and an XFA-aware
 * reader shows the old value (iText, SetaPDF and PDFBox document the same trap). This file
 * is the pure half of the fix — XML in, XML out, no PDF engine — so it runs in Node.
 *
 * What the binding follows is XFA's *normal* data binding, the one Designer produces:
 *
 *  - an AcroForm field is named by its SOM path (`form1[0].#subform[0].Name[0]`): a named
 *    segment is a template node, a `#subform` / `#pageSet` / `#area` segment is an unnamed
 *    container, and `[n]` is the occurrence among siblings of that name;
 *  - **named subforms create data groups, unnamed ones and areas do not**: the data node of
 *    `form1[0].#subform[0].Name[0]` is `form1/Name`;
 *  - a field's value is the text of its data node; a check box stores the template's *on*
 *    or *off* item, a radio group stores the on item of the chosen button, a list stores the
 *    saved item.
 *
 * What it does **not** follow, and says so instead of guessing (`skipped` in the plan): a
 * field with `<bind match="none">`, `global` or an explicit `dataRef`; a numeric or date
 * field whose display picture cannot be reversed here; a value whose data node is a group.
 * Those fields keep whatever the data held.
 */

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

/** The AcroForm field kinds the binding understands (`FormFieldKind` of `forms.ts`). */
export type XfaFieldKind = 'text' | 'checkbox' | 'dropdown' | 'radio' | 'optionlist' | 'signature' | 'other';

/** One AcroForm terminal field as the sync sees it. */
export interface XfaFieldSnapshot {
  /** Fully qualified AcroForm name — the SOM path. */
  readonly name: string;
  readonly kind: XfaFieldKind;
  /** `/V` as text for text and choice fields; `null` when unset. */
  readonly text: string | null;
  /** For a check box or radio button: whether this widget is on. `null` otherwise. */
  readonly on: boolean | null;
}

/** One step of a data path: a node name and its occurrence among same-named siblings. */
export interface DataStep {
  readonly name: string;
  readonly index: number;
}

export type SkipReason =
  | 'no-binding'
  | 'global-binding'
  | 'data-ref'
  | 'formatted'
  | 'data-group'
  | 'unmapped';

export interface XfaBinding {
  readonly name: string;
  readonly kind: XfaFieldKind;
  /** The data node the field's value lives in, `null` when it has none we can address. */
  readonly path: readonly DataStep[] | null;
  /** The reason the field is not mirrored, when `path` is `null`. */
  readonly skip: SkipReason | null;
  /** What the template stores for a check box / radio button: on and off item texts. */
  readonly on: string | null;
  readonly off: string | null;
  /** A radio button's group: the buttons of one `exclGroup` share a data node. */
  readonly group: string | null;
  /** A date picture (`DD/MM/YYYY`) when the template formats the field as a date. */
  readonly datePicture: string | null;
}

export interface SyncSkip {
  readonly name: string;
  readonly reason: SkipReason;
}

export interface SyncPlan {
  /** The new datasets text; `null` when nothing needs to change. */
  readonly xml: string | null;
  /** Fields whose data node was written. */
  readonly changed: readonly string[];
  /** Fields that were bound but already held the same data. */
  readonly unchanged: number;
  readonly skipped: readonly SyncSkip[];
}

// ---------------------------------------------------------------------------
// XML plumbing
// ---------------------------------------------------------------------------

/**
 * `null` when the text is not well-formed XML. A packet read from a document is parsed
 * leniently (a producer's quirk must not stop the sync); `strict` is for a file the user
 * hands in, where a mismatched tag means the file is not what it claims to be.
 */
export function parseXml(text: string, strict = false): Document | null {
  let failed = false;
  const parser = new DOMParser({
    // xmldom 0.8 calls a two-argument handler as `(level, message)`; the message is unused.
    errorHandler: (level: string, _message: string) => {
      if (level === 'fatalError' || level === 'error' || (strict && level === 'warning')) failed = true;
    },
  } as never);
  try {
    const document = parser.parseFromString(text, 'application/xml') as unknown as Document;
    return failed || document.documentElement === null ? null : document;
  } catch {
    return null;
  }
}

export function serializeNode(node: Node): string {
  return new XMLSerializer().serializeToString(node as never);
}

/** Element children with this local name. */
function childElements(parent: Node, name?: string): Element[] {
  const out: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === 1 && (name === undefined || (node as Element).localName === name)) {
      out.push(node as Element);
    }
  }
  return out;
}

/** An XFA packet is identified by its namespace prefix family; the version varies. */
function inNamespace(element: Element, family: string): boolean {
  return (element.namespaceURI ?? '').startsWith(`http://www.xfa.org/schema/${family}/`);
}

/**
 * Decode a packet's bytes: UTF-16 with a byte-order mark, otherwise UTF-8 (the encoding
 * Designer writes). Anything else would have to be named in the XML declaration, and a
 * packet that does is rare enough to be read as UTF-8 and reported by the parse.
 */
export function decodePacket(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** The text written back is UTF-8, so a declaration that says otherwise must not stay. */
export function encodePacket(text: string): Uint8Array {
  const declared = text.replace(/^(\s*<\?xml[^>]*?)encoding\s*=\s*(["'])[^"']*\2/, '$1encoding="UTF-8"');
  return new TextEncoder().encode(declared);
}

/** The `xfa:data` element of a datasets document, or `null`. */
export function dataElementOf(datasets: Document): Element | null {
  const root = datasets.documentElement;
  if (root.localName === 'data' && inNamespace(root, 'xfa-data')) return root;
  return childElements(root, 'data').find((element) => inNamespace(element, 'xfa-data')) ?? null;
}

/** The text of a data value node: its text children, joined. */
function textOf(node: Node): string {
  let out = '';
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    // A text or CDATA node always has a value: `nodeValue` is typed nullable for the other node types.
    if (child.nodeType === 3 || child.nodeType === 4) out += child.nodeValue as string;
    // A `<value>` child: a multi-select list stores one per selected item.
    else if (child.nodeType === 1 && (child as Element).localName === 'value') out += textOf(child);
  }
  return out;
}

function hasElementChildren(node: Node): boolean {
  return childElements(node).some((element) => element.localName !== 'value');
}

// ---------------------------------------------------------------------------
// the template
// ---------------------------------------------------------------------------

const TEMPLATE_CONTAINERS = new Set(['subform', 'subformSet', 'area', 'pageSet', 'pageArea', 'exclGroup']);

interface TemplateNode {
  readonly tag: string;
  readonly name: string | null;
  readonly element: Element;
  readonly children: TemplateNode[];
  readonly parent: TemplateNode | null;
}

function buildTemplate(element: Element, parent: TemplateNode | null): TemplateNode {
  const node: TemplateNode = {
    tag: element.localName,
    name: element.getAttribute('name') || null,
    element,
    children: [],
    parent,
  };
  if (TEMPLATE_CONTAINERS.has(node.tag) || node.tag === 'template') {
    for (const kid of childElements(element)) {
      if (TEMPLATE_CONTAINERS.has(kid.localName) || kid.localName === 'field') {
        node.children.push(buildTemplate(kid, node));
      }
    }
  }
  return node;
}

/** Split a SOM segment `name[3]` / `#subform[0]` / `name` into its parts. */
function parseSegment(segment: string): { name: string; index: number } {
  const occurrence = /\[(\d+)\]$/.exec(segment);
  if (occurrence === null) return { name: segment, index: 0 };
  return { name: segment.slice(0, occurrence.index), index: Number(occurrence[1]) };
}

/**
 * Split an AcroForm name into SOM segments. A dot inside `[...]` cannot occur in a SOM
 * index, so a plain split is exact; names the producer escaped are not handled.
 */
function somSegments(name: string): { name: string; index: number }[] {
  return name.split('.').map(parseSegment);
}

/** The template node a SOM path names, or `null` when a segment finds no node. */
function resolveTemplateNode(
  root: TemplateNode,
  segments: readonly { name: string; index: number }[],
): TemplateNode | null {
  let current: TemplateNode = root;
  // The first segment names the root subform itself.
  // `somSegments` always yields one segment at least (`''.split('.')` is `['']`).
  const first = segments[0] as { name: string; index: number };
  const top = root.children.find((kid) => kid.name === first.name && kid.tag === 'subform');
  if (top === undefined) return null;
  current = top;
  for (const segment of segments.slice(1)) {
    let next: TemplateNode | undefined;
    if (segment.name.startsWith('#')) {
      const tag = segment.name.slice(1);
      next = current.children.filter((kid) => kid.name === null && kid.tag === tag)[segment.index];
      // Indexes of unnamed containers count in the *form*, which may hold more of them
      // than the template; the first one is the answer when the index runs past.
      next ??= current.children.find((kid) => kid.name === null && kid.tag === tag);
    } else {
      next = current.children.find((kid) => kid.name === segment.name);
    }
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

function allNodes(root: TemplateNode, out: TemplateNode[] = []): TemplateNode[] {
  out.push(root);
  for (const kid of root.children) allNodes(kid, out);
  return out;
}

function itemTexts(field: Element): string[] {
  const items = childElements(field, 'items').find((element) => element.getAttribute('save') !== '1');
  if (items === undefined) return [];
  return childElements(items).map(textOf);
}

function pictureOf(field: Element): string | null {
  for (const holder of ['format', 'edit']) {
    const block = childElements(field, holder)[0];
    const picture = block === undefined ? undefined : childElements(block, 'picture')[0];
    const text = picture === undefined ? '' : textOf(picture).trim();
    if (text !== '') return text;
  }
  // The picture may also sit on the widget: `<ui><dateTimeEdit><picture>`.
  const ui = childElements(field, 'ui')[0];
  const editor = ui === undefined ? undefined : childElements(ui)[0];
  const picture = editor === undefined ? undefined : childElements(editor, 'picture')[0];
  const text = picture === undefined ? '' : textOf(picture).trim();
  return text === '' ? null : text;
}

/** The part of a picture inside `date{...}`, when it is a pure date picture. */
function datePictureOf(picture: string | null): string | null {
  if (picture === null || !picture.startsWith('date{') || !picture.endsWith('}')) return null;
  const inner = picture.slice('date{'.length, -1);
  return inner === '' || inner.includes('}') ? null : inner;
}

/** The bind mode of a template node: `normal` (the default), `none`, `global`, or a dataRef. */
function bindOf(node: TemplateNode): { match: string; ref: string | null } {
  const bind = childElements(node.element, 'bind')[0];
  return {
    match: bind?.getAttribute('match') || 'once',
    ref: bind?.getAttribute('ref') || null,
  };
}

/**
 * Bind every AcroForm field to its data node.
 *
 * `templateXml` is the `template` packet; with `null` (no template packet) every field is
 * bound by the shape of its name alone, which is what pdf.js does too. A field the
 * template resolves is bound through the template, so its on/off items, its bind mode and
 * its display picture are known.
 */
export function resolveBindings(
  templateXml: string | null,
  fields: readonly { readonly name: string; readonly kind: XfaFieldKind }[],
): XfaBinding[] {
  const document = templateXml === null ? null : parseXml(templateXml);
  const rootElement = document?.documentElement;
  const root = rootElement === undefined || rootElement === null ? null : buildTemplate(rootElement, null);
  const all = root === null ? [] : allNodes(root);
  return fields.map((field) => bindField(root, all, field));
}

function bindField(
  root: TemplateNode | null,
  all: readonly TemplateNode[],
  field: { readonly name: string; readonly kind: XfaFieldKind },
): XfaBinding {
  const segments = somSegments(field.name);
  const blank = { on: null, off: null, group: null, datePicture: null };
  let node = root === null ? null : resolveTemplateNode(root, segments);
  if (root !== null && node === null) {
    // The index of an unnamed container can run past the template: match by the field's
    // own name when exactly one template field carries it.
    // (`somSegments` yields one segment at least.)
    const leaf = (segments.at(-1) as { name: string }).name;
    const [only, ...others] = all.filter((candidate) => candidate.tag === 'field' && candidate.name === leaf);
    node = only !== undefined && others.length === 0 ? only : null;
  }

  if (node === null) {
    // No template to read: the shape of the name is the whole binding.
    const path = segments.filter((segment) => !segment.name.startsWith('#'));
    if (root !== null || path.length === 0 || field.kind === 'other') {
      return { name: field.name, kind: field.kind, path: null, skip: 'unmapped', ...blank };
    }
    return { name: field.name, kind: field.kind, path, skip: null, ...blank };
  }

  // Every ancestor and the node itself decides whether the data is addressable.
  for (let at: TemplateNode | null = node; at !== null; at = at.parent) {
    const { match, ref } = bindOf(at);
    if (match === 'none')
      return { name: field.name, kind: field.kind, path: null, skip: 'no-binding', ...blank };
    if (match === 'global') {
      return { name: field.name, kind: field.kind, path: null, skip: 'global-binding', ...blank };
    }
    if (match === 'dataRef' || ref !== null) {
      return { name: field.name, kind: field.kind, path: null, skip: 'data-ref', ...blank };
    }
  }

  // The data path is the named subforms above the node, then the node (or, for a radio
  // button, its exclusion group, which owns the value).
  const owner = node.parent !== null && node.parent.tag === 'exclGroup' ? node.parent : node;
  const chain: TemplateNode[] = [];
  for (let at: TemplateNode | null = owner; at !== null; at = at.parent) chain.unshift(at);
  const path: DataStep[] = [];
  for (const link of chain) {
    if (link.name === null) continue;
    if (link.tag !== 'subform' && link !== owner) continue;
    // The occurrence of a segment is the one the AcroForm name carries for that node.
    const matching = segments.find((segment) => segment.name === link.name);
    path.push({ name: link.name, index: matching?.index ?? 0 });
  }
  if (path.length === 0 || owner.name === null) {
    return { name: field.name, kind: field.kind, path: null, skip: 'unmapped', ...blank };
  }

  const items = node.tag === 'field' ? itemTexts(node.element) : [];
  const picture = node.tag === 'field' ? pictureOf(node.element) : null;
  const ui =
    node.tag === 'field' ? childElements(childElements(node.element, 'ui')[0] ?? node.element)[0] : null;
  const editor = ui?.localName ?? '';
  const datePicture = editor === 'dateTimeEdit' ? datePictureOf(picture) : null;
  // A picture changes what the widget shows but not what the data stores, and the
  // widget's `/V` is what was shown: only a date picture is reversed here.
  const formatted =
    (editor === 'dateTimeEdit' && datePicture === null) ||
    ((editor === 'numericEdit' || editor === 'textEdit') && picture !== null);
  if (formatted) return { name: field.name, kind: field.kind, path: null, skip: 'formatted', ...blank };

  return {
    name: field.name,
    kind: field.kind,
    path,
    skip: null,
    on: items[0] ?? null,
    off: items[1] ?? null,
    group: owner !== node ? owner.name : null,
    datePicture,
  };
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const PICTURE_TOKEN = /YYYY|YY|MM|M|DD|D/g;

/** `31/01/2024` in `DD/MM/YYYY` as the ISO date the data stores, or `null`. */
export function displayDateToIso(value: string, picture: string): string | null {
  const tokens = picture.match(PICTURE_TOKEN) ?? [];
  const pattern = picture
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(PICTURE_TOKEN, (token) =>
      token.length >= 2 && token !== 'YYYY' ? '(\\d{2})' : token === 'YYYY' ? '(\\d{4})' : '(\\d{1,2})',
    );
  const match = new RegExp(`^${pattern}$`).exec(value.trim());
  if (match === null) return null;
  let year = 0;
  let month = 0;
  let day = 0;
  for (const [position, token] of tokens.entries()) {
    const number = Number(match[position + 1]);
    if (token === 'YYYY') year = number;
    else if (token === 'YY') year = number < 70 ? 2000 + number : 1900 + number;
    else if (token.startsWith('M')) month = number;
    else day = number;
  }
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The reverse of {@link displayDateToIso}: an ISO data date as the form displays it. */
export function isoDateToDisplay(value: string, picture: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const [, year = '', month = '', day = ''] = match;
  return picture.replace(PICTURE_TOKEN, (token) => {
    switch (token) {
      case 'YYYY':
        return year;
      case 'YY':
        return year.slice(2);
      case 'MM':
        return month;
      case 'M':
        return String(Number(month));
      case 'DD':
        return day;
      default:
        return String(Number(day));
    }
  });
}

// ---------------------------------------------------------------------------
// reading and writing the data
// ---------------------------------------------------------------------------

/** The element at `path` below `data`, or `null`. */
function findDataNode(data: Element, path: readonly DataStep[]): Element | null {
  let current = data;
  for (const step of path) {
    const next = childElements(current, step.name)[step.index];
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

/** The element at `path` below `data`, the missing nodes along it made. */
function ensureDataNode(data: Element, path: readonly DataStep[]): Element {
  let current = data;
  for (const step of path) {
    const siblings = childElements(current, step.name);
    const existing = siblings[step.index];
    if (existing !== undefined) {
      current = existing;
      continue;
    }
    // `step.index` is past the last sibling, so the loop makes at least one node.
    let made = current;
    for (let count = siblings.length; count <= step.index; count += 1) {
      // A data node carries no namespace of its own: the datasets default is none.
      made = current.ownerDocument.createElementNS(null, step.name);
      current.appendChild(made);
    }
    current = made;
  }
  return current;
}

function setText(node: Element, value: string): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
  if (value !== '') node.appendChild(node.ownerDocument.createTextNode(value));
}

/** What a snapshot should be in the data, or `null` when the binding cannot say. */
function dataValueFor(binding: XfaBinding, snapshot: XfaFieldSnapshot): string | null {
  switch (binding.kind) {
    case 'text':
      if (snapshot.text === null) return '';
      if (binding.datePicture !== null) {
        return snapshot.text === '' ? '' : displayDateToIso(snapshot.text, binding.datePicture);
      }
      return snapshot.text;
    case 'dropdown':
    case 'optionlist':
      return snapshot.text ?? '';
    case 'checkbox':
      if (snapshot.on === true) return binding.on ?? snapshot.text ?? '1';
      // The template's off item; a template without one stores nothing for "off".
      return binding.off ?? '';
    case 'radio':
      return snapshot.on === true ? (binding.on ?? snapshot.text) : '';
    default:
      return null;
  }
}

/**
 * Work out what the datasets must say for the given AcroForm fields, and write it.
 *
 * `only` limits the sync to the fields a fill touched: the others are left exactly as the
 * data holds them, so a field whose display the template formats is not overwritten by a
 * fill of its neighbour.
 */
export function planSync(
  datasetsXml: string,
  bindings: readonly XfaBinding[],
  snapshots: readonly XfaFieldSnapshot[],
  only?: ReadonlySet<string>,
): SyncPlan | null {
  const document = parseXml(datasetsXml);
  if (document === null) return null;
  let data = dataElementOf(document);
  if (data === null) {
    const root = document.documentElement;
    data = document.createElementNS('http://www.xfa.org/schema/xfa-data/1.0/', 'xfa:data');
    root.appendChild(data);
  }

  const byName = new Map(snapshots.map((snapshot) => [snapshot.name, snapshot] as const));
  const changed: string[] = [];
  const skipped: SyncSkip[] = [];
  let unchanged = 0;

  // A radio group is one data node however many buttons it has: the chosen one decides.
  const groupValue = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.group === null || binding.path === null) continue;
    const snapshot = byName.get(binding.name);
    if (snapshot === undefined) continue;
    const key = `${binding.path.map((step) => `${step.name}[${step.index}]`).join('/')}#${binding.group}`;
    const value = snapshot.on === true ? (binding.on ?? snapshot.text ?? '') : '';
    if (!groupValue.has(key) || value !== '') groupValue.set(key, value);
  }

  for (const binding of bindings) {
    if (only !== undefined && !only.has(binding.name)) continue;
    const snapshot = byName.get(binding.name);
    if (snapshot === undefined) continue;
    if (binding.path === null) {
      if (binding.skip !== null && binding.skip !== 'unmapped')
        skipped.push({ name: binding.name, reason: binding.skip });
      continue;
    }
    let value: string | null;
    if (binding.group !== null) {
      const key = `${binding.path.map((step) => `${step.name}[${step.index}]`).join('/')}#${binding.group}`;
      // Set above for this very binding, whose snapshot exists.
      value = groupValue.get(key) as string;
    } else {
      value = dataValueFor(binding, snapshot);
    }
    if (value === null) {
      skipped.push({ name: binding.name, reason: binding.datePicture === null ? 'unmapped' : 'formatted' });
      continue;
    }
    const existing = findDataNode(data, binding.path);
    if (existing !== null && hasElementChildren(existing)) {
      skipped.push({ name: binding.name, reason: 'data-group' });
      continue;
    }
    const current = existing === null ? null : textOf(existing);
    if (current === value || (current === null && value === '')) {
      unchanged += 1;
      continue;
    }
    setText(existing ?? ensureDataNode(data, binding.path), value);
    changed.push(binding.name);
  }
  return { xml: changed.length === 0 ? null : serializeNode(document), changed, unchanged, skipped };
}

/** The value a bound field holds in the data, or `null` when its node is absent. */
export function readBoundValue(datasetsXml: string, binding: XfaBinding): string | null {
  if (binding.path === null) return null;
  const document = parseXml(datasetsXml);
  const data = document === null ? null : dataElementOf(document);
  const node = data === null ? null : findDataNode(data, binding.path);
  return node === null || hasElementChildren(node) ? null : textOf(node);
}

/** A data value as the AcroForm field takes it (the reverse of the write), or `null`. */
export function fillValueFor(
  binding: XfaBinding,
  dataValue: string,
): { readonly value: string | boolean } | null {
  switch (binding.kind) {
    case 'text':
      if (binding.datePicture !== null && dataValue !== '') {
        const display = isoDateToDisplay(dataValue, binding.datePicture);
        return display === null ? null : { value: display };
      }
      return { value: dataValue };
    case 'dropdown':
      return { value: dataValue };
    case 'checkbox':
      return {
        value: binding.on !== null ? dataValue === binding.on : dataValue !== '' && dataValue !== binding.off,
      };
    default:
      return null;
  }
}

/** Every `(path, text)` leaf of the data, for a count and for tests; groups are walked. */
export function dataEntries(datasetsXml: string): { readonly path: string; readonly value: string }[] {
  const document = parseXml(datasetsXml);
  const data = document === null ? null : dataElementOf(document);
  if (data === null) return [];
  const out: { path: string; value: string }[] = [];
  const walk = (node: Element, prefix: string): void => {
    for (const kid of childElements(node)) {
      const path = `${prefix}/${kid.localName}`;
      if (hasElementChildren(kid)) walk(kid, path);
      else out.push({ path: path.slice(1), value: textOf(kid) });
    }
  };
  walk(data, '');
  return out;
}

// ---------------------------------------------------------------------------
// import and export of the data file
// ---------------------------------------------------------------------------

/**
 * The data a file carries, as the markup of `xfa:data`'s children — whatever it is wrapped
 * in: a bare data document (`<form1>…`), an `xfa:data` element, an `xfa:datasets` packet or
 * a whole XDP. `null` when the file is not XML or holds no data.
 */
export function dataMarkupOf(xml: string): string | null {
  const document = parseXml(xml, true);
  if (document === null) return null;
  const root = document.documentElement;
  let holder: Element | null = null;
  if (root.localName === 'data' && inNamespace(root, 'xfa-data')) holder = root;
  else if (root.localName === 'datasets') holder = dataElementOf(document);
  else if (root.localName === 'xdp') {
    const datasets = childElements(root, 'datasets')[0];
    holder = datasets === undefined ? null : (childElements(datasets, 'data')[0] ?? null);
  }
  if (holder === null) {
    // A packet or an XDP without `xfa:data` holds no data; only a bare data document is the data itself.
    if (root.localName === 'datasets' || root.localName === 'xdp') return null;
    // A bare data document: its root element is the data itself.
    return childElements(root).length === 0 && textOf(root) === '' ? null : serializeNode(root);
  }
  const kids = childElements(holder);
  return kids.length === 0 ? null : kids.map(serializeNode).join('');
}

/** The data of a datasets packet as a standalone XML file (what "export data" writes). */
export function exportDataXml(datasetsXml: string): string | null {
  const document = parseXml(datasetsXml);
  const data = document === null ? null : dataElementOf(document);
  if (data === null) return null;
  const kids = childElements(data);
  if (kids.length === 0) return null;
  const body = kids.map(serializeNode).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}\n`;
}

/** Replace the children of `xfa:data` with imported markup; `null` when it is not XML. */
export function replaceData(datasetsXml: string, markup: string): string | null {
  const target = parseXml(datasetsXml);
  const data = target === null ? null : dataElementOf(target);
  if (target === null || data === null) return null;
  const imported = parseXml(`<holder>${markup}</holder>`);
  if (imported === null) return null;
  while (data.firstChild !== null) data.removeChild(data.firstChild);
  for (const kid of childElements(imported.documentElement)) {
    data.appendChild(target.importNode(kid, true));
  }
  return serializeNode(target);
}
