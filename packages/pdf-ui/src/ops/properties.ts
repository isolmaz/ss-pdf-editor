/**
 * Document properties (`PLAN.md §6`; `REPORT.md §3` A11).
 *
 * The dialog reads the document before it writes it (`readMetadata`), and that
 * read is what makes "empty means unchanged" honest rather than accidental:
 *  - a filled field that already holds the same text is **not** a change, so the
 *    file is not rewritten for nothing (a rewrite ends the fast path, `PLAN.md
 *    §3.3` rule 3);
 *  - when nothing differs and no clean-up was asked for, the dialog produces no
 *    file at all and says so in its report instead of journaling an empty step.
 *
 * Prefilling the fields themselves is not possible: `FieldSpec` values are static
 * (`dialogs/types.ts`) and the host seeds them from the spec's defaults, so the
 * current values are stated in a `readOnlyText` note and in the fields' hints —
 * the one shape the frozen contract has for "your document already has this".
 */

import { type MetadataPatch, note, readMetadata, writeMetadata } from 'pdf-core';
import type { OperationDialogSpec } from '../dialogs/types';

export const propertiesDialog: OperationDialogSpec = {
  id: 'properties',
  titleKey: 'properties.title',
  introKey: 'properties.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    { id: 'keep', kind: 'readOnlyText', labelKey: 'properties.keep.title', valueKey: 'properties.keep.note' },
    {
      id: 'title',
      kind: 'text',
      labelKey: 'properties.field.title',
      hintKey: 'properties.field.keepHint',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'author',
      kind: 'text',
      labelKey: 'properties.field.author',
      hintKey: 'properties.field.keepHint',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'subject',
      kind: 'text',
      labelKey: 'properties.field.subject',
      hintKey: 'properties.field.keepHint',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'keywords',
      kind: 'text',
      labelKey: 'properties.field.keywords',
      hintKey: 'properties.field.keywordsHint',
      defaultValue: '',
      maxLength: 500,
    },
    {
      id: 'creator',
      advanced: true,
      kind: 'text',
      labelKey: 'properties.field.creator',
      hintKey: 'properties.field.keepHint',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'creationDate',
      advanced: true,
      kind: 'text',
      labelKey: 'properties.field.creationDate',
      hintKey: 'properties.field.dateHint',
      defaultValue: '',
      maxLength: 40,
    },
    {
      id: 'modificationDate',
      advanced: true,
      kind: 'text',
      labelKey: 'properties.field.modificationDate',
      hintKey: 'properties.field.dateHint',
      defaultValue: '',
      maxLength: 40,
    },
    {
      id: 'writeXmp',
      advanced: true,
      kind: 'checkbox',
      labelKey: 'properties.writeXmp',
      hintKey: 'properties.writeXmpHint',
      defaultValue: false,
    },
    {
      id: 'clean',
      advanced: true,
      kind: 'checkboxList',
      labelKey: 'properties.clean.title',
      hintKey: 'properties.clean.warning',
      defaultValue: [],
      options: [
        { value: 'info', labelKey: 'properties.clean.info' },
        { value: 'xmp', labelKey: 'properties.clean.xmp' },
      ],
    },
  ],
  run: async (params, context) => {
    const current = await readMetadata(context.bytes);

    const text = {
      title: String(params.title ?? '').trim(),
      author: String(params.author ?? '').trim(),
      subject: String(params.subject ?? '').trim(),
      creator: String(params.creator ?? '').trim(),
      creationDate: String(params.creationDate ?? '').trim(),
      modificationDate: String(params.modificationDate ?? '').trim(),
    };
    const typedKeywords = String(params.keywords ?? '').trim();
    const keywords =
      typedKeywords === ''
        ? undefined
        : typedKeywords
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '');
    // Compared in the same shape the operation reads them back in, so "the user
    // typed what is already there" is one string comparison per field.
    const existingKeywords = (current.keywords ?? []).join(', ');

    const patch: MetadataPatch = {
      writeXmp: params.writeXmp === true,
      ...(text.title === '' || text.title === current.title ? {} : { title: text.title }),
      ...(text.author === '' || text.author === current.author ? {} : { author: text.author }),
      ...(text.subject === '' || text.subject === current.subject ? {} : { subject: text.subject }),
      ...(keywords === undefined || keywords.join(', ') === existingKeywords ? {} : { keywords }),
      ...(text.creator === '' || text.creator === current.creator ? {} : { creator: text.creator }),
      ...(text.creationDate === '' || text.creationDate === current.creationDate
        ? {}
        : { creationDate: text.creationDate }),
      ...(text.modificationDate === '' || text.modificationDate === current.modificationDate
        ? {}
        : { modificationDate: text.modificationDate }),
    };

    const clean = Array.isArray(params.clean) ? (params.clean as readonly string[]) : [];
    const cleanInfo = clean.includes('info');
    const cleanXmp = clean.includes('xmp');
    // `writeXmp` is always present in the patch and is not a change of its own.
    const changed = Object.keys(patch).length > 1 || cleanInfo || cleanXmp;

    if (!changed) {
      return {
        // No file: a `replace` result applies `files[0]`, so an empty list is how
        // this dialog says "nothing to write" without journaling an empty step.
        files: [],
        report: {
          engine: 'model',
          steps: [],
          notes: [note('warning', 'properties.noChange')],
          inputBytes: context.bytes.length,
          outputBytes: context.bytes.length,
          pageCount: context.pageCount,
          // Nothing was written, so the file format is untouched.
          incremental: true,
        },
        noticeKey: 'properties.noChange',
      };
    }

    const outcome = await writeMetadata(
      context.bytes,
      { patch, clean: cleanInfo, cleanXmp },
      {
        signal: context.signal,
        onProgress: context.onProgress,
      },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'properties.done',
    };
  },
};
