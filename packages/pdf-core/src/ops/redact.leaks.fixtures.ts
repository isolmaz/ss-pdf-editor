/**
 * Pages built in a test for `redact.leaks.test.ts`: documents that carry a file in every place one
 * can ride, a thumbnail, and tags whose text repeats the page — and a reader that finds the text
 * the way a reader that follows the tags would.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { addAttachments } from './attachments-write';
import { addLink, build, inProduced, OUTSIDE_LINK, TWO_LINES } from './redact.fixtures';
import { buildTagged, tagged } from './tagged.fixtures';

export const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The payloads of the three files `attachedDocument` carries; each must be gone from a redacted copy. */
export const PAYLOAD = {
  tree: 'TREEPAYLOAD-7741',
  annotation: 'ANNOTPAYLOAD-5532',
  associated: 'AFONLYPAYLOAD-1180',
} as const;

/** The payload of the inline file specification `associatedEdgeCases` carries. */
export const DIRECT_PAYLOAD = 'DIRECTSPEC-PAYLOAD-2297';

/** The payloads of the files `associatedElsewhere` lists in the `/AF` of an annotation and of a structure element. */
export const ELSEWHERE_PAYLOAD = {
  annotation: 'ANNOTAF-PAYLOAD-3305',
  element: 'ELEMENTAF-PAYLOAD-6618',
} as const;

/**
 * `/Root /AF` as a producer can write it badly: a file specification written inline (a direct
 * dictionary, its `/EF` holding only `/F`) and a reference to an object that is no longer there.
 */
export function associatedEdgeCases(): Promise<Uint8Array> {
  return build([TWO_LINES], (doc) => {
    const stream = doc.addStream(encode(DIRECT_PAYLOAD), { Type: 'EmbeddedFile' });
    const inline = doc.newDictionary();
    inline.put('Type', doc.newName('Filespec'));
    inline.put('F', doc.newString('inline.txt'));
    inline.put('EF', doc.addObject({ F: stream } as never));
    const gone = doc.addObject({ Type: 'Filespec', F: doc.newString('gone.txt') });
    doc.getTrailer().get('Root').put('AF', [inline, gone]);
    doc.deleteObject(gone.asIndirect());
  });
}

/**
 * Files that only an `/AF` list names, on a link annotation and on a structure element. The page
 * also lists an annotation that is no dictionary and one that points nowhere, and a structure
 * element's `/K` holds a marked-content id.
 */
export function associatedElsewhere(): Promise<Uint8Array> {
  return build([TWO_LINES], (doc) => {
    const attach = (name: string, payload: string): PDFObject =>
      doc.addEmbeddedFile(name, 'text/plain', encode(payload), new Date(0), new Date(0));
    const link = addLink(doc, OUTSIDE_LINK, [60, 60, 190, 80]);
    link.put('AF', [attach('on-annotation.txt', ELSEWHERE_PAYLOAD.annotation)]);
    doc.findPage(0).put('Annots', [link, doc.newInteger(7), doc.newIndirect(9999)]);
    const tree = doc.addObject({ Type: 'StructTreeRoot' });
    const element = doc.addObject({ Type: 'StructElem', S: 'P', P: tree, K: 0 });
    element.put('AF', [attach('on-element.txt', ELSEWHERE_PAYLOAD.element)]);
    tree.put('K', [element]);
    doc.getTrailer().get('Root').put('StructTreeRoot', tree);
  });
}

/** A file in the name tree, a file only `/Root /AF` lists, and a file-attachment annotation with its popup. */
export async function attachedDocument(): Promise<Uint8Array> {
  const base = await build([TWO_LINES], (doc) => {
    const attach = (name: string, payload: string): PDFObject =>
      doc.addEmbeddedFile(name, 'text/plain', encode(payload), new Date(0), new Date(0));
    const page = doc.findPage(0);
    doc
      .getTrailer()
      .get('Root')
      .put('AF', [attach('af-only.txt', PAYLOAD.associated)]);
    // The annotation's file is also listed in the page's `/AF`: one file reachable two ways.
    const shared = attach('on-page.txt', PAYLOAD.annotation);
    const icon = doc.addObject({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      F: 4,
      Name: 'Paperclip',
      Rect: [300, 400, 320, 420],
      FS: shared,
      Contents: doc.newString('see the attachment'),
      P: page,
    });
    const popup = doc.addObject({
      Type: 'Annot',
      Subtype: 'Popup',
      Rect: [330, 400, 400, 460],
      Parent: icon,
      Open: false,
      P: page,
    });
    icon.put('Popup', popup);
    page.put('AF', [shared]);
    page.put('Annots', [icon, popup, addLink(doc, OUTSIDE_LINK, [60, 60, 190, 80])]);
  });
  const added = await addAttachments(
    base,
    [{ name: 'gizli.txt', bytes: encode(PAYLOAD.tree), mime: 'text/plain' }],
    { signal: new AbortController().signal },
  );
  return added.bytes;
}

/** A document whose only attachment is a file-attachment annotation: the Attachments panel lists nothing. */
export function annotationOnlyDocument(): Promise<Uint8Array> {
  return build([TWO_LINES], (doc) => {
    const page = doc.findPage(0);
    const payload = encode(PAYLOAD.annotation);
    const spec = doc.addEmbeddedFile('note.txt', 'text/plain', payload, new Date(0), new Date(0));
    const icon = doc.addObject({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      F: 4,
      Name: 'Paperclip',
      Rect: [300, 400, 320, 420],
      FS: spec,
      P: page,
    });
    page.put('Annots', [icon]);
  });
}

/** A name tree whose keys are the given raw bytes, each pointing at a file with `payload`. */
export async function attachedByKeyBytes(keys: readonly Uint8Array[], payload: string): Promise<Uint8Array> {
  return build([TWO_LINES], (doc) => {
    const pairs = doc.newArray();
    for (const key of keys) {
      pairs.push(doc.newByteString(key));
      pairs.push(doc.addEmbeddedFile('x.txt', 'text/plain', encode(payload), new Date(0), new Date(0)));
    }
    const root = doc.getTrailer().get('Root');
    root.put('Names', doc.newDictionary()).put('EmbeddedFiles', doc.newDictionary()).put('Names', pairs);
  });
}

/**
 * A name tree one level deep: `/EmbeddedFiles /Kids` leads to a leaf per file, the first leaf listed
 * twice, and `/Names` holds a destination tree next to it.
 */
export function attachedInKids(files: readonly (readonly [string, string])[]): Promise<Uint8Array> {
  return build([TWO_LINES], (doc) => {
    const kids = doc.newArray();
    for (const [name, payload] of files) {
      const spec = doc.addEmbeddedFile(name, 'text/plain', encode(payload), new Date(0), new Date(0));
      const key = doc.newString(name);
      kids.push(doc.addObject({ Limits: [key, key], Names: [key, spec] }));
    }
    kids.push(kids.get(0));
    const names = doc.getTrailer().get('Root').put('Names', doc.newDictionary());
    names.put('Dests', doc.newDictionary());
    names.put('EmbeddedFiles', doc.newDictionary()).put('Kids', kids);
  });
}

/** UTF-16BE with the byte-order mark, the form a PDF text string takes for a name outside PDFDocEncoding. */
export function utf16be(value: string): Uint8Array {
  const out = [0xfe, 0xff];
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    out.push(unit >> 8, unit & 0xff);
  }
  return Uint8Array.from(out);
}

/** The hex string a tagger writes for a text string: `<FEFF…>`. */
export function hexString(value: string): string {
  const digits = [...utf16be(value)].map((byte) => byte.toString(16).padStart(2, '0'));
  return `<${digits.join('').toUpperCase()}>`;
}

/** Two pages with a thumbnail each, for a mark on the first. */
export function withThumbnails(): Promise<Uint8Array> {
  return build([TWO_LINES, TWO_LINES], (doc) => {
    for (const index of [0, 1]) {
      doc.findPage(index).put(
        'Thumb',
        doc.addStream(encode(`THUMBNAIL-OF-PAGE-${index}`), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 1,
          Height: 1,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
        }),
      );
    }
  });
}

/** Every secret `taggedDocument` writes into page 1's tags and content, and the ones it keeps on page 2. */
export const TAG_SECRETS = [
  'STRUCT-ALT-SECRET',
  'MCR-ONLY-ACTUALTEXT-SECRET',
  'TREE-ONLY-ALT-SECRET',
  'SPAN-ACTUALTEXT-SECRET',
  'SPAN-ALT-SECRET',
  'SPAN-EXPANSION-SECRET',
  'SINGLE-KID-ACTUALTEXT-SECRET',
  'OBJR-ACTUALTEXT-SECRET',
  'ANNOT-ALT-SECRET',
  'CONTENT-ALT-SECRET',
  'CONTENT-ACTUALTEXT-SECRET',
  'PROPERTY-ACTUALTEXT-SECRET',
  'PROPERTY-EXPANSION-SECRET',
] as const;

/** What page 2 of `taggedDocument` keeps: its own tag text, in the tree and in its content. */
export const KEPT_TAG_TEXT = ['OTHER-PAGE-ALT', 'OTHER-CONTENT-ALT'] as const;

/** The structure element whose `/Alt` is `alt`, found by walking the tree from `/StructTreeRoot`. */
function elementByAlt(root: PDFObject, alt: string): PDFObject | null {
  const stack: PDFObject[] = [root.get('K')];
  while (stack.length > 0) {
    const entry = stack.pop() as PDFObject;
    const target = entry.isNull() ? null : entry.resolve();
    if (target === null) continue;
    if (target.isArray()) {
      for (let index = 0; index < target.length; index += 1) stack.push(target.get(index));
    } else if (target.isDictionary()) {
      const found = target.get('Alt');
      if (!found.isNull() && found.asString() === alt) return entry;
      stack.push(target.get('K'));
    }
  }
  return null;
}

/**
 * A two-page tagged document (200 × 200 pt). Page 1 holds "Secret 4711" at user y 150, and every
 * place its tags can repeat text: `/Alt` and `/ActualText` of structure elements reached by `/Pg`,
 * by a content reference alone and by `/ParentTree` alone; an `/E` on a span; `/Alt` and a hex
 * `/ActualText` in the `BDC` dictionaries of its content stream; `/ActualText` and `/E` in a named
 * property dictionary. Page 2 carries a tag text of its own in the tree and in its content.
 */
export async function taggedDocument(): Promise<Uint8Array> {
  const font = { F1: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica' } } };
  const content = [
    '/Figure <</MCID 0 /Alt (CONTENT-ALT-SECRET)>> BDC',
    'BT /F1 12 Tf 20 150 Td (Secret 4711) Tj ET',
    'EMC',
    `/Span <</MCID 1/ActualText${hexString('CONTENT-ACTUALTEXT-SECRET')}>> BDC`,
    'BT /F1 12 Tf 20 100 Td (Public line) Tj ET',
    'EMC',
    '/Span /MC7 BDC',
    'BT /F1 12 Tf 20 60 Td (Named properties) Tj ET',
    'EMC',
  ].join('\n');
  const { bytes } = await buildTagged({
    pages: [
      {
        content,
        fonts: font,
        structParents: 0,
        // The annotation's `/StructParent` 1 leads to `ANNOT-ALT-SECRET` through the parent tree.
        annots: [{ subtype: 'Link', extra: { StructParent: 1 } }],
      },
      {
        content: tagged('Figure', 0, 'BT /F1 12 Tf 20 100 Td (Other page) Tj ET').replace(
          '<</MCID 0>>',
          '<</MCID 0 /Alt (OTHER-CONTENT-ALT)>>',
        ),
        fonts: font,
      },
    ],
    tree: [
      {
        s: 'Document',
        k: [
          { s: 'Figure', alt: 'STRUCT-ALT-SECRET', pg: 0, k: [0] },
          { s: 'Span', actualText: 'MCR-ONLY-ACTUALTEXT-SECRET', k: [{ mcr: 1, pg: 0 }] },
          { s: 'Figure', alt: 'TREE-ONLY-ALT-SECRET', k: [3] },
          { s: 'Span', actualText: 'SPAN-ACTUALTEXT-SECRET', alt: 'SPAN-ALT-SECRET', pg: 0, k: [2] },
          { s: 'Span', actualText: 'SINGLE-KID-ACTUALTEXT-SECRET', pg: 0, single: true, k: [4] },
          { s: 'Link', actualText: 'OBJR-ACTUALTEXT-SECRET', k: [{ objr: [0, 0], pg: 0 }] },
          { s: 'Figure', alt: 'ANNOT-ALT-SECRET' },
          { s: 'Figure', alt: 'OTHER-PAGE-ALT', pg: 1, k: [0] },
        ],
      },
    ],
    setup: (doc: PDFDocument, root: PDFObject, pages: readonly PDFObject[]) => {
      const treeRoot = root.get('StructTreeRoot');
      const properties = doc.newDictionary();
      properties.put(
        'MC7',
        doc.addObject({
          MCID: 5,
          ActualText: doc.newString('PROPERTY-ACTUALTEXT-SECRET'),
          E: doc.newString('PROPERTY-EXPANSION-SECRET'),
        } as never),
      );
      (pages[0] as PDFObject).get('Resources').put('Properties', properties);
      // `/E` has no field in the builder: it goes onto the span that carries `SPAN-ALT-SECRET`.
      const span = elementByAlt(treeRoot, 'SPAN-ALT-SECRET');
      if (span === null) throw new Error('fixture: span not found');
      span.resolve().put('E', doc.newString('SPAN-EXPANSION-SECRET'));
      // The element only `/ParentTree` leads to: its page's `/StructParents` key 0 lists it.
      const listed = elementByAlt(treeRoot, 'TREE-ONLY-ALT-SECRET');
      if (listed === null) throw new Error('fixture: tree-only element not found');
      const annotated = elementByAlt(treeRoot, 'ANNOT-ALT-SECRET');
      const other = elementByAlt(treeRoot, 'OTHER-PAGE-ALT');
      if (annotated === null || other === null) throw new Error('fixture: element not found');
      // Key 0 is page 1's MCID list (a hole, then the element); key 1 is the annotation's single
      // element; key 2 belongs to page 2 and is nobody's here. The tree is one level deep.
      const elements = doc.newArray();
      elements.push(null);
      elements.push(listed);
      const leaf = doc.addObject({ Nums: [0, elements, 1, annotated, 2, other] } as never);
      treeRoot.put('ParentTree', doc.addObject({ Kids: [leaf] } as never));
      // One element under two parents, and a cycle back to the document element: each is read once.
      span.resolve().get('K').push(listed);
      listed.resolve().get('K').push(treeRoot.get('K').get(0));
    },
  });
  return bytes;
}

/**
 * Two pages that share one `/Resources` object whose `/Properties` names `MC7`
 * (`/ActualText (SHARED-ACTUALTEXT-SECRET)`); both pages draw a line in `MC7`.
 */
export async function sharedResourcesDocument(): Promise<Uint8Array> {
  const { bytes } = await buildTagged({
    pages: [
      { content: '/Span /MC7 BDC BT /F1 12 Tf 20 150 Td (Secret 4711) Tj ET EMC' },
      { content: '/Span /MC7 BDC BT /F1 12 Tf 20 150 Td (Other page) Tj ET EMC' },
    ],
    setup: (doc: PDFDocument, _root: PDFObject, pages: readonly PDFObject[]) => {
      const shared = doc.addObject({
        Font: { F1: doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }) },
        Properties: {
          MC7: doc.addObject({ MCID: 5, ActualText: doc.newString('SHARED-ACTUALTEXT-SECRET') } as never),
        },
      } as never);
      for (const page of pages) page.put('Resources', shared);
    },
  });
  return bytes;
}

/**
 * Two pages that draw the same forms, for a mark on the first (or on both). `Fm1` holds a tag text in
 * its content, in a property dictionary of its own resources (`MC1`; `MC2` has none) and in the form
 * `Fm2` inside it, which has no resources of its own. Beside it in the page's resources: a plain form,
 * an image, a form that draws itself, a form with a tag text that no content draws (`Fm6`) and a
 * reference to an object that is gone.
 */
export function sharedFormDocument(): Promise<Uint8Array> {
  return build([TWO_LINES, TWO_LINES], (doc) => {
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    const form = (content: string, extra: Record<string, unknown> = {}): PDFObject =>
      doc.addStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], ...extra } as never);
    const nested = form('/Figure <</MCID 2 /Alt (NESTED-ALT-SECRET)>> BDC 0 0 10 10 re f EMC');
    const main = form(
      [
        '/Span <</MCID 0 /ActualText (FORM-ACTUALTEXT-SECRET)>> BDC BT /F1 12 Tf 0 0 Td (Form text) Tj ET EMC',
        '/Span /MC1 BDC /Fm2 Do EMC',
      ].join('\n'),
      {
        Resources: {
          Font: { F1: font },
          Properties: {
            MC1: doc.addObject({ MCID: 1, ActualText: doc.newString('FORM-PROPERTY-SECRET') } as never),
            MC2: doc.addObject({ MCID: 2 } as never),
          },
          XObject: { Fm2: nested },
        },
      },
    );
    const unused = form('/Span <</MCID 6 /ActualText (UNUSED-ACTUALTEXT-SECRET)>> BDC EMC');
    const loop = form('q Q', { Resources: { XObject: {} } });
    loop.resolve().get('Resources').get('XObject').put('Fm3', loop);
    const image = doc.addStream(encode('\u0000'), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    } as never);
    const gone = doc.addObject({ Gone: true } as never);
    for (const index of [0, 1]) {
      const page = doc.findPage(index);
      page.get('Resources').put('XObject', {
        Fm1: main,
        Fm3: loop,
        Fm5: form('q Q'),
        Fm6: unused,
        Im1: image,
        Gone: gone,
      });
      page.put(
        'Contents',
        doc.addStream(
          'BT /F1 12 Tf 50 400 Td (Public line) Tj ET\nBT /F1 12 Tf 50 300 Td (Secret 4711) Tj ET\nq /Fm1 Do Q',
          {},
        ),
      );
    }
    doc.deleteObject(gone.asIndirect());
  });
}

/** Two pages, the second without `/Contents` and without `/Resources`. */
export function bareDocument(): Promise<Uint8Array> {
  return build([TWO_LINES, TWO_LINES], (doc) => {
    const page = doc.findPage(1);
    page.delete('Contents');
    page.delete('Resources');
  });
}

/**
 * Every PDF string of the file, decoded (`asString`), and every stream decompressed with its
 * `<FEFF…>` hex strings decoded: what a reader that follows the tags can read out of the file.
 */
export function readableText(bytes: Uint8Array): Promise<string> {
  return inProduced(bytes, (doc) => {
    const parts: string[] = [];
    const walk = (object: PDFObject): void => {
      if (object.isIndirect()) return;
      if (object.isString()) parts.push(object.asString());
      else if (object.isArray() || object.isDictionary()) {
        object.forEach((value) => {
          walk(value);
        });
      }
    };
    for (let number = 1; number < doc.countObjects(); number += 1) {
      const object = doc.newIndirect(number);
      walk(object.resolve());
      if (!object.isStream()) continue;
      const stream = new TextDecoder('latin1').decode(object.readStream().asUint8Array());
      parts.push(
        stream.replace(/<FEFF([0-9A-Fa-f]*)>/gi, (_, hex: string) => {
          let decoded = '';
          for (let at = 0; at + 3 < hex.length; at += 4) {
            decoded += String.fromCharCode(Number.parseInt(hex.slice(at, at + 4), 16));
          }
          return decoded;
        }),
      );
    }
    return parts.join('\n');
  });
}
