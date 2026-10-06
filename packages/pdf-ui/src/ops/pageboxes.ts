/**
 * Page boxes & size ("Media/Crop/Trim/Bleed/Art, resize, scale,
 * auto-crop (white margins), rotate/shift content").
 *
 * One dialog, six modes, one operation (`applyPageBoxes`). Everything the mode needs
 * is a field of this dialog and nothing else is sent: only the fields the selected
 * mode reads are visible (`visibleWhen`), and `modeOptions` builds the operation's
 * options from exactly those — so a hidden field can never contribute a value the user
 * did not see.
 *
 * What the dialog says out loud, because the operation cannot say it in a field:
 *  - a page-box change is a geometry change, not a content change — existing
 *    annotations and links keep their coordinates and may fall outside the new crop;
 *  - a content shift moves content only (annotations are not translated with it), while
 *    a content rotation is written to the page's `/Rotate`, which turns content,
 *    annotations and boxes together;
 *  - auto-crop measures the rendered page (150 dpi, non-white pixels), so a document
 *    whose background is not white has no white margins to find.
 * The operation's report restates each of them per run (`boxes.note.*`).
 */

import { applyPageBoxes, type PageBoxesMode, type PageBoxesOptions, type PageBoxKind } from 'pdf-core';
import type { DialogParams, OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

/** Rect field bounds in points: negative origins are legal PDF, absurd sizes are not. */
const MAX_COORDINATE = 10000;
const MAX_PAGE_POINTS = 20000;
/** A4 in points, the default of the resize fields (the most common target). */
const A4_WIDTH = 595;
const A4_HEIGHT = 842;

export const pageBoxesDialog: OperationDialogSpec = {
  id: 'page-boxes',
  titleKey: 'boxes.dialog.title',
  introKey: 'boxes.dialog.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'boxes.dialog.mode',
      // Auto-crop first: it is the only mode that decides the box from the page itself,
      // so it is the safe default for a dialog whose other modes write what the user
      // types.
      defaultValue: 'auto-crop',
      columns: 2,
      options: [
        { value: 'auto-crop', labelKey: 'boxes.dialog.mode.autoCrop' },
        { value: 'set', labelKey: 'boxes.dialog.mode.set' },
        { value: 'resize', labelKey: 'boxes.dialog.mode.resize' },
        { value: 'scale', labelKey: 'boxes.dialog.mode.scale' },
        { value: 'shift', labelKey: 'boxes.dialog.mode.shift' },
        { value: 'rotate-content', labelKey: 'boxes.dialog.mode.rotate' },
      ],
    },
    {
      id: 'box',
      kind: 'select',
      labelKey: 'boxes.dialog.box',
      defaultValue: 'crop',
      visibleWhen: { field: 'mode', equals: ['set'] },
      options: [
        { value: 'crop', labelKey: 'boxes.dialog.box.crop' },
        { value: 'media', labelKey: 'boxes.dialog.box.media' },
        { value: 'trim', labelKey: 'boxes.dialog.box.trim' },
        { value: 'bleed', labelKey: 'boxes.dialog.box.bleed' },
        { value: 'art', labelKey: 'boxes.dialog.box.art' },
      ],
    },
    {
      id: 'x',
      kind: 'number',
      labelKey: 'boxes.dialog.x',
      hintKey: 'boxes.dialog.rectHint',
      defaultValue: 0,
      min: -MAX_COORDINATE,
      max: MAX_COORDINATE,
      step: 1,
      unitKey: 'boxes.unit.points',
      visibleWhen: { field: 'mode', equals: ['set'] },
    },
    {
      id: 'y',
      kind: 'number',
      labelKey: 'boxes.dialog.y',
      defaultValue: 0,
      min: -MAX_COORDINATE,
      max: MAX_COORDINATE,
      step: 1,
      unitKey: 'boxes.unit.points',
      visibleWhen: { field: 'mode', equals: ['set'] },
    },
    {
      id: 'rectWidth',
      kind: 'number',
      labelKey: 'boxes.dialog.width',
      defaultValue: A4_WIDTH,
      min: 1,
      max: MAX_PAGE_POINTS,
      step: 1,
      unitKey: 'boxes.unit.points',
      visibleWhen: { field: 'mode', equals: ['set'] },
    },
    {
      id: 'rectHeight',
      kind: 'number',
      labelKey: 'boxes.dialog.height',
      defaultValue: A4_HEIGHT,
      min: 1,
      max: MAX_PAGE_POINTS,
      step: 1,
      unitKey: 'boxes.unit.points',
      visibleWhen: { field: 'mode', equals: ['set'] },
    },
    {
      id: 'width',
      kind: 'number',
      labelKey: 'boxes.dialog.width',
      defaultValue: A4_WIDTH,
      min: 1,
      max: MAX_PAGE_POINTS,
      step: 1,
      unitKey: 'boxes.unit.points',
      visibleWhen: { field: 'mode', equals: ['resize'] },
    },
    {
      id: 'height',
      kind: 'number',
      labelKey: 'boxes.dialog.height',
      defaultValue: A4_HEIGHT,
      min: 1,
      max: MAX_PAGE_POINTS,
      step: 1,
      unitKey: 'boxes.unit.points',
      visibleWhen: { field: 'mode', equals: ['resize'] },
    },
    {
      id: 'fit',
      kind: 'select',
      labelKey: 'boxes.dialog.fit',
      defaultValue: 'fit',
      visibleWhen: { field: 'mode', equals: ['resize'] },
      options: [
        { value: 'fit', labelKey: 'boxes.dialog.fit.fit' },
        { value: 'fill', labelKey: 'boxes.dialog.fit.fill' },
        { value: 'stretch', labelKey: 'boxes.dialog.fit.stretch' },
        { value: 'none', labelKey: 'boxes.dialog.fit.none' },
      ],
    },
    {
      id: 'marginMm',
      kind: 'number',
      labelKey: 'boxes.dialog.margin',
      defaultValue: 0,
      min: 0,
      max: 200,
      step: 1,
      unitKey: 'boxes.unit.mm',
      visibleWhen: { field: 'mode', equals: ['resize'] },
    },
    {
      id: 'factor',
      kind: 'number',
      labelKey: 'boxes.dialog.factor',
      hintKey: 'boxes.dialog.factorHint',
      defaultValue: 1,
      min: 0.05,
      max: 10,
      step: 0.05,
      visibleWhen: { field: 'mode', equals: ['scale'] },
    },
    {
      id: 'scaleBoxes',
      kind: 'checkbox',
      labelKey: 'boxes.dialog.scaleBoxes',
      hintKey: 'boxes.dialog.scaleBoxesHint',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['scale'] },
    },
    {
      id: 'paddingMm',
      kind: 'number',
      labelKey: 'boxes.dialog.padding',
      hintKey: 'boxes.dialog.paddingHint',
      defaultValue: 2,
      min: 0,
      max: 200,
      step: 0.5,
      unitKey: 'boxes.unit.mm',
      visibleWhen: { field: 'mode', equals: ['auto-crop'] },
    },
    {
      id: 'alsoTrim',
      kind: 'checkbox',
      labelKey: 'boxes.dialog.alsoTrim',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['auto-crop'] },
    },
    {
      id: 'offsetXmm',
      kind: 'number',
      labelKey: 'boxes.dialog.offsetX',
      hintKey: 'boxes.dialog.offsetHint',
      defaultValue: 0,
      min: -500,
      max: 500,
      step: 1,
      unitKey: 'boxes.unit.mm',
      visibleWhen: { field: 'mode', equals: ['shift'] },
    },
    {
      id: 'offsetYmm',
      kind: 'number',
      labelKey: 'boxes.dialog.offsetY',
      defaultValue: 0,
      min: -500,
      max: 500,
      step: 1,
      unitKey: 'boxes.unit.mm',
      visibleWhen: { field: 'mode', equals: ['shift'] },
    },
    {
      id: 'degrees',
      kind: 'radio',
      labelKey: 'boxes.dialog.degrees',
      defaultValue: '90',
      columns: 3,
      visibleWhen: { field: 'mode', equals: ['rotate-content'] },
      // No 0° option: the operation refuses a rotation that changes nothing, and a
      // control that does nothing has no place in a dialog.
      options: [
        { value: '90', labelKey: 'boxes.dialog.degrees.90' },
        { value: '180', labelKey: 'boxes.dialog.degrees.180' },
        { value: '270', labelKey: 'boxes.dialog.degrees.270' },
      ],
    },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const mode = params.mode as PageBoxesMode;
    const outcome = await applyPageBoxes(context.bytes, modeOptions(mode, params, pages), {
      signal: context.signal,
      onProgress: context.onProgress,
    });

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'boxes.dialog.done',
      noticeParams: { count: outcome.changed.length },
    };
  },
};

/**
 * The operation's options for the selected mode — nothing else.
 *
 * The `set` rect is written as two corners (`[x0, y0, x1, y1]`) because that is the
 * contract `PageBoxesOptions.rect` has; the dialog shows the corner plus extents a
 * person measures, so the conversion lives here, in one place.
 */
function modeOptions(mode: PageBoxesMode, params: DialogParams, pages: readonly number[]): PageBoxesOptions {
  switch (mode) {
    case 'set': {
      const x = Number(params.x);
      const y = Number(params.y);
      return {
        mode,
        pages,
        box: params.box as PageBoxKind,
        rect: [x, y, x + Number(params.rectWidth), y + Number(params.rectHeight)],
      };
    }
    case 'resize':
      return {
        mode,
        pages,
        width: Number(params.width),
        height: Number(params.height),
        fit: params.fit as PageBoxesOptions['fit'],
        marginMm: Number(params.marginMm),
      };
    case 'scale':
      return { mode, pages, factor: Number(params.factor), scaleBoxes: params.scaleBoxes === true };
    case 'auto-crop':
      return { mode, pages, paddingMm: Number(params.paddingMm), alsoTrim: params.alsoTrim === true };
    case 'shift':
      return { mode, pages, offsetXmm: Number(params.offsetXmm), offsetYmm: Number(params.offsetYmm) };
    case 'rotate-content':
      return { mode, pages, degrees: Number(params.degrees) as 0 | 90 | 180 | 270 };
  }
}
