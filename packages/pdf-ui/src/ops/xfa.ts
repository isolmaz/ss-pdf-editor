/**
 * XFA form dialogs (`pdf-core/ops/xfa-form.ts`, `xfa-flatten.ts`): remove the XFA from a
 * static form, export or import the form's data, flatten a dynamic form to a normal PDF.
 *
 * The fourth XFA surface, filling a dynamic form, is not a declarative dialog: it hosts
 * pdf.js's XFA viewer (`dialogs/XfaFormDialog.tsx`).
 */

import { openWithPdfjs } from 'pdf-core/engines/pdfjs-handle';
import { note } from 'pdf-core/ops/types';
import { buildFlattenedXfa } from 'pdf-core/ops/xfa-flatten';
import { exportXfaData, importXfaData, inspectXfa, removeXfa } from 'pdf-core/ops/xfa-form';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';
import { rasterizeXfaPages } from './xfa-raster';

export const xfaRemoveDialog: OperationDialogSpec = {
  id: 'xfa-remove',
  titleKey: 'xfa.remove.title',
  introKey: 'xfa.remove.intro',
  confirmKey: 'xfa.remove.confirm',
  resultKind: 'replace',
  fields: [],
  run: async (_params, context) => {
    const outcome = await removeXfa(context.bytes, {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'xfa.remove.done',
    };
  },
};

export const xfaDataDialog: OperationDialogSpec = {
  id: 'xfa-data',
  titleKey: 'xfa.data.title',
  introKey: 'xfa.data.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'form.dialog.mode',
      defaultValue: 'export',
      options: [
        { value: 'export', labelKey: 'form.dialog.mode.export' },
        { value: 'import', labelKey: 'form.dialog.mode.import' },
      ],
    },
    {
      id: 'file',
      kind: 'files',
      labelKey: 'form.dialog.file',
      hintKey: 'xfa.data.fileHint',
      accept: '.xml,.xdp,application/xml,text/xml',
      multiple: false,
      visibleWhen: { field: 'mode', equals: ['import'] },
    },
  ],
  run: async (params, context) => {
    if (params.mode === 'export') {
      const exported = await exportXfaData(context.bytes);
      return {
        files: [{ name: exported.name, bytes: exported.bytes, mime: exported.mime }],
        report: {
          engine: 'mupdf',
          steps: ['xfa.export'],
          notes: [note('preserved', 'xfa.note.exported', { count: exported.values })],
          inputBytes: context.bytes.length,
          outputBytes: exported.bytes.length,
          pageCount: context.pageCount,
          incremental: true,
        },
        noticeKey: 'xfa.note.exported',
        noticeParams: { count: exported.values },
        deliver: 'download',
      };
    }
    const file = Array.isArray(params.file) ? (params.file[0] as File | undefined) : undefined;
    if (file === undefined) {
      throw new ToolError('input-missing', { engine: 'ui', engineMessage: 'no XFA data file chosen' });
    }
    const imported = await importXfaData(context.bytes, new Uint8Array(await file.arrayBuffer()), {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    return {
      files: [{ name: context.name, bytes: imported.bytes, mime: 'application/pdf' }],
      report: imported.report,
      noticeKey: 'xfa.note.imported',
      noticeParams: { count: imported.values },
    };
  },
};

/** Picture pixels per point: 1.5 is 108 dpi, 2 is 144 dpi, 3 is 216 dpi. */
const FLATTEN_SCALES = ['1.5', '2', '3'] as const;

export const xfaFlattenDialog: OperationDialogSpec = {
  id: 'xfa-flatten',
  titleKey: 'xfa.flatten.title',
  introKey: 'xfa.flatten.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  fields: [
    {
      id: 'scale',
      kind: 'radio',
      labelKey: 'xfa.flatten.resolution',
      defaultValue: '2',
      options: FLATTEN_SCALES.map((value) => ({
        value,
        labelKey: `xfa.flatten.resolution.${value}` as const,
      })),
    },
  ],
  run: async (params, context) => {
    const info = await inspectXfa(context.bytes);
    if (info === null) throw new ToolError('no-xfa', { engine: 'mupdf' });
    if (info.kind === 'static') throw new ToolError('xfa-static', { engine: 'mupdf' });
    const scale = Number(params.scale) > 0 ? Number(params.scale) : 2;

    // Its own pdf.js document with the XFA renderer on: the editor's documents never have it.
    const handle = await openWithPdfjs(context.bytes, { signal: context.signal, enableXfa: true });
    try {
      if (!handle.raw.isPureXfa) throw new ToolError('xfa-static', { engine: 'pdfjs' });
      const pages = await rasterizeXfaPages(handle.raw, {
        scale,
        signal: context.signal,
        onProgress: (done, total) =>
          context.onProgress({ phase: 'xfa.flatten', labelKey: 'op.progress.xfa.flatten', done, total }),
      });
      const outcome = await buildFlattenedXfa(pages, {
        signal: context.signal,
        onProgress: context.onProgress,
      });
      const base = context.name.replace(/\.pdf$/i, '');
      return {
        files: [{ name: `${base}-flat.pdf`, bytes: outcome.bytes, mime: 'application/pdf' }],
        report: outcome.report,
        noticeKey: 'xfa.flatten.done',
        noticeParams: { count: pages.length },
      };
    } finally {
      await handle.destroy();
    }
  },
};
