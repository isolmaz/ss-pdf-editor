/**
 * The repository's own PDF→Word fidelity samples: Turkish-language, vector-built pages (six here,
 * eight graphics-heavy ones in `samples-graphics.ts`) plus scan derivatives, all generated in code
 * (no binary assets, no network, no clock) so a run always sees the very same bytes.
 *
 * Every vector page is real, selectable text in an embedded Noto Sans face (see `sample-builder.ts`)
 * with a correct `ToUnicode` map, so ç ğ ı İ ö ş ü survive extraction. Each page is drawn in
 * *reading order*, which is also the order its text extracts in. The pages exercise what a
 * converter has to get right: a résumé with a sidebar and hyperlinks, justified magazine columns, a
 * ruled table that continues on a second page, a drawn form, rounded cards on a coloured page, and
 * text over a full-bleed picture with a translucent band.
 *
 * The scans (`cv-scan`, `cards-scan`, `shapes-scan`, `invoice-scan`, and the rough `invoice-scan-rough`
 * at 150 dpi with skew, noise and uneven light) are vector pages rendered into an image-only PDF:
 * the OCR path's input. Their ground truth is the vector original's own text.
 */

import {
  A4,
  extractPageTexts,
  type FontFace,
  type MuPixmap,
  type PageBuilder,
  type Rgb,
  rasterizeToImagePdf,
  SamplePdf,
  type ScanDefects,
} from './sample-builder';
import {
  buildChart,
  buildInvoice,
  buildMixedPage,
  buildOverlay,
  buildRotated,
  buildShapes,
  buildSlide,
  buildTextInImage,
} from './samples-graphics';

export { rasterizeToImagePdf } from './sample-builder';

/** One sample of the fidelity set. */
export interface FidelitySample {
  /** Stable key, e.g. `cv`, `cv-scan`. */
  readonly id: string;
  /** Human-readable name. */
  readonly title: string;
  readonly origin: 'generated' | 'public' | 'local';
  readonly license: string;
  /** True when the page content is an image with no text layer. */
  readonly ocr: boolean;
  /** The PDF. */
  readonly bytes: Uint8Array;
  /** Per-page plain text in reading order; always present when `ocr` is true. */
  readonly groundTruth?: readonly string[];
  /**
   * Text that exists only as pixels inside an embedded picture on a vector page, one string per
   * picture. It is not part of the text a converter can read, so it is kept out of `groundTruth`;
   * the report shows how much of it a conversion recovered (none is expected without OCR).
   */
  readonly imageText?: readonly string[];
}

/** The licence line of everything this module generates. */
const GENERATED_LICENSE = 'AGPL-3.0-or-later (generated in this repository)';

/** The resolution of the scan derivatives. */
const SCAN_DPI = 200;

/** The rough scan: 150 dpi, the sheet 2.5° skewed, sensor noise, one corner lit less than the other. */
const ROUGH_SCAN: ScanDefects = { skewDegrees: 2.5, noiseSigma: 14, unevenLight: 0.3 };
const ROUGH_SCAN_DPI = 150;

// ---------------------------------------------------------------------------
// shared palette and layout helpers
// ---------------------------------------------------------------------------

const INK: Rgb = [33, 37, 41];
const MUTED: Rgb = [96, 104, 112];
const WHITE: Rgb = [255, 255, 255];
const NAVY: Rgb = [24, 54, 94];
const TEAL: Rgb = [0, 122, 135];
const LINK: Rgb = [20, 90, 200];

/** Turkish number formatting: `.` between thousands, `,` before decimals. */
function formatTurkish(value: number, decimals = 0): string {
  const [whole = '0', fraction] = value.toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}

/** One styled stretch of an inline line. */
interface Span {
  readonly text: string;
  readonly face: FontFace;
  readonly color: Rgb;
  /** Makes the span an underlined hyperlink. */
  readonly uri?: string;
}

/** Spans set one after another on a baseline, hyperlinks underlined and linked. Returns the end x. */
function spans(
  pdf: SamplePdf,
  page: PageBuilder,
  x: number,
  y: number,
  size: number,
  list: readonly Span[],
): number {
  let cursor = x;
  for (const span of list) {
    const width = pdf.measure(span.face, size, span.text);
    page.text(cursor, y, size, span.face, span.color, span.text);
    if (span.uri !== undefined) {
      page.line(cursor, y + 1.8, cursor + width, y + 1.8, { stroke: span.color, lineWidth: 0.6 });
      page.link(cursor, y - size * 0.95, width, size * 1.3, span.uri);
    }
    cursor += width;
  }
  return cursor;
}

/** A bulleted list: the bullet hangs in the margin, the wrapped text indents. Returns the next baseline. */
function bullets(
  page: PageBuilder,
  x: number,
  y: number,
  width: number,
  size: number,
  leading: number,
  color: Rgb,
  items: readonly string[],
  gap = 3,
): number {
  let baseline = y;
  for (const item of items) {
    page.text(x, baseline, size, 'regular', color, '•');
    baseline = page.paragraph(x + 11, baseline, width - 11, size, leading, 'regular', color, item) + gap;
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// 1. cv: a résumé
// ---------------------------------------------------------------------------

/** A head-and-shoulders placeholder portrait, painted from shapes. */
function portrait(pdf: SamplePdf): MuPixmap {
  const size = 168;
  return pdf.pixmap(size, size, (x, y) => {
    const t = y / size;
    let color: Rgb = [Math.round(122 - 50 * t), Math.round(165 - 55 * t), Math.round(205 - 45 * t)];
    const shoulders = ((x - 84) / 70) ** 2 + ((y - 182) / 62) ** 2;
    if (shoulders <= 1) color = [38, 58, 92];
    if (Math.abs(x - 84) < 12 && y > 100 && y < 140) color = [214, 172, 142];
    const head = ((x - 84) / 30) ** 2 + ((y - 68) / 36) ** 2;
    if (head <= 1) color = y < 58 ? [58, 38, 30] : [226, 186, 154];
    const hair = ((x - 84) / 34) ** 2 + ((y - 62) / 38) ** 2;
    if (hair <= 1 && head > 1 && y < 78) color = [58, 38, 30];
    return color;
  });
}

/** Page-wide heading with a coloured rule under it. */
function sectionHeading(
  page: PageBuilder,
  x: number,
  y: number,
  width: number,
  title: string,
  color: Rgb,
): void {
  page.text(x, y, 10.5, 'bold', color, title);
  page.line(x, y + 5, x + width, y + 5, { stroke: color, lineWidth: 1.2 });
}

function buildCv(pdf: SamplePdf): void {
  const page = pdf.addPage();

  // header: portrait, name, title, contact line
  page.image(40, 34, 88, 88, portrait(pdf));
  page.text(146, 64, 20, 'bold', NAVY, 'Elif Yıldırım Çelik');
  page.text(146, 84, 12, 'semibold', TEAL, 'Kıdemli Yazılım Mühendisi');
  spans(pdf, page, 146, 106, 9.5, [
    { text: 'İstanbul, Türkiye  •  ', face: 'regular', color: MUTED },
    { text: 'elif.celik@example.com', face: 'regular', color: LINK, uri: 'mailto:elif.celik@example.com' },
    { text: '  •  ', face: 'regular', color: MUTED },
    {
      text: 'example.com/elif-celik',
      face: 'regular',
      color: LINK,
      uri: 'https://example.com/elif-celik',
    },
  ]);
  page.line(40, 138, 555.28, 138, { stroke: TEAL, lineWidth: 2 });

  // left sidebar on a light-grey panel
  page.rect(40, 152, 164, 650, { fill: [238, 240, 244] });
  const sx = 54;
  const sw = 138;
  sectionHeading(page, sx, 178, sw, 'BECERİLER', TEAL);
  let y = bullets(page, sx, 200, sw, 9.5, 13, INK, [
    'TypeScript ve JavaScript',
    'React ve Next.js',
    'Node.js, Fastify',
    'PostgreSQL, Redis',
    'Docker ve Kubernetes',
    'CI/CD (GitHub Actions)',
    'Test odaklı geliştirme',
  ]);
  sectionHeading(page, sx, y + 14, sw, 'DİLLER', TEAL);
  y += 36;
  for (const [language, level] of [
    ['Türkçe', 'Ana dil'],
    ['İngilizce', 'İleri (C1)'],
    ['Almanca', 'Orta (B1)'],
  ] as const) {
    page.text(sx, y, 9.5, 'semibold', INK, language);
    page.textRight(sx + sw, y, 9.5, 'regular', MUTED, level);
    y += 15;
  }
  sectionHeading(page, sx, y + 14, sw, 'EĞİTİM', TEAL);
  y += 36;
  page.text(sx, y, 9.5, 'bold', INK, 'Lisans, Bilgisayar');
  page.text(sx, y + 12, 9.5, 'bold', INK, 'Mühendisliği');
  page.text(sx, y + 27, 9.5, 'regular', INK, 'Orta Doğu Teknik');
  page.text(sx, y + 39, 9.5, 'regular', INK, 'Üniversitesi, Ankara');
  page.text(sx, y + 54, 9, 'italic', MUTED, '2008 – 2012');
  y += 82;
  sectionHeading(page, sx, y, sw, 'İLGİ ALANLARI', TEAL);
  bullets(page, sx, y + 22, sw, 9.5, 13, INK, ['Bisiklet turları', 'Satranç', 'Gönüllü eğitmenlik']);

  // main column
  const mx = 226;
  const mw = 329;
  sectionHeading(page, mx, 178, mw, 'ÖZET', NAVY);
  y = page.paragraph(
    mx,
    200,
    mw,
    10,
    14,
    'regular',
    INK,
    'Dokuz yılı aşkın deneyime sahip bir yazılım mühendisiyim. Ölçeklenebilir web uygulamaları, bulut altyapısı ve geliştirici deneyimi üzerine çalışıyorum; takım liderliği ve mentorluk konularında deneyimliyim.',
  );

  sectionHeading(page, mx, y + 14, mw, 'DENEYİM', NAVY);
  y += 38;
  const jobs: readonly {
    readonly title: string;
    readonly place: string;
    readonly period: string;
    readonly items: readonly string[];
  }[] = [
    {
      title: 'Kıdemli Yazılım Mühendisi',
      place: 'Anadolu Teknoloji A.Ş., İstanbul',
      period: 'Mart 2020 – Günümüz',
      items: [
        'Günde 2 milyon isteği karşılayan ödeme servisini yeniden tasarlayarak yanıt süresini %38 azalttım.',
        'Altı kişilik ekibe teknik liderlik yaptım; kod inceleme ve test kültürünü yerleştirdim.',
        'Şirket içi tasarım sistemini TypeScript ile geliştirip on iki ürüne yaygınlaştırdım.',
      ],
    },
    {
      title: 'Yazılım Mühendisi',
      place: 'Ege Dijital Çözümler, İzmir',
      period: 'Eylül 2015 – Şubat 2020',
      items: [
        'Müşteri portalının ön yüzünü Angular’dan React’e taşıdım.',
        'Sürekli entegrasyon hatları kurarak yayın süresini haftalardan günlere indirdim.',
        'Yeni gelen on dört mühendise mentorluk yaptım.',
      ],
    },
    {
      title: 'Yazılım Geliştirici',
      place: 'Boğaziçi Yazılım Evi, İstanbul',
      period: 'Haziran 2012 – Ağustos 2015',
      items: [
        'Kurumsal raporlama araçlarını Java ve SQL ile geliştirdim.',
        'Gece çalışan veri aktarım işlerini üçte bir sürede tamamlanır hale getirdim.',
      ],
    },
  ];
  for (const job of jobs) {
    page.text(mx, y, 11, 'bold', INK, job.title);
    page.text(mx, y + 13, 9.5, 'italic', MUTED, `${job.place}  |  ${job.period}`);
    y = bullets(page, mx, y + 30, mw, 9.5, 13, INK, job.items) + 8;
  }

  sectionHeading(page, mx, y + 4, mw, 'AÇIK KAYNAK VE PROJELER', NAVY);
  bullets(page, mx, y + 26, mw, 9.5, 13, INK, [
    'Kâğıt Okuyucu: Türkçe karakter desteği ve erişilebilirlik iyileştirmeleri katkısı.',
    'Şehir Bisikleti Haritası: kentteki bisiklet yollarını gösteren açık veri uygulaması.',
  ]);
}

// ---------------------------------------------------------------------------
// 2. columns: a magazine page
// ---------------------------------------------------------------------------

/** A landscape-ish sunlit green-roof picture, painted from a few layered shapes. */
function roofPicture(pdf: SamplePdf): MuPixmap {
  const width = 480;
  const height = 300;
  return pdf.pixmap(width, height, (x, y) => {
    const t = y / height;
    let color: Rgb = [Math.round(135 + 80 * t), Math.round(190 + 40 * t), Math.round(235 + 10 * t)];
    // distant towers
    const tower = Math.floor(x / 40);
    const towerTop = 120 + ((tower * 37) % 70);
    if (y > towerTop && y < 190) color = [Math.round(120 + (tower % 3) * 12), 138, 160];
    // the green roof terrace in front
    const terrace = 190 + 14 * Math.sin(x / 55);
    if (y >= terrace) {
      const stripe = Math.floor((x + y * 0.6) / 14) % 2;
      color = stripe === 0 ? [70, 150, 80] : [58, 128, 70];
    }
    if (y > 258) color = [120, 96, 74];
    return color;
  });
}

function buildColumns(pdf: SamplePdf): void {
  const page = pdf.addPage();
  const left = 40;
  const full = 515.28;
  const accent: Rgb = [190, 60, 40];

  page.text(left, 56, 9, 'bold', accent, 'BİLİM VE TEKNOLOJİ  |  EKİM 2026');
  page.line(left, 64, left + full, 64, { stroke: accent, lineWidth: 2.5 });
  let y = page.paragraph(
    left,
    104,
    full,
    29,
    34,
    'bold',
    INK,
    'Kentlerin Geleceği: Yeşil Çatılar ve Akıllı Ulaşım',
  );
  page.text(left, y - 2, 13, 'italic', MUTED, 'Beton şehirlerin üstünde sessiz bir devrim büyüyor.');
  page.text(left, y + 16, 9, 'regular', MUTED, 'Yazan: Deniz Kaya  •  Fotoğraf: Arşiv');
  y += 30;
  page.line(left, y, left + full, y, { stroke: [200, 200, 205], lineWidth: 0.8 });

  const paragraphs = [
    'Dünya nüfusunun yarısından fazlası bugün kentlerde yaşıyor ve bu oran her yıl artıyor. Hızlı büyüme, yeşil alanların asfalt ve betonla yer değiştirmesi anlamına geliyor; yaz aylarında kentlerin çevresinden birkaç derece daha sıcak olmasının nedeni de bu.',
    'Mühendisler bu sorunun yanıtını çatılarda arıyor. Yeşil çatılar yağmur suyunu tutuyor, binayı kışın ısıtmak ve yazın soğutmak için harcanan enerjiyi azaltıyor, üstelik arılara ve kuşlara yeni yaşam alanları sunuyor.',
    'İstanbul, İzmir ve Ankara’da yürütülen pilot projeler umut verici sonuçlar veriyor. İki yıl boyunca izlenen on iki binanın çatı sıcaklığı yazın ortalama on beş derece düştü; yağış sonrası kanalizasyona karışan su miktarı ise yarı yarıya azaldı.',
    'Ulaşım tarafında da değişim hızlanıyor. Akıllı kavşaklar trafik yoğunluğuna göre sinyal sürelerini ayarlıyor, toplu taşıma araçları anlık konum bilgisiyle yolculara ne zaman geleceğini söylüyor. Şarj ağı büyüdükçe elektrikli otobüsler de hatlara katılıyor.',
    'Uzmanlara göre asıl dönüşüm teknolojiden çok alışkanlıkta yaşanacak. Kısa mesafeleri yürüyerek ya da bisikletle kat etmek, çatı bahçelerinde komşularla sebze yetiştirmek yeni şehir kültürünün parçası haline geliyor.',
    'Belediyeler bu eğilimi teşvik etmek için yeşil çatı yapan binalara vergi indirimi sağlıyor. Başvuruların büyük bölümü, mahalle sakinlerinin ortak karar aldığı küçük apartman yönetimlerinden geliyor.',
    'Önümüzdeki on yılda hedef, her kentlinin evine beş dakikalık yürüme mesafesinde bir yeşil alan bırakmak. Bu hedefe ulaşmak için çatıların, balkonların ve hatta otobüs duraklarının bile yeşillendirilmesi gerekecek.',
  ];

  const columnWidth = 162;
  const gutter = (full - columnWidth * 3) / 2;
  const top = y + 20;
  const size = 9;
  const leading = 13;
  const quoteHeight = 156;
  const columnHeight = 300;
  const columns = [
    { x: left, top, height: columnHeight },
    { x: left + columnWidth + gutter, top, height: columnHeight },
    {
      x: left + (columnWidth + gutter) * 2,
      top: top + quoteHeight + 16,
      height: columnHeight - quoteHeight - 16,
    },
  ];

  // lay every line into the columns first, so the draw order is the reading order
  const placed: { column: number; baseline: number; text: string; justify: boolean }[] = [];
  let column = 0;
  let baseline = (columns[0]?.top ?? 0) + size;
  for (const paragraph of paragraphs) {
    const lines = pdf.wrap('regular', size, columnWidth, paragraph);
    for (const [index, text] of lines.entries()) {
      const current = columns[column];
      if (current === undefined) throw new Error('columns sample: the text does not fit the three columns');
      if (baseline > current.top + current.height) {
        column += 1;
        const next = columns[column];
        if (next === undefined) throw new Error('columns sample: the text does not fit the three columns');
        baseline = next.top + size;
      }
      placed.push({ column, baseline, text, justify: index < lines.length - 1 });
      baseline += leading;
    }
    baseline += 5;
  }

  const quoteX = columns[2]?.x ?? 0;
  for (const [index, current] of columns.entries()) {
    if (index === 2) {
      // the pull quote, in a coloured box heading the third column
      page.rect(quoteX, top, columnWidth, quoteHeight, { fill: [255, 238, 214] });
      page.rect(quoteX, top, 4, quoteHeight, { fill: accent });
      page.paragraph(
        quoteX + 16,
        top + 30,
        columnWidth - 28,
        12,
        17,
        'boldItalic',
        [120, 36, 20],
        '“Şehirler büyürken yeşili çatılara taşımak, kaybettiğimiz toprağı geri kazanmanın en hızlı yoludur.”',
      );
      page.text(quoteX + 16, top + quoteHeight - 14, 8.5, 'semibold', MUTED, '— Prof. Dr. Zeynep Aksoy');
    }
    for (const item of placed.filter((entry) => entry.column === index)) {
      page.text(
        current.x,
        item.baseline,
        size,
        'regular',
        INK,
        item.text,
        item.justify ? { justifyTo: columnWidth } : {},
      );
    }
  }

  // a picture with its caption, and a short aside beside them
  const pictureTop = top + columnHeight + 28;
  page.image(left, pictureTop, 300, 187.5, roofPicture(pdf));
  page.paragraph(
    left,
    pictureTop + 187.5 + 14,
    300,
    8.5,
    11.5,
    'italic',
    MUTED,
    'Şekil 1. Ankara’da bir ofis binasının çatı terasında yetiştirilen bitki örtüsü, 2026 yazı.',
  );
  page.text(358, pictureTop + 14, 10, 'bold', accent, 'RAKAMLARLA YEŞİL ÇATI');
  let aside = pictureTop + 36;
  for (const [figure, label] of [
    ['%50', 'yağmur suyu akışında azalma'],
    ['15 °C', 'yazın çatı sıcaklığında düşüş'],
    ['12', 'izlenen pilot bina'],
  ] as const) {
    page.text(358, aside, 20, 'bold', NAVY, figure);
    page.text(358, aside + 14, 9, 'regular', MUTED, label);
    aside += 44;
  }
  page.line(left, 800, left + full, 800, { stroke: [200, 200, 205], lineWidth: 0.8 });
  page.text(left, 816, 8, 'regular', MUTED, 'Kent Dergisi  •  Ekim 2026  •  Sayfa 14');
}

// ---------------------------------------------------------------------------
// 3. table: a ruled table over two pages
// ---------------------------------------------------------------------------

const TABLE_PRODUCTS: readonly (readonly [string, string, number, number])[] = [
  ['KH-101', 'Kablosuz Kulaklık', 148, 899.9],
  ['MK-204', 'Mekanik Klavye', 96, 1249],
  ['ER-310', 'Ergonomik Fare', 212, 459.5],
  ['DS-415', 'Dizüstü Standı', 175, 329],
  ['UC-522', 'USB-C Çoğaltıcı', 134, 749.9],
  ['WK-618', 'Web Kamerası', 88, 999],
  ['EK-725', 'Ekran Koruyucu', 301, 119.9],
  ['TD-830', 'Taşınabilir Disk 1 TB', 77, 2399],
  ['SC-946', 'Şarj Cihazı 65 W', 163, 689],
  ['BH-052', 'Bluetooth Hoparlör', 119, 1149.9],
  ['OS-163', 'Ofis Sandalyesi', 41, 3899],
  ['CM-274', 'Çalışma Masası', 36, 5249],
];

const GRID: Rgb = [120, 128, 140];

/** The column edges of the table: code, name, quantity, unit price, total. */
const TABLE_COLUMNS = [40, 112, 292, 352, 452, 555.28] as const;

/** One cell box spanning columns `from` to `to` (inclusive), with optional text. */
function tableCell(
  page: PageBuilder,
  y: number,
  height: number,
  from: number,
  to: number,
  fill: Rgb | undefined,
  text: string,
  face: FontFace,
  color: Rgb,
  align: 'left' | 'right' | 'center' = 'left',
): void {
  const left = TABLE_COLUMNS[from] ?? 0;
  const right = TABLE_COLUMNS[to + 1] ?? 0;
  page.rect(left, y, right - left, height, { fill, stroke: GRID, lineWidth: 0.75 });
  const baseline = y + height / 2 + 3.6;
  if (align === 'right') page.textRight(right - 8, baseline, 10, face, color, text);
  else if (align === 'center') page.textCentered((left + right) / 2, baseline, 10, face, color, text);
  else page.text(left + 8, baseline, 10, face, color, text);
}

/** The two-row header with a merged group cell. Returns the y below it. */
function tableHeader(page: PageBuilder, y: number): number {
  const group: Rgb = NAVY;
  const sub: Rgb = [214, 227, 243];
  tableCell(page, y, 24, 0, 1, group, 'Ürün Bilgisi', 'bold', WHITE, 'center');
  tableCell(page, y, 24, 2, 4, group, 'Satış Verileri', 'bold', WHITE, 'center');
  const row = y + 24;
  tableCell(page, row, 24, 0, 0, sub, 'Kod', 'bold', INK);
  tableCell(page, row, 24, 1, 1, sub, 'Ürün Adı', 'bold', INK);
  tableCell(page, row, 24, 2, 2, sub, 'Adet', 'bold', INK, 'right');
  tableCell(page, row, 24, 3, 3, sub, 'Birim Fiyat (₺)', 'bold', INK, 'right');
  tableCell(page, row, 24, 4, 4, sub, 'Toplam (₺)', 'bold', INK, 'right');
  return row + 24;
}

/** Data rows `[from, to)` starting at `y`; returns the y below the last. */
function tableRows(page: PageBuilder, y: number, from: number, to: number): number {
  let row = y;
  for (let index = from; index < to; index += 1) {
    const product = TABLE_PRODUCTS[index];
    if (product === undefined) throw new Error('table sample: missing product row');
    const [code, name, quantity, price] = product;
    const fill: Rgb | undefined = index % 2 === 1 ? [243, 246, 251] : undefined;
    tableCell(page, row, 26, 0, 0, fill, code, 'regular', INK);
    tableCell(page, row, 26, 1, 1, fill, name, 'regular', INK);
    tableCell(page, row, 26, 2, 2, fill, formatTurkish(quantity), 'regular', INK, 'right');
    tableCell(page, row, 26, 3, 3, fill, formatTurkish(price, 2), 'regular', INK, 'right');
    tableCell(page, row, 26, 4, 4, fill, formatTurkish(quantity * price, 2), 'regular', INK, 'right');
    row += 26;
  }
  return row;
}

function buildTable(pdf: SamplePdf): void {
  const left = 40;
  const width = 515.28;
  const first = pdf.addPage();
  first.text(left, 70, 20, 'bold', NAVY, 'Çevrimiçi Mağaza Satış Raporu');
  first.text(left, 90, 11, 'semibold', TEAL, '2026 üçüncü çeyrek  |  Ürün bazında özet');
  first.line(left, 102, left + width, 102, { stroke: TEAL, lineWidth: 1.5 });
  const after = first.paragraph(
    left,
    128,
    width,
    10.5,
    15,
    'regular',
    INK,
    'Bu rapor, 2026 yılının üçüncü çeyreğinde çevrimiçi mağazamızda satılan ürünlerin adet, birim fiyat ve toplam gelir bilgilerini özetler. Tüm tutarlar KDV hariç Türk lirası (₺) cinsindendir. Tablo ilk sayfada başlar ve ikinci sayfada devam eder.',
    { justify: true },
  );
  let y = tableHeader(first, after + 12);
  y = tableRows(first, y, 0, 7);
  first.text(left, y + 20, 9, 'italic', MUTED, 'Tablonun devamı bir sonraki sayfadadır.');
  first.line(left, 800, left + width, 800, { stroke: [200, 200, 205], lineWidth: 0.8 });
  first.text(left, 816, 8, 'regular', MUTED, 'Finans ve Raporlama Ekibi  •  Sayfa 1 / 2');

  const second = pdf.addPage();
  second.text(left, 60, 9.5, 'italic', MUTED, 'Çevrimiçi Mağaza Satış Raporu  (devam)');
  y = tableHeader(second, 76);
  y = tableRows(second, y, 7, TABLE_PRODUCTS.length);
  const totalQuantity = TABLE_PRODUCTS.reduce((sum, [, , quantity]) => sum + quantity, 0);
  const totalRevenue = TABLE_PRODUCTS.reduce((sum, [, , quantity, price]) => sum + quantity * price, 0);
  const totalFill: Rgb = [255, 243, 205];
  tableCell(second, y, 28, 0, 1, totalFill, 'Genel Toplam', 'bold', INK);
  tableCell(second, y, 28, 2, 2, totalFill, formatTurkish(totalQuantity), 'bold', INK, 'right');
  tableCell(second, y, 28, 3, 3, totalFill, '', 'bold', INK, 'right');
  tableCell(second, y, 28, 4, 4, totalFill, formatTurkish(totalRevenue, 2), 'bold', INK, 'right');
  second.paragraph(
    left,
    y + 60,
    width,
    10.5,
    15,
    'regular',
    INK,
    'Değerlendirme: Çeyrek boyunca en yüksek gelir çalışma masası ve ofis sandalyesi satışlarından geldi. Ekran koruyucu en çok adet satılan ürün olsa da toplam gelire katkısı sınırlı kaldı. Dördüncü çeyrekte kampanya dönemi nedeniyle adetlerde artış bekleniyor.',
    { justify: true },
  );
  second.text(left, y + 140, 10, 'semibold', INK, 'Hazırlayan: Finans ve Raporlama Ekibi');
  second.line(left, 800, left + width, 800, { stroke: [200, 200, 205], lineWidth: 0.8 });
  second.text(left, 816, 8, 'regular', MUTED, 'Finans ve Raporlama Ekibi  •  Sayfa 2 / 2');
}

// ---------------------------------------------------------------------------
// 4. form: a static, drawn application form
// ---------------------------------------------------------------------------

function buildForm(pdf: SamplePdf): void {
  const page = pdf.addPage();
  const left = 40;
  const width = 515.28;
  const boxLine: Rgb = [70, 78, 90];

  page.rect(0, 0, A4.width, 92, { fill: NAVY });
  page.text(left, 52, 22, 'bold', WHITE, 'Staj Başvuru Formu');
  page.text(
    left,
    74,
    10.5,
    'regular',
    [205, 218, 238],
    'Lütfen formu büyük harflerle ve eksiksiz doldurunuz.',
  );

  /** A caption above an empty box. */
  const field = (x: number, y: number, w: number, h: number, label: string): void => {
    page.text(x, y - 5, 8.5, 'semibold', MUTED, label);
    page.rect(x, y, w, h, { stroke: boxLine, lineWidth: 0.9 });
  };
  /** A small square, crossed when `checked`, with its label to the right. */
  const checkbox = (x: number, y: number, label: string, checked: boolean): void => {
    page.rect(x, y, 11, 11, { stroke: boxLine, lineWidth: 1 });
    if (checked) {
      page.line(x + 2.2, y + 2.2, x + 8.8, y + 8.8, { stroke: INK, lineWidth: 1.4 });
      page.line(x + 8.8, y + 2.2, x + 2.2, y + 8.8, { stroke: INK, lineWidth: 1.4 });
    }
    page.text(x + 17, y + 9, 10, 'regular', INK, label);
  };
  const heading = (y: number, title: string): void => {
    page.text(left, y, 12, 'bold', TEAL, title);
    page.line(left, y + 6, left + width, y + 6, { stroke: TEAL, lineWidth: 1 });
  };

  heading(130, '1. Kişisel Bilgiler');
  field(left, 164, 250, 26, 'Ad Soyad');
  field(left + 265, 164, 250.28, 26, 'T.C. Kimlik No');
  field(left, 220, 160, 26, 'Doğum Tarihi');
  field(left + 175, 220, 160, 26, 'Doğum Yeri');
  field(left + 350, 220, 165.28, 26, 'Cep Telefonu');
  field(left, 276, 515.28, 26, 'E-posta Adresi');
  field(left, 332, 515.28, 54, 'Ev Adresi');

  heading(424, '2. Eğitim Bilgileri');
  field(left, 458, 330, 26, 'Üniversite');
  field(left + 345, 458, 170.28, 26, 'Not Ortalaması');
  field(left, 514, 330, 26, 'Bölüm');
  page.text(left + 345, 509, 8.5, 'semibold', MUTED, 'Sınıf');
  checkbox(left + 345, 520, '2', false);
  checkbox(left + 385, 520, '3', true);
  checkbox(left + 425, 520, '4', false);

  heading(576, '3. Tercihler');
  checkbox(left, 598, 'Yarı zamanlı çalışabilirim', true);
  checkbox(left + 260, 598, 'Tam zamanlı çalışabilirim', false);
  checkbox(left, 620, 'Uzaktan çalışmayı tercih ederim', true);
  checkbox(left + 260, 620, 'Hafta sonu çalışabilirim', false);

  page.paragraph(
    left,
    662,
    width,
    9.5,
    13.5,
    'italic',
    MUTED,
    'Yukarıda verdiğim bilgilerin doğru olduğunu, yanlış beyanın başvurumun geçersiz sayılmasına yol açacağını ve kişisel verilerimin yalnızca başvuru sürecinde kullanılacağını kabul ederim.',
  );

  page.line(left, 748, left + 220, 748, { stroke: INK, lineWidth: 0.9 });
  page.text(left, 762, 9, 'regular', MUTED, 'Başvuru sahibinin imzası');
  page.line(left + 300, 748, left + 515.28, 748, { stroke: INK, lineWidth: 0.9 });
  page.text(left + 300, 762, 9, 'regular', MUTED, 'Tarih (gg.aa.yyyy)');

  page.line(left, 794, left + width, 794, { stroke: [200, 200, 205], lineWidth: 0.8 });
  page.text(
    left,
    812,
    8,
    'regular',
    MUTED,
    'Form No: İK-2026/04  •  Gizlilik: Bu form yalnızca insan kaynakları tarafından işlenir.  •  Sayfa 1 / 1',
  );
}

// ---------------------------------------------------------------------------
// 5. cards: a dashboard of rounded cards
// ---------------------------------------------------------------------------

function buildCards(pdf: SamplePdf): void {
  const page = pdf.addPage();
  page.rect(0, 0, A4.width, A4.height, { fill: [233, 238, 247] });
  page.text(40, 62, 24, 'bold', NAVY, 'Genel Bakış Panosu');
  page.text(40, 84, 11, 'regular', MUTED, 'Ekim 2026  •  Son 30 günün özeti');

  const cards: readonly {
    readonly title: string;
    readonly color: Rgb;
    readonly value: string;
    readonly label: string;
    readonly delta: string;
    readonly bars: readonly number[];
  }[] = [
    {
      title: 'Aktif Kullanıcılar',
      color: [32, 100, 190],
      value: '12.480',
      label: 'aylık aktif kullanıcı',
      delta: '+%8,4 geçen aya göre',
      bars: [30, 38, 34, 46, 52, 58, 66],
    },
    {
      title: 'Aylık Gelir',
      color: [28, 130, 84],
      value: '₺ 1,92 M',
      label: 'KDV hariç toplam gelir',
      delta: '+%12,1 geçen aya göre',
      bars: [40, 36, 48, 52, 50, 62, 70],
    },
    {
      title: 'Yeni Siparişler',
      color: [200, 100, 20],
      value: '3.275',
      label: 'tamamlanan sipariş',
      delta: '+%3,7 geçen aya göre',
      bars: [52, 48, 56, 50, 58, 54, 62],
    },
    {
      title: 'Destek Talepleri',
      color: [112, 64, 170],
      value: '418',
      label: 'açık destek talebi',
      delta: '−%5,2 geçen aya göre',
      bars: [66, 60, 62, 54, 50, 46, 40],
    },
    {
      title: 'Müşteri Memnuniyeti',
      color: [0, 124, 138],
      value: '%94,6',
      label: 'ortalama memnuniyet',
      delta: '+%1,3 geçen aya göre',
      bars: [56, 58, 57, 60, 61, 63, 64],
    },
    {
      title: 'Sunucu Çalışma Süresi',
      color: [176, 52, 60],
      value: '%99,97',
      label: 'kesintisiz çalışma',
      delta: '−%0,02 geçen aya göre',
      bars: [64, 64, 63, 64, 64, 62, 64],
    },
  ];

  const gap = 20;
  const cardWidth = (A4.width - 80 - gap) / 2;
  const cardHeight = 204;
  for (const [index, card] of cards.entries()) {
    const x = 40 + (index % 2) * (cardWidth + gap);
    const y = 116 + Math.floor(index / 2) * (cardHeight + gap);
    // a faint shadow, the white card, then the coloured band with square lower corners
    page.roundRect(x + 2, y + 3, cardWidth, cardHeight, 14, { fill: [0, 0, 0], opacity: 0.08 });
    page.roundRect(x, y, cardWidth, cardHeight, 14, { fill: WHITE });
    page.roundRect(x, y, cardWidth, 52, 14, { fill: card.color });
    page.rect(x, y + 26, cardWidth, 26, { fill: card.color });
    page.text(x + 18, y + 31, 13, 'semibold', WHITE, card.title);
    // an icon-like vector badge: a translucent disc with a solid dot and ring
    page.circle(x + cardWidth - 32, y + 26, 16, { fill: WHITE, opacity: 0.25 });
    page.circle(x + cardWidth - 32, y + 26, 8, { stroke: WHITE, lineWidth: 2 });
    page.circle(x + cardWidth - 32, y + 26, 3, { fill: WHITE });
    page.text(x + 18, y + 106, 30, 'bold', card.color, card.value);
    page.text(x + 18, y + 126, 10.5, 'regular', MUTED, card.label);
    page.text(
      x + 18,
      y + 152,
      9.5,
      'semibold',
      card.delta.startsWith('+') ? [28, 130, 84] : [176, 52, 60],
      card.delta,
    );
    // a small bar chart
    for (const [bar, height] of card.bars.slice(1).entries()) {
      const barHeight = height * 0.55;
      page.roundRect(x + cardWidth - 86 + bar * 12, y + cardHeight - 22 - barHeight, 8, barHeight, 2, {
        fill: card.color,
        opacity: 0.55,
      });
    }
  }
  page.text(40, 820, 8, 'regular', MUTED, 'Veriler her gece 03:00’te güncellenir.');
}

// ---------------------------------------------------------------------------
// 6. text-over-image: a full-bleed picture, text and a translucent band
// ---------------------------------------------------------------------------

/** Colour stops of the sky, from the zenith to the horizon. */
const SKY: readonly (readonly [number, Rgb])[] = [
  [0, [14, 22, 74]],
  [0.3, [78, 48, 124]],
  [0.46, [214, 98, 92]],
  [0.56, [250, 176, 98]],
  [0.62, [255, 226, 160]],
];

/** A dusk skyline-and-hills picture, full page. */
function duskPicture(pdf: SamplePdf): MuPixmap {
  const width = 600;
  const height = 850;
  const hill = (x: number, base: number, a: number, b: number, c: number): number =>
    base + a * Math.sin(x / 61 + c) + b * Math.sin(x / 19 + c * 2.3);
  return pdf.pixmap(width, height, (x, y) => {
    const t = y / height;
    let from = SKY[0] as (typeof SKY)[number];
    let to = SKY[SKY.length - 1] as (typeof SKY)[number];
    for (let stop = 0; stop < SKY.length - 1; stop += 1) {
      const a = SKY[stop] as (typeof SKY)[number];
      const b = SKY[stop + 1] as (typeof SKY)[number];
      if (t >= a[0] && t <= b[0]) {
        from = a;
        to = b;
        break;
      }
    }
    const mix = Math.min(1, Math.max(0, (t - from[0]) / (to[0] - from[0] || 1)));
    const sky = [0, 1, 2].map(
      (channel) => (from[1][channel] ?? 0) + ((to[1][channel] ?? 0) - (from[1][channel] ?? 0)) * mix,
    );
    // the sun's glow sitting on the horizon
    const glow = Math.exp(-(((x - 300) / 160) ** 2 + ((y - 520) / 90) ** 2));
    let color: Rgb = [
      Math.min(255, Math.round((sky[0] ?? 0) + 70 * glow)),
      Math.min(255, Math.round((sky[1] ?? 0) + 50 * glow)),
      Math.min(255, Math.round((sky[2] ?? 0) + 30 * glow)),
    ];
    const far = hill(x, 560, 26, 7, 0.4);
    const mid = hill(x, 620, 34, 9, 1.7);
    const near = hill(x, 700, 28, 12, 3.1);
    if (y > far) color = [86, 54, 92];
    if (y > mid) color = [52, 36, 70];
    if (y > near) color = [22, 18, 36];
    return color;
  });
}

function buildTextOverImage(pdf: SamplePdf): void {
  const page = pdf.addPage();
  page.image(0, 0, A4.width, A4.height, duskPicture(pdf));
  page.text(40, 118, 46, 'bold', WHITE, 'Boğaz’da');
  page.text(40, 170, 46, 'bold', WHITE, 'Gün Batımı');
  page.text(40, 208, 18, 'italic', [235, 235, 248], 'Işıkların şehre karıştığı o kısa an');
  page.text(40, 470, 24, 'semibold', [48, 24, 52], '“Her akşam şehir yeniden başlar.”');
  page.text(40, 494, 12, 'regular', [64, 36, 64], 'Üç kıtanın buluştuğu su yolundan notlar');

  // a translucent dark band behind the caption
  page.rect(0, 732, A4.width, 110, { fill: [0, 0, 0], opacity: 0.5 });
  page.text(40, 770, 16, 'bold', WHITE, 'Ortaköy’den Karaköy’e akşam ışığı');
  page.text(
    40,
    792,
    10.5,
    'regular',
    [225, 225, 235],
    'Görsel, bu depo için kodla üretilmiş yapay bir manzaradır.',
  );
  page.text(
    40,
    808,
    10.5,
    'regular',
    [225, 225, 235],
    'Güneşin batışı ile ilk köprü ışıkları arasındaki süre yaklaşık yirmi dakikadır.',
  );
}

// ---------------------------------------------------------------------------
// the set
// ---------------------------------------------------------------------------

/** Build one vector sample from a page-drawing function. */
async function vector(
  id: string,
  title: string,
  /** Draws the page; returns the words drawn inside pictures, if any. */
  draw: (pdf: SamplePdf) => unknown,
): Promise<FidelitySample> {
  const pdf = await SamplePdf.create();
  const drawn = await draw(pdf);
  const imageText = Array.isArray(drawn) ? (drawn as readonly string[]) : undefined;
  return {
    id,
    title,
    origin: 'generated',
    license: GENERATED_LICENSE,
    ocr: false,
    bytes: pdf.save(),
    ...(imageText === undefined ? {} : { imageText }),
  };
}

/** A scan of `source`: image-only, same page size, ground truth from the vector original's text. */
async function scanOf(
  source: FidelitySample,
  id: string,
  title: string,
  dpi = SCAN_DPI,
  defects: ScanDefects = {},
): Promise<FidelitySample> {
  return {
    id,
    title,
    origin: 'generated',
    license: GENERATED_LICENSE,
    ocr: true,
    bytes: await rasterizeToImagePdf(source.bytes, dpi, defects),
    groundTruth: await extractPageTexts(source.bytes),
  };
}

/** The generated samples: the vector pages, the graphics-heavy pages, then the scans. */
export async function generatedSamples(): Promise<FidelitySample[]> {
  const cv = await vector('cv', 'Résumé with sidebar, photo and hyperlinks', buildCv);
  const columns = await vector(
    'columns',
    'Magazine page with justified columns and pull quote',
    buildColumns,
  );
  const table = await vector('table', 'Ruled table with merged header, two pages', buildTable);
  const form = await vector('form', 'Application form with boxes and checkboxes', buildForm);
  const cards = await vector('cards', 'Dashboard of rounded cards on a coloured page', buildCards);
  const overImage = await vector(
    'text-over-image',
    'Text over a full-bleed picture with a translucent band',
    buildTextOverImage,
  );
  const shapes = await vector(
    'shapes',
    'Geometry: shapes, arrows, curves, dashes, a flow diagram',
    buildShapes,
  );
  const chart = await vector('chart', 'Vector charts: pie, bar and line with axes and legends', buildChart);
  const textInImage = await vector(
    'text-in-image',
    'Vector text plus two pictures that contain text',
    buildTextInImage,
  );
  const overlay = await vector(
    'overlay',
    'Photo with translucent band, gradient header, soft-masked emblem',
    buildOverlay,
  );
  const rotated = await vector(
    'rotated',
    'Rotated text, vertical table header, side labels and a stamp',
    buildRotated,
  );
  const mixedPage = await vector(
    'mixed-page',
    'Vector heading above a scanned typed paragraph',
    buildMixedPage,
  );
  const slide = await vector('slide', '16:9 slide with icons, placeholder and footer', buildSlide);
  const invoice = await vector(
    'invoice',
    'Invoice with logo, ruled table, totals and a QR-like grid',
    buildInvoice,
  );
  return [
    cv,
    columns,
    table,
    form,
    cards,
    overImage,
    await scanOf(cv, 'cv-scan', 'Résumé, scanned at 200 dpi (no text layer)'),
    await scanOf(cards, 'cards-scan', 'Dashboard cards, scanned at 200 dpi (no text layer)'),
    shapes,
    chart,
    textInImage,
    overlay,
    rotated,
    mixedPage,
    slide,
    invoice,
    await scanOf(shapes, 'shapes-scan', 'Geometry page, scanned at 200 dpi (no text layer)'),
    await scanOf(invoice, 'invoice-scan', 'Invoice, scanned at 200 dpi (no text layer)'),
    await scanOf(
      invoice,
      'invoice-scan-rough',
      'Invoice, rough scan: 150 dpi, skewed 2.5°, noisy, uneven light',
      ROUGH_SCAN_DPI,
      ROUGH_SCAN,
    ),
  ];
}
