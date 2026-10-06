/**
 * Sanitise a document in one step: remove what a PDF carries that its pages do not show —
 * scripts, attached files, metadata, private application data, thumbnails, hidden layers —
 * and, when asked, what the reader may not want to hand on: external links, comments, form
 * fields. Acrobat's "Sanitize Document", with the report Acrobat does not give: **what was
 * found and removed, per category, and proof that it is gone.**
 *
 * **One sweep, two uses.** `sweep()` walks every object of the document
 * (`sanitize-graph.ts`: reached or not) and, for each selected category, counts what it
 * finds — and, when `mutate` is set, removes it. The operation runs it mutating on the input,
 * saves, **re-opens the produced bytes and runs the very same sweep read-only**: every
 * selected category must count zero in the output, or the operation throws
 * `verification-failed` and returns nothing. Found and removed are therefore measured, not
 * assumed: `removed` is what the first sweep counted, `left` is what the second still finds.
 * (A counter and a remover that disagree about what a "script" is would pass each other;
 * they cannot, being one function.)
 *
 * **Actions, decided per type** (ISO 32000-1 §12.6.4). Everything is judged where an action
 * hangs: `/A` and `/PA` of annotations, outline items and fields, `/AA` of the catalog, pages,
 * annotations and fields, the catalog's `/OpenAction`, and the `/Next` chain behind each.
 *
 *  - **JavaScript, Launch, ImportData, SubmitForm, Rendition, RichMediaExecute** and a **URI
 *    that is a `file:` address** run code, start a program, read a file or send the form's data
 *    somewhere: removed under "scripts and active actions" (default on).
 *  - **URI** to anything else, **GoToR** and **GoToE** (a destination in *another* file) reach
 *    outside the document: removed under "external links" (default off — a link is content).
 *  - **GoTo, Named, Hide, ResetForm, SetOCGState, Thread, Trans, Movie, Sound** stay: they act
 *    inside the document or play media without running code.
 *  An action that goes takes its whole `/Next` chain with it; one that stays has the doomed
 *  actions cut out of its chain. A Link annotation whose *external* action went and that has no
 *  other destination is removed with it (a dead rectangle with a border is not "sanitised");
 *  one whose *script* went stays, so the page does not change.
 *
 * **What goes with each category**
 *  - scripts: the actions above; `/Names /JavaScript`; XFA packets that contain `<script`
 *    (the XFA is dropped whole — a script cannot be cut out of XML this module does not edit).
 *  - files: `/EF` of every file specification (so the payload stream is no longer reachable),
 *    `/Names /EmbeddedFiles`, every `/AF`, and file-attachment annotations.
 *  - metadata: every Info key but the producer line (product policy: `metadata.ts`), and every
 *    `/Metadata` entry — catalog, pages, XObjects, fonts — that is an XMP packet.
 *  - private data: `/PieceInfo` (and its `/LastModified`), the web-capture `/SpiderInfo` and
 *    `/Names /IDS` `/URLS`. thumbnails: every `/Thumb`.
 *  - comments: the markup annotations (everything but links, widgets, file attachments,
 *    printer's marks, watermarks and media) and their popups.
 *  - forms: *flatten* bakes each field into the page through `flattenForm` (the form writer's
 *    own flatten, which draws a missing appearance first) and then drops what is left of the
 *    `/AcroForm`; *remove* deletes the widgets and the form without drawing anything.
 *  - hidden layers: `sanitize-layers.ts`.
 *  - unused objects: the save's garbage collection, which always runs (removed objects are
 *    freed by it); reported with the count the input held.
 *
 * **Not done, said plainly.** There is no category for Acrobat's *embedded search index*: its
 * place in the file is not specified publicly, so it is not targeted by name — whatever it is
 * stored as falls under attachments, private data or unused objects. 3D and RichMedia
 * annotations can carry scripts of their own that this module does not read; they are
 * reported, not edited. A **signature** does not survive any rewrite and the report says so.
 *
 * **The picture does not change** unless the selection changes it. When nothing selected
 * draws (scripts, files, metadata, private data, thumbnails, hidden layers), every page — up
 * to 40, evenly spread — is rendered before and after at the same scale and compared pixel
 * for pixel; a difference is `verification-failed`.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError, openPdf } from '../engines/mupdf';
import {
  openForWrite,
  PRODUCER_LINE,
  readName,
  readText,
  saveRewrite,
  type WritableDocument,
} from '../engines/mupdf-write';
import { type FormFieldKind, flattenForm, readFormFields } from './forms';
import {
  arrayUnder,
  catalogOf,
  deref,
  dictionaryUnder,
  entriesOf,
  forEachDictionary,
  keysOf,
  liveObject,
  reachableObjects,
  referencesInside,
} from './sanitize-graph';
import { type LayerSweep, sweepHiddenLayers } from './sanitize-layers';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export type SanitizeCategory =
  | 'javascript'
  | 'files'
  | 'metadata'
  | 'private'
  | 'thumbnails'
  | 'links'
  | 'comments'
  | 'forms'
  | 'layers'
  | 'unused';

export type SanitizeFormsMode = 'keep' | 'flatten' | 'remove';

export interface SanitizeOptions {
  /** JavaScript and the actions that run code, start programs or send data. */
  readonly javascript: boolean;
  readonly files: boolean;
  readonly metadata: boolean;
  /** `/PieceInfo` and web-capture data. */
  readonly privateData: boolean;
  readonly thumbnails: boolean;
  /** Links and actions that leave the document (URI, remote destinations). */
  readonly links: boolean;
  /** Markup annotations and their popups. */
  readonly comments: boolean;
  readonly forms: SanitizeFormsMode;
  readonly layers: boolean;
}

/** The defaults the dialog opens with: what hides things, on; what is content, off. */
export const DEFAULT_SANITIZE_OPTIONS: SanitizeOptions = {
  javascript: true,
  files: true,
  metadata: true,
  privateData: true,
  thumbnails: true,
  links: false,
  comments: false,
  forms: 'keep',
  layers: true,
};

export interface SanitizeCount {
  readonly category: SanitizeCategory;
  /** What the sweep of the input counted. */
  readonly found: number;
  /** What the sweep of the output no longer finds. */
  readonly removed: number;
  /** What the output still holds: zero for every category but hidden layers and forms. */
  readonly left: number;
}

export interface SanitizeOutcome extends OperationOutcome {
  readonly counts: readonly SanitizeCount[];
}

/** The annotation subtypes that are comments: markup the reader added to the page. */
const COMMENT_SUBTYPES: ReadonlySet<string> = new Set([
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Redact',
]);

/** Actions that run code, start a program, read a file or send form data. */
const ACTIVE_ACTIONS: ReadonlySet<string> = new Set([
  'JavaScript',
  'Launch',
  'ImportData',
  'SubmitForm',
  'Rendition',
  'RichMediaExecute',
]);

/** Actions that name a destination outside the document. */
const EXTERNAL_ACTIONS: ReadonlySet<string> = new Set(['GoToR', 'GoToE']);

/** The chain behind one action is followed this deep, so a loop cannot run away. */
const ACTION_DEPTH = 24;

/** Pages rendered for the before/after comparison, at most. */
const RENDER_SAMPLE = 40;
/** The long side of a comparison render, in pixels. */
const RENDER_SIDE = 640;

type ActionKind = 'active' | 'external' | 'safe';

function actionKind(action: PDFObject): ActionKind {
  const type = readName(action.get('S'));
  if (type === null) return 'safe';
  if (ACTIVE_ACTIONS.has(type)) return 'active';
  if (EXTERNAL_ACTIONS.has(type)) return 'external';
  if (type === 'URI') {
    // A `file:` address opens a local file: that is not a link to the outside world.
    return /^\s*file:/i.test(readText(action.get('URI')) ?? '') ? 'active' : 'external';
  }
  return 'safe';
}

interface Tally {
  javascript: number;
  links: number;
  files: number;
  metadata: number;
  privateData: number;
  thumbnails: number;
  comments: number;
  forms: number;
}

/** What one sweep found, over the whole document. */
interface SweepResult {
  readonly tally: Tally;
  readonly layers: LayerSweep | null;
  /** Objects present in the file that the trailer cannot reach. */
  readonly unused: number;
  readonly objects: number;
  readonly unreadable: number;
  readonly signed: boolean;
  /** 3D and RichMedia annotations: they can hold scripts this module does not read. */
  readonly media: number;
  /** File attachment annotations drawn on a page (removing one changes the page). */
  readonly attachmentIcons: number;
  readonly xfaDropped: boolean;
  /** Whether a `/AcroForm` remains (after a mutating sweep: one that stays on purpose). */
  readonly acroForm: boolean;
}

/** How many entries a name tree lists, following `/Kids`. */
function nameTreeEntries(node: PDFObject, depth = 0): number {
  if (depth > ACTION_DEPTH) return 0;
  let count = 0;
  const names = arrayUnder(node, 'Names');
  if (names !== null) count += Math.floor(names.length / 2);
  const kids = arrayUnder(node, 'Kids');
  if (kids !== null) {
    for (const kid of entriesOf(kids)) {
      const child = deref(kid);
      if (child?.isDictionary() === true) count += nameTreeEntries(child, depth + 1);
    }
  }
  return count;
}

/** XFA packets (the form's XML) that contain a `<script`. */
function xfaScripts(form: PDFObject): { readonly packets: number; readonly present: boolean } {
  const entry = form.get('XFA');
  const value = deref(entry);
  if (value === null) return { packets: 0, present: false };
  const streams: PDFObject[] = [];
  if (!entry.isIndirect() || !entry.isStream()) {
    if (value.isArray()) {
      // `[name stream name stream …]`: the packets are the odd entries.
      for (const [index, item] of entriesOf(value).entries()) if (index % 2 === 1) streams.push(item);
    }
  } else {
    streams.push(entry);
  }
  let packets = 0;
  for (const stream of streams) {
    if (!stream.isStream()) continue;
    const buffer = stream.readStream();
    try {
      if (/<script/i.test(new TextDecoder('latin1').decode(buffer.asUint8Array()))) packets += 1;
    } finally {
      buffer.destroy();
    }
  }
  return { packets, present: true };
}

/**
 * Count — and, with `mutate`, remove — everything the selection names. See the file header.
 * The order matters only in that unused objects are counted before anything is freed.
 */
function sweep(
  doc: PDFDocument,
  options: SanitizeOptions,
  mutate: boolean,
  signal?: AbortSignal,
): SweepResult {
  const tally: Tally = {
    javascript: 0,
    links: 0,
    files: 0,
    metadata: 0,
    privateData: 0,
    thumbnails: 0,
    comments: 0,
    forms: 0,
  };

  // Objects nothing reaches, counted on the document as it came.
  const reachability = reachableObjects(doc, undefined, signal);

  /** Link annotations whose external action went and that have nothing else to follow. */
  const inertLinks = new Set<string>();
  const efHolders = new Set<number>();
  const attachmentSpecs: number[] = [];
  let efCount = 0;
  let bareAttachments = 0;
  /** Object-stream and xref-stream containers, and what they point at (their `/Length`): file plumbing, not garbage. */
  const plumbing = new Set<number>();
  let signed = false;

  /** One action slot (`owner[key]`): `true` when the action there is gone. */
  const visitAction = (owner: PDFObject, key: string | number, holder: number, depth: number): boolean => {
    const action = deref(owner.get(key));
    if (action === null || !action.isDictionary()) return false;
    const kind = actionKind(action);
    const doomed = kind === 'active' ? options.javascript : kind === 'external' ? options.links : false;
    if (doomed) {
      // The action and every doomed action in the chain behind it go together.
      let node: PDFObject | null = action;
      for (let step = 0; node !== null && step < ACTION_DEPTH; step += 1) {
        const nodeKind = actionKind(node);
        if (nodeKind === 'active' && options.javascript) tally.javascript += 1;
        else if (nodeKind === 'external' && options.links) tally.links += 1;
        const next = deref(node.get('Next'));
        if (next?.isArray() === true) {
          for (const item of entriesOf(next)) {
            const chained = deref(item);
            if (chained?.isDictionary() === true) {
              const chainedKind = actionKind(chained);
              if (chainedKind === 'active' && options.javascript) tally.javascript += 1;
              else if (chainedKind === 'external' && options.links) tally.links += 1;
            }
          }
          node = null;
        } else {
          node = next?.isDictionary() === true ? next : null;
        }
      }
      if (mutate) {
        owner.delete(key);
        if (
          (kind === 'external' || options.links) &&
          key === 'A' &&
          readName(owner.get('Subtype')) === 'Link' &&
          owner.get('A').isNull() &&
          owner.get('Dest').isNull() &&
          owner.get('PA').isNull()
        ) {
          inertLinks.add(`${holder}:${owner.get('Rect').toString()}`);
        }
      }
      return true;
    }
    if (depth >= ACTION_DEPTH) return false;
    const next = deref(action.get('Next'));
    if (next?.isArray() === true) {
      for (let index = next.length - 1; index >= 0; index -= 1) visitAction(next, index, holder, depth + 1);
    } else if (next?.isDictionary() === true) {
      visitAction(action, 'Next', holder, depth + 1);
    }
    return false;
  };

  const actionsWanted = options.javascript || options.links;
  const stats = forEachDictionary(
    doc,
    (dictionary, holder) => {
      const type = readName(dictionary.get('Type'));
      if (type === 'ObjStm' || type === 'XRef') {
        plumbing.add(holder);
        referencesInside(dictionary, (number) => plumbing.add(number));
      }
      for (const key of keysOf(dictionary)) {
        switch (key) {
          case 'A':
          case 'PA':
          case 'OpenAction':
            if (actionsWanted) visitAction(dictionary, key, holder, 0);
            break;
          case 'AA': {
            if (!actionsWanted) break;
            const additional = deref(dictionary.get('AA'));
            if (additional?.isDictionary() === true) {
              for (const trigger of keysOf(additional)) visitAction(additional, trigger, holder, 0);
            }
            break;
          }
          case 'EF':
            if (options.files && deref(dictionary.get('EF'))?.isDictionary() === true) {
              efCount += 1;
              efHolders.add(holder);
              if (mutate) {
                dictionary.delete('EF');
                dictionary.delete('RF');
              }
            }
            break;
          case 'AF':
            if (options.files && mutate) dictionary.delete('AF');
            break;
          case 'Metadata':
            if (options.metadata) {
              tally.metadata += 1;
              if (mutate) dictionary.delete('Metadata');
            }
            break;
          case 'PieceInfo':
            if (options.privateData) {
              tally.privateData += 1;
              if (mutate) {
                dictionary.delete('PieceInfo');
                dictionary.delete('LastModified');
              }
            }
            break;
          case 'SpiderInfo':
            if (options.privateData) {
              tally.privateData += 1;
              if (mutate) dictionary.delete('SpiderInfo');
            }
            break;
          case 'Thumb':
            if (options.thumbnails) {
              tally.thumbnails += 1;
              if (mutate) dictionary.delete('Thumb');
            }
            break;
          case 'ByteRange':
            signed = true;
            break;
          case 'Subtype':
            // An attachment annotation whose file is not embedded still has to be counted;
            // its file specification is judged before the traversal reaches (and strips) it.
            if (options.files && readName(dictionary.get('Subtype')) === 'FileAttachment') {
              const spec = dictionary.get('FS');
              if (spec.isIndirect()) {
                attachmentSpecs.push(spec.asIndirect());
              } else {
                const direct = deref(spec);
                if (direct?.isDictionary() !== true || direct.get('EF').isNull()) bareAttachments += 1;
              }
            }
            break;
          default:
            break;
        }
      }
    },
    signal,
  );
  tally.files = efCount + bareAttachments + attachmentSpecs.filter((spec) => !efHolders.has(spec)).length;

  // ---- the catalog and the trailer -------------------------------------------------------
  const catalog = catalogOf(doc);
  const names = dictionaryUnder(catalog, 'Names');
  if (options.javascript) {
    const tree = dictionaryUnder(names, 'JavaScript');
    if (tree !== null) {
      tally.javascript += nameTreeEntries(tree);
      if (mutate) names?.delete('JavaScript');
    }
  }
  if (options.files && names?.get('EmbeddedFiles').isNull() === false && mutate)
    names.delete('EmbeddedFiles');
  if (options.privateData) {
    for (const key of ['IDS', 'URLS']) {
      if (names?.get(key).isNull() === false) {
        tally.privateData += 1;
        if (mutate) names.delete(key);
      }
    }
  }
  if (options.links && catalog?.get('URI').isNull() === false) {
    tally.links += 1;
    if (mutate) catalog.delete('URI');
  }
  if (options.metadata) {
    const info = dictionaryUnder(doc.getTrailer(), 'Info');
    if (info !== null) {
      for (const key of keysOf(info)) {
        // The producer line is the product's own; `metadata.ts` keeps it for the same reason.
        if (key === 'Producer') continue;
        tally.metadata += 1;
        if (mutate) info.delete(key);
      }
    }
  }
  let xfaDropped = false;
  const form = dictionaryUnder(catalog, 'AcroForm');
  if (form !== null) {
    const xfa = xfaScripts(form);
    if (options.javascript) tally.javascript += xfa.packets;
    // A form that is flattened or removed has no use for its XML; one with scripts goes whole.
    if (xfa.present && ((options.javascript && xfa.packets > 0) || options.forms !== 'keep')) {
      xfaDropped = true;
      if (mutate) form.delete('XFA');
    }
  }

  // ---- the page annotations --------------------------------------------------------------
  let media = 0;
  let attachmentIcons = 0;
  let widgetsLeft = 0;
  const pages = doc.countPages();
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    if (signal !== undefined) throwIfAborted(signal);
    const page = doc.findPage(pageIndex);
    const pageNumber = page.isIndirect() ? page.asIndirect() : -1;
    const annotations = arrayUnder(page, 'Annots');
    if (annotations === null) continue;
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      const entry = annotations.get(index);
      const annotation = deref(entry);
      if (annotation === null || !annotation.isDictionary()) continue;
      const subtype = readName(annotation.get('Subtype'));
      let drop = false;
      if (subtype === 'Widget') {
        if (options.forms !== 'keep') tally.forms += 1;
        if (options.forms === 'remove') drop = true;
        else widgetsLeft += 1;
      } else if (subtype === 'FileAttachment') {
        if (options.files) {
          drop = true;
          attachmentIcons += 1;
        }
      } else if (subtype === 'Popup') {
        drop = options.comments;
      } else if (subtype !== null && COMMENT_SUBTYPES.has(subtype)) {
        if (options.comments) {
          tally.comments += 1;
          drop = true;
        }
      } else if (subtype === 'Link') {
        const holder = entry.isIndirect() ? entry.asIndirect() : pageNumber;
        drop = inertLinks.has(`${holder}:${annotation.get('Rect').toString()}`);
      } else if (subtype === 'RichMedia' || subtype === '3D') {
        media += 1;
      }
      if (drop && mutate) {
        annotations.delete(index);
        if (entry.isIndirect()) doc.deleteObject(entry.asIndirect());
      }
    }
  }
  // What is left of a form nothing draws any more is dropped with it.
  if (
    mutate &&
    form !== null &&
    (options.forms === 'remove' || (options.forms === 'flatten' && widgetsLeft === 0))
  ) {
    catalog?.delete('AcroForm');
  }

  const layers = options.layers ? sweepHiddenLayers(doc, mutate, signal) : null;
  let plumbingUnreached = 0;
  for (const number of plumbing) {
    const object = liveObject(doc, number);
    if (!reachability.reached.has(number) && object !== null && object !== 'unreadable')
      plumbingUnreached += 1;
  }
  const unused = Math.max(0, stats.live - plumbingUnreached - reachability.liveReached);
  return {
    tally,
    layers,
    unused,
    objects: stats.live,
    unreadable: stats.unreadable + reachability.unreadable,
    signed,
    media,
    attachmentIcons,
    xfaDropped,
    acroForm: dictionaryUnder(catalogOf(doc), 'AcroForm') !== null,
  };
}

/* ------------------------------------------------------------------ *
 * Pictures: the page does not change unless the selection changes it
 * ------------------------------------------------------------------ */

/** Pages compared: all of a short document, 40 evenly spread of a long one, first and last included. */
function sampledPages(pageCount: number): readonly number[] {
  if (pageCount <= RENDER_SAMPLE) return Array.from({ length: pageCount }, (_unused, index) => index);
  const pages = new Set<number>();
  for (let index = 0; index < RENDER_SAMPLE; index += 1) {
    pages.add(Math.round((index * (pageCount - 1)) / (RENDER_SAMPLE - 1)));
  }
  return [...pages];
}

/** FNV-1a over the pixels, twice with different seeds: a changed pixel changes both. */
function digest(pixels: Uint8ClampedArray): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index] as number;
    first = Math.imul(first ^ value, 0x01000193);
    second = Math.imul(second + value + 1, 0x9e3779b1) ^ (second >>> 15);
  }
  return `${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

/** One digest per sampled page; `null` for a page the engine could not draw. */
function renderDigests(
  opened: WritableDocument,
  pages: readonly number[],
  signal: AbortSignal,
): readonly (string | null)[] {
  const { mupdf, doc } = opened;
  const result: (string | null)[] = [];
  for (const index of pages) {
    throwIfAborted(signal);
    try {
      const page = doc.loadPage(index);
      try {
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.getBounds();
        const scale = Math.min(1, RENDER_SIDE / Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0)));
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        );
        try {
          result.push(digest(pixmap.getPixels()));
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    } catch {
      // A page MuPDF cannot draw cannot be compared either; it is left out, and counted.
      result.push(null);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------ */

/** Step ids this operation reports (declared in `apps/web/src/operations.ts`). */
const CATEGORY_STEP: Readonly<Record<Exclude<SanitizeCategory, 'unused'>, string>> = {
  javascript: 'sanitize.javascript',
  files: 'sanitize.files',
  metadata: 'sanitize.metadata',
  private: 'sanitize.private',
  thumbnails: 'sanitize.thumbnails',
  links: 'sanitize.links',
  comments: 'sanitize.comments',
  forms: 'sanitize.forms',
  layers: 'sanitize.layers',
};

function selectedCategories(options: SanitizeOptions): readonly Exclude<SanitizeCategory, 'unused'>[] {
  const selected: Exclude<SanitizeCategory, 'unused'>[] = [];
  if (options.javascript) selected.push('javascript');
  if (options.files) selected.push('files');
  if (options.metadata) selected.push('metadata');
  if (options.privateData) selected.push('private');
  if (options.thumbnails) selected.push('thumbnails');
  if (options.layers) selected.push('layers');
  if (options.links) selected.push('links');
  if (options.comments) selected.push('comments');
  if (options.forms !== 'keep') selected.push('forms');
  return selected;
}

const FLATTENABLE: readonly FormFieldKind[] = ['text', 'checkbox', 'dropdown', 'radio', 'optionlist'];

function verificationFailure(message: string): ToolError {
  return new ToolError('verification-failed', { engine: 'mupdf', engineMessage: `sanitize: ${message}` });
}

function countOf(result: SweepResult, category: Exclude<SanitizeCategory, 'unused'>): number {
  switch (category) {
    case 'javascript':
      return result.tally.javascript;
    case 'files':
      return result.tally.files;
    case 'metadata':
      return result.tally.metadata;
    case 'private':
      return result.tally.privateData;
    case 'thumbnails':
      return result.tally.thumbnails;
    case 'links':
      return result.tally.links;
    case 'comments':
      return result.tally.comments;
    case 'forms':
      return result.tally.forms;
    case 'layers':
      return result.layers?.found ?? 0;
  }
}

/** What the sweep could actually take out: hidden layer content that stays is not removable. */
function removableOf(result: SweepResult, category: Exclude<SanitizeCategory, 'unused'>): number {
  return category === 'layers'
    ? (result.layers?.found ?? 0) - (result.layers?.left ?? 0)
    : countOf(result, category);
}

/**
 * Flatten what can be flattened before the sweep: the form writer's own flatten, over the
 * fields it supports (push buttons and signature fields it refuses stay, and are reported).
 */
async function flattenFields(
  bytes: Uint8Array,
  context: OperationContext,
): Promise<{ readonly bytes: Uint8Array; readonly steps: readonly string[]; readonly fields: number }> {
  const fields = await readFormFields(bytes, context.signal);
  const names = fields
    .filter((field) => FLATTENABLE.includes(field.kind) && field.pageIndex !== null)
    .map((field) => field.name);
  if (names.length === 0) return { bytes, steps: [], fields: fields.length };
  const flattened = await flattenForm(bytes, names, context);
  return { bytes: flattened.bytes, steps: flattened.report.steps, fields: fields.length };
}

/**
 * The sweep, read-only, on the bytes as they came in. Flattening runs before the mutating
 * sweep, so that sweep sees a document whose form scripts are already gone with their
 * widgets; the report counts what the *input* held.
 */
async function sweepInput(
  bytes: Uint8Array,
  options: SanitizeOptions,
  signal: AbortSignal,
): Promise<SweepResult> {
  const { doc } = await openForWrite(bytes);
  try {
    return sweep(doc, options, false, signal);
  } catch (error) {
    if (error instanceof ToolError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw mapMupdfError(error, 'sanitize input');
  } finally {
    doc.destroy();
  }
}

/** An XFA form cannot be flattened (the writer refuses it): its XML is dropped first. */
async function withoutXfa(bytes: Uint8Array): Promise<Uint8Array> {
  const opened = await openForWrite(bytes);
  try {
    const form = dictionaryUnder(catalogOf(opened.doc), 'AcroForm');
    if (form === null || form.get('XFA').isNull()) return bytes;
    form.delete('XFA');
    return saveRewrite(opened.doc, 'sanitize.xfa');
  } catch (error) {
    throw mapMupdfError(error, 'sanitize.xfa');
  } finally {
    opened.doc.destroy();
  }
}

const PROGRESS_LABEL = {
  scan: 'op.progress.sanitize.scan',
  save: 'op.progress.sanitize.save',
  verify: 'op.progress.sanitize.verify',
  render: 'op.progress.sanitize.render',
} as const;

export async function sanitizeDocument(
  bytes: Uint8Array,
  options: SanitizeOptions,
  context: OperationContext,
): Promise<SanitizeOutcome> {
  throwIfAborted(context.signal);
  const progress = (phase: keyof typeof PROGRESS_LABEL, done: number): void =>
    context.onProgress?.({ phase, labelKey: PROGRESS_LABEL[phase], done, total: 4 });
  progress('scan', 0);

  const selected = selectedCategories(options);
  const steps: string[] = ['load'];
  const notes: OperationNote[] = [];

  // ---- forms to flatten go first: the writer works on the document as it came ------------
  let working = bytes;
  let formFieldsBefore = 0;
  if (options.forms === 'flatten') {
    working = await withoutXfa(working);
    const flattened = await flattenFields(working, context);
    working = flattened.bytes;
    formFieldsBefore = flattened.fields;
    for (const step of flattened.steps) if (!steps.includes(step)) steps.push(step);
  } else if (options.forms === 'remove') {
    formFieldsBefore = (await readFormFields(working, context.signal)).length;
  }

  const opened = await openForWrite(working);
  const { doc, mupdf } = opened;
  let out: Uint8Array;
  let found: SweepResult;
  let pageCount: number;
  try {
    try {
      found = sweep(doc, options, true, context.signal);
      pageCount = doc.countPages();
      // A file whose page tree MuPDF could not recover would come out as an empty shell.
      if (pageCount === 0) {
        throw new ToolError('corrupt-document', {
          engine: 'mupdf',
          engineMessage: 'sanitize: the document has no pages',
        });
      }
    } catch (error) {
      if (error instanceof ToolError || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw mapMupdfError(error, 'sanitize');
    }
    throwIfAborted(context.signal);

    // Nothing selected is present and nothing was unused: the file goes back as it is.
    const present =
      selected.some((category) => removableOf(found, category) > 0) ||
      found.unused > 0 ||
      found.xfaDropped ||
      (options.forms !== 'keep' && (formFieldsBefore > 0 || working !== bytes));
    if (!present) {
      return nothingFound(bytes, selected, found, pageCount, steps);
    }

    progress('save', 1);
    out = saveRewrite(doc, 'sanitize', 'garbage=compact,compress');
  } finally {
    doc.destroy();
  }

  // ---- read the output back: every selected category must be gone ------------------------
  progress('verify', 2);
  const check = openPdf(mupdf, out);
  let after: SweepResult;
  let outputPages: number;
  let revisions: number;
  try {
    after = sweep(check, options, false, context.signal);
    outputPages = check.countPages();
    revisions = check.countVersions();
  } catch (error) {
    if (error instanceof ToolError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw mapMupdfError(error, 'sanitize verify');
  } finally {
    check.destroy();
  }
  if (outputPages !== pageCount) throw verificationFailure(`page count ${pageCount} became ${outputPages}`);
  // An earlier revision is a second copy of everything the sweep removed.
  if (revisions > 1) throw verificationFailure(`${revisions} revisions remain in the output`);

  let formsLeft = 0;
  if (options.forms !== 'keep') {
    const remaining = await readFormFields(out, context.signal);
    formsLeft = remaining.length;
    if (options.forms === 'remove' && (remaining.length > 0 || after.tally.forms > 0)) {
      throw verificationFailure(`${remaining.length} form fields remain`);
    }
    const flattenable = remaining.filter(
      (field) => FLATTENABLE.includes(field.kind) && field.pageIndex !== null,
    );
    if (options.forms === 'flatten' && flattenable.length > 0) {
      throw verificationFailure(`${flattenable.length} fields were not flattened`);
    }
  }
  for (const category of selected) {
    if (category === 'forms') continue;
    const remaining =
      category === 'layers'
        ? (after.layers?.found ?? 0) - (after.layers?.left ?? 0)
        : countOf(after, category);
    if (remaining > 0) throw verificationFailure(`${remaining} ${category} items remain in the output`);
  }
  if (after.unused > 0) throw verificationFailure(`${after.unused} unused objects remain in the output`);

  // ---- the picture ----------------------------------------------------------------------
  progress('render', 3);
  const pictureChanges =
    options.comments ||
    options.forms !== 'keep' ||
    options.links ||
    (options.files && found.attachmentIcons > 0);
  let compared = 0;
  if (!pictureChanges) {
    const sample = sampledPages(pageCount);
    const beforeDocument = await openForWrite(working);
    let before: readonly (string | null)[];
    try {
      before = renderDigests(beforeDocument, sample, context.signal);
    } finally {
      beforeDocument.doc.destroy();
    }
    const afterDocument = await openForWrite(out);
    let rendered: readonly (string | null)[];
    try {
      rendered = renderDigests(afterDocument, sample, context.signal);
    } finally {
      afterDocument.doc.destroy();
    }
    for (const [slot, expected] of before.entries()) {
      if (expected === null) continue;
      if (rendered[slot] !== expected) {
        throw verificationFailure(`page ${(sample[slot] ?? 0) + 1} renders differently after sanitising`);
      }
      compared += 1;
    }
  }

  // ---- the report: what the input held, measured on the input itself -------------------
  const original = options.forms === 'keep' ? found : await sweepInput(bytes, options, context.signal);
  const counts: SanitizeCount[] = [];
  for (const category of selected) {
    let foundCount: number;
    let left: number;
    if (category === 'forms') {
      foundCount = formFieldsBefore;
      left = formsLeft;
    } else if (category === 'layers') {
      foundCount = original.layers?.found ?? 0;
      left = after.layers?.left ?? 0;
    } else {
      foundCount = countOf(original, category);
      left = countOf(after, category);
    }
    counts.push({ category, found: foundCount, removed: Math.max(0, foundCount - left), left });
    steps.push(CATEGORY_STEP[category]);
    notes.push(...categoryNotes(category, original, foundCount, left));
  }
  counts.push({ category: 'unused', found: original.unused, removed: original.unused, left: after.unused });
  steps.push('sanitize.unused');
  notes.push(
    original.unused > 0
      ? note('changed', 'op.note.sanitize.removed.unused', { found: original.unused })
      : note('preserved', 'op.note.sanitize.none.unused'),
  );
  notes.push(...warnings(original, options, compared, pictureChanges, after));
  notes.push(note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }));
  steps.push('producer', 'save', 'verify');
  if (compared > 0) steps.push('render');

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    incremental: false,
  };
  return { bytes: out, report, counts };
}

/** The selected categories had nothing to remove: same bytes, and the report says so. */
function nothingFound(
  bytes: Uint8Array,
  selected: readonly Exclude<SanitizeCategory, 'unused'>[],
  found: SweepResult,
  pageCount: number,
  steps: readonly string[],
): SanitizeOutcome {
  const counts: SanitizeCount[] = selected.map((category) => ({
    category,
    found: 0,
    removed: 0,
    left: category === 'layers' ? (found.layers?.left ?? 0) : 0,
  }));
  counts.push({ category: 'unused', found: 0, removed: 0, left: 0 });
  const notes: OperationNote[] = [];
  for (const category of selected) {
    notes.push(...categoryNotes(category, found, 0, category === 'layers' ? (found.layers?.left ?? 0) : 0));
  }
  notes.push(note('preserved', 'op.note.sanitize.none.unused'));
  notes.push(note('preserved', 'op.note.sanitize.nothing'));
  return {
    bytes,
    counts,
    report: {
      engine: 'mupdf',
      steps: [...steps, ...selected.map((category) => CATEGORY_STEP[category]), 'sanitize.unused', 'verify'],
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount,
      // Nothing was written: the file keeps whatever revisions it had.
      incremental: true,
    },
  };
}

/** One line per selected category: what was removed, or that there was nothing to remove. */
function categoryNotes(
  category: Exclude<SanitizeCategory, 'unused'>,
  found: SweepResult,
  foundCount: number,
  left: number,
): OperationNote[] {
  const removed = Math.max(0, foundCount - left);
  if (category === 'layers') {
    const layers = found.layers;
    const result: OperationNote[] = [];
    if (layers === null || (foundCount === 0 && layers.undecided === 0 && layers.unreadable === 0)) {
      result.push(note('preserved', 'op.note.sanitize.none.layers'));
    } else if (foundCount > 0) {
      result.push(
        note('changed', 'op.note.sanitize.removed.layers', {
          removed,
          groups: layers.groups,
          dropped: layers.groupsDropped,
        }),
      );
    }
    if (left > 0) result.push(note('warning', 'op.note.sanitize.layersLeft', { count: left }));
    if (layers !== null && layers.undecided > 0) {
      result.push(note('warning', 'op.note.sanitize.layersUndecided', { count: layers.undecided }));
    }
    if (layers !== null && layers.unreadable > 0) {
      result.push(note('warning', 'op.note.sanitize.layersUnreadable', { count: layers.unreadable }));
    }
    return result;
  }
  if (category === 'forms') {
    if (foundCount === 0) return [note('preserved', 'op.note.sanitize.none.forms')];
    const result: OperationNote[] = [
      note('changed', 'op.note.sanitize.removed.forms', { found: foundCount, removed }),
    ];
    if (left > 0) result.push(note('warning', 'op.note.sanitize.formsLeft', { count: left }));
    return result;
  }
  return foundCount === 0
    ? [note('preserved', `op.note.sanitize.none.${category}` as 'op.note.sanitize.none.javascript')]
    : [
        note('changed', `op.note.sanitize.removed.${category}` as 'op.note.sanitize.removed.javascript', {
          found: foundCount,
          removed,
        }),
      ];
}

/** What the user must know beyond the counts. */
function warnings(
  found: SweepResult,
  options: SanitizeOptions,
  compared: number,
  pictureChanges: boolean,
  after: SweepResult,
): OperationNote[] {
  const result: OperationNote[] = [];
  if (found.signed) result.push(note('lost', 'op.note.sanitize.signatureBroken'));
  if (found.xfaDropped) result.push(note('changed', 'op.note.sanitize.xfaDropped'));
  if (options.javascript && found.media > 0) {
    result.push(note('warning', 'op.note.sanitize.media', { count: found.media }));
  }
  if (found.unreadable > 0 || after.unreadable > 0) {
    result.push(
      note('warning', 'op.note.sanitize.unreadable', { count: Math.max(found.unreadable, after.unreadable) }),
    );
  }
  if (compared > 0) result.push(note('preserved', 'op.note.sanitize.rendered', { pages: compared }));
  else if (pictureChanges) result.push(note('warning', 'op.note.sanitize.pictureChanges'));
  return result;
}
