// @vitest-environment happy-dom
/**
 * The flatten-XFA dialog end to end: the real XFA form, pdf.js laying it out, the page pictures
 * and the PDF built from them. As in `xfa-raster.dom.test.ts`, only the browser's picture
 * drawing is replaced (an image that loads, a canvas that encodes a PNG); the form, the
 * rasteriser's own code and the produced file are real.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationProgress } from '../../../pdf-core/src/ops/types';
import { pageSizesOf, pageTextsOf, pngBytes, runContext, runDialog } from '../pdf-fixtures';
import { pureXfaPdf } from '../xfa-pure.fixtures';
import { xfaFlattenDialog } from './xfa';

// happy-dom replaces `URL`, so the workspace is found from the working directory (the repository root).
const coreRequire = createRequire(join(process.cwd(), 'packages', 'pdf-core', 'package.json'));
const fontsDir = `${coreRequire
  .resolve('pdfjs-dist/package.json')
  .replaceAll('\\', '/')
  .replace(/package\.json$/, '')}standard_fonts/`;

const widths: number[] = [];

beforeEach(async () => {
  widths.length = 0;
  const png = await pngBytes(8, 8);
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(readFileSync(`${fontsDir}${String(url).slice(String(url).lastIndexOf('/') + 1)}`)),
  );
  vi.stubGlobal(
    'Image',
    class {
      decoding = '';
      onload: (() => void) | null = null;
      set src(_url: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    fillStyle: '',
    fillRect: () => undefined,
    drawImage: () => undefined,
  })) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    done: BlobCallback,
  ) {
    widths.push(this.width);
    done(new Blob([png as BlobPart], { type: 'image/png' }));
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('xfaFlattenDialog on a dynamic form', () => {
  it('turns the form into a PDF of page pictures named after the file, reporting progress and the page count', async () => {
    const progress: OperationProgress[] = [];
    const context = await runContext(await pureXfaPdf(), {
      name: 'form.pdf',
      onProgress: (event) => progress.push(event),
      pageCount: 1,
    });
    const result = await xfaFlattenDialog.run({ scale: '3' }, context);
    expect(result.files[0]).toMatchObject({ name: 'form-flat.pdf', mime: 'application/pdf' });
    expect(result.noticeKey).toBe('xfa.flatten.done');
    expect(result.noticeParams).toEqual({ count: 1 });
    // The chosen 3 pixels per point: an A4 page 595 points wide is 1785 pixels.
    expect(widths).toEqual([1785]);
    expect(await pageSizesOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([[595, 841]]);
    expect(await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array())).toHaveLength(1);
    const flatten = progress.filter((event) => event.phase === 'xfa.flatten');
    expect(flatten[0]).toEqual({
      phase: 'xfa.flatten',
      labelKey: 'op.progress.xfa.flatten',
      done: 0,
      total: 1,
    });
    expect(flatten.at(-1)).toEqual({
      phase: 'xfa.flatten',
      labelKey: 'op.progress.xfa.flatten',
      done: 1,
      total: 1,
    });
  });

  it('draws at two pixels per point when the resolution is not a positive number, and keeps a name without .pdf', async () => {
    for (const scale of [undefined, 'abc', '0', '-3']) {
      widths.length = 0;
      const result = await xfaFlattenDialog.run(
        scale === undefined ? {} : { scale },
        await runContext(await pureXfaPdf(), { name: 'FORM.PDF', pageCount: 1 }),
      );
      expect(widths).toEqual([1190]);
      expect(result.files[0]?.name).toBe('FORM-flat.pdf');
    }
    const plain = await runDialog(xfaFlattenDialog, {}, await pureXfaPdf(), { name: 'form' });
    expect(plain.files[0]?.name).toBe('form-flat.pdf');
  });

  it('refuses a form pdf.js does not lay out itself, as a static one', async () => {
    const run = xfaFlattenDialog.run(
      {},
      await runContext(await pureXfaPdf({ needsRendering: false }), { pageCount: 1 }),
    );
    await expect(run).rejects.toMatchObject({ code: 'xfa-static', details: { engine: 'pdfjs' } });
    expect(widths).toEqual([]);
  });
});
