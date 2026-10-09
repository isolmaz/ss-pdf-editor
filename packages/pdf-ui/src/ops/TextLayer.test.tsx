// @vitest-environment happy-dom
/**
 * The text tool's layer: the blocks MuPDF reads from a page are drawn as boxes over the
 * page as it is laid out now, each marked with what an edit can do to it; a click hands an
 * editable block to the app, a block that cannot be edited is never handed over, and a page
 * that cannot be read says so instead of showing an empty overlay.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadMupdf } from 'pdf-core/engines/mupdf';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { displayedBox, TextLayer, type TextLayerProps } from './TextLayer';

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../public');
const fontFile = (path: string) => new Uint8Array(readFileSync(resolve(publicDir, `.${path}`)));

/** The served fonts the layer loads for its catalogue, answered from the repository's own copies. */
const serveFonts = async (input: unknown) => {
  const path = new URL(String(input)).pathname;
  return new Response(fontFile(path));
};

beforeEach(() => {
  vi.stubGlobal('fetch', serveFonts);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * One 200 × 200 pt page with three paragraphs: Helvetica (a base-14 face: editable, but the
 * font is replaced), the embedded Noto Sans the product itself ships (editable as it is), and
 * a line turned a quarter (which a write cannot reproduce).
 */
async function textPage(label = 'Plain'): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const helvetica = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  const noto = doc.addSimpleFont(
    new mupdf.Font('NotoSans', fontFile('/fonts/noto/NotoSans-Regular.ttf')),
    'Latin',
  );
  const content = [
    `BT /H 12 Tf 20 170 Td (${label}) Tj ET`,
    'BT /N 12 Tf 20 110 Td (Shipped) Tj ET',
    'BT /H 12 Tf 0 1 -1 0 160 20 Tm (Turned) Tj ET',
  ].join('\n');
  doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, { Font: { H: helvetica, N: noto } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The page drawn at 200 %, 100 px right of and 50 px below the container's origin. */
const viewerFor = (rotation: 0 | 90 | 180 | 270, onScreen = true): ViewerApi =>
  ({
    pageRect: () => (onScreen ? { x: 100, y: 50, width: 400, height: 400 } : null),
    pageGeometry: () => ({ x: 0, y: 0, width: 200, height: 200, rotation }),
    containerRect: () => ({ x: 0, y: 0, width: 1000, height: 1000 }),
  }) as unknown as ViewerApi;

function show(bytes: Uint8Array, overrides: Partial<TextLayerProps> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const props: TextLayerProps = {
    t: createTranslator('en'),
    viewer: viewerFor(0),
    bytes,
    pageIndex: 0,
    onSelect,
    onClose,
    ...overrides,
  };
  const view = render(<TextLayer {...props} />);
  return { onSelect, onClose, view, props };
}

const blocks = () => [...document.querySelectorAll<HTMLButtonElement>('[data-text-block]')];
const blockWith = (text: string) => {
  const found = blocks().find((block) => block.getAttribute('data-block-text') === text);
  if (found === undefined) throw new Error(`no block "${text}"`);
  return found;
};
const px = (value: string) => Number.parseFloat(value);
const failure = () => document.querySelector<HTMLElement>('[data-text-layer-error]');
const layer = () => document.querySelector<HTMLElement>('[data-text-layer]') as HTMLElement;

/** A fetch that holds the font files until `release`, to keep a read in flight. */
function gatedFonts() {
  let release: (status: number) => void = () => {};
  const gate = new Promise<number>((resolveGate) => {
    release = resolveGate;
  });
  vi.stubGlobal('fetch', async (input: unknown) => {
    const status = await gate;
    return status === 200 ? await serveFonts(input) : new Response('gone', { status });
  });
  return release;
}

describe('a read that is overtaken', () => {
  // These two run first: the font set is fetched once per session, so the gate only holds the
  // first read while no earlier test has loaded it (a failed load is not remembered).
  it('shows the new read’s failure, not the late failure of the read it replaced', async () => {
    const release = gatedFonts();
    const good = await textPage();
    const { view, props } = show(good);
    view.rerender(<TextLayer {...props} bytes={new TextEncoder().encode('not a pdf')} />);
    await waitFor(() => expect(failure()).not.toBeNull());
    const first = failure()?.getAttribute('data-text-layer-error');
    release(503);
    await new Promise((settle) => setTimeout(settle, 100));
    expect(failure()?.getAttribute('data-text-layer-error')).toBe(first);
    expect(failure()?.getAttribute('data-text-layer-reason')).not.toContain('font asset responded 503');
    expect(blocks()).toHaveLength(0);
  });

  it('does not paint the late result of the read it replaced over the new read’s failure', async () => {
    const release = gatedFonts();
    const good = await textPage();
    const { view, props } = show(good);
    view.rerender(<TextLayer {...props} bytes={new TextEncoder().encode('not a pdf')} />);
    await waitFor(() => expect(failure()).not.toBeNull());
    release(200);
    await new Promise((settle) => setTimeout(settle, 300));
    expect(failure()).not.toBeNull();
    expect(blocks()).toHaveLength(0);
  });
});

describe('TextLayer', () => {
  it('is busy while the page is read, then draws one box per paragraph over the page at its zoom', async () => {
    show(await textPage());
    expect(layer().getAttribute('aria-busy')).toBe('true');
    await waitFor(() => expect(blocks()).toHaveLength(3));
    expect(layer().getAttribute('aria-busy')).toBe('false');
    for (const block of blocks()) {
      const [x0, y0, x1, y1] = JSON.parse(block.getAttribute('data-block-rect') ?? '[]') as number[];
      // 200 % of the page, from the page's own top-left corner at (100, 50).
      expect(px(block.style.left)).toBeCloseTo(100 + (x0 as number) * 2, 3);
      expect(px(block.style.top)).toBeCloseTo(50 + (y0 as number) * 2, 3);
      expect(px(block.style.width)).toBeCloseTo(Math.max(1, ((x1 as number) - (x0 as number)) * 2), 3);
      expect(px(block.style.height)).toBeCloseTo(Math.max(1, ((y1 as number) - (y0 as number)) * 2), 3);
    }
  });

  it('says what an edit can do to each paragraph, in the words of the dictionary', async () => {
    show(await textPage());
    await waitFor(() => expect(blocks()).toHaveLength(3));
    const plain = blockWith('Plain');
    expect(plain.getAttribute('data-editability')).toBe('substituted');
    expect(plain.title).toBe('Standard font — editable, font replaced and embedded');
    expect(plain.getAttribute('aria-label')).toBe(
      'Plain — Standard font — editable, font replaced and embedded',
    );
    const shipped = blockWith('Shipped');
    expect(shipped.getAttribute('data-editability')).toBe('editable');
    expect(shipped.title).toBe('Editable');
    const turned = blockWith('Turned');
    expect(turned.getAttribute('data-editability')).toBe('not-editable');
    expect(turned.title).toBe('Rotated text — cannot edit');
  });

  it('hands an editable paragraph to the app, with its page, model and verdict', async () => {
    const { onSelect } = show(await textPage(), { pageIndex: 0 });
    await waitFor(() => expect(blocks()).toHaveLength(3));
    await userEvent.click(blockWith('Plain'));
    expect(onSelect).toHaveBeenCalledOnce();
    const selection = onSelect.mock.calls[0]?.[0];
    expect(selection).toMatchObject({
      pageIndex: 0,
      editable: true,
      substitutionRequired: true,
      reasonKey: 'textedit.reason.standard-font',
    });
    expect(selection.block.text).toBe('Plain');
    expect(selection.model.blocks).toHaveLength(3);
    expect(Object.keys(selection.fonts.metrics).sort()).toEqual(['noto-sans', 'noto-sans-semibold']);

    onSelect.mockClear();
    await userEvent.click(blockWith('Shipped'));
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ editable: true, substitutionRequired: false });
  });

  it('never hands over a paragraph that cannot be edited', async () => {
    const { onSelect } = show(await textPage());
    await waitFor(() => expect(blocks()).toHaveLength(3));
    await userEvent.click(blockWith('Turned'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the page’s own focus: pressing a box does not take it', async () => {
    show(await textPage());
    await waitFor(() => expect(blocks()).toHaveLength(3));
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    blockWith('Plain').dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('places the boxes of a page shown turned a quarter by turning each box the same way', async () => {
    show(await textPage(), { viewer: viewerFor(90) });
    await waitFor(() => expect(blocks()).toHaveLength(3));
    const [x0, y0, x1, y1] = JSON.parse(
      blockWith('Plain').getAttribute('data-block-rect') ?? '[]',
    ) as number[];
    // A 90° turn: u = 200 − y, v = x; 400 px for 200 pt across.
    const box = blockWith('Plain').style;
    expect(px(box.left)).toBeCloseTo(100 + (200 - (y1 as number)) * 2, 3);
    expect(px(box.top)).toBeCloseTo(50 + (x0 as number) * 2, 3);
    expect(px(box.width)).toBeCloseTo(((y1 as number) - (y0 as number)) * 2, 3);
    expect(px(box.height)).toBeCloseTo(((x1 as number) - (x0 as number)) * 2, 3);
  });

  it('draws no box for a page the viewer has not put on screen', async () => {
    show(await textPage(), { viewer: viewerFor(0, false) });
    await waitFor(() => expect(layer().getAttribute('aria-busy')).toBe('false'));
    expect(blocks()).toHaveLength(0);
  });

  it('reads the page it is given: the next page, not the first', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const helvetica = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
    for (const word of ['First', 'Second']) {
      doc.insertPage(
        -1,
        doc.addPage([0, 0, 200, 200], 0, { Font: { H: helvetica } }, `BT /H 12 Tf 20 100 Td (${word}) Tj ET`),
      );
    }
    const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();
    const { view, props } = show(bytes, { pageIndex: 0 });
    await waitFor(() =>
      expect(blocks().map((block) => block.getAttribute('data-block-text'))).toEqual(['First']),
    );
    view.rerender(<TextLayer {...props} pageIndex={1} />);
    await waitFor(() =>
      expect(blocks().map((block) => block.getAttribute('data-block-text'))).toEqual(['Second']),
    );
  });

  it('says so, in the dictionary’s words, when the page cannot be read, and keeps the engine’s words as a diagnostic', async () => {
    show(new TextEncoder().encode('not a pdf'));
    await waitFor(() => expect(failure()).not.toBeNull());
    expect(failure()?.textContent).toBe('Could not extract text for this page; editing disabled.');
    expect(failure()?.getAttribute('data-text-layer-error')).toBe('corrupt-document');
    expect(failure()?.getAttribute('data-text-layer-reason')).toContain('mupdf');
    expect(failure()?.title).toBe(failure()?.getAttribute('data-text-layer-reason'));
    expect(layer().getAttribute('aria-busy')).toBe('false');
    expect(blocks()).toHaveLength(0);
  });

  it('clears an earlier failure once a page reads', async () => {
    const { view, props } = show(new TextEncoder().encode('not a pdf'));
    await waitFor(() => expect(failure()).not.toBeNull());
    view.rerender(<TextLayer {...props} bytes={await textPage()} />);
    await waitFor(() => expect(blocks()).toHaveLength(3));
    expect(failure()).toBeNull();
  });

  it('closes on Escape and on no other key', async () => {
    const { onClose } = show(await textPage());
    const user = userEvent.setup();
    await user.keyboard('a{Enter}');
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stops listening for Escape once it is removed', async () => {
    const { onClose, view } = show(await textPage());
    view.unmount();
    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('displayedBox', () => {
  const box = { x: 10, y: 20, width: 200, height: 100 };
  const rect = [30, 40, 70, 60] as const;

  it.each([
    [0, [20, 20, 60, 40]],
    [90, [60, 20, 80, 60]],
    [180, [140, 60, 180, 80]],
    [270, [20, 140, 40, 180]],
  ] as const)('turns a block by %i° against the unrotated page box', (rotation, expected) => {
    expect(displayedBox(rect, box, rotation)).toEqual(expected);
  });

  it('reads a turn that is not a quarter as no turn', () => {
    expect(displayedBox(rect, box, 45)).toEqual([20, 20, 60, 40]);
  });
});
