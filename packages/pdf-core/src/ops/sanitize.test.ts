/**
 * Sanitise against real bytes: a document built in the test carries one marked item per
 * category (document and link and field scripts, two embedded files, Info and XMP, private
 * data, a thumbnail, a hidden layer, an orphaned object), and the output is searched for each
 * marker in the raw file and in every decoded stream, by MuPDF's object model and its text
 * extraction. The wrong answers that matter: a category that removes its neighbour's data, a
 * "removed" count the output does not bear out, an active action that survives, a safe one that
 * goes, a visible page that changes (the text, the pattern, the image), and a clean file that
 * is rewritten anyway.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFDocument } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import {
  DEFAULT_SANITIZE_OPTIONS,
  type SanitizeCategory,
  type SanitizeOptions,
  sanitizeDocument,
} from './sanitize';

const mupdf = await import('mupdf');
const run = { signal: new AbortController().signal };

const NONE: SanitizeOptions = {
  javascript: false,
  files: false,
  metadata: false,
  privateData: false,
  thumbnails: false,
  links: false,
  comments: false,
  forms: 'keep',
  layers: false,
};

const ALL = { ...DEFAULT_SANITIZE_OPTIONS };

/** Every marker the fixture plants, by the category that owns it. */
const MARKERS = {
  javascript: ['JSNAMES', 'JSOPEN', 'JSLINK', 'JSFIELD'],
  files: ['EMBEDDEDPAYLOAD', 'ATTACHPAYLOAD'],
  metadata: ['AUTHORMARKER', 'TITLEMARKER', 'XMPMARKER'],
  private: ['PIECEMARKER'],
  thumbnails: ['THUMBMARKER'],
  layers: ['HIDDENTEXT'],
  unused: ['ORPHANMARKER'],
} as const;

type Planted = keyof typeof MARKERS;
const PLANTED = Object.keys(MARKERS) as Planted[];

/** What is searched: the file's raw bytes and every stream decoded (object streams included). */
function haystack(bytes: Uint8Array): string {
  const doc = open(bytes);
  try {
    const parts = [new TextDecoder('latin1').decode(bytes)];
    for (let number = 1; number < doc.countObjects(); number += 1) {
      try {
        const object = doc.newIndirect(number);
        if (!object.isStream()) continue;
        const buffer = object.readStream();
        parts.push(new TextDecoder('latin1').decode(buffer.asUint8Array()));
        buffer.destroy();
      } catch {
        // A free or unreadable number holds nothing to search.
      }
    }
    return parts.join('\n');
  } finally {
    doc.destroy();
  }
}

const present = (text: string, group: Planted): boolean =>
  MARKERS[group].every((marker) => text.includes(marker));
const absent = (text: string, group: Planted): boolean =>
  MARKERS[group].every((marker) => !text.includes(marker));

/** Gray 4 x 4 picture, unique per `value` (MuPDF stores two equal images as one object). */
function picture(doc: import('mupdf').PDFDocument, value: number) {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(value);
  return doc.addImage(new mupdf.Image(pixmap));
}

const script = (doc: import('mupdf').PDFDocument, source: string) => ({
  S: 'JavaScript',
  JS: doc.newString(source),
});

/**
 * One A4-ish page: hidden text under a hidden layer, VISIBLETEXT, a red tiling-pattern square
 * and an image; document JavaScript (`/Names /JavaScript` and `/OpenAction`); a link with a
 * JavaScript action; a text field with `/AA`; an embedded file and a file-attachment
 * annotation; Info and XMP; `/PieceInfo` and `/Thumb`; and an object nothing refers to.
 */
function fixture(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  const hidden = doc.addObject({ Type: 'OCG', Name: doc.newString('Hidden') });
  const pattern = doc.addStream('1 0 0 rg 0 0 6 6 re f', {
    Type: 'Pattern',
    PatternType: 1,
    PaintType: 1,
    TilingType: 1,
    BBox: [0, 0, 10, 10],
    XStep: 10,
    YStep: 10,
    Resources: {},
  });
  const content =
    '/OC /Hid BDC BT /F 12 Tf 72 700 Td (HIDDENTEXT) Tj ET EMC\n' +
    'BT /F 12 Tf 72 600 Td (VISIBLETEXT) Tj ET\n' +
    '/Pattern cs /P1 scn 300 300 150 150 re f\n' +
    'q 80 0 0 80 72 300 cm /Im1 Do Q';
  const page = doc.addPage(
    [0, 0, 612, 792],
    0,
    {
      Font: { F: font },
      Pattern: { P1: pattern },
      XObject: { Im1: picture(doc, 10) },
      Properties: { Hid: hidden },
    },
    content,
  );
  doc.insertPage(0, page);
  const root = doc.getTrailer().get('Root');
  root.put('OCProperties', { OCGs: [hidden], D: { OFF: [hidden] } });

  const embedded = doc.addObject({
    Type: 'Filespec',
    F: doc.newString('secret.txt'),
    EF: { F: doc.addStream('EMBEDDEDPAYLOAD', { Type: 'EmbeddedFile' }) },
  });
  root.put('Names', {
    JavaScript: { Names: [doc.newString('doc'), script(doc, 'JSNAMES()')] },
    EmbeddedFiles: { Names: [doc.newString('secret.txt'), embedded] },
  });
  root.put('OpenAction', script(doc, 'JSOPEN()'));
  root.put(
    'Metadata',
    doc.addStream('<x:xmpmeta>XMPMARKER</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }),
  );
  root.put('PieceInfo', { App: { LastModified: doc.newString('PIECEMARKER') } });
  doc.getTrailer().put('Info', {
    Title: doc.newString('TITLEMARKER'),
    Author: doc.newString('AUTHORMARKER'),
    Producer: doc.newString('Some Producer'),
  });
  page.put(
    'Thumb',
    doc.addStream('THUMBMARKER', { Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }),
  );

  const link = doc.addObject({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 10, 100, 30],
    A: script(doc, 'JSLINK()'),
  });
  const field = doc.addObject({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Tx',
    T: doc.newString('f'),
    Rect: [10, 50, 100, 70],
    P: page,
    AA: { K: script(doc, 'JSFIELD()') },
  });
  const attachment = doc.addObject({
    Type: 'Annot',
    Subtype: 'FileAttachment',
    Rect: [10, 90, 30, 110],
    Name: 'PushPin',
    FS: {
      Type: 'Filespec',
      F: doc.newString('attached.txt'),
      EF: { F: doc.addStream('ATTACHPAYLOAD', { Type: 'EmbeddedFile' }) },
    },
  });
  page.put('Annots', [link, field, attachment]);
  root.put('AcroForm', { Fields: [field] });
  doc.addObject({ Orphan: doc.newString('ORPHANMARKER') });

  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function open(bytes: Uint8Array) {
  return mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as PDFDocument;
}

function pageText(bytes: Uint8Array): string {
  const doc = open(bytes);
  try {
    const page = doc.loadPage(0);
    const text = page.toStructuredText('').asText();
    page.destroy();
    return text;
  } finally {
    doc.destroy();
  }
}

/** Page 1 rendered at 1:1; the RGB at a point. */
function pixelAt(bytes: Uint8Array, x: number, y: number): number[] {
  const doc = open(bytes);
  try {
    const page = doc.loadPage(0);
    const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const at = (y * pixmap.getWidth() + x) * 3;
    const rgb = Array.from(pixmap.getPixels().slice(at, at + 3));
    pixmap.destroy();
    page.destroy();
    return rgb;
  } finally {
    doc.destroy();
  }
}

/** The category -> options and its expected count in the fixture (derived from what is planted). */
const CASES: ReadonlyArray<{
  readonly name: string;
  readonly options: SanitizeOptions;
  readonly category: Exclude<SanitizeCategory, 'unused'>;
  readonly planted: Planted;
  readonly found: number;
}> = [
  // Name tree entry, OpenAction, the link's /A and the field's /AA /K.
  {
    name: 'javascript',
    options: { ...NONE, javascript: true },
    category: 'javascript',
    planted: 'javascript',
    found: 4,
  },
  // The embedded file's /EF and the attachment annotation's.
  { name: 'files', options: { ...NONE, files: true }, category: 'files', planted: 'files', found: 2 },
  // Info Title and Author (Producer is kept) and the XMP packet.
  {
    name: 'metadata',
    options: { ...NONE, metadata: true },
    category: 'metadata',
    planted: 'metadata',
    found: 3,
  },
  {
    name: 'private data',
    options: { ...NONE, privateData: true },
    category: 'private',
    planted: 'private',
    found: 1,
  },
  {
    name: 'thumbnails',
    options: { ...NONE, thumbnails: true },
    category: 'thumbnails',
    planted: 'thumbnails',
    found: 1,
  },
  {
    name: 'hidden layers',
    options: { ...NONE, layers: true },
    category: 'layers',
    planted: 'layers',
    found: 1,
  },
];

describe('sanitizeDocument', () => {
  const input = fixture();

  it('plants what it says it plants', () => {
    const text = haystack(input);
    for (const group of PLANTED) expect(present(text, group), group).toBe(true);
  });

  it.each(CASES)('removes exactly $name and nothing else', async ({ options, category, planted, found }) => {
    const out = await sanitizeDocument(input, options, run);
    const text = haystack(out.bytes);
    for (const group of PLANTED) {
      if (group === planted) expect(absent(text, group), `${group} gone`).toBe(true);
      else if (group !== 'unused') expect(present(text, group), `${group} kept`).toBe(true);
    }
    // The count is measured, and the output bears it out.
    const count = out.counts.find((entry) => entry.category === category);
    expect(count).toEqual({ category, found, removed: found, left: 0 });
    expect(out.report.steps).toContain('verify');
    expect(out.report.pageCount).toBe(1);
    // The visible page is the same page: the text, the pattern square, the image.
    expect(pageText(out.bytes)).toContain('VISIBLETEXT');
    expect(pixelAt(out.bytes, 375, 792 - 375)[0]).toBeGreaterThan(200);
    // Nothing selected draws, so the operation compared the pages before and after, pixel for pixel
    // (the attachment icon is the one thing here that is drawn, and the file case removes it).
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.rendered')).toBe(
      category !== 'files',
    );
  });

  it('with every default on: all of it gone, the page intact, the pattern and the image still streams', async () => {
    const out = await sanitizeDocument(input, ALL, run);
    const text = haystack(out.bytes);
    for (const group of PLANTED) expect(absent(text, group), group).toBe(true);
    for (const count of out.counts) expect(count.left, count.category).toBe(0);
    // The orphan and nothing else was unused in the input.
    expect(out.counts.find((entry) => entry.category === 'unused')).toMatchObject({ found: 1, left: 0 });

    expect(pageText(out.bytes)).toContain('VISIBLETEXT');
    expect(pageText(out.bytes)).not.toContain('HIDDENTEXT');
    // The pattern-stream hazard (module header): the pattern keeps its stream and so its square.
    const doc = open(out.bytes);
    try {
      const resources = doc.findPage(0).get('Resources');
      const pattern = resources.get('Pattern').get('P1');
      expect(pattern.isStream()).toBe(true);
      const buffer = pattern.readStream();
      expect(new TextDecoder().decode(buffer.asUint8Array())).toBe('1 0 0 rg 0 0 6 6 re f');
      buffer.destroy();
      const image = resources.get('XObject').get('Im1');
      expect(image.isStream()).toBe(true);
      expect(image.get('Width').asNumber()).toBe(4);
      // Info keeps only the product's producer line.
      const info = doc.getTrailer().get('Info');
      const keys: string[] = [];
      info.forEach((_value, key) => {
        keys.push(String(key));
      });
      expect(keys).toEqual(['Producer']);
      expect(info.get('Producer').asString()).toBe(PRODUCER_LINE);
      expect(doc.countVersions()).toBe(1);
    } finally {
      doc.destroy();
    }
    // Pixel for pixel: the tiling pattern's red and the image's gray are where they were.
    for (const [x, y] of [
      [375, 792 - 375],
      [100, 792 - 340],
    ] as const) {
      expect(pixelAt(out.bytes, x, y)).toEqual(pixelAt(input, x, y));
    }
    // Removing the attachment's icon changes the page, so the report says the pages were not compared.
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toContain('op.note.sanitize.pictureChanges');
    expect(keys).not.toContain('op.note.sanitize.rendered');
    expect(out.bytes.length).toBeLessThan(input.length);
  });

  it('judges each action by its type, and a whole /Next chain together', async () => {
    const doc = new mupdf.PDFDocument();
    const page = doc.addPage([0, 0, 300, 400], 0, {}, '');
    doc.insertPage(0, page);
    const goTo = (): Record<string, unknown> => ({ S: 'GoTo', D: [page, 'Fit'] });
    const links: Array<[string, Record<string, unknown>]> = [
      ['js', script(doc, 'x()')],
      ['launch', { S: 'Launch', F: doc.newString('calc.exe') }],
      ['submit', { S: 'SubmitForm', F: { FS: 'URL', F: doc.newString('http://example.com/') } }],
      ['fileuri', { S: 'URI', URI: doc.newString('file:///C:/secret') }],
      ['http', { S: 'URI', URI: doc.newString('https://example.com/') }],
      ['gotor', { S: 'GoToR', F: doc.newString('other.pdf'), D: [0, 'Fit'] }],
      ['goto', goTo()],
      ['named', { S: 'Named', N: 'NextPage' }],
      ['jschain', { ...script(doc, 'y()'), Next: goTo() }],
      ['gotochain', { ...goTo(), Next: script(doc, 'z()') }],
    ];
    const annots = links.map(([name, action], index) =>
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [10, 10 + index * 20, 100, 25 + index * 20],
        Contents: doc.newString(name),
        A: action,
      }),
    );
    page.put('Annots', annots);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    /** Link name -> the action's type it still has (`null`: the link stays without one); absent: the link is gone. */
    const survivors = (output: Uint8Array): Record<string, string | null> => {
      const read = open(output);
      try {
        const result: Record<string, string | null> = {};
        const list = read.findPage(0).get('Annots');
        for (let index = 0; index < list.length; index += 1) {
          const annot = list.get(index);
          const action = annot.get('A');
          result[annot.get('Contents').asString()] = action.isNull() ? null : action.get('S').asName();
        }
        return result;
      } finally {
        read.destroy();
      }
    };

    // Scripts only: what runs code or reaches a file or the network with the form's data goes;
    // links and remote destinations stay, being content. A script link stays as a link.
    const scripts = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(survivors(scripts.bytes)).toEqual({
      js: null,
      launch: null,
      submit: null,
      fileuri: null,
      http: 'URI',
      gotor: 'GoToR',
      goto: 'GoTo',
      named: 'Named',
      jschain: null,
      // The safe action stays and the script behind it is cut out of its chain.
      gotochain: 'GoTo',
    });
    // js, launch, submit, fileuri, jschain's script and gotochain's script; jschain's GoTo
    // goes with the chain but is not itself a script.
    expect(scripts.counts.find((entry) => entry.category === 'javascript')).toMatchObject({
      found: 6,
      left: 0,
    });
    const chain = open(scripts.bytes);
    try {
      const annots = chain.findPage(0).get('Annots');
      const gotochain = annots.get(annots.length - 1).get('A');
      expect(gotochain.get('Next').isNull()).toBe(true);
    } finally {
      chain.destroy();
    }

    // Links too: URI and GoToR go, and their dead rectangles with them; GoTo and Named stay.
    const external = await sanitizeDocument(bytes, { ...NONE, links: true }, run);
    const left = survivors(external.bytes);
    expect(left.http).toBeUndefined();
    expect(left.gotor).toBeUndefined();
    expect(left.goto).toBe('GoTo');
    expect(left.named).toBe('Named');
    expect(external.counts.find((entry) => entry.category === 'links')).toMatchObject({
      found: 2,
      removed: 2,
      left: 0,
    });
    expect(external.report.notes.some((entry) => entry.key === 'op.note.sanitize.pictureChanges')).toBe(true);

    // Both: a link left with no action at all is a dead rectangle, so the script links go too.
    const both = await sanitizeDocument(bytes, { ...NONE, javascript: true, links: true }, run);
    const rest = survivors(both.bytes);
    expect(rest.js).toBeUndefined();
    expect(rest.launch).toBeUndefined();
    expect(rest.goto).toBe('GoTo');
    expect(rest.gotochain).toBe('GoTo');
  });

  it('returns a clean file as it came, saying so, and refuses an aborted run', async () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const clean = new Uint8Array(doc.saveToBuffer('garbage=compact').asUint8Array());
    doc.destroy();
    const out = await sanitizeDocument(clean, { ...ALL, metadata: false }, run);
    expect(out.bytes).toBe(clean);
    expect(out.counts.every((entry) => entry.found === 0 && entry.removed === 0)).toBe(true);
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.nothing')).toBe(true);

    const controller = new AbortController();
    controller.abort();
    // The guard at the top refuses before the scan reports its first progress: no work ran.
    const progress: unknown[] = [];
    await expect(
      sanitizeDocument(input, ALL, {
        signal: controller.signal,
        onProgress: (entry) => progress.push(entry),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([]);
  });

  it('rewrites a file whose earlier revision still holds an attachment a later update freed', async () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const payload = doc.addStream('FREEDPAYLOAD', { Type: 'EmbeddedFile' });
    const spec = doc.addObject({ Type: 'Filespec', F: doc.newString('old.txt'), EF: { F: payload } });
    doc
      .getTrailer()
      .get('Root')
      .put('Names', { EmbeddedFiles: { Names: [doc.newString('old.txt'), spec] } });
    const first = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    const specNumber = spec.asIndirect();
    const payloadNumber = payload.asIndirect();
    doc.destroy();
    // A later editor removed the attachment by an incremental update that freed its objects.
    const update = open(first);
    update.getTrailer().get('Root').delete('Names');
    update.deleteObject(specNumber);
    update.deleteObject(payloadNumber);
    const input = new Uint8Array(update.saveToBuffer('incremental').asUint8Array());
    update.destroy();
    const before = open(input);
    expect(before.countVersions()).toBe(2);
    before.destroy();
    expect(haystack(input)).toContain('FREEDPAYLOAD');

    // The latest revision holds no attachment, but the file still does.
    const out = await sanitizeDocument(input, { ...NONE, files: true }, run);
    expect(out.bytes).not.toBe(input);
    expect(out.report.incremental).toBe(false);
    expect(haystack(out.bytes)).not.toContain('FREEDPAYLOAD');
    const after = open(out.bytes);
    expect(after.countVersions()).toBe(1);
    after.destroy();
    expect(
      out.report.notes.find((entry) => entry.key === 'op.note.sanitize.revisionsDropped')?.params,
    ).toEqual({
      count: 2,
    });
  });

  it('refuses to drop the XFA of a dynamic form, whose page is only a placeholder, and keeps it otherwise', async () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, '0 0 1 rg 20 90 160 20 re f'));
    const xfa = doc.newArray();
    xfa.push(doc.newString('template'));
    xfa.push(
      doc.addStream(
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1">' +
          '<field name="Name"/><event activity="initialize"><script>this.rawValue = "x";</script></event>' +
          '</subform></template>',
        doc.newDictionary(),
      ),
    );
    const root = doc.getTrailer().get('Root');
    root.put('AcroForm', doc.addObject({ Fields: [], XFA: xfa }));
    root.put('NeedsRendering', true);
    const dynamic = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    // Scripts on (the default): dropping the XFA would leave the placeholder and nothing else.
    await expect(sanitizeDocument(dynamic, { ...NONE, javascript: true }, run)).rejects.toMatchObject({
      code: 'xfa-dynamic',
    });
    await expect(sanitizeDocument(dynamic, { ...NONE, forms: 'remove' }, run)).rejects.toMatchObject({
      code: 'xfa-dynamic',
    });
    // A run that keeps the XFA goes ahead and leaves it in place.
    const kept = await sanitizeDocument(dynamic, { ...NONE, thumbnails: true }, run);
    const out = open(kept.bytes);
    try {
      expect(out.getTrailer().get('Root').get('AcroForm').get('XFA').isNull()).toBe(false);
    } finally {
      out.destroy();
    }
  });

  it('removes form fields on request and leaves the rest of the page', async () => {
    const out = await sanitizeDocument(input, { ...NONE, forms: 'remove' }, run);
    const doc = open(out.bytes);
    try {
      const root = doc.getTrailer().get('Root');
      expect(root.get('AcroForm').isNull()).toBe(true);
      const annots = doc.findPage(0).get('Annots');
      const subtypes: string[] = [];
      for (let index = 0; index < annots.length; index += 1)
        subtypes.push(annots.get(index).get('Subtype').asName());
      expect(subtypes).toEqual(['Link', 'FileAttachment']);
    } finally {
      doc.destroy();
    }
    expect(out.counts.find((entry) => entry.category === 'forms')).toMatchObject({
      found: 1,
      removed: 1,
      left: 0,
    });
    expect(pageText(out.bytes)).toContain('VISIBLETEXT');
  });
});

/** A one-page document the test fills in; returns the saved bytes. */
function build(fill: (doc: PDFDocument, page: import('mupdf').PDFObject) => void, pages = 1): Uint8Array {
  const doc = new mupdf.PDFDocument();
  let first: import('mupdf').PDFObject | null = null;
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([0, 0, 300, 400], 0, {}, '0 0 1 rg 20 20 100 100 re f');
    doc.insertPage(-1, page);
    first ??= page;
  }
  if (first === null) throw new Error('no page');
  fill(doc, first);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The counts of one category in an outcome. */
const countOfCategory = (counts: readonly { category: string }[], category: string) =>
  counts.find((entry) => entry.category === category);

describe('sanitizeDocument: action chains', () => {
  it('counts a script once when its /Next chain loops back on itself', async () => {
    const bytes = build((doc, page) => {
      const js = doc.addObject({ S: 'JavaScript', JS: doc.newString('LOOPJS') });
      js.put('Next', js);
      const link = doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 90, 30], A: js });
      page.put('Annots', [link]);
    });
    expect(haystack(bytes)).toContain('LOOPJS');
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(countOfCategory(out.counts, 'javascript')).toEqual({
      category: 'javascript',
      found: 1,
      removed: 1,
      left: 0,
    });
    expect(haystack(out.bytes)).not.toContain('LOOPJS');
  });

  it('counts each member of a two-action loop once, and each kind under its own category', async () => {
    const bytes = build((doc, page) => {
      const js = doc.addObject({ S: 'JavaScript', JS: doc.newString('PINGJS') });
      const uri = doc.addObject({ S: 'URI', URI: doc.newString('https://example.com/loop') });
      js.put('Next', uri);
      uri.put('Next', js);
      const link = doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 90, 30], A: js });
      page.put('Annots', [link]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true, links: true }, run);
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(countOfCategory(out.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
  });
});

/** Annotation name -> what its /A is afterwards (`null`: no action; `undefined`: the annotation is gone). */
function actionsAfter(bytes: Uint8Array): Record<string, unknown> {
  const read = open(bytes);
  try {
    const result: Record<string, unknown> = {};
    const list = read.findPage(0).get('Annots');
    for (let index = 0; index < list.length; index += 1) {
      const annot = list.get(index);
      const action = annot.get('A');
      result[annot.get('Contents').asString()] = action.isNull()
        ? null
        : action.isDictionary()
          ? action.get('S').asName()
          : 'not-a-dictionary';
    }
    return result;
  } finally {
    read.destroy();
  }
}

describe('sanitizeDocument: unusual actions', () => {
  const link = (doc: PDFDocument, name: string, index: number, action: unknown) =>
    doc.addObject({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 10 + index * 20, 100, 25 + index * 20],
      Contents: doc.newString(name),
      A: action,
    });

  it('leaves an action with no type, a non-dictionary /A and a non-dictionary /AA alone', async () => {
    const bytes = build((doc, page) => {
      page.put('Annots', [
        link(doc, 'untyped', 0, { Foo: 'Bar' }),
        link(doc, 'number', 1, 5),
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 90, 100, 105],
          Contents: doc.newString('aa'),
          AA: 5,
        }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true, links: true }, run);
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.nothing')).toBe(true);
    expect(out.bytes).toBe(bytes);
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 0 });
    expect(countOfCategory(out.counts, 'links')).toMatchObject({ found: 0 });
  });

  it('treats a URI action without an address as an external link, not as a file address', async () => {
    const bytes = build((doc, page) => {
      page.put('Annots', [link(doc, 'bare', 0, { S: 'URI' })]);
    });
    const scripts = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(scripts.bytes).toBe(bytes);
    const links = await sanitizeDocument(bytes, { ...NONE, links: true }, run);
    expect(countOfCategory(links.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(actionsAfter(links.bytes)).toEqual({});
  });

  it('counts every action in a /Next array, by kind, and removes a link whose whole chain went', async () => {
    const bytes = build((doc, page) => {
      const uri = (): Record<string, unknown> => ({ S: 'URI', URI: doc.newString('https://example.com/') });
      page.put('Annots', [
        link(doc, 'array', 0, {
          ...script(doc, 'FIRSTJS'),
          Next: [script(doc, 'SECONDJS'), uri(), { S: 'GoTo', D: [page, 'Fit'] }, 7],
        }),
      ]);
    });
    const both = await sanitizeDocument(bytes, { ...NONE, javascript: true, links: true }, run);
    expect(countOfCategory(both.counts, 'javascript')).toMatchObject({ found: 2, removed: 2, left: 0 });
    expect(countOfCategory(both.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(haystack(both.bytes)).not.toContain('SECONDJS');
    expect(actionsAfter(both.bytes)).toEqual({});
    // Scripts only: the URI in the array is not counted as a link, the link itself stays.
    const scripts = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(countOfCategory(scripts.counts, 'javascript')).toMatchObject({ found: 2, removed: 2, left: 0 });
    expect(actionsAfter(scripts.bytes)).toEqual({ array: null });
    // A run that is only about links leaves the scripts (not selected) and cuts the URI out of the array.
    const links = await sanitizeDocument(bytes, { ...NONE, links: true }, run);
    expect(countOfCategory(links.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(countOfCategory(links.counts, 'javascript')).toBeUndefined();
    expect(haystack(links.bytes)).toContain('SECONDJS');
    expect(haystack(links.bytes)).not.toContain('example.com');
  });

  it('cuts the doomed actions out of the /Next array of an action that stays', async () => {
    const bytes = build((doc, page) => {
      page.put('Annots', [
        link(doc, 'safe', 0, {
          S: 'GoTo',
          D: [page, 'Fit'],
          Next: [
            script(doc, 'INARRAYJS'),
            { S: 'Named', N: 'NextPage' },
            { S: 'URI', URI: doc.newString('https://example.com/next') },
          ],
        }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 1, removed: 1, left: 0 });
    const read = open(out.bytes);
    try {
      const action = read.findPage(0).get('Annots').get(0).get('A');
      const chain = action.get('Next');
      const types: string[] = [];
      for (let index = 0; index < chain.length; index += 1) types.push(chain.get(index).get('S').asName());
      expect(types).toEqual(['Named', 'URI']);
    } finally {
      read.destroy();
    }
  });

  it('stops following a chain of safe actions that loops back, and one longer than the depth limit', async () => {
    const bytes = build((doc, page) => {
      const goto = doc.addObject({ S: 'GoTo', D: [page, 'Fit'] });
      goto.put('Next', goto);
      // 30 GoTo actions in a row; the script at the end is past what the sweep follows.
      let tail: unknown = script(doc, 'DEEPACTIONJS');
      for (let index = 0; index < 30; index += 1) tail = { S: 'GoTo', D: [page, 'Fit'], Next: tail };
      page.put('Annots', [link(doc, 'loop', 0, goto), link(doc, 'deep', 1, tail)]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 0, left: 0 });
    expect(actionsAfter(out.bytes)).toEqual({ loop: 'GoTo', deep: 'GoTo' });
  });
});

describe('sanitizeDocument: what each category counts', () => {
  it('counts every way a file is attached, once, and drops /AF and the attachment annotations', async () => {
    const bytes = build((doc, page) => {
      const spec = (name: string, marker: string | null) =>
        doc.addObject({
          Type: 'Filespec',
          F: doc.newString(name),
          ...(marker === null ? {} : { EF: { F: doc.addStream(marker, { Type: 'EmbeddedFile' }) } }),
        });
      const root = doc.getTrailer().get('Root');
      page.put('AF', [spec('af.txt', 'AFPAYLOAD')]);
      root.put('Names', {
        EmbeddedFiles: { Names: [doc.newString('n.txt'), spec('n.txt', 'NAMESPAYLOAD')] },
      });
      const attachment = (name: string, source: Record<string, unknown>) =>
        doc.addObject({
          Type: 'Annot',
          Subtype: 'FileAttachment',
          Rect: [10, 10, 30, 30],
          Contents: doc.newString(name),
          ...source,
        });
      page.put('Annots', [
        // File specification by reference, nothing embedded: counted by its annotation.
        attachment('indirect-bare', { FS: spec('bare.txt', null) }),
        // File specification written in place, nothing embedded.
        attachment('direct-bare', { FS: { Type: 'Filespec', F: doc.newString('d.txt') } }),
        // No file specification at all.
        attachment('missing', {}),
        // Written in place, with a payload: counted through its /EF.
        attachment('direct-embedded', {
          FS: { Type: 'Filespec', F: doc.newString('e.txt'), EF: { F: doc.addStream('DIRECTPAYLOAD', {}) } },
        }),
        // By reference with a payload: counted through its /EF, not a second time as an annotation.
        attachment('indirect-embedded', { FS: spec('i.txt', 'INDIRECTPAYLOAD') }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, files: true }, run);
    // /AF spec, name-tree spec, direct EF, indirect EF  + bare: direct, missing, by reference.
    expect(countOfCategory(out.counts, 'files')).toEqual({
      category: 'files',
      found: 7,
      removed: 7,
      left: 0,
    });
    const text = haystack(out.bytes);
    for (const marker of ['AFPAYLOAD', 'NAMESPAYLOAD', 'DIRECTPAYLOAD', 'INDIRECTPAYLOAD'])
      expect(text).not.toContain(marker);
    const read = open(out.bytes);
    try {
      expect(read.findPage(0).get('AF').isNull()).toBe(true);
      expect(read.findPage(0).get('Annots').length).toBe(0);
    } finally {
      read.destroy();
    }
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.pictureChanges')).toBe(true);
  });

  it('counts web-capture data, the catalog URI base and a signature, and warns that the signature does not survive', async () => {
    const bytes = build((doc, page) => {
      const root = doc.getTrailer().get('Root');
      root.put('SpiderInfo', { V: 1.0 });
      root.put('URI', { Base: doc.newString('https://example.com/base/') });
      root.put('Names', { IDS: { Names: [] }, URLS: { Names: [] } });
      root.put('Perms', {
        DocMDP: doc.addObject({
          Type: 'Sig',
          Filter: 'Adobe.PPKLite',
          SubFilter: 'adbe.pkcs7.detached',
          ByteRange: [0, 1, 2, 3],
          Contents: doc.newString('00'),
        }),
      });
      page.put(
        'Thumb',
        doc.addStream('THUMB', { Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }),
      );
    });
    const out = await sanitizeDocument(
      bytes,
      { ...NONE, privateData: true, links: true, metadata: true, thumbnails: true },
      run,
    );
    expect(countOfCategory(out.counts, 'private')).toMatchObject({ found: 3, removed: 3, left: 0 });
    expect(countOfCategory(out.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
    // The document has no Info dictionary: nothing to count there.
    expect(countOfCategory(out.counts, 'metadata')).toMatchObject({ found: 0, removed: 0, left: 0 });
    const read = open(out.bytes);
    try {
      const root = read.getTrailer().get('Root');
      expect(root.get('SpiderInfo').isNull()).toBe(true);
      expect(root.get('URI').isNull()).toBe(true);
      expect(root.get('Names').get('IDS').isNull()).toBe(true);
      expect(root.get('Names').get('URLS').isNull()).toBe(true);
    } finally {
      read.destroy();
    }
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.signatureBroken')).toBe(true);
    // A document with no signature carries no such warning.
    const plain = await sanitizeDocument(
      build((doc, page) =>
        page.put(
          'Thumb',
          doc.addStream('T', { Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }),
        ),
      ),
      { ...NONE, thumbnails: true },
      run,
    );
    expect(plain.report.notes.some((entry) => entry.key === 'op.note.sanitize.signatureBroken')).toBe(false);
  });

  it('counts every entry of a nested JavaScript name tree, skips what is not a node, and stops at the depth limit', async () => {
    const bytes = build((doc) => {
      const root = doc.getTrailer().get('Root');
      const entry = (name: string) => [doc.newString(name), script(doc, `${name}()`)];
      let deepest: Record<string, unknown> = { Names: entry('DEEPJS') };
      for (let level = 0; level < 30; level += 1) deepest = { Kids: [deepest] };
      root.put('Names', {
        JavaScript: { Names: entry('TOPJS'), Kids: [{ Names: [...entry('A'), ...entry('B')] }, 5, deepest] },
      });
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    // The top node's entry and the two of its first kid; the 30-deep leaf is past the limit.
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 3, removed: 3, left: 0 });
    expect(haystack(out.bytes)).not.toContain('DEEPJS');
  });

  it('does not touch a name tree node without names or kids', async () => {
    const bytes = build((doc) => {
      doc.getTrailer().get('Root').put('Names', { JavaScript: {} });
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 0, removed: 0, left: 0 });
  });
});

describe('sanitizeDocument: annotations', () => {
  const annot = (doc: PDFDocument, subtype: string, name: string, extra: Record<string, unknown> = {}) =>
    doc.addObject({
      Type: 'Annot',
      Subtype: subtype,
      Rect: [10, 10, 40, 40],
      Contents: doc.newString(name),
      ...extra,
    });

  it('removes comments and their popups, direct annotations included, and leaves links, widgets and entries that are not annotations', async () => {
    const bytes = build((doc, page) => {
      const popup = annot(doc, 'Popup', 'popup');
      page.put('Annots', [
        annot(doc, 'Text', 'note', { Popup: popup }),
        popup,
        annot(doc, 'Highlight', 'hl', { QuadPoints: [10, 40, 40, 40, 10, 10, 40, 10] }),
        // A comment written in place instead of by reference.
        { Type: 'Annot', Subtype: 'Square', Rect: [50, 50, 80, 80], Contents: doc.newString('direct') },
        annot(doc, 'Link', 'link', { Dest: [page, 'Fit'] }),
        annot(doc, 'Unknown', 'other'),
        // An annotation without a subtype, and entries that are no annotation at all.
        { Type: 'Annot', Rect: [0, 0, 1, 1], Contents: doc.newString('typeless') },
        7,
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, comments: true }, run);
    // Text, Highlight and the direct Square: the popup is removed with them but is not a comment.
    expect(countOfCategory(out.counts, 'comments')).toMatchObject({ found: 3, removed: 3, left: 0 });
    const read = open(out.bytes);
    try {
      const list = read.findPage(0).get('Annots');
      const names: string[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const entry = list.get(index);
        names.push(entry.isDictionary() ? entry.get('Contents').asString() : 'not-a-dictionary');
      }
      expect(names).toEqual(['link', 'other', 'typeless', 'not-a-dictionary']);
    } finally {
      read.destroy();
    }
    // Comments are drawn: the pages were not compared.
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.pictureChanges')).toBe(true);
  });

  it('keeps popups when comments are not selected, and warns about scripts in media annotations it does not read', async () => {
    const bytes = build((doc, page) => {
      page.put('Annots', [
        annot(doc, 'Popup', 'popup'),
        annot(doc, 'RichMedia', 'rich'),
        annot(doc, '3D', 'three'),
        annot(doc, 'Link', 'jslink', { A: script(doc, 'MEDIAJS') }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    const media = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.media');
    expect(media?.params).toEqual({ count: 2 });
    const read = open(out.bytes);
    try {
      expect(read.findPage(0).get('Annots').length).toBe(4);
    } finally {
      read.destroy();
    }
    // Without the scripts option the warning does not apply.
    const links = await sanitizeDocument(bytes, { ...NONE, links: true }, run);
    expect(links.report.notes.some((entry) => entry.key === 'op.note.sanitize.media')).toBe(false);
  });

  it('removes a link annotation written in place together with its external action', async () => {
    const bytes = build((_doc, page) => {
      page.put('Annots', [
        {
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10, 10, 90, 30],
          Contents: 'direct',
          A: { S: 'URI', URI: 'https://example.com/direct' },
        },
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, links: true }, run);
    expect(countOfCategory(out.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
    const read = open(out.bytes);
    try {
      expect(read.findPage(0).get('Annots').length).toBe(0);
    } finally {
      read.destroy();
    }
  });
});

/** A form with a text field (value FIELDVALUE), optionally a push button, scripts and an XFA packet. */
function formDocument(options: { button?: boolean; xfa?: string; fieldScript?: boolean } = {}): Uint8Array {
  return build((doc, page) => {
    const helv = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    const da = doc.newString('/Helv 12 Tf 0 g');
    const field = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Tx',
      T: doc.newString('name'),
      V: doc.newString('FIELDVALUE'),
      DA: da,
      Rect: [20, 300, 200, 330],
      P: page,
      F: 4,
      ...(options.fieldScript === true ? { AA: { K: script(doc, 'FIELDJS') } } : {}),
    });
    const fields = [field];
    const annots = [field];
    if (options.button === true) {
      const button = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Btn',
        Ff: 65536,
        T: doc.newString('go'),
        Rect: [20, 250, 100, 280],
        P: page,
        F: 4,
      });
      fields.push(button);
      annots.push(button);
    }
    page.put('Annots', annots);
    const form: Record<string, unknown> = { Fields: fields, DR: { Font: { Helv: helv } }, DA: da };
    if (options.xfa !== undefined) form.XFA = doc.addStream(options.xfa, {});
    doc.getTrailer().get('Root').put('AcroForm', form);
  });
}

/** The form writer draws missing appearances with the bundled Noto Sans, which the app fetches. */
function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

describe('sanitizeDocument: forms', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flattens a field into the page, counts it, and drops the form', async () => {
    const bytes = formDocument();
    expect(pageText(bytes)).not.toContain('FIELDVALUE');
    const out = await sanitizeDocument(bytes, { ...NONE, forms: 'flatten' }, run);
    expect(countOfCategory(out.counts, 'forms')).toEqual({
      category: 'forms',
      found: 1,
      removed: 1,
      left: 0,
    });
    expect(pageText(out.bytes)).toContain('FIELDVALUE');
    const read = open(out.bytes);
    try {
      expect(read.getTrailer().get('Root').get('AcroForm').isNull()).toBe(true);
      expect(read.findPage(0).get('Annots').length).toBe(0);
    } finally {
      read.destroy();
    }
    expect(out.report.steps).toContain('sanitize.forms');
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.removed.forms')).toBe(true);
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.pictureChanges')).toBe(true);
  });

  it('flattens what can be flattened, reports the push button that stays, and keeps the form for it', async () => {
    const out = await sanitizeDocument(formDocument({ button: true }), { ...NONE, forms: 'flatten' }, run);
    expect(countOfCategory(out.counts, 'forms')).toEqual({
      category: 'forms',
      found: 2,
      removed: 1,
      left: 1,
    });
    expect(pageText(out.bytes)).toContain('FIELDVALUE');
    const warning = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.formsLeft');
    expect(warning?.params).toEqual({ count: 1 });
    const read = open(out.bytes);
    try {
      expect(read.getTrailer().get('Root').get('AcroForm').isNull()).toBe(false);
    } finally {
      read.destroy();
    }
  });

  it('has nothing to flatten in a form of push buttons only: the form stays as it was', async () => {
    const bytes = build((doc, page) => {
      const button = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Btn',
        Ff: 65536,
        T: doc.newString('go'),
        Rect: [20, 250, 100, 280],
        P: page,
        F: 4,
      });
      page.put('Annots', [button]);
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [button] });
    });
    const out = await sanitizeDocument(bytes, { ...NONE, forms: 'flatten' }, run);
    expect(countOfCategory(out.counts, 'forms')).toEqual({
      category: 'forms',
      found: 1,
      removed: 0,
      left: 1,
    });
    expect(out.report.steps).not.toContain('flatten');
  });

  it('drops the XFA packet of a form that is flattened or carries a script, and counts that script', async () => {
    const xfa = '<template><subform><event><script>XFASCRIPT</script></event></subform></template>';
    const bytes = formDocument({ xfa });
    expect(haystack(bytes)).toContain('XFASCRIPT');
    const flattened = await sanitizeDocument(bytes, { ...NONE, forms: 'flatten' }, run);
    expect(haystack(flattened.bytes)).not.toContain('XFASCRIPT');
    expect(pageText(flattened.bytes)).toContain('FIELDVALUE');
    // Scripts only: the form stays a form, its XFA goes whole because a script cannot be cut out of XML.
    const scripts = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(countOfCategory(scripts.counts, 'javascript')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(haystack(scripts.bytes)).not.toContain('XFASCRIPT');
    expect(scripts.report.notes.some((entry) => entry.key === 'op.note.sanitize.xfaDropped')).toBe(true);
    const read = open(scripts.bytes);
    try {
      const form = read.getTrailer().get('Root').get('AcroForm');
      expect(form.isNull()).toBe(false);
      expect(form.get('XFA').isNull()).toBe(true);
    } finally {
      read.destroy();
    }
  });

  it('reads an XFA given as an array of packets: only the stream entries are packets, and only a packet with a script counts', async () => {
    const bytes = build((doc, page) => {
      const field = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('name'),
        Rect: [20, 300, 200, 330],
        P: page,
      });
      page.put('Annots', [field]);
      const xfa = doc.newArray();
      xfa.push(doc.newString('template'));
      xfa.push(doc.addStream('<template>quiet</template>', {}));
      xfa.push(doc.newString('datasets'));
      xfa.push(doc.newString('not a stream'));
      xfa.push(doc.newString('config'));
      xfa.push(doc.addStream('<config><script>ARRAYSCRIPT</script></config>', {}));
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [field], XFA: xfa });
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(haystack(out.bytes)).not.toContain('ARRAYSCRIPT');
  });

  it('keeps an XFA that is neither a stream nor an array of packets, and one with no script, when scripts are the only target', async () => {
    const withXfa = (value: (doc: PDFDocument) => unknown) =>
      build((doc, page) => {
        const field = doc.addObject({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Tx',
          T: doc.newString('name'),
          Rect: [20, 300, 200, 330],
          P: page,
        });
        page.put('Annots', [field]);
        doc
          .getTrailer()
          .get('Root')
          .put('AcroForm', { Fields: [field], XFA: value(doc) });
      });
    for (const bytes of [
      withXfa(() => 5),
      withXfa((doc) => doc.addStream('<template>quiet</template>', {})),
    ]) {
      const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
      expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 0 });
      expect(out.bytes).toBe(bytes);
    }
  });

  it('counts the scripts of a form the input held when the form itself is removed (read-only count of the input)', async () => {
    const bytes = formDocument({ button: true, fieldScript: true });
    const everything: SanitizeOptions = { ...ALL, links: true, comments: true, forms: 'remove' };
    const out = await sanitizeDocument(bytes, everything, run);
    expect(countOfCategory(out.counts, 'javascript')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(countOfCategory(out.counts, 'forms')).toMatchObject({ found: 2, removed: 2, left: 0 });
    expect(haystack(out.bytes)).not.toContain('FIELDJS');
  });

  it('counts, in a read-only pass over the input, every category the fixture holds when its form is removed', async () => {
    const out = await sanitizeDocument(fixture(), { ...ALL, forms: 'remove' }, run);
    const found = Object.fromEntries(out.counts.map((entry) => [entry.category, entry.found]));
    expect(found).toEqual({
      javascript: 4,
      files: 2,
      metadata: 3,
      private: 1,
      thumbnails: 1,
      layers: 1,
      forms: 1,
      unused: 1,
    });
    expect(out.counts.every((entry) => entry.left === 0)).toBe(true);
  });
});

describe('sanitizeDocument: structure', () => {
  it('refuses a document with no pages, as a corrupt one', async () => {
    const doc = new mupdf.PDFDocument();
    doc
      .getTrailer()
      .get('Root')
      .put('Names', { JavaScript: { Names: [doc.newString('x'), script(doc, 'EMPTYJS')] } });
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    await expect(sanitizeDocument(bytes, ALL, run)).rejects.toMatchObject({ code: 'corrupt-document' });
  });

  it('does not report the file plumbing of object streams as unused objects', async () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const bytes = new Uint8Array(doc.saveToBuffer('garbage=compact,compress,objstms').asUint8Array());
    doc.destroy();
    const probe = open(bytes);
    let containers = 0;
    try {
      for (let number = 1; number < probe.countObjects(); number += 1) {
        const object = probe.newIndirect(number);
        if (object.isStream() && object.resolve().get('Type').asName() === 'ObjStm') containers += 1;
      }
    } finally {
      probe.destroy();
    }
    expect(containers).toBeGreaterThan(0);
    const out = await sanitizeDocument(bytes, { ...ALL, metadata: false }, run);
    expect(out.counts.find((entry) => entry.category === 'unused')).toEqual({
      category: 'unused',
      found: 0,
      removed: 0,
      left: 0,
    });
    expect(out.bytes).toBe(bytes);
  });

  it('compares 40 evenly spread pages of a long document', async () => {
    const bytes = build((doc, page) => {
      page.put(
        'Thumb',
        doc.addStream('THUMB', { Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }),
      );
    }, 45);
    const out = await sanitizeDocument(bytes, { ...NONE, thumbnails: true }, run);
    expect(out.report.pageCount).toBe(45);
    const rendered = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.rendered');
    expect(rendered?.params).toEqual({ pages: 40 });
  });
});

describe('sanitizeDocument: hidden layers in the report', () => {
  const layered = (
    fill: (doc: PDFDocument, page: import('mupdf').PDFObject, hidden: import('mupdf').PDFObject) => void,
    content = '',
  ) =>
    (() => {
      const doc = new mupdf.PDFDocument();
      const page = doc.addPage([0, 0, 300, 400], 0, {}, content);
      doc.insertPage(-1, page);
      const hidden = doc.addObject({ Type: 'OCG', Name: doc.newString('Hidden') });
      doc
        .getTrailer()
        .get('Root')
        .put('OCProperties', { OCGs: [hidden], D: { OFF: [hidden] } });
      fill(doc, page, hidden);
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      return bytes;
    })();

  it('says how many hidden items it could not decide, and leaves them', async () => {
    const bytes = layered((doc, page, hidden) => {
      const membership = doc.addObject({ Type: 'OCMD', OCGs: [hidden], VE: ['And', hidden] });
      page.put('Annots', [
        doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 30], OC: membership }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, layers: true }, run);
    expect(out.bytes).toBe(bytes);
    expect(countOfCategory(out.counts, 'layers')).toEqual({
      category: 'layers',
      found: 0,
      removed: 0,
      left: 0,
    });
    const warning = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.layersUndecided');
    expect(warning?.params).toEqual({ count: 1 });
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.none.layers')).toBe(false);
  });

  it('says how many content streams it could not read, in a run that changes the file too', async () => {
    const bytes = layered((doc, page) => {
      page.put(
        'Thumb',
        doc.addStream('THUMB', { Width: 1, Height: 1, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }),
      );
    }, ') 0 0 m');
    const out = await sanitizeDocument(bytes, { ...NONE, layers: true, thumbnails: true }, run);
    const warning = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.layersUnreadable');
    expect(warning?.params).toEqual({ count: 1 });
    expect(countOfCategory(out.counts, 'thumbnails')).toMatchObject({ found: 1, removed: 1 });
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.none.layers')).toBe(false);
  });

  it('removes a hidden annotation, keeps the hidden widget it cannot remove, and says so', async () => {
    const bytes = layered((doc, page, hidden) => {
      page.put('Annots', [
        doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 50, 30], OC: hidden }),
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Tx',
          T: doc.newString('w'),
          Rect: [10, 50, 50, 70],
          OC: hidden,
        }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, layers: true }, run);
    expect(countOfCategory(out.counts, 'layers')).toEqual({
      category: 'layers',
      found: 2,
      removed: 1,
      left: 1,
    });
    const warning = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.layersLeft');
    expect(warning?.params).toEqual({ count: 1 });
    const removed = out.report.notes.find((entry) => entry.key === 'op.note.sanitize.removed.layers');
    expect(removed?.params).toMatchObject({ removed: 1 });
  });

  it('with only a hidden widget to find, reports it as left and returns the file untouched', async () => {
    const bytes = layered((doc, page, hidden) => {
      page.put('Annots', [
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Tx',
          T: doc.newString('w'),
          Rect: [10, 50, 50, 70],
          OC: hidden,
        }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, layers: true }, run);
    expect(out.bytes).toBe(bytes);
    expect(countOfCategory(out.counts, 'layers')).toEqual({
      category: 'layers',
      found: 0,
      removed: 0,
      left: 1,
    });
    expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.layersLeft')).toBe(true);
  });
});

describe('sanitizeDocument: nothing to find in a form', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a document with no form untouched when forms are to be removed or flattened', async () => {
    const bytes = build(() => undefined);
    for (const forms of ['remove', 'flatten'] as const) {
      const out = await sanitizeDocument(bytes, { ...NONE, forms }, run);
      expect(out.bytes).toBe(bytes);
      expect(countOfCategory(out.counts, 'forms')).toEqual({
        category: 'forms',
        found: 0,
        removed: 0,
        left: 0,
      });
      expect(out.report.notes.some((entry) => entry.key === 'op.note.sanitize.none.forms')).toBe(true);
    }
  });

  it('does not count as flattenable a text field that is on no page, and keeps the form for the button that stays', async () => {
    const bytes = build((doc, page) => {
      const lost = doc.addObject({ FT: 'Tx', T: doc.newString('lost'), V: doc.newString('LOSTVALUE') });
      const button = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Btn',
        Ff: 65536,
        T: doc.newString('go'),
        Rect: [20, 250, 100, 280],
        P: page,
      });
      page.put('Annots', [button]);
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [lost, button] });
    });
    const out = await sanitizeDocument(bytes, { ...NONE, forms: 'flatten' }, run);
    expect(countOfCategory(out.counts, 'forms')).toEqual({
      category: 'forms',
      found: 2,
      removed: 0,
      left: 2,
    });
  });
});

describe('sanitizeDocument: read-only count of the input matches the removing sweep', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('counts the same files, web-capture data and catalog URI when the form is removed too, and leaves unselected ones', async () => {
    const bytes = build((doc, page) => {
      const spec = doc.addObject({
        Type: 'Filespec',
        F: doc.newString('af.txt'),
        EF: { F: doc.addStream('AFPAYLOAD', { Type: 'EmbeddedFile' }) },
      });
      page.put('AF', [spec]);
      const root = doc.getTrailer().get('Root');
      root.put('SpiderInfo', { V: 1.0 });
      root.put('URI', { Base: doc.newString('https://example.com/base/') });
      root.put('Names', { IDS: { Names: [] }, URLS: { Names: [] } });
      const field = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('name'),
        Rect: [20, 300, 200, 330],
        P: page,
      });
      page.put('Annots', [field]);
      root.put('AcroForm', { Fields: [field] });
    });
    const selected: SanitizeOptions = { ...NONE, files: true, privateData: true, links: true };
    const keep = await sanitizeDocument(bytes, selected, run);
    const remove = await sanitizeDocument(bytes, { ...selected, forms: 'remove' }, run);
    for (const out of [keep, remove]) {
      expect(countOfCategory(out.counts, 'files')).toEqual({
        category: 'files',
        found: 1,
        removed: 1,
        left: 0,
      });
      expect(countOfCategory(out.counts, 'private')).toEqual({
        category: 'private',
        found: 3,
        removed: 3,
        left: 0,
      });
      expect(countOfCategory(out.counts, 'links')).toEqual({
        category: 'links',
        found: 1,
        removed: 1,
        left: 0,
      });
      expect(haystack(out.bytes)).not.toContain('AFPAYLOAD');
    }
    // Only the links are selected: web-capture data and attachments stay.
    const linksOnly = await sanitizeDocument(bytes, { ...NONE, links: true }, run);
    expect(haystack(linksOnly.bytes)).toContain('AFPAYLOAD');
    const read = open(linksOnly.bytes);
    try {
      expect(read.getTrailer().get('Root').get('SpiderInfo').isNull()).toBe(false);
      expect(read.getTrailer().get('Root').get('Names').get('IDS').isNull()).toBe(false);
    } finally {
      read.destroy();
    }
  });

  it('keeps a comment when comments are not selected', async () => {
    const bytes = build((doc, page) => {
      page.put('Annots', [
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [10, 10, 30, 30],
          Contents: doc.newString('NOTE'),
        }),
        doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [10, 40, 90, 60], A: script(doc, 'KEEPJS') }),
      ]);
    });
    const out = await sanitizeDocument(bytes, { ...NONE, javascript: true }, run);
    const read = open(out.bytes);
    try {
      const list = read.findPage(0).get('Annots');
      expect(list.length).toBe(2);
      expect(list.get(0).get('Subtype').asName()).toBe('Text');
    } finally {
      read.destroy();
    }
  });
});

describe('sanitizeDocument: a page object written in place', () => {
  /** A document whose only page is a dictionary inside the page tree's `/Kids`, with one link. */
  const inPlace = (withParent: boolean): Uint8Array => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 300, 400], 0, {}, ''));
    const pages = doc.getTrailer().get('Root').get('Pages');
    pages.put('Kids', [
      {
        Type: 'Page',
        ...(withParent ? { Parent: pages } : {}),
        MediaBox: [0, 0, 300, 400],
        Resources: {},
        Annots: [
          {
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [10, 10, 90, 30],
            Contents: doc.newString('direct-page'),
            A: { S: 'URI', URI: doc.newString('https://example.com/direct-page') },
          },
        ],
      },
    ]);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    return bytes;
  };

  it('removes a link whose external action went, on a page that is not an indirect object', async () => {
    const out = await sanitizeDocument(inPlace(true), { ...NONE, links: true }, run);
    expect(countOfCategory(out.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(actionsAfter(out.bytes)).toEqual({});
  });

  it('removes the action, and leaves the dead link, when the page in place names no parent to find it by', async () => {
    const out = await sanitizeDocument(inPlace(false), { ...NONE, links: true }, run);
    expect(countOfCategory(out.counts, 'links')).toMatchObject({ found: 1, removed: 1, left: 0 });
    expect(actionsAfter(out.bytes)).toEqual({ 'direct-page': null });
  });
});
