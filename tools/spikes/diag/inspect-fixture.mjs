#!/usr/bin/env node
/**
 * Throwaway fixture inspector — reads a PDF with MuPDF's object model and prints the
 * facts the Phase 4 checks assert on (page count, outline, annotations, form values,
 * image resources). Kept because "the harness said so" is weaker evidence than the file.
 *
 *   node tools/spikes/diag/inspect-fixture.mjs <file.pdf> [--text <substring>]
 */
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { readFixture } from '../mupdf-fixture.mjs';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: inspect-fixture.mjs <file.pdf> [--text <substring>]');
  process.exit(2);
}
const needleIndex = process.argv.indexOf('--text');
const needle = needleIndex >= 0 ? process.argv[needleIndex + 1] : null;

const bytes = readFileSync(path);
const pdf = readFixture(mupdf, bytes);
const { doc } = pdf;

const annotations = [];
const images = [];
const fields = [];
for (let index = 0; index < pdf.pageCount; index += 1) {
  const page = doc.findPage(index);
  const annots = page.get('Annots');
  for (let at = 0; annots.isArray() && at < annots.length; at += 1) {
    const dict = annots.get(at).resolve();
    if (!dict.isDictionary()) continue;
    const subtype = dict.get('Subtype');
    const contents = dict.get('Contents');
    const action = dict.get('A');
    const uri = action.isDictionary() ? action.get('URI') : null;
    annotations.push({
      page: index + 1,
      subtype: subtype.isName() ? subtype.asName() : '?',
      contents: contents.isString() ? contents.asString() : '',
      uri: uri?.isString() ? uri.asString() : undefined,
    });
  }

  const resources = page.getInheritable('Resources');
  const xobjects = resources.isDictionary() ? resources.get('XObject') : null;
  if (xobjects?.isDictionary()) {
    xobjects.forEach((value, name) => {
      const stream = value;
      if (!stream.isStream() || stream.get('Subtype').asName() !== 'Image') return;
      images.push({
        page: index + 1,
        name: String(name),
        width: stream.get('Width').asNumber(),
        height: stream.get('Height').asNumber(),
        bytes: stream.readRawStream().getLength(),
      });
    });
  }

  for (const widget of doc.loadPage(index).getWidgets()) {
    fields.push({ name: widget.getName(), value: widget.getValue() });
  }
}

console.log(
  JSON.stringify(
    {
      file: path,
      bytes: bytes.length,
      pages: pdf.pageCount,
      annotations,
      images,
      outlineTitles: pdf.outlineTitles(),
      fields,
      hasNeedle: needle === null ? undefined : bytes.includes(Buffer.from(needle, 'utf8')),
    },
    null,
    2,
  ),
);
