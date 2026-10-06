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

import type { PDFDocument } from 'mupdf';
import { describe, expect, it } from 'vitest';
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
    await expect(sanitizeDocument(input, ALL, { signal: controller.signal })).rejects.toThrow();
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
