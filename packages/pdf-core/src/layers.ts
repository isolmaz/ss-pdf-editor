/**
 * Optional content groups ("Katmanlar"): the layer palette of
 * a PDF, read through pdf.js's public `OptionalContentConfig`.
 *
 * Two engine facts shape this module:
 *  - **The config is per-instance state.** `getOptionalContentConfig()` builds a
 *    fresh object over cached data on every call, and only that object remembers a
 *    toggle — so the adapter keeps the one instance it hands out per document (a
 *    `WeakMap` on the handle, released with it) and every read goes through it.
 *  - **The order is a tree, not a flat list.** The engine normalises the document's
 *    OCG order into group ids and named sub-levels, and appends the groups the order
 *    omitted as one unnamed level — so nothing a document defines is lost.
 *
 * `setVisibility(id, visible)` is the engine's public toggle and the only write the
 * reader half performs.
 */

import { toToolError } from 'pdf-shared';
import type { PdfDocumentHandle } from './engines/pdfjs-handle';

/** An optional content group — the one node a reader can toggle. */
export interface PdfLayerGroup {
  readonly kind: 'group';
  /** Engine id behind `setVisibility(id, visible)`. */
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly children: readonly PdfLayerNode[];
}

/** A level of the document's own layer order that has no group of its own. */
export interface PdfLayerLabel {
  readonly kind: 'label';
  /** Heading the order carries, or `null` for the groups it omitted. */
  readonly name: string | null;
  readonly children: readonly PdfLayerNode[];
}

export type PdfLayerNode = PdfLayerGroup | PdfLayerLabel;

/**
 * The slice of pdf.js's `OptionalContentConfig` this adapter uses, declared here the
 * way the shell declares its viewer surface: an engine upgrade that changes one of
 * these members fails the typecheck instead of failing in the panel.
 */
interface PdfjsOptionalContentConfig {
  getOrder(): unknown;
  getGroup(id: string): unknown;
  setVisibility(id: string, visible: boolean): void;
  [Symbol.iterator](): Iterator<[string, unknown]>;
}

const configs = new WeakMap<PdfDocumentHandle, Promise<PdfjsOptionalContentConfig>>();

/** The document's own config instance, loaded once and reused for every read. */
function configFor(document: PdfDocumentHandle): Promise<PdfjsOptionalContentConfig> {
  const cached = configs.get(document);
  if (cached !== undefined) return cached;

  const config = document.raw.getOptionalContentConfig().catch((error: unknown) => {
    // A failed load stays uncached, so the next read of the panel tries again.
    configs.delete(document);
    throw toToolError(error, 'pdfjs');
  });
  configs.set(document, config);
  return config;
}

/** Name and state of one group; `null` when the order names an unknown id. */
function readGroup(
  config: PdfjsOptionalContentConfig,
  id: string,
): { name: string; visible: boolean } | null {
  const group: unknown = config.getGroup(id);
  if (group === null || typeof group !== 'object') return null;
  const meta = group as { readonly name?: unknown; readonly visible?: unknown };
  return {
    name: typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : id,
    // The engine's getter folds the document's usage flags in; `true` is what it
    // answers for a group nothing switched off.
    visible: meta.visible === true,
  };
}

function buildNodes(config: PdfjsOptionalContentConfig, order: unknown): readonly PdfLayerNode[] {
  if (!Array.isArray(order)) return [];

  const nodes: PdfLayerNode[] = [];
  for (const entry of order) {
    if (typeof entry === 'string') {
      const group = readGroup(config, entry);
      if (group === null) continue;
      nodes.push({ kind: 'group', id: entry, name: group.name, visible: group.visible, children: [] });
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const level = entry as { readonly name?: unknown; readonly order?: unknown };
    const children = buildNodes(config, level.order);
    if (children.length === 0) continue;
    nodes.push({ kind: 'label', name: typeof level.name === 'string' ? level.name : null, children });
  }
  return nodes;
}

/** The document's layer tree. A document without optional content is an empty list. */
export async function listPdfLayers(document: PdfDocumentHandle): Promise<readonly PdfLayerNode[]> {
  const config = await configFor(document);
  try {
    return buildNodes(config, config.getOrder());
  } catch (error) {
    throw toToolError(error, 'pdfjs');
  }
}

/**
 * The **cached** configuration instance — the one `listPdfLayers`/`setPdfLayerVisibility`
 * read and mutate. The viewer needs *this* object to repaint a toggled layer: asking the
 * engine for a config again builds a fresh instance with the document's defaults, which
 * would silently undo the toggle (measured: the canvas returned with the layer still on).
 */
export async function pdfOptionalContentConfig(document: PdfDocumentHandle): Promise<unknown> {
  return await configFor(document);
}

/**
 * Toggles one group and answers with the tree as it now stands, so the panel never
 * has to keep a second copy of the engine's state.
 */
export async function setPdfLayerVisibility(
  document: PdfDocumentHandle,
  id: string,
  visible: boolean,
): Promise<readonly PdfLayerNode[]> {
  const config = await configFor(document);
  try {
    config.setVisibility(id, visible);
    return buildNodes(config, config.getOrder());
  } catch (error) {
    throw toToolError(error, 'pdfjs');
  }
}
