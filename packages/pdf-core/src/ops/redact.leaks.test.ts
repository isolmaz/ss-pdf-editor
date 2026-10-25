/**
 * What a redaction leaves outside the marks, against the real MuPDF engine: an attached file that
 * survives in `/Root /AF` or in a file-attachment annotation after the attachments were "cleaned",
 * a document whose only attachment the Attachments panel cannot list, a thumbnail of the page as it
 * was, and the alt and replacement text of the tags — which spell the erased words a second time,
 * in the structure tree, in the content stream and in the forms the page draws. Every case reads the
 * produced bytes back.
 */

import type { PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { listPdfAttachments } from '../attachments';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { resolved } from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { addAttachments, pdfjsText, removeAttachments } from './attachments-write';
import { type RedactOptions, redactDocument } from './redact';
import {
  annotationsOf,
  build,
  decompressed,
  inProduced,
  mark,
  pageTexts,
  TWO_LINES,
} from './redact.fixtures';
import {
  annotationOnlyDocument,
  associatedEdgeCases,
  associatedElsewhere,
  attachedByKeyBytes,
  attachedDocument,
  attachedInKids,
  bareDocument,
  DIRECT_PAYLOAD,
  ELSEWHERE_PAYLOAD,
  encode,
  KEPT_TAG_TEXT,
  PAYLOAD,
  readableText,
  sharedFormDocument,
  sharedResourcesDocument,
  TAG_SECRETS,
  taggedDocument,
  utf16be,
  withThumbnails,
} from './redact.leaks.fixtures';
import { scrubRedactedPages } from './redact-leaks';

const run = { signal: new AbortController().signal };

const BASE: Omit<RedactOptions, 'marks'> = {
  imageMethod: 0,
  textMethod: 0,
  cleanMetadata: false,
  cleanAttachments: false,
};

/** Covers the second line of `TWO_LINES` (user y 290–315 of a 500 pt page). */
const SECRET_MARK = mark([40, 185, 200, 210]);

/** Every attached file goes, and the second line of `TWO_LINES` is marked. */
const ALL_ATTACHMENTS = { ...BASE, cleanAttachments: true, marks: [SECRET_MARK] } satisfies RedactOptions;

/** Covers "Secret 4711" on the 200 pt pages of the tagged fixtures (baseline at user y 150). */
const TAGGED_MARK = mark([10, 30, 100, 60]);

/** "a", the undefined PDFDocEncoding byte 0x9F, ".txt". */
const UNDEFINED_BYTE = Uint8Array.from([0x61, 0x9f, 0x2e, 0x74, 0x78, 0x74]);

/** `/AF` as a key, not the start of `/AFRelationship`. */
const AF_KEY = /\/AF(?![A-Za-z])/;

const removedFiles = (count: number) => ({
  kind: 'lost',
  key: 'op.note.redact.attachmentsRemoved',
  params: { count },
});

const tagTextRemoved = (count: number) => ({
  kind: 'lost',
  key: 'op.note.redact.tagTextRemoved',
  params: { count },
});

/** The attachment names pdf.js lists — what the Attachments panel shows and removes by. */
async function listedIds(bytes: Uint8Array): Promise<string[]> {
  const handle = await openWithPdfjs(bytes);
  try {
    return (await listPdfAttachments(handle)).map((attachment) => attachment.id);
  } finally {
    await handle.destroy();
  }
}

describe('redactDocument: attachments', () => {
  it('takes a file out of the name tree, /Root /AF, a page /AF and a file-attachment annotation', async () => {
    const source = await attachedDocument();
    const before = await decompressed(source);
    for (const payload of Object.values(PAYLOAD)) expect(before).toContain(payload);
    expect(before).toMatch(AF_KEY);
    expect(before).toContain('/FileAttachment');

    const outcome = await redactDocument(source, ALL_ATTACHMENTS, run);

    const after = await decompressed(outcome.bytes);
    for (const payload of Object.values(PAYLOAD)) expect(after).not.toContain(payload);
    expect(after).not.toMatch(AF_KEY);
    // No file object, no icon, no popup window, and no empty name tree left behind.
    for (const leftover of ['/FileAttachment', '/Popup', '/Filespec', '/EmbeddedFile', '/Names']) {
      expect(after, leftover).not.toContain(leftover);
    }
    // The link elsewhere on the page is not an attachment and stays.
    expect((await annotationsOf(outcome.bytes)).map((annotation) => annotation.subtype)).toEqual(['Link']);
    expect((await pageTexts(outcome.bytes))[0]).toBe('Public line');

    expect(outcome.report.steps).toContain('clean(attachments)');
    // The tree file, the file only `/AF` lists, and the annotation's file (listed on the page too): three files.
    expect(outcome.report.notes).toContainEqual(removedFiles(3));
  });

  it('removes every file of the name tree, not a chosen few', async () => {
    const attached = await addAttachments(
      await build([TWO_LINES]),
      [
        { name: 'a.txt', bytes: encode('PAYLOAD-A-4410'), mime: 'text/plain' },
        { name: 'b.txt', bytes: encode('PAYLOAD-B-4411'), mime: 'text/plain' },
      ],
      run,
    );

    const outcome = await redactDocument(attached.bytes, ALL_ATTACHMENTS, run);

    const after = await decompressed(outcome.bytes);
    expect(after).not.toContain('PAYLOAD-');
    expect(after).not.toMatch(AF_KEY);
    expect(after).not.toContain('/EmbeddedFiles');
    expect(outcome.report.notes).toContainEqual(removedFiles(2));
  });

  it('cleans a name tree that is split into /Kids', async () => {
    const source = await attachedInKids([
      ['a.txt', 'KIDS-PAYLOAD-A'],
      ['b.txt', 'KIDS-PAYLOAD-B'],
    ]);

    const outcome = await redactDocument(source, ALL_ATTACHMENTS, run);

    const after = await decompressed(outcome.bytes);
    expect(after).not.toContain('KIDS-PAYLOAD');
    expect(after).not.toContain('/EmbeddedFiles');
    // The destination tree next to the attachments stays, and so does the `/Names` that holds it.
    expect(after).toContain('/Dests');
    // The first leaf is listed twice: its file counts once.
    expect(outcome.report.notes).toContainEqual(removedFiles(2));
  });

  it('removes an inline file specification and counts a reference to nothing as no file', async () => {
    const source = await associatedEdgeCases();
    expect(await decompressed(source)).toContain(DIRECT_PAYLOAD);

    const outcome = await redactDocument(source, ALL_ATTACHMENTS, run);

    const after = await decompressed(outcome.bytes);
    expect(after).not.toContain(DIRECT_PAYLOAD);
    expect(after).not.toMatch(AF_KEY);
    expect(outcome.report.notes).toContainEqual(removedFiles(1));
  });

  it('removes the files an annotation and a structure element list in their /AF', async () => {
    const source = await associatedElsewhere();
    const before = await decompressed(source);
    for (const payload of Object.values(ELSEWHERE_PAYLOAD)) expect(before).toContain(payload);
    expect(before).toMatch(AF_KEY);

    const outcome = await redactDocument(source, ALL_ATTACHMENTS, run);

    const after = await decompressed(outcome.bytes);
    for (const payload of Object.values(ELSEWHERE_PAYLOAD)) expect(after).not.toContain(payload);
    expect(after).not.toMatch(AF_KEY);
    for (const leftover of ['/Filespec', '/EmbeddedFile']) expect(after, leftover).not.toContain(leftover);
    // The link carrying the list is not an attachment and stays.
    expect((await annotationsOf(outcome.bytes)).map((annotation) => annotation.subtype)).toContain('Link');
    expect(outcome.report.notes).toContainEqual(removedFiles(2));
  });

  it('removes a file-attachment annotation from a document whose Attachments panel lists nothing', async () => {
    const source = await annotationOnlyDocument();
    expect(await listedIds(source)).toEqual([]);
    expect(await decompressed(source)).toContain(PAYLOAD.annotation);

    const outcome = await redactDocument(source, ALL_ATTACHMENTS, run);

    const after = await decompressed(outcome.bytes);
    expect(after).not.toContain(PAYLOAD.annotation);
    expect(after).not.toContain('/FileAttachment');
    expect(await annotationsOf(outcome.bytes)).toEqual([]);
    expect(outcome.report.steps).toContain('clean(attachments)');
    expect(outcome.report.notes).toContainEqual(removedFiles(1));
  });

  it.each([
    { label: 'UTF-16BE', key: utf16be('Gizli-Şğ.txt') },
    { label: 'UTF-16BE with a language escape', key: utf16be('\u001btr\u001bad.txt') },
    { label: 'PDFDocEncoding with an undefined byte', key: UNDEFINED_BYTE },
  ])('removes an attachment whose name is $label', async ({ key }) => {
    const source = await attachedByKeyBytes([key], 'NAMED-PAYLOAD-6620');
    expect(await listedIds(source)).toHaveLength(1);

    const outcome = await redactDocument(source, ALL_ATTACHMENTS, run);

    expect(await listedIds(outcome.bytes)).toEqual([]);
    expect(await decompressed(outcome.bytes)).not.toContain('NAMED-PAYLOAD-6620');
    expect(outcome.report.notes).toContainEqual(removedFiles(1));
  });

  it('reports nothing for a document that has no attachment', async () => {
    const outcome = await redactDocument(await build([TWO_LINES]), ALL_ATTACHMENTS, run);

    expect(outcome.report.steps).not.toContain('clean(attachments)');
    expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.attachmentsRemoved')).toBe(
      false,
    );
  });

  it('leaves every attachment alone when the option is off', async () => {
    const outcome = await redactDocument(await attachedDocument(), { ...BASE, marks: [SECRET_MARK] }, run);

    const after = await decompressed(outcome.bytes);
    for (const payload of Object.values(PAYLOAD)) expect(after).toContain(payload);
    expect(after).toMatch(AF_KEY);
    expect(outcome.report.steps).not.toContain('clean(attachments)');
  });
});

describe('pdfjsText', () => {
  it.each([
    { label: 'UTF-16BE', bytes: [0xfe, 0xff, 0x01, 0x5e, 0x00, 0x61], text: 'Şa' },
    { label: 'UTF-16LE', bytes: [0xff, 0xfe, 0x5e, 0x01, 0x61, 0x00], text: 'Şa' },
    { label: 'UTF-8', bytes: [0xef, 0xbb, 0xbf, 0xc5, 0x9e, 0x61], text: 'Şa' },
    // The language escape pdf.js keeps and MuPDF drops.
    { label: 'UTF-16BE with an escape', bytes: [0xfe, 0xff, 0x00, 0x1b, 0x00, 0x61], text: '\u001ba' },
    { label: 'UTF-16BE with a dangling last byte', bytes: [0xfe, 0xff, 0x00, 0x61, 0x00], text: 'a' },
    // Not valid UTF-8: pdf.js reads the bytes as PDFDocEncoding.
    {
      label: 'a UTF-8 mark and a cut character',
      bytes: [0xef, 0xbb, 0xbf, 0xc5],
      text: '\u00ef\u00bb\u00bf\u00c5',
    },
    // 0xFF is the start of a UTF-16LE mark only with 0xFE behind it.
    { label: 'a byte that only starts a mark', bytes: [0xff, 0x41], text: '\u00ffA' },
    {
      label: 'PDFDocEncoding punctuation and controls',
      bytes: [0x80, 0x18, 0x9f, 0x41],
      text: '\u2022\u02d8\u009fA',
    },
    { label: 'nothing', bytes: [], text: '' },
  ])('reads $label the way pdf.js does', ({ bytes, text }) => {
    expect(pdfjsText(Uint8Array.from(bytes))).toBe(text);
  });
});

describe('removeAttachments: names as pdf.js lists them', () => {
  it.each([
    // MuPDF and pdf.js read this one alike; it pins that a UTF-16BE name is removed at all.
    { label: 'UTF-16BE', key: utf16be('Gizli-Şğ.txt') },
    // MuPDF drops the `ESC tr ESC` language tag inside UTF-16, pdf.js keeps it.
    { label: 'UTF-16BE with a language escape', key: utf16be('\u001btr\u001bad.txt') },
    // MuPDF turns the undefined PDFDocEncoding byte 0x9F into U+FFFD, pdf.js keeps U+009F.
    { label: 'PDFDocEncoding with an undefined byte', key: UNDEFINED_BYTE },
  ])('removes an attachment whose name is $label, under the name pdf.js lists it by', async ({ key }) => {
    const source = await attachedByKeyBytes([key], 'NAMED-PAYLOAD-6620');
    const ids = await listedIds(source);
    expect(ids).toHaveLength(1);

    const outcome = await removeAttachments(source, ids, run);

    expect(outcome.removed).toEqual(ids);
    expect(outcome.missing).toEqual([]);
    expect(await listedIds(outcome.bytes)).toEqual([]);
    expect(await decompressed(outcome.bytes)).not.toContain('NAMED-PAYLOAD-6620');
  });
});

/**
 * The forms a page draws (and the forms inside them), as the produced file has them: every stream's
 * text and every `/ActualText` of their `/Properties`, and the object numbers of the page's own forms by name.
 */
function formsOf(bytes: Uint8Array, pageIndex: number) {
  return inProduced(bytes, (doc) => {
    const parts: string[] = [];
    const seen = new Set<number>();
    const visit = (resources: PDFObject): void => {
      resolved(resources.get('XObject'))?.forEach((entry) => {
        if (!entry.isStream() || seen.has(entry.asIndirect())) return;
        seen.add(entry.asIndirect());
        parts.push(entry.readStream().asString());
        const own = resolved(entry.resolve().get('Resources'));
        if (own === null) return;
        resolved(own.get('Properties'))?.forEach((property) => {
          const text = resolved(property)?.get('ActualText');
          if (text !== undefined && !text.isNull()) parts.push(text.asString());
        });
        visit(own);
      });
    };
    const resources = resolved(doc.findPage(pageIndex).getInheritable('Resources')) as PDFObject;
    visit(resources);
    const objects: Record<string, number> = {};
    resolved(resources.get('XObject'))?.forEach((entry, name) => {
      if (entry.isStream()) objects[name] = entry.asIndirect();
    });
    return { text: parts.join('\n'), objects };
  });
}

describe('redactDocument: what a redacted page keeps of itself', () => {
  it('drops the thumbnail of a page that carried a mark and keeps the one of a page that did not', async () => {
    const outcome = await redactDocument(await withThumbnails(), { ...BASE, marks: [SECRET_MARK] }, run);

    const thumbnails = await inProduced(outcome.bytes, (doc) =>
      [0, 1].map((index) => !doc.findPage(index).get('Thumb').isNull()),
    );
    expect(thumbnails).toEqual([false, true]);
    const after = await decompressed(outcome.bytes);
    expect(after).not.toContain('THUMBNAIL-OF-PAGE-0');
    expect(after).toContain('THUMBNAIL-OF-PAGE-1');
  });

  it('removes the alt and replacement text of the tags and the marked content of a redacted page', async () => {
    const source = await taggedDocument();
    const before = await readableText(source);
    for (const text of [...TAG_SECRETS, ...KEPT_TAG_TEXT]) expect(before, text).toContain(text);

    const outcome = await redactDocument(source, { ...BASE, marks: [TAGGED_MARK] }, run);

    const after = await readableText(outcome.bytes);
    for (const secret of TAG_SECRETS) expect(after, secret).not.toContain(secret);
    // The other page's tags are not this redaction's business.
    for (const kept of KEPT_TAG_TEXT) expect(after, kept).toContain(kept);

    const [first] = await pageTexts(outcome.bytes);
    expect(first).toContain('Public line');
    expect(first).not.toContain('Secret 4711');

    // The tags themselves stay: nine elements, and the marked-content sequences with their MCIDs.
    const dump = await decompressed(outcome.bytes);
    expect(dump.match(/\/Type\/StructElem/g)).toHaveLength(9);
    expect(dump).toMatch(/\/Figure\s*<<\s*\/MCID 0\s*>>\s*BDC/);
    expect(dump).toMatch(/\/Span\s*<<\s*\/MCID 1\s*>>\s*BDC/);
    // Nine entries off the structure elements (Alt, ActualText, E, one more Alt and ActualText, a bare Alt,
    // and one each off the single-kid, OBJR and parent-tree-only elements), two off the `BDC`
    // dictionaries, two off the named property dictionary.
    expect(outcome.report.notes).toContainEqual(tagTextRemoved(13));
  });

  it('does not edit the property dictionaries a redacted page shares with a page that has no mark', async () => {
    const outcome = await redactDocument(
      await sharedResourcesDocument(),
      { ...BASE, marks: [TAGGED_MARK] },
      run,
    );

    const actualText = await inProduced(outcome.bytes, (doc) =>
      [0, 1].map((index) => {
        const properties = doc.findPage(index).getInheritable('Resources').resolve().get('Properties');
        const value = properties.resolve().get('MC7').resolve().get('ActualText');
        return value.isNull() ? null : value.asString();
      }),
    );
    expect(actualText).toEqual([null, 'SHARED-ACTUALTEXT-SECRET']);
    expect(outcome.report.notes).toContainEqual(tagTextRemoved(1));
  });

  it('scrubs the forms a redacted page draws as copies and leaves the form another page draws as it was', async () => {
    const source = await sharedFormDocument();
    const before = await formsOf(source, 0);
    for (const secret of ['FORM-ACTUALTEXT-SECRET', 'FORM-PROPERTY-SECRET', 'NESTED-ALT-SECRET']) {
      expect(before.text, secret).toContain(secret);
    }

    const outcome = await redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, run);

    const marked = await formsOf(outcome.bytes, 0);
    for (const secret of ['FORM-ACTUALTEXT-SECRET', 'FORM-PROPERTY-SECRET', 'NESTED-ALT-SECRET']) {
      expect(marked.text, secret).not.toContain(secret);
    }
    expect(marked.text).toContain('Form text');
    // The page without a mark still draws the original form, with the text it had, not the marked page's copy.
    // (Its nested form and property dictionary are not asserted: MuPDF's own `applyRedactions` deletes the
    // originals the marked page's filtered copies replace, whoever else uses them.)
    const untouched = await formsOf(outcome.bytes, 1);
    expect(untouched.text).toContain('FORM-ACTUALTEXT-SECRET');
    expect(untouched.objects.Fm1).not.toBe(marked.objects.Fm1);
    // The content text, the property text and the nested form's alt text.
    expect(outcome.report.notes).toContainEqual(tagTextRemoved(3));
  });

  it('leaves a page without content or resources as it is', async () => {
    const outcome = await redactDocument(
      await bareDocument(),
      { ...BASE, marks: [SECRET_MARK, mark([40, 185, 200, 210], 1)] },
      run,
    );

    expect(await pageTexts(outcome.bytes)).toEqual(['Public line', '']);
    expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.tagTextRemoved')).toBe(false);
  });
});

/** `scrubRedactedPages` on its own, without MuPDF's `applyRedactions` (which prunes and rewrites a page's forms first). */
async function scrubbed(bytes: Uint8Array, pages: readonly number[]) {
  const doc = openPdf(await loadMupdf(), bytes);
  try {
    const removed = scrubRedactedPages(doc, pages);
    return { removed, bytes: new Uint8Array(doc.saveToBuffer('garbage').asUint8Array()) };
  } finally {
    doc.destroy();
  }
}

describe('scrubRedactedPages: forms', () => {
  it('gives two pages that draw the same forms one copy of each, and counts their text once', async () => {
    const source = await sharedFormDocument();
    const { removed, bytes } = await scrubbed(source, [0, 1]);

    const [one, two] = [await formsOf(bytes, 0), await formsOf(bytes, 1)];
    for (const page of [one, two]) {
      for (const secret of [
        'FORM-ACTUALTEXT-SECRET',
        'FORM-PROPERTY-SECRET',
        'NESTED-ALT-SECRET',
        'UNUSED-ACTUALTEXT-SECRET',
      ]) {
        expect(page.text, secret).not.toContain(secret);
      }
    }
    // Content, property and nested form of `Fm1`, and the form no content draws: each once, not once per page.
    expect(removed).toBe(4);
    expect(two.objects.Fm1).toBe(one.objects.Fm1);
    expect(two.objects.Fm6).toBe(one.objects.Fm6);
    // What had no text, or is no form, is the object it was: the plain form, the image, the form that draws itself.
    const original = await formsOf(source, 0);
    for (const name of ['Fm3', 'Fm5', 'Im1']) expect(one.objects[name], name).toBe(original.objects[name]);
    expect(Object.keys(original.objects).sort()).toEqual(['Fm1', 'Fm3', 'Fm5', 'Fm6', 'Im1']);
  });

  it('leaves a page that has no content and no resources as it is', async () => {
    const { removed, bytes } = await scrubbed(await bareDocument(), [1]);

    expect(removed).toBe(0);
    const bare = await inProduced(bytes, (doc) => {
      const page = doc.findPage(1);
      return [page.get('Contents').isNull(), page.get('Resources').isNull()];
    });
    expect(bare).toEqual([true, true]);
  });
});
