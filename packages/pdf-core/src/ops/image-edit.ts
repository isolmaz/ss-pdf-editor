/**
 * Editing the images a PDF already contains (“select an image
 * object (pdf.js OPS), replace, crop, compress, rotate, opacity”).
 *
 * The split this module is built on: **the pixels are the caller's job, the PDF
 * structure is this module's**. Cropping, rotating, re-compressing and replacing all
 * end in the same place — some new encoded bytes — and every one of them is done in the
 * browser with `createImageBitmap` + `OffscreenCanvas`, which a DOM-free package cannot
 * (and must not) reach for. What is left here is the part that is genuinely about PDF:
 * finding the image objects, keeping the content stream that draws them untouched, and
 * putting new bytes in the object the page already names.
 *
 * Why replacing the object **in place** rather than adding a new XObject: the drawn
 * geometry of an image lives in the page's content stream (`cm` before `Do`), not in the
 * image. Assigning new content to the existing object reference therefore keeps every
 * placement, clip and blend mode exactly as the document has it — no content-stream
 * rewrite, no coordinate maths, no chance of moving the picture. The cost, stated in the
 * report: an image object can be shared, and then one edit changes it everywhere it is
 * drawn.
 *
 * What this module deliberately does not do: vector art, inline images (`BI … ID … EI`)
 * and image masks are not listed as editable, because "replace its pixels" has no
 * meaning for them; `/SMask` is dropped rather than rebuilt when the replacement carries
 * its own transparency, and that is reported as a loss.
 */

import type { PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  pageObjects,
  producerKeptNote,
  readName,
  resolved,
  saveRewrite,
} from '../engines/mupdf-write';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

/**
 * One image object a page draws. `pageIndex` is the page whose resources name it; an
 * object drawn by several pages appears once per page, with the same `ref`.
 */
export interface PdfImageInfo {
  readonly pageIndex: number;
  /** The key under `/Resources /XObject`. */
  readonly name: string;
  /** Object number, the identity an edit travels by. */
  readonly ref: string;
  /** `/Filter` as the file writes it (`/DCTDecode`, `/FlateDecode`, …), without the slash. */
  readonly filter: string | null;
  readonly width: number;
  readonly height: number;
  readonly bitsPerComponent: number | null;
  readonly colorSpace: string | null;
  /** Encoded stream length in bytes. */
  readonly bytes: number;
  /** The object carries `/SMask` or `/Mask`; a replacement drops it (`lost`, reported). */
  readonly hasMask: boolean;
  /**
   * False for anything whose pixels are not the whole picture: an image mask, a
   * degenerate size, or an object that does not resolve to an image at all.
   */
  readonly editable: boolean;
  /** Why `editable` is false, as a dictionary key. */
  readonly notEditableKey?: string;
  /**
   * Whether this module can also hand out the pixels (`readImageData`), which is what
   * crop/rotate/re-compress need. False is a statement about *this* module, not about the
   * image: a JPEG's samples are decodable in a browser but this writer does not decode
   * them yet, and the caller says so in words rather than offering an action that fails.
   */
  readonly transformable: boolean;
  /** Why `transformable` is false, as a dictionary key. */
  readonly notTransformableKey?: string;
}

/** The images of one page, with a small image counted as `small` (the size filter's own vocabulary). */
export interface ImageListing {
  readonly images: readonly PdfImageInfo[];
  readonly pageCount: number;
}

export interface ImageReplacement {
  readonly pageIndex: number;
  readonly name: string;
  /** The new pixels, already encoded. */
  readonly data: Uint8Array;
  readonly format: 'jpeg' | 'png';
}

export interface ImageEditRequest {
  /** Replacements by (page, name): the object keeps its reference, its bytes change. */
  readonly replacements: readonly ImageReplacement[];
  /**
   * Drop `/SMask`/`/Mask` on the replaced object. On by default: an old mask describes
   * the old pixels, and keeping it would apply one image's transparency to another's
   * content. The report states every drop.
   */
  readonly dropMask?: boolean;
}

/** One `/Resources /XObject` entry: its key, its object number and its dictionary. */
interface XObjectEntry {
  readonly name: string;
  /** The indirect reference the page names; a stream is only a stream through it. */
  readonly ref: PDFObject;
  readonly dict: PDFObject;
}

/** The identity an edit travels by: the object number, written the way a file writes it. */
function refLabel(ref: PDFObject): string {
  return `${ref.asIndirect()} 0 R`;
}

/** One of an image dictionary's integer keys (`/Width`, `/Height`, `/BitsPerComponent`). */
function integerAt(dict: PDFObject, key: string): number | null {
  const value = resolved(dict.get(key));
  return value?.isNumber() === true ? value.asNumber() : null;
}

/**
 * The colour model an image's samples are in, as the reader below understands it: a
 * device name, or the ICC-based space with 1 or 3 components that stands for grey or RGB
 * (MuPDF's own writer, and many producers, tag device RGB with an sRGB profile). Anything
 * else — indexed, CMYK, Lab, separations — is `null`.
 */
function sampleSpace(dict: PDFObject): 'DeviceRGB' | 'DeviceGray' | null {
  const value = resolved(dict.get('ColorSpace'));
  if (value === null) return null;
  if (value.isName()) {
    const name = value.asName();
    return name === 'DeviceRGB' || name === 'DeviceGray' ? name : null;
  }
  if (value.isArray() && readName(value.get(0)) === 'ICCBased') {
    const profile = resolved(value.get(1));
    const components = profile === null ? null : integerAt(profile, 'N');
    if (components === 3) return 'DeviceRGB';
    if (components === 1) return 'DeviceGray';
  }
  return null;
}

/** The colour space for the listing: its name, `ICCBased`/`Indexed`/… for an array. */
function colorSpaceLabel(dict: PDFObject): string | null {
  const value = resolved(dict.get('ColorSpace'));
  if (value === null) return null;
  if (value.isName()) return value.asName();
  return value.isArray() ? readName(value.get(0)) : null;
}

/** Every `/Resources /XObject` entry of one page, in the order the resources list them. */
function imageEntries(page: PDFObject): readonly XObjectEntry[] {
  const resources = resolved(page.getInheritable('Resources'));
  const xObjects = resources === null ? null : resolved(resources.get('XObject'));
  if (xObjects === null || !xObjects.isDictionary()) return [];
  const entries: XObjectEntry[] = [];
  xObjects.forEach((value, key) => {
    // An image is always an indirect stream; a direct entry cannot be one.
    if (!value.isIndirect()) return;
    const dict = resolved(value);
    if (dict === null || !dict.isDictionary()) return;
    entries.push({ name: String(key), ref: value, dict });
  });
  return entries;
}

/** The number of distinct pages whose resources name this object. */
function usageCount(pages: readonly PDFObject[], number: number): number {
  return pages.filter((page) => imageEntries(page).some((entry) => entry.ref.asIndirect() === number)).length;
}

/**
 * The images of a document, page by page. A read: it is the same call the dialog and the
 * properties surface use, and it never writes to the file.
 */
export async function listPdfImages(bytes: Uint8Array, context: OperationContext): Promise<ImageListing> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const pageCount = pages.length;
    const images: PdfImageInfo[] = [];
    for (const [pageIndex, page] of pages.entries()) {
      throwIfAborted(context.signal);
      context.onProgress?.({
        phase: 'images',
        labelKey: 'op.progress.image.read',
        done: pageIndex + 1,
        total: pageCount,
      });
      for (const entry of imageEntries(page)) {
        const isImage = readName(entry.dict.get('Subtype')) === 'Image';
        const width = integerAt(entry.dict, 'Width');
        const height = integerAt(entry.dict, 'Height');
        // A single `/Filter` name is the codec; a filter array (a chain) and no filter at
        // all both mean "not one codec the caller can name", which is all it needs to know.
        const filter = readName(entry.dict.get('Filter'));
        const hasMask = !entry.dict.get('SMask').isNull() || !entry.dict.get('Mask').isNull();
        const imageMask = !entry.dict.get('ImageMask').isNull();
        const bits = integerAt(entry.dict, 'BitsPerComponent');
        /**
         * What `readImageData` can hand out: a JPEG stream (the file's own bytes) or
         * 8-bit grey/RGB samples, unfiltered or Flate. Everything else is listed with its
         * reason — a JPEG is perfectly 8-bit grey/RGB too, which is why the filter is
         * checked first.
         */
        let notTransformableKey: string | undefined;
        if (filter === 'DCTDecode') notTransformableKey = undefined;
        else if (filter === null || filter === 'FlateDecode') {
          if ((bits ?? 8) !== 8) notTransformableKey = 'op.note.image.bitsUnsupported';
          else if (sampleSpace(entry.dict) === null)
            notTransformableKey = 'op.note.image.colorSpaceUnsupported';
        } else {
          notTransformableKey = 'op.note.image.filterUnsupported';
        }

        let editable = isImage;
        let notEditableKey: string | undefined;
        if (!isImage) {
          notEditableKey = 'op.note.image.notImage';
          editable = false;
        } else if (imageMask) {
          notEditableKey = 'op.note.image.mask';
          editable = false;
        } else if (width === null || height === null || width <= 0 || height <= 0) {
          notEditableKey = 'op.note.image.degenerate';
          editable = false;
        }

        images.push({
          pageIndex,
          name: entry.name,
          ref: refLabel(entry.ref),
          filter,
          width: width ?? 0,
          height: height ?? 0,
          bitsPerComponent: bits,
          colorSpace: colorSpaceLabel(entry.dict),
          bytes: integerAt(entry.dict, 'Length') ?? 0,
          hasMask,
          editable,
          ...(notEditableKey === undefined ? {} : { notEditableKey }),
          transformable: editable && notTransformableKey === undefined,
          ...(notTransformableKey === undefined ? {} : { notTransformableKey }),
        });
      }
    }
    return { images, pageCount };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'read images');
  } finally {
    doc.destroy();
  }
}

/**
 * The image's own pixels, in the one shape a canvas can take without guessing.
 *
 * `jpeg` is the object's stream **as a JPEG file** — a `/DCTDecode` stream *is* one — and
 * `raw` is uncompressed 8-bit RGBA built from `/FlateDecode` (or unfiltered) samples, with
 * PNG/TIFF row predictors honoured. Everything else (JPX, CCITT, indexed palettes,
 * 1/2/4/16-bit samples, CMYK) is `unsupported` with the reason, because "decode it
 * approximately" is how an edit silently changes a picture.
 */
export type ImageSampleRead =
  | {
      readonly kind: 'jpeg';
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: 'raw';
      /** RGBA, 4 bytes per pixel, row-major. */
      readonly rgba: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: 'unsupported'; readonly reasonKey: string };

/** A MuPDF buffer's bytes, copied out of wasm memory; the buffer is freed. */
function takeBytes(buffer: { asUint8Array(): Uint8Array; destroy(): void }): Uint8Array {
  try {
    return new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
}

/**
 * The pixels behind one image object the listing named.
 *
 * A JPEG is read **undecoded** (`readRawStream`): what the canvas needs is the file's own
 * JPEG, and decoding it here would destroy exactly that. Flate samples are read through
 * MuPDF's own stream decoder (`readStream`), which applies the filter and the
 * `/DecodeParms` row predictor; a predictor it cannot undo is a decode failure, never an
 * approximate picture.
 */
export async function readImageData(
  bytes: Uint8Array,
  target: { readonly pageIndex: number; readonly name: string },
  context: OperationContext,
): Promise<ImageSampleRead> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  try {
    const page = pageObjects(doc)[target.pageIndex];
    const entry =
      page === undefined ? undefined : imageEntries(page).find((item) => item.name === target.name);
    if (entry === undefined || !entry.ref.isStream()) {
      return { kind: 'unsupported', reasonKey: 'op.note.image.notImage' };
    }
    const width = integerAt(entry.dict, 'Width') ?? 0;
    const height = integerAt(entry.dict, 'Height') ?? 0;
    const bits = integerAt(entry.dict, 'BitsPerComponent') ?? 8;
    const filter = readName(entry.dict.get('Filter'));

    if (filter === 'DCTDecode') {
      return { kind: 'jpeg', bytes: takeBytes(entry.ref.readRawStream()), width, height };
    }
    if (filter !== null && filter !== 'FlateDecode') {
      return { kind: 'unsupported', reasonKey: 'op.note.image.filterUnsupported' };
    }
    if (bits !== 8) return { kind: 'unsupported', reasonKey: 'op.note.image.bitsUnsupported' };
    const space = sampleSpace(entry.dict);
    if (space === null) return { kind: 'unsupported', reasonKey: 'op.note.image.colorSpaceUnsupported' };

    let samples: Uint8Array;
    try {
      samples = takeBytes(entry.ref.readStream());
    } catch {
      return { kind: 'unsupported', reasonKey: 'op.note.image.decodeFailed' };
    }
    const colors = space === 'DeviceRGB' ? 3 : 1;
    if (samples.length < width * height * colors) {
      return { kind: 'unsupported', reasonKey: 'op.note.image.decodeFailed' };
    }

    const rgba = new Uint8Array(width * height * 4);
    // `samples` holds at least `width * height * colors` bytes (checked above), so every index read
    // below is inside it.
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const at = pixel * 4;
      if (colors === 3) {
        rgba[at] = samples[pixel * 3] as number;
        rgba[at + 1] = samples[pixel * 3 + 1] as number;
        rgba[at + 2] = samples[pixel * 3 + 2] as number;
      } else {
        const grey = samples[pixel] as number;
        rgba[at] = grey;
        rgba[at + 1] = grey;
        rgba[at + 2] = grey;
      }
      rgba[at + 3] = 255;
    }
    return { kind: 'raw', rgba, width, height };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'read image data');
  } finally {
    doc.destroy();
  }
}

/** The bytes carry the magic of the format the caller names (`\x89PNG`, `FF D8 FF`). */
function looksLike(data: Uint8Array, format: 'jpeg' | 'png'): boolean {
  if (format === 'png') {
    return data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  }
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

/**
 * Swap the encoded bytes of the images the request names.
 *
 * Each replacement is decoded by MuPDF first (which validates that the bytes really are
 * the format the caller claims — a truncated JPEG fails here, not in the user's reader)
 * and added as a new image object; then that object's dictionary and encoded stream are
 * written **into the reference the page already draws**, and the scratch object is
 * deleted. The old object's dictionary does not survive: keeping `/SMask`, `/Decode` or
 * `/DecodeParms` from pixels that are gone is exactly how an edit corrupts a file.
 */
export async function applyImageEdit(
  bytes: Uint8Array,
  request: ImageEditRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (request.replacements.length === 0) {
    return {
      bytes,
      report: {
        engine: 'mupdf',
        steps: ['load'],
        notes: [note('warning', 'op.note.image.nothing'), producerKeptNote()],
        inputBytes: bytes.byteLength,
        outputBytes: bytes.byteLength,
        pageCount: 0,
        incremental: true,
      },
    };
  }

  const { mupdf, doc } = await openForWrite(bytes);
  let out: Uint8Array;
  let pageCount: number;
  const notes: OperationNote[] = [];
  const steps: string[] = ['load'];
  const replaced: {
    readonly pageIndex: number;
    readonly name: string;
    readonly number: number;
    readonly sharedWith: number;
  }[] = [];
  try {
    const pages = pageObjects(doc);
    pageCount = pages.length;
    const dropMask = request.dropMask !== false;
    let dropped = 0;
    let missing = 0;

    for (const [index, replacement] of request.replacements.entries()) {
      throwIfAborted(context.signal);
      context.onProgress?.({
        phase: 'images',
        labelKey: 'op.progress.image.write',
        done: index,
        total: request.replacements.length,
      });
      const page = pages[replacement.pageIndex];
      if (page === undefined) {
        throw new ToolError('value-out-of-range', {
          engine: 'mupdf',
          path: 'request.replacements.pageIndex',
          engineMessage: `page ${replacement.pageIndex} is outside 0…${pageCount - 1}`,
        });
      }
      const target = imageEntries(page).find((entry) => entry.name === replacement.name);
      if (target === undefined) {
        // A name the document does not carry: counted, never invented.
        missing += 1;
        continue;
      }
      if (replacement.data.byteLength === 0) {
        throw new ToolError('selection-empty', {
          engine: 'mupdf',
          path: 'request.replacements.data',
          engineMessage: `replacement for "${replacement.name}" carries no bytes`,
        });
      }

      let produced: PDFObject;
      try {
        if (!looksLike(replacement.data, replacement.format)) throw new Error('format signature mismatch');
        const image = new mupdf.Image(replacement.data.slice());
        try {
          produced = doc.addImage(image);
        } finally {
          image.destroy();
        }
      } catch (error) {
        // The bytes came from the user's own file picker, so the honest code is the format one.
        throw new ToolError(
          'unsupported-format',
          {
            engine: 'mupdf',
            path: 'request.replacements.data',
            engineMessage: `the replacement for "${replacement.name}" is not a readable ${replacement.format.toUpperCase()}`,
          },
          { cause: error },
        );
      }

      const oldMask = [target.dict.get('SMask'), target.dict.get('Mask')].find((value) => value.isIndirect());
      const sharedWith = usageCount(pages, target.ref.asIndirect());

      // The reference the page names now holds the new image: its dictionary first, then
      // its encoded bytes (the filter the dictionary names stays theirs).
      const encoded = takeBytes(produced.readRawStream());
      const dictionary = doc.newDictionary();
      // The picture's own alpha arrives as an `/SMask` on the produced image: it is the new
      // picture's, so it stays; only the OLD object's mask is dropped.
      let ownMask = false;
      produced.resolve().forEach((value, key) => {
        if (key === 'SMask' || key === 'Mask') ownMask = true;
        if (key !== 'Length') dictionary.put(key, value);
      });
      target.ref.writeObject(dictionary);
      target.ref.writeRawStream(encoded);
      doc.deleteObject(produced);

      if (dropMask) {
        // The dictionary written above is the new picture's alone, so the old object's mask
        // is already gone: it described the old pixels, and `garbage` collects it on save.
        if (oldMask !== undefined) dropped += 1;
      } else if (oldMask !== undefined && !ownMask) {
        notes.push(note('warning', 'op.note.image.maskKept', { name: replacement.name }));
      }
      replaced.push({
        pageIndex: replacement.pageIndex,
        name: replacement.name,
        number: target.ref.asIndirect(),
        sharedWith,
      });
    }

    context.onProgress?.({
      phase: 'images',
      labelKey: 'op.progress.image.write',
      done: request.replacements.length,
      total: request.replacements.length,
    });

    if (replaced.length === 0) {
      // Nothing the request named exists in this document: the input goes back untouched.
      const report: OperationReport = {
        engine: 'mupdf',
        steps: ['load'],
        notes: [...notes, note('warning', 'op.note.image.noneFound', { count: missing }), producerKeptNote()],
        inputBytes: bytes.byteLength,
        outputBytes: bytes.byteLength,
        pageCount,
        incremental: true,
      };
      return { bytes, report };
    }

    for (const entry of replaced) {
      notes.push(note('changed', 'op.note.image.replaced', { name: entry.name, page: entry.pageIndex + 1 }));
      if (entry.sharedWith > 1) {
        notes.push(note('warning', 'op.note.image.shared', { name: entry.name, count: entry.sharedWith }));
      }
    }
    if (dropped > 0) notes.push(note('lost', 'op.note.image.maskDropped', { count: dropped }));
    if (missing > 0) notes.push(note('warning', 'op.note.image.notFound', { count: missing }));
    steps.push('producer');

    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'edit images');
    steps.push('save');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'edit images');
  } finally {
    doc.destroy();
  }
  await verifyOutput(out, pageCount, replaced);
  steps.push('verify');

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    // Re-serialised: the incremental fast path is over.
    incremental: false,
  };
  return { bytes: out, report };
}

/**
 * Re-open the produced file and check that every replaced object is still the image the
 * page names. A file that does not parse, a page count that moved, an object that is no
 * longer an image, or a page that no longer names it is `verification-failed` — the
 * caller keeps the original and the session stays dirty.
 */
async function verifyOutput(
  produced: Uint8Array,
  pageCount: number,
  replaced: readonly { readonly pageIndex: number; readonly name: string; readonly number: number }[],
): Promise<void> {
  let opened: Awaited<ReturnType<typeof openForWrite>>;
  try {
    opened = await openForWrite(produced);
  } catch (error) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `produced file does not re-open: ${String(error)}`,
    });
  }
  const { doc } = opened;
  try {
    const pages = pageObjects(doc);
    if (pages.length !== pageCount) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `produced file has ${pages.length} pages, expected ${pageCount}`,
      });
    }
    for (const entry of replaced) {
      // The page count matches (checked above) and a replaced page index was inside it.
      const page = pages[entry.pageIndex] as PDFObject;
      const named = imageEntries(page).find((item) => item.name === entry.name);
      if (named === undefined) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page ${entry.pageIndex + 1} no longer names an object called "${entry.name}"`,
        });
      }
      if (named.ref.asIndirect() !== entry.number || readName(named.dict.get('Subtype')) !== 'Image') {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `the object behind "${entry.name}" is not the replaced image after the write`,
        });
      }
    }
  } finally {
    doc.destroy();
  }
}
