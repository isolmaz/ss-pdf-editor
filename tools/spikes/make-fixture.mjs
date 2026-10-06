#!/usr/bin/env node
/**
 * Throwaway fixture generator for Phase 0 verification and the spike set.
 *
 * The owner's rule is explicit: PDFs are generated in code, never committed
 * (`tools/spikes/**` is the throwaway area; `PLAN.md §9/K21`). Output goes to a
 * temp directory, so nothing lands in the repository either.
 *
 * Usage: node tools/spikes/make-fixture.mjs [pages] [out]
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import { createFixture } from './mupdf-fixture.mjs';

const pages = Number.parseInt(process.argv[2] ?? '5', 10);
const directory = mkdtempSync(join(tmpdir(), 'pdf-editor-fixture-'));
const output = process.argv[3] ?? join(directory, `fixture-${pages}p.pdf`);

const document = createFixture(mupdf);
document.info({ Title: 'PDF Editor fixture', Author: 'isolmaz' });

// NOTE: the standard-14 Helvetica encodes WinAnsi only, so Turkish glyphs (ş, ğ, ı)
// need an embedded font (`embedFont`, as make-phase4-fixture.mjs does). This smoke
// fixture stays ASCII on purpose: it exercises the base-font path.
const turkish = [
  'Sozlesme taraflari, isbu belgeyi iki nusha olarak duzenlenmistir.',
  'Odemenin vadesi, fatura tarihinden itibaren otuz gundur.',
  'Gizlilik yukumlulugu, sozlesme sona erdikten sonra da devam eder.',
  'Isbu metin, PDF Editor Faz 0 dogrulamasi icin uretilmistir.',
];

for (let index = 0; index < pages; index += 1) {
  const page = document.addPage(595.28, 841.89);
  page.text(`Sayfa ${index + 1} / ${pages}`, {
    x: 60,
    y: 760,
    size: 18,
    color: [0.1, 0.15, 0.3],
  });
  for (let line = 0; line < 12; line += 1) {
    const text = turkish[(index + line) % turkish.length];
    page.text(`${text}  (${index + 1}.${line + 1})`, {
      x: 60,
      y: 720 - line * 24,
      size: 11,
      color: [0.15, 0.15, 0.15],
    });
  }
  page.rect({ x: 60, y: 420, width: 200, height: 60, color: [0.9, 0.93, 0.98] });
  page.text('IMZA', { x: 70, y: 445, size: 14, color: [0.2, 0.3, 0.6] });
}

const bytes = document.save();
writeFileSync(output, bytes);
console.log(`${output} (${pages} pages, ${(bytes.byteLength / 1024).toFixed(1)} KiB)`);
