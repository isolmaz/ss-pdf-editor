/**
 * Fixture built **in code** for spike #3 (throwaway, `PLAN.md §9/K21`).
 *
 * No PDF is committed and none is read from the repository: the six-page Turkish
 * fixture is drawn through MuPDF's `DocumentWriter` (device → content stream) with
 * a **real embedded font** supplied by the caller (the harness reads a system TTF
 * from `C:/Windows/Fonts` and copies it to a temp directory — see NOTES.md), then
 * reopened, subset with `subsetFonts()` and re-saved, so case (a) really exercises
 * an embedded **subset** font rather than a full embed.
 *
 * Page plan (all coordinates are MuPDF page space: origin top-left, y downward):
 *   0  case a  — normal paragraph, neighbours above and below
 *   1  case b  — text block rotated 90° counter-clockwise
 *   2  case b2 — page with /Rotate 90 carrying ordinary horizontal text
 *   3  case c  — table cell between rules, five neighbouring cells
 *   4  case d  — text drawn over an image
 *   5  duplicate of case a's first sentence + untouched control page
 */
import type { Mupdf, PdfDevice, PdfDoc, PdfFont } from './engine';
import type { Rect4, Vec2 } from './textmodel';

export interface Rule {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface CaseSpec {
  readonly id: string;
  readonly label: string;
  /** 0-based page index in the fixture */
  readonly page: number;
  /** line fragments that identify the block to erase (unique on that page) */
  readonly erasePhrases: readonly string[];
  /** Turkish replacement text; wrapped into the original block's box */
  readonly newText: string;
  readonly imageMethod: number;
  readonly lineArtMethod: number;
  readonly textMethod: number;
  /** rules that intersect the erase region (case c) */
  readonly rules?: readonly Rule[];
  /** image rectangle on the page (case d) */
  readonly imageRect?: Rect4;
  /** second erase attempt on a fresh copy: shows what the line-art policy changes */
  readonly contrast?: {
    readonly label: string;
    readonly region: Rect4;
    readonly lineArtMethod: number;
  };
}

export interface FontInfo {
  readonly page: number;
  readonly resource: string;
  readonly baseFont: string;
  readonly embedded: boolean;
  readonly subset: boolean;
  readonly embeddedBytes: number;
}

export interface Fixture {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly cases: readonly CaseSpec[];
  readonly bodySize: number;
  readonly leading: number;
  readonly duplicate: { readonly phrase: string; readonly page: number };
  readonly controlPage: number;
  readonly fontsBeforeSubset: readonly FontInfo[];
  readonly fontsAfterSubset: readonly FontInfo[];
  /** glyph id the embedded font reports for each Turkish character (0 = .notdef) */
  readonly coverage: readonly { readonly char: string; readonly gid: number }[];
}

export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const BODY_SIZE = 11;
export const LEADING = 18;
const DARK: [number, number, number] = [0.13, 0.13, 0.16];

/** Page 3 (case c) table geometry — shared with the case spec so the measurements line up. */
const TABLE_LEFT = 60;
const TABLE_COL1 = 207;
const TABLE_COL2 = 353;
const TABLE_RIGHT = 500;
const TABLE_ROW0 = 300;
const TABLE_ROW1 = 360;
const TABLE_ROW2 = 420;

const TABLE_RULES: readonly Rule[] = [
  { x1: TABLE_LEFT, y1: TABLE_ROW0, x2: TABLE_RIGHT, y2: TABLE_ROW0 },
  { x1: TABLE_LEFT, y1: TABLE_ROW1, x2: TABLE_RIGHT, y2: TABLE_ROW1 },
  { x1: TABLE_LEFT, y1: TABLE_ROW2, x2: TABLE_RIGHT, y2: TABLE_ROW2 },
  { x1: TABLE_LEFT, y1: TABLE_ROW0, x2: TABLE_LEFT, y2: TABLE_ROW2 },
  { x1: TABLE_COL1, y1: TABLE_ROW0, x2: TABLE_COL1, y2: TABLE_ROW2 },
  { x1: TABLE_COL2, y1: TABLE_ROW0, x2: TABLE_COL2, y2: TABLE_ROW2 },
  { x1: TABLE_RIGHT, y1: TABLE_ROW0, x2: TABLE_RIGHT, y2: TABLE_ROW2 },
];

/** Page 4 (case d) image rectangle. */
const IMAGE_RECT: Rect4 = [60, 200, 520, 400];

const CASE_A_TARGET = [
  'Gizlilik yükümlülüğü, sözleşme sona erdikten sonra da devam eder.',
  'Ödemenin vadesi, fatura tarihinden itibaren otuz gündür.',
  'Gecikme hâlinde aylık yüzde iki oranında temerrüt faizi uygulanır.',
];

const DUPLICATE_PHRASE = CASE_A_TARGET[0] as string;

export const CASE_SPECS: readonly CaseSpec[] = [
  {
    id: 'a',
    label: 'a · normal paragraph (embedded subset font)',
    page: 0,
    erasePhrases: ['Gizlilik yükümlülüğü', 'Ödemenin vadesi', 'Gecikme hâlinde'],
    newText:
      'Yeni madde: Bildirimler yazılı olarak yapılır ve tarafların kayıtlı adreslerine gönderilir; elektronik posta ile yapılan bildirimler de geçerli sayılır.',
    imageMethod: 0,
    lineArtMethod: 0,
    textMethod: 0,
  },
  {
    id: 'b',
    label: 'b · text block rotated 90° (counter-clockwise)',
    page: 1,
    erasePhrases: ['taraflarca ayrıca imzalanır', 'yalnızca tarafların kayıtları'],
    newText:
      'EKLER: Sözleşme ekleri, imza tarihinde taraflara ayrıca teslim edilir; ekleri imzalanmamış belge geçersiz sayılır.',
    imageMethod: 0,
    lineArtMethod: 0,
    textMethod: 0,
  },
  {
    id: 'b2',
    label: 'b2 · page with /Rotate 90',
    page: 2,
    erasePhrases: ['Döndürülmüş sayfa üzerindeki hedef', 'Bu ikinci satır'],
    newText:
      'Döndürülmüş sayfada yeni metin, koordinat dönüşümü doğru uygulandığında yerine oturur ve seçilebilir kalır.',
    imageMethod: 0,
    lineArtMethod: 0,
    textMethod: 0,
  },
  {
    id: 'c',
    label: 'c · table cell between rules',
    page: 3,
    erasePhrases: ['Teslim, 30 Eylül 2026', 'yapılacaktır'],
    newText: 'Teslim tarihi 15 Ekim 2026 olarak güncellendi.',
    imageMethod: 0,
    lineArtMethod: 0,
    textMethod: 0,
    rules: TABLE_RULES,
    contrast: {
      label: 'c-contrast · whole cell erased with line_art = REMOVE_IF_TOUCHED',
      region: [TABLE_COL1, TABLE_ROW0, TABLE_COL2, TABLE_ROW1],
      lineArtMethod: 2,
    },
  },
  {
    id: 'd',
    label: 'd · text over an image',
    page: 4,
    erasePhrases: ['Bu metin görselin üzerine', 'Silinip yeniden yazıldığında'],
    newText: 'Görselin üzerindeki metin yenilendi; arkadaki görsel bozulmadan korundu.',
    imageMethod: 0,
    lineArtMethod: 0,
    textMethod: 0,
    imageRect: IMAGE_RECT,
  },
];

/** Draw helpers bound to the fixture font; the device's space is MuPDF page space. */
function createPainter(mupdf: Mupdf, font: PdfFont) {
  return {
    text(device: PdfDevice, str: string, x: number, y: number, size = BODY_SIZE, direction: Vec2 = [1, 0]) {
      const [dx, dy] = direction;
      const text = new mupdf.Text();
      text.showString(font, [dx * size, dy * size, dy * size, -dx * size, x, y], str);
      device.fillText(text, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, DARK, 1);
      text.destroy();
    },
    rule(device: PdfDevice, value: Rule, width = 0.8) {
      const path = new mupdf.Path();
      path.moveTo(value.x1, value.y1);
      path.lineTo(value.x2, value.y2);
      const stroke = new mupdf.StrokeState({
        lineCap: 'Butt',
        lineJoin: 'Miter',
        lineWidth: width,
        miterLimit: 1,
      });
      device.strokePath(
        path,
        stroke,
        mupdf.Matrix.identity,
        mupdf.ColorSpace.DeviceRGB,
        [0.25, 0.25, 0.3],
        1,
      );
      path.destroy();
      stroke.destroy();
    },
    image(device: PdfDevice, rect: Rect4) {
      const width = Math.round(rect[2] - rect[0]);
      const height = Math.round(rect[3] - rect[1]);
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
      const pixels = pixmap.getPixels();
      const stride = pixmap.getStride();
      const components = pixmap.getNumberOfComponents();
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = y * stride + x * components;
          const stripe = (x + y) % 26 < 3 ? 30 : 0;
          const border = x < 4 || y < 4 || x > width - 5 || y > height - 5 ? -60 : 0;
          pixels[i] = 235 - Math.round((y / height) * 60) + stripe + border;
          pixels[i + 1] = 238 - Math.round((x / width) * 30) + stripe + border;
          pixels[i + 2] = 246 - Math.round((x / width) * 70) + stripe + border;
        }
      }
      const image = new mupdf.Image(pixmap);
      device.fillImage(image, [rect[2] - rect[0], 0, 0, rect[3] - rect[1], rect[0], rect[1]], 1);
      image.destroy();
      pixmap.destroy();
    },
  };
}

/** `ABCDEF+ArialMT` → subset; bare `ArialMT` → full embed. */
export function describeFontName(baseFont: string): { subset: boolean; family: string } {
  const match = /^([A-Z]{6})\+(.*)$/.exec(baseFont);
  return match ? { subset: true, family: match[2] ?? baseFont } : { subset: false, family: baseFont };
}

/** Fonts as they appear in a page's resources, with the embedded program's size. */
export function inspectFonts(doc: PdfDoc, pageIndex: number): FontInfo[] {
  const page = doc.loadPage(pageIndex);
  const fonts = page.getObject().getInheritable('Resources').get('Font');
  const result: FontInfo[] = [];
  fonts.forEach((value, key) => {
    if (typeof key !== 'string') return;
    const baseFont = value.get('BaseFont').asName();
    const descendants = value.get('DescendantFonts');
    const descriptor = descendants.isArray()
      ? descendants.get(0).get('FontDescriptor')
      : value.get('FontDescriptor');
    const file = ['FontFile2', 'FontFile3', 'FontFile']
      .map((key2) => descriptor.get(key2))
      .find((candidate) => !candidate.isNull());
    const length = file?.get('Length');
    const { subset } = describeFontName(baseFont);
    result.push({
      page: pageIndex,
      resource: key,
      baseFont,
      embedded: file !== undefined,
      subset,
      embeddedBytes: file === undefined || length === undefined || length.isNull() ? 0 : length.asNumber(),
    });
  });
  page.destroy();
  return result;
}

/**
 * Glyph id the saved fixture's embedded font reports for a character. MuPDF.js has no
 * "load font from page resources" call, so the font object is taken from the page's
 * structured text; 0 means `.notdef` (glyph absent from the embedded subset).
 */
export function readGlyphId(doc: PdfDoc, char: string): number {
  const page = doc.loadPage(0);
  const stext = page.toStructuredText('preserve-whitespace');
  let gid = -1;
  stext.walk({
    onChar(_c, _origin, font, _size, _quad, _color, _bidi) {
      if (gid < 0) gid = font.encodeCharacter(char);
    },
  });
  stext.destroy();
  page.destroy();
  return gid;
}

export async function buildFixture(mupdf: Mupdf, fontBytes: Uint8Array, fontName: string): Promise<Fixture> {
  const font = new mupdf.Font(fontName, fontBytes);
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', 'compress');
  const painter = createPainter(mupdf, font);
  const mediaBox: Rect4 = [0, 0, PAGE_WIDTH, PAGE_HEIGHT];

  // Page 0 — case a: paragraph with neighbours above and below.
  {
    const device = writer.beginPage(mediaBox);
    painter.text(device, 'Sözleşme Özeti', 60, 70, 16);
    painter.text(device, 'Bu sözleşme, tarafların karşılıklı hak ve yükümlülüklerini düzenler.', 60, 120);
    painter.text(
      device,
      'Sözleşmenin konusu, aşağıda belirtilen hizmetlerin sunulmasıdır.',
      60,
      120 + LEADING,
    );
    CASE_A_TARGET.forEach((line, index) => {
      painter.text(device, line, 60, 300 + index * LEADING);
    });
    painter.text(device, 'Taraflar, işbu sözleşmeyi iki nüsha olarak düzenlemiştir.', 60, 420);
    painter.text(device, 'Uyuşmazlıklarda İstanbul mahkemeleri yetkilidir.', 60, 420 + LEADING);
    writer.endPage();
  }

  // Page 1 — case b: 90° counter-clockwise block on the left margin.
  {
    const device = writer.beginPage(mediaBox);
    painter.text(device, 'Bu sayfa, seçili bloğun doksan derece döndürüldüğü durumu sınar.', 240, 200);
    painter.text(device, 'Döndürülmüş blok, sayfanın sol kenarında yer alır.', 240, 640);
    painter.text(device, 'Komşu metin, bloğun sağında kalır ve değişmemelidir.', 240, 640 + LEADING);
    painter.text(
      device,
      'EKLER: Sözleşme ekleri, taraflarca ayrıca imzalanır.',
      100,
      760,
      BODY_SIZE,
      [0, -1],
    );
    painter.text(
      device,
      'Not: Bu bölüm yalnızca tarafların kayıtları içindir.',
      100 - LEADING,
      760,
      BODY_SIZE,
      [0, -1],
    );
    writer.endPage();
  }

  // Page 2 — case b2: ordinary horizontal text on a page whose /Rotate becomes 90.
  {
    const device = writer.beginPage(mediaBox);
    painter.text(device, 'Döndürülmüş sayfa, koordinat dönüşümünü sınar.', 60, 150);
    painter.text(device, 'Döndürülmüş sayfa üzerindeki hedef paragraf buradadır.', 60, 200);
    painter.text(device, 'Bu ikinci satır da silinip yeniden yazılmalıdır.', 60, 200 + LEADING);
    painter.text(device, 'Komşu paragraf, hedefin altında kalır ve korunmalıdır.', 60, 300);
    painter.text(device, 'Sayfa döndürme değeri değişmemelidir.', 60, 300 + LEADING);
    writer.endPage();
  }

  // Page 3 — case c: 2×3 table of rules with the target cell in the middle.
  {
    const device = writer.beginPage(mediaBox);
    painter.text(device, 'Ödeme Planı', 60, 220, 14);
    for (const rule of TABLE_RULES) painter.rule(device, rule);
    const cell = (column: number, str: string, line: number) =>
      painter.text(device, str, column + 8, 328 + line * 14, 10);
    cell(TABLE_COL1 + 1, 'Teslim, 30 Eylül 2026 tarihinde', 0);
    cell(TABLE_COL1 + 1, 'yapılacaktır.', 1);
    cell(TABLE_LEFT + 8, 'Mal bedeli', 0);
    cell(TABLE_LEFT + 8, '12.500 TL', 1);
    cell(TABLE_COL2 + 8, 'Ödeme koşulu', 0);
    cell(TABLE_COL2 + 8, 'Peşin', 1);
    cell(TABLE_LEFT + 8, 'Vergi', 2.14);
    cell(TABLE_LEFT + 8, '%20', 3.14);
    cell(TABLE_COL1 + 8, 'Fatura', 2.14);
    cell(TABLE_COL1 + 8, 'e-Arşiv', 3.14);
    cell(TABLE_COL2 + 8, 'Süre', 2.14);
    cell(TABLE_COL2 + 8, '30 gün', 3.14);
    painter.text(
      device,
      'Tablodaki hücreler çizgilerle ayrılmıştır ve komşu hücreler korunmalıdır.',
      60,
      470,
    );
    writer.endPage();
  }

  // Page 4 — case d: text over an image.
  {
    const device = writer.beginPage(mediaBox);
    painter.text(device, 'Görsel üzerindeki metin ayrı bir katman olarak yazılmıştır.', 60, 150);
    painter.image(device, IMAGE_RECT);
    painter.text(device, 'Bu metin görselin üzerine yazılmıştır.', 80, 260);
    painter.text(device, 'Silinip yeniden yazıldığında görsel korunmalıdır.', 80, 260 + LEADING);
    painter.text(device, 'Görselin altındaki paragraf değişmemelidir.', 60, 430);
    painter.text(device, 'Bu satır da aynı şekilde korunmalıdır.', 60, 430 + LEADING);
    writer.endPage();
  }

  // Page 5 — duplicate of case a's first sentence + untouched control page.
  {
    const device = writer.beginPage(mediaBox);
    painter.text(device, DUPLICATE_PHRASE, 60, 100);
    painter.text(device, 'Karşı tarafın yazılı onayı olmadan bu sözleşme devredilemez.', 60, 100 + LEADING);
    painter.text(device, 'Ekler, sözleşmenin ayrılmaz bir parçasıdır.', 60, 100 + 2 * LEADING);
    writer.endPage();
  }

  writer.close();
  const draft = new Uint8Array(buffer.asUint8Array());
  buffer.destroy();
  font.destroy();

  const draftDoc = mupdf.PDFDocument.openDocument(draft, 'application/pdf') as PdfDoc;
  const pageCount = draftDoc.countPages();
  const fontsBeforeSubset = [0, 1, 2].flatMap((index) => inspectFonts(draftDoc, index));
  draftDoc.subsetFonts();
  draftDoc.loadPage(2).getObject().put('Rotate', 90);
  const output = draftDoc.saveToBuffer('garbage=compact,compress');
  const bytes = new Uint8Array(output.asUint8Array());
  output.destroy();

  const check = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as PdfDoc;
  const fontsAfterSubset = [0, 1, 2, 3, 4].flatMap((index) => inspectFonts(check, index));
  const coverage = ['ı', 'İ', 'ş', 'ğ', 'ü', 'ö', 'ç', 'â', 'Q'].map((char) => ({
    char,
    gid: readGlyphId(check, char),
  }));
  check.destroy();
  draftDoc.destroy();

  return {
    bytes,
    pageCount,
    cases: CASE_SPECS,
    bodySize: BODY_SIZE,
    leading: LEADING,
    duplicate: { phrase: DUPLICATE_PHRASE, page: 5 },
    controlPage: 5,
    fontsBeforeSubset,
    fontsAfterSubset,
    coverage,
  };
}
