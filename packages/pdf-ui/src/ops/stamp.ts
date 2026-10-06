/**
 * Page furniture (`PLAN.md §6`; `REPORT.md §3` A9, A10).
 *
 * Both capabilities draw on the page rather than changing its content, and both
 * go through the same `stampDocument` writer: one text block per page for
 * numbering, one text or image block for a watermark. The placement work — the
 * `/Rotate`-aware anchor arithmetic (`REPORT.md §3` A9's "placement can be wrong
 * on a rotated page") and the `{page}`/`{total}`/`{date}`/`{file}` substitution —
 * lives in the operation; the dialog only collects what the operation offers.
 */

import { type StampAnchor, stampDocument, type WatermarkOptions } from 'pdf-core';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

/**
 * A9 — header/footer and page numbers.
 *
 * `startAt` counts *stamped* pages, not document pages ("the first stamped page
 * shows `startAt`"), which is why `skipFirst` and a start value are both here
 * rather than one derived from the other.
 */
export const pageNumbersDialog: OperationDialogSpec = {
  id: 'page-numbers',
  titleKey: 'stamp.title',
  introKey: 'stamp.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
    {
      id: 'anchor',
      kind: 'radio',
      labelKey: 'stamp.position',
      defaultValue: 'bottom-center',
      columns: 3,
      options: [
        { value: 'top-left', labelKey: 'stamp.position.topLeft' },
        { value: 'top-center', labelKey: 'stamp.position.topCenter' },
        { value: 'top-right', labelKey: 'stamp.position.topRight' },
        { value: 'bottom-left', labelKey: 'stamp.position.bottomLeft' },
        { value: 'bottom-center', labelKey: 'stamp.position.bottomCenter' },
        { value: 'bottom-right', labelKey: 'stamp.position.bottomRight' },
        { value: 'center', labelKey: 'stamp.position.center' },
      ],
    },
    {
      id: 'template',
      kind: 'text',
      labelKey: 'stamp.format',
      hintKey: 'stamp.formatHint',
      defaultValue: '{page}',
      maxLength: 200,
      tokens: [
        { token: '{page}', labelKey: 'stamp.token.page' },
        { token: '{total}', labelKey: 'stamp.token.total' },
        { token: '{date}', labelKey: 'stamp.token.date' },
        { token: '{file}', labelKey: 'stamp.token.file' },
      ],
    },
    {
      id: 'fontSize',
      advanced: true,
      kind: 'number',
      labelKey: 'stamp.fontSize',
      defaultValue: 12,
      min: 4,
      max: 200,
      step: 1,
    },
    {
      id: 'marginMm',
      advanced: true,
      kind: 'number',
      labelKey: 'stamp.margin',
      defaultValue: 24,
      min: 0,
      max: 100,
      step: 1,
    },
    {
      id: 'startAt',
      advanced: true,
      kind: 'number',
      labelKey: 'stamp.startAt',
      defaultValue: 1,
      min: 1,
      max: 100000,
      step: 1,
    },
    { id: 'skipFirst', kind: 'checkbox', labelKey: 'stamp.skipFirst', defaultValue: false },
    { id: 'differentFirst', kind: 'checkbox', labelKey: 'stamp.differentFirst', defaultValue: false },
    {
      id: 'firstTemplate',
      advanced: true,
      kind: 'text',
      labelKey: 'stamp.firstTemplate',
      hintKey: 'stamp.firstTemplateHint',
      // Not empty: the operation refuses a template that resolves to nothing, and a
      // checked box whose field carries no text would be a control that does
      // nothing. The default is visibly different from the main template, so
      // ticking the box has an effect the user can see and then edit.
      defaultValue: '{page} / {total}',
      maxLength: 200,
      visibleWhen: { field: 'differentFirst', equals: [true] },
      tokens: [
        { token: '{page}', labelKey: 'stamp.token.page' },
        { token: '{total}', labelKey: 'stamp.token.total' },
        { token: '{date}', labelKey: 'stamp.token.date' },
        { token: '{file}', labelKey: 'stamp.token.file' },
      ],
    },
  ],
  run: async (params, context) => {
    const differentFirst = params.differentFirst === true;
    const outcome = await stampDocument(
      context.bytes,
      {
        kind: 'header-footer',
        pages: resolveScope(params.scope, context),
        anchor: params.anchor as StampAnchor,
        template: String(params.template ?? '').trim(),
        startAt: Number(params.startAt),
        fontSize: Number(params.fontSize),
        marginMm: Number(params.marginMm),
        skipFirst: params.skipFirst === true,
        ...(differentFirst ? { firstPageTemplate: String(params.firstTemplate ?? '').trim() } : {}),
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'stamp.done',
      noticeParams: { count: outcome.report.pageCount },
    };
  },
};

/**
 * A10 — text or image watermark.
 *
 * One kind at a time, because `stampDocument` rejects both at once (drawing one
 * and dropping the other would be a silent loss): the two value fields are gated
 * on the kind radio rather than left to a last-one-wins rule.
 */
export const watermarkDialog: OperationDialogSpec = {
  id: 'watermark',
  titleKey: 'watermark.title',
  introKey: 'watermark.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  initialValues: (context) => ({ text: context.t('watermark.defaultText') }),
  fields: [
    {
      id: 'type',
      kind: 'radio',
      labelKey: 'watermark.type',
      defaultValue: 'text',
      options: [
        { value: 'text', labelKey: 'watermark.type.text' },
        { value: 'image', labelKey: 'watermark.type.image' },
      ],
    },
    {
      id: 'text',
      kind: 'text',
      labelKey: 'watermark.text',
      hintKey: 'watermark.textHint',
      // Seeded from the interface language by `initialValues` above: a Turkish word here
      // showed up in the English dialog.
      defaultValue: '',
      maxLength: 200,
      visibleWhen: { field: 'type', equals: ['text'] },
    },
    {
      id: 'image',
      kind: 'image',
      accept: 'image/png,image/jpeg',
      labelKey: 'watermark.image',
      hintKey: 'watermark.imageHint',
      visibleWhen: { field: 'type', equals: ['image'] },
    },
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
    {
      id: 'opacity',
      kind: 'number',
      labelKey: 'watermark.opacity',
      hintKey: 'watermark.opacityHint',
      defaultValue: 0.2,
      min: 0.05,
      max: 1,
      step: 0.05,
    },
    {
      id: 'rotation',
      kind: 'number',
      labelKey: 'watermark.rotation',
      defaultValue: 45,
      min: -90,
      max: 90,
      step: 5,
    },
    {
      id: 'scale',
      advanced: true,
      kind: 'number',
      labelKey: 'watermark.scale',
      hintKey: 'watermark.scaleHint',
      defaultValue: 0.5,
      min: 0.05,
      max: 5,
      step: 0.05,
    },
    { id: 'tile', kind: 'checkbox', labelKey: 'watermark.tile', defaultValue: false },
    {
      id: 'tileSpacing',
      advanced: true,
      kind: 'number',
      labelKey: 'watermark.tileSpacing',
      hintKey: 'watermark.tileSpacingHint',
      defaultValue: 50,
      min: 5,
      max: 500,
      step: 5,
      visibleWhen: { field: 'tile', equals: [true] },
    },
    { id: 'noPrint', kind: 'checkbox', labelKey: 'watermark.noPrint', defaultValue: false },
  ],
  run: async (params, context) => {
    const shared: Omit<WatermarkOptions, 'text' | 'image'> = {
      kind: 'watermark',
      pages: resolveScope(params.scope, context),
      opacity: Number(params.opacity),
      rotationDegrees: Number(params.rotation),
      scale: Number(params.scale),
      tile: params.tile === true,
      tileSpacing: Number(params.tileSpacing),
      noPrint: params.noPrint === true,
    };

    let payload: Pick<WatermarkOptions, 'text' | 'image'>;
    if (params.type === 'image') {
      const picked = Array.isArray(params.image) ? (params.image as readonly File[]) : [];
      const file = picked[0];
      if (file === undefined) {
        throw new ToolError('unsupported-format', {
          engine: 'ui',
          engineMessage: 'watermark: image kind without a picked image',
        });
      }
      payload = { image: { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name } };
    } else {
      payload = { text: String(params.text ?? '').trim() };
    }

    const outcome = await stampDocument(
      context.bytes,
      { ...shared, ...payload },
      {
        signal: context.signal,
        onProgress: context.onProgress,
      },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'watermark.done',
      noticeParams: { count: outcome.report.pageCount },
    };
  },
};
