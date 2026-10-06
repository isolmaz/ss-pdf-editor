/**
 * Hidden layers cut out of a PDF built in the test, then re-read with MuPDF. The wrong
 * answers that matter: hidden ink left in the file (the leak), visible content or the state
 * it runs under removed with it, a cut that shifts the text after it, a visibility expression
 * guessed instead of left alone, and a read-only sweep that disagrees with the mutating one.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { sweepHiddenLayers } from './sanitize-layers';

const mupdf = await import('mupdf');

interface Built {
  readonly doc: PDFDocument;
  readonly page: PDFObject;
  readonly hidden: PDFObject;
  readonly visible: PDFObject;
  readonly resources: PDFObject;
}

/**
 * One page. Hidden layer `Hid` (default OFF) holds a red square and the text SECRET, a hidden
 * image `ImH` and, inside a visible form `Fm`, more hidden text; visible layer `Vis` holds
 * VISIBLE; `ImV` is a plain visible image. `extra` is appended to the page content.
 */
function build(extra = '', withOptionalContent = true): Built {
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  const hidden = doc.addObject({ Type: 'OCG', Name: doc.newString('Hidden') });
  const visible = doc.addObject({ Type: 'OCG', Name: doc.newString('Visible') });
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(10);
  const hiddenImage = doc.addImage(new mupdf.Image(pixmap));
  hiddenImage.put('OC', hidden);
  // A different picture: MuPDF stores two identical images as one object, and the hidden
  // layer's `/OC` would then be on the visible one too.
  const other = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  other.clear(200);
  const visibleImage = doc.addImage(new mupdf.Image(other));
  const form = doc.addStream(
    '/OC /Hid BDC BT /F 12 Tf 72 200 Td (FORMSECRET) Tj ET EMC BT /F 12 Tf 72 180 Td (FORMVISIBLE) Tj ET',
    {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 612, 792],
      Resources: { Font: { F: font }, Properties: { Hid: hidden } },
    },
  );
  const resources = doc.addObject({
    Font: { F: font },
    Properties: { Hid: hidden, Vis: visible },
    XObject: { ImH: hiddenImage, ImV: visibleImage, Fm: form },
  });
  const content =
    '/OC /Hid BDC 1 0 0 rg 300 300 100 100 re f BT /F 12 Tf 72 500 Td (SECRET) Tj ET EMC\n' +
    '/OC /Vis BDC BT /F 12 Tf 72 400 Td (VISIBLE) Tj ET EMC\n' +
    'q 50 0 0 50 10 10 cm /ImH Do Q\nq 50 0 0 50 70 10 cm /ImV Do Q\n/Fm Do\n' +
    extra;
  const page = doc.addPage([0, 0, 612, 792], 0, resources, content);
  doc.insertPage(0, page);
  if (withOptionalContent) {
    doc
      .getTrailer()
      .get('Root')
      .put('OCProperties', {
        OCGs: [hidden, visible],
        D: { OFF: [hidden], ON: [visible] },
      });
  }
  return { doc, page: doc.findPage(0), hidden, visible, resources };
}

function contentOf(doc: PDFDocument): string {
  const contents = doc.findPage(0).get('Contents');
  const buffer = contents.readStream();
  try {
    return new TextDecoder().decode(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
}

/** Save, reopen and give back the document, as the sanitiser's own verification does. */
function roundTrip(doc: PDFDocument): PDFDocument {
  const bytes = new Uint8Array(doc.saveToBuffer('garbage=compact').asUint8Array());
  return mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as PDFDocument;
}

function textOf(doc: PDFDocument): string {
  const page = doc.loadPage(0);
  try {
    return page.toStructuredText('').asText();
  } finally {
    page.destroy();
  }
}

describe('sweepHiddenLayers', () => {
  it('counts a hidden layer without touching the file', () => {
    const { doc } = build();
    try {
      const before = contentOf(doc);
      const sweep = sweepHiddenLayers(doc, false);
      // The marked region, the hidden image's Do and the hidden region inside the visible form.
      expect(sweep).toMatchObject({ groups: 1, found: 3, removed: 0, left: 0, undecided: 0, unreadable: 0 });
      expect(contentOf(doc)).toBe(before);
      expect(before).toContain('SECRET');
    } finally {
      doc.destroy();
    }
  });

  it('cuts the hidden ink, keeps the visible page, and frees what only the hidden layer used', () => {
    const { doc, resources } = build();
    try {
      const sweep = sweepHiddenLayers(doc, true);
      expect(sweep).toMatchObject({ found: 3, removed: 3, left: 0, groupsDropped: 1 });
      const content = contentOf(doc);
      expect(content).not.toContain('SECRET');
      expect(content).not.toContain('300 300 100 100 re');
      // The state operator inside the hidden region stays: what runs after it runs under the same colour.
      expect(content).toContain('1 0 0 rg');
      expect(content).toContain('(VISIBLE) Tj');
      expect(content).toContain('/ImV Do');
      expect(content).not.toContain('/ImH Do');
      // Resource names used only by the hidden content are pruned.
      const xobjects = resources.get('XObject');
      expect(xobjects.get('ImH').isNull()).toBe(true);
      expect(xobjects.get('ImV').isNull()).toBe(false);

      const reopened = roundTrip(doc);
      try {
        const text = textOf(reopened);
        expect(text).toContain('VISIBLE');
        expect(text).toContain('FORMVISIBLE');
        expect(text).not.toContain('SECRET');
        expect(text).not.toContain('FORMSECRET');
        // The hidden group left `/OCProperties`; the visible one stays.
        const groups = reopened.getTrailer().get('Root').get('OCProperties').get('OCGs');
        expect(groups.length).toBe(1);
        expect(groups.get(0).resolve().get('Name').asString()).toBe('Visible');
        // The same sweep, read-only, on the output finds nothing: the check the operation runs.
        expect(sweepHiddenLayers(reopened, false)).toMatchObject({ groups: 0, found: 0, left: 0 });
      } finally {
        reopened.destroy();
      }
    } finally {
      doc.destroy();
    }
  });

  it('leaves a region it cannot cut exactly, and says so', () => {
    // The text object opens outside the hidden region and continues after it: removing the
    // show inside would move every glyph that follows.
    const extra = 'BT /F 12 Tf 72 300 Td /OC /Hid BDC (PARTIAL) Tj EMC (AFTER) Tj ET\n';
    const { doc } = build(extra);
    try {
      const sweep = sweepHiddenLayers(doc, true);
      expect(sweep).toMatchObject({ found: 4, removed: 3, left: 1 });
      const content = contentOf(doc);
      expect(content).toContain('(PARTIAL) Tj');
      expect(content).toContain('(AFTER) Tj');
      expect(content).not.toContain('(SECRET)');
    } finally {
      doc.destroy();
    }
  });

  it('does not guess at a visibility expression: it is counted and left alone', () => {
    const doc = new mupdf.PDFDocument();
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    const group = doc.addObject({ Type: 'OCG', Name: doc.newString('G') });
    const member = doc.addObject({ Type: 'OCMD', VE: ['Not', group] });
    const page = doc.addPage(
      [0, 0, 200, 200],
      0,
      { Font: { F: font }, Properties: { M: member } },
      '/OC /M BDC BT /F 12 Tf 10 100 Td (EXPR) Tj ET EMC',
    );
    doc.insertPage(0, page);
    doc
      .getTrailer()
      .get('Root')
      .put('OCProperties', { OCGs: [group], D: { OFF: [group] } });
    try {
      const sweep = sweepHiddenLayers(doc, true);
      expect(sweep).toMatchObject({ found: 0, removed: 0, undecided: 1, groupsDropped: 0 });
      expect(contentOf(doc)).toContain('(EXPR) Tj');
      // The membership dictionary still points at the group, so the group stays too.
      expect(doc.getTrailer().get('Root').get('OCProperties').get('OCGs').length).toBe(1);
    } finally {
      doc.destroy();
    }
  });

  it('removes a hidden annotation, keeps a hidden widget, and answers zeros without optional content', () => {
    const { doc, page, hidden } = build();
    try {
      const square = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [10, 10, 50, 50],
        OC: hidden,
      });
      const widget = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('f'),
        Rect: [60, 10, 100, 30],
        OC: hidden,
      });
      page.put('Annots', [square, widget]);
      const sweep = sweepHiddenLayers(doc, true);
      expect(sweep).toMatchObject({ found: 5, removed: 4, left: 1 });
      const annots = doc.findPage(0).get('Annots');
      expect(annots.length).toBe(1);
      expect(annots.get(0).get('Subtype').asName()).toBe('Widget');
    } finally {
      doc.destroy();
    }

    const plain = build('', false);
    try {
      expect(sweepHiddenLayers(plain.doc, true)).toEqual({
        groups: 0,
        found: 0,
        removed: 0,
        left: 0,
        undecided: 0,
        unreadable: 0,
        groupsDropped: 0,
      });
      expect(contentOf(plain.doc)).toContain('SECRET');
    } finally {
      plain.doc.destroy();
    }
  });
});
