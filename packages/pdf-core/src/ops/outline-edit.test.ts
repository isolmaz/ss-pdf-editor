/**
 * Outline edits, against real bytes and read back through the app's own outline reader.
 * The wrong answers that matter: a Turkish title mangled, a `/Count` that disagrees with
 * the tree (readers then show the wrong number of rows), a removal that leaves the
 * neighbours pointing at a deleted item or the item's objects still in the file, an
 * emptied outline that keeps an `/Outlines` shell, a destination that lands on the wrong
 * point of a rotated page, and a malformed tree rewritten instead of refused.
 */

import { isToolError, type ToolError } from 'pdf-shared';
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

// ---------------------------------------------------------------------------
// refusals, malformed trees, every rotation and every removal position
// ---------------------------------------------------------------------------

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await promise;
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call resolved instead of rejecting');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

const leaf = (title: string): OutlineNodeInput => ({ title, destination: null });

/** The catalog of a document under construction. */
function catalogOf(doc: import('mupdf').PDFDocument) {
  return doc.getTrailer().get('Root').resolve();
}

/** A flat outline of `titles`, each linked to its neighbours, with no /Count anywhere. */
function outlineWith(doc: import('mupdf').PDFDocument, titles: readonly string[]) {
  const outlines = doc.addObject({ Type: 'Outlines' });
  let previous: import('mupdf').PDFObject | null = null;
  for (const title of titles) {
    const item = doc.addObject({ Title: doc.newString(title), Parent: outlines });
    if (previous === null) outlines.put('First', item);
    else {
      previous.put('Next', item);
      item.put('Prev', previous);
    }
    previous = item;
  }
  if (previous !== null) outlines.put('Last', previous);
  catalogOf(doc).put('Outlines', outlines);
  return outlines;
}

describe('applyOutlineEdit refuses a request it cannot honour', () => {
  const tooDeep = (levels: number): OutlineNodeInput =>
    levels === 0 ? leaf('bottom') : { title: 'level', destination: null, children: [tooDeep(levels - 1)] };

  it.each([
    [
      'an item with no title',
      { kind: 'add-child', parentPath: [], node: leaf('  ') },
      'request.node[0].title',
      'an outline item needs a title',
    ],
    [
      'a fractional destination page',
      { kind: 'add-child', parentPath: [], node: { title: 'x', destination: { pageIndex: 0.5 } } },
      'request.node[0].destination.pageIndex',
      'page index must be an integer, got 0.5',
    ],
    [
      'a zero zoom',
      { kind: 'add-child', parentPath: [], node: { title: 'x', destination: { pageIndex: 0, zoom: 0 } } },
      'request.node[0].destination.zoom',
      'zoom must be a finite number > 0, got 0',
    ],
    [
      'a colour that is not #rrggbb',
      { kind: 'replace-all', nodes: [{ title: 'x', destination: null, color: 'red' }] },
      'request.nodes[0].color',
      'outline colour must be #rrggbb, got "red"',
    ],
    [
      'a nesting deeper than 64 levels',
      { kind: 'replace-all', nodes: [tooDeep(65)] },
      'request.nodes[0].children[0].children[0]',
      'the outline is nested deeper than 64 levels',
    ],
    [
      'more than 20000 items',
      {
        kind: 'replace-all',
        nodes: Array.from({ length: 20_001 }, (_unused, index) => leaf(`item ${index}`)),
      },
      'request.nodes',
      'the outline carries more than 20000 items',
    ],
    [
      'a child under an outline the document does not have',
      { kind: 'add-child', parentPath: [0], node: leaf('x') },
      'request.parentPath',
      'the document has no outline to resolve a path against',
    ],
  ] as const)('refuses %s', async (_name, request, path, message) => {
    const error = await refusal(applyOutlineEdit(await blank(), request as never, run));
    expect(error.details.path).toContain(path);
    expect(error.details.engineMessage).toBe(message);
  });

  it('refuses a path against a document with no outline', async () => {
    const error = await refusal(
      applyOutlineEdit(await blank(), { kind: 'rename', path: [0], title: 'x' }, run),
    );
    expect(error.details.engineMessage).toBe('the document has no outline to resolve a path against');
  });

  it('refuses to rename the outline root, which has no title', async () => {
    const error = await refusal(
      applyOutlineEdit(await withTree(), { kind: 'rename', path: [], title: 'x' }, run),
    );
    expect(error.details.engineMessage).toBe('the outline root carries no title; name an item instead');
  });

  it('refuses a path with a step that is not a whole number, or past the level', async () => {
    const tree = await withTree();
    expect(
      (await refusal(applyOutlineEdit(tree, { kind: 'remove', path: [1.5] }, run))).details.engineMessage,
    ).toBe('path step 0 is not a non-negative integer: 1.5');
    expect(
      (await refusal(applyOutlineEdit(tree, { kind: 'remove', path: [-1] }, run))).details.engineMessage,
    ).toBe('path step 0 is not a non-negative integer: -1');
    expect(
      (await refusal(applyOutlineEdit(tree, { kind: 'remove', path: [0, 7] }, run))).details.engineMessage,
    ).toBe('path step 1 names item 7, but that level has 2 item(s)');
  });

  it('refuses to point an item at a page of a document that has none', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const error = await refusal(
      applyOutlineEdit(
        bytes,
        { kind: 'add-child', parentPath: [], node: { title: 'x', destination: { pageIndex: 0 } } },
        run,
      ),
    );
    expect(error.details.engineMessage).toBe('the document has no pages to point an outline item at');
  });
});

describe('applyOutlineEdit reads a malformed outline and refuses it', () => {
  const rename = { kind: 'rename', path: [0], title: 'x' } as const;

  it('refuses an item that is listed directly instead of by reference', async () => {
    const bytes = await blank((doc) => {
      const outlines = doc.addObject({ Type: 'Outlines' });
      const direct = doc.newDictionary();
      direct.put('Title', doc.newString('doğrudan'));
      outlines.put('First', direct);
      catalogOf(doc).put('Outlines', outlines);
    });
    const error = await refusal(applyOutlineEdit(bytes, rename, run));
    expect(error.details.engineMessage).toBe(
      '/Root/Outlines/First is not an indirect reference; an outline item needs one for its /Parent',
    );
  });

  it('refuses an item reference that is not a dictionary', async () => {
    const bytes = await blank((doc) => {
      const outlines = doc.addObject({ Type: 'Outlines' });
      outlines.put('First', doc.addObject(doc.newInteger(7)));
      catalogOf(doc).put('Outlines', outlines);
    });
    const error = await refusal(applyOutlineEdit(bytes, rename, run));
    expect(error.details.engineMessage).toMatch(
      /^\/Root\/Outlines\/First \(\d+ 0 R\) does not resolve to a dictionary$/,
    );
  });

  it('refuses an outline nested deeper than 64 levels', async () => {
    const bytes = await blank((doc) => {
      const outlines = doc.addObject({ Type: 'Outlines' });
      let owner = outlines;
      for (let level = 0; level < 66; level += 1) {
        const item = doc.addObject({ Title: doc.newString('level'), Parent: owner });
        owner.put('First', item);
        owner = item;
      }
      catalogOf(doc).put('Outlines', outlines);
    });
    const error = await refusal(applyOutlineEdit(bytes, rename, run));
    expect(error.details.engineMessage).toBe('the outline is nested deeper than 64 levels');
  });

  it('refuses an outline of more than 20000 items', async () => {
    const bytes = await blank((doc) => {
      outlineWith(
        doc,
        Array.from({ length: 20_001 }, (_unused, index) => `item ${index}`),
      );
    });
    const error = await refusal(applyOutlineEdit(bytes, rename, run));
    expect(error.details.engineMessage).toBe('the outline carries more than 20000 items');
  });

  it('reads an item without a title as an empty one', async () => {
    const bytes = await blank((doc) => {
      const outlines = doc.addObject({ Type: 'Outlines' });
      outlines.put('First', doc.addObject({ Parent: outlines }));
      catalogOf(doc).put('Outlines', outlines);
    });
    const out = await applyOutlineEdit(bytes, { kind: 'rename', path: [0], title: 'Yeni' }, run);
    expect(out.report.notes.find((entry) => entry.key === 'op.note.outline.renamed')?.params).toEqual({
      from: '',
      to: 'Yeni',
    });
    expect(titles(await outlineOf(out.bytes))).toEqual(['Yeni']);
  });

  it('treats an /Outlines that is not a dictionary as no outline, and writes a fresh one over it', async () => {
    const bytes = await blank((doc) => {
      catalogOf(doc).put('Outlines', doc.addObject(doc.newInteger(3)));
    });
    const added = await applyOutlineEdit(
      bytes,
      { kind: 'add-child', parentPath: [], node: leaf('Yeni') },
      run,
    );
    expect(titles(await outlineOf(added.bytes))).toEqual(['Yeni']);
    const replaced = await applyOutlineEdit(bytes, { kind: 'replace-all', nodes: [leaf('Başka')] }, run);
    expect(titles(await outlineOf(replaced.bytes))).toEqual(['Başka']);
  });

  it('appends after the item a /Last names when the root has no /First', async () => {
    const bytes = await blank((doc) => {
      const outlines = doc.addObject({ Type: 'Outlines' });
      outlines.put('Last', doc.addObject({ Title: doc.newString('eski'), Parent: outlines }));
      catalogOf(doc).put('Outlines', outlines);
    });
    const out = await applyOutlineEdit(bytes, { kind: 'add-child', parentPath: [], node: leaf('Yeni') }, run);
    expect(titles(await outlineOf(out.bytes))).toEqual(['Yeni']);
  });
});

describe('applyOutlineEdit destinations', () => {
  it('converts a displayed point through every rotation, and through a page with no box or turn', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    for (const rotate of [0, 90, 180, 270, 0] as const) {
      doc.insertPage(-1, doc.addPage([0, 0, 200, 300], rotate, {}, ''));
    }
    const bare = doc.findPage(4);
    bare.delete('MediaBox');
    bare.delete('Rotate');
    const source = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const nodes = [0, 1, 2, 3, 4].map((pageIndex) => ({
      title: `page ${pageIndex}`,
      destination: { pageIndex, x: 30, y: 40 },
    }));
    const out = await applyOutlineEdit(source, { kind: 'replace-all', nodes }, run);
    const read = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (read === null) throw new Error('not a PDF');
    try {
      const points: number[][] = [];
      let item = catalogOf(read).get('Outlines').resolve().get('First');
      while (item.isIndirect()) {
        const dict = item.resolve();
        const dest = dict.get('Dest');
        points.push([dest.get(2).asNumber(), dest.get(3).asNumber()]);
        item = dict.get('Next');
      }
      expect(points).toEqual([
        [30, 260],
        [40, 30],
        [170, 40],
        [160, 270],
        [30, 752],
      ]);
    } finally {
      read.destroy();
    }
  });

  it('clamps a destination page into the document and counts them', async () => {
    const out = await applyOutlineEdit(
      await blank(),
      {
        kind: 'replace-all',
        nodes: [
          { title: 'a', destination: { pageIndex: 99 } },
          { title: 'b', destination: { pageIndex: -3 } },
          { title: 'c', destination: { pageIndex: 1 } },
        ],
      },
      run,
    );
    expect(
      out.report.notes.find((entry) => entry.key === 'op.note.outline.destinationClamped')?.params,
    ).toEqual({ count: 2 });
  });
});

describe('applyOutlineEdit removal and structure', () => {
  const three = async (): Promise<Uint8Array> =>
    (await applyOutlineEdit(await blank(), { kind: 'replace-all', nodes: ['A', 'B', 'C'].map(leaf) }, run))
      .bytes;

  it('removes the last, then a middle, then the first sibling, keeping the chain whole', async () => {
    const withoutLast = await applyOutlineEdit(await three(), { kind: 'remove', path: [2] }, run);
    expect(titles(await outlineOf(withoutLast.bytes))).toEqual(['A', 'B']);
    const withoutMiddle = await applyOutlineEdit(await three(), { kind: 'remove', path: [1] }, run);
    expect(titles(await outlineOf(withoutMiddle.bytes))).toEqual(['A', 'C']);
    const withoutFirst = await applyOutlineEdit(await three(), { kind: 'remove', path: [0] }, run);
    expect(titles(await outlineOf(withoutFirst.bytes))).toEqual(['B', 'C']);
    // The removal reports its subtree size and what stays.
    expect(
      withoutFirst.report.notes.find((entry) => entry.key === 'op.note.outline.removed')?.params,
    ).toEqual({ title: 'A', count: 1 });
    expect(withoutFirst.report.notes.find((entry) => entry.key === 'op.note.outline.nodes')?.params).toEqual({
      before: 3,
      after: 2,
    });
  });

  it('removes a nested item and adds beside the ones a parent already has', async () => {
    const nested = (await applyOutlineEdit(await withTree(), { kind: 'remove', path: [0, 1] }, run)).bytes;
    expect(titles(await outlineOf(nested))).toEqual([{ 'Giriş — Şişli': ['Alt bölüm ğ'] }, 'Sonuç']);
    const grown = await applyOutlineEdit(
      nested,
      { kind: 'add-child', parentPath: [0], node: leaf('Yeni alt') },
      run,
    );
    expect(titles(await outlineOf(grown.bytes))).toEqual([
      { 'Giriş — Şişli': ['Alt bölüm ğ', 'Yeni alt'] },
      'Sonuç',
    ]);
  });

  it('reports the progress of the edit', async () => {
    const events: unknown[] = [];
    await applyOutlineEdit(
      await three(),
      { kind: 'remove', path: [0] },
      { ...run, onProgress: (event) => events.push([event.labelKey, event.done, event.total]) },
    );
    expect(events).toEqual([
      ['op.progress.outline', 0, 1],
      ['op.progress.outline', 1, 1],
    ]);
  });

  it('lets an abort raised while reporting progress through unchanged, and stops before starting', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    await expect(
      applyOutlineEdit(
        await three(),
        { kind: 'remove', path: [0] },
        {
          ...run,
          onProgress: () => {
            throw abort;
          },
        },
      ),
    ).rejects.toBe(abort);
    const before = new AbortController();
    before.abort();
    await expect(
      applyOutlineEdit(await three(), { kind: 'remove', path: [0] }, { signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
