/**
 * The object-graph walk under the sanitiser, on a document built in the test. The wrong
 * answers that matter: an orphaned object counted as reachable (or missed by the sweep, so a
 * script an earlier revision left behind is "clean"), a free object read as live, and a tiling
 * pattern that loses its content stream because the walk resolved it (the MuPDF hazard the
 * module header records).
 */

import type { PDFDocument } from 'mupdf';
import { describe, expect, it } from 'vitest';
import {
  arrayUnder,
  catalogOf,
  deref,
  dictionaryUnder,
  entriesOf,
  forEachDictionary,
  keysOf,
  liveObject,
  reachableObjects,
} from './sanitize-graph';

const mupdf = await import('mupdf');

const PATTERN_CONTENT = '1 0 0 rg 0 0 6 6 re f';

interface Fixture {
  readonly doc: PDFDocument;
  readonly pattern: number;
  readonly orphanDictionary: number;
  readonly orphanStream: number;
  readonly freed: number;
  readonly page: number;
}

async function build(): Promise<Fixture> {
  const doc = new mupdf.PDFDocument();
  const pattern = doc.addStream(PATTERN_CONTENT, {
    Type: 'Pattern',
    PatternType: 1,
    PaintType: 1,
    TilingType: 1,
    BBox: [0, 0, 10, 10],
    XStep: 10,
    YStep: 10,
    Resources: {},
  });
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(10);
  const image = doc.addImage(new mupdf.Image(pixmap));
  const page = doc.addPage(
    [0, 0, 200, 200],
    0,
    { Pattern: { P1: pattern }, XObject: { Im1: image } },
    '/Pattern cs /P1 scn 20 20 150 150 re f',
  );
  doc.insertPage(0, page);
  const orphanDictionary = doc.addObject({ OrphanMarker: 1 });
  const orphanStream = doc.addStream('orphaned stream bytes', { OrphanStream: true });
  const freed = doc.addObject({ Gone: true });
  doc.deleteObject(freed);
  return {
    doc,
    pattern: pattern.asIndirect(),
    orphanDictionary: orphanDictionary.asIndirect(),
    orphanStream: orphanStream.asIndirect(),
    freed: freed.asIndirect(),
    page: page.asIndirect(),
  };
}

describe('sanitize graph', () => {
  it('reaches what the trailer reaches and not what nothing points at', async () => {
    const { doc, pattern, page, orphanDictionary, orphanStream } = await build();
    try {
      const { reached, liveReached } = reachableObjects(doc);
      expect(reached.has(page)).toBe(true);
      expect(reached.has(pattern)).toBe(true);
      expect(reached.has(orphanDictionary)).toBe(false);
      expect(reached.has(orphanStream)).toBe(false);
      // Every reached number names a live object here (nothing dangles).
      expect(liveReached).toBe(reached.size);

      // The catalog entry named by `skipRootKey` is left out of the walk.
      const root = doc.getTrailer().get('Root');
      const referenced = doc.addObject({ OnlyViaExtra: true });
      root.put('Extra', referenced);
      expect(reachableObjects(doc).reached.has(referenced.asIndirect())).toBe(true);
      expect(reachableObjects(doc, 'Extra').reached.has(referenced.asIndirect())).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('visits every live object once, reached or not, and tells free numbers from live ones', async () => {
    const { doc, orphanDictionary, orphanStream, freed, pattern } = await build();
    try {
      const seen = new Map<number, number>();
      const orphanKeys: string[] = [];
      const stats = forEachDictionary(doc, (dictionary, holder) => {
        seen.set(holder, (seen.get(holder) ?? 0) + 1);
        orphanKeys.push(...keysOf(dictionary).filter((key) => key.startsWith('Orphan')));
      });
      // The sweep's whole point: the unreachable ones are visited.
      expect(orphanKeys.sort()).toEqual(['OrphanMarker', 'OrphanStream']);
      expect(seen.has(orphanDictionary)).toBe(true);
      expect(seen.has(orphanStream)).toBe(true);
      expect(seen.has(freed)).toBe(false);
      expect(seen.has(pattern)).toBe(true);
      expect(stats.unreadable).toBe(0);
      // `live` counts exactly the numbers that are in use.
      let live = 0;
      for (let number = 1; number < doc.countObjects(); number += 1) {
        if (liveObject(doc, number) !== null) live += 1;
      }
      expect(stats.live).toBe(live);
      expect(liveObject(doc, freed)).toBeNull();
      expect(liveObject(doc, 99999)).toBeNull();
    } finally {
      doc.destroy();
    }
  });

  it('leaves a pattern stream and an image as they were after a read-only walk', async () => {
    const { doc } = await build();
    try {
      // The walk's own operations on every object, and `deref` of every reference, read the
      // way the sweeps read them (a type test, then a `get` on what `deref` returned). The
      // resolve() hazard itself only shows inside a full sweep: `sanitize.test.ts` fails if
      // `deref` resolves (checked by injecting that fault), this one pins the walk's own part.
      forEachDictionary(doc, (dictionary) => {
        for (const key of keysOf(dictionary)) {
          const target = deref(dictionary.get(key));
          if (target?.isDictionary() === true) target.get('OC');
        }
      });
      reachableObjects(doc);
      const bytes = new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array());
      const reopened = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as PDFDocument;
      try {
        const page = reopened.findPage(0);
        const out = dictionaryUnder(dictionaryUnder(page, 'Resources'), 'Pattern')?.get('P1');
        expect(out?.isStream()).toBe(true);
        const buffer = out?.readStream();
        expect(new TextDecoder().decode(buffer?.asUint8Array())).toBe(PATTERN_CONTENT);
        buffer?.destroy();
        // The same for an image XObject: resolved by a careless walk, it saves without its pixels.
        const picture = dictionaryUnder(dictionaryUnder(page, 'Resources'), 'XObject')?.get('Im1');
        expect(picture?.isStream()).toBe(true);
        expect(picture?.get('Width').asNumber()).toBe(4);
      } finally {
        reopened.destroy();
      }
    } finally {
      doc.destroy();
    }
  });

  it('reads direct and indirect values alike, and nothing for a missing or dangling one', async () => {
    const { doc, freed, page } = await build();
    try {
      const root = catalogOf(doc);
      expect(root).not.toBeNull();
      expect(keysOf(root as NonNullable<typeof root>)).toContain('Pages');
      const pageObject = doc.newIndirect(page);
      expect(deref(pageObject)?.isDictionary()).toBe(true);
      expect(deref(doc.newIndirect(freed))).toBeNull();
      expect(deref(null)).toBeNull();
      expect(deref(doc.newNull())).toBeNull();
      expect(arrayUnder(pageObject, 'MediaBox')?.length).toBe(4);
      expect(
        entriesOf(arrayUnder(pageObject, 'MediaBox') as NonNullable<ReturnType<typeof arrayUnder>>).map(
          (entry) => entry.asNumber(),
        ),
      ).toEqual([0, 0, 200, 200]);
      expect(dictionaryUnder(pageObject, 'MediaBox')).toBeNull();
      expect(arrayUnder(pageObject, 'NoSuchKey')).toBeNull();
    } finally {
      doc.destroy();
    }
  });
});

/** A handle that behaves as the real one, except where `override` answers instead. */
function faulty<T extends object>(
  target: T,
  override: Partial<Record<string, (...args: never[]) => unknown>>,
): T {
  return new Proxy(target, {
    get(real, property) {
      const replacement = override[String(property)];
      if (replacement !== undefined) return replacement;
      const value: unknown = Reflect.get(real, property, real);
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });
}

describe('sanitize graph: objects MuPDF cannot read, and odd shapes', () => {
  it('keeps only the string keys of a container, so an array has none', async () => {
    const { doc, page } = await build();
    try {
      const mediaBox = arrayUnder(doc.newIndirect(page), 'MediaBox') as NonNullable<
        ReturnType<typeof arrayUnder>
      >;
      expect(keysOf(mediaBox)).toEqual([]);
    } finally {
      doc.destroy();
    }
  });

  it('counts an object MuPDF cannot read as unreadable, never as live and never as absent', async () => {
    const { doc, pattern, page } = await build();
    try {
      const broken = faulty(doc, {
        newIndirect: (number: number) => {
          if (number === pattern) throw new Error('cannot read object');
          return doc.newIndirect(number);
        },
      });
      expect(liveObject(broken, pattern)).toBe('unreadable');
      expect(liveObject(broken, page)).not.toBe('unreadable');

      const visited = new Set<number>();
      const stats = forEachDictionary(broken, (_dictionary, holder) => visited.add(holder));
      expect(stats.unreadable).toBe(1);
      expect(visited.has(pattern)).toBe(false);
      expect(visited.has(page)).toBe(true);
      // The sweep that skipped it is not "clean": the count is what the report carries.
      const whole = forEachDictionary(doc, () => undefined);
      expect(stats.live).toBe(whole.live - 1);

      const reached = reachableObjects(broken);
      expect(reached.unreadable).toBe(1);
      expect(reached.reached.has(pattern)).toBe(true);
      expect(reached.liveReached).toBe(reachableObjects(doc).liveReached - 1);
    } finally {
      doc.destroy();
    }
  });

  it('reads an entry whose object cannot be read as nothing', async () => {
    const { doc, page } = await build();
    try {
      const reference = doc.newIndirect(page);
      const hostile = faulty(reference, {
        isDictionary: () => {
          throw new Error('cannot read object');
        },
      });
      expect(hostile.isIndirect()).toBe(true);
      expect(deref(hostile)).toBeNull();
    } finally {
      doc.destroy();
    }
  });

  it('skips an object that is neither a dictionary nor an array, and a reference to nothing', async () => {
    const { doc, freed } = await build();
    try {
      doc.addObject(doc.newString('a lone string object'));
      const lone = doc.addObject(doc.newInteger(7));
      expect(liveObject(doc, lone.asIndirect())).not.toBeNull();
      const visited: number[] = [];
      forEachDictionary(doc, (_dictionary, holder) => visited.push(holder));
      expect(visited).not.toContain(lone.asIndirect());

      // The trailer points at a number nothing is stored under: reached, but not live.
      doc.getTrailer().put('Ghost', doc.newIndirect(freed));
      const { reached, liveReached } = reachableObjects(doc);
      expect(reached.has(freed)).toBe(true);
      expect(liveReached).toBeLessThan(reached.size);
    } finally {
      doc.destroy();
    }
  });

  it('has no catalog for a trailer whose Root is not a dictionary, and reads a direct Root', async () => {
    const { doc } = await build();
    try {
      const trailer = doc.getTrailer();
      trailer.put('Root', doc.newInteger(3));
      expect(catalogOf(doc)).toBeNull();
      const direct = doc.newDictionary();
      direct.put('Marker', doc.newInteger(1));
      trailer.put('Root', direct);
      expect(catalogOf(doc)).not.toBeNull();
      // A direct Root has no object number, and the walk still runs.
      expect(reachableObjects(doc, 'Marker').liveReached).toBe(0);
    } finally {
      doc.destroy();
    }
  });

  it('refuses to go on when the run is aborted, after every 256 objects', async () => {
    const doc = new mupdf.PDFDocument();
    try {
      doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
      const many = doc.newArray();
      for (let index = 0; index < 300; index += 1) many.push(doc.addObject({ Index: index }));
      doc.getTrailer().get('Root').put('Many', many);
      const controller = new AbortController();
      controller.abort();
      expect(() => forEachDictionary(doc, () => undefined, controller.signal)).toThrow(
        expect.objectContaining({ name: 'AbortError' }),
      );
      expect(() => reachableObjects(doc, undefined, controller.signal)).toThrow(
        expect.objectContaining({ name: 'AbortError' }),
      );
      // The same documents walk to the end when the signal is live.
      const live = new AbortController();
      expect(forEachDictionary(doc, () => undefined, live.signal).live).toBeGreaterThan(300);
      expect(reachableObjects(doc, undefined, live.signal).liveReached).toBeGreaterThan(300);
    } finally {
      doc.destroy();
    }
  });
});
