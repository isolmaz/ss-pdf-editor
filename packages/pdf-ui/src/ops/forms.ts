/**
 * Form dialogs.
 *
 * Three capabilities, three dialogs, one shape — the dialog contract: a spec plus
 * a `run` that receives frozen bytes and returns produced files with a report.
 *
 * The framework has no dynamic field list (`dialogs/types.ts` is a static
 * `FieldSpec[]`, and the host seeds it from the declared defaults), so a dialog
 * cannot render one row per form field the way the panel does. The honest
 * consequence is stated in each `introKey`: the inventory is **read from the
 * document and reported**, and the dialog takes the edits as text. A dialog that
 * pretended to show fields it cannot show would be worse than one that says where
 * they are.
 */

import {
  applyCalculations,
  createFormFields,
  exportFormData,
  type FormCalculation,
  type FormFieldInfo,
  type FormFill,
  fillFormFields,
  flattenForm,
  importFormData,
  note,
  readFormFields,
  setFieldFlags,
  validateField,
} from 'pdf-core';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

/** Cap so one paste cannot ask for a thousand widgets in one run. */
const MAX_CREATED_FIELDS = 200;

/**
 * `ad=Ada Lovelace` lines → fills.
 *
 * One assignment per line; `true`/`false` become a checkbox, a comma-separated
 * value becomes a multi-select, and everything else is text. A line without `=`
 * is a mistake the user should read about rather than have silently ignored, so it
 * fails before any engine work with the line number in the engine message.
 */
function parseFills(text: string): readonly FormFill[] {
  const fills: FormFill[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `form fill line ${index + 1} has no "name=value" assignment`,
      });
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.length === 0) {
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `form fill line ${index + 1} has an empty field name`,
      });
    }
    if (value === 'true') fills.push({ name, value: true });
    else if (value === 'false') fills.push({ name, value: false });
    else if (value.includes(',')) fills.push({ name, value: value.split(',').map((part) => part.trim()) });
    else fills.push({ name, value });
  }
  return fills;
}

/** `total = a + b * 2` lines → calculations. */
function parseCalculations(text: string): readonly FormCalculation[] {
  const calculations: FormCalculation[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `calculation line ${index + 1} has no "target = expression" form`,
      });
    }
    calculations.push({
      target: line.slice(0, separator).trim(),
      expression: line.slice(separator + 1).trim(),
    });
  }
  return calculations;
}

/** One line naming what the document already declares — the dialog's inventory. */
function inventoryNote(fields: readonly FormFieldInfo[]): string {
  return fields
    .slice(0, 40)
    .map((field) => `${field.name} [${field.kind}]`)
    .join(', ');
}

/**
 * Form v2 — filling, validation, locking and calculation fields.
 *
 * `run` is a small pipeline rather than one operation, because the four writes
 * share one document load: fills first (the values), then the calculations (which
 * read those values), then the flags (which do not depend on either).
 */
export const formFieldsDialog: OperationDialogSpec = {
  id: 'form-fields',
  titleKey: 'form.dialog.fields.title',
  introKey: 'form.dialog.fields.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      id: 'fills',
      kind: 'text',
      labelKey: 'form.dialog.fills',
      hintKey: 'form.dialog.fillsHint',
      defaultValue: '',
      maxLength: 4000,
      tokens: [{ token: '=', labelKey: 'form.dialog.tokenEquals' }],
    },
    {
      id: 'calculations',
      kind: 'text',
      labelKey: 'form.dialog.calculations',
      hintKey: 'form.dialog.calculationsHint',
      defaultValue: '',
      maxLength: 2000,
    },
    {
      id: 'lock',
      kind: 'checkbox',
      labelKey: 'form.dialog.lock',
      hintKey: 'form.dialog.lockHint',
      defaultValue: false,
    },
    {
      id: 'validateOnly',
      kind: 'checkbox',
      labelKey: 'form.dialog.validateOnly',
      hintKey: 'form.dialog.validateOnlyHint',
      defaultValue: true,
    },
  ],
  run: async (params, context) => {
    const fields = await readFormFields(context.bytes, context.signal);
    const inventory = inventoryNote(fields);
    const fills = parseFills(String(params.fills ?? ''));
    const calculations = parseCalculations(String(params.calculations ?? ''));

    // Validation runs first and always: a value that cannot be written must be
    // reported before the document is touched, not after half of the fills landed.
    const byName = new Map(fields.map((field) => [field.name, field]));
    const refused: string[] = [];
    for (const fill of fills) {
      const field = byName.get(fill.name);
      if (field === undefined) {
        refused.push(fill.name);
        continue;
      }
      const verdict = validateField(field, fill.value);
      if (!verdict.ok) refused.push(fill.name);
    }
    if (refused.length > 0 && params.validateOnly === true) {
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `form validation refused: ${refused.join(', ')} (inventory: ${inventory})`,
      });
    }

    if (params.validateOnly === true && fills.length + calculations.length === 0) {
      return {
        files: [],
        report: {
          engine: 'model',
          steps: [],
          notes: [
            note('preserved', 'form.note.inventory', { count: fields.length }),
            ...(refused.length === 0 ? [note('preserved', 'form.note.valid')] : []),
            ...(refused.length === 0
              ? []
              : [note('warning', 'form.note.refused', { count: refused.length })]),
          ],
          inputBytes: context.bytes.length,
          outputBytes: context.bytes.length,
          pageCount: context.pageCount,
          incremental: true,
        },
        noticeKey: 'form.note.inventory',
        noticeParams: { count: fields.length },
      };
    }

    let bytes = context.bytes;
    let steps: string[] = [];
    const notes = [note('preserved', 'form.note.inventory', { count: fields.length })];

    if (fills.length > 0) {
      const filled = await fillFormFields(bytes, fills, {
        signal: context.signal,
        onProgress: context.onProgress,
      });
      bytes = filled.bytes;
      steps = [...steps, ...filled.report.steps];
      notes.push(...filled.report.notes);
    }
    if (calculations.length > 0) {
      const calculated = await applyCalculations(bytes, calculations, {
        signal: context.signal,
        onProgress: context.onProgress,
      });
      bytes = calculated.bytes;
      steps = [...steps, ...calculated.report.steps];
      notes.push(...calculated.report.notes);
    }
    if (params.lock === true && fills.length > 0) {
      const locked = await setFieldFlags(
        bytes,
        fills.map((fill) => fill.name),
        { readOnly: true },
        { signal: context.signal, onProgress: context.onProgress },
      );
      bytes = locked.bytes;
      steps = [...steps, ...locked.report.steps];
      notes.push(...locked.report.notes);
    }

    return {
      files: [{ name: context.name, bytes, mime: 'application/pdf' }],
      report: {
        engine: 'mupdf',
        steps,
        notes,
        inputBytes: context.bytes.length,
        outputBytes: bytes.length,
        pageCount: context.pageCount,
        incremental: false,
      },
      noticeKey: 'form.note.filled',
      noticeParams: { count: fills.length },
    };
  },
};

/**
 * Field creation.
 *
 * The rectangle is entered in points rather than dragged on the page: a drag
 * gesture for a widget belongs to a tool layer, and this dialog's job is the
 * creation itself (the field list, the appearance font and the AcroForm entry).
 */
export const createFieldDialog: OperationDialogSpec = {
  id: 'form-create-field',
  titleKey: 'form.dialog.create.title',
  introKey: 'form.dialog.create.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      id: 'kind',
      kind: 'radio',
      labelKey: 'form.dialog.kind',
      defaultValue: 'text',
      columns: 3,
      options: [
        { value: 'text', labelKey: 'form.kind.text' },
        { value: 'checkbox', labelKey: 'form.kind.checkbox' },
        { value: 'dropdown', labelKey: 'form.kind.dropdown' },
        { value: 'radio', labelKey: 'form.kind.radio' },
        { value: 'optionlist', labelKey: 'form.kind.optionlist' },
      ],
    },
    {
      id: 'name',
      kind: 'text',
      labelKey: 'form.dialog.name',
      hintKey: 'form.dialog.nameHint',
      defaultValue: 'field1',
      maxLength: 120,
    },
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'current' },
    {
      id: 'x',
      kind: 'number',
      labelKey: 'form.dialog.x',
      defaultValue: 72,
      min: 0,
      max: 2000,
      step: 1,
      unitKey: 'unit.pt',
    },
    {
      id: 'y',
      kind: 'number',
      labelKey: 'form.dialog.y',
      defaultValue: 700,
      min: 0,
      max: 2000,
      step: 1,
      unitKey: 'unit.pt',
    },
    {
      id: 'width',
      kind: 'number',
      labelKey: 'form.dialog.width',
      defaultValue: 200,
      min: 8,
      max: 2000,
      step: 1,
      unitKey: 'unit.pt',
    },
    {
      id: 'height',
      kind: 'number',
      labelKey: 'form.dialog.height',
      defaultValue: 24,
      min: 8,
      max: 2000,
      step: 1,
      unitKey: 'unit.pt',
    },
    {
      id: 'defaultValue',
      advanced: true,
      kind: 'text',
      labelKey: 'form.dialog.defaultValue',
      defaultValue: '',
      maxLength: 300,
    },
    {
      id: 'options',
      kind: 'text',
      labelKey: 'form.dialog.options',
      hintKey: 'form.dialog.optionsHint',
      defaultValue: '',
      maxLength: 500,
      visibleWhen: { field: 'kind', equals: ['dropdown', 'radio', 'optionlist'] },
    },
    {
      id: 'fontSize',
      advanced: true,
      kind: 'number',
      labelKey: 'form.dialog.fontSize',
      defaultValue: 12,
      min: 4,
      max: 72,
      step: 1,
    },
    { id: 'required', kind: 'checkbox', labelKey: 'form.field.required', defaultValue: false },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const pageIndex = pages[0];
    if (pageIndex === undefined) {
      throw new ToolError('selection-empty', { engine: 'ui', engineMessage: 'no page selected' });
    }
    if (pages.length > MAX_CREATED_FIELDS) {
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `${pages.length} pages selected, over the ${MAX_CREATED_FIELDS} field ceiling`,
      });
    }
    const options = String(params.options ?? '')
      .split(',')
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
    const kind = String(params.kind ?? 'text');
    const kindAllowed =
      kind === 'text' ||
      kind === 'checkbox' ||
      kind === 'dropdown' ||
      kind === 'radio' ||
      kind === 'optionlist';
    if (!kindAllowed) {
      throw new ToolError('value-out-of-range', {
        engine: 'ui',
        engineMessage: `unknown field kind: ${kind}`,
      });
    }

    const outcome = await createFormFields(
      context.bytes,
      pages.map((page) => ({
        kind: kind as 'text' | 'checkbox' | 'dropdown' | 'radio' | 'optionlist',
        name: pages.length === 1 ? String(params.name) : `${String(params.name)}${page + 1}`,
        pageIndex: page,
        rect: [Number(params.x), Number(params.y), Number(params.width), Number(params.height)],
        defaultValue: String(params.defaultValue ?? ''),
        ...(options.length === 0 ? {} : { options }),
        fontSize: Number(params.fontSize),
        required: params.required === true,
      })),
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'form.note.created',
      noticeParams: { count: pages.length },
    };
  },
};

/**
 * Form data interchange, and the contract's one awkward fit.
 *
 * `resultKind: 'download'` writes files and touches nothing; `'replace'` applies
 * the result to the document. An **import** is a state change and an **export** is
 * a file, so no single `resultKind` covers both. The dialog declares `'replace'`
 * and the export run overrules it for its own result with `deliver: 'download'`:
 * the host then downloads the data file by name and leaves the document alone.
 */
export const formDataDialog: OperationDialogSpec = {
  id: 'form-data',
  titleKey: 'form.dialog.data.title',
  introKey: 'form.dialog.data.intro',
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
      id: 'format',
      kind: 'radio',
      labelKey: 'form.dialog.format',
      defaultValue: 'json',
      options: [
        { value: 'json', labelKey: 'form.dialog.format.json' },
        { value: 'fdf', labelKey: 'form.dialog.format.fdf' },
      ],
    },
    {
      id: 'flatten',
      kind: 'checkbox',
      labelKey: 'form.dialog.flatten',
      hintKey: 'form.dialog.flattenHint',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['import'] },
    },
    {
      id: 'file',
      kind: 'files',
      labelKey: 'form.dialog.file',
      hintKey: 'form.dialog.fileHint',
      accept: '.fdf,.json,application/json,application/vnd.fdf',
      multiple: false,
      visibleWhen: { field: 'mode', equals: ['import'] },
    },
  ],
  run: async (params, context) => {
    const format = params.format === 'fdf' ? 'fdf' : 'json';
    if (params.mode === 'export') {
      const exported = await exportFormData(context.bytes, format, context.signal);
      return {
        files: [{ name: exported.name, bytes: exported.bytes, mime: exported.mime }],
        report: {
          engine: 'model',
          steps: ['form.export'],
          notes: [
            note('preserved', 'form.note.exported', { count: exported.fields }),
            note('warning', 'form.note.exportIsData'),
          ],
          inputBytes: context.bytes.length,
          outputBytes: exported.bytes.length,
          pageCount: context.pageCount,
          incremental: true,
        },
        noticeKey: 'form.note.exported',
        noticeParams: { count: exported.fields },
        deliver: 'download',
      };
    }

    const file = Array.isArray(params.file) ? (params.file[0] as File | undefined) : undefined;
    if (file === undefined) {
      throw new ToolError('input-missing', { engine: 'ui', engineMessage: 'no form-data file chosen' });
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const imported = await importFormData(context.bytes, data, format, {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    let bytes = imported.bytes;
    const notes = [...imported.report.notes];
    let steps = [...imported.report.steps];
    if (params.flatten === true) {
      const flattened = await flattenForm(bytes, null, {
        signal: context.signal,
        onProgress: context.onProgress,
      });
      bytes = flattened.bytes;
      steps = [...steps, ...flattened.report.steps];
      notes.push(...flattened.report.notes);
    }
    if (imported.missing.length > 0) {
      notes.push(note('warning', 'form.note.missing', { count: imported.missing.length }));
    }
    return {
      files: [{ name: context.name, bytes, mime: 'application/pdf' }],
      report: {
        engine: 'mupdf',
        steps,
        notes,
        inputBytes: context.bytes.length,
        outputBytes: bytes.length,
        pageCount: context.pageCount,
        incremental: false,
      },
      noticeKey: 'form.note.imported',
      noticeParams: { count: imported.applied },
    };
  },
};

/** Exported so the dialog registry and the tests speak the same ids. */
export const FORM_DIALOG_IDS: readonly MessageKey[] = [
  'form.dialog.fields.title',
  'form.dialog.create.title',
  'form.dialog.data.title',
];
