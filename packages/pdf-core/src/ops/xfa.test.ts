/**
 * The XFA packet reader/writer on its own, against hand-built files: the shapes a form producer
 * is free to emit (a missing catalog, an XFA entry that is no array and no stream, an XDP with
 * comments between its packets, an array without a datasets or postamble packet) and what
 * happens to the datasets in each of them.
 */

import { describe, expect, it } from 'vitest';
import { xfaSnapshotsOf } from './forms';
import { handPdf } from './forms.fixtures';
import {
  datasetsText,
  describeXfa,
  hasDataElement,
  packetText,
  readXfaPackets,
  removeXfaEntries,
  syncXfaInDocument,
  writeDatasets,
} from './xfa';
import type { XfaFieldSnapshot } from './xfa-data';
import { DATASETS, TEMPLATE, withPdf, xfaPdf, xfaTexts } from './xfa-form.fixtures';

const NS = 'xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"';

describe('readXfaPackets', () => {
  it('finds nothing in a file without a catalog, without an AcroForm or without an XFA entry', async () => {
    const noCatalog = handPdf({ 2: '<</Type/Pages/Kids[]/Count 0>>' });
    const noForm = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
    });
    const noXfa = await xfaPdf({ kind: 'none' });
    for (const bytes of [noCatalog, noForm, noXfa]) {
      expect(await withPdf(bytes, (doc) => readXfaPackets(doc))).toBeNull();
      expect(await withPdf(bytes, (doc) => describeXfa(doc, []))).toBeNull();
      expect(await withPdf(bytes, (doc) => removeXfaEntries(doc))).toBe(false);
      expect(await withPdf(bytes, (doc) => packetText(doc, 'datasets'))).toBeNull();
      expect(await withPdf(bytes, (doc) => datasetsText(doc))).toBeNull();
      expect(await withPdf(bytes, (doc) => syncXfaInDocument(doc, []))).toBeNull();
    }
  });

  it('finds nothing when the XFA entry is neither an array nor a stream', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA 42>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
    });
    expect(await withPdf(bytes, (doc) => readXfaPackets(doc))).toBeNull();
    expect(await withPdf(bytes, (doc) => describeXfa(doc, []))).toBeNull();
  });

  it('reads an array whose name or stream is not usable as the packets that are', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA[(template) 5 0 R 7 5 0 R (datasets) 6 0 R]>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
      5: `<</Length 3>>\nstream\n<t>\nendstream`,
      6: `<</Length 5>>\nstream\n<d/>\nendstream`,
    });
    const read = await withPdf(bytes, (doc) => readXfaPackets(doc));
    expect(read?.layout).toBe('array');
    expect(read?.packets.map((packet) => packet.name)).toEqual(['template', 'datasets']);
  });

  it('reads one XDP stream packet by packet, skipping what is not an element', async () => {
    const xdp = `<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><!-- note -->text<template/><xfa:datasets ${NS}><xfa:data/></xfa:datasets></xdp:xdp>`;
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA 5 0 R>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
      5: `<</Length ${xdp.length}>>\nstream\n${xdp}\nendstream`,
    });
    const read = await withPdf(bytes, (doc) => readXfaPackets(doc));
    expect(read?.layout).toBe('stream');
    expect(read?.packets.map((packet) => packet.name)).toEqual(['template', 'datasets']);
  });

  it('reads a stream that is not well-formed XML as a stream layout without packets', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA 5 0 R>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
      5: `<</Length 7>>\nstream\nnot xml\nendstream`,
    });
    expect(await withPdf(bytes, (doc) => readXfaPackets(doc))).toEqual({ layout: 'stream', packets: [] });
    const info = await withPdf(bytes, (doc) => describeXfa(doc, []));
    expect(info).toMatchObject({
      layout: 'stream',
      packets: [],
      hasTemplate: false,
      hasDatasets: false,
      dataValues: 0,
    });
  });
});

describe('writeDatasets', () => {
  it('refuses a document without XFA', async () => {
    const bytes = await xfaPdf({ kind: 'none' });
    await expect(withPdf(bytes, (doc) => writeDatasets(doc, `<xfa:datasets ${NS}/>`))).rejects.toThrow(
      'the document has no XFA',
    );
  });

  it('adds a datasets packet before the postamble in an array that has none', async () => {
    const bytes = await xfaPdf({ kind: 'static', datasets: false });
    const out = await withPdf(bytes, (doc) => {
      writeDatasets(doc, DATASETS);
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    });
    const texts = await xfaTexts(out);
    expect(Object.keys(texts)).toEqual(['preamble', 'template', 'datasets', 'postamble']);
    expect(texts.datasets).toBe(DATASETS);
  });

  it('appends a datasets packet to an array that has neither datasets nor postamble', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA[(template) 5 0 R]>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
      5: `<</Length 3>>\nstream\n<t/>\nendstream`,
    });
    const out = await withPdf(bytes, (doc) => {
      writeDatasets(doc, DATASETS);
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    });
    expect(Object.keys(await xfaTexts(out))).toEqual(['template', 'datasets']);
  });

  it('adds a datasets packet when the array names one whose value is not a stream', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA[(datasets) 42]>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
    });
    const written = await withPdf(bytes, (doc) => {
      writeDatasets(doc, DATASETS);
      return datasetsText(doc);
    });
    expect(written).toBe(DATASETS);
  });

  it('swaps the datasets element inside a one-stream XDP, or appends it when there is none', async () => {
    const withData = await xfaPdf({ kind: 'static', layout: 'stream' });
    const replaced = await withPdf(withData, (doc) => {
      writeDatasets(
        doc,
        `<xfa:datasets ${NS}><xfa:data><form1><Name>New</Name></form1></xfa:data></xfa:datasets>`,
      );
      return datasetsText(doc);
    });
    expect(replaced).toContain('<Name>New</Name>');
    expect(replaced).not.toContain('Old');

    const without = await xfaPdf({ kind: 'static', layout: 'stream', datasets: false });
    const appended = await withPdf(without, (doc) => {
      writeDatasets(doc, `<xfa:datasets ${NS}><xfa:data><x>1</x></xfa:data></xfa:datasets>`);
      return datasetsText(doc);
    });
    expect(appended).toContain('<x>1</x>');
  });

  it('refuses an XFA entry that is neither an array nor a stream', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA 42>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
    });
    await expect(withPdf(bytes, (doc) => writeDatasets(doc, `<xfa:datasets ${NS}/>`))).rejects.toThrow(
      'the XFA stream is not well-formed XML',
    );
  });

  it('refuses datasets that are not well-formed, and a stream that is not well-formed', async () => {
    const stream = await xfaPdf({ kind: 'static', layout: 'stream' });
    await expect(withPdf(stream, (doc) => writeDatasets(doc, 'not xml'))).rejects.toThrow(
      'the XFA stream is not well-formed XML',
    );
    const broken = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[]/XFA 5 0 R>>>>',
      2: '<</Type/Pages/Kids[]/Count 0>>',
      5: `<</Length 7>>\nstream\nnot xml\nendstream`,
    });
    await expect(withPdf(broken, (doc) => writeDatasets(doc, `<xfa:datasets ${NS}/>`))).rejects.toThrow(
      'the XFA stream is not well-formed XML',
    );
  });
});

describe('syncXfaInDocument and removal', () => {
  it('creates the datasets of a form that has none from all of its widgets', async () => {
    const bytes = await xfaPdf({ kind: 'static', datasets: false });
    const written = await withPdf(bytes, (doc) => {
      const plan = syncXfaInDocument(doc, xfaSnapshotsOf(doc));
      return { changed: plan?.changed.length, datasets: datasetsText(doc) };
    });
    expect(written.changed).toBeGreaterThan(0);
    expect(written.datasets).toContain('<form1>');
  });

  it('answers null for a dynamic form (no widgets to sync) and for signatures only', async () => {
    const dynamic = await xfaPdf({ kind: 'dynamic' });
    expect(await withPdf(dynamic, (doc) => syncXfaInDocument(doc, []))).toBeNull();
    const signatureOnly: XfaFieldSnapshot[] = [{ name: 'Sig', kind: 'signature', text: null, on: null }];
    expect(
      await withPdf(await xfaPdf({ kind: 'static' }), (doc) => syncXfaInDocument(doc, signatureOnly)),
    ).toBeNull();
  });

  it('answers null when the datasets packet is not XML, so there is nothing to bring in step', async () => {
    const bytes = await xfaPdf({ kind: 'static', datasets: 'not xml' });
    expect(await withPdf(bytes, (doc) => syncXfaInDocument(doc, xfaSnapshotsOf(doc)))).toBeNull();
  });

  it('removes the XFA entry and the NeedsRendering flag, and keeps the template text readable before that', async () => {
    const bytes = await xfaPdf({ kind: 'dynamic' });
    const info = await withPdf(bytes, (doc) => describeXfa(doc, []));
    expect(info?.needsRendering).toBe(true);
    expect(await withPdf(bytes, (doc) => packetText(doc, 'template'))).toBe(TEMPLATE);
    const after = await withPdf(bytes, (doc) => {
      expect(removeXfaEntries(doc)).toBe(true);
      return readXfaPackets(doc);
    });
    expect(after).toBeNull();
    const staticBytes = await xfaPdf({ kind: 'static' });
    expect(await withPdf(staticBytes, (doc) => removeXfaEntries(doc))).toBe(true);
  });
});

describe('hasDataElement', () => {
  it('is true only for a datasets packet with an xfa:data element', () => {
    expect(hasDataElement(DATASETS)).toBe(true);
    expect(hasDataElement(`<xfa:datasets ${NS}/>`)).toBe(false);
    expect(hasDataElement('not xml')).toBe(false);
  });
});
