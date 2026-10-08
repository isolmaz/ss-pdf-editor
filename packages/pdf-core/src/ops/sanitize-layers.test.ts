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

/** A page with `content` and `resources`, and optional content set to `properties`. */
function onePage(
  content: string,
  resources: Record<string, unknown>,
  properties?: Record<string, unknown>,
  doc = new mupdf.PDFDocument(),
): { readonly doc: PDFDocument; readonly page: PDFObject } {
  const page = doc.addPage([0, 0, 612, 792], 0, resources, content);
  doc.insertPage(0, page);
  if (properties !== undefined) doc.getTrailer().get('Root').put('OCProperties', properties);
  return { doc, page: doc.findPage(0) };
}

/** One marked region that draws `token`, hidden or shown according to the group `tag` names. */
const region = (token: string, tag: string): string =>
  `/OC /${tag} BDC BT /F 12 Tf 10 10 Td (${token}) Tj ET EMC\n`;

const ocg = (doc: PDFDocument, name: string, extra: Record<string, unknown> = {}): PDFObject =>
  doc.addObject({ Type: 'OCG', Name: doc.newString(name), ...extra });

describe('the default configuration of optional content', () => {
  it('hides the groups a BaseState of OFF does not list as ON, and skips entries that are no references', () => {
    const doc = new mupdf.PDFDocument();
    const shown = ocg(doc, 'Shown');
    const hidden = ocg(doc, 'Hidden');
    const other = ocg(doc, 'Other');
    const { page } = onePage(
      region('SHOWNTEXT', 'S') + region('HIDDENTEXT', 'H') + region('OTHERTEXT', 'O'),
      { Properties: { S: shown, H: hidden, O: other } },
      {
        // A direct dictionary in each list is not a group reference and names nobody.
        OCGs: [shown, hidden, other, doc.newDictionary()],
        D: { BaseState: 'OFF', ON: [shown, doc.newInteger(7)] },
      },
      doc,
    );
    try {
      expect(sweepHiddenLayers(doc, false)).toMatchObject({ groups: 2, found: 2, left: 0 });
      sweepHiddenLayers(doc, true);
      const content = contentOf(doc);
      expect(content).toContain('SHOWNTEXT');
      expect(content).not.toContain('HIDDENTEXT');
      expect(content).not.toContain('OTHERTEXT');
      expect(page.get('Contents').isNull()).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('lets a usage application for the view event decide by each group’s own ViewState', () => {
    const doc = new mupdf.PDFDocument();
    const viewOff = ocg(doc, 'ViewOff', { Usage: { View: { ViewState: 'OFF' } } });
    const viewOn = ocg(doc, 'ViewOn', { Usage: { View: { ViewState: 'ON' } } });
    const viewOther = ocg(doc, 'ViewOther', { Usage: { View: { ViewState: 'Sideways' } } });
    const noUsage = ocg(doc, 'NoUsage');
    const printOff = ocg(doc, 'PrintOff', { Usage: { View: { ViewState: 'OFF' } } });
    onePage(
      region('VIEWOFFTEXT', 'A') +
        region('VIEWONTEXT', 'B') +
        region('VIEWOTHERTEXT', 'C') +
        region('NOUSAGETEXT', 'D') +
        region('PRINTOFFTEXT', 'E'),
      { Properties: { A: viewOff, B: viewOn, C: viewOther, D: noUsage, E: printOff } },
      {
        OCGs: [viewOff, viewOn, viewOther, noUsage, printOff],
        // `viewOn` is listed OFF, `viewOther` too; the others start ON.
        D: {
          OFF: [viewOn, viewOther],
          AS: [
            doc.newInteger(5),
            { Event: 'Print', Category: ['View'], OCGs: [printOff] },
            { Event: 'View', Category: ['Print'], OCGs: [printOff] },
            { Event: 'View', Category: ['View'] },
            {
              Event: 'View',
              Category: ['View'],
              OCGs: [viewOff, viewOn, viewOther, noUsage, doc.newDictionary()],
            },
          ],
        },
      },
      doc,
    );
    try {
      // OFF by ViewState: `viewOff`. ON by ViewState: `viewOn` (listed OFF, now shown). A state
      // that is neither leaves the listing as it was: `viewOther` stays hidden, `noUsage` shown.
      expect(sweepHiddenLayers(doc, false)).toMatchObject({ groups: 2, found: 2 });
      sweepHiddenLayers(doc, true);
      const content = contentOf(doc);
      expect(content).not.toContain('VIEWOFFTEXT');
      expect(content).toContain('VIEWONTEXT');
      expect(content).not.toContain('VIEWOTHERTEXT');
      expect(content).toContain('NOUSAGETEXT');
      // Only the view event's application counts: Print's does not hide the print group.
      expect(content).toContain('PRINTOFFTEXT');
    } finally {
      doc.destroy();
    }
  });

  it('evaluates a membership dictionary by its policy', () => {
    const doc = new mupdf.PDFDocument();
    const on = ocg(doc, 'On');
    const off = ocg(doc, 'Off');
    const member = (extra: Record<string, unknown>): PDFObject => doc.addObject({ Type: 'OCMD', ...extra });
    const cases: ReadonlyArray<readonly [string, PDFObject, boolean]> = [
      ['ANYON_MIXED', member({ OCGs: [on, off] }), true],
      ['ANYON_OFF', member({ OCGs: [off] }), false],
      ['ANYON_EXPLICIT_OFF', member({ OCGs: [off, off], P: 'AnyOn' }), false],
      ['ALLON_MIXED', member({ OCGs: [on, off], P: 'AllOn' }), false],
      ['ALLON_ON', member({ OCGs: [on, on], P: 'AllOn' }), true],
      ['ANYOFF_MIXED', member({ OCGs: [on, off], P: 'AnyOff' }), true],
      ['ANYOFF_ON', member({ OCGs: [on], P: 'AnyOff' }), false],
      ['ALLOFF_OFF', member({ OCGs: [off, off], P: 'AllOff' }), true],
      ['ALLOFF_MIXED', member({ OCGs: [on, off], P: 'AllOff' }), false],
      ['SINGLE_OFF', member({ OCGs: off }), false],
      ['SINGLE_ON', member({ OCGs: on }), true],
      ['EMPTY_LIST', member({ OCGs: [] }), true],
      ['NO_LIST', member({}), true],
    ];
    const properties: Record<string, PDFObject> = {};
    let content = '';
    for (const [token, entry] of cases.map(([token, entry]) => [token, entry] as const)) {
      properties[token] = entry;
      content += region(token, token);
    }
    onePage(content, { Properties: properties }, { OCGs: [on, off], D: { OFF: [off] } }, doc);
    try {
      const sweep = sweepHiddenLayers(doc, true);
      expect(sweep.undecided).toBe(0);
      const kept = contentOf(doc);
      for (const [token, , visible] of cases) expect(kept.includes(`(${token})`), token).toBe(visible);
    } finally {
      doc.destroy();
    }
  });

  it('counts what it cannot place as undecided and leaves it', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const listed = doc.addObject({ Type: 'OCMD', OCGs: [off, doc.newDictionary()] });
    onePage(
      region('DIRECTTEXT', 'Direct') +
        region('NUMBERTEXT', 'Number') +
        region('LISTEDTEXT', 'Listed') +
        region('MISSINGTEXT', 'Missing') +
        '/Span BDC BT (SPANTEXT) Tj ET EMC\n' +
        '/OC <</MCID 0>> BDC BT (INLINETEXT) Tj ET EMC\n' +
        '/OC BDC BT (BARETEXT) Tj ET EMC\n',
      // `Missing` has no entry at all. `Direct` is a group written in place, `Number` is not a dictionary.
      { Properties: { Direct: doc.newDictionary(), Number: doc.newInteger(3), Listed: listed } },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      const sweep = sweepHiddenLayers(doc, true);
      // A direct `Direct` carries no Type and so reads as a group in place; `Number` is no dictionary;
      // `Listed` holds a member that is no reference. The three are undecided, nothing is cut.
      expect(sweep).toMatchObject({ found: 0, removed: 0, undecided: 3 });
      const content = contentOf(doc);
      for (const token of [
        'DIRECTTEXT',
        'NUMBERTEXT',
        'LISTEDTEXT',
        'MISSINGTEXT',
        'SPANTEXT',
        'INLINETEXT',
        'BARETEXT',
      ]) {
        expect(content, token).toContain(`(${token})`);
      }
    } finally {
      doc.destroy();
    }
  });
});

describe('cutting a hidden region out of the content', () => {
  const hiddenPage = (content: string) => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const { page } = onePage(
      content,
      { Properties: { H: off }, XObject: {} },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    return { doc, page, off };
  };

  it('cuts nested hidden regions with their first one, and lets other marked content ride along', () => {
    const { doc } = hiddenPage(
      '/OC /H BDC /OC /H BDC BT (INNERTEXT) Tj ET EMC /Artifact BMC EMC BT (OUTERTEXT) Tj ET EMC\nBT (VISIBLETEXT) Tj ET',
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1, left: 0 });
      const content = contentOf(doc);
      expect(content).not.toContain('INNERTEXT');
      expect(content).not.toContain('OUTERTEXT');
      expect(content).toContain('(VISIBLETEXT) Tj');
    } finally {
      doc.destroy();
    }
  });

  it('keeps a clip as `path W n` and the line move of a quote, and drops the ink', () => {
    const { doc } = hiddenPage(
      "/OC /H BDC 10 10 50 50 re W n 0 0 5 5 re f 20 20 30 30 re W* n BT 1 0 0 1 5 5 Tm (QUOTED) ' ET EMC\nBT (VISIBLETEXT) Tj ET",
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1, left: 0 });
      const content = contentOf(doc);
      expect(content).toContain('10 10 50 50 re');
      expect(content).toContain('W n');
      expect(content).toContain('20 20 30 30 re');
      expect(content).toContain('W* n');
      expect(content).toContain('T*');
      expect(content).toContain('1 0 0 1 5 5 Tm');
      expect(content).not.toContain('0 0 5 5 re');
      expect(content).not.toContain('QUOTED');
      expect(content).toContain('(VISIBLETEXT) Tj');
    } finally {
      doc.destroy();
    }
  });

  it.each([
    ['a double-quote show, which sets spacing as well as drawing', '/OC /H BDC BT 1 2 (SPACED) " ET EMC\n'],
    ['a region that never closes', '/OC /H BDC BT (OPENENDED) Tj ET\n'],
    ['a path left open at its end', '/OC /H BDC 0 0 5 5 re EMC\nBT (AFTER) Tj ET\n'],
    ['a text object that straddles it', 'BT /OC /H BDC (STRADDLED) Tj EMC ET\n'],
  ])('leaves %s as it is, and counts it as left', (_name, content) => {
    const { doc } = hiddenPage(content);
    try {
      const before = contentOf(doc);
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 0, left: 1 });
      expect(contentOf(doc)).toBe(before);
    } finally {
      doc.destroy();
    }
  });

  it('reads a double quote outside any hidden region as plain content', () => {
    const { doc } = hiddenPage('BT 1 2 (PLAIN) " ET\n/OC /H BDC BT (GONE) Tj ET EMC\n');
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1, left: 0 });
      expect(contentOf(doc)).toContain('(PLAIN) "');
    } finally {
      doc.destroy();
    }
  });

  it('releases a picture drawn only inside a hidden region, and keeps one a visible region still draws', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
    pixmap.clear(30);
    const onlyHidden = doc.addImage(new mupdf.Image(pixmap));
    const other = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
    other.clear(90);
    const shared = doc.addImage(new mupdf.Image(other));
    const { page } = onePage(
      '/OC /H BDC q /OnlyHidden Do Q q /Shared Do Q EMC\nq /Shared Do Q\n',
      {
        Properties: { H: off },
        XObject: { OnlyHidden: onlyHidden, Shared: shared },
      },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      sweepHiddenLayers(doc, true);
      const xobjects = page.get('Resources').get('XObject');
      expect(xobjects.get('OnlyHidden').isNull()).toBe(true);
      expect(xobjects.get('Shared').isNull()).toBe(false);
      expect(page.get('Resources').get('Properties').get('H').isNull()).toBe(true);
    } finally {
      doc.destroy();
    }
  });

  it('refuses a stream the scanner cannot delimit, and a Contents that is not a stream', () => {
    const { doc, page } = hiddenPage('BT (BROKEN) Tj ET ) /OC /H BDC BT (HIDDEN) Tj ET EMC');
    try {
      const before = contentOf(doc);
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 0, unreadable: 1 });
      expect(contentOf(doc)).toBe(before);
      page.put('Contents', doc.newInteger(4));
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 0, unreadable: 1 });
    } finally {
      doc.destroy();
    }
  });

  it('joins a Contents array, and refuses one that holds something that is no stream', () => {
    const { doc, page } = hiddenPage('');
    try {
      const first = doc.addStream('/OC /H BDC BT (FIRSTHIDDEN) Tj ET EMC', {});
      const second = doc.addStream('BT (SECONDVISIBLE) Tj ET', {});
      // Read-only first: a mutating sweep drops the group, and a document without one is not read.
      page.put('Contents', [second, doc.addObject({ NotAStream: true })]);
      expect(sweepHiddenLayers(doc, false)).toMatchObject({ found: 0, unreadable: 1 });
      page.delete('Contents');
      expect(sweepHiddenLayers(doc, false)).toMatchObject({ found: 0, unreadable: 0 });

      page.put('Contents', [first, second]);
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1 });
      const content = contentOf(doc);
      expect(content).not.toContain('FIRSTHIDDEN');
      expect(content).toContain('SECONDVISIBLE');
    } finally {
      doc.destroy();
    }
  });
});

describe('forms, resources and annotations under hidden layers', () => {
  it('reads a Do with no operand, a name with no resource, and a drawn object that is no dictionary, without error', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const { page } = onePage(
      'Do\n/Nothing Do\n/Number Do\n/Direct Do\nBT (KEPT) Tj ET\n/Span BDC (x) Tj EMC',
      { XObject: { Number: doc.newInteger(3), Direct: doc.newDictionary() } },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({
        found: 0,
        removed: 0,
        undecided: 0,
        unreadable: 0,
      });
      expect(contentOf(doc)).toContain('/Number Do');
      expect(page.get('Resources').get('XObject').get('Number').isNull()).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('counts a drawn object whose visibility expression it cannot evaluate, and leaves it', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const expression = doc.addObject({ Type: 'OCMD', VE: ['Not', off] });
    const form = doc.addStream('BT (EXPRFORM) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
      OC: expression,
    });
    onePage('/Fm Do', { XObject: { Fm: form } }, { OCGs: [off], D: { OFF: [off] } }, doc);
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 0, undecided: 1 });
      expect(contentOf(doc)).toContain('/Fm Do');
    } finally {
      doc.destroy();
    }
  });

  it('searches a form that has no resources of its own with the resources of the page that draws it', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const form = doc.addStream(`${region('INHERITEDHIDDEN', 'H')}BT (INHERITEDKEPT) Tj ET`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 100, 100],
    });
    onePage(
      '/Fm Do',
      { Properties: { H: off }, XObject: { Fm: form } },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1 });
      const buffer = form.readStream();
      const text = new TextDecoder().decode(buffer.asUint8Array());
      buffer.destroy();
      expect(text).not.toContain('INHERITEDHIDDEN');
      expect(text).toContain('(INHERITEDKEPT) Tj');
    } finally {
      doc.destroy();
    }
  });

  it('walks a form that draws itself once, and stops nesting at the depth limit', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    // Forms 1..30, each drawing the next; the hidden text sits in the first and the last.
    const forms: PDFObject[] = [];
    const resources = doc.addObject({ Properties: { H: off }, XObject: {} });
    for (let level = 0; level < 30; level += 1) {
      const next = level + 1 < 30 ? `/F${level + 1} Do ` : '';
      const hidden = level === 0 || level === 29 ? region(`HIDDEN${level}`, 'H') : '';
      forms.push(
        doc.addStream(`${hidden}${next}/F${level} Do`, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: resources,
        }),
      );
    }
    for (const [level, form] of forms.entries()) resources.get('XObject').put(`F${level}`, form);
    onePage(
      '/F0 Do',
      { Properties: { H: off }, XObject: { F0: forms[0] } },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      // The cycle (`/Fn Do` inside Fn) ends at once; the nesting ends at 24 levels: the first
      // hidden region is found, the one 29 levels down is beyond the walk and not counted.
      expect(sweepHiddenLayers(doc, false)).toMatchObject({ found: 1, unreadable: 0 });
    } finally {
      doc.destroy();
    }
  });

  it('does not search a form whose dictionary has no stream, or an image', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const bare = doc.addObject({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] });
    onePage('/Bare Do', { XObject: { Bare: bare } }, { OCGs: [off], D: { OFF: [off] } }, doc);
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 0, unreadable: 0 });
    } finally {
      doc.destroy();
    }
  });

  it('reads the resources of a page from its page tree, and none for a tree that has none', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const { page } = onePage(
      `${region('TREEHIDDEN', 'H')}BT (TREEKEPT) Tj ET`,
      {},
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      // With no resources anywhere, `/H` names nothing and nothing is hidden.
      page.delete('Resources');
      expect(sweepHiddenLayers(doc, false)).toMatchObject({ found: 0, undecided: 0 });
      expect(contentOf(doc)).toContain('TREEHIDDEN');
      // The same page, inheriting `/Resources` from its parent node.
      page.get('Parent').put('Resources', { Properties: { H: off } });
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1 });
      expect(contentOf(doc)).not.toContain('TREEHIDDEN');
      expect(contentOf(doc)).toContain('TREEKEPT');
    } finally {
      doc.destroy();
    }
  });

  it('shares the judgement of a resource dictionary between the pages that use it', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
    pixmap.clear(60);
    const picture = doc.addImage(new mupdf.Image(pixmap));
    const resources = doc.addObject({ Properties: { H: off }, XObject: { Im: picture } });
    const first = doc.addPage([0, 0, 200, 200], 0, resources, '/OC /H BDC /Im Do EMC');
    const second = doc.addPage([0, 0, 200, 200], 0, resources, 'q /Im Do Q');
    doc.insertPage(0, first);
    doc.insertPage(1, second);
    doc
      .getTrailer()
      .get('Root')
      .put('OCProperties', { OCGs: [off], D: { OFF: [off] } });
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1 });
      // The second page still draws it, so the shared dictionary keeps the picture.
      expect(resources.get('XObject').get('Im').isNull()).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('judges annotations: dangling and visible ones stay, an undecidable one is counted, a direct hidden one goes', () => {
    const { doc, page, hidden, visible: visibleGroup } = build();
    try {
      const expression = doc.addObject({ Type: 'OCMD', VE: ['Not', hidden] });
      const freed = doc.addObject({ Gone: true });
      doc.deleteObject(freed);
      const visible = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [0, 0, 9, 9],
        OC: visibleGroup,
      });
      const undecided = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [0, 0, 9, 9],
        OC: expression,
      });
      const plain = doc.addObject({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 9, 9] });
      const direct = doc.newDictionary();
      direct.put('Type', doc.newName('Annot'));
      direct.put('Subtype', doc.newName('Circle'));
      direct.put('OC', hidden);
      page.put('Annots', [
        doc.newIndirect(freed.asIndirect()),
        doc.newInteger(3),
        visible,
        undecided,
        plain,
        direct,
      ]);

      const counted = sweepHiddenLayers(doc, false);
      expect(counted).toMatchObject({ found: 4, removed: 0, undecided: 1 });
      expect(doc.findPage(0).get('Annots').length).toBe(6);
      sweepHiddenLayers(doc, true);
      expect(doc.findPage(0).get('Annots').length).toBe(5);
    } finally {
      doc.destroy();
    }
  });
});

describe('dropping the hidden groups from the optional-content properties', () => {
  it('keeps the properties of a document that has no hidden group, and the group something else still names', () => {
    const doc = new mupdf.PDFDocument();
    const shown = ocg(doc, 'Shown');
    onePage('BT (X) Tj ET', {}, { OCGs: [shown], D: {} }, doc);
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ groups: 0, groupsDropped: 0 });
    } finally {
      doc.destroy();
    }

    const second = new mupdf.PDFDocument();
    const hidden = ocg(second, 'StillNamed');
    onePage(
      region('X', 'H'),
      { Properties: { H: hidden } },
      { OCGs: [hidden], D: { OFF: [hidden] } },
      second,
    );
    // An object outside the optional-content properties refers to the group: dropping it would dangle.
    second
      .getTrailer()
      .get('Root')
      .put('Outline', second.addObject({ Mention: hidden }));
    second.getTrailer().get('Root').put('Direct', { Mention: hidden });
    try {
      expect(sweepHiddenLayers(second, true)).toMatchObject({ groups: 1, removed: 1, groupsDropped: 0 });
      expect(second.getTrailer().get('Root').get('OCProperties').get('OCGs').length).toBe(1);
    } finally {
      second.destroy();
    }
  });

  it('drops the group from every list that names it, nested, in alternate configurations and in usage applications', () => {
    const doc = new mupdf.PDFDocument();
    const hidden = ocg(doc, 'Hidden');
    const kept = ocg(doc, 'Kept');
    const alternate = doc.addObject({
      Name: doc.newString('Alt'),
      OFF: [hidden],
      Order: [[hidden, kept], kept],
    });
    onePage(
      region('X', 'H'),
      { Properties: { H: hidden } },
      {
        OCGs: [hidden, kept],
        D: {
          OFF: [hidden],
          Order: [hidden, [kept, hidden], kept],
          Name: doc.newString('Not an array'),
          AS: [{ Event: 'View', Category: ['View'], OCGs: [hidden, kept] }, doc.newInteger(2)],
        },
        Configs: [alternate, doc.newInteger(4)],
      },
      doc,
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ groups: 1, groupsDropped: 1 });
      const properties = doc.getTrailer().get('Root').get('OCProperties');
      expect(properties.get('OCGs').length).toBe(1);
      const config = properties.get('D');
      expect(config.get('OFF').length).toBe(0);
      expect(config.get('Order').length).toBe(2);
      expect(config.get('Order').get(0).length).toBe(1);
      expect(config.get('AS').get(0).get('OCGs').length).toBe(1);
      expect(alternate.get('OFF').length).toBe(0);
      expect(alternate.get('Order').get(0).length).toBe(1);
      expect(properties.get('Configs').length).toBe(2);
    } finally {
      doc.destroy();
    }
  });

  it('takes the whole properties entry out with the last group, and copes with no default configuration', () => {
    const doc = new mupdf.PDFDocument();
    const only = ocg(doc, 'Only');
    // The configuration is missing: nothing is hidden by it, but a usage application would do it.
    onePage(
      region('X', 'H'),
      { Properties: { H: only } },
      { OCGs: [only], D: { AS: [{ Event: 'View', Category: ['View'], OCGs: [only] }] } },
      doc,
    );
    try {
      const properties = doc.getTrailer().get('Root').get('OCProperties');
      only.put('Usage', { View: { ViewState: 'OFF' } });
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ groups: 1, groupsDropped: 1 });
      expect(doc.getTrailer().get('Root').get('OCProperties').isNull()).toBe(true);
      expect(properties.isNull()).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('treats a usage application that names a group nobody listed, with no list of groups at all', () => {
    const doc = new mupdf.PDFDocument();
    const unlisted = ocg(doc, 'Unlisted', { Usage: { View: { ViewState: 'OFF' } } });
    onePage(
      region('UNLISTEDTEXT', 'H'),
      { Properties: { H: unlisted } },
      { D: { AS: [{ Event: 'View', Category: ['View'], OCGs: [unlisted] }] } },
      doc,
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({
        groups: 1,
        found: 1,
        removed: 1,
        groupsDropped: 1,
      });
      expect(contentOf(doc)).not.toContain('UNLISTEDTEXT');
    } finally {
      doc.destroy();
    }
  });

  it('reads a catalog written in the trailer, and skips objects it cannot read or that are gone', () => {
    const doc = new mupdf.PDFDocument();
    const hidden = ocg(doc, 'Hidden');
    const { page } = onePage(
      region('X', 'H'),
      { Properties: { H: hidden } },
      { OCGs: [hidden], D: { OFF: [hidden] } },
      doc,
    );
    const freed = doc.addObject({ Gone: true });
    doc.deleteObject(freed);
    doc.getTrailer().get('Root').put('Dangling', doc.newIndirect(freed.asIndirect()));
    const unreadable = doc.addObject({ Fine: true });
    doc.getTrailer().get('Root').put('Unreadable', unreadable);
    try {
      const broken = new Proxy(doc, {
        get(target, property) {
          if (property === 'newIndirect') {
            return (number: number) => {
              if (number === unreadable.asIndirect()) throw new Error('cannot read object');
              return target.newIndirect(number);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      expect(page.isDictionary()).toBe(true);
      expect(sweepHiddenLayers(broken, true)).toMatchObject({ groups: 1, groupsDropped: 1 });
    } finally {
      doc.destroy();
    }
  });

  it('refuses to go on when the run is aborted', () => {
    const { doc } = build();
    try {
      const controller = new AbortController();
      controller.abort();
      expect(() => sweepHiddenLayers(doc, true, controller.signal)).toThrow(
        expect.objectContaining({ name: 'AbortError' }),
      );
    } finally {
      doc.destroy();
    }
  });
});

describe('what a region the sweep cannot cut still names, and a catalog written in the trailer', () => {
  it('keeps the pictures an uncut region and a name-less Do still draw', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
    pixmap.clear(70);
    const picture = doc.addImage(new mupdf.Image(pixmap));
    const { page } = onePage(
      '/OC /H BDC /Im Do BT (OPENENDED) Tj ET\n',
      { Properties: { H: off }, XObject: { Im: picture } },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 0, left: 1 });
      expect(page.get('Resources').get('XObject').get('Im').isNull()).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('keeps a region cut around a Do that names nothing', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    onePage(
      '/OC /H BDC Do EMC\nBT (AFTER) Tj ET',
      { Properties: { H: off } },
      { OCGs: [off], D: { OFF: [off] } },
      doc,
    );
    try {
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1 });
      expect(contentOf(doc)).toContain('(AFTER) Tj');
    } finally {
      doc.destroy();
    }
  });

  it('judges a page with no resources in a mutating sweep without touching anything', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    const { page } = onePage(region('NORESOURCES', 'H'), {}, { OCGs: [off], D: { OFF: [off] } }, doc);
    try {
      page.delete('Resources');
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 0, removed: 0, groupsDropped: 1 });
      expect(contentOf(doc)).toContain('NORESOURCES');
    } finally {
      doc.destroy();
    }
  });

  it('drops hidden groups when the catalog is written in the trailer instead of being an object', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    onePage(region('DIRECTROOT', 'H'), { Properties: { H: off } }, { OCGs: [off], D: { OFF: [off] } }, doc);
    try {
      const root = doc.getTrailer().get('Root');
      const direct = doc.newDictionary();
      direct.put('Type', doc.newName('Catalog'));
      direct.put('Pages', root.get('Pages'));
      direct.put('OCProperties', root.get('OCProperties'));
      doc.getTrailer().put('Root', direct);
      expect(sweepHiddenLayers(doc, true)).toMatchObject({ found: 1, removed: 1, groupsDropped: 1 });
      expect(contentOf(doc)).not.toContain('DIRECTROOT');
    } finally {
      doc.destroy();
    }
  });
});

describe('a page written directly in its parent’s Kids array', () => {
  it('is searched like any other page, keyed by its own resources', () => {
    const doc = new mupdf.PDFDocument();
    const off = ocg(doc, 'Off');
    onePage('BT (X) Tj ET', {}, { OCGs: [off], D: { OFF: [off] } }, doc);
    try {
      const kids = doc.getTrailer().get('Root').get('Pages').get('Kids');
      kids.delete(0);
      const direct = doc.newDictionary();
      direct.put('Type', doc.newName('Page'));
      direct.put('Parent', doc.getTrailer().get('Root').get('Pages'));
      direct.put('MediaBox', doc.newArray());
      direct.put('Resources', doc.addObject({ Properties: { H: off } }).resolve());
      direct.put('Contents', doc.addStream(`${region('DIRECTPAGE', 'H')}BT (KEPT) Tj ET`, {}));
      kids.push(direct);
      const found = sweepHiddenLayers(doc, false);
      expect(found).toMatchObject({ found: 1 });
    } finally {
      doc.destroy();
    }
  });
});
