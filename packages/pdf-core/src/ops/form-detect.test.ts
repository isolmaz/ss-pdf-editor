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
  const [width, height] = rotation === 90 || rotation === 270 ? [PH, PW] : [PW, PH];
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
