/**
 * OCR (`PLAN.md §6`; `REPORT.md §3` A15).
 *
 * The dialog's job is small and exact, because both of A15's defects were places
 * where the UI and the core disagreed:
 *  - the DPI field offers 150–300 and rejects anything else in the field itself
 *    (`FieldSpec.number`'s range, the same rule `OcrOptions.dpi` enforces), so the
 *    value the user sees is the value tesseract gets (`REPORT.md §4.5`: the old UI
 *    offered 120–400 while the core rejected >300);
 *  - the "existing text" mode is explicit, and in `skip` mode the dialog asks the
 *    engine which pages actually carry text (`detectScannedPages`) so the report can
 *    say how many pages were left alone instead of the user wondering.
 */

import {
  detectScannedPages,
  note,
  OCR_LANGUAGES,
  type OcrLanguage,
  type OcrQuality,
  ocrDocument,
} from 'pdf-core';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

/** Language pack names as the UI spells them; the values are tesseract's own codes. */
const LANGUAGE_LABELS: Record<OcrLanguage, MessageKey> = {
  tur: 'ocr.language.tr',
  eng: 'ocr.language.en',
};

export const ocrDialog: OperationDialogSpec = {
  id: 'ocr',
  titleKey: 'ocr.title',
  introKey: 'ocr.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      id: 'languages',
      kind: 'checkboxList',
      labelKey: 'ocr.languages',
      hintKey: 'ocr.languagesHint',
      // Turkish first: the product's first locale, and the pack the row is tested
      // against (`PLAN.md §6` A15's quality gate).
      defaultValue: ['tur'],
      options: OCR_LANGUAGES.map((language) => ({
        value: language,
        labelKey: LANGUAGE_LABELS[language],
      })),
    },
    {
      id: 'quality',
      kind: 'radio',
      labelKey: 'ocr.quality',
      defaultValue: 'fast',
      options: [
        { value: 'fast', labelKey: 'ocr.quality.fast' },
        { value: 'best', labelKey: 'ocr.quality.best' },
      ],
    },
    {
      id: 'dpi',
      advanced: true,
      kind: 'number',
      labelKey: 'ocr.dpi',
      hintKey: 'ocr.dpiHint',
      defaultValue: 200,
      min: 150,
      max: 300,
      step: 50,
    },
    {
      id: 'existingText',
      advanced: true,
      kind: 'radio',
      labelKey: 'ocr.textPresent.mode',
      hintKey: 'ocr.textPresentModeHint',
      defaultValue: 'skip',
      options: [
        { value: 'skip', labelKey: 'ocr.textPresent.skip' },
        { value: 'overwrite', labelKey: 'ocr.textPresent.overwrite' },
      ],
    },
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const languages = Array.isArray(params.languages) ? (params.languages as readonly OcrLanguage[]) : [];
    // A run with no language pack cannot recognise anything; the failure belongs to
    // the dictionary's own "language missing" contract rather than to a silent
    // pass that produces a document with no text layer.
    if (languages.length === 0) {
      throw new ToolError('ocr-language-missing', {
        engine: 'ui',
        engineMessage: 'ocr: no language was selected',
      });
    }

    const operationContext = { signal: context.signal, onProgress: context.onProgress };
    const existingText = params.existingText as 'skip' | 'overwrite';

    // Measured, not assumed: the operation owns the skip rule, and this call is how
    // the dialog can say which of the selected pages it will leave untouched.
    const scanned = new Set(
      existingText === 'skip' ? await detectScannedPages(context.bytes, operationContext) : [],
    );
    const skipped = existingText === 'skip' ? pages.filter((page) => !scanned.has(page)) : [];

    const outcome = await ocrDocument(
      context.bytes,
      {
        pages,
        languages,
        quality: params.quality as OcrQuality,
        dpi: Number(params.dpi),
        existingText,
      },
      operationContext,
    );

    const recognised = outcome.pages.filter((page) => !page.skipped).length;
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: {
        ...outcome.report,
        notes: [
          ...outcome.report.notes,
          ...(skipped.length === 0 ? [] : [note('preserved', 'ocr.skipped', { count: skipped.length })]),
          ...(recognised === 0 ? [note('warning', 'ocr.empty')] : []),
        ],
      },
      noticeKey: recognised === 0 ? 'ocr.empty' : 'ocr.done',
      ...(recognised === 0 ? {} : { noticeParams: { count: recognised } }),
    };
  },
};
