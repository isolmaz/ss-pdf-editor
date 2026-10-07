/**
 * The unusual form structures real files carry, built object by object (`forms.fixtures.ts`):
 * a field tree with nulls, duplicates, kids of the wrong type and a chain 40 deep; choice
 * options in every shape `/Opt` allows; widgets a page lists only through `/Annots`; every
 * `/DA`, `/MK` and flag a widget can be drawn from; the refusals a fill makes; flattening of
 * buttons whose appearances are damaged; and the calculator's grammar.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, type PDFObject, type PDFPage } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCalculations,
  createFormFields,
  evaluateCalculation,
  exportFormData,
  type FormFieldInfo,
  fillFormFields,
  flattenForm,
  importFormData,
  readFormFields,
  readFormWidgets,
  setFieldFlags,
  validateField,
  xfaSnapshotsOf,
} from './forms';
import { blankForm, formPdf, handPdf, widgetBody } from './forms.fixtures';

const run = { signal: new AbortController().signal };

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

beforeEach(() => {
  const font = notoRegular();
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const refused = (engineMessage: string | RegExp) => ({
  details: {
    engine: 'mupdf',
    engineMessage: typeof engineMessage === 'string' ? engineMessage : expect.stringMatching(engineMessage),
  },
});

/** The widget dictionary of the field named `name` (or of one of its kids), searching every page. */
function widgetOf(doc: PDFDocument, name: string, nth = 0): PDFObject {
  const found: PDFObject[] = [];
  for (let index = 0; index < doc.countPages(); index += 1) {
    const listed = doc.findPage(index).get('Annots');
    if (listed.isNull()) continue;
    const annots = listed.resolve();
    for (let at = 0; at < annots.length; at += 1) {
      const dict = annots.get(at).resolve();
      if (!dict.isDictionary()) continue;
      const owner = dict.get('T').isNull() ? dict.get('Parent').resolve() : dict;
      if (owner.isDictionary() && owner.get('T').isString() && owner.get('T').asString() === name)
        found.push(dict);
    }
  }
  const dict = found[nth];
  if (dict === undefined) throw new Error(`no widget of ${name}`);
  return dict;
}

/** The drawn normal appearance of a widget: its operators and its form dictionary. */
function drawnOf(
  bytes: Uint8Array,
  name: string,
  nth = 0,
): { content: string; matrix: number[]; da: string } {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const widget = widgetOf(doc, name, nth);
    const form = widget.get('AP').get('N');
    return {
      content: form.readStream().asString(),
      matrix: form.get('Matrix').asJS(),
      da: widget.get('DA').asString(),
    };
  } finally {
    doc.destroy();
  }
}

/** The `x` of every `Td` in a drawn appearance, in order. */
function runsX(content: string): number[] {
  return [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) Td/g)].map((match) => Number(match[1]));
}

const rect = (y: number) => `10 ${y} 110 ${y + 20}`;

describe('the field tree as the file writes it', () => {
  const chain = (): Record<number, string> => {
    const objects: Record<number, string> = {};
    for (let depth = 0; depth < 36; depth += 1) {
      objects[100 + depth] =
        `<</T(d)/FT/Tx/Kids[${depth < 35 ? `${101 + depth} 0 R ` : ''}${200 + depth} 0 R]>>`;
      objects[200 + depth] = widgetBody('0 0 5 5', '');
    }
    return objects;
  };
  const tree = (): Uint8Array =>
    formPdf({
      fields:
        '[null 42 10 0 R 10 0 R 99 0 R 11 0 R 13 0 R 20 0 R 21 0 R 22 0 R 26 0 R 27 0 R 28 0 R 29 0 R 31 0 R 34 0 R 36 0 R <</T(direct)/FT/Tx/Subtype/Widget/Rect[0 0 10 10]>> 100 0 R]',
      annots:
        '[10 0 R 12 0 R 16 0 R <</Subtype/Link>> 20 0 R 21 0 R 23 0 R 24 0 R 25 0 R 26 0 R 27 0 R 28 0 R 29 0 R 36 0 R]',
      secondAnnots: '[34 0 R 33 0 R]',
      extra: {
        ...chain(),
        10: widgetBody(rect(500), '/FT/Tx/T(plain)/V(hello)/Ff 2/MaxLen 8'),
        11: '<</Kids[12 0 R]>>',
        12: widgetBody(rect(470), '/T(child)/FT/Tx/V(c)/Parent 11 0 R'),
        13: '<</T(grp)/FT/Tx/Kids[14 0 R 42 16 0 R]>>',
        14: '<</Subtype/Widget/Parent 13 0 R/Rect[10 440 110 460]>>',
        16: widgetBody(rect(410), '/T(sub)/Parent 13 0 R/V(s)/FT/Tx'),
        20: widgetBody(
          rect(380),
          '/FT/Ch/Ff 131072/T(dd)/Opt[[(x1)(Show 1)][(x2)][5]5 null(plain)]/V[(x1) 7 (plain)]',
        ),
        21: widgetBody(rect(350), '/FT/Ch/Ff 131072/T(dn)/V 7'),
        22: '<</FT/Btn/Ff 32768/T(rd)/V/Z/Kids[23 0 R 24 0 R 25 0 R]>>',
        23: widgetBody(rect(320), '/Parent 22 0 R'),
        24: widgetBody(rect(290), '/Parent 22 0 R/AP<</N<</A 60 0 R>>>>'),
        25: widgetBody(rect(260), '/Parent 22 0 R/AP<</N<</A 60 0 R/Off 60 0 R>>>>'),
        26: widgetBody(rect(230), '/FT/Sig/T(sg)'),
        27: widgetBody(rect(200), '/FT/Btn/Ff 65536/T(pb)'),
        28: widgetBody(rect(170), '/T(un)'),
        29: widgetBody(rect(140), '/FT/Ch/T(ol)/Opt[(a)(b)]/V[(a)(b)]'),
        31: '<</FT/Tx/T(second)/Kids[32 0 R 33 0 R]>>',
        32: '<</Subtype/Widget/Parent 31 0 R/P 99 0 R/Rect[10 100 50 120]>>',
        33: '<</Subtype/Widget/Parent 31 0 R/P 4 0 R/Rect[10 100 50 120]>>',
        34: '<</Subtype/Widget/FT/Tx/T(viaAnnots)/Rect[10 70 50 90]>>',
        36: widgetBody(rect(110), '/FT/Ch/Ff 131072/T(ds)/V(x2)/Opt[(x2)]'),
        60: blankForm(10, 10),
      },
    });

  it('lists the fields a reader finds, skipping nulls, duplicates and kids of the wrong type', async () => {
    const fields = await readFormFields(tree());
    const byName = new Map(fields.map((field) => [field.name, field]));
    const names = fields.map((field) => field.name);
    expect(names.filter((name) => !/^d(\.d)*$/.test(name))).toEqual([
      'plain',
      'child',
      'grp.sub',
      'grp',
      'dd',
      'dn',
      'rd',
      'sg',
      'pb',
      'un',
      'ol',
      'second',
      'viaAnnots',
      'ds',
      'direct',
    ]);
    expect(byName.get('plain')).toMatchObject({
      kind: 'text',
      value: 'hello',
      required: true,
      maxLength: 8,
      pageIndex: 0,
    });
    expect(byName.get('child')).toMatchObject({ kind: 'text', value: 'c', pageIndex: 0 });
    expect(byName.get('grp.sub')).toMatchObject({ value: 's', pageIndex: 0 });
    expect(byName.get('grp')).toMatchObject({ kind: 'text', value: null, pageIndex: null });
    // The nine fields a field with no /T of its own passes its name through.
    expect(byName.get('child')?.name).toBe('child');
  });

  it('stops descending at depth 32, so a chain 36 deep yields 33 fields', async () => {
    const names = (await readFormFields(tree()))
      .map((field) => field.name)
      .filter((name) => /^d(\.d)*$/.test(name));
    expect(names).toHaveLength(33);
    expect(Math.max(...names.map((name) => name.split('.').length))).toBe(33);
  });

  it('reads choice options as export/display pairs, a bare string or nothing', async () => {
    const byName = new Map((await readFormFields(tree())).map((field) => [field.name, field]));
    // `[(x1)(Show 1)]` shows "Show 1"; `[(x2)]` shows its own export; `[5]` and `5` are empty texts;
    // a null entry is skipped; a bare string is both.
    expect(byName.get('dd')).toMatchObject({ kind: 'dropdown', options: ['Show 1', 'x2', '', '', 'plain'] });
    // The value array keeps its strings and drops the number.
    expect(byName.get('dd')?.value).toEqual(['x1', 'plain']);
    expect(byName.get('dn')?.value).toEqual([]);
    expect(byName.get('ol')).toMatchObject({ kind: 'optionlist', value: ['a', 'b'], options: ['a', 'b'] });
  });

  it('names a radio group by its on-states, once each, and keeps a value that matches none', async () => {
    const rd = (await readFormFields(tree())).find((field) => field.name === 'rd');
    expect(rd).toMatchObject({ kind: 'radio', value: 'Z', options: ['A'], pageIndex: 0 });
  });

  it('classifies signature, push button and untyped fields without a value', async () => {
    const byName = new Map((await readFormFields(tree())).map((field) => [field.name, field]));
    expect(byName.get('sg')).toMatchObject({ kind: 'signature', value: null, options: null });
    expect(byName.get('pb')).toMatchObject({ kind: 'button', value: null });
    expect(byName.get('un')).toMatchObject({ kind: 'unknown', value: null });
  });

  it('places a widget by /P, else by the page whose /Annots lists it, else nowhere', async () => {
    const widgets = await readFormWidgets(tree());
    const pages = (name: string) =>
      widgets.find((field) => field.name === name)?.widgets.map((w) => w.pageIndex);
    // The first widget of `second` points at a missing page and is listed by none; the second is on page 2.
    expect(pages('second')).toEqual([null, 1]);
    // No /P, but the second page's /Annots lists it.
    expect(pages('viaAnnots')).toEqual([1]);
    // A direct dictionary in /Fields has no object number to look up.
    expect(pages('direct')).toEqual([null]);
    expect(widgets.find((field) => field.name === 'second')?.widgets[0]?.rect).toEqual([10, 100, 50, 120]);
    const second = (await readFormFields(tree())).find((field) => field.name === 'second');
    expect(second?.pageIndex).toBe(1);
  });

  it('returns nothing from a read whose signal is already aborted', async () => {
    const stopped = AbortSignal.abort();
    expect(await readFormFields(tree(), stopped)).toEqual([]);
    expect(await readFormWidgets(tree(), stopped)).toEqual([]);
  });

  it('snapshots every field the way the XFA data sync reads it', async () => {
    const doc = PDFDocument.openDocument(tree().slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const snapshots = new Map(xfaSnapshotsOf(doc).map((snapshot) => [snapshot.name, snapshot]));
      expect(snapshots.get('plain')).toEqual({ name: 'plain', kind: 'text', text: 'hello', on: null });
      // Two selected values have no single data value.
      expect(snapshots.get('dd')).toEqual({ name: 'dd', kind: 'other', text: null, on: null });
      expect(snapshots.get('ol')).toEqual({ name: 'ol', kind: 'other', text: null, on: null });
      expect(snapshots.get('dn')).toEqual({ name: 'dn', kind: 'dropdown', text: null, on: null });
      expect(snapshots.get('ds')).toEqual({ name: 'ds', kind: 'dropdown', text: 'x2', on: null });
      expect(snapshots.get('rd')).toEqual({ name: 'rd', kind: 'radio', text: 'Z', on: true });
      expect(snapshots.get('sg')).toEqual({ name: 'sg', kind: 'signature', text: null, on: null });
      expect(snapshots.get('pb')).toEqual({ name: 'pb', kind: 'other', text: null, on: null });
    } finally {
      doc.destroy();
    }
  });
});

describe('how a widget is drawn from its /DA, /MK and flags', () => {
  const styled = (): Uint8Array =>
    formPdf({
      fields:
        '[10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R 16 0 R 17 0 R 18 0 R 19 0 R 20 0 R 21 0 R 22 0 R 23 0 R 24 0 R 25 0 R 26 0 R 27 0 R 28 0 R 29 0 R]',
      annots:
        '[10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R 16 0 R 17 0 R 18 0 R 19 0 R 20 0 R 21 0 R 22 0 R 23 0 R 24 0 R 25 0 R 26 0 R 27 0 R 28 0 R 29 0 R]',
      extra: {
        10: widgetBody(
          rect(560),
          '/FT/Tx/T(rgb)/DA(/Helv 10 Tf 1 0 0 rg)/MK<</BG[0.9]/BC[0 0 1 0]/R -90>>/BS<</W 3>>',
        ),
        11: widgetBody(rect(530), '/FT/Tx/T(badcolor)/DA(/Helv 10 Tf x y z rg)/MK<</BG[1 1]/BC[0 0 1]>>'),
        12: widgetBody(rect(500), '/FT/Tx/T(cmyk)/DA(0 0 0 1 k /Helv 8 Tf)/MK<</BC[0.5]/R 180>>/BS<</W 0>>'),
        13: widgetBody(rect(470), '/FT/Tx/T(bare)/DA(Tf)'),
        14: widgetBody('10 440 60 590', '/FT/Tx/T(wrap)/Ff 4096/DA(/Helv 8 Tf 0 g)'),
        15: widgetBody('10 380 50 410', '/FT/Tx/T(shrink)/Ff 4096/DA(/Helv 0 Tf 0 g)'),
        16: widgetBody(rect(350), '/FT/Tx/T(q1)/Q 1/DA(/Helv 10 Tf 0 g)'),
        17: widgetBody(rect(320), '/FT/Tx/T(q2)/Q 2/DA(/Helv 10 Tf 0 g)'),
        18: widgetBody(rect(290), '/FT/Tx/T(q0)/DA(/Helv 10 Tf 0 g)'),
        19: widgetBody(rect(260), '/FT/Tx/T(m1)/Ff 4096/Q 1/DA(/Helv 10 Tf 0 g)'),
        20: widgetBody(rect(230), '/FT/Tx/T(m2)/Ff 4096/Q 2/DA(/Helv 10 Tf 0 g)'),
        21: widgetBody(rect(200), '/FT/Tx/T(m0)/Ff 4096/DA(/Helv 10 Tf 0 g)'),
        22: widgetBody(rect(170), '/FT/Tx/T(pw)/Ff 8192/DA(/Helv 10 Tf 0 g)'),
        23: widgetBody('10 130 130 150', '/FT/Tx/T(combfixed)/Ff 16777216/MaxLen 6/DA(/Helv 10 Tf 0 g)'),
        24: widgetBody('10 100 130 120', '/FT/Tx/T(combauto)/Ff 16777216/MaxLen 6/DA(/Helv 0 Tf 0 g)'),
        25: widgetBody(rect(70), '/FT/Tx/T(auto)/DA(/Helv 0 Tf 0 g)'),
        26: widgetBody('10 20 110 60', '/FT/Ch/T(list)/DA(/Helv 0 Tf 0 g)/Opt[(one)(two)(three)]'),
        27: widgetBody(
          '10 5 110 15',
          '/FT/Ch/Ff 131072/T(combo)/DA(/Helv 10 Tf 0 g)/Opt[[(a1)(Alpha)][(b1)(Beta)]]',
        ),
        28: widgetBody(rect(590), '/FT/Tx/T(zeroset)/DA(/Helv 10 Tf)/MK<</BC[1 0 0]>>'),
        29: widgetBody(rect(610), '/FT/Tx/T(nodefault)/MK<</BC[1 0 0]>>/BS<</W 2>>'),
      },
    });

  async function filled(values: Record<string, string>): Promise<Uint8Array> {
    const out = await fillFormFields(
      styled(),
      Object.entries(values).map(([name, value]) => ({ name, value })),
      run,
    );
    return out.bytes;
  }

  it('draws a /DA colour, an /MK background and border, and turns the box by /MK /R', async () => {
    const bytes = await filled({ rgb: 'AB', badcolor: 'x', cmyk: 'y', bare: 'z' });
    const rgb = drawnOf(bytes, 'rgb');
    // A one-number /BG is a gray fill; a four-number /BC is a CMYK stroke; /BS /W 3 is the width.
    expect(rgb.content).toContain('0.9 g 0 0 ');
    expect(rgb.content).toContain('0 0 1 0 K 3 w 1.5 1.5');
    expect(rgb.content).toContain('10 Tf 1 0 0 rg ');
    // -90 is 270 turned the other way: the width is the rect's height.
    expect(rgb.matrix).toEqual([0, -1, 1, 0, 0, 0]);
    expect(rgb.da).toBe('/NotoForm 10 Tf 1 0 0 rg');

    // A colour whose operands are not numbers is ignored; a two-number /BG draws no background.
    const bad = drawnOf(bytes, 'badcolor');
    expect(bad.da).toBe('/NotoForm 10 Tf 0 g');
    expect(bad.content).not.toMatch(/ re f/);
    expect(bad.content).toContain('0 0 1 RG 1 w 0.5 0.5');

    // `0 0 0 1 k` is the text colour; a one-number /BC strokes in gray, and /W 0 draws no stroke; /R 180.
    const cmyk = drawnOf(bytes, 'cmyk');
    expect(cmyk.da).toBe('/NotoForm 8 Tf 0 0 0 1 k');
    expect(cmyk.content).toContain('0 0 0 1 k');
    expect(cmyk.content).not.toContain(' w ');
    expect(cmyk.matrix).toEqual([-1, 0, 0, -1, 0, 0]);

    // A /DA that is only `Tf` has no size to take: the field is drawn at an automatic size.
    expect(drawnOf(bytes, 'bare').da).toBe('/NotoForm 0 Tf 0 g');
  });

  it('draws a border at 1 point when /BS names none, and honours the declared width', async () => {
    const bytes = await filled({ zeroset: 'a', nodefault: 'b' });
    expect(drawnOf(bytes, 'zeroset').content).toContain('1 0 0 RG 1 w 0.5 0.5');
    expect(drawnOf(bytes, 'nodefault').content).toContain('1 0 0 RG 2 w 1 1');
    // With no /DA at all the field takes the form's default (`0 g`) and no size.
    expect(drawnOf(bytes, 'nodefault').da).toBe('/NotoForm 0 Tf 0 g');
  });

  it('wraps a multiline value to the box, breaking a word that is wider than the line', async () => {
    const value = 'alpha beta gamma delta\nepsilon Supercalifragilisticexpialidocious';
    const bytes = await filled({ wrap: value });
    const wrap = drawnOf(bytes, 'wrap');
    const lines = (wrap.content.match(/ Tj ET/g) ?? []).length;
    // 46 points inside: short words share lines, the 34-letter word is broken over several of its own.
    expect(lines).toBeGreaterThanOrEqual(7);
    const extracted = (await pageTextOf(bytes)).replace(/\s+/g, '');
    expect(extracted).toContain('alphabetagammadeltaepsilonSupercalifragilisticexpialidocious');
  });

  it('breaks a first word that is already wider than the line, then goes on with the rest', async () => {
    const bytes = await filled({ wrap: 'Supercalifragilisticexpialidocious beta' });
    const lines = drawnOf(bytes, 'wrap').content.match(/ Tj ET/g) ?? [];
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect((await pageTextOf(bytes)).replace(/\s+/g, '')).toContain('Supercalifragilisticexpialidociousbeta');
  });

  it('shrinks an automatic multiline font until the text fits, down to 4 points', async () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    const bytes = await filled({ shrink: text });
    const sizes = [...drawnOf(bytes, 'shrink').content.matchAll(/NotoForm ([\d.]+) Tf/g)].map((m) =>
      Number(m[1]),
    );
    expect(sizes.length).toBeGreaterThan(1);
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeLessThan(12);
    expect(sizes[0]).toBeGreaterThanOrEqual(4);
  });

  it('aligns single-line and multiline text by /Q: left, centred, right', async () => {
    const bytes = await filled({ q0: 'Hi', q1: 'Hi', q2: 'Hi', m0: 'Hi', m1: 'Hi', m2: 'Hi' });
    const x = (name: string) => runsX(drawnOf(bytes, name).content)[0] ?? Number.NaN;
    expect(x('q0')).toBe(2); // the padding: 2 points, no border
    expect(x('q1')).toBeGreaterThan(x('q0'));
    expect(x('q2')).toBeGreaterThan(x('q1'));
    // The 100 point box and the text of width w: right is 98 - w, centred is 50 - w / 2 = 1 + right / 2.
    expect(x('q1')).toBeCloseTo(1 + x('q2') / 2, 5);
    expect(x('m0')).toBe(2);
    expect(x('m1')).toBeGreaterThan(x('m0'));
    expect(x('m2')).toBeGreaterThan(x('m1'));
    expect(x('m1')).toBeCloseTo(x('q1'), 5);
    expect(x('m2')).toBeCloseTo(x('q2'), 5);
  });

  it('draws a password field as bullets, never the typed text', async () => {
    const bytes = await filled({ pw: 'abc' });
    const text = await pageTextOf(bytes);
    expect(text).toContain('•••');
    expect(text).not.toContain('abc');
  });

  it('spaces comb characters on equal cells, at the declared or an automatic size', async () => {
    const bytes = await filled({ combfixed: '1234', combauto: '1234' });
    for (const name of ['combfixed', 'combauto']) {
      const xs = runsX(drawnOf(bytes, name).content);
      expect(xs).toHaveLength(4);
      // 120 points over 6 cells: 20 points between neighbours (digits are one width in Noto Sans).
      for (let index = 1; index < xs.length; index += 1) {
        expect((xs[index] ?? 0) - (xs[index - 1] ?? 0)).toBeCloseTo(20, 1);
      }
    }
    expect(drawnOf(bytes, 'combfixed').content).toContain('NotoForm 10 Tf');
    expect(drawnOf(bytes, 'combauto').content).not.toContain('NotoForm 10 Tf');
  });

  it('sizes an automatic single-line field to the box, with or without text to measure', async () => {
    const size = (bytes: Uint8Array) =>
      Number(/NotoForm ([\d.]+) Tf/.exec(drawnOf(bytes, 'auto').content)?.[1]);
    // Nothing to measure: the box height alone decides (16 points inside, at most 12).
    const empty = size(await filled({ auto: '' }));
    expect(empty).toBeGreaterThan(11);
    expect(empty).toBeLessThanOrEqual(12);
    // One narrow capital fits at that size too; a text far wider than the box is shrunk to fit it.
    expect(size(await filled({ auto: 'W' }))).toBe(empty);
    const wide = size(await filled({ auto: 'W'.repeat(40) }));
    expect(wide).toBeLessThan(4.5);
    expect(wide).toBeGreaterThanOrEqual(4);
  });

  it('draws every option of a list on a highlight for the selected ones, and a dropdown shows the display text', async () => {
    const out = await fillFormFields(
      styled(),
      [
        { name: 'list', value: ['two'] },
        { name: 'combo', value: 'Beta' },
      ],
      run,
    );
    // `list` is not a multi-select, so a single value is a single string.
    const list = drawnOf(out.bytes, 'list');
    expect(list.content.match(/0\.6 0\.75 0\.85 rg/g)).toHaveLength(1);
    expect(list.content.match(/ Tj ET/g)).toHaveLength(3);
    expect(list.content).toContain('NotoForm 12 Tf');
    const fields = await readFormFields(out.bytes);
    expect(fields.find((field) => field.name === 'combo')?.value).toEqual(['b1']);
    expect(await pageTextOf(out.bytes)).toContain('Beta');
  });
});

/** The text a reader draws on page 1, widgets included. */
async function pageTextOf(bytes: Uint8Array): Promise<string> {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = doc.loadPage(0) as PDFPage;
    return page.toDisplayList(true).toStructuredText('preserve-whitespace').asText();
  } finally {
    doc.destroy();
  }
}

/** A form with one field of each kind a fill can be refused for. */
function choices(): Uint8Array {
  const annot = (...numbers: number[]) => `[${numbers.map((number) => `${number} 0 R`).join(' ')}]`;
  return formPdf({
    fields: annot(10, 11, 12, 13, 14, 15, 16, 19, 20),
    annots: annot(10, 11, 12, 13, 14, 15, 17, 18, 21, 22, 20),
    extra: {
      10: widgetBody(rect(560), '/FT/Tx/T(ad)/MaxLen 5'),
      11: widgetBody(rect(530), '/FT/Btn/T(cb0)'),
      12: widgetBody(rect(500), '/FT/Ch/Ff 131072/T(dd)/Opt[(Bir)(Iki)]'),
      13: widgetBody(rect(470), '/FT/Ch/Ff 393216/T(ed)/Opt[(Bir)]'),
      14: widgetBody(rect(440), '/FT/Ch/Ff 2097152/T(ml)/Opt[(a)(b)(c)]'),
      15: widgetBody(rect(410), '/FT/Ch/T(sl)/Opt[(a)(b)]'),
      16: '<</FT/Btn/Ff 32768/T(rd)/Kids[17 0 R 18 0 R]>>',
      17: widgetBody(rect(380), '/Parent 16 0 R/AS/Off/AP<</N<</A 60 0 R/Off 60 0 R>>>>'),
      18: widgetBody(rect(350), '/Parent 16 0 R/AS/Off/AP<</N<</B 60 0 R/Off 60 0 R>>>>'),
      19: '<</FT/Btn/Ff 32768/T(rn)/Kids[21 0 R 22 0 R]>>',
      21: widgetBody(rect(320), '/Parent 19 0 R/AP<</N<</A 60 0 R>>>>'),
      22: widgetBody(rect(290), '/Parent 19 0 R/AP<</N<</B 60 0 R>>>>'),
      20: widgetBody(rect(260), '/FT/Tx/T(tx)'),
      60: blankForm(10, 10),
    },
  });
}

describe('fillFormFields refusals and button appearances', () => {
  const fill = (name: string, value: string | readonly string[] | boolean) =>
    fillFormFields(choices(), [{ name, value }], run);

  it('refuses a text longer than /MaxLen, naming the field and both lengths', async () => {
    await expect(fill('ad', '123456')).rejects.toMatchObject({
      code: 'value-out-of-range',
      ...refused('form.fill(ad): 6 characters exceed /MaxLen 5'),
    });
    const ok = await fill('ad', '12345');
    expect((await readFormFields(ok.bytes)).find((field) => field.name === 'ad')?.value).toBe('12345');
  });

  it('refuses a choice that is not an option, and several values for a single-choice field', async () => {
    await expect(fill('dd', 'Üç')).rejects.toMatchObject({
      code: 'value-out-of-range',
      ...refused('form.fill(dd): not one of the options'),
    });
    await expect(fill('dd', ['Bir', 'Iki'])).rejects.toMatchObject(refused('form.fill(dd): one option only'));
    await expect(fill('sl', 'zzz')).rejects.toMatchObject(refused('form.fill(sl): not one of the options'));
    await expect(fill('rd', 'Q')).rejects.toMatchObject(refused('form.fill(rd): not one of the options'));
  });

  it('lets an editable combo take any text and a multi-select list take several options', async () => {
    const out = await fillFormFields(
      choices(),
      [
        { name: 'ed', value: 'serbest' },
        { name: 'ml', value: ['a', 'c'] },
      ],
      run,
    );
    const byName = new Map((await readFormFields(out.bytes)).map((field) => [field.name, field]));
    expect(byName.get('ed')?.value).toEqual(['serbest']);
    expect(byName.get('ml')?.value).toEqual(['a', 'c']);
    const single = await fill('ml', 'b');
    expect((await readFormFields(single.bytes)).find((field) => field.name === 'ml')?.value).toEqual(['b']);
  });

  it('reports a value of the wrong kind as missing and draws nothing when nothing was written', async () => {
    const out = await fill('tx', true);
    const notes = out.report.notes;
    expect(notes).toContainEqual({ kind: 'warning', key: 'form.note.missing', params: { count: 1 } });
    expect(notes).toContainEqual({ kind: 'changed', key: 'form.note.filled', params: { count: 0 } });
    expect(notes.map((entry) => entry.key)).toContain('form.note.appearance');
    expect(notes.map((entry) => entry.key)).not.toContain('form.note.appearanceNoto');
    expect((await readFormFields(out.bytes)).find((field) => field.name === 'tx')?.value).toBeNull();
  });

  it('turns a checkbox without appearances on, with a check mark it draws itself', async () => {
    const out = await fill('cb0', true);
    expect((await readFormFields(out.bytes)).find((field) => field.name === 'cb0')?.value).toBe(true);
    const doc = PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const widget = widgetOf(doc, 'cb0');
      expect(widget.get('AS').asName()).toBe('Yes');
      expect(widget.get('AP').get('N').get('Yes').readStream().asString()).toContain(' m ');
      expect(widget.get('AP').get('N').get('Off').readStream().asString()).toBe('q\nQ');
    } finally {
      doc.destroy();
    }
  });

  it('draws the missing Off appearance of a radio group and selects the chosen kid', async () => {
    const out = await fill('rn', 'A');
    const doc = PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const first = widgetOf(doc, 'rn', 0);
      const second = widgetOf(doc, 'rn', 1);
      expect(first.get('AS').asName()).toBe('A');
      expect(second.get('AS').asName()).toBe('Off');
      // The dot is drawn as four curves for the chosen kid and nothing for the Off state.
      expect(first.get('AP').get('N').get('A').readStream().asString().match(/ c/g)).toHaveLength(4);
      expect(second.get('AP').get('N').get('Off').readStream().asString()).toBe('q\nQ');
    } finally {
      doc.destroy();
    }
  });

  it('reports progress per written field and stops on an aborted signal', async () => {
    const onProgress = vi.fn();
    await fillFormFields(
      choices(),
      [
        { name: 'ad', value: 'x' },
        { name: 'tx', value: 'y' },
      ],
      { signal: run.signal, onProgress },
    );
    const event = (done: number) => [{ phase: 'forms', labelKey: 'op.progress.forms', done, total: 2 }];
    expect(onProgress.mock.calls).toEqual([event(1), event(2)]);
    await expect(
      fillFormFields(choices(), [{ name: 'ad', value: 'x' }], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createFormFields refusals', () => {
  const create = (spec: Parameters<typeof createFormFields>[1][number]) =>
    createFormFields(choices(), [spec], run);

  it('refuses a field with no area, an unusable name or a name already in the form', async () => {
    await expect(
      create({ kind: 'text', name: 'w', pageIndex: 0, rect: [0, 0, 0, 10] }),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
      ...refused('field w has a non-positive size (0x10)'),
    });
    await expect(
      create({ kind: 'text', name: 'h', pageIndex: 0, rect: [0, 0, 10, -1] }),
    ).rejects.toMatchObject(refused('field h has a non-positive size (10x-1)'));
    await expect(
      create({ kind: 'text', name: '  ', pageIndex: 0, rect: [0, 0, 10, 10] }),
    ).rejects.toMatchObject(refused('field name "  " is empty or contains a period'));
    await expect(
      create({ kind: 'text', name: 'a.b', pageIndex: 0, rect: [0, 0, 10, 10] }),
    ).rejects.toMatchObject(refused('field name "a.b" is empty or contains a period'));
    await expect(
      create({ kind: 'text', name: 'ad', pageIndex: 0, rect: [0, 0, 10, 10] }),
    ).rejects.toMatchObject(refused('a field named ad already exists'));
    await expect(
      create({ kind: 'text', name: 'n', pageIndex: -1, rect: [0, 0, 10, 10] }),
    ).rejects.toMatchObject({
      code: 'range-invalid',
    });
  });

  it('refuses a radio group without options', async () => {
    await expect(
      create({ kind: 'radio', name: 'r', pageIndex: 0, rect: [0, 0, 10, 30] }),
    ).rejects.toMatchObject({
      code: 'selection-empty',
      ...refused('radio group r was created without options'),
    });
  });

  it('creates an option list and keeps a default that is not an option unselected', async () => {
    const out = await createFormFields(
      choices(),
      [
        {
          kind: 'optionlist',
          name: 'olist',
          pageIndex: 0,
          rect: [200, 100, 80, 60],
          options: ['a', 'b'],
          defaultValue: 'b',
        },
        {
          kind: 'dropdown',
          name: 'dlist',
          pageIndex: 0,
          rect: [200, 200, 80, 20],
          options: ['a', 'b'],
          defaultValue: 'zz',
        },
      ],
      run,
    );
    const byName = new Map((await readFormFields(out.bytes)).map((field) => [field.name, field]));
    expect(byName.get('olist')).toMatchObject({ kind: 'optionlist', value: ['b'], options: ['a', 'b'] });
    expect(byName.get('dlist')).toMatchObject({ kind: 'dropdown', value: [], options: ['a', 'b'] });
  });

  it('adds the /AcroForm to a document that has none, with a default appearance naming the embedded face', async () => {
    const bare = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>',
    });
    const out = await createFormFields(
      bare,
      [{ kind: 'text', name: 'n', pageIndex: 0, rect: [10, 10, 100, 20] }],
      run,
    );
    expect((await readFormFields(out.bytes)).map((field) => field.name)).toEqual(['n']);
    const doc = PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const form = doc.getTrailer().get('Root').get('AcroForm');
      expect(form.get('DA').asString()).toBe('/NotoForm 0 Tf 0 g');
      expect(form.get('DR').get('Font').get('NotoForm').isNull()).toBe(false);
    } finally {
      doc.destroy();
    }
  });
});

describe('setFieldFlags', () => {
  it('sets and clears each flag on its own and ignores names that are not fields', async () => {
    const flagsOfAd = async (bytes: Uint8Array) => {
      const ad = (await readFormFields(bytes)).find((field) => field.name === 'ad');
      return { readOnly: ad?.readOnly, required: ad?.required };
    };
    const locked = await setFieldFlags(choices(), ['ad', 'nope'], { readOnly: true }, run);
    expect(await flagsOfAd(locked.bytes)).toEqual({ readOnly: true, required: false });
    expect(locked.report.notes).toEqual([
      { kind: 'changed', key: 'form.note.flagged', params: { count: 1 } },
    ]);
    const both = await setFieldFlags(locked.bytes, ['ad'], { readOnly: false, required: true }, run);
    expect(await flagsOfAd(both.bytes)).toEqual({ readOnly: false, required: true });
    const optional = await setFieldFlags(both.bytes, ['ad'], { required: false }, run);
    expect(await flagsOfAd(optional.bytes)).toEqual({ readOnly: false, required: false });
  });
});

describe('flattenForm refusals and damaged appearances', () => {
  const one = (fields: string, annots: string, extra: Record<number, string>, secondAnnots?: string) =>
    formPdf({
      fields,
      annots,
      secondAnnots,
      extra: { ...extra, 60: blankForm(10, 10), 61: blankForm(0, 0) },
    });
  const flat = (bytes: Uint8Array, names: readonly string[] | null) => flattenForm(bytes, names, run);
  const text = (more: string) => widgetBody(rect(500), `/FT/Tx/T(t)/AP<</N 60 0 R>>${more}`);

  it('refuses a name that is not a field, an empty selection and a form without fields', async () => {
    const bytes = one('[10 0 R]', '[10 0 R]', { 10: text('') });
    await expect(flat(bytes, ['zz'])).rejects.toMatchObject({
      code: 'selection-empty',
      ...refused('no field named zz'),
    });
    await expect(flat(bytes, [])).rejects.toMatchObject({ code: 'selection-empty' });
    await expect(flat(one('[]', '[]', {}), null)).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('refuses a signature or push button, and a field with no widget', async () => {
    const sig = one('[10 0 R]', '[10 0 R]', { 10: widgetBody(rect(500), '/FT/Sig/T(s)') });
    await expect(flat(sig, null)).rejects.toMatchObject({
      code: 'unsupported',
      ...refused('Unsupported flatten field or XFA form'),
    });
    const bare = one('[10 0 R]', '[]', { 10: '<</FT/Tx/T(nw)>>' });
    await expect(flat(bare, null)).rejects.toMatchObject({
      code: 'unsupported',
      ...refused('Field has no visible widgets'),
    });
  });

  it('refuses a widget that no page holds, and an appearance with no area', async () => {
    const lost = one('[10 0 R]', '[]', {
      10: '<</Type/Annot/Subtype/Widget/FT/Tx/T(t)/Rect[10 10 50 30]/AP<</N 60 0 R>>>>',
    });
    await expect(flat(lost, null)).rejects.toMatchObject({
      code: 'corrupt-document',
      ...refused('Widget page missing'),
    });
    const empty = one('[10 0 R]', '[10 0 R]', { 10: text('').replace('60 0 R', '61 0 R') });
    await expect(flat(empty, null)).rejects.toMatchObject({
      code: 'corrupt-document',
      ...refused('Invalid widget appearance bounds'),
    });
  });

  it('paints what each button shows and skips one whose shown state has no stream', async () => {
    const button = (y: number, name: string, more: string) =>
      widgetBody(`10 ${y} 20 ${y + 10}`, `/FT/Btn/T(${name})${more}`);
    const bytes = one('[10 0 R 11 0 R 12 0 R]', '[10 0 R 11 0 R 12 0 R]', {
      // The normal appearance is a number: there is nothing to look a state up in.
      10: button(500, 'c1', '/AP<</N 5>>'),
      // A state dictionary and no /AS naming one of its states.
      11: button(480, 'c2', '/AP<</N<</Yes 60 0 R/Off 60 0 R>>>>'),
      // The state it shows is not a stream: nothing to paint.
      12: button(460, 'c3', '/V/Off/AS/Off/AP<</N<</Yes 60 0 R/Off 5>>>>'),
    });
    const out = await flat(bytes, null);
    expect(out.report.notes).toContainEqual({
      kind: 'changed',
      key: 'form.note.flattened',
      params: { count: 3 },
    });
    expect(await readFormFields(out.bytes)).toEqual([]);
    const doc = PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const painted: string[] = [];
      doc
        .findPage(0)
        .get('Resources')
        .get('XObject')
        .forEach((_value, key) => {
          painted.push(String(key));
        });
      expect(painted.filter((key) => key.startsWith('FlatWidget'))).toHaveLength(2);
    } finally {
      doc.destroy();
    }
  });

  it('flattens widgets on a page without /Annots, one the page does not list, and a direct field', async () => {
    const field = (name: string, extra: string) =>
      widgetBody(rect(500), `/FT/Tx/T(${name})/AP<</N 60 0 R>>${extra}`);
    const bytes = one(
      '[10 0 R 11 0 R <</T(dir)/FT/Tx/Subtype/Widget/Rect[10 300 110 320]/P 3 0 R/AP<</N 60 0 R>>>>]',
      '[<</Subtype/Link>>]',
      {
        // /P names the second page, which has no /Annots at all.
        10: field('onPageTwo', '').replace('/P 3 0 R', '/P 4 0 R'),
        // On the first page, whose /Annots does not list it.
        11: field('unlisted', ''),
      },
    );
    const out = await flat(bytes, ['onPageTwo', 'unlisted', 'dir']);
    expect(out.report.notes).toContainEqual({
      kind: 'changed',
      key: 'form.note.flattened',
      params: { count: 3 },
    });
    const doc = PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const drawn = (page: number) => {
        const keys: string[] = [];
        doc
          .findPage(page)
          .get('Resources')
          .get('XObject')
          .forEach((_value, key) => {
            keys.push(String(key));
          });
        return keys.filter((key) => key.startsWith('FlatWidget')).length;
      };
      expect(drawn(0)).toBe(2);
      expect(drawn(1)).toBe(1);
    } finally {
      doc.destroy();
    }
  });
});

describe('the calculator', () => {
  it('evaluates the four operators, unary minus, min and max and parentheses', () => {
    expect(evaluateCalculation('1 + 2 * 3 - 4 / 2', {})).toBe(5);
    expect(evaluateCalculation('(1 + 2) * 3', {})).toBe(9);
    expect(evaluateCalculation('-x * 2', { x: 4 })).toBe(-8);
    expect(evaluateCalculation('min(3, 9) + max(3, 9)', {})).toBe(12);
    expect(evaluateCalculation('10 - 4', {})).toBe(6);
    expect(evaluateCalculation('1.5 + 1', {})).toBe(2.5);
  });

  it('reads an undefined field as 0 and a division by zero or an overflow as 0', () => {
    expect(evaluateCalculation('ghost + 1', {})).toBe(1);
    expect(evaluateCalculation('8 / zero', { zero: 0 })).toBe(0);
    expect(evaluateCalculation('9'.repeat(400), {})).toBe(0);
  });

  it.each([
    ['', 'calculation: empty expression'],
    ['2 $ 3', 'calculation: unexpected character "$"'],
    ['1..2', 'calculation: malformed number "1..2"'],
    ['(1 + 2', 'calculation: unexpected token "end of expression"'],
    ['1 +', 'calculation: unexpected token "end of expression"'],
    ['min 1', 'calculation: unexpected token "1"'],
    ['min(1 2)', 'calculation: unexpected token "2"'],
    ['max(1, 2', 'calculation: unexpected token "end of expression"'],
    ['.5', 'calculation: malformed number ".5"'],
    ['5.', 'calculation: malformed number "5."'],
    ['1.2.3 + 1', 'calculation: malformed number "1.2.3"'],
    ['.', 'calculation: malformed number "."'],
    ['* 2', 'calculation: unexpected token "*"'],
    ['1 2', 'calculation: unexpected token "2"'],
    ['(1 2)', 'calculation: unexpected token "2"'],
  ])('refuses %j with a message naming the token', (expression, message) => {
    expect(() => evaluateCalculation(expression, {})).toThrow(
      expect.objectContaining({
        code: 'value-out-of-range',
        details: { engine: 'model', engineMessage: message },
      }),
    );
  });
});

describe('applyCalculations', () => {
  const sheet = (): Uint8Array =>
    formPdf({
      fields: '[10 0 R 11 0 R 12 0 R 13 0 R 14 0 R]',
      annots: '[10 0 R 11 0 R 12 0 R 13 0 R 14 0 R]',
      extra: {
        10: widgetBody(rect(560), '/FT/Tx/T(a)/V(2,5)'),
        11: widgetBody(rect(530), '/FT/Tx/T(total)'),
        12: widgetBody(rect(500), '/FT/Btn/T(ck)'),
        13: widgetBody(rect(470), '/FT/Ch/Ff 131072/T(dd)/Opt[(7)(8)]/V(7)'),
        14: widgetBody(rect(440), '/FT/Tx/T(word)/V(abc)'),
      },
    });

  it('writes the result into a text target only, keeping it for later expressions', async () => {
    const out = await applyCalculations(
      sheet(),
      [
        { target: 'total', expression: 'a + dd + word + ck' },
        { target: 'ck', expression: '1' },
        { target: 'ghost', expression: 'total * 2' },
        { target: 'total', expression: '1 / 3' },
      ],
      run,
    );
    // A checkbox, a list and a text that is not a number read as their number or 0.
    expect(out.results).toEqual({ total: '0.33', ck: '1', ghost: '19' });
    const byName = new Map((await readFormFields(out.bytes)).map((field) => [field.name, field]));
    expect(byName.get('total')?.value).toBe('0.33');
    expect(byName.get('ck')?.value).toBe(false);
    expect(out.report.notes).toEqual([
      { kind: 'changed', key: 'form.note.calculated', params: { count: 3 } },
    ]);
  });

  it('stops on an aborted signal and reports progress per calculation', async () => {
    await expect(
      applyCalculations(sheet(), [{ target: 'total', expression: '1' }], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const onProgress = vi.fn();
    await applyCalculations(sheet(), [{ target: 'total', expression: '1' }], {
      signal: run.signal,
      onProgress,
    });
    expect(onProgress.mock.calls).toEqual([
      [{ phase: 'forms', labelKey: 'op.progress.forms', done: 1, total: 1 }],
    ]);
  });
});

describe('validateField', () => {
  const info = (over: Partial<FormFieldInfo>): FormFieldInfo => ({
    name: 'f',
    kind: 'text',
    value: null,
    readOnly: false,
    required: false,
    maxLength: null,
    options: null,
    pageIndex: 0,
    ...over,
  });

  it('refuses a read-only field whatever the value', () => {
    expect(validateField(info({ readOnly: true }), 'x')).toEqual({
      ok: false,
      reasonKey: 'form.reason.readOnly',
    });
  });

  it('checks a text against /Required and /MaxLen', () => {
    expect(validateField(info({ required: true }), '  ')).toEqual({
      ok: false,
      reasonKey: 'form.reason.required',
    });
    expect(validateField(info({ required: true }), true)).toEqual({
      ok: false,
      reasonKey: 'form.reason.required',
    });
    expect(validateField(info({ maxLength: 3 }), 'abcd')).toEqual({
      ok: false,
      reasonKey: 'form.reason.maxLength',
    });
    expect(validateField(info({ maxLength: 3 }), 'abc')).toEqual({ ok: true });
    expect(validateField(info({}), 'anything')).toEqual({ ok: true });
  });

  it('requires a required checkbox to be on', () => {
    expect(validateField(info({ kind: 'checkbox', required: true }), false)).toEqual({
      ok: false,
      reasonKey: 'form.reason.required',
    });
    expect(validateField(info({ kind: 'checkbox', required: true }), true)).toEqual({ ok: true });
    expect(validateField(info({ kind: 'checkbox' }), false)).toEqual({ ok: true });
  });

  it('accepts only listed options for a choice field, and an empty choice unless it is required', () => {
    const choice = (kind: FormFieldInfo['kind'], required = false) =>
      info({ kind, required, options: ['a', 'b'] });
    expect(validateField(choice('dropdown'), 'a')).toEqual({ ok: true });
    expect(validateField(choice('optionlist'), ['a', 'b'])).toEqual({ ok: true });
    expect(validateField(choice('radio'), 'c')).toEqual({ ok: false, reasonKey: 'form.reason.notAnOption' });
    expect(validateField(choice('dropdown'), ['a', 'c'])).toEqual({
      ok: false,
      reasonKey: 'form.reason.notAnOption',
    });
    expect(validateField(choice('dropdown'), [])).toEqual({ ok: true });
    expect(validateField(choice('dropdown', true), [])).toEqual({
      ok: false,
      reasonKey: 'form.reason.required',
    });
    expect(validateField(choice('radio'), true)).toEqual({ ok: true });
    expect(validateField(info({ kind: 'dropdown', options: null }), 'a')).toEqual({
      ok: false,
      reasonKey: 'form.reason.notAnOption',
    });
  });

  it('has no rule for the other kinds', () => {
    expect(validateField(info({ kind: 'signature', required: true }), 'x')).toEqual({ ok: true });
  });
});

describe('form data interchange', () => {
  it('stops an export whose signal is aborted', async () => {
    await expect(exportFormData(choices(), 'json', AbortSignal.abort())).rejects.toMatchObject({
      code: 'aborted',
      ...refused('export aborted'),
    });
  });

  it('imports FDF and JSON given as text or bytes, reporting names the form does not have', async () => {
    const filled = await fillFormFields(choices(), [{ name: 'ad', value: 'Ali' }], run);
    const fdf = await exportFormData(filled.bytes, 'fdf');
    const json = await exportFormData(filled.bytes, 'json');
    expect(fdf.name).toBe('form.fdf');
    expect(json.mime).toBe('application/json');
    const withGhost = JSON.stringify({
      fields: [...JSON.parse(new TextDecoder().decode(json.bytes)).fields, { name: 'ghost', value: 'x' }],
    });
    const inputs: readonly [Uint8Array | string, 'fdf' | 'json'][] = [
      [new TextDecoder().decode(fdf.bytes), 'fdf'],
      [fdf.bytes, 'fdf'],
      [json.bytes, 'json'],
      [new TextDecoder().decode(json.bytes), 'json'],
    ];
    for (const [data, format] of inputs) {
      const imported = await importFormData(choices(), data, format, run);
      expect(imported.missing).toEqual([]);
      expect(imported.applied).toBe(fdf.fields);
      expect((await readFormFields(imported.bytes)).find((field) => field.name === 'ad')?.value).toBe('Ali');
    }
    const missing = await importFormData(choices(), withGhost, 'json', run);
    expect(missing.missing).toEqual(['ghost']);
  });
});

describe('forms whose pages and XFA packets are written unusually', () => {
  it('finds the page of a widget when the page is a direct dictionary in /Kids', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[10 0 R]>>>>',
      2: '<</Type/Pages/Kids[<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Annots[10 0 R]>>]/Count 1>>',
      10: '<</Type/Annot/Subtype/Widget/FT/Tx/T(t)/Rect[10 10 100 30]>>',
    });
    const fields = await readFormFields(bytes);
    expect(fields).toMatchObject([{ name: 't', pageIndex: 0 }]);
  });

  const xml = (text: string): string => `<</Length ${text.length}>>\nstream\n${text}\nendstream`;
  const TEMPLATE =
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><field name="Name"><ui><textEdit/></ui></field><field name="Birth"><ui><dateTimeEdit/></ui><format><picture>date{DD/MM/YYYY}</picture></format></field></subform></template>';
  const DATASETS =
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Old</Name><Birth>2000-01-01</Birth></form1></xfa:data></xfa:datasets>';

  it('syncs what an XFA form can follow and warns about what it cannot', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[11 0 R 12 0 R]',
      acroForm: '/XFA[(template) 20 0 R (datasets) 21 0 R]',
      extra: {
        10: '<</T(form1[0])/Kids[11 0 R 12 0 R]>>',
        11: widgetBody(rect(500), '/FT/Tx/T(Name[0])/Parent 10 0 R'),
        12: widgetBody(rect(470), '/FT/Tx/T(Birth[0])/Parent 10 0 R'),
        20: xml(TEMPLATE),
        21: xml(DATASETS),
      },
    });
    const out = await fillFormFields(
      bytes,
      [
        { name: 'form1[0].Name[0]', value: 'New' },
        { name: 'form1[0].Birth[0]', value: '2020-02-02' },
      ],
      run,
    );
    expect(out.report.steps).toEqual(['load', 'form.setText', 'xfa.datasets', 'save']);
    expect(out.report.notes).toContainEqual({
      kind: 'changed',
      key: 'xfa.note.synced',
      params: { count: 1 },
    });
    expect(out.report.notes).toContainEqual({
      kind: 'warning',
      key: 'xfa.note.notSynced',
      params: { count: 1 },
    });
  });
});
