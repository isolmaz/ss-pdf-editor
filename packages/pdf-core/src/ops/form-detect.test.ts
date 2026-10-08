/**
 * Prepare form against real bytes: a flat form built in-test with MuPDF (labels, drawn rules,
 * a square, circles), read by `detectFormFields` and written by `createDetectedFields`, then
 * read back through the form reader and MuPDF's object model. The wrong answers that matter:
 * a field proposed in the wrong space on a turned page, a kind or name that is not what the
 * page says, a created widget that is not where it was reviewed, a text page that "has
 * fields", and a picture-only page that is guessed at instead of sent to OCR.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { createDetectedFields, detectFormFields, displayToAppRect, type FieldCandidate } from './form-detect';
import { readFormFields, readFormWidgets } from './forms';

const run = { signal: new AbortController().signal };
type Rotation = 0 | 90 | 180 | 270;

/** Upright page size; a turned page's MediaBox is this with the sides swapped. */
const PW = 595;
const PH = 842;

/** Upright (a right, b up) → user space, per `/Rotate`: the matrix a producer draws a turned page with. */
const UPRIGHT_TO_USER: Record<Rotation, readonly [number, number, number, number, number, number]> = {
  0: [1, 0, 0, 1, 0, 0],
  90: [0, 1, -1, 0, PH, 0],
  180: [-1, 0, 0, -1, PW, PH],
  270: [0, -1, 1, 0, 0, PW],
};

function circle(cx: number, cy: number, r: number): string {
  const k = r * 0.5523;
  return [
    `${cx + r} ${cy} m`,
    `${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c`,
    `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c`,
    `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c`,
    `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c S`,
  ].join(' ');
}

const text = (x: number, y: number, value: string): string => `BT /F1 10 Tf ${x} ${y} Td (${value}) Tj ET`;

/** The flat form, drawn upright and then turned by `rotation` so it still reads upright when displayed. */
const FORM = [
  text(50, 740, 'Ad Soyad:'),
  '130 738 m 330 738 l S',
  text(50, 700, 'T.C. Kimlik No:'),
  '160 698 m 360 698 l S',
  text(50, 660, 'Signature:'),
  '130 658 m 330 658 l S',
  '50 610 10 10 re S',
  text(66, 611, 'Kabul ediyorum'),
  text(50, 570, 'Status:'),
  circle(135, 573, 5),
  text(146, 571, 'Yes'),
  circle(195, 573, 5),
  text(206, 571, 'No'),
].join('\n');

async function pdfWith(
  contents: (doc: import('mupdf').PDFDocument) => { stream: string; resources?: Record<string, unknown> },
  rotation: Rotation = 0,
  pageHeight = PH,
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const { stream, resources } = contents(doc);
  const [width, height] = rotation === 90 || rotation === 270 ? [pageHeight, PW] : [PW, pageHeight];
  doc.insertPage(
    0,
    doc.addPage([0, 0, width, height], rotation, { Font: { F1: font }, ...resources }, stream),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function flatForm(rotation: Rotation = 0): Promise<Uint8Array> {
  const [a, b, c, d, e, f] = UPRIGHT_TO_USER[rotation];
  return pdfWith(() => ({ stream: `q ${a} ${b} ${c} ${d} ${e} ${f} cm\n${FORM}\nQ` }), rotation);
}

const byName = (candidates: readonly FieldCandidate[], name: string): FieldCandidate => {
  const found = candidates.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no candidate named ${name}: ${candidates.map((c) => c.name)}`);
  return found;
};

/** An upright displayed-space rectangle (y down) in app space for a page turned by `rotation`. */
function toApp(rotation: Rotation, rect: readonly [number, number, number, number]): number[] {
  const [a, b, c, d, e, f] = UPRIGHT_TO_USER[rotation];
  const userHeight = rotation === 90 || rotation === 270 ? PW : PH;
  const points = [
    [rect[0], PH - rect[1]],
    [rect[2], PH - rect[3]],
  ].map(([x = 0, y = 0]) => [a * x + c * y + e, userHeight - (b * x + d * y + f)] as const);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function expectClose(actual: readonly number[], expected: readonly number[], tolerance = 1.5): void {
  expect(actual).toHaveLength(expected.length);
  for (const [at, value] of expected.entries())
    expect(Math.abs((actual[at] ?? NaN) - value)).toBeLessThan(tolerance);
}

describe('displayToAppRect', () => {
  // A 200 x 100 page whose box starts at x = 10; the displayed rectangle is hand-mapped corner by corner.
  const box = { x: 10, y: 0, width: 200, height: 100 };
  const rect = [10, 20, 50, 40] as const;
  it.each([
    [0, [20, 20, 60, 40]],
    [90, [30, 50, 50, 90]],
    [180, [160, 60, 200, 80]],
    [270, [170, 10, 190, 50]],
  ] as const)('maps a displayed rectangle on a page turned %i degrees', (rotation, expected) => {
    expect(displayToAppRect(rotation, box, rect)).toEqual(expected);
  });
});

describe('detectFormFields', () => {
  it('finds the fields of a flat form with their kinds, names and app-space rectangles', async () => {
    const detection = await detectFormFields(await flatForm(), run);
    expect(detection).toMatchObject({ pageCount: 1, needsOcr: [], rasterPages: [], truncated: false });
    expect(
      detection.candidates.map((candidate) => [candidate.kind, candidate.name, candidate.option ?? null]),
    ).toEqual([
      ['text', 'Ad Soyad', null],
      ['text', 'TC Kimlik No', null],
      ['signature', 'Signature', null],
      ['checkbox', 'Kabul ediyorum', null],
      ['radio', 'Status', 'Yes'],
      ['radio', 'Status', 'No'],
    ]);
    // Rules were drawn at y = 738, 698, 658 from the bottom: 104, 144, 184 from the top.
    const first = byName(detection.candidates, 'Ad Soyad');
    expectClose([first.rect[0], first.rect[2], first.rect[3]], [130, 330, 104], 1.5);
    expect(first.rect[3] - first.rect[1]).toBeGreaterThanOrEqual(12);
    const second = byName(detection.candidates, 'TC Kimlik No');
    expectClose([second.rect[0], second.rect[2], second.rect[3]], [160, 360, 144], 1.5);
    expectClose(byName(detection.candidates, 'Signature').rect, [130, 184 - 16.5, 330, 184], 6);
    expectClose(byName(detection.candidates, 'Kabul ediyorum').rect, [50, 222, 60, 232]);
    const radios = detection.candidates.filter((candidate) => candidate.kind === 'radio');
    expectClose(radios[0]?.rect ?? [], [130, 264, 140, 274]);
    expectClose(radios[1]?.rect ?? [], [190, 264, 200, 274]);
    expect(radios[0]?.group).toBeDefined();
    expect(radios[0]?.group).toBe(radios[1]?.group);
  });

  it('gives the same fields in upright app space on a page turned a quarter, half or three quarters', async () => {
    const upright = (await detectFormFields(await flatForm(0), run)).candidates;
    for (const rotation of [90, 180, 270] as const) {
      const turned = (await detectFormFields(await flatForm(rotation), run)).candidates;
      expect(turned.map((candidate) => [candidate.kind, candidate.name])).toEqual(
        upright.map((candidate) => [candidate.kind, candidate.name]),
      );
      for (const [at, candidate] of turned.entries()) {
        // Where the upright candidate's rectangle goes when the page is turned, computed from
        // the drawing matrix and not from the code under test.
        const was = upright[at]?.rect as FieldCandidate['rect'];
        const [x0, y0, x1, y1] = was;
        expectClose(candidate.rect, toApp(rotation, [x0, y0, x1, y1]));
      }
    }
  });

  it('proposes nothing on a page of prose and asks for OCR on a picture without text', async () => {
    const prose = await pdfWith(() => ({
      stream: [
        text(50, 740, 'This page is only a paragraph of ordinary prose.'),
        text(50, 726, 'It has no rule, no square and no label for any answer.'),
        text(50, 712, 'Nothing here is a place to write anything at all.'),
      ].join('\n'),
    }));
    expect(await detectFormFields(prose, run)).toMatchObject({
      candidates: [],
      needsOcr: [],
      alreadyFields: 0,
    });

    const mupdf = await loadMupdf();
    const picture = await pdfWith((doc) => {
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 40], false);
      pixmap.clear(230);
      const image = new mupdf.Image(pixmap);
      const ref = doc.addImage(image);
      return { stream: `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`, resources: { XObject: { Im0: ref } } };
    });
    expect(await detectFormFields(picture, run)).toMatchObject({ candidates: [], needsOcr: [0] });
  });
});

/** What a page proposes, as `[kind, name, source, confidence]` and the rectangle, rounded. */
async function proposals(bytes: Uint8Array) {
  const detection = await detectFormFields(bytes, run);
  return {
    detection,
    found: detection.candidates.map((candidate) => ({
      what: [candidate.kind, candidate.name, candidate.source, candidate.confidence],
      rect: candidate.rect.map((value) => Math.round(value)),
      cells: candidate.cells,
      multiline: candidate.multiline,
    })),
  };
}

describe('detectFormFields: how the drawing is read', () => {
  const label = text(50, 740, 'Name:');
  const BOX = '120 735 200 16 re S';
  /** The field the label and box make: a box 200 x 16 at app y 91..107. */
  const field = (source: string, confidence: string) => ({
    what: ['text', 'Name', source, confidence],
    rect: [120, 91, 320, 107],
  });

  it('takes a box a producer drew in any of the usual ways as the same field', async () => {
    const rounded = (x: number, y: number, w: number, h: number, r: number): string =>
      [
        `${x + r} ${y} m ${x + w - r} ${y} l`,
        `${x + w} ${y} ${x + w} ${y} ${x + w} ${y + r} c ${x + w} ${y + h - r} l`,
        `${x + w} ${y + h} ${x + w} ${y + h} ${x + w - r} ${y + h} c ${x + r} ${y + h} l`,
        `${x} ${y + h} ${x} ${y + h} ${x} ${y + h - r} c ${x} ${y + r} l`,
        `${x} ${y} ${x} ${y} ${x + r} ${y} c h S`,
      ].join(' ');
    const stream = (...drawing: string[]) => pdfWith(() => ({ stream: [label, ...drawing].join('\n') }));

    // A path of five points that comes back to its start.
    expect(
      (await proposals(await stream('120 735 m 320 735 l 320 751 l 120 751 l 120 735 l S'))).found,
    ).toMatchObject([field('box', 'high')]);
    // Curves at the corners and lines between them.
    expect((await proposals(await stream(rounded(120, 735, 200, 16, 4)))).found).toMatchObject([
      field('box', 'high'),
    ]);
    // A light fill is a field, a weaker one than a drawn border.
    expect((await proposals(await stream('0.9 g 120 735 200 16 re f'))).found).toMatchObject([
      field('box', 'medium'),
    ]);
    // A border painted as a fill of an outline inside an outline: the border, whatever its colour.
    expect((await proposals(await stream('0 g 120 735 200 16 re 121 736 198 14 re f*'))).found).toMatchObject(
      [field('box', 'high')],
    );
    // A dotted rule: many small dots in a row; three dots (an ellipsis) are not one.
    const dots = Array.from({ length: 30 }, (_, index) => `${130 + index * 5} 738 2 2 re f`);
    const ellipsis = [300, 305, 310].map((x) => `${x} 600 2 2 re f`);
    expect((await proposals(await stream(...dots, ...ellipsis))).found).toMatchObject([
      { what: ['text', 'Name', 'line', 'high'], rect: [131, 87, 276, 103] },
    ]);
  });

  it('is not led astray by a page background, a diamond or a stray moveto', async () => {
    const stream = [
      '0.97 g 0 0 595 842 re f 0 g',
      label,
      BOX,
      '100 600 m 120 620 l 100 640 l 80 620 l h S',
      '10 10 m S',
    ].join('\n');
    expect((await proposals(await pdfWith(() => ({ stream })))).found).toMatchObject([field('box', 'high')]);
  });

  it('reads a row of squares and a frame with ticks as a comb, and a tall box as a multi-line field', async () => {
    const squares = Array.from({ length: 6 }, (_, index) => `${130 + index * 16} 700 16 16 re S`);
    const comb = await proposals(
      await pdfWith(() => ({ stream: [text(50, 704, 'Code:'), ...squares].join('\n') })),
    );
    expect(comb.found).toMatchObject([{ what: ['text', 'Code', 'comb', 'high'], cells: 6 }]);
    expect(comb.detection.candidates[0]?.cells).toBe(6);

    const ticks = [1, 2, 3, 4, 5].map((index) => `${120 + index * 16} 735 m ${120 + index * 16} 751 l S`);
    const ticked = await proposals(
      await pdfWith(() => ({ stream: [text(50, 740, 'Code:'), '120 735 96 16 re S', ...ticks].join('\n') })),
    );
    expect(ticked.found).toMatchObject([{ what: ['text', 'Code', 'comb', 'high'], cells: 6 }]);

    const tall = await proposals(
      await pdfWith(() => ({ stream: [text(50, 740, 'Notes:'), '120 660 300 90 re S'].join('\n') })),
    );
    expect(tall.found).toMatchObject([{ what: ['text', 'Notes', 'box', 'high'], multiline: true }]);
    expect(tall.detection.candidates[0]?.multiline).toBe(true);
  });

  it('does not take a box with a picture, a shading or a drawing in it for a field', async () => {
    const mupdf = await loadMupdf();
    const picture = await pdfWith((doc) => {
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
      pixmap.clear(0);
      return {
        stream: [label, BOX, 'q 8 0 0 8 130 739 cm /Im0 Do Q'].join('\n'),
        resources: { XObject: { Im0: doc.addImage(new mupdf.Image(pixmap)) } },
      };
    });
    const mask = await pdfWith((doc) => ({
      stream: [label, BOX, 'q 8 0 0 8 130 739 cm /Mk Do Q'].join('\n'),
      resources: {
        XObject: {
          Mk: doc.addStream(new Uint8Array(8).fill(0x55), {
            Type: 'XObject',
            Subtype: 'Image',
            Width: 8,
            Height: 8,
            ImageMask: true,
            BitsPerComponent: 1,
          } as never),
        },
      },
    }));
    const shading = await pdfWith(() => ({
      stream: [label, BOX, '/Sh0 sh'].join('\n'),
      resources: {
        Shading: {
          Sh0: {
            ShadingType: 2,
            ColorSpace: 'DeviceRGB',
            BBox: [130, 739, 138, 747],
            Coords: [130, 0, 138, 0],
            Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
            Extend: [true, true],
          },
        },
      },
    }));
    const triangle = await pdfWith(() => ({
      stream: [label, BOX, '130 737 m 140 737 l 135 749 l h f'].join('\n'),
    }));
    for (const bytes of [picture, mask, shading, triangle]) {
      // What is left is the label's colon alone: no `box` candidate.
      const { found } = await proposals(bytes);
      expect(found.map((entry) => entry.what)).toEqual([['text', 'Name', 'colon', 'medium']]);
    }
  });

  it('reads a radio button drawn as a ring, a filled circle inside a filled circle', async () => {
    const ring = (cx: number, cy: number): string =>
      `${circle(cx, cy, 5).slice(0, -2)} ${circle(cx, cy, 4).slice(0, -2)} f*`;
    const { found } = await proposals(
      await pdfWith(() => ({
        stream: [
          text(50, 571, 'Status:'),
          ring(135, 573),
          text(146, 571, 'Yes'),
          ring(195, 573),
          text(206, 571, 'No'),
        ].join('\n'),
      })),
    );
    expect(found.map((entry) => entry.what)).toEqual([
      ['radio', 'Status', 'circle', 'high'],
      ['radio', 'Status', 'circle', 'high'],
    ]);
  });

  it('reads the cells of a ruled table: the empty one beside a label is the field', async () => {
    const grid = [
      '100 700 m 400 700 l S',
      '100 670 m 400 670 l S',
      '100 640 m 400 640 l S',
      '100 700 m 100 640 l S',
      '250 700 m 250 640 l S',
      '400 700 m 400 640 l S',
    ];
    const { found } = await proposals(
      await pdfWith(() => ({
        stream: [text(110, 680, 'Name'), text(110, 650, 'Phone'), ...grid].join('\n'),
      })),
    );
    expect(found.map((entry) => entry.what)).toEqual([
      ['text', 'Name', 'cell', 'high'],
      ['text', 'Phone', 'cell', 'high'],
    ]);
  });

  it('reads the rules of a scanned page with a text layer from its pixels, and only the thin ones', async () => {
    const width = 600;
    const height = 850;
    const stride = width;
    // 8-bit grey, paper 255 and ink 40: no pixel is black, so the darkest levels are empty.
    const data = new Uint8Array(stride * height).fill(0xff);
    const rule = (row: number, x0: number, x1: number): void => {
      data.fill(40, row * stride + x0, row * stride + x1);
    };
    // Two rows of a rule (about 1 pt thick), then a bar six rows tall that is not a rule.
    for (const row of [100, 101]) rule(row, 130, 330);
    for (let row = 300; row < 306; row += 1) rule(row, 130, 330);
    const scan = (doc: import('mupdf').PDFDocument) => ({
      XObject: {
        Scan: doc.addStream(data, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: width,
          Height: height,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
        } as never),
      },
    });
    const page = (...extra: string[]) =>
      pdfWith((doc) => ({
        stream: ['q 595 0 0 842 0 0 cm /Scan Do Q', ...extra].join('\n'),
        resources: scan(doc),
      }));

    const { detection, found } = await proposals(await page(`0.5 g ${text(50, 735, 'Name:')}`));
    expect(detection.rasterPages).toEqual([0]);
    expect(detection.needsOcr).toEqual([]);
    const line = found.find((entry) => entry.what[2] === 'line');
    expect(line?.what).toEqual(['text', 'Name', 'line', 'medium']);
    // The rule is at row 100 of 850, which is 842 / 850 of a point per row from the top.
    expect(Math.abs((line?.rect[2] ?? 0) - 328)).toBeLessThanOrEqual(2);
    expect(Math.abs((line?.rect[3] ?? 0) - 100)).toBeLessThanOrEqual(2);
    // The bar is not a rule: no candidate sits on it.
    expect(found.every((entry) => (entry.rect[3] ?? 0) < 250)).toBe(true);

    expect((await proposals(await page())).detection).toMatchObject({ needsOcr: [0], rasterPages: [] });
  });
});

describe('detectFormFields: the document around the page', () => {
  it('reads a page with an odd /Rotate without refusing it, where creating a field on it is refused', async () => {
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument((await flatForm(0)).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    doc.findPage(0).put('Rotate', 45);
    const odd = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    expect(await detectFormFields(odd, run)).toMatchObject({ pageCount: 1, truncated: false });
    const candidate: FieldCandidate = {
      id: '1-1',
      kind: 'text',
      pageIndex: 0,
      rect: [10, 10, 100, 30],
      name: 'Odd',
      label: 'Odd',
      confidence: 'high',
      source: 'line',
      size: 10,
    };
    await expect(createDetectedFields(odd, [candidate], run)).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'page /Rotate 45 is not a multiple of 90' },
    });
  });

  it('leaves alone a widget that sits on no page, and stops at 400 candidates', async () => {
    const rows = Array.from({ length: 450 }, (_, index) => {
      const y = 5900 - index * 12;
      return `${text(50, y, `Field ${index}:`)}\n130 ${y - 2} m 330 ${y - 2} l S`;
    });
    const tall = await pdfWith(() => ({ stream: rows.join('\n') }), 0, 6000);
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(tall.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    // A field in the AcroForm that no page's /Annots holds.
    const orphan = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Tx',
      T: doc.newString('Orphan'),
      Rect: [0, 0, 10, 10],
    } as never);
    const form = doc.addObject({ Fields: [orphan] } as never);
    doc.getTrailer().get('Root').put('AcroForm', form);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    expect((await readFormWidgets(bytes))[0]?.widgets[0]?.pageIndex).toBeNull();

    const detection = await detectFormFields(bytes, run);
    expect(detection.truncated).toBe(true);
    expect(detection.candidates).toHaveLength(400);
    expect(detection.alreadyFields).toBe(0);
    expect(new Set(detection.candidates.map((candidate) => candidate.name)).size).toBe(400);
  });

  it('reports progress per page and stops for an aborted signal', async () => {
    const bytes = await flatForm(0);
    const events: unknown[] = [];
    await detectFormFields(bytes, { signal: run.signal, onProgress: (event) => events.push(event) });
    expect(events).toEqual([{ phase: 'detect', labelKey: 'op.progress.formDetect', done: 0, total: 1 }]);
    const aborted = new AbortController();
    aborted.abort();
    await expect(detectFormFields(bytes, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('createDetectedFields', () => {
  beforeEach(() => {
    // The widgets' appearances are drawn with the embedded Noto Sans the shell serves.
    const file = createRequire(import.meta.url).resolve(
      '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
      { paths: [process.cwd()] },
    );
    const font = new Uint8Array(readFileSync(file));
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the reviewed fields where they were, readable as the same kinds, names and pages', async () => {
    const bytes = await flatForm(0);
    const { candidates } = await detectFormFields(bytes, run);
    const out = await createDetectedFields(bytes, candidates, run);
    expect(out.created.map((entry) => [entry.name, entry.kind, entry.widgets, entry.pageIndex])).toEqual([
      ['Ad Soyad', 'text', 1, 0],
      ['TC Kimlik No', 'text', 1, 0],
      ['Signature', 'signature', 1, 0],
      ['Kabul ediyorum', 'checkbox', 1, 0],
      ['Status', 'radio', 2, 0],
    ]);

    const fields = await readFormFields(out.bytes);
    expect(fields.map((field) => [field.name, field.kind, field.pageIndex])).toEqual([
      ['Ad Soyad', 'text', 0],
      ['TC Kimlik No', 'text', 0],
      ['Signature', 'signature', 0],
      ['Kabul ediyorum', 'checkbox', 0],
      ['Status', 'radio', 0],
    ]);
    expect(fields.find((field) => field.name === 'Status')?.options).toEqual(['Yes', 'No']);

    // Widget rectangles are user space (y up): the app-space rectangle flipped about the page height.
    const widgets = await readFormWidgets(out.bytes);
    for (const candidate of candidates.filter((entry) => entry.kind !== 'radio')) {
      const widget = widgets.find((field) => field.name === candidate.name)?.widgets[0];
      expectClose(
        widget?.rect ?? [],
        [candidate.rect[0], PH - candidate.rect[3], candidate.rect[2], PH - candidate.rect[1]],
        0.75,
      );
    }
    expect(widgets.find((field) => field.name === 'Status')?.widgets).toHaveLength(2);

    // Created fields are not proposed again, and are counted instead.
    const again = await detectFormFields(out.bytes, run);
    expect(again.candidates).toEqual([]);
    expect(again.alreadyFields).toBe(candidates.length);
  });

  it('places fields on a turned page by its user-space frame and draws them upright with /MK /R', async () => {
    const bytes = await flatForm(90);
    const { candidates } = await detectFormFields(bytes, run);
    const out = await createDetectedFields(bytes, candidates, run);
    const widgets = await readFormWidgets(out.bytes);
    // The user-space page is 842 wide and 595 tall: app y is counted down from 595.
    for (const candidate of candidates.filter((entry) => entry.kind !== 'radio')) {
      const widget = widgets.find((field) => field.name === candidate.name)?.widgets[0];
      expectClose(
        widget?.rect ?? [],
        [candidate.rect[0], PW - candidate.rect[3], candidate.rect[2], PW - candidate.rect[1]],
        0.75,
      );
    }
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const annots = doc.findPage(0).get('Annots');
      expect(annots.length).toBeGreaterThanOrEqual(6);
      for (let at = 0; at < annots.length; at += 1) {
        expect(annots.get(at).resolve().get('MK').get('R').asNumber()).toBe(90);
      }
    } finally {
      doc.destroy();
    }
  });

  const candidate = (
    extra: Partial<FieldCandidate> & Pick<FieldCandidate, 'id' | 'name'>,
  ): FieldCandidate => ({
    kind: 'text',
    pageIndex: 0,
    rect: [100, 100, 200, 120],
    label: extra.name,
    confidence: 'high',
    source: 'line',
    size: 10,
    ...extra,
  });

  it("names a radio group's options when the review left them empty or repeated", async () => {
    const out = await createDetectedFields(
      await flatForm(0),
      [
        candidate({
          id: 'r1',
          name: 'Pick',
          kind: 'radio',
          group: 'g',
          option: '',
          rect: [100, 100, 110, 110],
        }),
        candidate({
          id: 'r2',
          name: 'Pick',
          kind: 'radio',
          group: 'g',
          option: 'Yes',
          rect: [100, 120, 110, 130],
        }),
        candidate({
          id: 'r3',
          name: 'Pick',
          kind: 'radio',
          group: 'g',
          option: 'Yes',
          rect: [100, 140, 110, 150],
        }),
        candidate({ id: 'r4', name: 'Other', kind: 'radio', group: 'h', rect: [200, 100, 210, 110] }),
        candidate({
          id: 'r5',
          name: 'Other',
          kind: 'radio',
          group: 'h',
          option: '  ',
          rect: [200, 120, 210, 130],
        }),
      ],
      run,
    );
    const fields = await readFormFields(out.bytes);
    expect(fields.map((field) => [field.name, field.kind, field.options])).toContainEqual([
      'Pick',
      'radio',
      ['Option 1', 'Yes', 'Yes 2'],
    ]);
    expect(fields.map((field) => [field.name, field.kind, field.options])).toContainEqual([
      'Other',
      'radio',
      ['Option 1', 'Option 2'],
    ]);
  });

  it('creates a radio group that has one button left as a checkbox', async () => {
    const lone = candidate({ id: 'r1', name: 'Alone', kind: 'radio', group: 'g', option: 'Yes' });
    const out = await createDetectedFields(await flatForm(0), [lone], run);
    expect(out.created).toEqual([{ name: 'Alone', kind: 'checkbox', pageIndex: 0, widgets: 1 }]);
    expect((await readFormFields(out.bytes)).map((field) => [field.name, field.kind])).toContainEqual([
      'Alone',
      'checkbox',
    ]);
  });

  it('creates a candidate that is listed twice once', async () => {
    const field = candidate({ id: 't1', name: 'Once' });
    const out = await createDetectedFields(await flatForm(0), [field, field], run);
    expect(out.created).toEqual([{ name: 'Once', kind: 'text', pageIndex: 0, widgets: 1 }]);
    expect(out.report.notes[0]).toMatchObject({ key: 'formDetect.note.created', params: { count: 1 } });
  });

  it('creates a multi-line text field and a comb of the cells the page showed', async () => {
    const out = await createDetectedFields(
      await flatForm(0),
      [
        candidate({ id: 'm', name: 'Notes', multiline: true, rect: [100, 100, 300, 180] }),
        candidate({ id: 'c', name: 'Code', cells: 6, rect: [100, 200, 196, 216] }),
      ],
      run,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const fields = doc.getTrailer().get('Root').get('AcroForm').get('Fields');
      const byTitle = new Map<string, import('mupdf').PDFObject>();
      for (let index = 0; index < fields.length; index += 1) {
        byTitle.set(fields.get(index).get('T').asString(), fields.get(index));
      }
      // `/Ff` bit 13 is multi-line and bit 25 is comb (ISO 32000-1, tables 228 and 230).
      expect(byTitle.get('Notes')?.get('Ff').asNumber()).toBe(1 << 12);
      expect(byTitle.get('Code')?.get('Ff').asNumber()).toBe(1 << 24);
      expect(byTitle.get('Code')?.get('MaxLen').asNumber()).toBe(6);
    } finally {
      doc.destroy();
    }
  });

  it('refuses an empty selection and a candidate on a page the document does not have', async () => {
    const bytes = await flatForm(0);
    await expect(createDetectedFields(bytes, [], run)).rejects.toMatchObject({ code: 'selection-empty' });
    const stray: FieldCandidate = {
      id: '9-1',
      kind: 'text',
      pageIndex: 3,
      rect: [10, 10, 100, 30],
      name: 'Stray',
      label: 'Stray',
      confidence: 'high',
      source: 'line',
      size: 10,
    };
    await expect(createDetectedFields(bytes, [stray], run)).rejects.toMatchObject({ code: 'range-invalid' });
  });
});
