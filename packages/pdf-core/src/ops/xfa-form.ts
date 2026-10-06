/**
 * XFA forms: what to do with them, as operations.
 *
 * A PDF form can carry **XFA** (Adobe's XML Forms Architecture) next to, or instead of, the
 * AcroForm every other PDF form uses. This product reads and draws PDF with pdf.js and
 * writes it with MuPDF, and neither engine runs XFA scripts or lays a dynamic form out —
 * pdf.js can *draw* a dynamic form (`XfaLayer`, off by default), MuPDF ignores XFA
 * entirely. What the editor does about it, by kind of form:
 *
 *  - **Static XFA** (the AcroForm widgets exist; the XFA is a second description of them):
 *    the widgets are filled through the normal form path, and every write also **keeps the
 *    XFA `datasets` in step**, because an XFA-aware reader draws the data, not the widgets
 *    (`forms.ts` `fillFormFields`, `syncXfaDatasets` below for values pdf.js wrote
 *    inline). The alternative — {@link removeXfa} — leaves the AcroForm as the one truth.
 *  - **Dynamic XFA** (no widgets; the PDF page is a "Please wait…" placeholder): the form is
 *    displayed and filled in the XFA viewer (`pdf-ui` `XfaFormDialog`, pdf.js's own XFA
 *    renderer); {@link finishXfaFill} checks what pdf.js wrote, and `xfa-flatten.ts` turns the
 *    laid-out pages into an ordinary PDF.
 *  - **Data** in and out: {@link exportXfaData} / {@link importXfaData} read and write the
 *    `xfa:data` XML, the file Acrobat's "Export data" produces.
 *
 * What is **not** done: XFA scripts (FormCalc, JavaScript), validations, calculations and
 * dynamic show/hide never run. Those belong to the form's author and to Acrobat.
 */

import type { PDFDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import { openForWrite, saveIncremental, saveRewrite, type WritableDocument } from '../engines/mupdf-write';
import { fillFormFields, readFormFields, xfaSnapshotsOf } from './forms';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';
import {
  datasetsText,
  describeXfa,
  readXfaPackets,
  removeXfaEntries,
  syncXfaInDocument,
  writeDatasets,
  type XfaInfo,
} from './xfa';
import {
  dataEntries,
  dataMarkupOf,
  decodePacket,
  exportDataXml,
  fillValueFor,
  readBoundValue,
  replaceData,
  resolveBindings,
  type SyncSkip,
} from './xfa-data';

async function withDocument<T>(
  bytes: Uint8Array,
  context: string,
  body: (opened: WritableDocument) => Promise<T> | T,
): Promise<T> {
  const opened = await openForWrite(bytes);
  try {
    return await body(opened);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof ToolError) throw error;
    throw mapMupdfError(error, context);
  } finally {
    opened.doc.destroy();
  }
}

function noXfa(): ToolError {
  return new ToolError('no-xfa', { engine: 'mupdf', engineMessage: 'the document has no /AcroForm /XFA' });
}

/** What the document's XFA is, or `null` when it has none. A pure read. */
export async function inspectXfa(bytes: Uint8Array): Promise<XfaInfo | null> {
  return await withDocument(bytes, 'xfa.inspect', ({ doc }) => describeXfa(doc, xfaSnapshotsOf(doc)));
}

/**
 * Bring a static form's datasets in step with its widgets, for bytes pdf.js produced.
 *
 * The inline widgets write into pdf.js's annotation storage, and `saveDocument` turns that
 * into an incremental update that patches the datasets by *field name* (`writeXFADataForAcroform`
 * in its worker): good for flat names, blind to a template's bind modes, check box items and
 * date pictures. This runs after it and applies the template-aware rule of `xfa-data.ts` to
 * every field. A document without XFA — nearly every document — comes back **as the same
 * array**, unwritten.
 */
export async function syncXfaDatasets(
  bytes: Uint8Array,
): Promise<{ readonly bytes: Uint8Array; readonly changed: number; readonly skipped: readonly SyncSkip[] }> {
  return await withDocument(bytes, 'xfa.sync', ({ doc }) => {
    if (readXfaPackets(doc) === null) return { bytes, changed: 0, skipped: [] };
    const plan = syncXfaInDocument(doc, xfaSnapshotsOf(doc));
    if (plan === null || plan.xml === null) return { bytes, changed: 0, skipped: plan?.skipped ?? [] };
    // Appended, not rewritten: the bytes before it (pdf.js's own incremental save) may carry a
    // signature, and a rewrite would leave nothing for it to cover.
    return { bytes: saveIncremental(doc, 'xfa.sync'), changed: plan.changed.length, skipped: plan.skipped };
  });
}

/**
 * Remove the XFA from a **static** form and keep the AcroForm.
 *
 * This is the choice iText (`removeXfaForm`), PDFBox (flatten drops the XFA) and Acrobat's
 * own "convert to AcroForm" workflows make, and it is the right one when the widgets are
 * what the user cares about: nothing is left to fall out of step. The cost is stated in the
 * report — XFA scripts, calculations and validations, and any usage rights the file carried.
 * A dynamic form is refused: it has no widgets, so removing its XFA would leave the
 * "Please wait…" page and nothing else.
 */
export async function removeXfa(bytes: Uint8Array, context: OperationContext): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const before = await readFormFields(bytes, context.signal);
  const result = await withDocument(bytes, 'xfa.remove', ({ doc }) => {
    const info = describeXfa(doc, xfaSnapshotsOf(doc));
    if (info === null) throw noXfa();
    if (info.kind === 'dynamic') {
      throw new ToolError('xfa-dynamic', { engine: 'mupdf', engineMessage: 'dynamic XFA has no AcroForm' });
    }
    removeXfaEntries(doc);
    const saved = saveRewrite(doc, 'xfa.remove');
    return { saved, pageCount: doc.countPages(), packets: info.packets.length };
  });

  // Read back: no XFA left, every field and value as it was.
  await withDocument(result.saved, 'xfa.remove.verify', ({ doc }) => {
    if (readXfaPackets(doc) !== null) {
      throw new ToolError('verification-failed', { engine: 'mupdf', engineMessage: 'XFA still present' });
    }
  });
  const after = await readFormFields(result.saved, context.signal);
  const same =
    after.length === before.length &&
    before.every((field, index) => {
      const other = after[index];
      return (
        other !== undefined &&
        other.name === field.name &&
        JSON.stringify(other.value) === JSON.stringify(field.value)
      );
    });
  if (!same) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: 'the form fields changed while the XFA was removed',
    });
  }

  return {
    bytes: result.saved,
    report: {
      engine: 'mupdf',
      steps: ['load', 'xfa.remove', 'verify', 'save'],
      notes: [
        note('changed', 'xfa.note.removed'),
        note('preserved', 'xfa.note.fieldsKept', { count: after.length }),
        note('lost', 'xfa.note.scriptsLost'),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: result.saved.byteLength,
      pageCount: result.pageCount,
      incremental: false,
    },
  };
}

/** The form's data as the XML file Acrobat's "Export data" writes. */
export async function exportXfaData(bytes: Uint8Array): Promise<{
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly mime: string;
  readonly values: number;
}> {
  return await withDocument(bytes, 'xfa.export', ({ doc }) => {
    if (readXfaPackets(doc) === null) throw noXfa();
    const datasets = datasetsText(doc);
    const xml = datasets === null ? null : exportDataXml(datasets);
    if (xml === null || datasets === null) {
      throw new ToolError('unsupported', { engine: 'mupdf', engineMessage: 'the XFA datasets hold no data' });
    }
    return {
      bytes: new TextEncoder().encode(xml),
      name: 'xfa-data.xml',
      mime: 'application/xml',
      values: dataEntries(datasets).length,
    };
  });
}

/**
 * Replace the form's data with an XML data file.
 *
 * The file may be bare data (`<form1>…`), an `xfa:data` element, a datasets packet or a whole
 * XDP. A **static** form's widgets are then filled from the data too, through the same fill the
 * form panel uses, so the page shows what the data says; a **dynamic** form shows it the next
 * time the XFA viewer opens. The write is read back: the data in the output has to be the data
 * that was imported.
 */
export async function importXfaData(
  bytes: Uint8Array,
  data: Uint8Array | string,
  context: OperationContext,
): Promise<OperationOutcome & { readonly values: number; readonly widgets: number }> {
  throwIfAborted(context.signal);
  const text = typeof data === 'string' ? data : decodePacket(data);
  const markup = dataMarkupOf(text);
  if (markup === null) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'the file is not XML data an XFA form can take',
    });
  }
  const expected = dataEntries(
    `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>${markup}</xfa:data></xfa:datasets>`,
  );

  const written = await withDocument(bytes, 'xfa.import', ({ doc }) => {
    const info = describeXfa(doc, xfaSnapshotsOf(doc));
    if (info === null) throw noXfa();
    const current =
      datasetsText(doc) ??
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>';
    const replaced = replaceData(current, markup);
    if (replaced === null) {
      throw new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'the datasets are not XML' });
    }
    writeDatasets(doc, replaced);
    return { saved: saveRewrite(doc, 'xfa.import'), info, replaced };
  });

  let output = written.saved;
  let widgets = 0;
  const skipped: string[] = [];
  const notes = [note('changed', 'xfa.note.imported', { count: expected.length })];

  if (written.info.kind === 'static') {
    // The widgets show what the data says.
    const snapshots = await withDocument(output, 'xfa.import.read', ({ doc }) => ({
      fields: xfaSnapshotsOf(doc),
      template: (() => {
        const packet = readXfaPackets(doc)?.packets.find((entry) => entry.name === 'template');
        return packet === undefined ? null : decodePacket(packet.bytes);
      })(),
    }));
    const fields = snapshots.fields.filter((field) => field.kind !== 'signature');
    const bindings = resolveBindings(
      snapshots.template,
      fields.map((field) => ({ name: field.name, kind: field.kind })),
    );
    const fills: { name: string; value: string | boolean }[] = [];
    for (const binding of bindings) {
      if (binding.path === null) {
        if (binding.skip !== null && binding.skip !== 'unmapped') skipped.push(binding.name);
        continue;
      }
      const value = readBoundValue(written.replaced, binding);
      if (value === null) continue;
      const fill = fillValueFor(binding, value);
      if (fill === null) {
        skipped.push(binding.name);
        continue;
      }
      const field = fields.find((candidate) => candidate.name === binding.name);
      // Only a value that differs is written: a field already showing the data stays as it is.
      const shown = field?.kind === 'checkbox' ? field.on === true : (field?.text ?? '');
      if (shown !== fill.value) fills.push({ name: binding.name, value: fill.value });
    }
    if (fills.length > 0) {
      const filled = await fillFormFields(output, fills, context);
      output = filled.bytes;
      widgets = fills.length;
    }
    if (widgets > 0) notes.push(note('changed', 'xfa.note.widgetsFilled', { count: widgets }));
    if (skipped.length > 0) notes.push(note('warning', 'xfa.note.notSynced', { count: skipped.length }));
  }

  // Read back: the data in the file is the data that was imported.
  await withDocument(output, 'xfa.import.verify', ({ doc }) => {
    const text = datasetsText(doc);
    const actual = text === null ? [] : dataEntries(text);
    const same =
      actual.length === expected.length &&
      expected.every(
        (entry, index) => actual[index]?.path === entry.path && actual[index]?.value === entry.value,
      );
    if (!same) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `the datasets hold ${actual.length} values, ${expected.length} were imported`,
      });
    }
  });

  return {
    bytes: output,
    values: expected.length,
    widgets,
    report: {
      engine: 'mupdf',
      steps:
        written.info.kind === 'static' && widgets > 0
          ? ['load', 'xfa.datasets', 'form.setText', 'verify', 'save']
          : ['load', 'xfa.datasets', 'verify', 'save'],
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: output.byteLength,
      pageCount: await pageCountOf(output),
      incremental: false,
    },
  };
}

async function pageCountOf(bytes: Uint8Array): Promise<number> {
  return await withDocument(bytes, 'xfa.pages', ({ doc }: { doc: PDFDocument }) => doc.countPages());
}

/**
 * Check what pdf.js wrote when the XFA viewer saved a dynamic form.
 *
 * pdf.js's `saveDocument` serialises the values typed into the XFA layer back into the
 * `datasets` packet as an incremental update. That is the only writer of dynamic XFA data
 * here, so its output is verified like any other: the file opens, the page list and every
 * other packet (above all the template) are unchanged, and the data differs from the
 * previous version by the values that were typed. `changed` is how many leaf values moved.
 */
export async function finishXfaFill(
  before: Uint8Array,
  saved: Uint8Array,
  context: OperationContext,
): Promise<OperationOutcome & { readonly changed: number }> {
  throwIfAborted(context.signal);
  const read = (bytes: Uint8Array) =>
    withDocument(bytes, 'xfa.verify', ({ doc }) => {
      const packets = readXfaPackets(doc);
      if (packets === null) throw noXfa();
      const datasets = packets.packets.find((packet) => packet.name === 'datasets');
      return {
        pages: doc.countPages(),
        data: datasets === undefined ? [] : dataEntries(decodePacket(datasets.bytes)),
        others: packets.packets
          .filter((packet) => packet.name !== 'datasets')
          .map((packet) => `${packet.name}:${decodePacket(packet.bytes)}`),
      };
    });
  const [was, now] = await Promise.all([read(before), read(saved)]);
  if (now.pages !== was.pages || now.others.join('\n') !== was.others.join('\n')) {
    throw new ToolError('verification-failed', {
      engine: 'pdfjs',
      engineMessage: 'the XFA save changed the page list or a packet other than the datasets',
    });
  }
  const previous = new Map(was.data.map((entry) => [entry.path, entry.value] as const));
  let changed = 0;
  for (const entry of now.data) if (previous.get(entry.path) !== entry.value) changed += 1;
  const notes = [note('preserved', 'xfa.note.templateKept')];
  notes.unshift(
    changed > 0
      ? note('changed', 'xfa.note.dataSaved', { count: changed })
      : note('warning', 'xfa.note.nothingChanged'),
  );
  return {
    bytes: saved,
    changed,
    report: {
      engine: 'pdfjs',
      steps: ['xfa.datasets', 'verify'],
      notes,
      inputBytes: before.byteLength,
      outputBytes: saved.byteLength,
      pageCount: now.pages,
      // pdf.js appends an update to the file it was given.
      incremental: true,
    },
  };
}
