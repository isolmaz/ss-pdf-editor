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
