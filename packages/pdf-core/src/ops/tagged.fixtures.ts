/**
 * **Test-only.** A builder for PDFs with an arbitrary structure tree, page content, annotations
 * and fonts — the shapes a real tagger never writes but real files do (a table with a row outside
 * it, a `/Pg` that names no page, a ParentTree that is a name tree, a font with a made-up
 * encoding). Built with MuPDF's object model at run time; imported only by tests.
 */

import type { PDFDocument, PDFObject } from 'mupdf';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | PDFObject };

/** One structure element. `s` is `/S`; `k` is `/K` in order. */
export interface TNode {
  readonly s?: string;
  readonly k?: readonly TKid[];
  readonly alt?: string;
  readonly actualText?: string;
  readonly lang?: string;
  readonly id?: string;
  /** The page `/Pg` names (index into `pages`); omitted = none. */
  readonly pg?: number;
  /** `/A`: table attributes. */
  readonly attrs?: {
    readonly scope?: string;
    readonly colSpan?: number;
    readonly rowSpan?: number;
    readonly headers?: readonly string[];
  };
  /** Written as a direct dictionary instead of an indirect object. */
  readonly direct?: boolean;
  /** `/K` is written as the single entry, not an array. */
  readonly single?: boolean;
}

export type TKid =
  | TNode
  /** A bare marked-content id. */
  | number
  /** A `/Type /MCR` reference; `pg` is the page it names, `stm` adds a `/Stm`. */
  | { readonly mcr: number; readonly pg?: number; readonly stm?: boolean }
  /** A `/Type /OBJR` reference to `pages[page].annots[annot]`. */
  | { readonly objr: readonly [number, number]; readonly pg?: number };

export interface TAnnot {
  readonly subtype: string;
  readonly contents?: string;
  readonly flags?: number;
  /** Written as a direct dictionary in `/Annots`. */
  readonly direct?: boolean;
  readonly extra?: Record<string, Json>;
  /** A form field: `/T`, `/TU` and `/FT /Tx` written as strings. */
  readonly field?: { readonly name: string; readonly tooltip?: string };
}

export interface TPage {
  /** The page content stream. */
  readonly content?: string;
  /** Extra content streams appended to an array `/Contents`. */
  readonly more?: readonly string[];
  /** Font resources by name: a raw dictionary, plus an optional ToUnicode CMap source. */
  readonly fonts?: Record<
    string,
    {
      readonly dict?: Record<string, Json>;
      readonly toUnicode?: string;
      /** Builds the whole font object when a plain dictionary cannot say it (embedded programs, CID fonts). */
      readonly build?: (doc: PDFDocument) => PDFObject;
    }
  >;
  /** An image XObject `Im1` (4 × 4 gray) in the resources. */
  readonly image?: true;
  /** Form XObjects by name: content and optional own resources. */
  readonly forms?: Record<string, { readonly content: string; readonly fonts?: TPage['fonts'] }>;
  readonly annots?: readonly TAnnot[];
  readonly tabs?: string;
  readonly structParents?: number;
  readonly box?: readonly [number, number, number, number];
}

export interface TSpec {
  readonly pages: readonly TPage[];
  /** The children of `/StructTreeRoot`; omitted = untagged. */
  readonly tree?: readonly TNode[];
  readonly roleMap?: Record<string, string>;
  /** `/ParentTree` present (an empty `/Nums`), or a value to put there. */
  readonly parentTree?: true | { readonly kids: true };
  readonly markInfo?: boolean;
  readonly lang?: string;
  readonly title?: string;
  readonly displayTitle?: boolean;
  /** Catalog entries put as written. */
  readonly catalog?: Record<string, Json>;
  /** `/StructTreeRoot` as a name instead of a dictionary. */
  readonly rootAsName?: true;
  /** `/Outlines` with a first child. */
  readonly outlines?: true;
  /** `/AcroForm` entries; fields are collected from the pages' Widget annotations. */
  readonly acroForm?: Record<string, Json>;
  readonly trailer?: Record<string, Json>;
  /** Runs last, with the document, the catalog and the page dictionaries, for shapes no field above can say. */
  readonly setup?: (doc: PDFDocument, root: PDFObject, pages: readonly PDFObject[]) => void;
  /** Save options (`encrypt=aes-128,owner-password=x,permissions=-3904`). */
  readonly save?: string;
}

export interface Built {
  readonly bytes: Uint8Array;
  /** Object numbers of every annotation, by page then position. */
  readonly annots: readonly (readonly number[])[];
}

export async function buildTagged(spec: TSpec): Promise<Built> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const pageRefs: PDFObject[] = [];
  const annotRefs: PDFObject[][] = [];

  const addFonts = (fonts: TPage['fonts']): Record<string, PDFObject> => {
    const out: Record<string, PDFObject> = {};
    for (const [name, font] of Object.entries(fonts ?? {})) {
      if (font.build !== undefined) {
        out[name] = font.build(doc);
        continue;
      }
      const dict: Record<string, Json | PDFObject> = { Type: 'Font', ...font.dict };
      if (font.toUnicode !== undefined) dict.ToUnicode = doc.addStream(font.toUnicode, {});
      out[name] = doc.addObject(dict as never);
    }
    return out;
  };

  for (const [index, page] of spec.pages.entries()) {
    const fonts = addFonts(page.fonts);
    const xobjects: Record<string, PDFObject> = {};
    for (const [name, form] of Object.entries(page.forms ?? {})) {
      xobjects[name] = doc.addStream(form.content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        ...(form.fonts === undefined ? {} : { Resources: { Font: addFonts(form.fonts) } }),
      });
    }
    if (page.image === true) {
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
      pixmap.clear(0);
      xobjects.Im1 = doc.addImage(new mupdf.Image(pixmap));
    }
    const resources = {
      ...(Object.keys(fonts).length > 0 ? { Font: fonts } : {}),
      ...(Object.keys(xobjects).length > 0 ? { XObject: xobjects } : {}),
    };
    const box = page.box ?? [0, 0, 200, 200];
    const first = doc.addPage([...box], 0, resources, page.content ?? '');
    doc.insertPage(index, first);
    const ref = doc.findPage(index);
    pageRefs.push(ref);
    if ((page.more?.length ?? 0) > 0) {
      const contents = doc.newArray();
      contents.push(ref.get('Contents'));
      for (const text of page.more ?? []) contents.push(doc.addStream(text, {}));
      ref.put('Contents', contents);
    }
    if (page.tabs !== undefined) ref.put('Tabs', doc.newName(page.tabs));
    if (page.structParents !== undefined) ref.put('StructParents', page.structParents);
  }

  for (const [index, page] of spec.pages.entries()) {
    const refs: PDFObject[] = [];
    const list = doc.newArray();
    for (const annot of page.annots ?? []) {
      const dict: Record<string, Json | PDFObject> = {
        Type: 'Annot',
        Subtype: annot.subtype,
        Rect: [10, 10, 50, 30],
        ...(annot.contents === undefined ? {} : { Contents: doc.newString(annot.contents) }),
        ...(annot.flags === undefined ? {} : { F: annot.flags }),
        ...(annot.field === undefined
          ? {}
          : {
              FT: 'Tx',
              T: doc.newString(annot.field.name),
              ...(annot.field.tooltip === undefined ? {} : { TU: doc.newString(annot.field.tooltip) }),
            }),
        ...(annot.extra ?? {}),
      };
      const object = annot.direct === true ? doc.newDictionary() : doc.addObject(dict as never);
      if (annot.direct === true) {
        for (const [key, value] of Object.entries(dict)) object.put(key, value as never);
      }
      refs.push(object);
      list.push(object);
    }
    annotRefs.push(refs);
    if (refs.length > 0) (pageRefs[index] as PDFObject).put('Annots', list);
  }

  const root = doc.getTrailer().get('Root');
  if (spec.tree !== undefined) {
    const treeRoot = doc.addObject({ Type: 'StructTreeRoot' });
    const kids = doc.newArray();
    const make = (node: TNode, parent: PDFObject): PDFObject => {
      const dict: Record<string, Json | PDFObject> = { Type: 'StructElem', P: parent };
      if (node.s !== undefined) dict.S = node.s;
      if (node.alt !== undefined) dict.Alt = doc.newString(node.alt);
      if (node.actualText !== undefined) dict.ActualText = doc.newString(node.actualText);
      if (node.lang !== undefined) dict.Lang = doc.newString(node.lang);
      if (node.id !== undefined) dict.ID = doc.newString(node.id);
      if (node.pg !== undefined) dict.Pg = pageRefs[node.pg] as PDFObject;
      const attrs: Record<string, Json | PDFObject> = {};
      if (node.attrs !== undefined) {
        attrs.O = 'Table';
        if (node.attrs.scope !== undefined) attrs.Scope = node.attrs.scope;
        if (node.attrs.colSpan !== undefined) attrs.ColSpan = node.attrs.colSpan;
        if (node.attrs.rowSpan !== undefined) attrs.RowSpan = node.attrs.rowSpan;
        if (node.attrs.headers !== undefined) {
          attrs.Headers = node.attrs.headers.map((header) => doc.newString(header)) as never;
        }
        dict.A = attrs as never;
      }
      let element: PDFObject;
      if (node.direct === true) {
        element = doc.newDictionary();
        for (const [key, value] of Object.entries(dict)) element.put(key, value as never);
      } else element = doc.addObject(dict as never);
      const entries: PDFObject[] = [];
      for (const kid of node.k ?? []) {
        if (typeof kid === 'number') entries.push(doc.newInteger(kid));
        else if ('mcr' in kid) {
          const mcr = doc.newDictionary();
          mcr.put('Type', doc.newName('MCR'));
          mcr.put('MCID', doc.newInteger(kid.mcr));
          if (kid.pg !== undefined) mcr.put('Pg', pageRefs[kid.pg] as PDFObject);
          if (kid.stm === true) mcr.put('Stm', pageRefs[0] as PDFObject);
          entries.push(mcr);
        } else if ('objr' in kid) {
          const [pageIndex, annotIndex] = kid.objr;
          const objr = doc.newDictionary();
          objr.put('Type', doc.newName('OBJR'));
          objr.put('Obj', (annotRefs[pageIndex] as PDFObject[])[annotIndex] as PDFObject);
          if (kid.pg !== undefined) objr.put('Pg', pageRefs[kid.pg] as PDFObject);
          entries.push(objr);
        } else entries.push(make(kid, element));
      }
      if (node.single === true && entries.length === 1) element.put('K', entries[0] as PDFObject);
      else if (entries.length > 0) {
        const array = doc.newArray();
        for (const entry of entries) array.push(entry);
        element.put('K', array);
      }
      return element;
    };
    for (const node of spec.tree) kids.push(make(node, treeRoot));
    treeRoot.put('K', kids);
    if (spec.roleMap !== undefined) {
      const map = doc.newDictionary();
      for (const [from, to] of Object.entries(spec.roleMap)) map.put(from, doc.newName(to));
      treeRoot.put('RoleMap', map);
    }
    if (spec.parentTree === true) treeRoot.put('ParentTree', doc.addObject({ Nums: [] }));
    else if (spec.parentTree !== undefined) treeRoot.put('ParentTree', doc.addObject({ Kids: [] }));
    root.put('StructTreeRoot', spec.rootAsName === true ? doc.newName('Broken') : treeRoot);
  }
  if (spec.markInfo !== undefined) root.put('MarkInfo', doc.addObject({ Marked: spec.markInfo }));
  if (spec.lang !== undefined) root.put('Lang', doc.newString(spec.lang));
  if (spec.displayTitle !== undefined) {
    root.put('ViewerPreferences', doc.addObject({ DisplayDocTitle: spec.displayTitle }));
  }
  if (spec.title !== undefined) doc.setMetaData('info:Title', spec.title);
  if (spec.outlines === true) {
    const outlines = doc.addObject({ Type: 'Outlines' });
    outlines.put(
      'First',
      doc.addObject({
        Title: doc.newString('One'),
        Parent: outlines,
        Dest: [pageRefs[0] as PDFObject, 'Fit'],
      }),
    );
    root.put('Outlines', outlines);
  }
  if (spec.acroForm !== undefined) {
    const fields = doc.newArray();
    for (const refs of annotRefs) {
      for (const ref of refs) if (ref.get('Subtype').asName() === 'Widget') fields.push(ref);
    }
    const form = doc.addObject({ ...spec.acroForm } as never);
    form.put('Fields', fields);
    root.put('AcroForm', form);
  }
  for (const [key, value] of Object.entries(spec.catalog ?? {})) root.put(key, value as never);
  for (const [key, value] of Object.entries(spec.trailer ?? {})) doc.getTrailer().put(key, value as never);

  spec.setup?.(doc, root, pageRefs);

  const bytes = new Uint8Array(doc.saveToBuffer(spec.save ?? '').asUint8Array());
  const numbers = annotRefs.map((refs) => refs.map((ref) => ref.asIndirect()));
  doc.destroy();
  return { bytes, annots: numbers };
}

/** Re-open `bytes`, let `edit` change the object model, and return the saved bytes. */
export async function mutate(bytes: Uint8Array, edit: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    edit(doc);
    return new Uint8Array(doc.saveToBuffer('').asUint8Array());
  } finally {
    doc.destroy();
  }
}

/** A marked-content line the way a tagger writes it: `/P <</MCID n>> BDC … EMC`. */
export const tagged = (tag: string, mcid: number, body: string): string =>
  `/${tag} <</MCID ${mcid}>> BDC\n${body}\nEMC\n`;
