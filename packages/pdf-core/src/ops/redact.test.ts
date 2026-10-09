/**
 * Redaction against the real MuPDF engine: pages are built in the test, redacted, and the
 * produced bytes are read back. The wrong answers that matter: erased text still
 * extractable, neighbouring text lost with it, a mark that erased nothing reported as a
 * success, a verification that waves a leftover through, a rotated page that erases the
 * wrong area, and metadata or attachments the user asked to clear that survive.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { PRODUCER_LINE } from './metadata';
import { type RedactOptions, type RedactRect, redactDocument, verifyRedaction } from './redact';
import {
  addNote,
  addWidget,
  annotationsOf,
  build,
  decompressed,
  FIELD_SECRET,
  fieldNames,
  formAndNotes,
  inProduced,
  LINK_SECRET,
  listOnPage,
  mark,
  NOTE_SECRET,
  OUTSIDE_LINK,
  OUTSIDE_NOTE,
  OUTSIDE_VALUE,
  pageTexts,
  setForm,
  TWO_LINES,
} from './redact.fixtures';
import { editWidgets, withPdf, xfaPdf } from './xfa-form.fixtures';

const run = { signal: new AbortController().signal };

const BASE: Omit<RedactOptions, 'marks'> = {
  imageMethod: 0,
  textMethod: 0,
  cleanMetadata: false,
  cleanAttachments: [],
};

/** Covers the second line only: its baseline sits 200 pt below the top. */
const SECRET_MARK = mark([40, 185, 200, 210]);

/** What `formAndNotes` leaves on its page once `SECRET_MARK` has been applied: everything far from the mark. */
const OUTSIDE_ANNOTATIONS = [
  { subtype: 'Widget', name: 'otherfield', value: OUTSIDE_VALUE, rect: [60, 100, 190, 120] },
  { subtype: 'Text', contents: OUTSIDE_NOTE, rect: [210, 100, 230, 120] },
  { subtype: 'Popup', rect: [300, 40, 380, 90] },
  { subtype: 'Link', uri: `https://example.test/${OUTSIDE_LINK}`, rect: [60, 60, 190, 80] },
];

describe('redactDocument', () => {
  it('erases the marked glyphs, keeps the neighbouring line and reports what it did', async () => {
    const source = await build([TWO_LINES]);
    const events: string[] = [];
    const outcome = await redactDocument(
      source,
      { ...BASE, marks: [SECRET_MARK] },
      {
        signal: run.signal,
        onProgress: (entry) => events.push(`${entry.labelKey}:${entry.done}/${entry.total}`),
      },
    );
    expect(await pageTexts(outcome.bytes)).toEqual(['Public line']);
    expect(outcome.verification).toEqual({ marksCleared: true, remaining: [] });
    expect(events).toEqual([
      'op.progress.redact:1/1',
      'op.progress.redact.save:0/1',
      'op.progress.redact.save:1/1',
    ]);
    expect(outcome.report).toMatchObject({
      engine: 'mupdf',
      steps: [
        'open',
        'annotate(Redact)',
        'applyRedactions',
        'save(garbage=compact,compress,clean)',
        'verify',
      ],
      inputBytes: source.byteLength,
      outputBytes: outcome.bytes.byteLength,
      incremental: false,
      pageCount: 1,
    });
    expect(outcome.report.notes).toEqual([
      { kind: 'lost', key: 'op.note.redact.contentErased', params: { marks: 1, pages: 1 } },
      { kind: 'preserved', key: 'op.note.redact.singleRevision' },
      { kind: 'preserved', key: 'op.note.redact.verified' },
      { kind: 'warning', key: 'op.note.redact.imagesUntouched' },
      { kind: 'preserved', key: 'op.note.redact.producerKept', params: { producer: PRODUCER_LINE } },
    ]);
  });

  it('erases on a rotated page, where the mark is given in the unrotated space', async () => {
    for (const rotate of [90, 180, 270] as const) {
      const source = await build([{ ...TWO_LINES, rotate }]);
      const outcome = await redactDocument(source, { ...BASE, imageMethod: 1, marks: [SECRET_MARK] }, run);
      expect(await pageTexts(outcome.bytes), `rotation ${rotate}`).toEqual(['Public line']);
      expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.imagesUntouched')).toBe(
        false,
      );
    }
  });

  it('marks several pages in page order and counts marks and pages', async () => {
    const source = await build([TWO_LINES, TWO_LINES]);
    const outcome = await redactDocument(
      source,
      { ...BASE, marks: [mark([40, 185, 200, 210], 1), mark([40, 85, 200, 110], 0)] },
      run,
    );
    expect(await pageTexts(outcome.bytes)).toEqual(['Secret 4711', 'Public line']);
    expect(outcome.report.notes[0]).toEqual({
      kind: 'lost',
      key: 'op.note.redact.contentErased',
      params: { marks: 2, pages: 2 },
    });
  });

  it('warns about a mark that covered nothing drawable instead of claiming an erasure', async () => {
    const source = await build([TWO_LINES, TWO_LINES]);
    const outcome = await redactDocument(
      source,
      {
        ...BASE,
        marks: [mark([300, 10, 390, 40], 0), mark([300, 10, 390, 40], 1), mark([40, 185, 200, 210], 1)],
      },
      run,
    );
    expect(outcome.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.redact.emptyMarks',
      params: { pages: '0' },
    });
    expect(await pageTexts(outcome.bytes)).toEqual(['Public line Secret 4711', 'Public line']);
  });

  it('refuses a redaction without marks', async () => {
    await expect(redactDocument(await build([TWO_LINES]), { ...BASE, marks: [] }, run)).rejects.toMatchObject(
      {
        code: 'selection-empty',
      },
    );
  });

  it('refuses marks whose geometry is unknown, not a page, or not a rectangle', async () => {
    const source = await build([TWO_LINES]);
    const legacy = { pageIndex: 0, rect: [0, 0, 10, 10] } as unknown as RedactRect;
    await expect(redactDocument(source, { ...BASE, marks: [legacy] }, run)).rejects.toMatchObject({
      code: 'redaction-geometry-unknown',
    });
    for (const bad of [
      mark([10, 10, 50, 50], 0.5),
      mark([50, 10, 10, 50]),
      mark([10, 50, 50, 10]),
      mark([10, 10, Number.NaN, 50]),
    ]) {
      await expect(redactDocument(source, { ...BASE, marks: [bad] }, run)).rejects.toMatchObject({
        code: 'range-invalid',
      });
    }
  });

  it('names the page when a mark points past the document or before it', async () => {
    const source = await build([TWO_LINES]);
    await expect(
      redactDocument(source, { ...BASE, marks: [mark([10, 10, 50, 50], 1)] }, run),
    ).rejects.toMatchObject({
      code: 'range-invalid',
      details: { pageIndex: 1, engineMessage: 'page index 1 outside 0..0' },
    });
    await expect(
      redactDocument(source, { ...BASE, marks: [mark([10, 10, 50, 50], -1)] }, run),
    ).rejects.toMatchObject({
      code: 'range-invalid',
      details: { pageIndex: -1 },
    });
  });

  it('refuses a file that is not a PDF', async () => {
    await expect(
      redactDocument(new TextEncoder().encode('not a pdf'), { ...BASE, marks: [SECRET_MARK] }, run),
    ).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engine: 'mupdf' },
    });
  });

  it('never returns a file whose marks still hold text', async () => {
    // `textMethod: 1` tells the engine to leave the text alone: the verification has to catch it.
    const source = await build([TWO_LINES]);
    await expect(
      redactDocument(source, { ...BASE, textMethod: 1, marks: [SECRET_MARK] }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: 'redaction left text or annotations inside marks on page(s) 0' },
    });
  });

  it('stops at every checkpoint when the signal is aborted', async () => {
    const source = await build([TWO_LINES]);
    const abortsAtRead = (limit: number): AbortSignal => {
      let reads = 0;
      return {
        get aborted() {
          reads += 1;
          return reads >= limit;
        },
      } as AbortSignal;
    };
    // Reads: entry, after the engine loads, per page, after the marks, after the save. The two
    // inside the engine's try block surface as the engine-mapped `aborted` ToolError.
    const outcomes = { 1: 'AbortError', 2: 'AbortError', 3: 'ToolError', 4: 'ToolError', 5: 'AbortError' };
    for (const [limit, name] of Object.entries(outcomes)) {
      await expect(
        redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, { signal: abortsAtRead(Number(limit)) }),
      ).rejects.toMatchObject({ name, ...(name === 'ToolError' ? { code: 'aborted' } : {}) });
    }
    const finished = await redactDocument(
      source,
      { ...BASE, marks: [SECRET_MARK] },
      { signal: abortsAtRead(99) },
    );
    expect(finished.verification.marksCleared).toBe(true);
  });

  it('clears the content-bearing Info keys and an indirect XMP packet but keeps the producer line', async () => {
    const source = await build([TWO_LINES], (doc) => {
      doc.setMetaData('info:Title', 'Gizli başlık');
      doc.setMetaData('info:Author', 'Ayşe');
      doc.setMetaData('info:Producer', 'Some Producer 1.0');
      const root = doc.getTrailer().get('Root');
      root.put(
        'Metadata',
        doc.addStream('<?xpacket begin?><x:xmpmeta>XMPSECRET</x:xmpmeta>', {
          Type: 'Metadata',
          Subtype: 'XML',
        }),
      );
    });
    const outcome = await redactDocument(source, { ...BASE, cleanMetadata: true, marks: [SECRET_MARK] }, run);
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes, 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    expect(doc.getMetaData('info:Title') ?? '').toBe('');
    expect(doc.getMetaData('info:Author') ?? '').toBe('');
    expect(doc.getMetaData('info:Producer')).toBe(PRODUCER_LINE);
    expect(doc.getTrailer().get('Root').get('Metadata').isNull()).toBe(true);
    doc.destroy();
    expect(new TextDecoder('latin1').decode(outcome.bytes)).not.toContain('XMPSECRET');
    expect(outcome.report.steps).toContain('clean(Info+XMP)');
    expect(outcome.report.notes).toContainEqual({ kind: 'lost', key: 'op.note.redact.metadataCleared' });
  });

  it('clears a direct XMP entry, and reports no metadata clean-up for a document without any', async () => {
    const direct = await build([TWO_LINES], (doc) => {
      doc.getTrailer().get('Root').put('Metadata', { Type: 'Metadata' });
    });
    const cleared = await redactDocument(direct, { ...BASE, cleanMetadata: true, marks: [SECRET_MARK] }, run);
    expect(cleared.report.steps).toContain('clean(Info+XMP)');

    const bare = await build([TWO_LINES]);
    const untouched = await redactDocument(bare, { ...BASE, cleanMetadata: true, marks: [SECRET_MARK] }, run);
    expect(untouched.report.steps).not.toContain('clean(Info+XMP)');
    expect(untouched.report.notes.some((entry) => entry.key === 'op.note.redact.metadataCleared')).toBe(
      false,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(untouched.bytes, 'application/pdf').asPDF();
    expect(doc?.getMetaData('info:Producer')).toBe(PRODUCER_LINE);
    doc?.destroy();
  });

  it('removes the named attachments and counts only the ones that existed', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const bytes = new TextEncoder().encode('ATTACHED');
      doc.insertEmbeddedFile(
        'gizli.txt',
        doc.addEmbeddedFile('gizli.txt', 'text/plain', bytes, new Date(0), new Date(0)),
      );
      doc.insertEmbeddedFile(
        'kalsin.txt',
        doc.addEmbeddedFile('kalsin.txt', 'text/plain', bytes, new Date(0), new Date(0)),
      );
    });
    const outcome = await redactDocument(
      source,
      { ...BASE, cleanAttachments: ['gizli.txt', 'yok.txt'], marks: [SECRET_MARK] },
      run,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes, 'application/pdf').asPDF();
    expect(Object.keys(doc?.getEmbeddedFiles() ?? {})).toEqual(['kalsin.txt']);
    doc?.destroy();
    expect(outcome.report.steps).toContain('clean(attachments)');
    expect(outcome.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.attachmentsRemoved',
      params: { count: 1 },
    });
  });
});

describe('redactDocument: annotations and form fields under a mark', () => {
  it('removes the form field, the comment and the link under the mark, byte for byte, and leaves those outside it alone', async () => {
    const source = await build([TWO_LINES], formAndNotes);
    // The fixture really carries what the redaction has to get rid of.
    const before = await decompressed(source);
    for (const secret of [FIELD_SECRET, NOTE_SECRET, LINK_SECRET]) expect(before).toContain(secret);

    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);

    expect(await pageTexts(outcome.bytes)).toEqual(['Public line']);
    expect(await annotationsOf(outcome.bytes)).toEqual(OUTSIDE_ANNOTATIONS);
    expect(await fieldNames(outcome.bytes)).toEqual(['otherfield']);

    const raw = new TextDecoder('latin1').decode(outcome.bytes);
    const forensic = await decompressed(outcome.bytes);
    for (const secret of [FIELD_SECRET, NOTE_SECRET, LINK_SECRET]) {
      expect(raw, `${secret} in the produced bytes`).not.toContain(secret);
      expect(forensic, `${secret} after decompressing every stream`).not.toContain(secret);
    }
    for (const kept of [OUTSIDE_VALUE, OUTSIDE_NOTE, OUTSIDE_LINK]) expect(forensic).toContain(kept);

    expect(outcome.verification).toEqual({ marksCleared: true, remaining: [] });
    expect(outcome.report.steps).toContain('clean(annotations+fields)');
    expect(outcome.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.fieldsRemoved',
      params: { count: 1 },
    });
    expect(outcome.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.annotationsRemoved',
      params: { count: 1 },
    });
  });

  it('removes them on a rotated page too, where the mark is given in the unrotated space', async () => {
    for (const rotate of [90, 180, 270] as const) {
      const source = await build([{ ...TWO_LINES, rotate }], formAndNotes);
      const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);
      expect(await annotationsOf(outcome.bytes), `rotation ${rotate}`).toEqual(OUTSIDE_ANNOTATIONS);
      expect(await fieldNames(outcome.bytes), `rotation ${rotate}`).toEqual(['otherfield']);
    }
  });

  it('counts a rectangle that shares area with a mark, whichever corners it names, and not one that only touches it', async () => {
    const source = await build([TWO_LINES], (doc) => {
      // The mark is x 40–200, user y 290–315.
      const hidden = addWidget(doc, { name: 'hidden', value: 'HIDDENVALUE', rect: [100, 300, 100, 300] });
      const reversed = addNote(doc, { contents: 'REVERSED', rect: [195, 312, 185, 292] });
      const rightEdge = addNote(doc, { contents: 'EDGE-RIGHT', rect: [200, 292, 220, 312] });
      const lowerEdge = addNote(doc, { contents: 'EDGE-BELOW', rect: [100, 270, 120, 290] });
      const point = addNote(doc, { contents: 'EDGE-POINT', rect: [200, 300, 200, 300] });
      const short = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [60, 292, 150],
        Contents: doc.newString('SHORT-RECT'),
      });
      const bare = doc.addObject({ Type: 'Annot', Subtype: 'Square', Contents: doc.newString('NO-RECT') });
      const dangling = doc.newIndirect(9999);
      listOnPage(doc, [hidden, reversed.note, rightEdge.note, lowerEdge.note, point.note, short, bare]);
      doc.findPage(0).get('Annots').push(doc.newInteger(7));
      doc.findPage(0).get('Annots').push(dangling);
      setForm(doc, [hidden]);
    });
    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);
    const kept = (await annotationsOf(outcome.bytes)).map((annotation) => annotation.contents);
    expect(kept).toEqual(['EDGE-RIGHT', 'EDGE-BELOW', 'EDGE-POINT', 'SHORT-RECT', 'NO-RECT']);
    expect(await fieldNames(outcome.bytes)).toEqual([]);
    const forensic = await decompressed(outcome.bytes);
    expect(forensic).not.toContain('HIDDENVALUE');
    expect(forensic).not.toContain('REVERSED');
  });

  it('takes a removed widget out of its parent, drops a parent left without kids, and keeps one that still has a kid', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const keep = doc.addObject({ FT: 'Tx', T: doc.newString('keep'), V: doc.newString('KEEPVALUE') });
      const keptKid = addWidget(doc, { rect: [60, 100, 100, 120], parent: keep });
      const goneKid = addWidget(doc, { rect: [60, 292, 100, 312], parent: keep });
      keep.put('Kids', [goneKid, keptKid]);

      const drop = doc.addObject({ FT: 'Tx', T: doc.newString('drop'), V: doc.newString('DROPVALUE') });
      const dropOne = addWidget(doc, { rect: [110, 292, 140, 312], parent: drop });
      const dropTwo = addWidget(doc, { rect: [150, 292, 190, 312], parent: drop });
      drop.put('Kids', [dropOne, dropTwo]);
      const outer = doc.addObject({ T: doc.newString('OUTERNAME'), Kids: [drop] });
      drop.put('Parent', outer);

      // A node written inside `/Fields` itself, without an object number of its own.
      const inline = doc.newDictionary();
      const inlineKid = addWidget(doc, { rect: [45, 292, 55, 312] });
      inline.put('T', doc.newString('inline'));
      inline.put('Kids', [inlineKid]);

      const hollow = doc.addObject({ T: doc.newString('hollow'), FT: 'Tx', Kids: [] });
      const plain = addWidget(doc, { name: 'plain', value: 'PLAINVALUE', rect: [60, 60, 190, 80] });
      listOnPage(doc, [goneKid, keptKid, dropOne, dropTwo, inlineKid, plain]);
      setForm(doc, [keep, outer, inline, doc.newInteger(3), hollow, plain], { CO: [keep, drop, plain] });
    });
    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);

    expect(await fieldNames(outcome.bytes)).toEqual(['keep', 'hollow', 'plain']);
    const form = await inProduced(outcome.bytes, (doc) => {
      const acro = doc.getTrailer().get('Root').get('AcroForm');
      const keepNode = acro.get('Fields').get(0).resolve();
      return {
        keepKids: keepNode.get('Kids').length,
        keepKidRect: keepNode.get('Kids').get(0).get('Rect').get(1).asNumber(),
        entries: acro.get('Fields').length,
        order: [0, 1].map((index) => acro.get('CO').get(index).get('T').asString()),
        orderLength: acro.get('CO').length,
      };
    });
    expect(form).toEqual({
      keepKids: 1,
      keepKidRect: 100,
      entries: 4,
      order: ['keep', 'plain'],
      orderLength: 2,
    });

    const forensic = await decompressed(outcome.bytes);
    expect(forensic).not.toContain('DROPVALUE');
    expect(forensic).not.toContain('OUTERNAME');
    // The field that still has a widget keeps its value: that widget shows it.
    expect(forensic).toContain('KEEPVALUE');
    expect(forensic).toContain('PLAINVALUE');
    // Four widgets went, two fields with them: `drop` (two widgets) and the loose `inline` one.
    // `keep` lost a widget but still has the other, so it is not a removed field.
    expect(outcome.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.fieldsRemoved',
      params: { count: 2 },
    });
    expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.annotationsRemoved')).toBe(
      false,
    );
  });

  it('removes a field only when its last widget is gone, across pages', async () => {
    const source = await build([TWO_LINES, TWO_LINES], (doc) => {
      const both = doc.addObject({ FT: 'Tx', T: doc.newString('both'), V: doc.newString('BOTHVALUE') });
      const first = addWidget(doc, { rect: [60, 292, 150, 312], parent: both });
      const second = addWidget(doc, { rect: [60, 292, 150, 312], parent: both, pageIndex: 1 });
      both.put('Kids', [first, second]);
      listOnPage(doc, [first], 0);
      listOnPage(doc, [second], 1);
      setForm(doc, [both]);
    });
    const onePage = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);
    expect(await fieldNames(onePage.bytes)).toEqual(['both']);
    expect(await annotationsOf(onePage.bytes, 0)).toEqual([]);
    expect(await annotationsOf(onePage.bytes, 1)).toHaveLength(1);
    expect(await decompressed(onePage.bytes)).toContain('BOTHVALUE');
    // The widget went, the field did not: no field is reported as removed.
    expect(onePage.report.steps).toContain('clean(annotations+fields)');
    expect(onePage.report.notes.some((entry) => entry.key === 'op.note.redact.fieldsRemoved')).toBe(false);

    const bothPages = await redactDocument(
      source,
      { ...BASE, marks: [mark([40, 185, 200, 210], 1), SECRET_MARK] },
      run,
    );
    expect(await fieldNames(bothPages.bytes)).toEqual([]);
    expect(await decompressed(bothPages.bytes)).not.toContain('BOTHVALUE');
    // Two widgets, one field.
    expect(bothPages.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.fieldsRemoved',
      params: { count: 1 },
    });
  });

  it('counts a field once however many widgets it has, and every field that went', async () => {
    const source = await build([TWO_LINES], (doc) => {
      // A radio group of three widgets, a field of two, and a field of one, all under the mark.
      const radio = doc.addObject({ FT: 'Btn', T: doc.newString('radio'), V: 'RADIOVALUE' });
      const radios = [0, 1, 2].map((step) =>
        addWidget(doc, { rect: [45 + step * 20, 292, 60 + step * 20, 312], parent: radio }),
      );
      radio.put('Kids', radios);
      const pair = doc.addObject({ FT: 'Tx', T: doc.newString('pair'), V: doc.newString('PAIRVALUE') });
      const pairKids = [0, 1].map((step) =>
        addWidget(doc, { rect: [110 + step * 40, 292, 140 + step * 40, 312], parent: pair }),
      );
      pair.put('Kids', pairKids);
      const single = addWidget(doc, { name: 'single', value: 'SINGLEVALUE', rect: [45, 316, 190, 330] });
      listOnPage(doc, [...radios, ...pairKids, single]);
      // A widget written inside `/Annots` itself has no object number: it is a field of its own.
      const inline = doc.newDictionary();
      inline.put('Type', 'Annot');
      inline.put('Subtype', 'Widget');
      inline.put('FT', 'Tx');
      inline.put('T', doc.newString('inline'));
      inline.put('Rect', [150, 316, 190, 330]);
      doc.findPage(0).get('Annots').push(inline);
      setForm(doc, [radio, pair, single]);
    });
    const outcome = await redactDocument(source, { ...BASE, marks: [mark([40, 170, 200, 210])] }, run);
    expect(await fieldNames(outcome.bytes)).toEqual([]);
    expect(await annotationsOf(outcome.bytes)).toEqual([]);
    // Seven widgets: the three of `radio`, the two of `pair`, `single` and the inline one.
    expect(outcome.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.fieldsRemoved',
      params: { count: 4 },
    });
  });

  it('takes the popups and replies of a removed comment along, and the comment whose popup window is marked', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const root = addNote(doc, {
        contents: NOTE_SECRET,
        rect: [160, 292, 180, 312],
        popupRect: [300, 200, 380, 260],
      });
      const reply = addNote(doc, {
        contents: 'REPLYSECRET1',
        rect: [300, 100, 320, 120],
        replyTo: root.note,
      });
      const answer = addNote(doc, {
        contents: 'REPLYSECRET2',
        rect: [300, 60, 320, 80],
        replyTo: reply.note,
      });
      const free = addNote(doc, { contents: 'FREE', rect: [300, 20, 320, 40] });
      // The popup window lies inside the mark and shows the comment's text, so the comment
      // goes with it, and so does the reply to that comment.
      const owner = addNote(doc, {
        contents: 'OWNERSECRET',
        rect: [300, 140, 320, 160],
        popupRect: [60, 292, 100, 312],
      });
      const ownerReply = addNote(doc, {
        contents: 'OWNERREPLY',
        rect: [300, 120, 320, 135],
        replyTo: owner.note,
      });
      // A comment that no page lists keeps nothing to draw its popup from: only its link to the window goes.
      const unlisted = addNote(doc, {
        contents: 'UNLISTED',
        rect: [300, 440, 320, 460],
        popupRect: [192, 292, 199, 312],
      });
      doc.getTrailer().get('Root').put('Probe', unlisted.note);
      // A popup that names a parent whose `/Popup` is another popup, and one without a parent.
      const other = addNote(doc, {
        contents: 'OTHER',
        rect: [300, 180, 320, 200],
        popupRect: [300, 400, 380, 450],
      });
      const stray = doc.addObject({
        Type: 'Annot',
        Subtype: 'Popup',
        Rect: [110, 292, 140, 312],
        Parent: other.note,
      });
      const orphan = doc.addObject({ Type: 'Annot', Subtype: 'Popup', Rect: [150, 292, 190, 312] });
      // The answer comes first in the list, so one pass over the list cannot find the whole thread.
      listOnPage(doc, [
        answer.note,
        reply.note,
        root.note,
        root.popup as PDFObject,
        free.note,
        owner.note,
        owner.popup as PDFObject,
        ownerReply.note,
        other.note,
        other.popup as PDFObject,
        unlisted.popup as PDFObject,
        stray,
        orphan,
      ]);
    });
    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);

    expect(
      (await annotationsOf(outcome.bytes)).map((annotation) => annotation.contents ?? annotation.subtype),
    ).toEqual(['FREE', 'OTHER', 'Popup']);
    const links = await inProduced(outcome.bytes, (doc) => {
      const list = doc.findPage(0).get('Annots');
      const other = list.get(1).resolve();
      return {
        otherPopup: other.get('Popup').isIndirect(),
        unlistedPopup: doc.getTrailer().get('Root').get('Probe').get('Popup').isNull(),
      };
    });
    expect(links).toEqual({ otherPopup: true, unlistedPopup: true });
    const forensic = await decompressed(outcome.bytes);
    for (const secret of [NOTE_SECRET, 'REPLYSECRET1', 'REPLYSECRET2', 'OWNERSECRET', 'OWNERREPLY'])
      expect(forensic).not.toContain(secret);
    expect(forensic).toContain('UNLISTED');
    // The comments that went: the marked one, its two replies, the one whose popup window was marked, its reply.
    expect(outcome.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.annotationsRemoved',
      params: { count: 5 },
    });
    expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.fieldsRemoved')).toBe(false);
  });

  it('reads an /Annots array that is an object of its own and removes an annotation written inside it', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const indirect = addNote(doc, { contents: NOTE_SECRET, rect: [160, 292, 180, 312] });
      const outside = addNote(doc, { contents: OUTSIDE_NOTE, rect: [210, 100, 230, 120] });
      const inline = doc.newDictionary();
      inline.put('Type', 'Annot');
      inline.put('Subtype', 'Square');
      inline.put('Rect', [60, 292, 100, 312]);
      inline.put('Contents', doc.newString('INLINESECRET'));
      const list = doc.addObject([]);
      list.push(indirect.note);
      list.push(inline);
      list.push(outside.note);
      doc.findPage(0).put('Annots', list);
    });
    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);
    expect((await annotationsOf(outcome.bytes)).map((annotation) => annotation.contents)).toEqual([
      OUTSIDE_NOTE,
    ]);
    const forensic = await decompressed(outcome.bytes);
    expect(forensic).not.toContain('INLINESECRET');
    expect(forensic).not.toContain(NOTE_SECRET);
  });

  it('removes a field from a document whose form is missing, empty or not a dictionary', async () => {
    const forms: readonly ((doc: PDFDocument) => void)[] = [
      () => undefined,
      (doc) => doc.getTrailer().get('Root').put('AcroForm', { NeedAppearances: true }),
      (doc) => doc.getTrailer().get('Root').put('AcroForm', { Fields: 3 }),
      (doc) => doc.getTrailer().get('Root').put('AcroForm', 3),
    ];
    for (const [index, form] of forms.entries()) {
      const source = await build([TWO_LINES], (doc) => {
        const field = addWidget(doc, { name: 'lone', value: FIELD_SECRET, rect: [60, 292, 150, 312] });
        listOnPage(doc, [field]);
        form(doc);
      });
      const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);
      expect(await annotationsOf(outcome.bytes), `form variant ${index}`).toEqual([]);
      // The field is counted from the widget, so a form tree that cannot be walked does not hide it.
      expect(outcome.report.notes, `form variant ${index}`).toContainEqual({
        kind: 'lost',
        key: 'op.note.redact.fieldsRemoved',
        params: { count: 1 },
      });
      expect(await decompressed(outcome.bytes), `form variant ${index}`).not.toContain(FIELD_SECRET);
    }
  });

  it('stops following a field tree that loops or runs deeper than any form does', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const loop = doc.addObject({ T: doc.newString('loop') });
      const loopKid = addWidget(doc, { rect: [60, 292, 100, 312], parent: loop });
      loop.put('Kids', [loop, loopKid]);

      let node = addWidget(doc, { name: 'bottom', value: FIELD_SECRET, rect: [110, 292, 190, 312] });
      const bottom = node;
      for (let level = 0; level < 70; level += 1) {
        node = doc.addObject({ T: doc.newString(`level${level}`), Kids: [node] });
      }
      listOnPage(doc, [loopKid, bottom]);
      setForm(doc, [loop, node]);
    });
    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);
    const names = await fieldNames(outcome.bytes);
    expect(names[0]).toBe('loop');
    expect(names[1]).toBe('level69');
    // The bottom widget is out of the page and deleted whether or not the walk reached its parent.
    expect(await annotationsOf(outcome.bytes)).toEqual([]);
    expect(await decompressed(outcome.bytes)).not.toContain(FIELD_SECRET);
  });

  it('deletes what it removes even where another object still points at it', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const field = addWidget(doc, { name: 'tagged', value: FIELD_SECRET, rect: [60, 292, 150, 312] });
      listOnPage(doc, [field]);
      setForm(doc, [field]);
      // A structure tree's object reference keeps its target alive in the written file.
      doc
        .getTrailer()
        .get('Root')
        .put('StructTreeRoot', {
          Type: 'StructTreeRoot',
          K: [{ Type: 'OBJR', Obj: field, Pg: doc.findPage(0) }],
        });
    });
    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);
    expect(await decompressed(outcome.bytes)).not.toContain(FIELD_SECRET);
    expect(new TextDecoder('latin1').decode(outcome.bytes)).not.toContain(FIELD_SECRET);
  });

  it('does not call a mark empty when it removed a form field, and still does when nothing was under it', async () => {
    const source = await build([TWO_LINES], formAndNotes);
    // Right of the text, over the field, the link and nothing else: no glyph is touched.
    const overField = await redactDocument(source, { ...BASE, marks: [mark([130, 190, 155, 205])] }, run);
    expect(overField.report.notes.some((entry) => entry.key === 'op.note.redact.emptyMarks')).toBe(false);
    expect(overField.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.fieldsRemoved',
      params: { count: 1 },
    });
    expect(await fieldNames(overField.bytes)).toEqual(['otherfield']);

    const overNothing = await redactDocument(source, { ...BASE, marks: [mark([300, 10, 390, 40])] }, run);
    expect(overNothing.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.redact.emptyMarks',
      params: { pages: '0' },
    });
    expect(overNothing.report.steps).not.toContain('clean(annotations+fields)');
    expect(overNothing.report.notes.some((entry) => entry.key === 'op.note.redact.fieldsRemoved')).toBe(
      false,
    );
    expect(await annotationsOf(overNothing.bytes)).toHaveLength(8);
  });
});

describe('redactDocument: a static XFA form', () => {
  const XFA_SECRET = 'XFASECRET9';
  const datasetsWith = (value: string) =>
    `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>${value}</Name><Agree>0</Agree><Birth>2000-01-01</Birth></form1></xfa:data></xfa:datasets>`;
  /** The `Name` widget spans x 20–180, user y 250–270 of a 300 pt page. */
  const NAME_MARK = mark([10, 25, 190, 55]);

  it('drops the XFA when a field under the mark leaves, so the value is not in the file any more, and says so', async () => {
    for (const layout of ['array', 'stream'] as const) {
      const form = await xfaPdf({ kind: 'static', layout, datasets: datasetsWith(XFA_SECRET) });
      const source = await editWidgets(form, { 'Name[0]': XFA_SECRET });
      // The value is in the file twice: the widget's /V and the XFA data.
      expect(await decompressed(source), layout).toContain(XFA_SECRET);

      const outcome = await redactDocument(source, { ...BASE, marks: [NAME_MARK] }, run);

      expect(await annotationsOf(outcome.bytes), layout).toHaveLength(2);
      expect(new TextDecoder('latin1').decode(outcome.bytes), layout).not.toContain(XFA_SECRET);
      expect(await decompressed(outcome.bytes), layout).not.toContain(XFA_SECRET);
      const kept = await withPdf(outcome.bytes, (doc) => {
        const acro = doc.getTrailer().get('Root').get('AcroForm');
        return { xfaGone: acro.get('XFA').isNull(), fields: acro.get('Fields').length };
      });
      expect(kept, layout).toEqual({ xfaGone: true, fields: 1 });
      expect(outcome.report.notes, layout).toContainEqual({ kind: 'lost', key: 'op.note.redact.xfaDropped' });
      expect(outcome.verification, layout).toEqual({ marksCleared: true, remaining: [] });
    }
  });

  it('keeps the XFA when nothing under the marks was a form field', async () => {
    const form = await xfaPdf({ kind: 'static', datasets: datasetsWith(XFA_SECRET) });
    const outcome = await redactDocument(form, { ...BASE, marks: [mark([300, 200, 390, 290])] }, run);
    const xfa = await withPdf(outcome.bytes, (doc) =>
      doc.getTrailer().get('Root').get('AcroForm').get('XFA').isNull(),
    );
    expect(xfa).toBe(false);
    expect(await decompressed(outcome.bytes)).toContain(XFA_SECRET);
    expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.xfaDropped')).toBe(false);
  });

  it('does not mention an XFA for a form that has none', async () => {
    const outcome = await redactDocument(
      await build([TWO_LINES], formAndNotes),
      { ...BASE, marks: [SECRET_MARK] },
      run,
    );
    expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.xfaDropped')).toBe(false);
  });
});

describe('verifyRedaction', () => {
  it('finds the page whose mark still holds text and passes the one that is empty', async () => {
    const source = await build([TWO_LINES, TWO_LINES]);
    expect(
      await verifyRedaction(source, [mark([40, 185, 200, 210], 1), mark([300, 10, 390, 40], 0)]),
    ).toEqual({
      marksCleared: false,
      remaining: [1],
    });
    expect(await verifyRedaction(source, [mark([300, 10, 390, 40], 0)])).toEqual({
      marksCleared: true,
      remaining: [],
    });
  });

  it('fails a page whose mark still holds a form field or a comment, though no text is left in it', async () => {
    const source = await build([TWO_LINES, TWO_LINES], formAndNotes);
    // "Secret 4711" ends near x 115, the field spans x 60–150 and the comment x 160–180 (all at
    // the same height): right of the text, only an annotation is inside each of these marks.
    expect(await verifyRedaction(source, [mark([130, 190, 155, 205])])).toEqual({
      marksCleared: false,
      remaining: [0],
    });
    expect(await verifyRedaction(source, [mark([165, 190, 200, 205])])).toEqual({
      marksCleared: false,
      remaining: [0],
    });
    // Over nothing at all on page 1, and on a page that carries no annotations.
    expect(await verifyRedaction(source, [mark([300, 10, 390, 40]), mark([130, 190, 155, 205], 1)])).toEqual({
      marksCleared: true,
      remaining: [],
    });
  });

  it('does not count a redaction annotation that is still waiting to be applied', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const pending = doc.addObject({ Type: 'Annot', Subtype: 'Redact', Rect: [130, 295, 155, 310] });
      listOnPage(doc, [pending]);
    });
    expect(await verifyRedaction(source, [mark([130, 190, 155, 205])])).toEqual({
      marksCleared: true,
      remaining: [],
    });
  });

  it('counts a glyph only when half of it lies inside the mark', async () => {
    const source = await build([TWO_LINES]);
    // "Secret 4711" starts at x 50; a mark ending at 51 touches the first glyph by a sliver.
    expect(await verifyRedaction(source, [mark([40, 185, 51, 210])])).toEqual({
      marksCleared: true,
      remaining: [],
    });
    expect(await verifyRedaction(source, [mark([40, 185, 58, 210])])).toEqual({
      marksCleared: false,
      remaining: [0],
    });
  });

  it('reports a page that does not exist as remaining content, and reads rotated pages in the stored space', async () => {
    const rotated = await build([{ ...TWO_LINES, rotate: 90 }]);
    expect(
      await verifyRedaction(rotated, [mark([40, 185, 200, 210], 3), mark([40, 185, 200, 210], -1)]),
    ).toEqual({
      marksCleared: false,
      remaining: [-1, 3],
    });
    expect(await verifyRedaction(rotated, [SECRET_MARK])).toEqual({ marksCleared: false, remaining: [0] });
  });

  it('refuses a mark with an unknown geometry space', async () => {
    const legacy = { pageIndex: 0, rect: [0, 0, 10, 10] } as unknown as RedactRect;
    await expect(verifyRedaction(await build([TWO_LINES]), [legacy])).rejects.toMatchObject({
      code: 'redaction-geometry-unknown',
    });
  });

  it('does not count a glyph without extent as remaining text', async () => {
    // Horizontal scaling 0 leaves glyph quads with no width: nothing inside the mark is drawn.
    const source = await build([TWO_LINES], (doc) => {
      doc.findPage(0).put('Contents', doc.addStream('BT /F1 12 Tf 0 Tz 50 300 Td (Hidden) Tj ET', {}));
    });
    expect(await verifyRedaction(source, [SECRET_MARK])).toEqual({ marksCleared: true, remaining: [] });
  });

  it('refuses a page without a readable box as a damaged document', async () => {
    const source = await build([TWO_LINES], (doc) => {
      doc.findPage(0).delete('MediaBox');
    });
    await expect(verifyRedaction(source, [SECRET_MARK])).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'page has no readable CropBox/MediaBox' },
    });
  });

  it('maps an engine failure on bytes that are not a PDF', async () => {
    await expect(verifyRedaction(new TextEncoder().encode('nope'), [SECRET_MARK])).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engine: 'mupdf' },
    });
  });
});
