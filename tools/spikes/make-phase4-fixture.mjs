#!/usr/bin/env node
/**
 * Phase 4 fixture builder — throwaway tooling.
 *
 *   node tools/spikes/make-phase4-fixture.mjs [--out <path>] [--replace-image <path>]
 *
 * Builds the one document every Phase 4 check runs against, so the evidence is
 * reproducible from the repository alone. It exists because Phase 4's items each
 * need a *different* kind of content, and a fixture that only carries one of them
 * forces a session reset between checks — the exact ordering coupling that broke
 * the Phase 3 driver.
 *
 * Page 1  a Turkish paragraph drawn in an **embedded subset font** (Noto Sans), with
 *         the sentinel word `KADIKÖY` in the middle of it — the text-edit target.
 * Page 2  a second paragraph carrying the *same* sentinel, so the acceptance check
 *         can prove that only the targeted occurrence disappeared.
 * Page 3  a bitmap image at a known rectangle — the image-editing target.
 * Page 4  a `/URI` link annotation and a two-entry outline — link + outline editing.
 * Page 5  a text form field — the fill-path regression that the other phases rely on.
 *
 * `--replace-image` writes the small RGB image the image-replace check feeds in and
 * exits, so the same generator produces both sides of that operation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import * as mupdf from 'mupdf';
import { createFixture } from './mupdf-fixture.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

export const SENTINEL = 'KADIKÖY';
export const REPLACEMENT = 'ÜSKÜDAR';
/** The image's placement on page 3 (0-based page 2), in PDF user space. */
export const IMAGE_RECT = { x: 80, y: 420, width: 240, height: 150 };
export const LINK_RECT = { x: 72, y: 700, width: 180, height: 18 };

const NOTO_SANS = join(ROOT, 'public', 'fonts', 'noto', 'NotoSans-Regular.ttf');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG, so the image path decodes a real format rather than a stub. */
export function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y, width, height);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      at += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildFixture(path) {
  const pdf = createFixture(mupdf);
  const noto = pdf.embedFont('NotoSans', readFileSync(NOTO_SANS));
  const ink = [0.08, 0.08, 0.12];

  const page1 = pdf.addPage(595.28, 841.89);
  page1.text('Phase 4 text fixture', { x: 64, y: 770, size: 18 });
  const paragraph = [
    'Belge içeriği yalnızca cihazda işlenir; hiçbir veri',
    `sunucuya gönderilmez. ${SENTINEL} şubesi bu kuralı`,
    'istisnasız uygular ve arşivini yerel tutar.',
  ];
  paragraph.forEach((line, index) => {
    page1.text(line, { x: 64, y: 720 - index * 22, size: 12, font: noto, color: ink });
  });

  const page2 = pdf.addPage(595.28, 841.89);
  page2.text('Phase 4 untouched occurrence', { x: 64, y: 770, size: 18 });
  page2.text(`${SENTINEL} şubesi ikinci sayfada aynen kalmalıdır.`, {
    x: 64,
    y: 720,
    size: 12,
    font: noto,
    color: ink,
  });

  const page3 = pdf.addPage(595.28, 841.89);
  page3.text('Phase 4 image fixture', { x: 64, y: 770, size: 18 });
  const png = makePng(240, 150, (x, y, width, height) => [
    Math.round((x / width) * 255),
    Math.round((y / height) * 255),
    x < width / 2 && y < height / 2 ? 40 : 200,
  ]);
  page3.image(png, IMAGE_RECT);

  const page4 = pdf.addPage(595.28, 841.89);
  page4.text('Phase 4 structure fixture', { x: 64, y: 770, size: 18 });
  // Noto Sans, not Helvetica: standard-14 fonts are WinAnsi and cannot encode
  // `ı`/`ş`/`ğ` — the same reason the text engine's insert path embeds a font.
  page4.text('Yapı bağlantısı', { x: LINK_RECT.x, y: LINK_RECT.y, size: 12, font: noto });
  page4.link(
    [LINK_RECT.x, LINK_RECT.y - 4, LINK_RECT.x + LINK_RECT.width, LINK_RECT.y + LINK_RECT.height - 4],
    'https://pdf.isolmaz.com/',
  );

  const page5 = pdf.addPage(595.28, 841.89);
  page5.text('Phase 4 form fixture', { x: 64, y: 770, size: 18 });
  page5.textField('musteri', [64, 700, 284, 724], 'Ada Lovelace');

  // `newString` writes UTF-16BE where PDFDocEncoding has no slot: 'İ' would otherwise
  // come back as '0kinci' and the outline surface would show mojibake.
  pdf.outline([
    { title: 'Birinci bölüm', page: page1 },
    { title: 'İkinci bölüm', page: page2 },
  ]);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pdf.save());
  return path;
}

const replacePath = readArg('--replace-image', null);
if (replacePath !== null) {
  writeFileSync(
    resolve(replacePath),
    makePng(120, 80, (x, y, width, height) => [
      x < width / 2 ? 250 : 20,
      y < height / 2 ? 20 : 250,
      Math.round(((x + y) / (width + height)) * 255),
    ]),
  );
  console.log(`replace image written: ${resolve(replacePath)}`);
} else {
  const out = resolve(readArg('--out', join(tmpdir(), 'phase4-fixture.pdf')));
  const built = buildFixture(out);
  console.log(`phase 4 fixture: ${built}`);
}
