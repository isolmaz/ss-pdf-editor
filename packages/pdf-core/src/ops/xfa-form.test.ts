/**
 * XFA forms against hand-built PDFs (an `/AcroForm /XFA` array or one XDP stream, with
 * template and datasets packets), read back through MuPDF's own object model. The wrong
 * answers that matter: a static form called dynamic (or the reverse), a fill that leaves
 * the datasets stale so an XFA-aware reader shows the old value, a datasets packet written
 * in the wrong place or not at all, "remove XFA" that drops fields or values, and a dynamic
 * form that is flattened or stripped as if it had widgets.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFDocument, PDFObject } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { fillFormFields, flattenForm, readFormFields } from './forms';
import { describeXfa, readXfaPackets, syncXfaInDocument, writeDatasets } from './xfa';
import {
  exportXfaData,
  finishXfaFill,
  importXfaData,
  inspectXfa,
  removeXfa,
  syncXfaDatasets,
} from './xfa-form';

const run = { signal: new AbortController().signal };

const TEMPLATE = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><subform><field name="Name"><ui><textEdit/></ui></field><field name="Agree"><ui><checkButton/></ui><items><integer>1</integer><integer>0</integer></items></field><field name="Birth"><ui><dateTimeEdit/></ui><format><picture>date{DD/MM/YYYY}</picture></format></field></subform></subform></template>`;
const DATASETS = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Old</Name><Agree>0</Agree><Birth>2000-01-01</Birth><City>Ankara</City></form1></xfa:data></xfa:datasets>`;
const PREAMBLE = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">';

interface Build {
  /** `static` has AcroForm widgets; `dynamic` has none. */
  readonly kind: 'static' | 'dynamic' | 'none';
  readonly layout?: 'array' | 'stream';
  readonly datasets?: boolean;
  readonly template?: string;
}

async function xfaPdf({ kind, layout = 'array', datasets = true, template = TEMPLATE }: Build) {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, {}, ''));
  const page = doc.findPage(0);
  const box = (width: number, height: number) =>
    doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height] });
  const widget = (extra: Record<string, unknown>, rect: number[]) =>
    doc.addObject({ Type: 'Annot', Subtype: 'Widget', Rect: rect, P: page, F: 4, ...extra });

  const fields: PDFObject[] = [];
  if (kind !== 'dynamic') {
    const root = doc.addObject({ T: doc.newString('form1[0]'), Kids: [] });
    const inner = doc.addObject({ T: doc.newString('#subform[0]'), Parent: root, Kids: [] });
    root.get('Kids').push(inner);
    const name = widget(
      { FT: 'Tx', T: doc.newString('Name[0]'), Parent: inner, AP: { N: box(160, 20) } },
      [20, 250, 180, 270],
    );
    const agree = widget(
      {
        FT: 'Btn',
        T: doc.newString('Agree[0]'),
        Parent: inner,
        V: 'Off',
        AS: 'Off',
        AP: { N: { Yes: box(20, 20), Off: box(20, 20) } },
      },
      [20, 210, 40, 230],
    );
    const birth = widget(
      { FT: 'Tx', T: doc.newString('Birth[0]'), Parent: inner, AP: { N: box(100, 20) } },
      [20, 170, 120, 190],
    );
    for (const entry of [name, agree, birth]) inner.get('Kids').push(entry);
    page.put('Annots', [name, agree, birth]);
    fields.push(root);
  }
  const form = doc.addObject({ Fields: fields });
  doc.getTrailer().get('Root').put('AcroForm', form);

  if (kind !== 'none') {
    const packets: [string, string][] = [
      ['preamble', PREAMBLE],
      ['template', template],
      ...(datasets ? ([['datasets', DATASETS]] as [string, string][]) : []),
      ['postamble', '<xfa:postamble/>'],
    ];
    if (layout === 'array') {
      const array = doc.newArray();
      for (const [name, body] of packets) {
        array.push(doc.newString(name));
        array.push(doc.addStream(body, doc.newDictionary()));
      }
      form.put('XFA', array);
    } else {
      const body = packets
        .filter(([name]) => name === 'template' || name === 'datasets')
        .map(([, text]) => text)
        .join('');
      form.put(
        'XFA',
        doc.addStream(`<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">${body}</xdp:xdp>`, doc.newDictionary()),
      );
    }
    if (kind === 'dynamic') doc.getTrailer().get('Root').put('NeedsRendering', true);
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Run `body` on the document, as an independent reader opening the bytes. */
async function withPdf<T>(bytes: Uint8Array, body: (doc: PDFDocument) => T): Promise<T> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return body(doc);
  } finally {
    doc.destroy();
  }
}

/** The XFA as the file holds it: packet name → text for an array, `{ xdp: text }` for one stream. */
function xfaTexts(bytes: Uint8Array): Promise<Record<string, string>> {
  return withPdf(bytes, (doc) => {
    const entry = doc.getTrailer().get('Root').get('AcroForm').resolve().get('XFA');
    const text = (stream: PDFObject) => new TextDecoder().decode(stream.readStream().asUint8Array());
    const xfa = entry.resolve();
    if (!xfa.isArray()) return { xdp: text(entry) };
    const out: Record<string, string> = {};
    for (let at = 0; at + 1 < xfa.length; at += 2) out[xfa.get(at).asString()] = text(xfa.get(at + 1));
    return out;
  });
}

/** Set widget values the way an editor that knows nothing of XFA does: straight into `/V`. */
function editWidgets(bytes: Uint8Array, values: Record<string, string>): Promise<Uint8Array> {
  return withPdf(bytes, (doc) => {
    const annots = doc.findPage(0).get('Annots').resolve();
    for (let at = 0; at < annots.length; at += 1) {
      const widget = annots.get(at).resolve();
      const value = values[widget.get('T').asString()];
      if (value === undefined) continue;
      if (widget.get('FT').asName() === 'Btn') {
        widget.put('V', value);
        widget.put('AS', value);
      } else widget.put('V', doc.newString(value));
    }
    return new Uint8Array(doc.saveToBuffer('').asUint8Array());
  });
}

describe('xfa packets and inspection', () => {
  it('tells a static form, a dynamic form and no XFA apart, in both layouts', async () => {
    expect(await inspectXfa(await xfaPdf({ kind: 'none' }))).toBeNull();

    const array = await inspectXfa(await xfaPdf({ kind: 'static' }));
    expect(array).toMatchObject({
      kind: 'static',
      layout: 'array',
      hasTemplate: true,
      hasDatasets: true,
      fieldCount: 3,
      needsRendering: false,
      dataValues: 4,
    });
    expect(array?.packets.map((packet) => packet.name)).toEqual([
      'preamble',
      'template',
      'datasets',
      'postamble',
    ]);
    expect(array?.packets.every((packet) => packet.bytes > 0)).toBe(true);

    const stream = await inspectXfa(await xfaPdf({ kind: 'static', layout: 'stream' }));
    expect(stream).toMatchObject({ kind: 'static', layout: 'stream', fieldCount: 3, dataValues: 4 });
    expect(stream?.packets.map((packet) => packet.name)).toEqual(['template', 'datasets']);

    // No widgets: the PDF page is only the placeholder, and the catalog says to render it.
    expect(await inspectXfa(await xfaPdf({ kind: 'dynamic' }))).toMatchObject({
      kind: 'dynamic',
      fieldCount: 0,
      needsRendering: true,
    });
  });

  it('writes a missing datasets packet before the postamble, or into the XDP stream', async () => {
    const without = await xfaPdf({ kind: 'static', datasets: false });
    expect((await inspectXfa(without))?.hasDatasets).toBe(false);
    const created = await withPdf(without, (doc) => {
      writeDatasets(doc, DATASETS);
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    });
    const texts = await xfaTexts(created);
    expect(Object.keys(texts)).toEqual(['preamble', 'template', 'datasets', 'postamble']);
    expect(texts.datasets).toBe(DATASETS);
    // The packet that was there is replaced in place, not duplicated.
    const replaced = await withPdf(created, (doc) => {
      writeDatasets(doc, DATASETS.replace('Old', 'New'));
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    });
    expect(Object.keys(await xfaTexts(replaced))).toEqual(['preamble', 'template', 'datasets', 'postamble']);
    expect((await xfaTexts(replaced)).datasets).toContain('<Name>New</Name>');

    const stream = await xfaPdf({ kind: 'static', layout: 'stream', datasets: false });
    const appended = await withPdf(stream, (doc) => {
      writeDatasets(doc, DATASETS);
      const read = readXfaPackets(doc);
      expect(read?.packets.map((packet) => packet.name)).toEqual(['template', 'datasets']);
      expect(describeXfa(doc, [])?.kind).toBe('dynamic');
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    });
    expect(await inspectXfa(appended)).toMatchObject({ layout: 'stream', hasDatasets: true, dataValues: 4 });
  });
});

describe('xfa operations', () => {
  beforeEach(() => {
    const file = createRequire(import.meta.url).resolve(
      '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
      { paths: [process.cwd()] },
    );
    const font = new Uint8Array(readFileSync(file));
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('brings the datasets in step with widgets an XFA-unaware editor changed, and is a no-op otherwise', async () => {
    const plain = await xfaPdf({ kind: 'none' });
    const same = await syncXfaDatasets(plain);
    expect(same.bytes).toBe(plain);
    expect(same.changed).toBe(0);

    const stale = await editWidgets(await xfaPdf({ kind: 'static' }), {
      'Name[0]': 'Çağrı Işık',
      'Agree[0]': 'Yes',
      'Birth[0]': '31/01/2024',
    });
    // The widgets changed; an XFA reader would still draw the old data.
    expect((await xfaTexts(stale)).datasets).toContain('<Name>Old</Name>');
    const synced = await syncXfaDatasets(stale);
    expect(synced.changed).toBe(3);
    const datasets = (await xfaTexts(synced.bytes)).datasets as string;
    expect(datasets).toContain('<Name>Çağrı Işık</Name>');
    // The template's on item, not the widget's "Yes"; the ISO date, not the displayed one.
    expect(datasets).toContain('<Agree>1</Agree>');
    expect(datasets).toContain('<Birth>2024-01-31</Birth>');
    expect(datasets).toContain('<City>Ankara</City>');
    // A second sync finds nothing to do and hands the same bytes back.
    const again = await syncXfaDatasets(synced.bytes);
    expect(again.changed).toBe(0);
    expect(again.bytes).toBe(synced.bytes);
  });

  it('appends the datasets sync as a revision, so the bytes before it, and a signature over them, stay', async () => {
    const stale = await editWidgets(await xfaPdf({ kind: 'static' }), { 'Name[0]': 'Yeni Değer' });
    const revisions = await withPdf(stale, (doc) => doc.countVersions());
    const synced = await syncXfaDatasets(stale);
    expect(synced.changed).toBeGreaterThan(0);
    expect(synced.bytes.length).toBeGreaterThan(stale.length);
    expect(synced.bytes.subarray(0, stale.length)).toEqual(stale);
    expect(await withPdf(synced.bytes, (doc) => doc.countVersions())).toBe(revisions + 1);
    expect((await xfaTexts(synced.bytes)).datasets).toContain('<Name>Yeni Değer</Name>');
  });

  it('syncs only the fields a fill touched, and a form-panel fill reaches the datasets', async () => {
    for (const layout of ['array', 'stream'] as const) {
      const bytes = await xfaPdf({ kind: 'static', layout });
      const out = await fillFormFields(
        bytes,
        [
          { name: 'form1[0].#subform[0].Name[0]', value: 'Şule' },
          { name: 'form1[0].#subform[0].Agree[0]', value: true },
        ],
        run,
      );
      const text = Object.values(await xfaTexts(out.bytes)).join('\n');
      expect(text).toContain('<Name>Şule</Name>');
      expect(text).toContain('<Agree>1</Agree>');
      // The date field was not filled: its data stays as it was.
      expect(text).toContain('<Birth>2000-01-01</Birth>');
      expect(out.report.steps).toContain('xfa.datasets');
      expect(out.report.notes.map((entry) => entry.key)).toContain('xfa.note.synced');
      const fields = await readFormFields(out.bytes);
      expect(fields.find((field) => field.name.endsWith('Name[0]'))?.value).toBe('Şule');
    }
    // `only` at the engine level: a plan for one name leaves the others alone.
    const plan = await withPdf(
      await editWidgets(await xfaPdf({ kind: 'static' }), { 'Name[0]': 'X', 'Birth[0]': '01/02/2003' }),
      (doc) => {
        const snapshots = [
          { name: 'form1[0].#subform[0].Name[0]', kind: 'text', text: 'X', on: null },
          { name: 'form1[0].#subform[0].Birth[0]', kind: 'text', text: '01/02/2003', on: null },
        ] as const;
        return syncXfaInDocument(doc, snapshots, new Set(['form1[0].#subform[0].Name[0]']));
      },
    );
    expect(plan?.changed).toEqual(['form1[0].#subform[0].Name[0]']);
  });

  it('removes XFA from a static form and keeps every field and value; refuses dynamic and none', async () => {
    const filled = await fillFormFields(
      await xfaPdf({ kind: 'static' }),
      [{ name: 'form1[0].#subform[0].Name[0]', value: 'Ayşe' }],
      run,
    );
    const before = await readFormFields(filled.bytes);
    const out = await removeXfa(filled.bytes, run);
    expect(await inspectXfa(out.bytes)).toBeNull();
    const after = await readFormFields(out.bytes);
    expect(after.map((field) => [field.name, field.value])).toEqual(
      before.map((field) => [field.name, field.value]),
    );
    expect(after).toHaveLength(3);
    expect(out.report.notes.map((entry) => entry.key)).toEqual([
      'xfa.note.removed',
      'xfa.note.fieldsKept',
      'xfa.note.scriptsLost',
    ]);
    await withPdf(out.bytes, (doc) => {
      const form = doc.getTrailer().get('Root').get('AcroForm').resolve();
      expect(form.get('XFA').isNull()).toBe(true);
    });

    const dynamic = await xfaPdf({ kind: 'dynamic' });
    await expect(removeXfa(dynamic, run)).rejects.toMatchObject({ code: 'xfa-dynamic' });
    await expect(removeXfa(await xfaPdf({ kind: 'none' }), run)).rejects.toMatchObject({ code: 'no-xfa' });
    // Flattening: a static form is flattened through its widgets, a dynamic one is refused.
    const flat = await flattenForm(filled.bytes, null, run);
    expect(await inspectXfa(flat.bytes)).toBeNull();
    await expect(flattenForm(dynamic, null, run)).rejects.toMatchObject({ code: 'xfa-dynamic' });
  });

  it('exports the data and imports a file, filling a static form’s widgets from it', async () => {
    const bytes = await xfaPdf({ kind: 'static' });
    const exported = await exportXfaData(bytes);
    expect(exported).toMatchObject({ name: 'xfa-data.xml', mime: 'application/xml', values: 4 });
    expect(new TextDecoder().decode(exported.bytes)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<form1><Name>Old</Name><Agree>0</Agree><Birth>2000-01-01</Birth><City>Ankara</City></form1>\n',
    );

    const out = await importXfaData(
      bytes,
      '<form1><Name>Ümit</Name><Agree>1</Agree><Birth>2024-03-09</Birth><City>İzmir</City></form1>',
      run,
    );
    expect(out.values).toBe(4);
    expect(out.widgets).toBe(3);
    const fields = Object.fromEntries(
      (await readFormFields(out.bytes)).map((field) => [field.name.split('.').pop(), field.value]),
    );
    expect(fields).toMatchObject({ 'Name[0]': 'Ümit', 'Agree[0]': true, 'Birth[0]': '09/03/2024' });
    const datasets = (await xfaTexts(out.bytes)).datasets as string;
    expect(datasets).toContain('<City>İzmir</City>');
    expect(datasets).toContain('<Birth>2024-03-09</Birth>');

    await expect(importXfaData(bytes, 'not xml at all', run)).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    await expect(importXfaData(await xfaPdf({ kind: 'none' }), '<a><b>1</b></a>', run)).rejects.toMatchObject(
      {
        code: 'no-xfa',
      },
    );
    await expect(exportXfaData(await xfaPdf({ kind: 'none' }))).rejects.toMatchObject({ code: 'no-xfa' });
  });

  it('accepts a save that changed only the data, and refuses one that touched the template', async () => {
    const before = await xfaPdf({ kind: 'dynamic' });
    const typed = await withPdf(before, (doc) => {
      writeDatasets(doc, DATASETS.replace('Old', 'Typed'));
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    });
    const ok = await finishXfaFill(before, typed, run);
    expect(ok.changed).toBe(1);
    expect(ok.report.notes.map((entry) => entry.key)).toEqual([
      'xfa.note.dataSaved',
      'xfa.note.templateKept',
    ]);

    const same = await finishXfaFill(before, before, run);
    expect(same.changed).toBe(0);
    expect(same.report.notes[0]?.key).toBe('xfa.note.nothingChanged');

    const altered = await xfaPdf({ kind: 'dynamic', template: TEMPLATE.replace('Name', 'Other') });
    await expect(finishXfaFill(before, altered, run)).rejects.toMatchObject({ code: 'verification-failed' });
    await expect(finishXfaFill(before, await xfaPdf({ kind: 'none' }), run)).rejects.toMatchObject({
      code: 'no-xfa',
    });
  });
});
