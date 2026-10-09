// @vitest-environment happy-dom
/**
 * Drawing a dynamic XFA form's pages as pictures. The browser has two things happy-dom lacks and
 * they are replaced at their own boundary: layout (rectangles of words and controls, supplied
 * below) and picture drawing (an `<svg>` image, a canvas that encodes a PNG). Everything else is
 * real: the XFA PDF, pdf.js laying it out and `XfaLayer` writing the HTML, the field values,
 * the style sheets and the fonts the form's SVG carries. The SVG handed to the picture is read
 * back to see what would be drawn.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { openWithPdfjs } from 'pdf-core/engines/pdfjs-handle';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pngBytes, xfaFormPdf } from '../pdf-fixtures';
import { PURE_XFA_PAGE, pureXfaPdf } from '../xfa-pure.fixtures';
import { rasterizeXfaPages } from './xfa-raster';

// happy-dom replaces `URL`, so the workspace is found from the working directory (the repository root).
const coreRequire = createRequire(join(process.cwd(), 'packages', 'pdf-core', 'package.json'));
const fontsDir = `${coreRequire
  .resolve('pdfjs-dist/package.json')
  .replaceAll('\\', '/')
  .replace(/package\.json$/, '')}standard_fonts/`;

const env = {
  fetched: [] as string[],
  failFirstFont: false,
  images: [] as string[],
  imageFails: false,
  noContext: false,
  noBlob: false,
  canvasWidths: [] as number[],
  png: new Uint8Array(),
  fills: [] as unknown[][],
  draws: [] as unknown[][],
};

/** What the browser's `Image` does with an SVG data URL: loads it, or fails on demand. */
class PictureImage {
  decoding = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(url: string) {
    env.images.push(decodeURIComponent(url.slice(url.indexOf(',') + 1)));
    queueMicrotask(() => (env.imageFails ? this.onerror?.() : this.onload?.()));
  }
}

const open = async (bytes: Uint8Array) => await openWithPdfjs(bytes, { enableXfa: true });

/**
 * The XFA tree of a page with the form's faces named the way pdf.js registers its own
 * (`…-PdfJS-XFA`), and the multi-line field holding a blank line between its two lines (pdf.js
 * drops the blank line the template wrote).
 */
function withFaces(pdf: PDFDocumentProxy, faces: readonly string[]): PDFDocumentProxy {
  return new Proxy(pdf, {
    get(target, property) {
      if (property !== 'getPage') {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (number: number) => {
        const page = await target.getPage(number);
        return new Proxy(page, {
          get(pageTarget, pageProperty) {
            if (pageProperty !== 'getXfa') {
              const value: unknown = Reflect.get(pageTarget, pageProperty, pageTarget);
              return typeof value === 'function' ? value.bind(pageTarget) : value;
            }
            return async () => {
              const tree = (await pageTarget.getXfa()) as {
                attributes?: { style?: Record<string, string> };
                children?: unknown[];
              };
              let next = 0;
              const walk = (node: typeof tree & { name?: string }) => {
                if (node.name === 'textarea' && node.attributes) {
                  // What the user typed lives in the document's annotation storage, keyed by field id.
                  const id = (node.attributes as { fieldId: string }).fieldId;
                  target.annotationStorage.setValue(id, { value: 'first line\n\nthird' });
                }
                const classes = (node.attributes as { class?: string[] } | undefined)?.class ?? [];
                if (classes.some((name) => /^xfa(Field|Draw)$/.test(name)) && node.attributes?.style) {
                  node.attributes.style.fontFamily = `"${faces[next % faces.length]}-PdfJS-XFA"`;
                  next += 1;
                }
                for (const child of node.children ?? [])
                  if (typeof child === 'object' && child !== null) walk(child as typeof tree);
              };
              walk(tree);
              return tree;
            };
          },
        });
      };
    },
  });
}

const svgOfFirstPage = () => env.images[0] ?? '';

beforeEach(async () => {
  env.fetched = [];
  env.failFirstFont = false;
  env.images = [];
  env.imageFails = false;
  env.noContext = false;
  env.noBlob = false;
  env.canvasWidths = [];
  env.fills = [];
  env.draws = [];
  env.png = new Uint8Array(await pngBytes(8, 8));

  vi.stubGlobal('fetch', async (url: string) => {
    env.fetched.push(String(url));
    if (env.failFirstFont && env.fetched.length === 1) return new Response(null, { status: 404 });
    const file = String(url).slice(String(url).lastIndexOf('/') + 1);
    return new Response(readFileSync(`${fontsDir}${file}`));
  });
  vi.stubGlobal('Image', PictureImage);
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });

  // Layout: the host sits at (100, 50); controls and words have fixed boxes.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('aria-hidden') === 'true') return new DOMRect(100, 50, 600, 850);
    if (this instanceof HTMLTextAreaElement) return new DOMRect(120, 120, 200, 60);
    return new DOMRect(120, 80, 200, 20);
  });
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const word = this.toString();
    if (word === 'wrapped')
      return [new DOMRect(150, 60, 40, 12), new DOMRect(110, 75, 40, 12)] as unknown as DOMRectList;
    if (word === 'ghost') return [new DOMRect(0, 0, 0, 0)] as unknown as DOMRectList;
    return [new DOMRect(110, 60, word.length * 6, 12)] as unknown as DOMRectList;
  });

  // No layout means no computed sizes: the sizes a control reports are empty.
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '', paddingLeft: '', borderLeftWidth: '' }));

  // The picture: a canvas that records what is drawn and encodes the PNG the test chose.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (env.noContext) return null;
    return {
      fillStyle: '',
      fillRect: (...args: unknown[]) => env.fills.push(args),
      drawImage: (...args: unknown[]) => env.draws.push(args.slice(1)),
    } as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    done: BlobCallback,
  ) {
    env.canvasWidths.push(this.width);
    done(env.noBlob ? null : new Blob([env.png as BlobPart], { type: 'image/png' }));
  } as never);

  const sheet = document.createElement('style');
  sheet.textContent = '.xfaLayer .xfaField{content:"a&b<c>d";}\n.unrelated{color:red;}';
  document.head.append(sheet);
  const blocked = document.createElement('style');
  blocked.textContent = '.xfaBlocked{color:blue;}';
  document.head.append(blocked);
  const sheets = Array.from(document.styleSheets);
  Object.defineProperty(sheets[sheets.length - 1] as CSSStyleSheet, 'cssRules', {
    get() {
      throw new DOMException('cross-origin', 'SecurityError');
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('rasterizeXfaPages', () => {
  it('draws the page of a dynamic form into a picture with the words measured from its layout', async () => {
    const handle = await open(await pureXfaPdf());
    const progress: [number, number][] = [];
    try {
      const pages = await rasterizeXfaPages(withFaces(handle.raw, ['Myriad Pro']), {
        scale: 2,
        signal: new AbortController().signal,
        onProgress: (done, total) => progress.push([done, total]),
      });
      expect(pages).toHaveLength(1);
      const [page] = pages;
      expect(page?.widthPt).toBe(PURE_XFA_PAGE.width);
      expect(page?.heightPt).toBe(PURE_XFA_PAGE.height);
      expect(page?.scale).toBe(2);
      expect(Array.from(page?.png ?? [])).toEqual(Array.from(env.png));
      expect(progress).toEqual([
        [0, 1],
        [1, 1],
      ]);
      // The picture is the page at 2 pixels per point.
      expect(env.canvasWidths).toEqual([Math.ceil(PURE_XFA_PAGE.width * 2)]);
      expect(env.fills).toEqual([
        [0, 0, Math.ceil(PURE_XFA_PAGE.width * 2), Math.ceil(PURE_XFA_PAGE.height * 2)],
      ]);
      expect(env.draws).toHaveLength(1);

      const words = page?.words ?? [];
      const textOf = (text: string) => words.filter((word) => word.text === text);
      // One rectangle per word and line, in the host's pixels; a word with no size is dropped.
      expect(textOf('Hello')).toEqual([{ text: 'Hello', x0: 10, y0: 10, x1: 40, y1: 22 }]);
      expect(textOf('wrapped')).toEqual([
        { text: 'wrapped', x0: 50, y0: 10, x1: 90, y1: 22 },
        { text: 'wrapped', x0: 10, y0: 25, x1: 50, y1: 37 },
      ]);
      expect(textOf('ghost')).toEqual([]);
      // Typed values live in controls: the text field, the multi-line field's two non-empty lines,
      // the drop-down's chosen entry (the empty drop-down has none).
      const [typed] = textOf('Ada');
      expect(typed).toMatchObject({ x0: 22, y0: 34 });
      expect(typed?.x1).toBeCloseTo(22 + 3 * 12 * 0.55, 5);
      expect(typed?.y1).toBeCloseTo(34 + 12 * 1.15, 5);
      const typedWords = words.filter((word) => word.x0 === 22);
      expect(typedWords.map((word) => word.text)).toEqual(['Ada', 'first line', 'third', 'Two']);
      expect(typedWords[1]).toMatchObject({ y0: 72 });
      expect(typedWords[2]?.y0).toBeCloseTo(120 + 2 * 12 * 1.2 + 2 - 50, 5);
    } finally {
      await handle.destroy();
    }
    expect(document.body.children).toHaveLength(0);
  });

  it('draws what the user typed: field values copied into attributes, faces mapped, chrome and foreign styles left out', async () => {
    const handle = await open(await pureXfaPdf());
    try {
      await rasterizeXfaPages(withFaces(handle.raw, ['Times New Roman', 'Courier New', 'Myriad Pro']), {
        scale: 1,
        signal: new AbortController().signal,
      });
    } finally {
      await handle.destroy();
    }
    const svg = svgOfFirstPage();
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('value="Ada"');
    expect(svg).toMatch(/<textarea[^>]*>first line\n\nthird<\/textarea>/);
    expect(svg).toMatch(/<input[^>]*type="checkbox"[^>]*checked="[^"]*"/);
    expect(svg).toMatch(/<option[^>]*selected="[^"]*"[^>]*>Two<\/option>/);
    expect(svg).not.toMatch(/<option[^>]*selected[^>]*>One<\/option>/);
    expect(svg).not.toMatch(/\srequired[=\s>]/);
    // The faces pdf.js registered are replaced by ones an image can see.
    expect(svg).not.toContain('PdfJS-XFA');
    expect(svg).toContain('Times New Roman&quot;, Times, serif');
    expect(svg).toContain('Courier New&quot;, Courier, monospace');
    expect(svg).toContain('XfaSans, Arial, Helvetica, sans-serif');
    // The embedded sans in its four weights, the layer's own rules (escaped), and nothing else.
    expect(svg.match(/@font-face\{font-family:"XfaSans"/g)).toHaveLength(4);
    expect(svg).toContain('font-weight:bold;font-style:italic');
    expect(svg).toContain('.xfaLayer .xfaField { content: "a&amp;b&lt;c&gt;d"; }</style>');
    expect(svg).not.toContain('.unrelated');
    expect(svg).not.toContain('.xfaBlocked');
  });

  it('fetches the embedded sans once, and tries again after a failed fetch', async () => {
    vi.resetModules();
    const fresh = await import('./xfa-raster');
    env.failFirstFont = true;
    const handle = await open(await pureXfaPdf());
    const signal = new AbortController().signal;
    try {
      await expect(fresh.rasterizeXfaPages(handle.raw, { scale: 1, signal })).rejects.toMatchObject({
        code: 'asset-missing',
        details: { engine: 'pdfjs', path: 'LiberationSans-Regular.ttf' },
      });
      expect(env.fetched).toHaveLength(1);
      await fresh.rasterizeXfaPages(handle.raw, { scale: 1, signal });
      expect(env.fetched).toHaveLength(5);
      await fresh.rasterizeXfaPages(handle.raw, { scale: 1, signal });
      expect(env.fetched).toHaveLength(5);
    } finally {
      await handle.destroy();
    }
  });

  it('refuses a document whose page has no XFA layout, naming the page', async () => {
    const handle = await openWithPdfjs(await xfaFormPdf('static'));
    try {
      await expect(
        rasterizeXfaPages(handle.raw, { scale: 1, signal: new AbortController().signal }),
      ).rejects.toMatchObject({
        code: 'xfa-static',
        details: { engine: 'pdfjs', engineMessage: 'page 1 has no XFA layout' },
      });
    } finally {
      await handle.destroy();
    }
    expect(document.body.children).toHaveLength(0);
  });

  it('stops as aborted when the signal is already aborted, leaving nothing in the page', async () => {
    const handle = await open(await pureXfaPdf());
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        rasterizeXfaPages(handle.raw, { scale: 1, signal: controller.signal }),
      ).rejects.toMatchObject({
        code: 'aborted',
      });
    } finally {
      await handle.destroy();
    }
    expect(document.body.children).toHaveLength(0);
  });

  it('fails when the page picture cannot be drawn, encoded, or given a canvas', async () => {
    const handle = await open(await pureXfaPdf());
    const signal = new AbortController().signal;
    try {
      env.imageFails = true;
      await expect(rasterizeXfaPages(handle.raw, { scale: 1, signal })).rejects.toThrow(
        'the page picture could not be drawn',
      );
      env.imageFails = false;
      env.noContext = true;
      await expect(rasterizeXfaPages(handle.raw, { scale: 1, signal })).rejects.toMatchObject({
        code: 'out-of-memory',
        details: { engine: 'pdfjs' },
      });
      env.noContext = false;
      env.noBlob = true;
      await expect(rasterizeXfaPages(handle.raw, { scale: 1, signal })).rejects.toMatchObject({
        code: 'out-of-memory',
        details: { engineMessage: 'toBlob failed' },
      });
    } finally {
      await handle.destroy();
    }
    expect(document.body.children).toHaveLength(0);
  });
});
