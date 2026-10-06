/**
 * The pictures a stamp is made of, prepared in the browser.
 *
 * Everything here runs on a canvas in this tab: a drawn or typed signature is rendered and
 * trimmed to its ink, a photographed one has its paper made transparent, and an image the
 * user adds is decoded (EXIF orientation applied by the browser) and re-encoded only when it
 * has to be. What leaves this module is one PNG or JPEG plus its pixel size, which is all
 * `pdf-core/ops/image-stamp.ts` needs.
 */

/** What a stamp is made of, ready for `addImageStamp`. */
export interface StampSource {
  readonly role: 'signature' | 'initials' | 'image';
  /** PNG (with alpha) or JPEG. */
  readonly bytes: Uint8Array;
  /** The same picture as a data URL, for the preview and the placement ghost. */
  readonly dataUrl: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

/** A signature the user chose to remember on this device (`apps/web/src/signature-store.ts`). */
export interface SavedSignature {
  readonly id: string;
  readonly role: 'signature' | 'initials';
  /** `data:image/png;base64,…` — the trimmed picture. */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** The longest side an added image keeps; a 48 MP photo is not what a page needs. */
export const MAX_IMAGE_SIDE = 3000;

/** The ink colours offered for a signature: black, blue and navy, as `#rrggbb`. */
export const INK_COLORS = { black: '#111111', blue: '#1d4ed8', navy: '#1e2a5a' } as const;
export type InkColor = keyof typeof INK_COLORS;

/** The two typed-signature faces, served from `/fonts/handwriting/` (`tools/fetch-engines.mjs`). */
export const HANDWRITING_FACES = [
  { id: 'dancing', family: 'SsSignatureDancing', file: 'dancing-script', label: 'Dancing Script' },
  { id: 'vibes', family: 'SsSignatureVibes', file: 'great-vibes', label: 'Great Vibes' },
] as const;

/** `latin` and `latin-ext` (Turkish Ğ/ğ, İ/ı, Ş/ş live in U+0100–024F) as two ranges of one face. */
const SUBSETS = [
  {
    name: 'latin',
    range:
      'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  },
  {
    name: 'latin-ext',
    range:
      'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
] as const;

let fontsLoading: Promise<void> | null = null;

/** Register and load the handwriting faces once per page; a failure leaves the fallback cursive face. */
export function loadHandwritingFonts(): Promise<void> {
  if (fontsLoading !== null) return fontsLoading;
  fontsLoading = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
    const faces = HANDWRITING_FACES.flatMap((face) =>
      SUBSETS.map(
        (subset) =>
          new FontFace(face.family, `url(/fonts/handwriting/${face.file}-${subset.name}-400-normal.woff2)`, {
            unicodeRange: subset.range,
            display: 'block',
          }),
      ),
    );
    await Promise.all(
      faces.map(async (face) => {
        try {
          document.fonts.add(await face.load());
        } catch {
          // The face is optional: the signature then renders in the generic cursive face.
        }
      }),
    );
  })();
  return fontsLoading;
}

/** The box around every pixel whose alpha is above `threshold`, or `null` for an empty canvas. */
function inkBounds(
  data: ImageData,
  threshold = 8,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null {
  let minX = data.width;
  let minY = data.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < data.height; y += 1) {
    for (let x = 0; x < data.width; x += 1) {
      if ((data.data[(y * data.width + x) * 4 + 3] ?? 0) > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function canvasBytes(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg'): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  if (blob === null) throw new Error('the canvas could not be encoded');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The ink of a transparent canvas, trimmed to its bounds with a small margin, as a PNG.
 * `null` when nothing was drawn.
 */
export async function trimmedPng(
  source: HTMLCanvasElement,
  role: StampSource['role'],
): Promise<StampSource | null> {
  const context = source.getContext('2d', { willReadFrequently: true });
  if (context === null) return null;
  const bounds = inkBounds(context.getImageData(0, 0, source.width, source.height));
  if (bounds === null) return null;
  const margin = Math.round(Math.max(source.width, source.height) * 0.01);
  const x = Math.max(0, bounds.x - margin);
  const y = Math.max(0, bounds.y - margin);
  const width = Math.min(source.width - x, bounds.width + 2 * margin);
  const height = Math.min(source.height - y, bounds.height + 2 * margin);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d')?.drawImage(source, x, y, width, height, 0, 0, width, height);
  return {
    role,
    bytes: await canvasBytes(out, 'image/png'),
    dataUrl: out.toDataURL('image/png'),
    pixelWidth: width,
    pixelHeight: height,
  };
}

/** Decode an image file the browser can read, EXIF orientation applied. */
async function decode(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/**
 * A photographed or scanned signature: the light paper becomes transparent and the ink is
 * recoloured, so it sits on the page like ink rather than as a white rectangle.
 * `threshold` is 0…100 — how light a pixel may be and still count as ink.
 */
export async function inkFromPhoto(
  file: Blob,
  threshold: number,
  color: string,
  role: StampSource['role'],
): Promise<StampSource | null> {
  const bitmap = await decode(file);
  try {
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const cut = Math.min(Math.max(threshold, 1), 100) * 2.55;
    const ink = /^#([0-9a-f]{6})$/i.exec(color);
    const value = ink === null ? 0x111111 : Number.parseInt(ink[1] as string, 16);
    const [red, green, blue] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    const data = pixels.data;
    for (let index = 0; index < data.length; index += 4) {
      const luminance =
        0.2126 * (data[index] ?? 0) + 0.7152 * (data[index + 1] ?? 0) + 0.0722 * (data[index + 2] ?? 0);
      const alpha = luminance >= cut ? 0 : Math.round(255 * Math.min(1, ((cut - luminance) / cut) ** 0.6));
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = Math.round((alpha * (data[index + 3] ?? 255)) / 255);
    }
    context.putImageData(pixels, 0, 0);
    return await trimmedPng(canvas, role);
  } finally {
    bitmap.close();
  }
}

/** Whether a decoded picture has any pixel that is not fully opaque. */
function hasTransparency(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const data = context.getImageData(0, 0, width, height).data;
  for (let index = 3; index < data.length; index += 4) if ((data[index] ?? 255) < 255) return true;
  return false;
}

/**
 * An image the user adds to the page. A JPEG that needs no turn and no shrink keeps its
 * own bytes (no second lossy pass); anything else is decoded once and written as PNG when
 * it has transparency, JPEG when it does not. `null` when the browser cannot read it.
 */
export async function imageFromFile(file: File): Promise<StampSource | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(file);
  } catch {
    return null;
  }
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL(isJpeg ? 'image/jpeg' : 'image/png', 0.92);
    if (isJpeg && scale === 1 && !(await jpegIsTurned(file))) {
      return {
        role: 'image',
        bytes: new Uint8Array(await file.arrayBuffer()),
        dataUrl,
        pixelWidth: width,
        pixelHeight: height,
      };
    }
    const transparent = !isJpeg && hasTransparency(context, width, height);
    return {
      role: 'image',
      bytes: await canvasBytes(canvas, transparent ? 'image/png' : 'image/jpeg'),
      dataUrl,
      pixelWidth: width,
      pixelHeight: height,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * Whether a JPEG's EXIF orientation turns or mirrors it (tag 0x0112 ≠ 1). The browser
 * applies the tag when it decodes, a PDF reader does not, so a turned JPEG is re-encoded
 * upright instead of embedded as it is.
 *
 * An EXIF block whose offsets point past its bytes (cut short, or written wrong by the
 * camera) counts as turned: its orientation cannot be read, and re-encoding what the
 * browser decoded is right either way. A `DataView` read past the end throws.
 */
export async function jpegIsTurned(file: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    const marker = bytes[offset + 1] ?? 0;
    const length = view.getUint16(offset + 2);
    if (marker === 0xe1 && offset + 8 <= bytes.length && view.getUint32(offset + 4) === 0x45786966) {
      try {
        const tiff = offset + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const entries = view.getUint16(tiff + view.getUint32(tiff + 4, little), little);
        const first = tiff + view.getUint32(tiff + 4, little) + 2;
        for (let index = 0; index < entries; index += 1) {
          const entry = first + index * 12;
          if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little) !== 1;
        }
        return false;
      } catch (error) {
        if (error instanceof RangeError) return true;
        throw error;
      }
    }
    if (marker === 0xda) return false;
    offset += 2 + length;
  }
  return false;
}

/**
 * A base64 data URL's bytes (a remembered signature, placed again). Decoded by hand: a
 * `fetch` of a `data:` URL is a connection, and the CSP's `connect-src 'self'` refuses it.
 */
export function bytesOfDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const binary = atob(comma < 0 ? '' : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
