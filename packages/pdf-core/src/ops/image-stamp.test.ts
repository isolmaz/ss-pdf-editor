/**
 * Picture stamps against real bytes, checked by rendering the page with MuPDF: the image
 * must land where it was placed (a picture placed on a turned page upright, left half
 * still on the left), resizing must move only the rectangle, and a file that is not a
 * PNG/JPEG or a box too small to see must be refused rather than written.
 */

import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { readName, readNumbers, resolved } from '../engines/mupdf-write';
import { addImageStamp, type ImageStampRequest, resizeImageStamp } from './image-stamp';

const run = { signal: new AbortController().signal };

/** A 20×10 PNG, left half red and right half blue, so a turned stamp shows its way up. */
function redBluePng(): Uint8Array {
  const width = 20;
  const height = 10;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      if (x < width / 2) raw[at] = 255;
      else raw[at + 2] = 255;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** A blank 200×300 page, optionally turned. */
async function blank(rotate: 0 | 90 = 0): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 300], rotate, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const request = (patch: Partial<ImageStampRequest> = {}): ImageStampRequest => ({
  id: 'stamp-1',
  pageIndex: 0,
  center: { x: 100, y: 150 },
  width: 60,
  height: 40,
  image: redBluePng(),
  role: 'signature',
  label: 'Signature',
  author: 'Tester',
  ...patch,
});

/** The page as shown, and the box of its red and of its blue pixels. */
async function render(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    const pixels = pixmap.getPixels();
    const stride = pixmap.getStride();
    const channels = pixmap.getNumberOfComponents();
    const boxOf = (match: (r: number, g: number, b: number) => boolean) => {
      let box: [number, number, number, number] | null = null;
      for (let y = 0; y < pixmap.getHeight(); y += 1) {
        for (let x = 0; x < pixmap.getWidth(); x += 1) {
          const at = y * stride + x * channels;
          if (!match(pixels[at] ?? 0, pixels[at + 1] ?? 0, pixels[at + 2] ?? 0)) continue;
          box =
            box === null
              ? [x, y, x, y]
              : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
        }
      }
      return box;
    };
    return {
      size: [pixmap.getWidth(), pixmap.getHeight()],
      red: boxOf((r, g, b) => r > 200 && g < 60 && b < 60),
      blue: boxOf((r, g, b) => b > 200 && r < 60 && g < 60),
    };
  } finally {
    doc.destroy();
  }
}

/** The stamps as the file stores them. */
async function stamps(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const annots = resolved(doc.findPage(0).get('Annots'));
    return Array.from({ length: annots?.length ?? 0 }, (_value, index) => {
      const dict = resolved(annots?.get(index));
      return {
        subtype: readName(dict?.get('Subtype')),
        name: readName(dict?.get('Name')),
        rect: readNumbers(dict?.get('Rect')),
        flags: dict?.get('F').asNumber(),
        nm: dict?.get('NM').asString(),
        contents: dict?.get('Contents').asString(),
      };
    });
  } finally {
    doc.destroy();
  }
}

describe('addImageStamp', () => {
  it('puts the picture on the page at the asked rectangle, upright, as a printable stamp', async () => {
    const out = await addImageStamp(await blank(), request(), run);
    expect(out.annotationId).toMatch(/^\d+R$/);
    const [stamp] = await stamps(out.bytes);
    // App space is top-left, y down: centre (100,150) of a 300 pt page, 60×40 → PDF y 130..170.
    expect(stamp).toMatchObject({
      subtype: 'Stamp',
      name: 'SsSignature',
      rect: [70, 130, 130, 170],
      flags: 4,
    });
    // The marker names the stamp; `/Contents` is the label a reader shows, nothing else.
    expect(stamp?.nm).toBe('pdf-editor-ann:stamp-1');
    expect(stamp?.contents).toBe('Signature');
    const shown = await render(out.bytes);
    // The 20×10 picture is scaled to 60×40 (stretched to the box): red on the left half, blue on the right.
    expect(shown.red).toEqual([70, 130, 99, 169]);
    expect(shown.blue).toEqual([100, 130, 129, 169]);
  });

  it('keeps the picture upright and left-to-right on a page turned a quarter', async () => {
    const out = await addImageStamp(await blank(90), request({ center: { x: 50, y: 100 } }), run);
    const [stamp] = await stamps(out.bytes);
    // The box is turned in page space: the extents swap (40 wide, 60 tall in the file).
    expect(stamp?.rect).toEqual([30, 170, 70, 230]);
    const shown = await render(out.bytes);
    expect(shown.size).toEqual([300, 200]);
    // Shown 60 wide and 40 tall at the displayed point (300 - 100, 50), red still left of blue.
    expect(shown.red).toEqual([170, 30, 199, 69]);
    expect(shown.blue).toEqual([200, 30, 229, 69]);
  });

  it('refuses a file that is not PNG or JPEG, a stamp too small to see, and a missing page', async () => {
    const page = await blank();
    await expect(
      addImageStamp(page, request({ image: new TextEncoder().encode('GIF89a....') }), run),
    ).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    await expect(addImageStamp(page, request({ width: 3 }), run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
    await expect(addImageStamp(page, request({ height: Number.NaN }), run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
    await expect(addImageStamp(page, request({ pageIndex: 4 }), run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
  });
});

describe('resizeImageStamp', () => {
  it('changes only the rectangle: the picture is drawn at the new box, nothing re-encoded', async () => {
    const placed = await addImageStamp(await blank(), request(), run);
    const out = await resizeImageStamp(
      placed.bytes,
      { pageIndex: 0, id: placed.annotationId, rect: [20, 40, 100, 80] },
      run,
    );
    const [stamp] = await stamps(out.bytes);
    expect(stamp?.rect).toEqual([20, 220, 100, 260]);
    const shown = await render(out.bytes);
    expect(shown.red).toEqual([20, 40, 59, 79]);
    expect(shown.blue).toEqual([60, 40, 99, 79]);
    // Corners given the other way round are the same box.
    const flipped = await resizeImageStamp(
      placed.bytes,
      { pageIndex: 0, id: placed.annotationId, rect: [100, 80, 20, 40] },
      run,
    );
    expect((await stamps(flipped.bytes))[0]?.rect).toEqual([20, 220, 100, 260]);
  });

  it('refuses a stamp that is not there, one that is not a stamp, and a box that is too small', async () => {
    const placed = await addImageStamp(await blank(), request(), run);
    const rect = [20, 40, 100, 80] as const;
    await expect(
      resizeImageStamp(placed.bytes, { pageIndex: 0, id: '9999R', rect }, run),
    ).rejects.toMatchObject({
      code: 'selection-empty',
    });
    await expect(
      resizeImageStamp(placed.bytes, { pageIndex: 0, id: placed.annotationId, rect: [20, 40, 22, 80] }, run),
    ).rejects.toMatchObject({ code: 'range-invalid' });

    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, placed.bytes);
    const square = doc.loadPage(0).createAnnotation('Square');
    square.setRect([10, 10, 50, 50]);
    const squareId = `${square.getObject().asIndirect()}R`;
    const withSquare = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    await expect(
      resizeImageStamp(withSquare, { pageIndex: 0, id: squareId, rect }, run),
    ).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
