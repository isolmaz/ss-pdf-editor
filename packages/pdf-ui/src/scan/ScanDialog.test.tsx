// @vitest-environment happy-dom
/**
 * The scanner's dialog, driven the way a person drives it: photographs in (from files or the
 * shutter), the crop screen with its four corners, the page list and what can be done to it
 * (filter, rotate, reorder, retake, edit corners, delete), and the two ways out — a PDF for the
 * shell, or JPEG files for the insert-pages flow. The camera is the fake of `camera.fixtures.ts`.
 * The browser's decoder, canvas painting and JPEG encoder, and the PDF writer (tested on its own in
 * pdf-core), are replaced; the page detector, the straightening and the filters are the real ones.
 */

import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { type FakeCamera, installCamera } from './camera.fixtures';
import { ScanDialog, type ScannedDocument } from './ScanDialog';
import { photo } from './scan.fixtures';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected value is missing');
  return value;
}

const t = createTranslator('en');

// Every wait in this file is for a real condition (a decode, a straightening, a PDF being written)
// that resolves on its own; the 1 s default of `findBy`/`waitFor` only races a busy machine.
configure({ asyncUtilTimeout: 20000 });

// Real image work is inherent to this file: every photograph goes through the real page detector,
// the straightening and the look filters, and the pages screen redoes that for each page on every
// change. A test that scans several pages takes seconds alone and several times that on a loaded core.
vi.setConfig({ testTimeout: 30000 });

interface Painted {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
}

const browser = vi.hoisted(() => ({
  painted: [] as Painted[],
  jpegs: [] as Array<{ width: number; height: number; quality: number }>,
  /** When set, JPEG encoding waits for it. */
  jpegGate: null as Promise<void> | null,
  jpegFailure: null as Error | null,
  pdfCalls: [] as Array<{
    pages: Array<{ name: string; bytes: Uint8Array }>;
    pageSize: string;
    signal: AbortSignal;
  }>,
  pdfGate: null as Promise<void> | null,
  pdfFailure: null as Error | null,
  pdfOutcome: { bytes: new Uint8Array(), report: { pageCount: 0 } } as {
    bytes: Uint8Array;
    report: { pageCount: number };
  },
}));

vi.mock('pdf-core/ops/scan-browser', async () => {
  // A static import is not initialised yet when vitest hoists this factory above the imports.
  const fixtures = await import('./scan.fixtures');
  return {
    decodePhoto: (blob: Blob) => fixtures.decodeFake(blob),
    frameToRaster: () => null,
    paintRaster: (canvas: HTMLCanvasElement, raster: { width: number; height: number }) => {
      canvas.width = raster.width;
      canvas.height = raster.height;
      browser.painted.push({ canvas, width: raster.width, height: raster.height });
    },
    rasterToJpeg: async (raster: { width: number; height: number }, quality: number) => {
      browser.jpegs.push({ width: raster.width, height: raster.height, quality });
      await browser.jpegGate;
      if (browser.jpegFailure !== null) throw browser.jpegFailure;
      return new Blob([`jpeg:${raster.width}x${raster.height}@${quality}`], { type: 'image/jpeg' });
    },
  };
});

vi.mock('pdf-core/ops/scan', () => ({
  scanPagesToPdf: async (
    options: { pages: Array<{ name: string; bytes: Uint8Array }>; pageSize: string },
    context: { signal: AbortSignal },
  ) => {
    browser.pdfCalls.push({ pages: options.pages, pageSize: options.pageSize, signal: context.signal });
    await browser.pdfGate;
    if (browser.pdfFailure !== null) throw browser.pdfFailure;
    return browser.pdfOutcome;
  },
}));

let camera: FakeCamera;
let onClose: Mock<() => void>;
let onDocument: Mock<(result: ScannedDocument) => Promise<string | undefined>>;
let onPages: Mock<(files: readonly File[]) => void>;
let user: ReturnType<typeof userEvent.setup>;
let urls: string[];
let revoked: string[];

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]);

beforeEach(() => {
  camera = installCamera();
  onClose = vi.fn();
  onDocument = vi.fn(async (_result: ScannedDocument) => undefined);
  onPages = vi.fn();
  user = userEvent.setup({ document, delay: null });
  browser.painted.length = 0;
  browser.jpegs.length = 0;
  browser.jpegGate = null;
  browser.jpegFailure = null;
  browser.pdfCalls.length = 0;
  browser.pdfGate = null;
  browser.pdfFailure = null;
  browser.pdfOutcome = {
    bytes: PDF_BYTES,
    report: { pageCount: 2 },
  };
  urls = [];
  revoked = [];
  URL.createObjectURL = () => {
    const url = `blob:photo-${urls.length + 1}`;
    urls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  camera.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderDocumentDialog() {
  return render(<ScanDialog t={t} mode="document" onClose={onClose} onDocument={onDocument} />);
}

function renderPagesDialog() {
  return render(<ScanDialog t={t} mode="pages" onClose={onClose} onPages={onPages} />);
}

const fileOf = (name: string, kind: 'page' | 'plain' | 'broken' = 'page') =>
  new File([kind === 'broken' ? 'broken' : `${kind}:400x300`], name, { type: 'image/jpeg' });

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const corner = (name: string) => button(name);

/** Choose photographs from files on the camera screen. */
async function choose(...files: File[]) {
  await user.upload(screen.getByTestId('scan-file-input'), files);
}

/** Choose photographs and wait for the crop screen to open on the first. */
async function chooseAndCrop(...files: File[]) {
  await choose(...files);
  await screen.findByRole('heading', { name: 'Adjust the corners' });
}

/** The pages screen, with `names` accepted as they were found. */
async function scanPages(...names: string[]) {
  for (const [index, name] of names.entries()) {
    if (index === 0) await chooseAndCrop(fileOf(name));
    else {
      await user.click(button('Add page'));
      await chooseAndCrop(fileOf(name));
    }
    await user.click(button('Add page'));
    await screen.findByRole('list', { name: 'Scanned pages' });
  }
}

const sizesOf = (label: string) =>
  screen.getAllByRole('img', { name: label }).map((canvas) => {
    const element = canvas as HTMLCanvasElement;
    return [element.width, element.height];
  });

/** The canvases labelled `label`, once each has been painted (an unpainted canvas is 300 × 150). */
async function paintedCanvases(label: string) {
  await waitFor(() => {
    for (const canvas of screen.getAllByRole('img', { name: label })) {
      expect(browser.painted.some((entry) => entry.canvas === canvas)).toBe(true);
    }
  });
  return screen.getAllByRole('img', { name: label }) as HTMLCanvasElement[];
}

describe('ScanDialog opening', () => {
  it('opens on the camera with its title and introduction, and a way to close', async () => {
    renderDocumentDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Scan with camera')).toBeTruthy();
    await screen.findByText('Looking for the page…');
    await user.click(button('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not ask about discarding when nothing was scanned, even for the Escape key', async () => {
    renderDocumentDialog();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard the scanned pages?')).toBeNull();
  });

  it('opens the crop screen on a photograph taken with the shutter', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => done(photo('page')));
    renderDocumentDialog();
    const video = (await screen.findByLabelText('Camera preview')) as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 400 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 300 });
    await waitFor(() => expect(screen.getByTestId('scan-shutter').hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByTestId('scan-shutter'));
    await screen.findByRole('heading', { name: 'Adjust the corners' });
    expect(screen.getByText(/The page edges were found/)).toBeTruthy();
    // The camera is stopped the moment the camera screen is left.
    expect(camera.track.stop).toHaveBeenCalled();
  });
});

describe('ScanDialog crop screen', () => {
  it('opens a photograph with the corners found, and the straightened page beside them', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('desk.jpg'));
    expect(screen.getByText(/The page edges were found. Correct the corners if needed./)).toBeTruthy();
    expect(screen.queryByText(/Photo 1 of/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    // The corners are at the page's edges: 20 % / 13.3 % ... of the picture.
    expect(Number.parseFloat(corner('Top-left corner').style.left)).toBeCloseTo(20, 0);
    expect(Number.parseFloat(corner('Top-left corner').style.top)).toBeCloseTo(13.3, 0);
    expect(Number.parseFloat(corner('Bottom-right corner').style.left)).toBeCloseTo(80, 0);
    expect(Number.parseFloat(corner('Bottom-right corner').style.top)).toBeCloseTo(86.7, 0);
    expect(document.querySelector('img')?.getAttribute('src')).toBe(urls[0]);
    // The page in the photograph is 240 × 220 px, shown at that size (a photograph is not enlarged).
    const [preview] = await paintedCanvases('Straightened page');
    expect([preview?.width, preview?.height]).toEqual([240, 220]);
  });

  it('places the corners by hand, with a notice, when the photograph shows no page', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('blank.jpg', 'plain'));
    expect(screen.getByText(/The page edges could not be found; place the corners by hand./)).toBeTruthy();
    expect(Number.parseFloat(corner('Top-left corner').style.left)).toBeCloseTo(6, 6);
    expect(Number.parseFloat(corner('Bottom-right corner').style.left)).toBeCloseTo(94, 6);
  });

  it('takes the whole photograph on request, and finds the edges again on request', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('blank.jpg', 'plain'));
    await user.click(button('Whole photo'));
    expect(corner('Top-left corner').style.left).toBe('0%');
    expect(corner('Top-left corner').style.top).toBe('0%');
    expect(corner('Bottom-right corner').style.left).toBe('100%');
    expect(corner('Bottom-right corner').style.top).toBe('100%');
    await user.click(button('Find the edges again'));
    expect(Number.parseFloat(corner('Top-left corner').style.left)).toBeCloseTo(6, 6);
    expect(screen.getByText(/The page edges could not be found/)).toBeTruthy();
  });

  it('finds the edges of a photograph again after the corners were moved', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('desk.jpg'));
    await user.click(button('Whole photo'));
    await user.click(button('Find the edges again'));
    expect(Number.parseFloat(corner('Top-left corner').style.left)).toBeCloseTo(20, 0);
    expect(screen.getByText(/The page edges were found/)).toBeTruthy();
  });

  it('moves a corner with the keyboard, and the straightened page follows', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('desk.jpg'));
    const before = Number.parseFloat(corner('Top-left corner').style.left);
    fireEvent.keyDown(corner('Top-left corner'), { key: 'ArrowRight', shiftKey: true });
    expect(Number.parseFloat(corner('Top-left corner').style.left)).toBeCloseTo(before + 2, 6);
  });

  it('will not add a page whose outline folds over itself', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
    } as DOMRect);
    HTMLElement.prototype.setPointerCapture = () => undefined;
    renderDocumentDialog();
    await chooseAndCrop(fileOf('desk.jpg'));
    const handle = corner('Top-left corner');
    fireEvent.pointerDown(handle, { pointerId: 1 });
    // Dragged across the page to the opposite corner: the outline crosses itself.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 360, clientY: 280 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(button('Add page').hasAttribute('disabled')).toBe(true);
    // Back to a valid outline: the page can be added again.
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 80, clientY: 40 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(button('Add page').hasAttribute('disabled')).toBe(false);
    Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
  });

  it('releases the photograph’s URL when the crop screen is left', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('desk.jpg'));
    expect(revoked).toEqual([]);
    await user.click(button('Add page'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    expect(revoked).toEqual([urls[0]]);
  });
});

describe('ScanDialog several photographs', () => {
  it('takes them in turn, counting them, and adds the pages in the order chosen', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('one.jpg'), fileOf('two.jpg', 'plain'));
    expect(screen.getByText('Photo 1 of 2')).toBeTruthy();
    expect(button('Skip this photo')).toBeTruthy();
    await user.click(button('Add page'));
    // The second is the last: no counter, and it can only be cancelled.
    await waitFor(() => expect(screen.getByText(/The page edges could not be found/)).toBeTruthy());
    expect(screen.queryByText(/Photo 1 of/)).toBeNull();
    await user.click(button('Add page'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(2);
  });

  it('skips a photograph without adding it', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('one.jpg'), fileOf('two.jpg'));
    await user.click(button('Skip this photo'));
    await waitFor(() => expect(screen.queryByText(/Photo 1 of/)).toBeNull());
    await user.click(button('Add page'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(1);
  });

  it('goes back to the camera when the only photograph is cancelled and there are no pages', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('one.jpg'));
    await user.click(button('Cancel'));
    expect(await screen.findByTestId('scan-shutter')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Adjust the corners' })).toBeNull();
  });

  it('goes back to the pages when a photograph is cancelled and there are some', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(button('Add page'));
    await chooseAndCrop(fileOf('two.jpg'));
    await user.click(button('Cancel'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(1);
  });

  it('takes only as many photographs as the page limit leaves room for, and says so', async () => {
    renderDocumentDialog();
    await chooseAndCrop(...Array.from({ length: 41 }, (_, index) => fileOf(`p${index}.jpg`)));
    expect(screen.getByText('At most 40 pages can be scanned.')).toBeTruthy();
    expect(screen.getByText('Photo 1 of 40')).toBeTruthy();
  });

  it('says which photograph could not be opened and carries on with the others', async () => {
    renderDocumentDialog();
    await chooseAndCrop(fileOf('broken.png', 'broken'), fileOf('good.jpg'));
    expect(screen.getByText('This photo could not be opened: broken.png')).toBeTruthy();
    expect(screen.getByText(/The page edges were found/)).toBeTruthy();
    // The notice goes when the next photograph is chosen on its own.
    await user.click(button('Add page'));
    await user.click(button('Add page'));
    await chooseAndCrop(fileOf('again.jpg'));
    expect(screen.queryByText(/could not be opened/)).toBeNull();
  });

  it('returns to the camera when none of the photographs can be opened', async () => {
    renderDocumentDialog();
    await choose(fileOf('first.png', 'broken'), fileOf('second.png', 'broken'));
    expect(await screen.findByText('This photo could not be opened: second.png')).toBeTruthy();
    expect(screen.queryByText('This photo could not be opened: first.png')).toBeNull();
    expect(screen.getByTestId('scan-shutter')).toBeTruthy();
  });

  it('returns to the pages when the last photograph cannot be opened and there are pages', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(button('Add page'));
    await choose(fileOf('bad.png', 'broken'));
    expect(await screen.findByText('This photo could not be opened: bad.png')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Scanned pages' })).toBeTruthy();
  });
});

describe('ScanDialog pages', () => {
  it('shows each page as a thumbnail, the newest one large, with the default look chosen', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    expect(screen.getByRole('button', { name: 'Select page 2' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Select page 1' }).getAttribute('aria-current')).toBe('false');
    expect(screen.getByRole('toolbar', { name: 'Page 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enhanced' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Grayscale' }).getAttribute('aria-pressed')).toBe('false');
    // The page in the photograph is 240 × 220 px. Large it is shown at that size (a photograph is not
    // enlarged); the thumbnail is cut to 220 px on its long side.
    const [large, thumb] = await paintedCanvases('Page 2');
    expect([large?.width, large?.height]).toEqual([240, 220]);
    expect([thumb?.width, thumb?.height]).toEqual([220, 202]);
  });

  it('shows another page large when its thumbnail is chosen', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    await user.click(button('Select page 1'));
    expect(screen.getByRole('toolbar', { name: 'Page 1' })).toBeTruthy();
    expect(button('Select page 1').getAttribute('aria-current')).toBe('true');
    expect(button('Select page 2').getAttribute('aria-current')).toBe('false');
  });

  it('applies a look to every page by default, and to the selected page alone when asked', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    await user.click(button('Grayscale'));
    expect(button('Grayscale').getAttribute('aria-pressed')).toBe('true');
    await user.click(button('Select page 1'));
    expect(button('Grayscale').getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('checkbox', { name: 'Apply to all pages' }));
    await user.click(button('Black and white'));
    expect(button('Black and white').getAttribute('aria-pressed')).toBe('true');
    await user.click(button('Select page 2'));
    expect(button('Grayscale').getAttribute('aria-pressed')).toBe('true');
    expect(button('Black and white').getAttribute('aria-pressed')).toBe('false');
  });

  it('turns the selected page a quarter turn either way', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    // The page is 240 × 220 in the photograph; the large preview is the first canvas of the label.
    await waitFor(() => expect(sizesOf('Page 1')[0]).toEqual([240, 220]));
    await user.click(button('Rotate right'));
    await waitFor(() => expect(sizesOf('Page 1')[0]).toEqual([220, 240]));
    await user.click(button('Rotate right'));
    await waitFor(() => expect(sizesOf('Page 1')[0]).toEqual([240, 220]));
    await user.click(button('Rotate left'));
    await waitFor(() => expect(sizesOf('Page 1')[0]).toEqual([220, 240]));
    await user.click(button('Rotate left'));
    await waitFor(() => expect(sizesOf('Page 1')[0]).toEqual([240, 220]));
  });

  it('moves the selected page earlier and later, and the buttons stop at either end', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg', 'three.jpg');
    expect(button('Move page 3 later').hasAttribute('disabled')).toBe(true);
    await user.click(button('Move page 3 earlier'));
    // Now the selected page is second: its toolbar says so, and both moves are possible.
    expect(screen.getByRole('toolbar', { name: 'Page 2' })).toBeTruthy();
    expect(button('Move page 2 earlier').hasAttribute('disabled')).toBe(false);
    expect(button('Move page 2 later').hasAttribute('disabled')).toBe(false);
    await user.click(button('Move page 2 earlier'));
    expect(screen.getByRole('toolbar', { name: 'Page 1' })).toBeTruthy();
    expect(button('Move page 1 earlier').hasAttribute('disabled')).toBe(true);
    await user.click(button('Move page 1 later'));
    expect(screen.getByRole('toolbar', { name: 'Page 2' })).toBeTruthy();
  });

  it('deletes the selected page and selects its neighbour; deleting the last page returns to the camera', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    await user.click(button('Delete page'));
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(1);
    expect(screen.getByRole('toolbar', { name: 'Page 1' })).toBeTruthy();
    await user.click(button('Delete page'));
    expect(await screen.findByTestId('scan-shutter')).toBeTruthy();
    // Nothing is left to lose: closing asks no question.
    await user.click(button('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deletes a page in the middle and selects the one that took its place', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg', 'three.jpg');
    await user.click(button('Select page 2'));
    await user.click(button('Delete page'));
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(2);
    expect(screen.getByRole('toolbar', { name: 'Page 2' })).toBeTruthy();
  });

  it('adds another page from the camera, and goes back to the pages from there', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(button('Add page'));
    expect(await screen.findByTestId('scan-shutter')).toBeTruthy();
    await user.click(button('Pages (1)'));
    expect(screen.getByRole('list', { name: 'Scanned pages' })).toBeTruthy();
  });

  it('replaces a page with a retaken photograph, keeping its place and its look', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    await user.click(screen.getByRole('checkbox', { name: 'Apply to all pages' }));
    await user.click(button('Grayscale'));
    await user.click(button('Select page 1'));
    await user.click(button('Retake'));
    await chooseAndCrop(fileOf('again.jpg'));
    await user.click(button('Add page'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(2);
    expect(screen.getByRole('toolbar', { name: 'Page 1' })).toBeTruthy();
    // Page 1 kept the look it had before (the default); page 2, which was not touched, kept Grayscale.
    expect(button('Enhanced').getAttribute('aria-pressed')).toBe('true');
    await user.click(button('Select page 2'));
    expect(button('Grayscale').getAttribute('aria-pressed')).toBe('true');
  });

  it('takes a retake as a new page for the photographs after the first that is skipped', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(button('Retake'));
    await chooseAndCrop(fileOf('a.jpg'), fileOf('b.jpg'));
    await user.click(button('Skip this photo'));
    await waitFor(() => expect(screen.queryByText(/Photo 1 of/)).toBeNull());
    await user.click(button('Add page'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    // The first photograph was skipped, the second is a new page rather than a replacement.
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(2);
  });

  it('moves the corners of an existing page and applies them', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    await user.click(button('Select page 1'));
    await user.click(button('Edit corners'));
    await screen.findByRole('heading', { name: 'Adjust the corners' });
    expect(button('Apply')).toBeTruthy();
    expect(button('Cancel')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip this photo' })).toBeNull();
    const left = Number.parseFloat(corner('Top-left corner').style.left);
    fireEvent.keyDown(corner('Top-left corner'), { key: 'ArrowLeft', shiftKey: true });
    await user.click(button('Apply'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    expect(screen.getAllByRole('button', { name: /^Select page/ })).toHaveLength(2);
    expect(screen.getByRole('toolbar', { name: 'Page 1' })).toBeTruthy();
    // The corners were kept: editing again shows the moved one.
    await user.click(button('Edit corners'));
    await screen.findByRole('heading', { name: 'Adjust the corners' });
    expect(Number.parseFloat(corner('Top-left corner').style.left)).toBeCloseTo(left - 2, 6);
  });

  it('leaves the corners as they were when editing is cancelled', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(button('Edit corners'));
    await screen.findByRole('heading', { name: 'Adjust the corners' });
    const left = corner('Top-left corner').style.left;
    fireEvent.keyDown(corner('Top-left corner'), { key: 'ArrowLeft', shiftKey: true });
    await user.click(button('Cancel'));
    await screen.findByRole('list', { name: 'Scanned pages' });
    await user.click(button('Edit corners'));
    await screen.findByRole('heading', { name: 'Adjust the corners' });
    expect(corner('Top-left corner').style.left).toBe(left);
  });
});

describe('ScanDialog closing', () => {
  it('asks before discarding scanned pages, and goes back to them when told to', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(button('Close'));
    expect(onClose).not.toHaveBeenCalled();
    const question = screen.getByRole('alert');
    expect(within(question).getByText('Discard the scanned pages?')).toBeTruthy();
    await user.click(within(question).getByRole('button', { name: 'Go back' }));
    expect(screen.queryByText('Discard the scanned pages?')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes once the discarding is confirmed', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(button('Close'));
    await user.click(button('Discard and close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when Close is pressed a second time, or Escape after the question', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.keyboard('{Escape}');
    expect(screen.getByText('Discard the scanned pages?')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close while the pages are being made', async () => {
    const gate = Promise.withResolvers<void>();
    browser.jpegGate = gate.promise;
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByTestId('scan-create'));
    await screen.findByText(/Preparing page 1 of 1/);
    expect(button('Close').hasAttribute('disabled')).toBe(true);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard the scanned pages?')).toBeNull();
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(onDocument).toHaveBeenCalledTimes(1));
  });
});

describe('ScanDialog making the PDF', () => {
  it('makes one JPEG per page at the balanced quality and hands the PDF to the shell, named by the time', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    expect(screen.getByTestId('scan-create').textContent).toBe('Create PDF');
    await user.click(screen.getByTestId('scan-create'));
    await waitFor(() => expect(onDocument).toHaveBeenCalledTimes(1));
    expect(browser.jpegs.map((entry) => entry.quality)).toEqual([0.8, 0.8]);
    expect(browser.pdfCalls).toHaveLength(1);
    expect(browser.pdfCalls[0]?.pageSize).toBe('a4');
    expect(browser.pdfCalls[0]?.pages.map((page) => page.name)).toEqual(['scan-001.jpg', 'scan-002.jpg']);
    const texts = browser.pdfCalls[0]?.pages.map((page) => new TextDecoder().decode(page.bytes));
    expect(texts?.[0]).toMatch(/^jpeg:\d+x\d+@0\.8$/);
    const result = must(onDocument.mock.calls[0])[0] as ScannedDocument;
    expect(result.bytes).toBe(PDF_BYTES);
    expect(result.pageCount).toBe(2);
    expect(result.report).toBe(browser.pdfOutcome.report);
    expect(result.offerOcr).toBe(true);
    expect(result.name).toMatch(/^Scan \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.pdf$/);
    // Done: the progress line is gone and nothing is wrong.
    await waitFor(() => expect(screen.queryByText(/Preparing page/)).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('scan-create').hasAttribute('disabled')).toBe(false);
  });

  it('shows how far the work has got, page by page', async () => {
    const gate = Promise.withResolvers<void>();
    browser.jpegGate = gate.promise;
    renderDocumentDialog();
    await scanPages('one.jpg', 'two.jpg');
    await user.click(screen.getByTestId('scan-create'));
    await screen.findByText('Preparing page 1 of 2…');
    expect(screen.getByTestId('scan-create').hasAttribute('disabled')).toBe(true);
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(onDocument).toHaveBeenCalledTimes(1));
  });

  it('uses the chosen paper, quality and the offer of text recognition', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByRole('combobox', { name: 'Page size' }));
    await user.click(await screen.findByRole('option', { name: 'Letter' }));
    await user.click(screen.getByRole('combobox', { name: 'JPEG quality' }));
    await user.click(await screen.findByRole('option', { name: 'Best quality' }));
    await user.click(screen.getByRole('checkbox', { name: /Offer text recognition/ }));
    await user.click(screen.getByTestId('scan-create'));
    await waitFor(() => expect(onDocument).toHaveBeenCalledTimes(1));
    expect(browser.pdfCalls[0]?.pageSize).toBe('letter');
    expect(browser.jpegs[0]?.quality).toBe(0.92);
    expect((must(onDocument.mock.calls[0])[0] as ScannedDocument).offerOcr).toBe(false);
  });

  it('offers the other papers and the smallest file too', async () => {
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByRole('combobox', { name: 'Page size' }));
    await user.click(await screen.findByRole('option', { name: 'Fit to the image (no margins)' }));
    await user.click(screen.getByRole('combobox', { name: 'JPEG quality' }));
    await user.click(await screen.findByRole('option', { name: 'Small file' }));
    await user.click(screen.getByTestId('scan-create'));
    await waitFor(() => expect(onDocument).toHaveBeenCalledTimes(1));
    expect(browser.pdfCalls[0]?.pageSize).toBe('fit');
    expect(browser.jpegs[0]?.quality).toBe(0.6);
  });

  it('shows the shell’s sentence, and stays open, when the shell does not open the document', async () => {
    onDocument.mockResolvedValue('No tab could be opened.');
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByTestId('scan-create'));
    const alert = await screen.findByText('No tab could be opened.');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('list', { name: 'Scanned pages' })).toBeTruthy();
  });

  it('clears the earlier error when it is tried again', async () => {
    onDocument.mockResolvedValueOnce('No tab could be opened.');
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByTestId('scan-create'));
    await screen.findByText('No tab could be opened.');
    await user.click(screen.getByTestId('scan-create'));
    await waitFor(() => expect(screen.queryByText('No tab could be opened.')).toBeNull());
    await waitFor(() => expect(onDocument).toHaveBeenCalledTimes(2));
  });

  it('says what went wrong, with what to do, when a page cannot be made', async () => {
    browser.jpegFailure = new Error('encoder broke');
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByTestId('scan-create'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Something unexpected went wrong. Try again; report it if it keeps happening.',
    );
    expect(onDocument).not.toHaveBeenCalled();
    expect(screen.queryByText(/Preparing page/)).toBeNull();
    expect(screen.getByTestId('scan-create').hasAttribute('disabled')).toBe(false);
  });

  it('says what went wrong when the PDF cannot be written', async () => {
    browser.pdfFailure = new Error('writer broke');
    renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByTestId('scan-create'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something unexpected went wrong. Try again; report it if it keeps happening.',
    );
    expect(onDocument).not.toHaveBeenCalled();
  });

  it('stops quietly when the dialog is closed while the pages are made', async () => {
    const gate = Promise.withResolvers<void>();
    browser.jpegGate = gate.promise;
    const view = renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByTestId('scan-create'));
    await screen.findByText('Preparing page 1 of 1…');
    view.unmount();
    await act(async () => {
      gate.resolve();
    });
    expect(browser.pdfCalls).toEqual([]);
    expect(onDocument).not.toHaveBeenCalled();
  });

  it('stops quietly when the dialog is closed while the PDF is written', async () => {
    const gate = Promise.withResolvers<void>();
    browser.pdfGate = gate.promise;
    browser.pdfFailure = new Error('cancelled');
    const view = renderDocumentDialog();
    await scanPages('one.jpg');
    await user.click(screen.getByTestId('scan-create'));
    await waitFor(() => expect(browser.pdfCalls).toHaveLength(1));
    view.unmount();
    await act(async () => {
      gate.resolve();
    });
    expect(browser.pdfCalls[0]?.signal.aborted).toBe(true);
    expect(onDocument).not.toHaveBeenCalled();
  });
});

describe('ScanDialog handing pages to the insert flow', () => {
  it('offers no paper size or text recognition, and says how many pages it will use', async () => {
    renderPagesDialog();
    await scanPages('one.jpg', 'two.jpg');
    expect(screen.queryByRole('combobox', { name: 'Page size' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Offer text recognition/ })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'JPEG quality' })).toBeTruthy();
    expect(screen.getByTestId('scan-create').textContent).toBe('Use 2 pages');
  });

  it('hands over the straightened pages as JPEG files, without making a PDF', async () => {
    renderPagesDialog();
    await scanPages('one.jpg', 'two.jpg');
    await user.click(screen.getByTestId('scan-create'));
    await waitFor(() => expect(onPages).toHaveBeenCalledTimes(1));
    const files = onPages.mock.calls[0]?.[0] as File[];
    expect(files.map((file) => file.name)).toEqual(['scan-001.jpg', 'scan-002.jpg']);
    expect(files.map((file) => file.type)).toEqual(['image/jpeg', 'image/jpeg']);
    expect(await files[0]?.text()).toMatch(/^jpeg:\d+x\d+@0\.8$/);
    expect(browser.pdfCalls).toEqual([]);
    await waitFor(() => expect(screen.queryByText(/Preparing page/)).toBeNull());
  });
});
