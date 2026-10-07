/**
 * The annotation writers the engine has no writer for, against real bytes and read back
 * through the app's own reader (pdf.js). The wrong answers that matter: a shape that
 * lands somewhere else than it was drawn or without an appearance (some readers then
 * show nothing), a line whose endpoints swap, a retag that renames a popup or an
 * unrelated highlight, a marker resolved to its popup instead of itself, and a comment
 * whose session marker is lost (the next edit can no longer find it).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as mupdf from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import {
  writeAnnotationsToFile,
  writeNoteAnnotations,
  writeShapeAnnotations,
  writeStrokeHighlights,
} from './annotation-shapes';
import {
  type AnnotationMark,
  type ExistingAnnotation,
  markerFor,
  markerTargets,
  readAnnotations,
  settleEngineMarks,
} from './annotations';

const run = { signal: new AbortController().signal };

/** Two 400×500 pages; the second has a CropBox that starts at (50, 50). */
async function blank(extra?: (doc: mupdf.PDFDocument) => void): Promise<Uint8Array> {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  doc.findPage(1).put('CropBox', [50, 50, 350, 450]);
  extra?.(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function mark(overrides: Partial<AnnotationMark> & Pick<AnnotationMark, 'id' | 'kind'>): AnnotationMark {
  return {
    pageIndex: 0,
    quads: [[40, 60, 200, 90]],
    color: '#ff0000',
    opacity: 0.5,
    contents: 'Şişli notu',
    author: 'Ayşe',
    createdAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

async function annotationsOf(bytes: Uint8Array): Promise<readonly ExistingAnnotation[]> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await readAnnotations(handle, run);
  } finally {
    await handle.destroy();
  }
}

/**
 * Per annotation this app named (`Subtype|marker`): whether it carries a normal appearance
 * stream, its `/CA` (pdf.js does not report opacity for every kind) and its `/Contents`.
 */
async function appearances(
  bytes: Uint8Array,
): Promise<Record<string, { ap: boolean; ca: number | null; contents: string | null }>> {
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const found: Record<string, { ap: boolean; ca: number | null; contents: string | null }> = {};
    for (let page = 0; page < doc.countPages(); page += 1) {
      const annots = doc.findPage(page).get('Annots');
      if (annots.isNull()) continue;
      const array = annots.resolve();
      for (let index = 0; index < array.length; index += 1) {
        const dict = array.get(index).resolve();
        const name = dict.get('NM');
        if (name.isNull()) continue;
        const ap = dict.get('AP');
        const ca = dict.get('CA');
        const contents = dict.get('Contents');
        found[`${dict.get('Subtype').asName()}|${name.asString()}`] = {
          ap: !ap.isNull() && ap.resolve().get('N').isStream(),
          ca: ca.isNull() ? null : ca.asNumber(),
          contents: contents.isNull() ? null : contents.asString(),
        };
      }
    }
    return found;
  } finally {
    doc.destroy();
  }
}

describe('writeShapeAnnotations', () => {
  it('writes each shape where it was drawn, with its colour, opacity, comment and an appearance', async () => {
    const shapes = [
      mark({ id: 'sq', kind: 'shapes', shape: 'square', rect: [40, 60, 200, 160], thickness: 2 }),
      mark({ id: 'ci', kind: 'shapes', shape: 'circle', rect: [100, 200, 300, 260], color: '#0000ff' }),
      mark({ id: 'li', kind: 'shapes', shape: 'line', rect: [300, 400, 50, 350], thickness: 4 }),
      mark({ id: 'p2', kind: 'shapes', shape: 'square', pageIndex: 1, rect: [0, 0, 100, 50] }),
    ];
    const out = await writeShapeAnnotations(await blank(), shapes, run);
    expect(out.written).toEqual(shapes.map((shape) => markerFor(shape.id)));

    const read = await annotationsOf(out.bytes);
    const byMarker = (id: string) => read.find((entry) => entry.marker === id);
    // Page space is top-left; the file is bottom-left, padded by half the stroke.
    expect(byMarker('sq')).toMatchObject({ subtype: 'Square', rect: [39, 339, 201, 441], color: '#ff0000' });
    // The comment is the author's words alone: the marker is the annotation's `/NM`, and
    // `/Contents` is what every other reader prints.
    expect(byMarker('sq')?.contents).toBe('Şişli notu');
    expect(byMarker('ci')).toMatchObject({ subtype: 'Circle', color: '#0000ff' });
    // pdf.js reports a line's coordinates normalised, so only the span is checked here.
    expect(byMarker('li')).toMatchObject({ subtype: 'Line', vertices: [50, 100, 300, 150] });
    // The second page's box starts at y = 50, so its top is at 450, not 500.
    expect(byMarker('p2')).toMatchObject({ pageIndex: 1, subtype: 'Square', rect: [-1, 399, 101, 451] });
    // The stroke width is the annotation's border width, so a reader (and this app, reopening
    // the file) reads back the thickness that was drawn; a mark without one is drawn at 2 pt.
    expect(['sq', 'ci', 'li', 'p2'].map((id) => byMarker(id)?.thickness)).toEqual([2, 2, 4, 2]);
    const drawn = Object.values(await appearances(out.bytes));
    expect(drawn.map((entry) => entry.ap)).toEqual([true, true, true, true]);
    expect(drawn.map((entry) => entry.ca)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(drawn.map((entry) => entry.contents)).toEqual([
      'Şişli notu',
      'Şişli notu',
      'Şişli notu',
      'Şişli notu',
    ]);
  });

  it('paints each shape with its own outline, stroke width and colour, and keeps a line in drag order', async () => {
    const shapes = [
      mark({ id: 'sq', kind: 'shapes', shape: 'square', rect: [40, 60, 200, 160], thickness: 6, opacity: 1 }),
      mark({
        id: 'ci',
        kind: 'shapes',
        shape: 'circle',
        rect: [100, 200, 300, 260],
        color: '#0000ff',
        thickness: 6,
        opacity: 1,
      }),
      mark({
        id: 'li',
        kind: 'shapes',
        shape: 'line',
        rect: [300, 400, 50, 350],
        color: '#00aa00',
        thickness: 6,
        opacity: 1,
      }),
    ];
    const out = await writeShapeAnnotations(await blank(), shapes, run);
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      // The file's own /L is in drag order: from (300, 400) to (50, 350) in top-left page space.
      const annots = doc.asPDF()?.findPage(0).get('Annots').resolve();
      let endpoints: number[] | null = null;
      for (let index = 0; index < (annots?.length ?? 0); index += 1) {
        const dict = annots?.get(index).resolve();
        if (dict?.get('Subtype').asName() !== 'Line') continue;
        const list = dict.get('L').resolve();
        endpoints = [0, 1, 2, 3].map((position) => list.get(position).asNumber());
      }
      expect(endpoints).toEqual([300, 100, 50, 150]);

      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const at = (x: number, y: number): number[] => {
        const offset = (y * pixmap.getWidth() + x) * pixmap.getNumberOfComponents();
        return [pixels[offset] ?? -1, pixels[offset + 1] ?? -1, pixels[offset + 2] ?? -1];
      };
      const white = [255, 255, 255];
      const red = [255, 0, 0];
      const blue = [0, 0, 255];
      const green = [0, 0xaa, 0];

      // Square: the outline sits on the drawn box, 6 pt wide, hollow inside and outside it.
      expect(at(40, 110)).toEqual(red);
      expect(at(120, 60)).toEqual(red);
      expect(at(200, 110)).toEqual(red);
      expect(at(120, 160)).toEqual(red);
      expect(at(120, 110)).toEqual(white);
      expect(at(30, 110)).toEqual(white);
      expect(at(42, 110)).toEqual(red); // within the half-stroke (37..43)...
      expect(at(44, 110)).toEqual(white); // ...and no further: the width is the mark's, not a default
      expect(at(120, 158)).toEqual(red); // the bottom edge spans 157..163 as well,
      expect(at(120, 164)).toEqual(white); // not a stroke shifted away from the box
      // Circle: the outline touches the four side midpoints but not the box corners.
      expect(at(100, 230)).toEqual(blue);
      expect(at(200, 200)).toEqual(blue);
      expect(at(300, 230)).toEqual(blue);
      expect(at(200, 260)).toEqual(blue);
      expect(at(101, 201)).toEqual(white);
      expect(at(299, 259)).toEqual(white);
      expect(at(200, 230)).toEqual(white);
      // Line: it runs between its two endpoints and nowhere else.
      expect(at(175, 375)).toEqual(green);
      expect(at(300, 400)).toEqual(green);
      expect(at(175, 340)).toEqual(white);
    } finally {
      doc.destroy();
    }
  });

  it('paints a translucent shape translucent: the appearance carries the opacity, not only /CA', async () => {
    // A reader paints the `/AP`; with the alpha only on the annotation's `/CA` a 40 %
    // rectangle came out of the export as a solid one.
    const out = await writeShapeAnnotations(
      await blank(),
      [
        mark({
          id: 'sq',
          kind: 'shapes',
          shape: 'square',
          rect: [40, 60, 200, 160],
          thickness: 6,
          opacity: 0.4,
        }),
      ],
      run,
    );
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const offset = (110 * pixmap.getWidth() + 40) * pixmap.getNumberOfComponents();
      const [red, green, blue] = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      // Red at 40 % over white: (255, 153, 153), give or take the rasteriser's rounding.
      expect(red).toBe(255);
      expect(green).toBeGreaterThan(140);
      expect(green).toBeLessThan(166);
      expect(blue).toBeGreaterThan(140);
      expect(blue).toBeLessThan(166);
    } finally {
      doc.destroy();
    }
  });

  it('refuses a mark on a page the document does not have', async () => {
    await expect(
      writeShapeAnnotations(
        await blank(),
        [mark({ id: 'x', kind: 'shapes', shape: 'square', pageIndex: 5 })],
        run,
      ),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });
});

/**
 * A page with what the engine's highlight writer leaves behind for three session marks
 * (all `/Highlight`), one of them with a popup that carries the same comment, and an
 * unrelated highlight of the document's own.
 */
async function engineWritten(): Promise<Uint8Array> {
  return blank((doc) => {
    const page = doc.findPage(0);
    const annots = doc.newArray();
    const highlight = (id: string, top: number) => {
      const dict = doc.addObject({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [40, top - 30, 200, top],
        QuadPoints: [40, top, 200, top, 40, top - 30, 200, top - 30],
        P: page,
      });
      dict.put('Contents', doc.newString(`${markerFor(id)}\nyorum`));
      annots.push(dict);
      return dict;
    };
    const underlined = highlight('u1', 440);
    highlight('s1', 380);
    highlight('q1', 320);
    const popup = doc.addObject({
      Type: 'Annot',
      Subtype: 'Popup',
      Rect: [210, 400, 300, 440],
      Parent: underlined,
    });
    popup.put('Contents', doc.newString(`${markerFor('u1')}\nyorum`));
    underlined.put('Popup', popup);
    annots.push(popup);
    const own = doc.addObject({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [40, 100, 200, 130],
      QuadPoints: [40, 130, 200, 130, 40, 100, 200, 100],
      P: page,
    });
    own.put('Contents', doc.newString('the document’s own'));
    annots.push(own);
    page.put('Annots', annots);
  });
}

describe('settleEngineMarks', () => {
  it('turns each session highlight into its own kind and leaves the popup and the rest alone', async () => {
    const marks = [
      mark({ id: 'u1', kind: 'underline', quads: [[40, 60, 200, 90]] }),
      mark({ id: 's1', kind: 'strikeout', quads: [[40, 120, 200, 150]] }),
      mark({ id: 'q1', kind: 'squiggly', quads: [[40, 180, 200, 210]] }),
    ];
    const out = await settleEngineMarks(await engineWritten(), marks, run);
    expect(out.retagged).toHaveLength(3);
    const subtypes = (await annotationsOf(out.bytes)).map((entry) => entry.subtype).sort();
    expect(subtypes).toEqual(['Highlight', 'Popup', 'Squiggly', 'StrikeOut', 'Underline']);
    const drawn = await appearances(out.bytes);
    expect(drawn[`Underline|${markerFor('u1')}`]?.ap).toBe(true);
    expect(drawn[`Squiggly|${markerFor('q1')}`]?.ap).toBe(true);
    // The engine could only tag the comment with the marker; settled, the marker is the
    // name and the comment — the mark's and its popup's — is the author's words alone.
    expect(drawn[`Underline|${markerFor('u1')}`]?.contents).toBe('Şişli notu');
    const comments = (await annotationsOf(out.bytes)).map((entry) => entry.contents);
    expect(comments.some((text) => text.includes('pdf-editor-ann:'))).toBe(false);
  });
});

describe('settleEngineMarks appearance', () => {
  it('draws an underline at the baseline, a strike through the middle and a zigzag, each in its colour', async () => {
    const marks = [
      mark({ id: 'u1', kind: 'underline', quads: [[40, 60, 200, 90]], color: '#ff0000' }),
      mark({ id: 's1', kind: 'strikeout', quads: [[40, 120, 200, 150]], color: '#0000ff' }),
      mark({ id: 'q1', kind: 'squiggly', quads: [[40, 180, 200, 210]], color: '#00aa00', thickness: 4 }),
    ];
    const out = await settleEngineMarks(await engineWritten(), marks, run);
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const components = pixmap.getNumberOfComponents();
      const row = (y: number, x0 = 60, x1 = 180): string[] => {
        const seen = new Set<string>();
        for (let x = x0; x <= x1; x += 1) {
          const [r = 255, g = 255, b = 255] = [0, 1, 2].map(
            (channel) => pixels[(y * pixmap.getWidth() + x) * components + channel],
          );
          if (r > 200 && g < 60 && b < 60) seen.add('red');
          else if (b > 200 && r < 60 && g < 60) seen.add('blue');
          else if (g > 130 && r < 60 && b < 60) seen.add('green');
        }
        return [...seen];
      };
      // Underline: on the baseline of its line box (the pixel row above y = 90, the annotation's
      // box ends there), nowhere else in the box.
      expect(row(89)).toEqual(['red']);
      expect(row(75)).toEqual([]);
      // Strike-out: halfway between top and bottom of the line box (y = 135).
      expect(row(134)).toEqual(['blue']);
      expect(row(135)).toEqual(['blue']);
      expect(row(150)).toEqual([]);
      // Squiggle: the 4 pt zigzag climbs above the baseline (y = 210); a straight bar would not.
      expect(row(205)).toEqual(['green']);
      expect(row(195)).toEqual([]);
    } finally {
      doc.destroy();
    }
  });
});

describe('writeAnnotationsToFile', () => {
  /** The session written over `input`, and whether every byte of `input` was kept. */
  async function save(input: Uint8Array, session: AnnotationMark) {
    const handle = await openWithPdfjs(input);
    try {
      const out = await writeAnnotationsToFile(handle, [session], run);
      const kept =
        out.bytes.byteLength > input.byteLength && input.every((byte, at) => out.bytes[at] === byte);
      return { out, kept };
    } finally {
      await handle.destroy();
    }
  }

  it('appends a highlight and a note to the file the reader opened, and says so', async () => {
    for (const session of [
      mark({ id: 'hl', kind: 'highlight' }),
      mark({ id: 'nt', kind: 'note', rect: [40, 60, 64, 84] }),
    ]) {
      const input = await blank();
      const { out, kept } = await save(input, session);
      // An appended revision leaves the bytes a signature covers as they were; a rewrite
      // re-serialises them and breaks it.
      expect({ kind: session.kind, kept, incremental: out.report.incremental }).toEqual({
        kind: session.kind,
        kept: true,
        incremental: true,
      });
      const written = (await annotationsOf(out.bytes)).find((entry) => entry.marker === session.id);
      expect(written?.contents).toBe('Şişli notu');
    }
  });

  it('says a shape rewrote the file, because it did', async () => {
    const input = await blank();
    const { out, kept } = await save(
      input,
      mark({ id: 'sq', kind: 'shapes', shape: 'square', rect: [40, 60, 200, 160] }),
    );
    expect({ kept, incremental: out.report.incremental, engine: out.report.engine }).toEqual({
      kept: false,
      incremental: false,
      engine: 'mupdf',
    });
  });
});

describe('readAnnotations', () => {
  it('lists the comments of a file that needs a password, opened with it', async () => {
    const shaped = await writeShapeAnnotations(
      await blank(),
      [mark({ id: 'sq', kind: 'shapes', shape: 'square', rect: [40, 60, 200, 160] })],
      run,
    );
    const source = mupdf.PDFDocument.openDocument(shaped.bytes.slice(), 'application/pdf').asPDF();
    if (source === null) throw new Error('not a PDF');
    const locked = new Uint8Array(
      source.saveToBuffer('encrypt=aes-256,user-password=u,owner-password=o').asUint8Array(),
    );
    source.destroy();
    const handle = await openWithPdfjs(locked, { password: 'u' });
    try {
      const read = await readAnnotations(handle, run);
      expect(read.map((entry) => [entry.subtype, entry.contents])).toEqual([['Square', 'Şişli notu']]);
    } finally {
      await handle.destroy();
    }
  });
});

describe('markerTargets', () => {
  it('resolves a session mark to its own annotation, never to the popup that repeats its comment', async () => {
    const bytes = await engineWritten();
    const found = await markerTargets(
      bytes,
      [
        { pageIndex: 0, id: 'u1' },
        { pageIndex: 1, id: 's1' },
      ],
      run,
    );
    const read = await annotationsOf(bytes);
    const highlight = read.find((entry) => entry.subtype === 'Highlight' && entry.marker === 'u1');
    // `s1` is on page 1, not page 2: a marker is only looked for on the page it names.
    expect(found).toEqual([{ pageIndex: 0, id: highlight?.id, markId: 'u1' }]);
  });
});

// ---------------------------------------------------------------------------
// refusals, stops and the paths of the whole save
// ---------------------------------------------------------------------------

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await promise;
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call resolved instead of rejecting');
  return outcome.error;
}

async function toolErrorOf(promise: Promise<unknown>): Promise<ToolError> {
  const error = await rejectionOf(promise);
  if (!isToolError(error)) throw error;
  return error;
}

const sketch = mark({
  id: 'stroke',
  kind: 'highlight',
  quads: [[40, 100, 120, 100]],
  strokes: [[40, 100, 80, 100, 120, 100]],
  thickness: 8,
});
const shape = mark({ id: 'sq', kind: 'shapes', shape: 'square', rect: [40, 60, 200, 160] });
const sticky = mark({ id: 'nt', kind: 'note', rect: [40, 60, 64, 84] });

/** The writers that build their own dictionaries, each with a mark of its own kind. */
const WRITERS = [
  ['shapes', writeShapeAnnotations, shape],
  ['notes', writeNoteAnnotations, sticky],
  ['highlights', writeStrokeHighlights, sketch],
] as const;

/** An annotation's dictionary in a written file, found by the marker in its /NM. */
function dictionaryOf(doc: mupdf.PDFDocument, id: string): mupdf.PDFObject {
  for (let page = 0; page < doc.countPages(); page += 1) {
    const annots = doc.findPage(page).get('Annots');
    if (annots.isNull()) continue;
    const array = annots.resolve();
    for (let index = 0; index < array.length; index += 1) {
      const dict = array.get(index).resolve();
      const name = dict.get('NM');
      if (!name.isNull() && name.asString() === markerFor(id)) return dict;
    }
  }
  throw new Error(`no annotation named ${id}`);
}

function numbersIn(array: mupdf.PDFObject): number[] {
  const out: number[] = [];
  for (let index = 0; index < array.length; index += 1) out.push(array.get(index).asNumber());
  return out;
}

describe.each(WRITERS)('the %s writer', (step, write, own) => {
  it('leaves the file alone when it has no mark of its kind', async () => {
    const input = await blank();
    const other = mark({ id: 'other', kind: 'underline' });
    const outcome = await write(input, [other], run);
    expect(outcome.bytes).toBe(input);
    expect(outcome.written).toEqual([]);
    expect(outcome.report.steps).toEqual([`annotations.${step}.skipped`]);
    expect(outcome.report.notes).toEqual([{ kind: 'warning', key: 'op.note.annotate.nothing' }]);
  });

  it('refuses a mark on a page the file does not have, naming the page', async () => {
    const error = await toolErrorOf(write(await blank(), [{ ...own, pageIndex: 7 }], run));
    expect(error.code).toBe('range-invalid');
    expect(error.details.pageIndex).toBe(7);
  });

  it('stops at an aborted signal without rewriting the abort', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await rejectionOf(write(await blank(), [own], { signal: aborted.signal }))).toMatchObject({
      name: 'AbortError',
    });
  });

  it('refuses a mark whose colour is not #rrggbb and writes nothing', async () => {
    const error = await toolErrorOf(write(await blank(), [{ ...own, color: 'red' }], run));
    expect(error.code).toBe('internal');
    expect(error.details.engineMessage).toBe('annotation colour is not #rrggbb: red');
  });
});

describe('writeShapeAnnotations on shapes it cannot draw', () => {
  it('refuses a shape kind it has no subtype for', async () => {
    const error = await toolErrorOf(
      writeShapeAnnotations(await blank(), [mark({ ...shape, shape: 'star' as 'square' })], run),
    );
    expect(error.code).toBe('unsupported-format');
    expect(error.details.pageIndex).toBe(0);
  });

  it('draws a shape with no kind as a square', async () => {
    const out = await writeShapeAnnotations(
      await blank(),
      [mark({ id: 'plain', kind: 'shapes', rect: [40, 60, 200, 160] })],
      run,
    );
    const read = await annotationsOf(out.bytes);
    expect(read.find((entry) => entry.marker === 'plain')?.subtype).toBe('Square');
  });

  it('refuses a shape with no rectangle', async () => {
    const error = await toolErrorOf(
      writeShapeAnnotations(await blank(), [mark({ id: 'bare', kind: 'shapes', quads: [] })], run),
    );
    expect(error.code).toBe('selection-empty');
  });
});

describe('writeStrokeHighlights on strokes with little to follow', () => {
  it('falls back to the padded rect for a stroke whose segments are all too short, and dots a lone point', async () => {
    const out = await writeStrokeHighlights(
      await blank(),
      [
        mark({
          id: 'tiny',
          kind: 'highlight',
          quads: [[50, 100, 50.1, 100.1]],
          strokes: [[50, 100, 50.1, 100.1]],
          thickness: 8,
        }),
        mark({
          id: 'dot',
          kind: 'highlight',
          quads: [[200, 300, 200, 300]],
          strokes: [[200, 300], [5]],
          thickness: 8,
        }),
      ],
      run,
    );
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      for (const id of ['tiny', 'dot']) {
        const dict = dictionaryOf(doc, id);
        const [left = 0, bottom = 0, right = 0, top = 0] = numbersIn(dict.get('Rect'));
        // With no segment to follow, QuadPoints is the padded rect: upper edge first, then lower.
        expect(numbersIn(dict.get('QuadPoints')), id).toEqual([
          left,
          top,
          right,
          top,
          left,
          bottom,
          right,
          bottom,
        ]);
      }
      const dot = dictionaryOf(doc, 'dot').get('AP').get('N');
      // A lone point is repeated as a zero-length segment so a round cap paints it.
      expect(dot.readStream().asString()).toMatch(/^(\S+ \S+) m\n\1 l\nS$/m);
    } finally {
      doc.destroy();
    }
  });

  it('gives a marker with no stored thickness the default width, padding its rect by half of it', async () => {
    const out = await writeStrokeHighlights(
      await blank(),
      [mark({ id: 'thin', kind: 'highlight', quads: [[40, 100, 120, 100]], strokes: [[40, 100, 120, 100]] })],
      run,
    );
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      // The stroke is 6 points wide: a 3-point pad around the line at page y = 400.
      expect(numbersIn(dictionaryOf(doc, 'thin').get('Rect'))).toEqual([37, 397, 123, 403]);
    } finally {
      doc.destroy();
    }
  });

  it('follows a path with a quad per segment that is long enough, and skips a short one', async () => {
    const out = await writeStrokeHighlights(
      await blank(),
      [
        mark({
          id: 'path',
          kind: 'highlight',
          quads: [[40, 100, 120, 100]],
          strokes: [[40, 100, 40.2, 100, 120, 100]],
          thickness: 8,
        }),
      ],
      run,
    );
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      // 40 → 40.2 is under the minimum; 40.2 → 120 is the one quad.
      expect(dictionaryOf(doc, 'path').get('QuadPoints').length).toBe(8);
    } finally {
      doc.destroy();
    }
  });
});

/** The pinned regular face, as `fetch:engines` copies it from this package. */
function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

describe('writeAnnotationsToFile in full', () => {
  // Typed text embeds the font it fetches from the app's own origin; the real face is served here.
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stamped = (overrides: Partial<AnnotationMark> & Pick<AnnotationMark, 'id' | 'kind'>) =>
    mark(overrides);
  const typedBox = stamped({
    id: 'tx',
    kind: 'freetext',
    rect: [40, 200, 200, 230],
    contents: 'Merhaba',
    color: '#000000',
    opacity: 1,
    fontSize: 12,
  });

  async function saveAll(marks: readonly AnnotationMark[], existing: readonly ExistingAnnotation[] = []) {
    const handle = await openWithPdfjs(await blank());
    try {
      return await writeAnnotationsToFile(handle, marks, run, existing);
    } finally {
      await handle.destroy();
    }
  }

  it('writes nothing, and says so, when there is no mark or every mark is already in the file', async () => {
    const none = await saveAll([]);
    expect(none.report).toMatchObject({ engine: 'pdfjs', steps: [], incremental: true, pageCount: 2 });
    expect(none.report.notes).toEqual([{ kind: 'warning', key: 'op.note.annotate.nothing' }]);
    const known = await saveAll(
      [stamped({ id: 'old', kind: 'highlight' })],
      [
        {
          id: '9R',
          subtype: 'Highlight',
          pageIndex: 0,
          kind: 'highlight',
          rect: null,
          contents: '',
          marker: 'old',
          author: '',
          modified: null,
        },
      ],
    );
    expect(known.report.steps).toEqual([]);
    // An empty typed box is not a mark either.
    expect(
      (await saveAll([stamped({ id: 'empty', kind: 'freetext', rect: [1, 1, 5, 5], contents: '  ' })])).report
        .steps,
    ).toEqual([]);
  });

  it('writes typed text and a marker through their own writers, as a rewrite by MuPDF', async () => {
    const out = await saveAll([typedBox, sketch]);
    expect(out.report).toMatchObject({ engine: 'mupdf', incremental: false });
    expect(out.report.steps).toEqual(expect.arrayContaining(['annotations.highlights']));
    const read = await annotationsOf(out.bytes);
    expect(read.filter((entry) => entry.kind !== null).map((entry) => [entry.subtype, entry.marker])).toEqual(
      expect.arrayContaining([
        ['FreeText', 'tx'],
        ['Highlight', 'stroke'],
      ]),
    );
  });

  it('turns each written mark by its own rotation, one transform per distinct turn', async () => {
    const out = await saveAll([
      { ...shape, rotation: 90 },
      { ...sticky, rotation: 90 },
      stamped({ id: 'ci', kind: 'shapes', shape: 'circle', rect: [100, 200, 300, 260], rotation: 180 }),
      stamped({ id: 'flat', kind: 'shapes', shape: 'square', rect: [100, 300, 300, 360] }),
    ]);
    expect(out.report.steps.filter((step) => step === 'annotations.transform')).toHaveLength(2);
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const size = (id: string) => {
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = numbersIn(dictionaryOf(doc, id).get('Rect'));
        return [Math.round(x1 - x0), Math.round(y1 - y0)];
      };
      // The square was 162 × 102 with its stroke padding; a quarter turn swaps the sides.
      expect(size('sq')).toEqual([102, 162]);
      expect(size('ci')).toEqual([202, 62]);
      expect(size('flat')).toEqual([202, 62]);
    } finally {
      doc.destroy();
    }
  });

  it('refuses a rotation it cannot resolve, because the mark was never written', async () => {
    const error = await toolErrorOf(
      saveAll([
        stamped({ id: 'void', kind: 'freetext', rect: [1, 1, 5, 5], contents: '', rotation: 90 }),
        sticky,
      ]),
    );
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe(
      'a written mark could not be resolved for its requested rotation',
    );
  });

  it('stops between turns when the signal aborts', async () => {
    const aborted = new AbortController();
    const error = await rejectionOf(
      writeAnnotationsToFile(
        await openWithPdfjs(await blank()),
        [
          { ...shape, rotation: 90 },
          { ...sticky, rotation: 180 },
        ],
        { signal: aborted.signal, onProgress: () => aborted.abort() },
      ),
    );
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('writes the replies and the review state of a comment as records that point at it', async () => {
    const out = await saveAll([
      {
        ...sticky,
        replies: [{ id: 'r1', author: 'Can', contents: 'agreed', createdAt: '2026-01-03T00:00:00.000Z' }],
        review: { state: 'Accepted', author: 'Can', at: '2026-01-04T00:00:00.000Z' },
      },
      { ...shape, id: 'quiet', review: { state: 'None', author: '', at: '2026-01-04T00:00:00.000Z' } },
      {
        ...shape,
        id: 'only-reply',
        replies: [{ id: 'r2', author: 'Ece', contents: 'later', createdAt: '2026-01-05T00:00:00.000Z' }],
        review: { state: 'None', author: '', at: '2026-01-04T00:00:00.000Z' },
      },
    ]);
    expect(out.report.engine).toBe('mupdf');
    const read = await annotationsOf(out.bytes);
    const parent = read.find((entry) => entry.marker === 'nt');
    const replies = read.filter((entry) => entry.inReplyTo === parent?.id);
    expect(replies.map((entry) => [entry.contents, entry.state ?? null])).toEqual(
      expect.arrayContaining([
        ['agreed', null],
        [expect.any(String), 'Accepted'],
      ]),
    );
    const quiet = read.find((entry) => entry.marker === 'quiet');
    expect(read.filter((entry) => entry.inReplyTo === quiet?.id)).toEqual([]);
    const lone = read.find((entry) => entry.marker === 'only-reply');
    expect(read.filter((entry) => entry.inReplyTo === lone?.id).map((entry) => entry.contents)).toEqual([
      'later',
    ]);
  });

  it('writes a review state alone for a comment with no replies', async () => {
    const out = await saveAll([
      { ...sticky, review: { state: 'Rejected', author: 'Can', at: '2026-01-04T00:00:00.000Z' } },
    ]);
    const read = await annotationsOf(out.bytes);
    const parent = read.find((entry) => entry.marker === 'nt');
    expect(read.filter((entry) => entry.inReplyTo === parent?.id).map((entry) => entry.state)).toEqual([
      'Rejected',
    ]);
  });

  it('refuses replies for a comment that was never written', async () => {
    const error = await toolErrorOf(
      saveAll([
        sticky,
        stamped({
          id: 'void',
          kind: 'freetext',
          rect: [1, 1, 5, 5],
          contents: '',
          replies: [{ id: 'r', author: '', contents: 'x', createdAt: '2026-01-01T00:00:00.000Z' }],
        }),
      ]),
    );
    expect(error.code).toBe('verification-failed');
    expect(error.details.engineMessage).toBe('the comment void could not be resolved for its replies');
  });
});
