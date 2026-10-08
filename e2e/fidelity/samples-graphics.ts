/**
 * The graphics-heavy fidelity pages: geometry, charts, pictures that carry text, translucent
 * overlays, rotated text, a scan-and-vector mix, a slide and an invoice. Same rules as `samples.ts`:
 * generated in code, Turkish text with diacritics in embedded Noto Sans, drawn in reading order,
 * nothing random or dated (the "noise" in pictures comes from an integer hash).
 *
 * Every function here draws one sample onto a fresh `SamplePdf`; `samples.ts` registers them.
 * A function returns the text that lives only inside a picture (`imageText`), when there is any.
 */

import {
  A4,
  extractPageTexts,
  type MuPixmap,
  type PageBuilder,
  type PathStep,
  type Rgb,
  renderPageToPixmap,
  SamplePdf,
  type ScanDefects,
} from './sample-builder';

const INK: Rgb = [33, 37, 41];
const MUTED: Rgb = [96, 104, 112];
const WHITE: Rgb = [255, 255, 255];
const NAVY: Rgb = [24, 54, 94];
const TEAL: Rgb = [0, 122, 135];
const ORANGE: Rgb = [234, 120, 36];
const RED: Rgb = [196, 32, 38];
const GOLD: Rgb = [240, 188, 40];
const GREEN: Rgb = [46, 140, 84];
const PALE: Rgb = [226, 236, 248];
const RULE: Rgb = [170, 178, 190];

/** Turkish number formatting: `.` between thousands, `,` before decimals. */
function formatTurkish(value: number, decimals = 0): string {
  const [whole = '0', fraction] = value.toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}

/** An integer hash in 0…1: the repeatable "noise" of generated pictures. */
function hash01(x: number, y: number, salt = 0): number {
  let h =
    Math.imul(x + 374761393, 668265263) ^
    Math.imul(y + 1274126177, 2246822519) ^
    Math.imul(salt + 1, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A page title and a one-line subtitle in the common style. */
function heading(page: PageBuilder, title: string, subtitle: string): void {
  page.text(40, 56, 22, 'bold', NAVY, title);
  page.text(40, 76, 10.5, 'regular', MUTED, subtitle);
}

/** A small section label with a rule to its right edge. */
function sectionLabel(page: PageBuilder, x: number, y: number, width: number, text: string): void {
  page.text(x, y, 11, 'semibold', TEAL, text);
  page.line(x, y + 5, x + width, y + 5, { stroke: RULE, lineWidth: 0.6 });
}

/** Bézier steps for the arc of a circle from angle `a0` to `a1` (radians, y-down page space), without the leading move. */
function arcSteps(cx: number, cy: number, radius: number, a0: number, a1: number): PathStep[] {
  const steps: PathStep[] = [];
  const pieces = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const delta = (a1 - a0) / pieces;
  const k = (4 / 3) * Math.tan(delta / 4);
  for (let index = 0; index < pieces; index += 1) {
    const s = a0 + delta * index;
    const e = s + delta;
    steps.push([
      'C',
      cx + radius * (Math.cos(s) - k * Math.sin(s)),
      cy + radius * (Math.sin(s) + k * Math.cos(s)),
      cx + radius * (Math.cos(e) + k * Math.sin(e)),
      cy + radius * (Math.sin(e) - k * Math.cos(e)),
      cx + radius * Math.cos(e),
      cy + radius * Math.sin(e),
    ]);
  }
  return steps;
}

/** A pie wedge from `a0` to `a1` around `(cx, cy)`. */
function wedge(
  page: PageBuilder,
  cx: number,
  cy: number,
  radius: number,
  a0: number,
  a1: number,
  fill: Rgb,
): void {
  page.path(
    [
      ['M', cx, cy],
      ['L', cx + radius * Math.cos(a0), cy + radius * Math.sin(a0)],
      ...arcSteps(cx, cy, radius, a0, a1),
      ['Z'],
    ],
    { fill, stroke: WHITE, lineWidth: 1.5 },
  );
}

/** A line with an arrowhead at its end (and at its start when `both`). */
function arrow(
  page: PageBuilder,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: Rgb,
  width = 2,
  both = false,
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 5 + width * 1.6;
  const tip = (x: number, y: number, direction: number): void => {
    page.polygon(
      [
        [x, y],
        [x - head * Math.cos(direction - 0.45), y - head * Math.sin(direction - 0.45)],
        [x - head * Math.cos(direction + 0.45), y - head * Math.sin(direction + 0.45)],
      ],
      { fill: color },
    );
  };
  const pull = head * 0.7;
  page.line(
    both ? x1 + pull * Math.cos(angle) : x1,
    both ? y1 + pull * Math.sin(angle) : y1,
    x2 - pull * Math.cos(angle),
    y2 - pull * Math.sin(angle),
    { stroke: color, lineWidth: width },
  );
  tip(x2, y2, angle);
  if (both) tip(x1, y1, angle + Math.PI);
}

/** The point `(dx, dy)` away from `(cx, cy)`, turned counter-clockwise on the page by `degrees`. */
function turned(cx: number, cy: number, dx: number, dy: number, degrees: number): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [cx + dx * Math.cos(a) + dy * Math.sin(a), cy - dx * Math.sin(a) + dy * Math.cos(a)];
}

// ---------------------------------------------------------------------------
// 1. shapes
// ---------------------------------------------------------------------------

/**
 * Geometry: filled and stroked circles and ellipses, a triangle, hexagon, star and diamond,
 * arrows, a Bézier curve with its handles, dashed / dotted / thick lines, rounded rectangles,
 * nested shapes, an even-odd hole, labels inside shapes and a small flow diagram.
 */
export function buildShapes(pdf: SamplePdf): void {
  const page = pdf.addPage();
  heading(
    page,
    'Şekiller ve Geometri',
    'Daireler, çokgenler, oklar, eğriler, çizgi türleri ve bir akış şeması',
  );

  sectionLabel(page, 40, 108, 515.28, 'Daire ve elips');
  page.circle(80, 166, 40, { fill: TEAL });
  page.textCentered(80, 170, 12, 'bold', WHITE, 'Daire');
  page.circle(190, 166, 40, { stroke: NAVY, lineWidth: 3 });
  page.textCentered(190, 170, 12, 'bold', NAVY, 'Çember');
  page.ellipse(320, 166, 55, 32, { fill: ORANGE });
  page.textCentered(320, 170, 12, 'bold', WHITE, 'Elips');
  page.ellipse(465, 166, 55, 32, { stroke: RED, lineWidth: 2, dash: [6, 4] });
  page.textCentered(465, 170, 11, 'semibold', RED, 'Kesikli elips');

  sectionLabel(page, 40, 240, 515.28, 'Çokgenler');
  page.polygon(
    [
      [90, 258],
      [138, 338],
      [42, 338],
    ],
    { fill: GREEN },
  );
  page.textCentered(90, 330, 11, 'bold', WHITE, 'Üçgen');
  page.polygon(
    Array.from({ length: 6 }, (_, index): [number, number] => [
      250 + 44 * Math.cos((index * Math.PI) / 3),
      298 + 44 * Math.sin((index * Math.PI) / 3),
    ]),
    { fill: NAVY },
  );
  page.textCentered(250, 302, 12, 'bold', WHITE, 'Altıgen');
  page.polygon(
    Array.from({ length: 10 }, (_, index): [number, number] => {
      const radius = index % 2 === 0 ? 46 : 19;
      const angle = -Math.PI / 2 + (index * Math.PI) / 5;
      return [400 + radius * Math.cos(angle), 298 + radius * Math.sin(angle)];
    }),
    { fill: GOLD, stroke: [160, 110, 0], lineWidth: 1.5 },
  );
  page.textCentered(400, 303, 8.5, 'bold', INK, 'Yıldız');
  page.polygon(
    [
      [520, 256],
      [565, 298],
      [520, 340],
      [475, 298],
    ],
    { fill: PALE, stroke: NAVY, lineWidth: 1.5 },
  );
  page.textCentered(520, 302, 11, 'semibold', NAVY, 'Baklava');

  sectionLabel(page, 40, 372, 515.28, 'Oklar ve eğriler');
  page.text(40, 398, 10, 'regular', INK, 'Sağ ok');
  arrow(page, 40, 412, 150, 412, NAVY, 3);
  page.text(190, 398, 10, 'regular', INK, 'Çift yönlü');
  arrow(page, 190, 412, 300, 412, TEAL, 2.5, true);
  page.text(340, 458, 10, 'regular', INK, 'Çapraz ok');
  arrow(page, 340, 446, 420, 396, RED, 2.5);
  page.path(
    [
      ['M', 450, 440],
      ['C', 480, 380, 520, 500, 555, 420],
    ],
    { stroke: ORANGE, lineWidth: 2.5 },
  );
  page.line(450, 440, 480, 380, { stroke: MUTED, lineWidth: 0.6, dash: [2, 2] });
  page.line(555, 420, 520, 500, { stroke: MUTED, lineWidth: 0.6, dash: [2, 2] });
  for (const [x, y] of [
    [480, 380],
    [520, 500],
  ] as const) {
    page.circle(x, y, 2.5, { fill: MUTED });
  }
  page.text(450, 470, 10, 'regular', INK, 'Bézier eğrisi');

  sectionLabel(page, 40, 488, 515.28, 'Çizgi türleri');
  const lines: readonly (readonly [
    string,
    number,
    number,
    readonly [number, number] | undefined,
    'round' | undefined,
  ])[] = [
    ['Düz çizgi', 512, 1.2, undefined, undefined],
    ['Kesikli çizgi', 530, 1.5, [8, 5], undefined],
    ['Noktalı çizgi', 548, 2.5, [0.1, 6], 'round'],
    ['Kalın çizgi', 566, 6, undefined, undefined],
  ];
  for (const [label, y, lineWidth, dash, cap] of lines) {
    page.line(40, y, 300, y, {
      stroke: NAVY,
      lineWidth,
      ...(dash === undefined ? {} : { dash }),
      ...(cap === undefined ? {} : { cap }),
    });
    page.text(320, y + 4, 10.5, 'regular', INK, label);
  }

  sectionLabel(page, 40, 596, 515.28, 'Yuvarlak köşeler, iç içe şekiller ve delik');
  page.roundRect(40, 612, 120, 70, 16, { fill: PALE, stroke: NAVY, lineWidth: 1.5 });
  page.textCentered(100, 652, 11, 'semibold', NAVY, 'Yuvarlak köşe');
  page.rect(180, 612, 130, 80, { fill: [236, 238, 242], stroke: MUTED, lineWidth: 1 });
  page.circle(245, 652, 30, { fill: ORANGE });
  page.rect(230, 637, 30, 30, { fill: WHITE });
  page.textCentered(245, 656, 9, 'bold', ORANGE, 'iç');
  page.text(180, 706, 10, 'regular', INK, 'İç içe şekiller');
  page.rect(330, 612, 100, 80, { fill: [250, 214, 214] });
  page.path(
    [
      ['M', 340, 618],
      ['L', 420, 618],
      ['L', 420, 686],
      ['L', 340, 686],
      ['Z'],
      ['M', 402, 652],
      ...arcSteps(380, 652, 22, 0, Math.PI * 2),
      ['Z'],
    ],
    { fill: NAVY, evenOdd: true },
  );
  page.text(330, 706, 10, 'regular', INK, 'Delikli şekil');
  page.roundRect(450, 625, 105, 44, 22, { fill: TEAL });
  page.textCentered(502, 652, 12, 'bold', WHITE, 'Hap şekli');

  sectionLabel(page, 40, 728, 515.28, 'Akış şeması');
  page.roundRect(40, 760, 64, 34, 17, { fill: GREEN });
  page.textCentered(72, 782, 11, 'bold', WHITE, 'Başla');
  arrow(page, 104, 777, 128, 777, INK, 1.5);
  page.rect(128, 760, 88, 34, { fill: PALE, stroke: NAVY, lineWidth: 1.2 });
  page.textCentered(172, 782, 11, 'regular', INK, 'Veriyi oku');
  arrow(page, 216, 777, 240, 777, INK, 1.5);
  page.polygon(
    [
      [290, 749],
      [340, 777],
      [290, 805],
      [240, 777],
    ],
    { fill: [255, 243, 205], stroke: [160, 110, 0], lineWidth: 1.2 },
  );
  page.textCentered(290, 781, 10, 'semibold', INK, 'Geçerli mi?');
  arrow(page, 340, 777, 372, 777, INK, 1.5);
  page.text(344, 771, 9, 'italic', MUTED, 'Evet');
  page.rect(372, 760, 68, 34, { fill: PALE, stroke: NAVY, lineWidth: 1.2 });
  page.textCentered(406, 782, 11, 'regular', INK, 'Kaydet');
  arrow(page, 440, 777, 484, 777, INK, 1.5);
  page.roundRect(484, 760, 70, 34, 17, { fill: RED });
  page.textCentered(519, 782, 11, 'bold', WHITE, 'Bitir');
  page.line(290, 805, 290, 824, { stroke: INK, lineWidth: 1.5 });
  page.line(290, 824, 172, 824, { stroke: INK, lineWidth: 1.5 });
  arrow(page, 172, 824, 172, 794, INK, 1.5);
  page.text(298, 820, 9, 'italic', MUTED, 'Hayır');
}

// ---------------------------------------------------------------------------
// 2. chart
// ---------------------------------------------------------------------------

/** Pie, grouped bar and line charts with axes, ticks, gridlines, axis titles and legends; all text real. */
export function buildChart(pdf: SamplePdf): void {
  const page = pdf.addPage();
  heading(page, 'Üç Aylık Satış Raporu', 'Ürün dağılımı, çeyreklik satışlar ve aylık ziyaretçi sayısı');
  const colors: readonly Rgb[] = [NAVY, TEAL, ORANGE, [150, 90, 170]];

  // pie with wedge labels, percentages and a legend
  page.text(40, 108, 12, 'semibold', INK, 'Ürün Dağılımı');
  const slices: readonly (readonly [string, number])[] = [
    ['Ürün A', 35],
    ['Ürün B', 25],
    ['Ürün C', 22],
    ['Diğer', 18],
  ];
  const cx = 170;
  const cy = 200;
  const radius = 72;
  let angle = -Math.PI / 2;
  for (const [index, [name, share]] of slices.entries()) {
    const sweep = (share / 100) * Math.PI * 2;
    wedge(page, cx, cy, radius, angle, angle + sweep, colors[index] ?? NAVY);
    const mid = angle + sweep / 2;
    page.textCentered(
      cx + radius * 0.62 * Math.cos(mid),
      cy + radius * 0.62 * Math.sin(mid) + 4,
      11,
      'bold',
      WHITE,
      `%${share}`,
    );
    const lx = cx + (radius + 10) * Math.cos(mid);
    const ly = cy + (radius + 10) * Math.sin(mid) + 4;
    if (Math.cos(mid) >= 0) page.text(lx, ly, 10, 'regular', INK, name);
    else page.textRight(lx, ly, 10, 'regular', INK, name);
    angle += sweep;
  }
  page.text(330, 150, 11, 'semibold', INK, 'Gösterge');
  for (const [index, [name, share]] of slices.entries()) {
    const y = 168 + index * 22;
    page.rect(330, y - 9, 12, 12, { fill: colors[index] ?? NAVY });
    page.text(350, y, 10.5, 'regular', INK, `${name}: %${share}`);
  }

  // grouped bars
  const plotLeft = 84;
  const plotRight = 545;
  const barTop = 352;
  const barBottom = 540;
  page.text(40, 318, 12, 'semibold', INK, 'Çeyreklik Satışlar');
  const series: readonly (readonly [string, readonly number[]])[] = [
    ['Ürün A', [42, 55, 61, 78]],
    ['Ürün B', [30, 38, 52, 60]],
    ['Ürün C', [18, 27, 33, 45]],
  ];
  for (const [index, [name]] of series.entries()) {
    const x = 350 + index * 66;
    page.rect(x, 322, 10, 10, { fill: colors[index] ?? NAVY });
    page.text(x + 14, 331, 9.5, 'regular', INK, name);
  }
  for (let tick = 0; tick <= 100; tick += 20) {
    const y = barBottom - ((barBottom - barTop) * tick) / 100;
    page.line(plotLeft, y, plotRight, y, {
      stroke: tick === 0 ? INK : [214, 218, 224],
      lineWidth: tick === 0 ? 1 : 0.6,
    });
    page.textRight(plotLeft - 6, y + 3.5, 9, 'regular', MUTED, String(tick));
  }
  page.line(plotLeft, barTop, plotLeft, barBottom, { stroke: INK, lineWidth: 1 });
  const quarters = ['1. Çeyrek', '2. Çeyrek', '3. Çeyrek', '4. Çeyrek'];
  const groupWidth = (plotRight - plotLeft) / quarters.length;
  for (const [quarter, label] of quarters.entries()) {
    const groupX = plotLeft + groupWidth * quarter;
    for (const [index, [, values]] of series.entries()) {
      const value = values[quarter] ?? 0;
      const height = ((barBottom - barTop) * value) / 100;
      const x = groupX + 22 + index * 30;
      page.rect(x, barBottom - height, 24, height, { fill: colors[index] ?? NAVY });
      page.textCentered(x + 12, barBottom - height - 4, 8, 'regular', INK, String(value));
    }
    page.textCentered(groupX + groupWidth / 2, barBottom + 15, 9.5, 'regular', INK, label);
  }
  page.text(plotLeft + (plotRight - plotLeft) / 2 - 18, barBottom + 34, 10, 'italic', MUTED, 'Çeyrek');
  page.text(26, (barTop + barBottom) / 2 + 40, 10, 'italic', MUTED, 'Satış (bin ₺)', { rotate: 90 });

  // line chart with markers
  const lineTop = 640;
  const lineBottom = 770;
  page.text(40, 612, 12, 'semibold', INK, 'Aylık Ziyaretçi Sayısı');
  page.line(350, 606, 366, 606, { stroke: TEAL, lineWidth: 2 });
  page.circle(358, 606, 3.2, { fill: TEAL });
  page.text(372, 609.5, 9.5, 'regular', INK, 'Web');
  page.line(420, 606, 436, 606, { stroke: ORANGE, lineWidth: 2 });
  page.rect(425, 603, 6, 6, { fill: ORANGE });
  page.text(442, 609.5, 9.5, 'regular', INK, 'Mobil');
  for (let tick = 0; tick <= 60; tick += 20) {
    const y = lineBottom - ((lineBottom - lineTop) * tick) / 60;
    page.line(plotLeft, y, plotRight, y, {
      stroke: tick === 0 ? INK : [214, 218, 224],
      lineWidth: tick === 0 ? 1 : 0.6,
    });
    page.textRight(plotLeft - 6, y + 3.5, 9, 'regular', MUTED, String(tick));
  }
  page.line(plotLeft, lineTop, plotLeft, lineBottom, { stroke: INK, lineWidth: 1 });
  const months = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz'];
  const web = [22, 28, 35, 31, 44, 52];
  const mobile = [14, 19, 27, 36, 41, 57];
  const step = (plotRight - plotLeft - 40) / (months.length - 1);
  const px = (index: number): number => plotLeft + 20 + step * index;
  const py = (value: number): number => lineBottom - ((lineBottom - lineTop) * value) / 60;
  for (const [values, color, square] of [
    [web, TEAL, false],
    [mobile, ORANGE, true],
  ] as const) {
    for (let index = 0; index < values.length - 1; index += 1) {
      page.line(px(index), py(values[index] ?? 0), px(index + 1), py(values[index + 1] ?? 0), {
        stroke: color,
        lineWidth: 2,
      });
    }
    for (const [index, value] of values.entries()) {
      if (square) page.rect(px(index) - 3, py(value) - 3, 6, 6, { fill: color });
      else page.circle(px(index), py(value), 3.2, { fill: color });
    }
  }
  for (const [index, month] of months.entries())
    page.textCentered(px(index), lineBottom + 15, 9.5, 'regular', INK, month);
  page.text(plotLeft + (plotRight - plotLeft) / 2 - 6, lineBottom + 32, 10, 'italic', MUTED, 'Ay');
  page.text(26, (lineTop + lineBottom) / 2 + 40, 10, 'italic', MUTED, 'Ziyaretçi (bin)', { rotate: 90 });
}

// ---------------------------------------------------------------------------
// 3. text-in-image
// ---------------------------------------------------------------------------

/** A one-page snippet drawn, saved and rendered at `dpi` into a pixmap the target document adopts. */
async function snippet(
  pdf: SamplePdf,
  width: number,
  height: number,
  dpi: number,
  draw: (page: PageBuilder) => void,
  defects: ScanDefects = {},
): Promise<{ readonly pixmap: MuPixmap; readonly text: string }> {
  const source = await SamplePdf.create();
  draw(source.addPage(width, height));
  const bytes = source.save();
  const [text = ''] = await extractPageTexts(bytes);
  return { pixmap: pdf.adopt(await renderPageToPixmap(bytes, dpi, defects)), text };
}

/**
 * A page of real vector text and two embedded raster pictures that themselves contain text (a
 * screenshot-like price table and a warning sign). The pictures' text is returned as
 * `imageText`, one string per picture, so the report can tell whether a converter recovered it.
 */
export async function buildTextInImage(pdf: SamplePdf): Promise<string[]> {
  const page = pdf.addPage();
  heading(page, 'Müze Ziyaretçi Bilgisi', 'Duyuru no. 2025/14 – 3 Mart 2025');
  let y = page.paragraph(
    40,
    112,
    515.28,
    10.5,
    15,
    'regular',
    INK,
    'Müzemiz hafta içi dokuz ile on yedi arasında, hafta sonu ise on ile on sekiz arasında açıktır. Biletler giriş kapısındaki gişeden alınabilir; öğrenciler ve emekliler indirimli tarifeden yararlanır. Aşağıdaki görselde güncel bilet fiyatları ve salon uyarısı yer almaktadır.',
    { justify: true },
  );

  const table = await snippet(pdf, 300, 150, 144, (card) => {
    card.rect(0, 0, 300, 150, { fill: [250, 250, 252] });
    card.rect(0, 0, 300, 30, { fill: NAVY });
    card.text(12, 20, 13, 'bold', WHITE, 'Bilet Fiyatları');
    const rows: readonly (readonly [string, string])[] = [
      ['Tam bilet', '120 TL'],
      ['Öğrenci', '60 TL'],
      ['Emekli', '75 TL'],
      ['Aile (4 kişi)', '280 TL'],
    ];
    for (const [index, [name, price]] of rows.entries()) {
      const rowY = 52 + index * 24;
      card.text(12, rowY, 12, 'regular', INK, name);
      card.textRight(288, rowY, 12, 'bold', INK, price);
      card.line(10, rowY + 8, 290, rowY + 8, { stroke: RULE, lineWidth: 0.6 });
    }
  });
  page.image(40, y + 10, 300, 150, table.pixmap);
  page.text(40, y + 184, 9, 'italic', MUTED, 'Şekil 1. Gişede asılı güncel fiyat listesi (görüntü).');

  const sign = await snippet(pdf, 190, 150, 144, (card) => {
    card.rect(0, 0, 190, 150, { fill: GOLD });
    card.rect(6, 6, 178, 138, { stroke: INK, lineWidth: 4 });
    card.textCentered(95, 56, 24, 'bold', INK, 'DİKKAT');
    card.textCentered(95, 92, 17, 'bold', INK, 'ISLAK ZEMİN');
    card.textCentered(95, 118, 11, 'regular', INK, 'Yavaş yürüyünüz');
  });
  page.image(365, y + 10, 190, 150, sign.pixmap);
  page.text(365, y + 184, 9, 'italic', MUTED, 'Şekil 2. Salon girişindeki uyarı levhası (görüntü).');

  y += 218;
  page.paragraph(
    40,
    y,
    515.28,
    10.5,
    15,
    'regular',
    INK,
    'Görseldeki yazılar gerçek metin değil, resmin içindeki pikseldir. Bir dönüştürücü bu yazıları yalnızca karakter tanıma ile geri kazanabilir. Sayfadaki diğer tüm yazılar ise seçilebilir, gerçek metindir ve dönüştürmede aynen korunmalıdır.',
    { justify: true },
  );
  page.text(40, y + 80, 9, 'regular', MUTED, 'Bilgi: ziyaret@example.com');
  return [table.text, sign.text];
}

// ---------------------------------------------------------------------------
// 4. overlay
// ---------------------------------------------------------------------------

/** A photo-like picture: a graded sky over a sea, with film grain from an integer hash. */
function photoPicture(pdf: SamplePdf): MuPixmap {
  const width = 600;
  const height = 424;
  return pdf.pixmap(width, height, (x, y) => {
    const t = y / height;
    const horizon = 0.58;
    let color: Rgb;
    if (t < horizon) {
      const k = t / horizon;
      color = [Math.round(60 + 150 * k), Math.round(110 + 90 * k), Math.round(180 + 40 * k)];
    } else {
      const k = (t - horizon) / (1 - horizon);
      const ripple = 10 * Math.sin(x / 9 + k * 14) * k;
      color = [
        Math.round(30 + 20 * k + ripple),
        Math.round(80 - 30 * k + ripple),
        Math.round(120 - 40 * k + ripple),
      ];
    }
    const sun = Math.hypot(x - 430, y - 215);
    const glow = Math.max(0, 1 - sun / 90);
    const grain = (hash01(x, y) - 0.5) * 22;
    return [
      Math.max(0, Math.min(255, Math.round(color[0] + glow * 120 + grain))),
      Math.max(0, Math.min(255, Math.round(color[1] + glow * 80 + grain))),
      Math.max(0, Math.min(255, Math.round(color[2] + glow * 20 + grain))),
    ];
  });
}

/** A round emblem whose alpha fades from solid in the middle to clear at the rim. */
function emblem(pdf: SamplePdf): MuPixmap {
  const size = 96;
  return pdf.maskedPixmap(size, size, (x, y) => {
    const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5) / (size / 2);
    const ring = d > 0.55 && d < 0.72;
    const color: Rgb = ring ? WHITE : [236, 112, 38];
    return [color, d >= 1 ? 0 : d > 0.8 ? (1 - d) / 0.2 : 1];
  });
}

/**
 * A photo-like picture with a 50 % black band and white text over it, a linear-gradient
 * (shading) header, a soft-masked emblem, text drawn with its own opacity and translucent
 * panels over a striped background.
 */
export function buildOverlay(pdf: SamplePdf): void {
  const page = pdf.addPage();
  page.image(0, 0, A4.width, 420, photoPicture(pdf));
  page.text(40, 96, 40, 'bold', WHITE, 'Kıyıda Sabah');
  page.text(40, 128, 16, 'italic', [240, 244, 252], 'Denizin üstünde ilk ışık');
  page.image(470, 30, 84, 84, emblem(pdf));
  page.text(40, 300, 18, 'semibold', WHITE, 'Yarı saydam metin', { opacity: 0.55 });
  page.rect(0, 330, A4.width, 90, { fill: [0, 0, 0], opacity: 0.5 });
  page.text(40, 362, 17, 'bold', WHITE, 'Gün doğarken liman sessizdir');
  page.text(
    40,
    384,
    11,
    'regular',
    [236, 236, 244],
    'Balıkçı tekneleri, ışık ağır ağır yükselirken limandan çıkar.',
  );
  page.text(
    40,
    402,
    11,
    'regular',
    [236, 236, 244],
    'Görsel, bu depo için kodla üretilmiş yapay bir fotoğraftır.',
  );

  page.gradientRect(0, 430, A4.width, 64, NAVY, [20, 170, 170], 'horizontal');
  page.text(40, 470, 24, 'bold', WHITE, 'Gradyan Başlık Şeridi');
  page.image(490, 438, 48, 48, emblem(pdf));

  const stripes: readonly Rgb[] = [
    [250, 214, 214],
    [214, 232, 250],
  ];
  for (let index = 0; index < 8; index += 1) {
    page.rect(index * 74.4, 500, 74.4, 330, { fill: stripes[index % 2] ?? WHITE });
  }
  page.text(40, 530, 15, 'bold', NAVY, 'Saydam paneller');
  page.rect(40, 546, 250, 120, { fill: WHITE, opacity: 0.7 });
  page.text(54, 572, 12, 'semibold', INK, 'Beyaz panel');
  page.text(54, 592, 10.5, 'regular', INK, 'Arkadaki şeritler panelin içinden');
  page.text(54, 608, 10.5, 'regular', INK, 'belli belirsiz görünmeye devam eder.');
  page.text(54, 624, 10.5, 'regular', INK, 'Metin ise tamamen opaktır.');
  page.rect(305, 546, 250, 120, { fill: NAVY, opacity: 0.8 });
  page.text(319, 572, 12, 'semibold', WHITE, 'Koyu panel');
  page.text(319, 592, 10.5, 'regular', WHITE, 'Beyaz yazı koyu yarı saydam');
  page.text(319, 608, 10.5, 'regular', WHITE, 'bir yüzeyin üzerinde okunur.');
  page.text(319, 624, 10.5, 'regular', WHITE, 'Yazının kendisi %70 opaklıktadır.', { opacity: 0.7 });
  page.text(40, 700, 10, 'regular', MUTED, 'Not: tüm renkler ve görseller kodla üretilmiştir.');
}

// ---------------------------------------------------------------------------
// 5. rotated
// ---------------------------------------------------------------------------

/** Text at 90°, 270° and 45°, a table with a header row of vertical titles, margin labels, a red rotated stamp and normal body text. */
export function buildRotated(pdf: SamplePdf): void {
  const page = pdf.addPage();
  heading(page, 'Döndürülmüş Metinler', 'Dik, ters ve eğik yazılar; damga; kenar etiketleri');
  page.paragraph(
    40,
    104,
    515.28,
    10.5,
    15,
    'regular',
    INK,
    'Bu sayfada yazılar farklı açılarda durur. Gövde metni yatay kalır; sütun başlıkları, kenar etiketleri ve damga ise döndürülmüş metindir. Bir dönüştürücü bu satırların okuma sırasını ve yönünü bozmamalıdır.',
  );

  // a table whose header row is vertical text
  const columns = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran'];
  const left = 40;
  const first = 100;
  const colWidth = 60;
  page.rect(left, 180, first - left + colWidth * columns.length, 78, { fill: NAVY });
  page.text(left + 8, 246, 11, 'bold', WHITE, 'Bölge');
  for (const [index, name] of columns.entries()) {
    page.text(first + colWidth * index + colWidth / 2 + 5, 250, 11, 'bold', WHITE, name, { rotate: 90 });
    page.line(first + colWidth * index, 180, first + colWidth * index, 258, {
      stroke: [90, 112, 150],
      lineWidth: 0.6,
    });
  }
  const regions: readonly (readonly [string, readonly number[]])[] = [
    ['Marmara', [120, 135, 150, 142, 160, 171]],
    ['Ege', [88, 92, 101, 99, 110, 118]],
    ['Akdeniz', [64, 70, 83, 91, 102, 125]],
  ];
  for (const [rowIndex, [region, values]] of regions.entries()) {
    const top = 258 + rowIndex * 24;
    page.line(left, top + 24, first + colWidth * columns.length, top + 24, { stroke: RULE, lineWidth: 0.6 });
    page.text(left + 8, top + 16, 10.5, 'semibold', INK, region);
    for (const [index, value] of values.entries()) {
      page.textRight(first + colWidth * (index + 1) - 10, top + 16, 10.5, 'regular', INK, String(value));
    }
  }

  // text at several angles
  page.text(40, 356, 11, 'semibold', TEAL, 'Farklı açılar');
  page.text(60, 540, 14, 'bold', NAVY, 'Eğik metin kırk beş derece', { rotate: 45 });
  page.text(250, 540, 14, 'bold', TEAL, 'Yukarı doğru dokuz yüz', { rotate: 90 });
  page.text(290, 380, 14, 'bold', ORANGE, 'Aşağı doğru iki yüz yetmiş', { rotate: 270 });

  // the stamp
  const stampX = 440;
  const stampY = 420;
  const turn = 18;
  const stampSize = 28;
  const stampWidth = pdf.measure('bold', stampSize, 'ONAYLANDI');
  const halfWidth = stampWidth / 2 + 14;
  const corners = [
    [-halfWidth, -30],
    [halfWidth, -30],
    [halfWidth, 30],
    [-halfWidth, 30],
  ] as const;
  page.polygon(
    corners.map(([dx, dy]) => turned(stampX, stampY, dx, dy, turn)),
    { stroke: RED, lineWidth: 3.5 },
  );
  page.polygon(
    corners.map(([dx, dy]) => turned(stampX, stampY, dx * 0.95, dy * 0.88, turn)),
    { stroke: RED, lineWidth: 1 },
  );
  const [stampTextX, stampTextY] = turned(stampX, stampY, -stampWidth / 2, stampSize * 0.36, turn);
  page.text(stampTextX, stampTextY, stampSize, 'bold', RED, 'ONAYLANDI', { rotate: turn, opacity: 0.88 });

  // side labels in the margins
  page.text(22, 700, 10, 'semibold', MUTED, 'GİZLİ BELGE – DAĞITMAYINIZ', { rotate: 90 });
  page.text(580, 150, 10, 'semibold', MUTED, 'Sayfa kenarı etiketi – sağ', { rotate: 270 });

  let y = page.paragraph(
    40,
    600,
    515.28,
    10.5,
    15,
    'regular',
    INK,
    'Damga, sayfanın sağ tarafında kırmızı çerçeveli ve eğik durur. Sol kenardaki dikey etiket aşağıdan yukarıya, sağ kenardaki etiket ise yukarıdan aşağıya okunur.',
  );
  y = page.paragraph(
    40,
    y + 8,
    515.28,
    10.5,
    15,
    'regular',
    INK,
    'Bu iki paragraf yatay metindir ve döndürülmüş öğelerin yanında doğru sırada, doğru satır kırılımlarıyla korunmalıdır.',
  );
  page.text(40, y + 24, 9, 'regular', MUTED, 'Hazırlayan: Test Birimi');
}

// ---------------------------------------------------------------------------
// 6. mixed-page
// ---------------------------------------------------------------------------

/**
 * Real vector text on top (title, date, reference number, subject) and, below, a raster picture of
 * a typed paragraph with scan-like noise — a page that has both visible text and a scanned body.
 * Returns the picture's text (`imageText`).
 */
export async function buildMixedPage(pdf: SamplePdf): Promise<string[]> {
  const page = pdf.addPage();
  page.text(40, 64, 22, 'bold', NAVY, 'Resmî Yazı');
  page.text(40, 84, 10.5, 'regular', MUTED, 'Çevre ve Şehircilik Birimi');
  page.line(40, 98, 555.28, 98, { stroke: TEAL, lineWidth: 2 });
  page.text(40, 126, 11, 'semibold', INK, 'Tarih:');
  page.text(110, 126, 11, 'regular', INK, '12 Mart 2025');
  page.text(40, 146, 11, 'semibold', INK, 'Sayı:');
  page.text(110, 146, 11, 'regular', INK, '2025/ARŞ-0417');
  page.text(40, 166, 11, 'semibold', INK, 'Konu:');
  page.text(110, 166, 11, 'regular', INK, 'Arşiv taraması ve dosya devri hakkında');
  page.text(
    40,
    210,
    10,
    'italic',
    MUTED,
    'Aşağıdaki gövde, daktilo edilmiş bir kâğıdın taranmış görüntüsüdür.',
  );

  const body = await snippet(
    pdf,
    515.28,
    400,
    150,
    (card) => {
      card.rect(0, 0, 515.28, 400, { fill: [251, 249, 243] });
      card.text(8, 28, 12.5, 'regular', [30, 30, 30], 'Sayın Yetkili,');
      let y = card.paragraph(
        8,
        54,
        499,
        12.5,
        19,
        'regular',
        [30, 30, 30],
        'Birimimizde bulunan eski dosyaların sayısallaştırılması çalışmasına ilişkin ilk aşama tamamlanmıştır. Toplam üç yüz kırk iki klasör taranmış, her biri bir sıra numarası ile etiketlenmiş ve güvenli depolama alanına aktarılmıştır.',
      );
      y = card.paragraph(
        8,
        y + 10,
        499,
        12.5,
        19,
        'regular',
        [30, 30, 30],
        'İkinci aşamada, taranan belgelerin içeriği üzerinde arama yapılabilmesi için karakter tanıma işlemi uygulanacaktır. Bu işlem sonunda belgelerin metin katmanı oluşturulacak ve arşiv kayıtlarına bağlanacaktır.',
      );
      y = card.paragraph(
        8,
        y + 10,
        499,
        12.5,
        19,
        'regular',
        [30, 30, 30],
        'Çalışmanın kalan bölümü için ihtiyaç duyulan sürenin altı hafta olduğu tahmin edilmektedir. Gereğini bilgilerinize arz ederim.',
      );
      card.text(8, y + 34, 12.5, 'regular', [30, 30, 30], 'Saygılarımla,');
      card.text(8, y + 52, 12.5, 'bold', [30, 30, 30], 'Zeynep Aksoy Demir');
      card.text(8, y + 68, 12.5, 'regular', [30, 30, 30], 'Arşiv Sorumlusu');
    },
    { noiseSigma: 8, unevenLight: 0.07 },
  );
  page.image(40, 226, 515.28, 400, body.pixmap);
  page.text(40, 660, 9, 'regular', MUTED, 'Ek: Tarama listesi (2 sayfa)');
  page.text(40, 676, 9, 'regular', MUTED, 'Dağıtım: İlgili birimler');
  return [body.text];
}

// ---------------------------------------------------------------------------
// 7. slide
// ---------------------------------------------------------------------------

/** A 16:9 landscape slide: big title, a bullet list with vector icons, a picture placeholder and a footer with a page number. */
export function buildSlide(pdf: SamplePdf): void {
  const page = pdf.addPage(960, 540);
  page.rect(0, 0, 960, 540, { fill: [248, 250, 253] });
  page.rect(0, 0, 18, 540, { fill: TEAL });
  page.text(60, 104, 40, 'bold', NAVY, 'Yıllık Değerlendirme 2025');
  page.text(60, 136, 18, 'italic', MUTED, 'Ürün ekibi – dördüncü çeyrek sunumu');
  page.line(60, 152, 520, 152, { stroke: ORANGE, lineWidth: 3 });

  const items = [
    'Gelirler yüzde on iki arttı',
    'Müşteri memnuniyeti 4,6 / 5',
    'Yeni üç pazara açıldık',
    'Destek süresi yarıya indi',
  ];
  for (const [index, item] of items.entries()) {
    const y = 214 + index * 62;
    page.circle(78, y - 8, 17, { fill: [TEAL, ORANGE, NAVY, GREEN][index] ?? TEAL });
    if (index === 0) {
      page.path(
        [
          ['M', 69, y - 8],
          ['L', 76, y - 1],
          ['L', 88, y - 16],
        ],
        { stroke: WHITE, lineWidth: 3, cap: 'round' },
      );
    } else if (index === 1) {
      page.polygon(
        Array.from({ length: 10 }, (_, k): [number, number] => {
          const r = k % 2 === 0 ? 10 : 4.2;
          const a = -Math.PI / 2 + (k * Math.PI) / 5;
          return [78 + r * Math.cos(a), y - 8 + r * Math.sin(a)];
        }),
        { fill: WHITE },
      );
    } else if (index === 2) {
      page.polygon(
        [
          [71, y - 3],
          [85, y - 3],
          [78, y - 16],
        ],
        { fill: WHITE },
      );
    } else {
      page.ellipse(78, y - 8, 9, 9, { stroke: WHITE, lineWidth: 2 });
      page.line(78, y - 8, 78, y - 14, { stroke: WHITE, lineWidth: 1.6 });
      page.line(78, y - 8, 83, y - 8, { stroke: WHITE, lineWidth: 1.6 });
    }
    page.text(112, y, 24, 'regular', INK, item);
  }

  page.rect(590, 180, 320, 230, { fill: [226, 230, 238], stroke: RULE, lineWidth: 1.5, dash: [8, 5] });
  page.line(590, 180, 910, 410, { stroke: RULE, lineWidth: 1 });
  page.line(910, 180, 590, 410, { stroke: RULE, lineWidth: 1 });
  page.rect(700, 281, 100, 28, { fill: [248, 250, 253] });
  page.textCentered(750, 300, 14, 'semibold', MUTED, 'Görsel alanı');

  page.line(60, 496, 900, 496, { stroke: RULE, lineWidth: 0.8 });
  page.text(60, 520, 11, 'regular', MUTED, 'Örnek Teknoloji A.Ş. • Kurum içi');
  page.textRight(900, 520, 11, 'semibold', NAVY, '3 / 12');
}

// ---------------------------------------------------------------------------
// 8. invoice
// ---------------------------------------------------------------------------

/** A QR-like grid of 25 × 25 modules with three finder squares; the pattern is a fixed hash, not data. */
function qrLike(page: PageBuilder, x: number, y: number, size: number): void {
  const modules = 25;
  const cell = size / modules;
  const finder = (fx: number, fy: number): void => {
    page.rect(x + fx * cell, y + fy * cell, 7 * cell, 7 * cell, { fill: INK });
    page.rect(x + (fx + 1) * cell, y + (fy + 1) * cell, 5 * cell, 5 * cell, { fill: WHITE });
    page.rect(x + (fx + 2) * cell, y + (fy + 2) * cell, 3 * cell, 3 * cell, { fill: INK });
  };
  const inFinder = (cx: number, cy: number): boolean =>
    (cx < 8 && cy < 8) || (cx >= modules - 8 && cy < 8) || (cx < 8 && cy >= modules - 8);
  for (let cy = 0; cy < modules; cy += 1) {
    for (let cx = 0; cx < modules; cx += 1) {
      if (!inFinder(cx, cy) && hash01(cx, cy, 7) < 0.48) {
        page.rect(x + cx * cell, y + cy * cell, cell, cell, { fill: INK });
      }
    }
  }
  finder(0, 0);
  finder(modules - 7, 0);
  finder(0, modules - 7);
}

/** An invoice: vector logo, sender and recipient blocks, a ruled table with right-aligned numbers, bold totals, a QR-like grid and small-print terms. */
export function buildInvoice(pdf: SamplePdf): void {
  const page = pdf.addPage();
  const left = 40;
  const right = 555.28;

  // logo
  page.circle(62, 66, 22, { fill: NAVY });
  page.path(
    [
      ['M', 46, 70],
      ['C', 54, 56, 60, 80, 68, 66],
      ['C', 72, 60, 76, 62, 79, 66],
    ],
    { stroke: WHITE, lineWidth: 3, cap: 'round' },
  );
  page.text(92, 62, 18, 'bold', NAVY, 'MAVİ VADİ');
  page.text(92, 78, 9, 'italic', MUTED, 'Yazılım ve Danışmanlık');
  page.textRight(right, 62, 28, 'bold', TEAL, 'FATURA');
  page.textRight(right, 82, 10, 'regular', INK, 'Fatura No: 2025-000417');
  page.textRight(right, 96, 10, 'regular', INK, 'Tarih: 14.03.2025');
  page.textRight(right, 110, 10, 'regular', INK, 'Vade: 13.04.2025');
  page.line(left, 124, right, 124, { stroke: TEAL, lineWidth: 2 });

  // sender and recipient
  page.text(left, 148, 9, 'bold', MUTED, 'GÖNDEREN');
  page.text(left, 164, 11, 'bold', INK, 'Mavi Vadi Yazılım Ltd. Şti.');
  page.text(left, 179, 10, 'regular', INK, 'Çınar Sokak No: 14, Kat 3');
  page.text(left, 193, 10, 'regular', INK, '34000 Kadıköy / İstanbul');
  page.text(left, 207, 10, 'regular', INK, 'Vergi No: 1234567890');
  page.text(left, 221, 10, 'regular', INK, 'muhasebe@example.com');
  page.text(320, 148, 9, 'bold', MUTED, 'ALICI');
  page.text(320, 164, 11, 'bold', INK, 'Kuzey Yıldızı Gıda A.Ş.');
  page.text(320, 179, 10, 'regular', INK, 'Lale Caddesi 27/B');
  page.text(320, 193, 10, 'regular', INK, '06000 Çankaya / Ankara');
  page.text(320, 207, 10, 'regular', INK, 'Vergi No: 9876543210');

  // the table
  const edges = [left, 66, 290, 350, 430, 480, right] as const;
  const headTop = 250;
  page.rect(left, headTop, right - left, 24, { fill: NAVY });
  const heads = ['#', 'Açıklama', 'Miktar', 'Birim Fiyat', 'KDV', 'Tutar'];
  for (const [index, head] of heads.entries()) {
    const edge = edges[index] ?? left;
    const next = edges[index + 1] ?? right;
    if (index >= 2) page.textRight(next - 6, headTop + 16, 10, 'bold', WHITE, head);
    else page.text(edge + 6, headTop + 16, 10, 'bold', WHITE, head);
  }
  const lines: readonly (readonly [string, number, number])[] = [
    ['Web sitesi tasarımı', 1, 18500],
    ['Alan adı ve barındırma (12 ay)', 1, 2450],
    ['Mobil uygulama bakım hizmeti', 6, 3200],
    ['Kullanıcı eğitimi (saat)', 8, 750],
    ['Güvenlik denetimi raporu', 1, 6900],
    ['Yedekleme aboneliği', 12, 185.5],
    ['Teknik destek paketi', 3, 1400],
  ];
  let subtotal = 0;
  for (const [index, [name, quantity, price]] of lines.entries()) {
    const top = headTop + 24 + index * 24;
    const total = quantity * price;
    subtotal += total;
    if (index % 2 === 1) page.rect(left, top, right - left, 24, { fill: [243, 246, 250] });
    page.line(left, top + 24, right, top + 24, { stroke: RULE, lineWidth: 0.5 });
    const baseline = top + 16;
    page.text(edges[0] + 6, baseline, 10, 'regular', INK, String(index + 1));
    page.text(edges[1] + 6, baseline, 10, 'regular', INK, name);
    page.textRight((edges[3] ?? 0) - 6, baseline, 10, 'regular', INK, String(quantity));
    page.textRight((edges[4] ?? 0) - 6, baseline, 10, 'regular', INK, formatTurkish(price, 2));
    page.textRight((edges[5] ?? 0) - 6, baseline, 10, 'regular', INK, '%20');
    page.textRight(right - 6, baseline, 10, 'regular', INK, formatTurkish(total, 2));
  }
  const tableEnd = headTop + 24 + lines.length * 24;
  for (const edge of edges) page.line(edge, headTop, edge, tableEnd, { stroke: RULE, lineWidth: 0.5 });

  // totals
  const vat = subtotal * 0.2;
  const totalsLeft = 360;
  let y = tableEnd + 24;
  page.text(totalsLeft, y, 10.5, 'regular', INK, 'Ara Toplam');
  page.textRight(right - 6, y, 10.5, 'regular', INK, `${formatTurkish(subtotal, 2)} ₺`);
  y += 18;
  page.text(totalsLeft, y, 10.5, 'regular', INK, 'KDV (%20)');
  page.textRight(right - 6, y, 10.5, 'regular', INK, `${formatTurkish(vat, 2)} ₺`);
  y += 8;
  page.line(totalsLeft, y, right, y, { stroke: INK, lineWidth: 1 });
  y += 18;
  page.text(totalsLeft, y, 12, 'bold', NAVY, 'Genel Toplam');
  page.textRight(right - 6, y, 12, 'bold', NAVY, `${formatTurkish(subtotal + vat, 2)} ₺`);

  // QR-like grid and the payment terms
  const footTop = 690;
  qrLike(page, left, footTop, 96);
  page.text(left, footTop + 110, 8, 'regular', MUTED, 'Ödeme için QR kodu okutunuz');
  page.text(160, footTop + 8, 8.5, 'bold', INK, 'Ödeme Koşulları');
  const terms = [
    'Ödeme, fatura tarihinden itibaren otuz gün içinde yapılmalıdır.',
    'Vadesi geçen tutarlara aylık yüzde bir gecikme faizi uygulanır.',
    'Banka: Örnek Bankası, Kadıköy Şubesi',
    'IBAN: TR00 0000 0000 0000 0000 0000 00',
    'Açıklama kısmına fatura numarasını yazınız.',
    'İtirazlar fatura tarihinden itibaren sekiz gün içinde yazılı bildirilmelidir.',
  ];
  for (const [index, term] of terms.entries())
    page.text(160, footTop + 22 + index * 11, 7.5, 'regular', MUTED, term);
}
