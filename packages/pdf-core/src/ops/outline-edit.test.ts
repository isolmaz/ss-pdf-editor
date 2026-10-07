/**
 * Outline edits, against real bytes and read back through the app's own outline reader.
 * The wrong answers that matter: a Turkish title mangled, a `/Count` that disagrees with
 * the tree (readers then show the wrong number of rows), a removal that leaves the
 * neighbours pointing at a deleted item or the item's objects still in the file, an
 * emptied outline that keeps an `/Outlines` shell, a destination that lands on the wrong
 * point of a rotated page, and a malformed tree rewritten instead of refused.
 */

import { describe, expect, it } from 'vitest';
import { openWithPdfjs, type PdfOutlineEntry } from '../engines/pdfjs-handle';
import { applyOutlineEdit, type OutlineNodeInput } from './outline-edit';

const run = { signal: new AbortController().signal };

/** Three 200×300 pages; the second is `/Rotate 90`. No outline. */
async function blank(extra?: (doc: import('mupdf').PDFDocument) => void): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (const rotate of [0, 90, 0] as const) doc.insertPage(-1, doc.addPage([0, 0, 200, 300], rotate, {}, ''));
  extra?.(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const TREE: readonly OutlineNodeInput[] = [
  {
    title: 'Giriş — Şişli',
    destination: { pageIndex: 0 },
    bold: true,
    color: '#ff0000',
    children: [
      { title: 'Alt bölüm ğ', destination: { pageIndex: 1, x: 30, y: 40, zoom: 2 } },
      { title: 'İkinci (alt)', destination: null, italic: true },
    ],
  },
  { title: 'Sonuç', destination: { pageIndex: 2 } },
];

/** The tree the viewer shows. */
async function outlineOf(bytes: Uint8Array): Promise<readonly PdfOutlineEntry[]> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await handle.getOutline();
  } finally {
    await handle.destroy();
  }
}

/**
 * Object-level facts: every `/Count` on the way down, the first item's `/F`, `/C` and the
 * first child's `/Dest`, and how many outline item objects the file carries at all.
 */
async function structure(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    let items = 0;
    for (let number = 1; number < doc.countObjects(); number += 1) {
      const object = doc.newIndirect(number).resolve();
      if (object.isDictionary() && !object.get('Title').isNull() && !object.get('Parent').isNull())
        items += 1;
    }
    const root = doc.getTrailer().get('Root').resolve().get('Outlines');
    if (root.isNull()) return { items, hasOutlines: false };
    const outlines = root.resolve();
    const first = outlines.get('First').resolve();
    const child = first.get('First');
    const dest = child.isNull() ? null : child.resolve().get('Dest');
    const values: unknown[] = [];
    if (dest !== null && !dest.isNull()) {
      const array = dest.resolve();
      for (let index = 0; index < array.length; index += 1) {
        const value = array.get(index);
        values.push(
          value.isIndirect()
            ? `page ${[0, 1, 2].find((page) => doc.findPage(page).asIndirect() === value.asIndirect())}`
            : value.isName()
              ? value.asName()
              : value.isNumber()
                ? value.asNumber()
                : null,
        );
      }
    }
    const colour = first.get('C');
    return {
      items,
      hasOutlines: true,
      rootCount: outlines.get('Count').asNumber(),
      firstCount: first.get('Count').isNull() ? null : first.get('Count').asNumber(),
      firstFlags: first.get('F').isNull() ? 0 : first.get('F').asNumber(),
      firstColour: colour.isNull() ? null : [0, 1, 2].map((index) => colour.resolve().get(index).asNumber()),
      childDest: values,
    };
  } finally {
    doc.destroy();
  }
}

const titles = (entries: readonly PdfOutlineEntry[]): unknown =>
  entries.map((entry) =>
    entry.children.length === 0 ? entry.title : { [entry.title]: titles(entry.children) },
  );

async function withTree(): Promise<Uint8Array> {
  return (await applyOutlineEdit(await blank(), { kind: 'replace-all', nodes: TREE }, run)).bytes;
}

describe('applyOutlineEdit', () => {
  it('writes a tree whose Turkish titles, pages, counts, style and rotated destination read back', async () => {
    const out = await applyOutlineEdit(await blank(), { kind: 'replace-all', nodes: TREE }, run);
    const outline = await outlineOf(out.bytes);
    expect(titles(outline)).toEqual([{ 'Giriş — Şişli': ['Alt bölüm ğ', 'İkinci (alt)'] }, 'Sonuç']);
    expect(outline.map((entry) => entry.pageIndex)).toEqual([0, 2]);
    expect(outline[0]?.children[0]?.pageIndex).toBe(1);
    // `/Rotate 90`: displayed (30, 40) → user (40, 30).
    expect(await structure(out.bytes)).toEqual({
      items: 4,
      hasOutlines: true,
      rootCount: 4,
      firstCount: 2,
      firstFlags: 2,
      firstColour: [1, 0, 0],
      childDest: ['page 1', 'XYZ', 40, 30, 2],
    });
    expect(out.report.steps).toEqual(['load', 'outline.replace', 'producer', 'save', 'verify']);
  });

  it('adds a root to a document without one, then a child under an item', async () => {
    const first = await applyOutlineEdit(
      await blank(),
      { kind: 'add-child', parentPath: [], node: { title: 'Tek', destination: { pageIndex: 0 } } },
      run,
    );
    const second = await applyOutlineEdit(
      first.bytes,
      { kind: 'add-child', parentPath: [0], node: { title: 'Çocuk', destination: { pageIndex: 9 } } },
      run,
    );
    expect(titles(await outlineOf(second.bytes))).toEqual([{ Tek: ['Çocuk'] }]);
    expect(await structure(second.bytes)).toMatchObject({ items: 2, rootCount: 2, firstCount: 1 });
    expect(second.report.notes.map((entry) => entry.key)).toContain('op.note.outline.destinationClamped');
  });

  it('renames an item, and hands back the same bytes when the title is already that', async () => {
    const input = await withTree();
    const renamed = await applyOutlineEdit(
      input,
      { kind: 'rename', path: [0, 1], title: 'Yeni ad — ş' },
      run,
    );
    expect(titles(await outlineOf(renamed.bytes))).toEqual([
      { 'Giriş — Şişli': ['Alt bölüm ğ', 'Yeni ad — ş'] },
      'Sonuç',
    ]);
    const same = await applyOutlineEdit(input, { kind: 'rename', path: [1], title: 'Sonuç' }, run);
    expect(same.bytes).toBe(input);
    expect(same.report.incremental).toBe(true);
  });

  it('removes a subtree, re-links its neighbours, recounts and deletes its objects', async () => {
    const out = await applyOutlineEdit(await withTree(), { kind: 'remove', path: [0] }, run);
    expect(titles(await outlineOf(out.bytes))).toEqual(['Sonuç']);
    expect(await structure(out.bytes)).toMatchObject({ items: 1, rootCount: 1 });
  });

  it('leaves no /Outlines and no item objects once the last item goes', async () => {
    const one = await applyOutlineEdit(await withTree(), { kind: 'remove', path: [0] }, run);
    const none = await applyOutlineEdit(one.bytes, { kind: 'remove', path: [0] }, run);
    expect(await structure(none.bytes)).toEqual({ items: 0, hasOutlines: false });
    const cleared = await applyOutlineEdit(await withTree(), { kind: 'replace-all', nodes: [] }, run);
    expect(await structure(cleared.bytes)).toEqual({ items: 0, hasOutlines: false });
    expect(cleared.report.notes.map((entry) => entry.key)).toContain('op.note.outline.cleared');
    const input = await blank();
    const nothing = await applyOutlineEdit(input, { kind: 'replace-all', nodes: [] }, run);
    expect(nothing.bytes).toBe(input);
  });

  it('refuses what it cannot write correctly, before writing anything', async () => {
    const tree = await withTree();
    const refusals: [Uint8Array, Parameters<typeof applyOutlineEdit>[1], string][] = [
      [tree, { kind: 'rename', path: [5], title: 'x' }, 'unsupported'],
      [tree, { kind: 'rename', path: [0], title: '   ' }, 'unsupported'],
      [tree, { kind: 'remove', path: [] }, 'unsupported'],
      [
        tree,
        { kind: 'add-child', parentPath: [], node: { title: 'x', destination: { pageIndex: 0, x: 1 } } },
        'unsupported',
      ],
      [
        tree,
        { kind: 'add-child', parentPath: [], node: { title: 'x', destination: null, color: 'red' } },
        'value-out-of-range',
      ],
    ];
    for (const [bytes, request, code] of refusals) {
      await expect(applyOutlineEdit(bytes, request, run)).rejects.toMatchObject({ code });
    }

    const inline = await blank((doc) => {
      const outlines = doc.newDictionary();
      outlines.put('Type', 'Outlines');
      doc.getTrailer().get('Root').resolve().put('Outlines', outlines);
    });
    await expect(
      applyOutlineEdit(
        inline,
        { kind: 'add-child', parentPath: [], node: { title: 'x', destination: null } },
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });

    const cyclic = await blank((doc) => {
      const outlines = doc.addObject({ Type: 'Outlines' });
      const item = doc.addObject({ Title: doc.newString('döngü'), Parent: outlines });
      item.put('Next', item);
      outlines.put('First', item);
      outlines.put('Last', item);
      doc.getTrailer().get('Root').resolve().put('Outlines', outlines);
    });
    await expect(
      applyOutlineEdit(cyclic, { kind: 'rename', path: [0], title: 'x' }, run),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
