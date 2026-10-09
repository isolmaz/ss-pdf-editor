/**
 * Optimisation.
 *
 * Two modes, one operation. The dialog's whole job is to make the difference
 * between them unmissable before the button is pressed: `structure` re-serialises
 * and may drop Info metadata, `raster` renders the selected pages into images and
 * loses their text layer, links and annotations (the outline still leads to them).
 *
 * `destructive` is a **spec-level** flag, so choosing the raster mode makes the
 * whole dialog ask twice. The alternative — a lost note
 * the user only reads afterwards — is exactly the "report told me later"
 * behaviour the phase exists to remove, so the flag is set and `introKey` carries
 * the sentence the confirmation is about.
 */

import { type CompressOptions, compressDocument, formatBytes } from 'pdf-core';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

export const compressDialog: OperationDialogSpec = {
  id: 'compress',
  titleKey: 'optimize.title',
  introKey: 'optimize.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  destructive: true,
  fields: [
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'optimize.mode',
      defaultValue: 'structure',
      options: [
        { value: 'structure', labelKey: 'optimize.mode.structure' },
        { value: 'raster', labelKey: 'optimize.mode.rasterize' },
      ],
    },
    {
      id: 'stripMetadata',
      advanced: true,
      kind: 'checkbox',
      labelKey: 'optimize.stripMetadata',
      // The producer line is never stripped, so the reassurance
      // belongs next to the checkbox that sounds like it would.
      hintKey: 'optimize.producerKept',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['structure'] },
    },
    {
      id: 'dpi',
      kind: 'number',
      labelKey: 'optimize.dpi',
      defaultValue: 150,
      min: 72,
      max: 300,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['raster'] },
    },
    {
      id: 'quality',
      kind: 'number',
      labelKey: 'optimize.imageQuality',
      hintKey: 'optimize.qualityHint',
      defaultValue: 0.7,
      min: 0.3,
      max: 0.95,
      step: 0.05,
      visibleWhen: { field: 'mode', equals: ['raster'] },
    },
    {
      id: 'greyscale',
      advanced: true,
      kind: 'checkbox',
      labelKey: 'optimize.greyscale',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['raster'] },
    },
    {
      id: 'scope',
      kind: 'pageScope',
      labelKey: 'op.scope',
      default: 'all',
      visibleWhen: { field: 'mode', equals: ['raster'] },
    },
  ],
  run: async (params, context) => {
    const options: CompressOptions =
      params.mode === 'raster'
        ? {
            mode: 'raster',
            pages: resolveScope(params.scope, context),
            dpi: Number(params.dpi),
            quality: Number(params.quality),
            greyscale: params.greyscale === true,
          }
        : {
            mode: 'structure',
            stripMetadata: params.stripMetadata === true,
            // Hard-coded, never a field: the producer line is a product policy,
            // not a user choice.
            keepProducer: true,
          };

    const outcome = await compressDocument(context.bytes, options, {
      signal: context.signal,
      onProgress: context.onProgress,
    });

    // A larger output is never reported as "no gain". The size delta the user opened
    // this dialog for is stated in the notice, and the report carries the same two numbers.
    const { inputBytes, outputBytes } = outcome.report;
    const noticeKey =
      outputBytes > inputBytes
        ? 'optimize.grew'
        : outputBytes < inputBytes
          ? 'optimize.saved'
          : 'optimize.noGain';

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey,
      noticeParams: {
        before: formatBytes(inputBytes),
        after: formatBytes(outputBytes),
        percent: inputBytes === 0 ? 0 : Math.round((1 - outputBytes / inputBytes) * 100),
      },
    };
  },
};
