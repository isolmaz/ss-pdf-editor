/**
 * Draw a dynamic XFA form's pages as pictures, in the browser.
 *
 * pdf.js lays an XFA template out as **HTML** (`page.getXfa()`, drawn by `XfaLayer`), not
 * as PDF operators, so there is no canvas render to take. This file does what a print
 * preview does with that HTML: it renders each page into an off-screen element, lets the
 * browser lay it out, and rasterises it through an SVG `foreignObject` — the same CSS the
 * viewer used (`pdf_viewer.css`), the field values the user typed (read from the
 * document's annotation storage, which is where `XfaLayer` keeps them), and the form's
 * fonts. The words are measured from the live layout (`Range` rectangles) so the
 * flattened PDF gets an invisible text layer that lines up with the picture.
 *
 * Fonts: the form's fonts are `…-PdfJS-XFA` faces pdf.js registers on the page's
 * `document.fonts`; an SVG image cannot see them. The sans faces come from pdf.js's own
 * standard-font data (Liberation Sans, served from this origin) embedded in the image; any
 * other family falls back to the system's serif/monospace/sans face. The report says so.
 */

import { PDFJS_ASSETS } from 'pdf-core/assets';
import type { XfaRasterPage, XfaRasterWord } from 'pdf-core/ops/xfa-flatten';
import { ToolError } from 'pdf-shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

const FACE_FILES = [
  { file: 'LiberationSans-Regular.ttf', weight: 'normal', style: 'normal' },
  { file: 'LiberationSans-Bold.ttf', weight: 'bold', style: 'normal' },
  { file: 'LiberationSans-Italic.ttf', weight: 'normal', style: 'italic' },
  { file: 'LiberationSans-BoldItalic.ttf', weight: 'bold', style: 'italic' },
] as const;

/** The embedded sans, as `@font-face` rules over data URLs; fetched once. */
let fontCss: Promise<string> | null = null;

function embeddedFontCss(): Promise<string> {
  fontCss ??= (async () => {
    const rules: string[] = [];
    for (const face of FACE_FILES) {
      const response = await fetch(`${PDFJS_ASSETS.standardFonts}${face.file}`);
      if (!response.ok) throw new ToolError('asset-missing', { engine: 'pdfjs', path: face.file });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      rules.push(
        `@font-face{font-family:"XfaSans";font-weight:${face.weight};font-style:${face.style};src:url(data:font/ttf;base64,${btoa(binary)}) format("truetype");}`,
      );
    }
    return rules.join('');
  })();
  fontCss.catch(() => {
    fontCss = null;
  });
  return fontCss;
}

/** The rules of every loaded stylesheet that style the XFA layer (`pdf_viewer.css`). */
function xfaStyleRules(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A cross-origin sheet: none of ours is, and none of those styles the layer.
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (/xfa/i.test(rule.cssText)) out.push(rule.cssText);
    }
  }
  return out.join('\n');
}

function familyFor(name: string): string {
  const base = name.replace(/^["']|["']$/g, '').replace(/-PdfJS-XFA$/, '');
  if (/times|serif|georgia|garamond|palatino|cambria|book/i.test(base) && !/sans/i.test(base)) {
    return '"Times New Roman", Times, serif';
  }
  if (/courier|mono|consolas/i.test(base)) return '"Courier New", Courier, monospace';
  return 'XfaSans, Arial, Helvetica, sans-serif';
}

/** The layer as it must be drawn: live values copied into attributes, faces mapped. */
function frozenClone(layer: HTMLElement): HTMLElement {
  const clone = layer.cloneNode(true) as HTMLElement;
  const live = layer.querySelectorAll<HTMLElement>('input, textarea, select');
  const copy = clone.querySelectorAll<HTMLElement>('input, textarea, select');
  live.forEach((element, index) => {
    const target = copy[index];
    if (target === undefined) return;
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox' || element.type === 'radio') {
        target.toggleAttribute('checked', element.checked);
      } else {
        target.setAttribute('value', element.value);
      }
    } else if (element instanceof HTMLTextAreaElement) {
      target.textContent = element.value;
    } else if (element instanceof HTMLSelectElement) {
      Array.from(element.options).forEach((option, at) => {
        (target as HTMLSelectElement).options[at]?.toggleAttribute('selected', option.selected);
      });
    }
    // The outline `:required` draws on a field is interaction chrome, not form content.
    target.removeAttribute('required');
  });
  for (const element of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]) {
    const family = element.style?.fontFamily;
    if (family !== undefined && family !== '' && /PdfJS-XFA/.test(family)) {
      element.style.fontFamily = familyFor(family);
    }
  }
  return clone;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Words of the live layout, in `host`'s pixels, one rectangle per word and line. */
function measureWords(layer: HTMLElement, host: HTMLElement): XfaRasterWord[] {
  const origin = host.getBoundingClientRect();
  const words: XfaRasterWord[] = [];
  const push = (text: string, rect: DOMRect) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    words.push({
      text,
      x0: rect.left - origin.left,
      y0: rect.top - origin.top,
      x1: rect.right - origin.left,
      y1: rect.bottom - origin.top,
    });
  };

  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    for (const match of text.matchAll(/\S+/g)) {
      range.setStart(node, match.index ?? 0);
      range.setEnd(node, (match.index ?? 0) + match[0].length);
      for (const rect of Array.from(range.getClientRects())) push(match[0], rect);
    }
  }

  // Typed values live in controls, not in text nodes.
  for (const control of Array.from(layer.querySelectorAll<HTMLElement>('input, textarea, select'))) {
    let value = '';
    if (control instanceof HTMLTextAreaElement) value = control.value;
    else if (control instanceof HTMLSelectElement) value = control.selectedOptions[0]?.text ?? '';
    else if (control instanceof HTMLInputElement && control.type !== 'checkbox' && control.type !== 'radio') {
      value = control.value;
    }
    if (value.trim() === '') continue;
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    const size = Number.parseFloat(style.fontSize) || 12;
    const lines = value.split(/\r?\n/);
    const inset = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth) || 2;
    lines.forEach((line, at) => {
      if (line.trim() === '') return;
      const top =
        rect.top + at * size * 1.2 + (control instanceof HTMLTextAreaElement ? 2 : (rect.height - size) / 2);
      const width = Math.min(rect.width - inset, line.length * size * 0.55);
      push(line.trim(), new DOMRect(rect.left + inset, top, width, size * 1.15));
    });
  }
  return words;
}

async function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null)
    throw new ToolError('out-of-memory', { engine: 'pdfjs', engineMessage: 'toBlob failed' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('the page picture could not be drawn'));
    image.src = url;
  });
  return image;
}

export interface XfaRasterOptions {
  /** Picture pixels per PDF point. */
  readonly scale: number;
  readonly signal: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Every page of a pure-XFA document as a picture and its words. `document` must have been
 * opened with `enableXfa` and `isPureXfa`; the values in its `annotationStorage` are drawn.
 */
export async function rasterizeXfaPages(
  pdf: PDFDocumentProxy,
  options: XfaRasterOptions,
): Promise<XfaRasterPage[]> {
  const { XfaLayer } = await import('pdfjs-dist');
  const css = `${await embeddedFontCss()}\n${xfaStyleRules()}`;
  const pages: XfaRasterPage[] = [];

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:-200000px;top:0;overflow:hidden;background:#fff;pointer-events:none;';
  document.body.append(host);
  try {
    for (let number = 1; number <= pdf.numPages; number += 1) {
      if (options.signal.aborted) throw new ToolError('aborted', { engine: 'pdfjs' });
      options.onProgress?.(number - 1, pdf.numPages);
      const page = await pdf.getPage(number);
      const xfa = await page.getXfa();
      if (xfa === null || xfa === undefined) {
        throw new ToolError('xfa-static', {
          engine: 'pdfjs',
          engineMessage: `page ${number} has no XFA layout`,
        });
      }
      const [left = 0, bottom = 0, right = 612, top = 792] = page.view;
      const widthPt = right - left;
      const heightPt = top - bottom;
      const viewport = page.getViewport({ scale: options.scale, dontFlip: true });
      const width = Math.ceil(widthPt * options.scale);
      const height = Math.ceil(heightPt * options.scale);

      host.replaceChildren();
      host.style.width = `${width}px`;
      host.style.height = `${height}px`;
      const layer = document.createElement('div');
      host.append(layer);
      await XfaLayer.render({
        viewport,
        div: layer,
        xfaHtml: xfa,
        annotationStorage: pdf.annotationStorage,
        linkService: undefined,
        intent: 'display',
      } as never);
      await document.fonts.ready;
      // One frame: images and wrapped text settle after the nodes are attached.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const words = measureWords(layer, host);
      const clone = frozenClone(layer);
      const body = new XMLSerializer().serializeToString(clone);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
        `<div xmlns="${XHTML_NS}" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#fff;">` +
        `<style>${escapeXml(css)}</style>${body}</div></foreignObject></svg>`;
      const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) throw new ToolError('out-of-memory', { engine: 'pdfjs' });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      pages.push({
        widthPt,
        heightPt,
        scale: options.scale,
        png: await toPng(canvas),
        words,
      });
      page.cleanup();
    }
    options.onProgress?.(pdf.numPages, pdf.numPages);
  } finally {
    host.remove();
  }
  return pages;
}
