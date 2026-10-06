/**
 * Walking a document's whole object graph, for the sanitiser (`sanitize.ts`,
 * `sanitize-layers.ts`).
 *
 * Why every object and not the page tree: a script, an attachment or an XMP packet is
 * reached from the catalog, from a page, from an annotation, from an outline entry, from a
 * field — and from objects an earlier revision left behind that nothing reaches any more.
 * A sweep that follows the tree finds the first four and reports a clean file while the
 * last still carries the bytes. So the sweep visits **object numbers `1 … count - 1`**, each
 * object's own dictionary and every dictionary nested directly inside it, and never follows
 * a reference: each object is visited once, reached or not.
 *
 * **Never `resolve()` an object that may be a stream.** This is the one rule of the module,
 * and it was paid for: calling `resolve()` on the indirect reference of a tiling pattern's
 * content stream made MuPDF 1.28.1 save that object as a dictionary *without its stream*
 * (the picture the pattern drew was gone from the output; measured on a real file, one
 * object in 74). `isDictionary()`, `isArray()`, `get()`, `forEach()`, `put()` and `delete()`
 * called **on the reference itself** resolve internally and are safe — the same engine
 * calls, but not through the binding's `resolve()`, which hands out a kept pointer to the
 * object. So every object here is handled as the reference `newIndirect(n)` and never as its
 * resolved body. (The text editor's writer found the same fault from the other side: an
 * image XObject resolved before a redaction lost its stream.)
 *
 * Other MuPDF facts this relies on (`engines/mupdf-write.ts` has the rest):
 *  - `isDictionary()` / `isArray()` / `isStream()` resolve an indirect reference first, so
 *    `isIndirect()` is always asked before them on a *value*.
 *  - `isNull()` does not resolve: a reference to a freed or never-written object is not
 *    "null" to it, and liveness is decided by what the object *is*.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { throwIfAborted } from './types';

/** What a traversal could not do, so a report never implies "scanned" for an unreadable object. */
export interface WalkStats {
  /** Objects that exist (number is in use). */
  live: number;
  /** Object numbers whose body MuPDF could not parse; they are skipped, never guessed at. */
  unreadable: number;
}

/** Keys of a dictionary, collected first so the caller may delete while it works. */
export function keysOf(dictionary: PDFObject): string[] {
  const keys: string[] = [];
  dictionary.forEach((_value, key) => {
    if (typeof key === 'string') keys.push(key);
  });
  return keys;
}

/** The entries of an array, as the references or direct values it holds. */
export function entriesOf(array: PDFObject): PDFObject[] {
  const entries: PDFObject[] = [];
  for (let index = 0; index < array.length; index += 1) entries.push(array.get(index));
  return entries;
}

/**
 * The object an object number names, as a **reference** (see the header), or `null` when the
 * number is free, never written, or names something MuPDF cannot read (`unreadable` says so).
 */
export function liveObject(doc: PDFDocument, number: number): PDFObject | null | 'unreadable' {
  try {
    const reference = doc.newIndirect(number);
    return isLive(reference) ? reference : null;
  } catch {
    return 'unreadable';
  }
}

/** Whether a reference names an object that exists (see {@link liveObject}). */
function isLive(reference: PDFObject): boolean {
  return (
    reference.isDictionary() ||
    reference.isArray() ||
    reference.isNumber() ||
    reference.isString() ||
    reference.isName() ||
    reference.isBoolean()
  );
}

/**
 * What an entry stands for, **without** `resolve()` (see the header): the entry itself when
 * it is a direct value or a reference to something that exists, `null` for an absent entry,
 * a PDF null and a reference to a free object. The returned value answers `isDictionary()`,
 * `get()`, `forEach()` and the rest through the engine's own internal resolution.
 */
export function deref(entry: PDFObject | null | undefined): PDFObject | null {
  if (entry === null || entry === undefined || entry.isNull()) return null;
  if (!entry.isIndirect()) return entry;
  try {
    return isLive(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Every dictionary of the document: each object's own (a stream's dictionary included) and
 * each one nested directly in an array or another dictionary. `holder` is the number of the
 * object the dictionary lives in, which is how a caller names an annotation or a field it
 * has to unlink later. For an object's own dictionary the argument is the reference.
 */
export function forEachDictionary(
  doc: PDFDocument,
  visit: (dictionary: PDFObject, holder: number) => void,
  signal?: AbortSignal,
): WalkStats {
  const stats: WalkStats = { live: 0, unreadable: 0 };
  const total = doc.countObjects();

  const descend = (value: PDFObject, holder: number): void => {
    // `isDictionary` resolves a reference, so the reference test comes first.
    if (value.isIndirect()) return;
    if (value.isDictionary()) {
      visit(value, holder);
      value.forEach((child) => {
        descend(child, holder);
      });
    } else if (value.isArray()) {
      value.forEach((child) => {
        descend(child, holder);
      });
    }
  };

  for (let number = 1; number < total; number += 1) {
    if (signal !== undefined && number % 256 === 0) throwIfAborted(signal);
    const object = liveObject(doc, number);
    if (object === 'unreadable') {
      stats.unreadable += 1;
      continue;
    }
    if (object === null) continue;
    stats.live += 1;
    if (object.isDictionary()) {
      visit(object, number);
      object.forEach((child) => {
        descend(child, number);
      });
    } else if (object.isArray()) {
      object.forEach((child) => {
        descend(child, number);
      });
    }
  }
  return stats;
}

/** Every object number `value` is, or holds directly, a reference to. */
export function referencesIn(value: PDFObject, onReference: (number: number) => void): void {
  if (value.isIndirect()) {
    onReference(value.asIndirect());
    return;
  }
  if (!value.isDictionary() && !value.isArray()) return;
  value.forEach((child) => {
    referencesIn(child, onReference);
  });
}

/**
 * The references an *object* (a reference to a dictionary, an array or a stream) holds,
 * `skipKey` leaving one top-level entry out.
 */
export function referencesInside(
  object: PDFObject,
  onReference: (number: number) => void,
  skipKey?: (key: string) => boolean,
): void {
  object.forEach((child, key) => {
    if (skipKey !== undefined && typeof key === 'string' && skipKey(key)) return;
    referencesIn(child, onReference);
  });
}

/**
 * The objects the file's own structure reaches from the trailer — what a reader can ever
 * get to. `skipRootKey` leaves one catalog entry out of the walk (the optional-content
 * properties, when the question is "does anything *else* point at a layer").
 */
export function reachableObjects(
  doc: PDFDocument,
  skipRootKey?: string,
  signal?: AbortSignal,
): {
  readonly reached: ReadonlySet<number>;
  /** Reached numbers that name an object that exists (a reference to a freed one is not). */
  readonly liveReached: number;
  readonly unreadable: number;
} {
  const reached = new Set<number>();
  const pending: number[] = [];
  let unreadable = 0;
  let liveReached = 0;
  const push = (number: number): void => {
    if (!reached.has(number)) {
      reached.add(number);
      pending.push(number);
    }
  };

  const trailer = doc.getTrailer();
  const root = trailer.get('Root');
  const rootNumber = root.isIndirect() ? root.asIndirect() : -1;
  referencesIn(trailer, push);
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (signal !== undefined && visited % 256 === 0) throwIfAborted(signal);
    const number = pending.pop() as number;
    const object = liveObject(doc, number);
    if (object === 'unreadable') {
      unreadable += 1;
      continue;
    }
    if (object === null) continue;
    liveReached += 1;
    const skip =
      skipRootKey !== undefined && number === rootNumber ? (key: string) => key === skipRootKey : undefined;
    referencesInside(object, push, skip);
  }
  return { reached, liveReached, unreadable };
}

/** The document's catalog dictionary; `null` for a trailer MuPDF could not repair. */
export function catalogOf(doc: PDFDocument): PDFObject | null {
  const root = deref(doc.getTrailer().get('Root'));
  return root?.isDictionary() === true ? root : null;
}

/** The dictionary under `key`, resolved; `null` when it is absent or not a dictionary. */
export function dictionaryUnder(parent: PDFObject | null | undefined, key: string): PDFObject | null {
  const value = deref(parent?.get(key));
  return value?.isDictionary() === true ? value : null;
}

/** The array under `key`, resolved; `null` when it is absent or not an array. */
export function arrayUnder(parent: PDFObject | null | undefined, key: string): PDFObject | null {
  const value = deref(parent?.get(key));
  return value?.isArray() === true ? value : null;
}
