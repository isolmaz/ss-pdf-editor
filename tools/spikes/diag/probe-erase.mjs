#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/**
 * Throwaway probe: does the text-edit erase actually remove glyphs?
 *
 *   node tools/spikes/diag/probe-erase.mjs
 *
 * Runs the real reader → model → plan → writer chain in Node (every package in it is
 * DOM-free by design), with an **erase-only** plan for the fixture's paragraph. No
 * browser is involved, so the loop is seconds instead of minutes — and the assertion
 * is the same one the acceptance harness makes: the exported bytes lost the targeted
 * occurrence and kept the untouched one on the next page.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(tmpdir(), 'pdf-editor-erase-probe');
mkdirSync(dir, { recursive: true });
const fixture = join(dir, 'fixture.pdf');
spawnSync(process.execPath, [join(ROOT, 'tools/spikes/make-phase4-fixture.mjs'), '--out', fixture], {
  cwd: ROOT,
  stdio: 'inherit',
});

const { readPageText } = await import('../../../packages/pdf-core/src/text-source.ts');
const { buildTextPage, measureEditability, planTextEdit } = await import(
  '../../../packages/pdf-text-engine/src/index.ts'
);
const { createFontCatalog } = await import('../../../packages/pdf-text-engine/src/fonts.ts');
const { applyTextEdit } = await import('../../../packages/pdf-core/src/ops/text-edit.ts');

const bytes = new Uint8Array(readFileSync(fixture));
const context = { signal: new AbortController().signal };

const source = await readPageText(bytes, 0, context);
console.log('page', source.pageIndex, `${source.width}×${source.height}`, 'rotation', source.rotation);
console.log('blocks', source.blocks.length);
for (const [index, block] of source.blocks.entries()) {
  console.log(
    `  b${index}`,
    `[${block.quads ?? ''}]`,
    JSON.stringify(block.lines.map((line) => line.chars.map((char) => char.ch).join('')).join(' | ')).slice(
      0,
      140,
    ),
  );
}

const model = buildTextPage(source);
const report = measureEditability(model);
console.log(
  'editability',
  JSON.stringify(report.blocks.map((entry) => `${entry.blockId}:${entry.verdict}/${entry.reason}`)),
);

const target = model.blocks.find((block) => block.text.includes('KADIKÖY'));
if (target === undefined) throw new Error('no block carries the sentinel');
console.log('target', target.id, 'rect', JSON.stringify(target.rect), 'lines', target.lines.length);
for (const line of target.lines)
  console.log('   line rect', JSON.stringify(line.rect), JSON.stringify(line.text.slice(0, 40)));

const metrics = createFontCatalog([]).metrics;
const request = planTextEdit({ page: model, blockId: target.id, replacement: '' }, metrics);
console.log('plan erase rects', JSON.stringify(request.erase[0]?.rects ?? []));
console.log('plan insert groups', request.insert.length);

const outcome = await applyTextEdit(bytes, { ...request, fonts: {} }, context);
console.log('report steps', JSON.stringify(outcome.report.steps));
console.log('notes', JSON.stringify(outcome.report.notes.map((note) => `${note.kind}:${note.key}`)));
const produced = join(dir, 'erased.pdf');
writeFileSync(produced, outcome.bytes);
console.log('wrote', produced, outcome.bytes.length, 'bytes');

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(produced)),
  useSystemFonts: false,
  isEvalSupported: false,
}).promise;
for (const index of [1, 2]) {
  const page = await doc.getPage(index);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join('|');
  console.log(`page ${index}:`, text.slice(0, 200));
}
await doc.cleanup();
