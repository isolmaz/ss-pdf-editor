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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fillFormFields, flattenForm, readFormFields } from './forms';
import type { OperationOutcome } from './types';
import { describeXfa, readXfaPackets, syncXfaInDocument, writeDatasets } from './xfa';
import {
  exportXfaData,
  finishXfaFill,
  importXfaData,
  inspectXfa,
  removeXfa,
  syncXfaDatasets,
} from './xfa-form';
import { DATASETS, datasetsOf, editWidgets, TEMPLATE, withPdf, xfaPdf, xfaTexts } from './xfa-form.fixtures';

const run = { signal: new AbortController().signal };

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
    const datasets = await datasetsOf(synced.bytes);
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
    // Two fields differ from the datasets: Name (edited) and Birth (its widget was never filled, the datasets say 2000-01-01).
    expect(synced.changed).toBe(2);
    expect(synced.bytes.length).toBeGreaterThan(stale.length);
    expect(synced.bytes.subarray(0, stale.length)).toEqual(stale);
    expect(await withPdf(synced.bytes, (doc) => doc.countVersions())).toBe(revisions + 1);
    const datasets = await datasetsOf(synced.bytes);
    expect(datasets).toContain('<Name>Yeni Değer</Name>');
    expect(datasets).toContain('<Birth/>');
    // The checkbox and the field the form has no widget for are left alone.
    expect(datasets).toContain('<Agree>0</Agree>');
    expect(datasets).toContain('<City>Ankara</City>');
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
    const datasets = await datasetsOf(out.bytes);
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

// Forms the main fixture does not describe: a template that leaves a field out or binds it to nothing, a
// file with no datasets packet or one that is not XML, a dynamic form given data, data the widgets
// already show, a value the widget cannot take, and a save that dropped the datasets.
const DATA = '<form1><Name>Zed</Name><Agree>1</Agree><Birth>2024-03-05</Birth></form1>';
const keys = (outcome: OperationOutcome) => outcome.report.notes.map((entry) => entry.key);
const noteParams = (outcome: OperationOutcome, key: string) =>
  outcome.report.notes.find((entry) => entry.key === key)?.params;
const valuesOf = async (bytes: Uint8Array) =>
  Object.fromEntries((await readFormFields(bytes, run.signal)).map((field) => [field.name, field.value]));

describe('importing data into a static form', () => {
  it('fills the widgets from a string or from bytes, and writes nothing when they already show it', async () => {
    const input = await xfaPdf({ kind: 'static' });
    const first = await importXfaData(input, DATA, run);
    expect([first.values, first.widgets]).toEqual([3, 3]);
    expect(first.report.steps).toEqual(['load', 'xfa.datasets', 'form.setText', 'verify', 'save']);
    expect(noteParams(first, 'xfa.note.widgetsFilled')).toEqual({ count: 3 });
    expect(Object.values(await valuesOf(first.bytes))).toEqual(expect.arrayContaining(['Zed', '05/03/2024']));

    // The same data again, as bytes: every widget already shows it, so no fill runs.
    const again = await importXfaData(first.bytes, new TextEncoder().encode(DATA), run);
    expect(again.widgets).toBe(0);
    expect(again.report.steps).toEqual(['load', 'xfa.datasets', 'verify', 'save']);
    expect(keys(again)).not.toContain('xfa.note.widgetsFilled');
  });

  it('leaves a widget alone when the data has no value for it', async () => {
    const out = await importXfaData(
      await xfaPdf({ kind: 'static' }),
      '<form1><Name>Only</Name></form1>',
      run,
    );
    expect([out.values, out.widgets]).toEqual([1, 1]);
  });

  it('counts the fields it could not bind and the values it could not fill, and says so', async () => {
    const noBinding = TEMPLATE.replace('<field name="Name">', '<field name="Name"><bind match="none"/>');
    const out = await importXfaData(await xfaPdf({ kind: 'static', template: noBinding }), DATA, run);
    expect(noteParams(out, 'xfa.note.notSynced')).toEqual({ count: 1 });
    expect(out.widgets).toBe(2);

    const badDate = await importXfaData(
      await xfaPdf({ kind: 'static' }),
      '<form1><Name>Zed</Name><Birth>not a date</Birth></form1>',
      run,
    );
    expect(noteParams(badDate, 'xfa.note.notSynced')).toEqual({ count: 1 });
    expect(badDate.widgets).toBe(1);
  });

  it('does not count a field the template does not mention as one that could not be synced', async () => {
    const partial = TEMPLATE.replace(/<field name="Birth">.*?<\/field>/, '');
    const out = await importXfaData(await xfaPdf({ kind: 'static', template: partial }), DATA, run);
    expect(keys(out)).not.toContain('xfa.note.notSynced');
    expect(out.widgets).toBe(2);
  });

  it('binds fields by the shape of their names when the form has no template packet', async () => {
    const out = await importXfaData(await xfaPdf({ kind: 'static', template: null }), DATA, run);
    expect(out.widgets).toBeGreaterThan(0);
    expect(Object.values(await valuesOf(out.bytes))).toContain('Zed');
    // The fill would spell the check box "Yes" and the date as the widget shows it; the data is what was imported.
    const datasets = await datasetsOf(out.bytes);
    expect(datasets).toContain('<Agree>1</Agree>');
    expect(datasets).toContain('<Birth>2024-03-05</Birth>');
  });

  it('creates the datasets when the form has none', async () => {
    const out = await importXfaData(await xfaPdf({ kind: 'static', datasets: false }), DATA, run);
    expect(out.values).toBe(3);
    expect((await xfaTexts(out.bytes)).datasets).toContain('<Name>Zed</Name>');
  });

  it('refuses datasets that are not XML, and data that is not XML data', async () => {
    await expect(
      importXfaData(await xfaPdf({ kind: 'static', datasets: 'not xml at all' }), DATA, run),
    ).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'the datasets are not XML' },
    });
    await expect(importXfaData(await xfaPdf({ kind: 'static' }), 'plain text', run)).rejects.toMatchObject({
      code: 'unsupported-format',
    });
  });
});

describe('importing data into an unusual file', () => {
  // An XDP stream with two datasets elements: the reader takes the first, so the writer must
  // replace that one, or what was imported is not what is read back.
  const twice = DATASETS + DATASETS.replace('Old', 'Second');

  it('writes the first datasets element of an XDP stream, the one that is read, static or dynamic', async () => {
    for (const kind of ['static', 'dynamic'] as const) {
      const input = await xfaPdf({ kind, layout: 'stream', datasets: twice });
      const out = await importXfaData(input, '<form1><Name>Zed</Name></form1>', run);
      expect(out.values).toBe(1);
      const { xdp } = await xfaTexts(out.bytes);
      expect(xdp).toContain('<Name>Zed</Name>');
      expect(xdp).toContain('<Name>Second</Name>');
      expect(xdp?.indexOf('<Name>Zed</Name>')).toBeLessThan(xdp?.indexOf('<Name>Second</Name>') ?? 0);
      expect((await inspectXfa(out.bytes))?.dataValues).toBe(1);
    }
  });

  it('reports an XDP stream that is not well-formed as the engine failing to write it', async () => {
    const broken = await xfaPdf({ kind: 'dynamic', layout: 'stream', datasets: '<unclosed' });
    await expect(importXfaData(broken, DATA, run)).rejects.toMatchObject({
      details: { engineMessage: 'xfa.import: the XFA stream is not well-formed XML' },
    });
  });

  it('keeps the imported data when the fill spells a check box value its own way', async () => {
    // The check box item has no on/off texts, so the fill's own datasets sync would write "Yes".
    const unnamed = TEMPLATE.replace('<items><integer>1</integer><integer>0</integer></items>', '');
    const out = await importXfaData(await xfaPdf({ kind: 'static', template: unnamed }), DATA, run);
    expect(out.values).toBe(3);
    const datasets = await datasetsOf(out.bytes);
    expect(datasets).toContain('<Agree>1</Agree>');
    expect(datasets).toContain('<Birth>2024-03-05</Birth>');
  });
});

describe('importing data into a dynamic form', () => {
  it('writes the datasets and fills no widgets, because it has none', async () => {
    const out = await importXfaData(await xfaPdf({ kind: 'dynamic' }), DATA, run);
    expect([out.values, out.widgets]).toEqual([3, 0]);
    expect(out.report.steps).toEqual(['load', 'xfa.datasets', 'verify', 'save']);
    expect((await xfaTexts(out.bytes)).datasets).toContain('<Name>Zed</Name>');
  });
});

describe('exporting data', () => {
  it('refuses a form whose datasets hold no data, or that has no datasets packet', async () => {
    await expect(exportXfaData(await xfaPdf({ kind: 'static', datasets: false }))).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'the XFA datasets hold no data' },
    });
    const empty =
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>';
    await expect(exportXfaData(await xfaPdf({ kind: 'static', datasets: empty }))).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(exportXfaData(await xfaPdf({ kind: 'none' }))).rejects.toMatchObject({ code: 'no-xfa' });
  });
});

describe('syncing the datasets', () => {
  it('returns the same bytes for a dynamic form, which has no widgets to sync', async () => {
    const input = await xfaPdf({ kind: 'dynamic' });
    expect(await syncXfaDatasets(input)).toEqual({ bytes: input, changed: 0, skipped: [] });
  });

  it('returns the same bytes, and names the fields it cannot follow, when the data already agrees', async () => {
    const noBinding = TEMPLATE.replace('<field name="Name">', '<field name="Name"><bind match="none"/>');
    // Name is bound to nothing; the empty Birth widget and the unchecked Agree match their data.
    const agreeing = DATASETS.replace('<Birth>2000-01-01</Birth>', '<Birth/>');
    const input = await xfaPdf({ kind: 'static', template: noBinding, datasets: agreeing });
    const out = await syncXfaDatasets(input);
    expect(out.bytes).toBe(input);
    expect(out.changed).toBe(0);
    expect(out.skipped).toEqual([{ name: 'form1[0].#subform[0].Name[0]', reason: 'no-binding' }]);
  });

  it('writes the fields it can follow, and still names the one it cannot, when the data differs', async () => {
    const noBinding = TEMPLATE.replace('<field name="Name">', '<field name="Name"><bind match="none"/>');
    // Birth's widget is empty and the data says 2000-01-01: that field needs writing.
    const input = await xfaPdf({ kind: 'static', template: noBinding });
    const out = await syncXfaDatasets(input);
    expect(out.bytes).not.toBe(input);
    expect(out.changed).toBe(1);
    expect(out.skipped).toEqual([{ name: 'form1[0].#subform[0].Name[0]', reason: 'no-binding' }]);
    const datasets = await datasetsOf(out.bytes);
    expect(datasets).toContain('<Birth/>');
    expect(datasets).toContain('<Name>Old</Name>');
  });
});

describe('checking a save of a dynamic form', () => {
  it('reads a save that dropped the datasets packet as one that changed nothing', async () => {
    const before = await xfaPdf({ kind: 'dynamic' });
    const saved = await xfaPdf({ kind: 'dynamic', datasets: false });
    const out = await finishXfaFill(before, saved, run);
    expect(out.changed).toBe(0);
    expect(keys(out)).toContain('xfa.note.nothingChanged');
  });

  it('counts the values that moved, and refuses a save that changed another packet or the page list', async () => {
    const before = await xfaPdf({ kind: 'dynamic' });
    const typed = await xfaPdf({
      kind: 'dynamic',
      datasets:
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Typed</Name></form1></xfa:data></xfa:datasets>',
    });
    expect((await finishXfaFill(before, typed, run)).changed).toBe(1);
    const retemplated = await xfaPdf({ kind: 'dynamic', template: TEMPLATE.replace('Name', 'Other') });
    await expect(finishXfaFill(before, retemplated, run)).rejects.toMatchObject({
      code: 'verification-failed',
    });
    const twoPages = await withPdf(before, (doc) => {
      doc.insertPage(1, doc.addPage([0, 0, 10, 10], 0, {}, ''));
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    });
    await expect(finishXfaFill(before, twoPages, run)).rejects.toMatchObject({ code: 'verification-failed' });
  });
});
