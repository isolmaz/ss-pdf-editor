/**
 * The layer tree as the reader (pdf.js) sees it: a real file with optional content groups, read,
 * toggled and read again. The engine's own failures are injected at the `raw` document seam.
 */

import { isToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import type { PdfDocumentHandle } from './engines/pdfjs-handle';
import { openWithPdfjs } from './engines/pdfjs-handle';
import { listPdfLayers, pdfOptionalContentConfig, setPdfLayerVisibility } from './layers';
import { layerPdf } from './ops/layer-write.fixtures';

async function withHandle<T>(bytes: Uint8Array, use: (handle: PdfDocumentHandle) => Promise<T>): Promise<T> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await use(handle);
  } finally {
    await handle.destroy();
  }
}

/** A handle whose `raw` document runs `change` on the engine's own optional-content config. */
function withConfigFault(
  handle: PdfDocumentHandle,
  fault: {
    readonly load?: () => never;
    readonly config?: Readonly<Record<string, (...args: readonly string[]) => unknown>>;
  },
): PdfDocumentHandle {
  const raw = new Proxy(handle.raw, {
    get(target, property) {
      if (property === 'getOptionalContentConfig') {
        return async () => {
          if (fault.load !== undefined) fault.load();
          const config = await target.getOptionalContentConfig();
          return new Proxy(config, {
            get(configTarget, configProperty) {
              const trap = typeof configProperty === 'string' ? fault.config?.[configProperty] : undefined;
              if (trap !== undefined) return trap;
              const value: unknown = Reflect.get(configTarget, configProperty, configTarget);
              return typeof value === 'function' ? value.bind(configTarget) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...handle, raw };
}

describe('listPdfLayers', () => {
  it('lists groups, headings and their names in the document order, hidden groups as not visible', async () => {
    const bytes = layerPdf({
      config: '<</Order[10 0 R [(Group) 11 0 R]]/OFF[11 0 R]>>',
    });
    const tree = await withHandle(bytes, listPdfLayers);
    expect(tree[0]).toEqual({ kind: 'group', id: '10R', name: 'A', visible: true, children: [] });
    const heading = tree[1];
    expect(heading?.kind).toBe('label');
    expect(heading?.kind === 'label' && heading.name).toBe('Group');
    expect(heading?.children[0]).toEqual({
      kind: 'group',
      id: '11R',
      name: 'B',
      visible: false,
      children: [],
    });
  });

  it('names a group without a name by its id', async () => {
    const bytes = layerPdf({ config: '<</Order[12 0 R]>>', extra: { 12: '<</Type/OCG/Name()>>' } });
    const tree = await withHandle(bytes, listPdfLayers);
    expect(tree[0]).toEqual({ kind: 'group', id: '12R', name: '12R', visible: true, children: [] });
    // The groups the order left out follow under a heading of their own that has no name.
    expect(tree[1]?.kind === 'label' && tree[1].name).toBeNull();
  });

  it('reads a document without optional content as an empty list', async () => {
    expect(await withHandle(layerPdf({ ocProperties: false }), listPdfLayers)).toEqual([]);
  });

  it('skips what the order cannot make a node of: no order, unknown ids, scalars, empty levels', async () => {
    await withHandle(layerPdf(), async (real) => {
      const groupOf = (id: string): unknown =>
        id === '10R' ? { name: 'A', visible: true } : id === 'odd' ? { name: 5 } : null;
      const orders: unknown[] = [
        null,
        [
          '10R',
          'missing',
          'nothing',
          7,
          null,
          { name: 'Empty', order: [] },
          { name: 3, order: ['10R', 'odd'] },
        ],
      ];
      const results: unknown[] = [];
      for (const order of orders) {
        const handle = withConfigFault(real, {
          config: { getOrder: () => order, getGroup: (id) => groupOf(id) },
        });
        results.push(await listPdfLayers(handle));
      }
      expect(results[0]).toEqual([]);
      expect(results[1]).toEqual([
        { kind: 'group', id: '10R', name: 'A', visible: true, children: [] },
        {
          kind: 'label',
          name: null,
          children: [
            { kind: 'group', id: '10R', name: 'A', visible: true, children: [] },
            { kind: 'group', id: 'odd', name: 'odd', visible: false, children: [] },
          ],
        },
      ]);
    });
  });
});

describe('setPdfLayerVisibility', () => {
  it('toggles a group and answers with the tree as it now stands, on the same cached config', async () => {
    const bytes = layerPdf({ config: '<</Order[10 0 R 11 0 R]>>' });
    await withHandle(bytes, async (handle) => {
      const before = await listPdfLayers(handle);
      expect(before.map((node) => (node.kind === 'group' ? node.visible : null))).toEqual([true, true, null]);
      const after = await setPdfLayerVisibility(handle, '10R', false);
      expect(after.map((node) => (node.kind === 'group' ? node.visible : null))).toEqual([false, true, null]);
      // The viewer repaints with this very instance, so a second read still sees the toggle.
      expect(await pdfOptionalContentConfig(handle)).toBe(await pdfOptionalContentConfig(handle));
      const again = await listPdfLayers(handle);
      expect(again.map((node) => (node.kind === 'group' ? node.visible : null))).toEqual([false, true, null]);
      const restored = await setPdfLayerVisibility(handle, '10R', true);
      expect(restored.map((node) => (node.kind === 'group' ? node.visible : null))).toEqual([
        true,
        true,
        null,
      ]);
    });
  });
});

describe('engine failures', () => {
  it('maps a failed config load to a tool error and tries again on the next read', async () => {
    await withHandle(layerPdf({ config: '<</Order[10 0 R]>>' }), async (real) => {
      let failures = 1;
      const handle = withConfigFault(real, {
        load: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('optional content config failed');
          }
          return undefined as never;
        },
      });
      const failure = await listPdfLayers(handle).catch((error: unknown) => error);
      expect(isToolError(failure)).toBe(true);
      expect(isToolError(failure) && failure.code).toBe('internal');
      expect(isToolError(failure) && failure.details.engine).toBe('pdfjs');
      const tree = await listPdfLayers(handle);
      expect(tree.length).toBeGreaterThan(0);
    });
  });

  it('maps a failing order read to a tool error', async () => {
    await withHandle(layerPdf(), async (real) => {
      const handle = withConfigFault(real, {
        config: {
          getOrder: () => {
            throw new Error('order is unreadable');
          },
        },
      });
      const failure = await listPdfLayers(handle).catch((error: unknown) => error);
      expect(isToolError(failure) && failure.details.engineMessage).toBe('order is unreadable');
    });
  });

  it('maps a failing toggle to a tool error', async () => {
    await withHandle(layerPdf(), async (real) => {
      const handle = withConfigFault(real, {
        config: {
          setVisibility: () => {
            throw new Error('unknown group');
          },
        },
      });
      const failure = await setPdfLayerVisibility(handle, 'zz', true).catch((error: unknown) => error);
      expect(isToolError(failure) && failure.details.engineMessage).toBe('unknown group');
    });
  });
});
