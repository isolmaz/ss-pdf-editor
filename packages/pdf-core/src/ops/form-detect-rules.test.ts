/**
 * The form-detection rules on hand-built page models: no engine, only geometry. What they
 * protect: a label that names the field beside it (and a heading that must not), a typed
 * blank that is a field and a table-of-contents leader that is not, the field kinds the
 * marks mean (square, circles in a row, comb cells, "Signature"), and the names the labels
 * become (no period, unique, never empty).
 */

import { describe, expect, it } from 'vitest';
import {
  type Box,
  cleanLabel,
  type DetectionPage,
  type DetectLine,
  detectPageFields,
  readLine,
  uniqueName,
} from './form-detect-rules';

/** A line of text: `parts` are `[text, x]` pairs, glyphs half the size wide, `top` the line's top. */
function line(parts: readonly (readonly [string, number])[], top: number, size = 10): DetectLine {
  return {
    chars: parts.flatMap(([text, x0]) =>
      [...text].map((c, at) => ({
        c,
        size,
        box: [x0 + at * size * 0.5, top, x0 + (at + 1) * size * 0.5, top + size] as Box,
      })),
    ),
  };
}

function page(parts: Partial<DetectionPage>): DetectionPage {
  return {
    width: 595,
    height: 842,
    lines: [],
    hlines: [],
    vlines: [],
    rects: [],
    circles: [],
    ink: [],
    tables: [],
    ...parts,
  };
}

const outline = (box: Box) => ({ box, stroked: true, luminance: null });

describe('form-detect-rules', () => {
  it('reads a typed blank, splits runs at a wide gap and leaves a contents leader alone', () => {
    const typed = readLine(
      line(
        [
          ['Telefon: ', 50],
          ['______', 95],
        ],
        100,
      ),
    );
    expect(typed.runs.map((run) => run.text)).toEqual(['Telefon:']);
    expect(typed.blanks).toHaveLength(1);
    expect(typed.blanks[0]?.box[0]).toBeCloseTo(95, 5);
    expect(typed.blanks[0]?.box[2]).toBeCloseTo(125, 5);

    // Two words 40 pt apart are two runs: a column gap, not a space.
    const columns = readLine(
      line(
        [
          ['Ad', 50],
          ['Soyad', 100],
        ],
        100,
      ),
    );
    expect(columns.runs.map((run) => run.text)).toEqual(['Ad', 'Soyad']);

    // Dots leading to a page number lead to a page; dots leading to a word are a blank.
    expect(readLine(line([['Giriş ......... 12', 50]], 100)).blanks).toHaveLength(0);
    expect(readLine(line([['Giriş ......... Ad', 50]], 100)).blanks).toHaveLength(1);
    // Three underscores are a dash, not room to write.
    expect(readLine(line([['a ___ b', 50]], 100)).blanks).toHaveLength(0);
  });

  it('turns a label into a name: no period, no colon, bounded, unique, never empty', () => {
    expect(cleanLabel('T.C. Kimlik No:')).toBe('TC Kimlik No');
    expect(cleanLabel('Doğum Tarihi .........')).toBe('Doğum Tarihi');
    expect(cleanLabel('  Adres *  ')).toBe('Adres');
    const long = cleanLabel('Çok uzun bir alan açıklaması burada başlıyor ve hiç bitmek bilmiyor');
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith(' ')).toBe(false);
    expect('Çok uzun bir alan açıklaması burada başlıyor ve hiç bitmek bilmiyor').toContain(long);

    const taken = new Set(['ad soyad']);
    expect(uniqueName('Ad Soyad:', 'text', taken)).toBe('Ad Soyad 2');
    expect(uniqueName('Ad Soyad:', 'text', taken)).toBe('Ad Soyad 3');
    expect(uniqueName('', 'checkbox', taken)).toBe('Checkbox');
    expect(uniqueName('...', 'signature', taken)).toBe('Signature');
    expect(uniqueName('', 'checkbox', taken)).toBe('Checkbox 2');
    expect(taken.has('ad soyad 3')).toBe(true);
  });

  it('finds a text field on the rule after a colon label, named from the label', () => {
    const found = detectPageFields(
      page({
        lines: [line([['Ad Soyad:', 50]], 100)],
        hlines: [{ x0: 130, x1: 330, y: 112 }],
      }),
    );
    expect(found).toHaveLength(1);
    const [field] = found;
    expect(field).toMatchObject({ kind: 'text', label: 'Ad Soyad:', source: 'line', confidence: 'high' });
    // The field spans the rule, rests on it, and is a writable height.
    expect(field?.rect[0]).toBeCloseTo(130, 0);
    expect(field?.rect[2]).toBeCloseTo(330, 0);
    expect(field?.rect[3]).toBeGreaterThan(110);
    expect(field?.rect[3]).toBeLessThanOrEqual(112);
    expect((field?.rect[3] ?? 0) - (field?.rect[1] ?? 0)).toBeGreaterThanOrEqual(12);
    expect((field?.rect[3] ?? 0) - (field?.rect[1] ?? 0)).toBeLessThanOrEqual(22);
  });

  it('finds a typed blank, and a scan reads its rules as medium confidence', () => {
    const blank = detectPageFields(
      page({
        lines: [
          line(
            [
              ['Telefon: ', 50],
              ['________', 95],
            ],
            100,
          ),
        ],
      }),
    );
    expect(blank).toMatchObject([{ kind: 'text', label: 'Telefon:', source: 'blank' }]);
    expect(blank[0]?.rect[0]).toBeCloseTo(95, 5);

    const ruled = {
      lines: [line([['Ad Soyad:', 50]], 100)],
      hlines: [{ x0: 130, x1: 330, y: 112 }],
    };
    expect(detectPageFields(page(ruled))[0]?.confidence).toBe('high');
    expect(detectPageFields(page({ ...ruled, raster: true }))[0]?.confidence).toBe('medium');
  });

  it('finds a checkbox from a small square, and radio buttons only when two stand in a row', () => {
    const checks = detectPageFields(
      page({
        lines: [line([['Kabul ediyorum', 66]], 199)],
        rects: [outline([50, 200, 60, 210])],
      }),
    );
    expect(checks).toMatchObject([
      { kind: 'checkbox', label: 'Kabul ediyorum', source: 'square', rect: [50, 200, 60, 210] },
    ]);

    const radios = detectPageFields(
      page({
        lines: [line([['Medeni hal:', 20]], 299), line([['Evet', 114]], 299), line([['Hayır', 164]], 299)],
        circles: [outline([100, 300, 110, 310]), outline([150, 300, 160, 310])],
      }),
    );
    expect(radios.map((entry) => [entry.kind, entry.option, entry.label])).toEqual([
      ['radio', 'Evet', 'Medeni hal:'],
      ['radio', 'Hayır', 'Medeni hal:'],
    ]);
    expect(radios[0]?.group).toBeDefined();
    expect(radios[0]?.group).toBe(radios[1]?.group);

    // One lone circle is a bullet, not a question.
    const lone = detectPageFields(
      page({ lines: [line([['Evet', 114]], 299)], circles: [outline([100, 300, 110, 310])] }),
    );
    expect(lone).toEqual([]);
  });

  it('turns a signature label into a signature field, but a date or a name beside it is text', () => {
    const rule = { x0: 130, x1: 330, y: 112 };
    const kindFor = (label: string): string | undefined =>
      detectPageFields(page({ lines: [line([[label, 50]], 100)], hlines: [rule] }))[0]?.kind;
    expect(kindFor('İmza:')).toBe('signature');
    expect(kindFor('Signature:')).toBe('signature');
    expect(kindFor('İmza tarihi:')).toBe('text');
    expect(kindFor('Name:')).toBe('text');
  });

  it('reads touching equal squares as a comb with its cell count', () => {
    const cells = Array.from({ length: 11 }, (_, at) => outline([130 + at * 14, 500, 144 + at * 14, 514]));
    const found = detectPageFields(page({ lines: [line([['T.C. Kimlik No:', 40]], 502)], rects: cells }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'text', source: 'comb', cells: 11, label: 'T.C. Kimlik No:' });
    expect(found[0]?.rect).toEqual([130, 500, 130 + 11 * 14, 514]);
    expect(cleanLabel(found[0]?.label ?? '')).toBe('TC Kimlik No');
  });

  it('proposes nothing for a heading over a rule, a paragraph, or an empty page', () => {
    const body = line([['Aşağıdaki alanları eksiksiz doldurunuz.', 50]], 300);
    // A heading set larger than the body, with its underline.
    const heading = line([['KİŞİSEL BİLGİLER', 50]], 100, 20);
    expect(
      detectPageFields(page({ lines: [heading, body], hlines: [{ x0: 220, x1: 400, y: 122 }] })),
    ).toEqual([]);
    expect(detectPageFields(page({ lines: [body] }))).toEqual([]);
    expect(detectPageFields(page({}))).toEqual([]);
  });
});

/** Page text that makes 10 pt the body size without being a label itself (more than six words). */
const BODY = line([['Lütfen formu eksiksiz doldurup imzalayarak teslim ediniz bugün.', 50]], 780);
const rule = (x0: number, x1: number, y: number) => ({ x0, x1, y });
type Fields = ReturnType<typeof detectPageFields>;
const summary = (fields: Fields) => fields.map((entry) => [entry.source, entry.label, entry.confidence]);
/** The fields a rule gave, without what the colon at the end of a label suggests on its own. */
const ruled = (fields: Fields) => fields.filter((entry) => entry.source === 'line');
const boxed = (fields: Fields) => fields.filter((entry) => entry.source === 'box' || entry.source === 'comb');

describe('typed blanks and labels', () => {
  it('counts an ellipsis as three dots, lets a space sit inside a blank, and reads full-width underscores', () => {
    expect(readLine(line([['Ad ……', 50]], 100)).blanks).toHaveLength(1);
    expect(readLine(line([['Ad …', 50]], 100)).blanks).toHaveLength(0);
    const spaced = readLine(line([['Ad _ _ _ _', 50]], 100));
    expect(spaced.blanks).toHaveLength(1);
    expect(spaced.blanks[0]?.box[0]).toBeCloseTo(65, 5);
    expect(readLine(line([['＿＿＿＿', 50]], 100)).blanks).toHaveLength(1);
    expect(readLine(line([['x', 50]], 100)).blanks).toEqual([]);
  });

  it('treats dots that lead to a number or a roman numeral as a leader, and underscores never', () => {
    expect(readLine(line([['Giriş ...... (iv)', 50]], 100)).blanks).toHaveLength(0);
    expect(readLine(line([['Giriş ...... XII', 50]], 100)).blanks).toHaveLength(0);
    expect(readLine(line([['Giriş ______ 12', 50]], 100)).blanks).toHaveLength(1);
  });

  it('keeps a run whole when only spaces precede it, and splits it at a wide gap after solid text', () => {
    const spaced = readLine(line([[' Ad', 50]], 100));
    expect(spaced.runs.map((entry) => entry.text)).toEqual(['Ad']);
    expect(readLine(line([['   ', 50]], 100))).toEqual({ runs: [], blanks: [] });
    const sizes = readLine({
      chars: [
        { c: 'A', size: 8, box: [0, 0, 4, 8] },
        { c: 'B', size: 12, box: [4, 0, 10, 12] },
        { c: 'C', size: 10, box: [10, 0, 15, 10] },
      ],
    });
    expect(sizes.runs).toMatchObject([{ text: 'ABC', size: 10 }]);
  });

  it('cuts a long label at its last space, or at the limit when the first word is long', () => {
    const cut = cleanLabel('uzun bir etiket burada başlıyor ve çok uzun sürüyor işte böyle');
    expect(cut).toBe('uzun bir etiket burada başlıyor ve çok uzun');
    expect(cleanLabel('x'.repeat(60))).toBe('x'.repeat(48));
    expect(cleanLabel(`abcdefgh ${'y'.repeat(60)}`)).toBe(`abcdefgh ${'y'.repeat(39)}`);
  });
});

describe('fields over rules', () => {
  it('joins the pieces of one rule and ignores rules that are too short, too long, in a table or the edge of a box', () => {
    const found = detectPageFields(
      page({
        lines: [
          BODY,
          line([['Ad Soyad:', 50]], 100),
          line([['Kısa:', 50]], 150),
          line([['Uzun:', 20]], 200),
          line([['Tablo:', 50]], 250),
        ],
        hlines: [
          rule(130, 230, 112),
          rule(230, 330, 112.5),
          rule(130, 150, 162),
          rule(80, 580, 212),
          rule(130, 330, 262),
        ],
        tables: [{ box: [130, 245, 330, 275], cells: [] }],
      }),
    );
    expect(summary(ruled(found))).toEqual([
      ['line', 'Ad Soyad:', 'high'],
      ['line', 'Uzun:', 'high'],
    ]);
    expect(found[0]?.rect[0]).toBe(130);
    expect(found[0]?.rect[2]).toBe(330);
  });

  it('does not make a field of the border of a rectangle that is a box already', () => {
    const found = detectPageFields(
      page({
        lines: [BODY, line([['Açıklama:', 50]], 300)],
        hlines: [rule(130, 330, 300), rule(130, 330, 340)],
        rects: [outline([130, 300, 330, 340])],
      }),
    );
    expect(summary(found)).toEqual([['box', 'Açıklama:', 'high']]);
  });

  it('splits a rule around text written on it and keeps only the pieces a label can name', () => {
    const layout = (middle: string) =>
      page({
        lines: [BODY, line([['Ad:', 50]], 100), line([[middle, 250]], 100)],
        hlines: [rule(130, 400, 112)],
      });
    // "ile" begins over the rule and does not ask for anything: the piece after it is not a field.
    expect(summary(ruled(detectPageFields(layout('ile'))))).toEqual([['line', 'Ad:', 'high']]);
    const asked = ruled(detectPageFields(layout('ile:')));
    expect(summary(asked)).toEqual([
      ['line', 'Ad:', 'high'],
      ['line', 'ile:', 'high'],
    ]);
    // The piece that follows its label closely starts a point and a half in.
    expect(asked[1]?.rect[0]).toBeCloseTo(250 + 4 * 5 + 2 + 1.5, 5);
  });

  it('names a rule by a caption under it or a label over it, whichever is nearer', () => {
    const below = detectPageFields(
      page({ lines: [BODY, line([['Adres', 130]], 115)], hlines: [rule(130, 330, 112)] }),
    );
    expect(summary(below)).toEqual([['line', 'Adres', 'medium']]);

    const above = detectPageFields(
      page({ lines: [BODY, line([['Adres', 130]], 80)], hlines: [rule(130, 330, 112)] }),
    );
    expect(summary(above)).toEqual([['line', 'Adres', 'medium']]);
    // The field starts under the label that names it.
    expect(above[0]?.rect[1]).toBe(91);

    const both = detectPageFields(
      page({
        lines: [BODY, line([['Üst', 130]], 80), line([['Alt', 130]], 115)],
        hlines: [rule(130, 330, 112)],
      }),
    );
    expect(both[0]?.label).toBe('Alt');
    const aboveCloser = detectPageFields(
      page({
        lines: [BODY, line([['Üst', 130]], 90), line([['Alt', 130]], 126)],
        hlines: [rule(130, 330, 112)],
      }),
    );
    expect(aboveCloser[0]?.label).toBe('Üst');
  });

  it('ignores a caption under a rule that is a page number, a figure caption or too long', () => {
    const under = (text: string) =>
      detectPageFields(page({ lines: [BODY, line([[text, 130]], 115)], hlines: [rule(130, 330, 112)] }));
    expect(under('Sayfa 3')).toEqual([]);
    expect(under('Şekil 2')).toEqual([]);
    expect(under('Açıklama '.repeat(5).trim())).toEqual([]);
    expect(under('1234')).toEqual([]);
  });

  it('continues a field on the next rule of the same width and leaves a lone rule alone', () => {
    const twoLines = ruled(
      detectPageFields(
        page({
          lines: [BODY, line([['Adres:', 50]], 100)],
          hlines: [rule(130, 330, 112), rule(130, 330, 135)],
        }),
      ),
    );
    expect(summary(twoLines)).toEqual([
      ['line', 'Adres:', 'high'],
      ['line', 'Adres:', 'medium'],
    ]);
    expect(twoLines[1]?.rect).toEqual([130, 113, 330, 134.5]);
    // A rule with nothing near it names nothing, and one far from the first is not its continuation.
    expect(detectPageFields(page({ lines: [BODY], hlines: [rule(130, 330, 135)] }))).toEqual([]);
    const far = ruled(
      detectPageFields(
        page({
          lines: [BODY, line([['Adres:', 50]], 100)],
          hlines: [rule(130, 330, 112), rule(130, 330, 200)],
        }),
      ),
    );
    expect(far).toHaveLength(1);
  });

  it('refuses a divider across the page, a caption far smaller than the text, and a heading with its underline', () => {
    expect(
      detectPageFields(page({ lines: [BODY, line([['Adres', 50]], 115)], hlines: [rule(40, 520, 112)] })),
    ).toEqual([]);
    expect(
      detectPageFields(
        page({ lines: [BODY, line([['Adres', 130]], 116, 5)], hlines: [rule(130, 330, 112)] }),
      ),
    ).toEqual([]);
  });

  it('refuses a rule that something stands on or that sits in a drawing', () => {
    const base = { lines: [BODY, line([['Ad:', 50]], 100)], hlines: [rule(130, 330, 112)] };
    expect(ruled(detectPageFields(page(base)))).toHaveLength(1);
    const stands = (parts: Partial<DetectionPage>) => ruled(detectPageFields(page({ ...base, ...parts })));
    const bar: Box = [150, 90, 180, 112];
    expect(stands({ ink: [bar] })).toEqual([]);
    expect(stands({ circles: [{ box: bar, stroked: false, luminance: null }] })).toEqual([]);
    expect(stands({ rects: [{ box: bar, stroked: false, luminance: null }] })).toEqual([]);
    // A thin mark, a short overlap or one that ends above the rule does not count.
    expect(stands({ ink: [[150, 110, 180, 112.5]] })).toHaveLength(1);
    expect(stands({ ink: [[100, 90, 134, 112]] })).toHaveLength(1);
    expect(stands({ ink: [[150, 90, 180, 100]] })).toHaveLength(1);
    const many = (count: number): Box[] =>
      Array.from({ length: count }, (_unused, index) => [200 + index * 3, 80, 202 + index * 3, 82] as Box);
    expect(stands({ ink: many(6) })).toEqual([]);
    expect(stands({ ink: many(5) })).toHaveLength(1);
    const keys = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        box: [
          140 + (index % 5) * 30,
          70 + Math.floor(index / 5) * 4,
          150 + (index % 5) * 30,
          72 + Math.floor(index / 5) * 4,
        ] as Box,
        stroked: false,
        luminance: null,
      }));
    expect(stands({ rects: keys(25) })).toEqual([]);
    expect(stands({ rects: keys(24) })).toHaveLength(1);
  });

  it('takes room from a field for text written above its rule, and drops a field with none left', () => {
    const base = { lines: [BODY, line([['Ad:', 50]], 100)], hlines: [rule(130, 330, 112)] };
    const hinted = ruled(
      detectPageFields(page({ ...base, lines: [...base.lines, line([['ipucu', 200]], 86, 10)] })),
    );
    expect(hinted[0]?.rect[1]).toBe(97);
    expect(summary(hinted)).toEqual([['line', 'Ad:', 'high']]);
    // Text right above the rule leaves a sliver: no field.
    const crowded = ruled(
      detectPageFields(page({ ...base, lines: [...base.lines, line([['ipucu', 200]], 93, 10)] })),
    );
    expect(crowded).toEqual([]);
  });
});

describe('typed blanks as fields', () => {
  const fieldsOf = (lines: DetectLine[]) => detectPageFields(page({ lines: [BODY, ...lines] }));

  it('skips a blank too short to write on, and one with no label to the left or above', () => {
    expect(
      fieldsOf([
        line(
          [
            ['Ad: ', 50],
            ['_____', 80],
          ],
          100,
        ),
      ]).filter((entry) => entry.source === 'blank'),
    ).toEqual([]);
    expect(fieldsOf([line([['________', 130]], 100)])).toEqual([]);
    // The label is further left than a blank looks for it.
    expect(
      fieldsOf([
        line(
          [
            ['Ad', 20],
            ['________', 200],
          ],
          100,
        ),
      ]),
    ).toEqual([]);
  });

  it('names a blank by the label over it at medium confidence and starts the field under that label', () => {
    const found = fieldsOf([line([['Telefon', 130]], 60), line([['________', 130]], 100)]);
    expect(summary(found)).toEqual([['blank', 'Telefon', 'medium']]);
    expect(found[0]?.rect).toEqual([130, 95, 170, 110]);
  });
});

describe('boxes', () => {
  const frame = (box: Box, parts: Partial<DetectionPage> = {}, label = 'Ad Soyad') =>
    detectPageFields(
      page({
        lines: [BODY, line([[label, 50]], box[1] + 3)],
        rects: [outline(box)],
        ...parts,
      }),
    );

  it('turns an empty outlined box into a field, and a tall one into a multi-line field', () => {
    const single = frame([130, 300, 330, 320]);
    expect(summary(single)).toEqual([['box', 'Ad Soyad', 'high']]);
    expect(single[0]).not.toHaveProperty('multiline');
    expect(frame([130, 300, 330, 350])[0]).toMatchObject({ source: 'box', multiline: true });
    expect(frame([130, 300, 330, 338])[0]).not.toHaveProperty('multiline');
  });

  it('turns a lightly shaded box into a field at medium confidence', () => {
    const shade = (luminance: number | null, stroked: boolean) =>
      frame([130, 300, 330, 320], { rects: [{ box: [130, 300, 330, 320], stroked, luminance }] });
    expect(summary(shade(0.9, false))).toEqual([['box', 'Ad Soyad', 'medium']]);
    expect(summary(shade(0.9, true))).toEqual([['box', 'Ad Soyad', 'high']]);
    // A dark fill is a bar, an unfilled shape that is not stroked or a white one is nothing to write in.
    expect(shade(0.5, true)).toEqual([]);
    expect(shade(null, false)).toEqual([]);
    expect(shade(0.99, false)).toEqual([]);
  });

  it('ignores boxes that are too small, too large, in a table or the size of a checkbox', () => {
    expect(frame([130, 300, 150, 320])).toEqual([]);
    expect(frame([130, 300, 330, 308])).toEqual([]);
    expect(frame([130, 300, 330, 470])).toEqual([]);
    expect(frame([10, 300, 580, 320])).toEqual([]);
    expect(frame([130, 300, 330, 320], { tables: [{ box: [100, 280, 400, 340], cells: [] }] })).toEqual([]);
    const small = frame([130, 300, 150, 320]);
    expect(small.filter((entry) => entry.source === 'box')).toEqual([]);
  });

  it('names a box by the label over it when none stands beside it, and skips one with no label', () => {
    const over = detectPageFields(
      page({ lines: [BODY, line([['Adres', 130]], 280)], rects: [outline([130, 300, 330, 320])] }),
    );
    expect(summary(over)).toEqual([['box', 'Adres', 'high']]);
    expect(detectPageFields(page({ lines: [BODY], rects: [outline([130, 300, 330, 320])] }))).toEqual([]);
  });

  it('skips a box that holds drawings, a ruled writing area or sits in a crowd, but not one with a browser’s arrow', () => {
    const inside: Box = [200, 305, 230, 315];
    expect(boxed(frame([130, 300, 330, 320], { ink: [inside] }))).toEqual([]);
    const arrow: Box = [312, 304, 324, 316];
    expect(summary(boxed(frame([130, 300, 330, 320], { ink: [arrow] })))).toEqual([
      ['box', 'Ad Soyad', 'high'],
    ]);
    const three = [304, 310, 316].map((y) => ({ x0: 135, x1: 325, y }));
    expect(boxed(frame([130, 300, 330, 330], { hlines: three }))).toEqual([]);
    const two = three.slice(0, 2);
    expect(summary(boxed(frame([130, 300, 330, 330], { hlines: two })))).toEqual([
      ['box', 'Ad Soyad', 'high'],
    ]);
    const crowd = Array.from(
      { length: 6 },
      (_unused, index) => [100 + index * 4, 340, 102 + index * 4, 342] as Box,
    );
    expect(frame([130, 300, 330, 320], { ink: crowd })).toEqual([]);
  });

  it('reads a frame divided by even ticks as a comb, and uneven or too few ticks as a plain box', () => {
    const ticks = (xs: number[]) => xs.map((x) => ({ x, y0: 300, y1: 320 }));
    const even = frame([130, 300, 330, 320], {
      vlines: ticks([150, 170, 190, 210, 230, 250, 270, 290, 310]),
    });
    expect(even[0]).toMatchObject({ source: 'comb', cells: 10 });
    expect(
      frame([130, 300, 330, 320], { vlines: ticks([150, 160, 190, 210, 230, 250, 270, 290, 310]) })[0],
    ).toMatchObject({
      source: 'box',
    });
    expect(frame([130, 300, 330, 320], { vlines: ticks([180, 230]) })[0]).toMatchObject({ source: 'box' });
    // A tick that does not span the box, or lies on its edge, is not one.
    expect(
      frame([130, 300, 330, 320], { vlines: [{ x: 200, y0: 312, y1: 320 }, ...ticks([131, 329])] })[0],
    ).toMatchObject({
      source: 'box',
    });
  });

  it('draws a box from four lines, once, and not from lines that do not close', () => {
    const lines = (override: Partial<{ right: number; width: number }> = {}) => ({
      hlines: [
        { x0: 130, x1: 330, y: 300 },
        { x0: 130, x1: 330 - (override.width ?? 0), y: 320 },
      ],
      vlines: [
        { x: 130, y0: 300, y1: 320 },
        { x: override.right ?? 330, y0: 300, y1: 320 },
      ],
    });
    const closed = detectPageFields(page({ lines: [BODY, line([['Ad', 50]], 303)], ...lines() }));
    expect(summary(closed)).toEqual([['box', 'Ad', 'high']]);
    expect(closed[0]?.rect).toEqual([130, 300, 330, 320]);
    expect(
      detectPageFields(page({ lines: [BODY, line([['Ad', 50]], 303)], ...lines({ right: 340 }) })).filter(
        (entry) => entry.source === 'box',
      ),
    ).toEqual([]);
    expect(
      detectPageFields(page({ lines: [BODY, line([['Ad', 50]], 303)], ...lines({ width: 10 }) })).filter(
        (entry) => entry.source === 'box',
      ),
    ).toEqual([]);
    // Two rules too close or too far apart are not the two sides of a box.
    const close = {
      hlines: [
        { x0: 130, x1: 330, y: 300 },
        { x0: 130, x1: 330, y: 304 },
      ],
      vlines: lines().vlines,
    };
    expect(
      detectPageFields(page({ lines: [BODY, line([['Ad', 50]], 303)], ...close })).filter(
        (entry) => entry.source === 'box',
      ),
    ).toEqual([]);
    // A rectangle that is also drawn as lines is one box, with the strongest of both descriptions.
    const both = detectPageFields(
      page({
        lines: [BODY, line([['Ad', 50]], 303)],
        ...lines(),
        rects: [{ box: [130.5, 300.5, 330, 320], stroked: false, luminance: 0.9 }],
      }),
    );
    expect(summary(both)).toEqual([['box', 'Ad', 'high']]);
  });

  it('reads touching equal squares as one comb only from four of them, with a label and no text inside', () => {
    const squares = (count: number, gap = 0, size = 14) =>
      Array.from({ length: count }, (_unused, index) =>
        outline([130 + index * (size + gap), 500, 130 + index * (size + gap) + size, 500 + size]),
      );
    const combOf = (rects: ReturnType<typeof squares>, extra: Partial<DetectionPage> = {}) =>
      detectPageFields(page({ lines: [BODY, line([['Kod', 50]], 502)], rects, ...extra })).filter(
        (entry) => entry.source === 'comb',
      );
    expect(combOf(squares(4))[0]).toMatchObject({ cells: 4 });
    expect(combOf(squares(3))).toEqual([]);
    expect(combOf(squares(5, 2))[0]).toMatchObject({ cells: 5 });
    expect(combOf(squares(5, 6))).toEqual([]);
    const uneven = [
      ...squares(2),
      outline([158, 500, 180, 522]),
      ...squares(2).map((shape) => ({
        ...shape,
        box: [shape.box[0] + 60, 500, shape.box[2] + 60, 514] as Box,
      })),
    ];
    expect(combOf(uneven)).toEqual([]);
    // Text inside the comb, or no label for it, drops it.
    expect(combOf(squares(6), { lines: [BODY, line([['Kod', 50]], 502), line([['A', 134]], 502)] })).toEqual(
      [],
    );
    expect(detectPageFields(page({ lines: [BODY], rects: squares(6) }))).toEqual([]);
    const over = detectPageFields(page({ lines: [BODY, line([['Kod', 130]], 480)], rects: squares(6) }));
    expect(summary(over)).toEqual([['comb', 'Kod', 'high']]);
  });
});

/** A ruled table: its rules, the table model and the lines of text its cells hold. */
function grid(x0: number, y0: number, cols: number[], rows: number[], texts: string[][], ruledEdges = true) {
  const xs = [x0];
  for (const w of cols) xs.push((xs[xs.length - 1] as number) + w);
  const ys = [y0];
  for (const h of rows) ys.push((ys[ys.length - 1] as number) + h);
  const cells = rows.flatMap((_h, row) =>
    cols.map((_w, column) => ({
      row,
      column,
      box: [xs[column] as number, ys[row] as number, xs[column + 1] as number, ys[row + 1] as number] as Box,
      text: texts[row]?.[column] ?? '',
    })),
  );
  return {
    hlines: ruledEdges ? ys.map((y) => ({ x0: xs[0] as number, x1: xs[xs.length - 1] as number, y })) : [],
    vlines: ruledEdges ? xs.map((x) => ({ x, y0: ys[0] as number, y1: ys[ys.length - 1] as number })) : [],
    tables: [
      {
        box: [
          xs[0] as number,
          ys[0] as number,
          xs[xs.length - 1] as number,
          ys[ys.length - 1] as number,
        ] as Box,
        cells,
      },
    ],
    lines: cells
      .filter((cell) => cell.text !== '')
      .map((cell) => line([[cell.text, cell.box[0] + 3]], cell.box[1] + 3)),
  };
}

describe('table cells', () => {
  const tableFields = (parts: ReturnType<typeof grid>, extra: Partial<DetectionPage> = {}) =>
    detectPageFields(
      page({
        lines: [BODY, ...parts.lines],
        hlines: parts.hlines,
        vlines: parts.vlines,
        tables: parts.tables,
        ...extra,
      }),
    ).filter((entry) => entry.source === 'cell');

  it('names an empty cell by the filled cell to its left, and a tall one is multi-line', () => {
    const found = tableFields(
      grid(
        100,
        200,
        [100, 200],
        [20, 20, 50],
        [
          ['Ad', ''],
          ['Soyad', ''],
          ['Adres', ''],
        ],
      ),
    );
    const asked = found.filter((entry) => entry.confidence === 'high');
    expect(summary(asked)).toEqual([
      ['cell', 'Ad', 'high'],
      ['cell', 'Soyad', 'high'],
      ['cell', 'Adres', 'high'],
    ]);
    expect(asked[0]?.rect).toEqual([201, 201, 399, 219]);
    expect(asked[0]).not.toHaveProperty('multiline');
    expect(asked[2]).toMatchObject({ multiline: true });
  });

  it('names the empty cells of a grid by the header over their column, from two empty cells up', () => {
    const found = tableFields(grid(100, 200, [80, 80, 80], [20, 20, 20, 20], [['Ürün', 'Adet', 'Fiyat']]));
    expect(found.map((entry) => entry.label)).toEqual([
      'Ürün 1',
      'Adet 1',
      'Fiyat 1',
      'Ürün 2',
      'Adet 2',
      'Fiyat 2',
      'Ürün 3',
      'Adet 3',
      'Fiyat 3',
    ]);
    expect(found.every((entry) => entry.confidence === 'medium')).toBe(true);
    // One empty cell under a header is a hole, not a column.
    expect(tableFields(grid(100, 200, [80, 80], [20, 20], [['Ad', 'Soyad']]))).toEqual([]);
  });

  it('does not take a long or wordy neighbour, a long header or a header that is only a number for a label', () => {
    const wordy = 'bir iki üç dört beş altı yedi sekiz';
    expect(
      tableFields(
        grid(
          100,
          200,
          [100, 200],
          [20, 20],
          [
            [wordy, ''],
            ['Ad', ''],
          ],
        ),
      ),
    ).toMatchObject([{ label: 'Ad' }]);
    expect(tableFields(grid(100, 200, [100, 200], [20], [['x'.repeat(80), '']]))).toEqual([]);
    const header = (text: string) => tableFields(grid(100, 200, [80, 80], [20, 20, 20], [[text, 'Adet']]));
    expect(header('12')).toHaveLength(2);
    expect(header('Başlık '.repeat(8).trim())).toHaveLength(2);
  });

  it('names a cell that holds its own caption over room to write, but not one without room or with a mark in it', () => {
    const captioned = (rowHeight: number, extra: Partial<DetectionPage> = {}) => {
      const parts = grid(100, 200, [200], [rowHeight], [['Adı Soyadı']]);
      return tableFields({ ...parts, lines: [line([['Adı Soyadı', 103]], 203, 8)] }, extra);
    };
    expect(summary(captioned(40))).toEqual([['cell', 'Adı Soyadı', 'medium']]);
    expect(captioned(40)[0]?.rect).toEqual([101.5, 212, 298.5, 238.5]);
    expect(captioned(100)[0]).toMatchObject({ multiline: true });
    expect(captioned(24)).toEqual([]);
    expect(captioned(40, { ink: [[200, 220, 220, 230]] })).toEqual([]);
    expect(captioned(40, { rects: [{ box: [100, 200, 300, 240], stroked: false, luminance: 0.8 }] })).toEqual(
      [],
    );
  });

  it('skips cells that are too small, not ruled on three sides, drawn in, or written on, and tables that are all empty', () => {
    expect(tableFields(grid(100, 200, [100, 20], [20], [['Ad', '']]))).toEqual([]);
    expect(tableFields(grid(100, 200, [100, 200], [8], [['Ad', '']]))).toEqual([]);
    expect(tableFields(grid(100, 200, [100, 200], [20], [['Ad', '']], false))).toEqual([]);
    expect(
      tableFields(grid(100, 200, [100, 200], [20], [['Ad', '']]), { ink: [[220, 205, 240, 215]] }),
    ).toEqual([]);
    const written = grid(100, 200, [100, 200], [20], [['Ad', '']]);
    expect(tableFields({ ...written, lines: [...written.lines, line([['stray', 220]], 205)] })).toEqual([]);
    expect(
      tableFields(
        grid(
          100,
          200,
          [100, 200],
          [20, 20],
          [
            ['', ''],
            ['', ''],
          ],
        ),
      ),
    ).toEqual([]);
  });

  it('keeps no cell of a table with more than eighty to offer, which is a layout and not a form', () => {
    const rows = Array.from({ length: 81 }, () => 10);
    const texts = rows.map((_unused, index) => [`Alan ${index}`, '']);
    expect(tableFields(grid(400, 20, [60, 100], rows, texts))).toEqual([]);
    const fewer = rows.slice(0, 80);
    expect(tableFields(grid(400, 20, [60, 100], fewer, texts.slice(0, 80)))).toHaveLength(80);
  });

  it('ignores a captioned cell that is rule-less, or whose caption is a paragraph', () => {
    const parts = grid(100, 200, [200], [40], [['bir iki üç dört beş altı yedi sekiz']]);
    expect(
      tableFields({ ...parts, lines: [line([[parts.tables[0]?.cells[0]?.text ?? '', 103]], 203, 8)] }),
    ).toEqual([]);
    const loose = grid(100, 200, [200], [40], [['Ad']], false);
    expect(tableFields({ ...loose, lines: [line([['Ad', 103]], 203, 8)] })).toEqual([]);
  });
});

describe('checkboxes', () => {
  const marked = (parts: Partial<DetectionPage>) =>
    detectPageFields(page({ lines: [BODY], ...parts })).filter((entry) => entry.kind === 'checkbox');
  const square: Box = [50, 200, 60, 210];
  const withLabel = (extra: Partial<DetectionPage> = {}) =>
    marked({ lines: [BODY, line([['Kabul', 66]], 199)], rects: [outline(square)], ...extra });

  it('finds the label to the right of a square first and to its left when nothing is on the right', () => {
    expect(withLabel()).toMatchObject([{ label: 'Kabul' }]);
    const left = marked({ lines: [BODY, line([['Kabul', 15]], 199)], rects: [outline(square)] });
    expect(left).toMatchObject([{ label: 'Kabul', source: 'square' }]);
    const both = marked({
      lines: [BODY, line([['Sol', 25]], 199), line([['Sağ', 66]], 199), line([['Daha sağ', 90]], 199)],
      rects: [outline(square)],
    });
    expect(both[0]?.label).toBe('Sağ');
    const leftBoth = marked({
      lines: [BODY, line([['ab', 29]], 199), line([['cd', 41]], 199)],
      rects: [outline(square)],
    });
    expect(leftBoth[0]?.label).toBe('cd');
    // Beside a square means on its row, and not a sentence.
    expect(marked({ lines: [BODY, line([['Kabul', 66]], 150)], rects: [outline(square)] })).toEqual([]);
    expect(
      marked({
        lines: [
          BODY,
          line(
            [
              [
                'bir iki üç dört beş altı yedi sekiz dokuz on on bir on iki on üç on dört on beş on altı on yedi on sekiz on dokuz',
                66,
              ],
            ],
            199,
          ),
        ],
        rects: [outline(square)],
      }),
    ).toEqual([]);
    expect(marked({ rects: [outline(square)] })).toEqual([]);
  });

  it('skips squares that are the wrong size or shape, dark, empty of paint, a comb cell or drawn in', () => {
    expect(withLabel({ rects: [outline([50, 200, 54, 204])] })).toEqual([]);
    expect(withLabel({ rects: [outline([50, 200, 75, 225])] })).toEqual([]);
    expect(withLabel({ rects: [outline([50, 200, 70, 208])] })).toEqual([]);
    expect(withLabel({ rects: [{ box: square, stroked: true, luminance: 0.3 }] })).toEqual([]);
    expect(withLabel({ rects: [{ box: square, stroked: false, luminance: null }] })).toEqual([]);
    expect(withLabel({ rects: [{ box: square, stroked: false, luminance: 0.99 }] })).toEqual([]);
    expect(withLabel({ rects: [{ box: square, stroked: false, luminance: 0.9 }] })).toHaveLength(1);
    expect(withLabel({ ink: [[52, 202, 58, 208]] })).toEqual([]);
    expect(withLabel({ lines: [BODY, line([['Kabul', 66]], 199), line([['x', 52]], 200)] })).toEqual([]);
    // Lettering over a key: text overlapping a quarter of the square.
    expect(withLabel({ lines: [BODY, line([['Kabul', 66]], 199), line([['xx', 54]], 205)] })).toEqual([]);
    const crowd = Array.from(
      { length: 6 },
      (_unused, index) => [20 + index * 3, 230, 22 + index * 3, 232] as Box,
    );
    expect(withLabel({ ink: crowd })).toEqual([]);
    const row = Array.from({ length: 4 }, (_unused, index) =>
      outline([50 + index * 10, 200, 60 + index * 10, 210]),
    );
    expect(marked({ lines: [BODY, line([['Kabul', 96]], 199)], rects: row })).toEqual([]);
  });

  it('reads a typed box glyph as a checkbox with the label after it', () => {
    const typed = marked({
      lines: [
        BODY,
        line(
          [
            ['☐', 50],
            ['Kabul', 62],
          ],
          200,
        ),
      ],
    });
    expect(typed).toMatchObject([{ label: 'Kabul', source: 'glyph', confidence: 'high' }]);
    expect((typed[0]?.rect[2] ?? 0) - (typed[0]?.rect[0] ?? 0)).toBe(8);
    // A large glyph is drawn at most 16 points wide; a lone glyph has no label.
    const large = marked({
      lines: [
        BODY,
        line(
          [
            ['☐', 50],
            ['Kabul', 80],
          ],
          200,
          40,
        ),
      ],
    });
    expect((large[0]?.rect[2] ?? 0) - (large[0]?.rect[0] ?? 0)).toBe(16);
    expect(marked({ lines: [BODY, line([['☐', 50]], 200)] })).toEqual([]);
  });
});

describe('radio buttons', () => {
  const dot = (x: number, y: number): Box => [x, y, x + 10, y + 10];
  const radios = (parts: Partial<DetectionPage>) =>
    detectPageFields(page({ lines: [BODY], ...parts })).filter((entry) => entry.kind === 'radio');

  it('groups circles listed in a column and names the group by the question above them', () => {
    const found = radios({
      lines: [
        BODY,
        line([['Cinsiyet', 98]], 270),
        line([['Kadın', 114]], 299),
        line([['Erkek', 114]], 319),
        line([['Diğer', 114]], 339),
      ],
      circles: [outline(dot(100, 300)), outline(dot(100, 320)), outline(dot(100, 340))],
    });
    expect(found.map((entry) => [entry.option, entry.label, entry.group, entry.confidence])).toEqual([
      ['Kadın', 'Cinsiyet', 'radio-0', 'high'],
      ['Erkek', 'Cinsiyet', 'radio-0', 'high'],
      ['Diğer', 'Cinsiyet', 'radio-0', 'high'],
    ]);
  });

  it('names a group by nothing at medium confidence, and keeps two groups apart', () => {
    const found = radios({
      lines: [
        BODY,
        line([['Evet', 114]], 299),
        line([['Hayır', 164]], 299),
        line([['Var', 114]], 399),
        line([['Yok', 164]], 399),
      ],
      circles: [
        outline(dot(100, 300)),
        outline(dot(150, 300)),
        outline(dot(100, 400)),
        outline(dot(150, 400)),
      ],
    });
    expect(found.map((entry) => [entry.option, entry.label, entry.group, entry.confidence])).toEqual([
      ['Evet', '', 'radio-0', 'medium'],
      ['Hayır', '', 'radio-0', 'medium'],
      ['Var', '', 'radio-1', 'medium'],
      ['Yok', '', 'radio-1', 'medium'],
    ]);
  });

  it('does not chain circles that are too far apart, out of line or without a label beside them', () => {
    const lines = [
      BODY,
      line([['Evet', 114]], 299),
      line([['Hayır', 264]], 299),
      line([['Belki', 114]], 399),
    ];
    // 150 pt apart: more than a row's reach.
    expect(radios({ lines, circles: [outline(dot(100, 300)), outline(dot(250, 300))] })).toEqual([]);
    // Same column but 90 pt apart, and one on another row.
    expect(radios({ lines, circles: [outline(dot(100, 300)), outline(dot(100, 400))] })).toEqual([]);
    expect(radios({ lines, circles: [outline(dot(100, 300)), outline(dot(150, 312))] })).toEqual([]);
    // A circle with nothing beside it cannot be told from decoration.
    expect(
      radios({
        lines: [BODY, line([['Evet', 114]], 299)],
        circles: [outline(dot(100, 300)), outline(dot(150, 300))],
      }),
    ).toEqual([]);
  });

  it('skips circles that are dark, empty of paint, drawn in, lettered over or in a crowd, and the wrong size', () => {
    const lines = [BODY, line([['Evet', 114]], 299), line([['Hayır', 164]], 299)];
    const pair = (
      second: Parameters<typeof outline>[0] | { box: Box; stroked: boolean; luminance: number | null },
    ) => [outline(dot(100, 300)), 'stroked' in second ? second : outline(second)];
    const withSecond = (
      shape: { box: Box; stroked: boolean; luminance: number | null },
      extra: Partial<DetectionPage> = {},
    ) => radios({ lines, circles: pair(shape), ...extra });
    const second = dot(150, 300);
    expect(withSecond({ box: second, stroked: true, luminance: 0.3 })).toEqual([]);
    expect(withSecond({ box: second, stroked: false, luminance: null })).toEqual([]);
    expect(withSecond({ box: second, stroked: false, luminance: 0.99 })).toEqual([]);
    expect(withSecond({ box: second, stroked: false, luminance: 0.9 })).toHaveLength(2);
    expect(
      withSecond({
        box: dot(150, 300).map((v, i) => (i > 1 ? v - 6 : v)) as unknown as Box,
        stroked: true,
        luminance: null,
      }),
    ).toEqual([]);
    expect(withSecond({ box: [150, 300, 190, 340], stroked: true, luminance: null })).toEqual([]);
    expect(withSecond({ box: [150, 300, 170, 308], stroked: true, luminance: null })).toEqual([]);
    expect(
      withSecond({ box: second, stroked: true, luminance: null }, { ink: [[153, 303, 157, 307]] }),
    ).toEqual([]);
    expect(
      withSecond(
        { box: second, stroked: true, luminance: null },
        { lines: [...lines, line([['x', 152]], 301)] },
      ),
    ).toEqual([]);
    const crowd = Array.from(
      { length: 6 },
      (_unused, index) => [150 + index * 3, 330, 152 + index * 3, 332] as Box,
    );
    expect(withSecond({ box: second, stroked: true, luminance: null }, { ink: crowd })).toEqual([]);
  });

  it('reads ○ glyphs as circles', () => {
    const found = radios({
      lines: [
        BODY,
        line(
          [
            ['○', 100],
            ['Evet', 112],
            ['○', 160],
            ['Hayır', 172],
          ],
          300,
        ),
      ],
    });
    expect(found.map((entry) => [entry.option, entry.source])).toEqual([
      ['Evet', 'glyph'],
      ['Hayır', 'glyph'],
    ]);
  });
});

describe('labels that end in a colon', () => {
  const colons = (lines: DetectLine[], extra: Partial<DetectionPage> = {}) =>
    detectPageFields(page({ lines: [BODY, ...lines], ...extra })).filter((entry) => entry.source === 'colon');

  it('leaves room for an answer to the end of the line, or up to the next text on the row', () => {
    const open = colons([line([['Ad Soyad:', 50]], 100)]);
    expect(open).toMatchObject([{ label: 'Ad Soyad:', confidence: 'medium', kind: 'text' }]);
    expect(open[0]?.rect).toEqual([99, 99, 559, 111]);
    const next = colons([
      line(
        [
          ['Ad Soyad:', 50],
          ['Telefon:', 300],
        ],
        100,
      ),
    ]);
    expect(next.map((entry) => [entry.label, entry.rect[2]])).toEqual([
      ['Ad Soyad:', 294],
      ['Telefon:', 559],
    ]);
    // The nearest text to the right limits the answer, not the one that is further.
    const near = colons([
      line(
        [
          ['Ad:', 50],
          ['Yakın', 200],
          ['Uzak', 400],
        ],
        100,
      ),
    ]);
    expect(near[0]?.rect[2]).toBe(194);
  });

  it('asks for room, a short label that is a name, and not the end of a paragraph', () => {
    expect(
      colons([
        line(
          [
            ['Ad:', 50],
            ['Yakın', 80],
          ],
          100,
        ),
      ]),
    ).toEqual([]);
    expect(colons([line([['Çok uzun bir etiket burada bitiyor:', 50]], 100)])).toEqual([]);
    expect(colons([line([['bir iki üç dört beş:', 50]], 100)])).toEqual([]);
    expect(colons([line([['12:', 50]], 100)])).toEqual([]);
    const paragraph = [
      line([['Aşağıdaki alanları eksiksiz doldurunuz ve', 50]], 80),
      line([['dikkat ediniz:', 50]], 92),
    ];
    expect(colons(paragraph)).toEqual([]);
    // A line far below the sentence is a label of its own.
    expect(
      colons([
        line([['Aşağıdaki alanları eksiksiz doldurunuz ve', 50]], 40),
        line([['dikkat ediniz:', 50]], 92),
      ]),
    ).toHaveLength(1);
  });
});

describe('the page as a whole', () => {
  it('lets the stronger mark win where two fields overlap, and keeps fields that merely touch', () => {
    const found = detectPageFields(
      page({
        lines: [BODY, line([['Kabul', 70]], 199)],
        rects: [outline([50, 200, 60, 210])],
        hlines: [rule(40, 200, 211)],
      }),
    );
    expect(found.map((entry) => entry.source)).toEqual(['square']);
    const apart = detectPageFields(
      page({
        lines: [BODY, line([['Ad:', 50]], 100), line([['Soyad:', 50]], 140)],
        hlines: [rule(130, 330, 112), rule(130, 330, 152)],
      }),
    ).filter((entry) => entry.source === 'line');
    expect(apart).toHaveLength(2);
  });

  it('drops fields from lettering far smaller than the page’s text and those outside the page', () => {
    expect(
      detectPageFields(page({ lines: [BODY, line([['Ad:', 50]], 100, 4)], hlines: [rule(130, 330, 112)] })),
    ).toEqual([]);
    const narrow = detectPageFields(
      page({ width: 300, lines: [BODY, line([['Ad:', 50]], 100)], hlines: [rule(130, 330, 112)] }),
    ).filter((entry) => entry.source === 'line');
    expect(narrow).toEqual([]);
    const high = detectPageFields(
      page({ lines: [BODY, line([['Ad:', 50]], -5)], hlines: [rule(130, 330, 7)] }),
    ).filter((entry) => entry.source === 'line');
    expect(high).toEqual([]);
  });
});

describe('the nearest label wins whatever the order of the text', () => {
  it('keeps the nearer label to the left, above and below when a farther one comes after it', () => {
    const left = detectPageFields(
      page({
        lines: [BODY, line([['Yakın', 70]], 100), line([['Uzak', 10]], 100)],
        hlines: [rule(130, 330, 112)],
      }),
    ).filter((entry) => entry.source === 'line');
    expect(left[0]?.label).toBe('Yakın');
    const above = detectPageFields(
      page({
        lines: [BODY, line([['Yakın', 130]], 90), line([['Uzak', 130]], 80)],
        hlines: [rule(130, 330, 112)],
      }),
    );
    expect(above[0]?.label).toBe('Yakın');
    const below = detectPageFields(
      page({
        lines: [BODY, line([['Yakın', 130]], 115), line([['Uzak', 130]], 124)],
        hlines: [rule(130, 330, 112)],
      }),
    );
    expect(below[0]?.label).toBe('Yakın');
    const beside = detectPageFields(
      page({
        lines: [BODY, line([['Sağ', 62]], 199), line([['Başka', 70]], 199)],
        rects: [outline([50, 200, 60, 210])],
      }),
    ).filter((entry) => entry.kind === 'checkbox');
    expect(beside[0]?.label).toBe('Sağ');
  });
});

describe('rules split by text, and rects drawn twice', () => {
  it('joins pieces of a rule that share a y, and keeps a span whole when text starts before or ends after it', () => {
    const pieces = detectPageFields(
      page({
        lines: [BODY, line([['Ad:', 50]], 100)],
        hlines: [rule(230, 330, 112), rule(130, 232, 112)],
      }),
    ).filter((entry) => entry.source === 'line');
    expect(pieces[0]?.rect[0]).toBe(130);
    expect(pieces[0]?.rect[2]).toBe(330);

    // Text that starts before the rule and text that ends after it leave the middle.
    const edges = detectPageFields(
      page({
        lines: [
          BODY,
          line([['Ad:', 50]], 100),
          line([['başında', 112]], 100),
          line([['sonunda:', 320]], 100),
        ],
        hlines: [rule(130, 350, 112)],
      }),
    ).filter((entry) => entry.source === 'line');
    expect(edges.map((entry) => entry.label)).toEqual(['başında']);
    // Two words on the rule leave three pieces; the one after a word that asks for nothing is not a field.
    const two = detectPageFields(
      page({
        lines: [BODY, line([['Ad:', 50]], 100), line([['bir', 300]], 100), line([['iki:', 200]], 100)],
        hlines: [rule(130, 400, 112)],
      }),
    ).filter((entry) => entry.source === 'line');
    expect(two.map((entry) => entry.label)).toEqual(['Ad:', 'iki:']);
  });

  it('merges a rectangle drawn twice, keeping the fill of whichever drawing had one', () => {
    const found = detectPageFields(
      page({
        lines: [BODY, line([['Ad', 50]], 303)],
        rects: [
          { box: [130, 300, 330, 320], stroked: false, luminance: null },
          { box: [130.4, 300.4, 330, 320], stroked: false, luminance: 0.9 },
        ],
      }),
    );
    expect(summary(found)).toEqual([['box', 'Ad', 'medium']]);
  });
});

describe('boxes that carry text', () => {
  const inFrame = (parts: Partial<DetectionPage>, box: Box = [100, 400, 300, 440]) =>
    detectPageFields(page({ lines: [BODY], rects: [outline(box)], ...parts })).filter(
      (entry) => entry.source === 'cell' || entry.source === 'box',
    );

  it('names a frame by its caption and leaves the free part under it as the field', () => {
    const found = inFrame({ lines: [BODY, line([['Adı Soyadı', 105]], 403, 8)] });
    expect(summary(found)).toEqual([['cell', 'Adı Soyadı', 'medium']]);
    expect(found[0]?.rect).toEqual([101.5, 412, 298.5, 438.5]);
    expect(
      inFrame({ lines: [BODY, line([['Adı Soyadı', 105]], 403, 8)] }, [100, 400, 300, 490])[0],
    ).toMatchObject({
      multiline: true,
    });
  });

  it('leaves a frame with text alone when the text is not a caption over room', () => {
    const caption = (top: number, size = 8) => line([['Adı Soyadı', 105]], top, size);
    // Shaded (not outlined) frames are not captioned boxes.
    expect(
      inFrame({
        lines: [BODY, caption(403)],
        rects: [{ box: [100, 400, 300, 440], stroked: false, luminance: 0.9 }],
      }),
    ).toEqual([]);
    // A caption low in the frame, a frame with no room under it, text that is three runs, a glyph only.
    expect(inFrame({ lines: [BODY, caption(425)] })).toEqual([]);
    expect(inFrame({ lines: [BODY, caption(403, 20)] }, [100, 400, 300, 450])).toEqual([]);
    expect(inFrame({ lines: [BODY, caption(403), caption(414), caption(425)] })).toEqual([]);
    expect(inFrame({ lines: [BODY, line([['☐', 150]], 410)] })).toEqual([]);
    // A frame too small for a caption and an answer.
    expect(inFrame({ lines: [BODY, caption(403)] }, [100, 400, 300, 420])).toEqual([]);
  });
});

describe('typed box glyphs inside boxes, paragraphs ending in a colon, scans', () => {
  it('reads a scan’s rules as medium confidence and leaves its boxes as they were', () => {
    const scan = detectPageFields(
      page({
        raster: true,
        lines: [BODY, line([['Ad Soyad', 50]], 303)],
        rects: [outline([130, 300, 330, 320])],
      }),
    );
    expect(summary(scan)).toEqual([['box', 'Ad Soyad', 'high']]);
  });

  it('does not answer a colon that ends a paragraph whose lines are set a little apart', () => {
    const paragraph = [
      line([['Aşağıdaki alanları eksiksiz doldurunuz ve', 50]], 80),
      line([['dikkat ediniz:', 50]], 98),
    ];
    expect(
      detectPageFields(page({ lines: [BODY, ...paragraph] })).filter((entry) => entry.source === 'colon'),
    ).toEqual([]);
  });
});
