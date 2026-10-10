/**
 * MuPDF adapter: the only place that talks
 * to `mupdf.js`.
 *
 * MuPDF is AGPL-3.0-or-later and every byte of it is served from **our own
 * origin** (`/engines/mupdf/mupdf.js`, SHA-256 pinned); the wasm
 * resolves next to that file, so no runtime request ever leaves the device. The
 * module is imported by its **runtime URL** (behind a `vite-ignore` marker) so the
 * bundler neither resolves nor inlines a 9.93 MiB wasm engine into the first-paint
 * chunk —
 * MuPDF only loads when a redaction, box, layer or widget step actually runs
 * ("no redaction, no MuPDF touch").
 *
 * Engines work on a **disposable copy** of the bytes, never the app-owned
 * master buffer. The copy is made here, in `openPdf`.
 *
 * Error vocabulary (measured on mupdf@1.28.1): the wasm layer throws plain
 * `Error`s whose message carries the MuPDF text ("cannot authenticate password",
 * "Unused pdf arguments found", "invalid page number: 1", …). Those strings never
 * reach the user; they are mapped to our codes and preserved in
 * `details.engineMessage` for the save report and diagnostics.
 */

import type { Document as MupdfDocument, PDFDocument, PDFObject, PDFPage, Rect } from 'mupdf';
import { ToolError, toToolError } from 'pdf-shared';
import { MUPDF_ASSETS } from '../assets';

export type Mupdf = typeof import('mupdf');

export interface UserBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The unrotated page box: `/CropBox`, falling back to `/MediaBox` (both inheritable). */
export function readPageBox(page: PDFPage): UserBox {
  const object = page.getObject();
  const media = readBoxArray(object.getInheritable('MediaBox'));
  const crop = readBoxArray(object.getInheritable('CropBox'));
  if (media !== null) {
    const visible: Box4 =
      crop === null
        ? media
        : [
            Math.max(media[0], crop[0]),
            Math.max(media[1], crop[1]),
            Math.min(media[2], crop[2]),
            Math.min(media[3], crop[3]),
          ];
    const [x0, y0, x1, y1] = visible[2] > visible[0] && visible[3] > visible[1] ? visible : media;
    if (x1 > x0 && y1 > y0) return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  throw new ToolError('corrupt-document', {
    engine: 'mupdf',
    engineMessage: 'page has no readable CropBox/MediaBox',
  });
}

type Box4 = readonly [number, number, number, number];

/** The four numbers of a box array, or `null` when the object is not one. */
function readBoxArray(object: PDFObject): Box4 | null {
  if (!object.isArray()) return null;
  const [a, b, c, d] = [object.get(0), object.get(1), object.get(2), object.get(3)];
  if (!(a.isNumber() && b.isNumber() && c.isNumber() && d.isNumber())) return null;
  return [a.asNumber(), b.asNumber(), c.asNumber(), d.asNumber()];
}

/**
 * The page's `/Rotate` as quarter turns. The entry is inheritable (`/Rotate` may
 * live on a `/Pages` node) and defaults to 0 per ISO 32000-2 §7.7.3.3. A value that
 * is not a multiple of 90 is refused instead of rounded: the conversion below would
 * otherwise rotate the rectangles by an angle no reader displays, and pdf.js — the
 * verification reader — rejects such a page outright.
 */
export function readPageRotation(page: PDFPage): 0 | 90 | 180 | 270 {
  const entry = page.getObject().getInheritable('Rotate');
  const raw = entry.isNumber() ? entry.asNumber() : 0;
  if (!Number.isFinite(raw) || raw % 90 !== 0) {
    throw new ToolError('unsupported', {
      engine: 'mupdf',
      engineMessage: `page /Rotate ${raw} is not a multiple of 90`,
    });
  }
  return (((raw % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

/**
 * Top-left page space → unrotated PDF user space (bottom-left origin).
 *
 * The app's page space — and therefore every rectangle and baseline this operation
 * receives — counts `y` **down** from the top edge of the page box; PDF user space
 * counts `y` up from the bottom. One flip, one place:
 *
 *   user = (x, box.y + box.height − y)
 *
 * The flip line is the box's top edge, which is what the viewer's own pointer
 * conversion uses (`PdfViewerPane.pointToPage`: `top = viewBox[3]`, `y = top − pdfY`).
 */
export function topLeftToUserPoint(
  box: UserBox,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return { x, y: box.y + box.height - y };
}

/** The same flip for a rectangle; `[x0, y0, x1, y1]` stays ascending through it. */
export function topLeftRectToUserSpace(box: UserBox, rect: readonly [number, number, number, number]): Rect {
  const [x0, y0, x1, y1] = rect;
  return [x0, box.y + box.height - y1, x1, box.y + box.height - y0];
}

/**
 * Unrotated user space → **MuPDF page space**, the space an annotation's `setRect`
 * takes.
 *
 * MuPDF page space is the *displayed* page: its origin is the page box's top-left
 * corner **after `/Rotate`**, `u` grows right and `v` grows down. Inverting the
 * forward table `ops/page-boxes.ts` verified against a rendered fixture for all
 * four rotations gives, for a box `(cx, cy, cw, ch)` and a user-space point
 * `(x, y)`:
 *
 *   rotation   0:  u = x − cx,        v = cy + ch − y
 *   rotation  90:  u = y − cy,        v = x − cx
 *   rotation 180:  u = cx + cw − x,   v = y − cy
 *   rotation 270:  u = cy + ch − y,   v = cx + cw − x
 *
 * The same statement in words: the page is turned clockwise by `/Rotate`, so under
 * 90° the box's bottom-left corner `(cx, cy)` lands at page-space `(0, 0)` and the
 * top of the page becomes its right edge. Skipping this step fails silently — an
 * annotation built from unrotated coordinates is accepted, consumed, and removes
 * nothing.
 */
function userToPageSpace(
  rotation: 0 | 90 | 180 | 270,
  box: UserBox,
  x: number,
  y: number,
): { readonly u: number; readonly v: number } {
  // The input here is **PDF user space** (bottom-left origin) — `rectToPageSpace`
  // composes `topLeftToUserPoint` first — and the result is MuPDF's **page space**
  // (the displayed page after `/Rotate`, origin top-left, `v` growing down).
  //
  //   rotation   0:  u = x − cx,        v = cy + ch − y
  //   rotation  90:  u = y − cy,        v = x − cx
  //   rotation 180:  u = cx + cw − x,   v = y − cy
  //   rotation 270:  u = cy + ch − y,   v = cx + cw − x
  //
  // This is the inverse of the pair `ops/stamp.ts > displayToUserPoint` defines and
  // `page-boxes.ts` verified per quarter turn. It is also the space MuPDF's own
  // `toStructuredText` walk reports quads in, which is what makes the coverage read
  // and the annotation agree — the property to check whenever either side changes.
  switch (rotation) {
    case 90:
      return { u: y - box.y, v: x - box.x };
    case 180:
      return { u: box.x + box.width - x, v: y - box.y };
    case 270:
      return { u: box.y + box.height - y, v: box.x + box.width - x };
    default:
      return { u: x - box.x, v: box.y + box.height - y };
  }
}

/**
 * A request rectangle → the page-space rectangle the redaction needs. Two opposite
 * corners are mapped and the result is normalised, so the quarter turn is reasoned
 * about exactly once.
 */
export function rectToPageSpace(
  box: UserBox,
  rotation: 0 | 90 | 180 | 270,
  rect: readonly [number, number, number, number],
): Rect {
  const first = topLeftToUserPoint(box, rect[0], rect[1]);
  const second = topLeftToUserPoint(box, rect[2], rect[3]);
  const start = userToPageSpace(rotation, box, first.x, first.y);
  const end = userToPageSpace(rotation, box, second.x, second.y);
  return [
    Math.min(start.u, end.u),
    Math.min(start.v, end.v),
    Math.max(start.u, end.u),
    Math.max(start.v, end.v),
  ];
}

/**
 * The full-rewrite save option string.
 *
 * `garbage=compact,compress,clean` is the option set that leaves a
 * **single revision** in the output (`/Prev` 0, one `startxref`), drops the object
 * that held the erased content stream, and renumbers the survivors (page-1 content
 * object 6 → 10 in a 2-page fixture). `incremental` is never an option here: after
 * `applyRedactions()`, `canBeSavedIncrementally()` turns
 * `false`, and the incremental write still succeeds *silently*, keeping the
 * pre-redaction revision alive behind a `/Prev` chain — the erased revision would
 * travel with the file.
 */
export const MUPDF_FULL_SAVE_OPTIONS = 'garbage=compact,compress,clean';

let mupdfModule: Promise<Mupdf> | null = null;
let mupdfLoadAttempt = 0;

/** Memoized lazy load; the second caller shares the first request, but a failed request can retry. */
export function loadMupdf(): Promise<Mupdf> {
  if (mupdfModule === null) {
    const url = mupdfLoadAttempt === 0 ? MUPDF_ASSETS.js : `${MUPDF_ASSETS.js}?retry=${mupdfLoadAttempt}`;
    mupdfLoadAttempt += 1;
    mupdfModule = (import(/* @vite-ignore */ url) as Promise<Mupdf>).catch((error) => {
      mupdfModule = null;
      throw error;
    });
  }
  return mupdfModule;
}

/** Keywords of the MuPDF error text we can classify; everything else is `internal`. */
const MUPDF_ERROR_CODES: readonly (readonly [RegExp, ToolError['code']])[] = [
  [/password/i, 'wrong-password'],
  [/out of memory|memory exhausted|allocation failed/i, 'out-of-memory'],
  [/cannot open|no objects found|damaged|corrupt|format error|broken/i, 'corrupt-document'],
  [/not a pdf|unknown file format|unsupported|unrecognized/i, 'unsupported-format'],
  [/abort|cancel/i, 'aborted'],
];

/**
 * MuPDF text -> `ToolError`. The raw message is kept verbatim in
 * `details.engineMessage` (diagnostics only) and prefixed with the call site that
 * failed, because MuPDF reports the same phrasing from several entry points.
 */
export function mapMupdfError(error: unknown, context: string): ToolError {
  if (error instanceof ToolError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const engineMessage = `${context}: ${raw}`;
  for (const [pattern, code] of MUPDF_ERROR_CODES) {
    if (pattern.test(raw)) {
      return new ToolError(code, { engine: 'mupdf', engineMessage }, { cause: error });
    }
  }
  return toToolError(new Error(engineMessage), 'mupdf');
}

/**
 * Open a PDF from a **disposable copy** and hand back the PDF-specific
 * interface. The caller owns the returned document and must `destroy()` it —
 * `asPDF()` returns the same wrapper for a PDF, so one destroy releases the wasm
 * document exactly once.
 *
 * An encrypted document opens here; `needsPassword()`/`authenticatePassword()` stay
 * the caller's decision, because the security op has to distinguish "no password
 * needed" from "wrong password" (`ops/security.ts`).
 */
export function openPdf(mupdf: Mupdf, bytes: Uint8Array): PDFDocument {
  let document: MupdfDocument;
  try {
    document = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  } catch (error) {
    throw mapMupdfError(error, 'open');
  }
  const pdf = document.asPDF();
  if (pdf === null) {
    document.destroy();
    throw new ToolError('unsupported-format', {
      engine: 'mupdf',
      engineMessage: 'opened document is not a PDF',
    });
  }
  return pdf;
}

/**
 * `saveToBuffer` hands back a **wasm-owned** buffer: copy the bytes out and free
 * the buffer, otherwise the emscripten heap keeps the whole output until the
 * document is destroyed.
 *
 * The option argument is a string (`'encrypt=…,permissions=…'`,
 * `MUPDF_FULL_SAVE_OPTIONS`, `'incremental'`); the object form exists only because
 * MuPDF's own typings accept `any`, and an unknown key is a hard error ("Unused pdf
 * arguments found"), so callers pass strings they have measured.
 */
export function savePdf(doc: PDFDocument, options: string | Record<string, unknown>): Uint8Array {
  const buffer = doc.saveToBuffer(options);
  try {
    return new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
}

const LATIN1_CHUNK = 0x8000;

/**
 * Raw bytes as a latin1 ("binary") string — the shape object-level audits need
 *: a needle can then be counted with plain
 * `indexOf` across dictionary text, hex strings and undecoded streams without
 * decoding the file as UTF-8 (a PDF is binary; UTF-8 decoding would mangle bytes
 * and hide occurrences).
 *
 * Chunked because `String.fromCharCode(...bytes)` on a 50 MB file overflows the
 * argument limit.
 */
export function hexStringToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += LATIN1_CHUNK) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + LATIN1_CHUNK));
  }
  return out;
}
