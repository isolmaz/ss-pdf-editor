/**
 * The text-edit dialog.
 *
 * The whole manoeuvre is three calls, and the order is the plan's: the model block
 * is reflowed **inside its own box** (`4d-1`), the layout is turned into the
 * writer's serializable request (`planTextEdit`), and the writer erases the old
 * glyphs for real and draws the new ones with a freshly embedded font (`4c`, `4e`).
 * The dialog owns none of that logic — it owns the fields, the dictionary text and
 * the one thing only the UI knows: which block the user pointed at.
 *
 * The selected block travels in the run context (`OpRunContext.textEdit`), filled by
 * `App.tsx` when the text tool hands over a block. It is read here and never
 * re-derived: reading the document again would edit whatever the bytes say now
 * instead of the paragraph the user clicked.
 */

import type { OperationReport, OutputFile } from 'pdf-core';
import { applyTextEdit } from 'pdf-core/ops/text-edit';
import { TEXT_FONT_FILES } from 'pdf-core/text-source';
import { ToolError } from 'pdf-shared';
import type { FontCandidate, TextPage } from 'pdf-text-engine';
import { matchFont, planTextEdit } from 'pdf-text-engine';
import type { DialogParams, OperationDialogSpec, OpRunContext } from '../dialogs/types';

/** The face the user asked for, or the best match for the block's own style. */
function faceFor(
  choice: string,
  selection: NonNullable<OpRunContext['textEdit']>,
  text: string,
): FontCandidate {
  if (choice !== 'auto') {
    const named = selection.fonts.catalog.candidates.find((candidate) => candidate.id === choice);
    if (named !== undefined) return named;
  }
  return matchFont(selection.block.style, text, selection.fonts.catalog).font;
}

/** The model with the block's colour replaced — the one style value the plan reads. */
function withColor(page: TextPage, blockId: string, color: string): TextPage {
  if (color === '') return page;
  return {
    ...page,
    blocks: page.blocks.map((block) =>
      block.id === blockId && block.style.color !== color
        ? { ...block, style: { ...block.style, color } }
        : block,
    ),
  };
}

export const textEditDialog: OperationDialogSpec = {
  id: 'text-edit',
  titleKey: 'textedit.title',
  introKey: 'textedit.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  destructive: false,
  /**
   * The block the user pointed at is the dialog's starting state: its own text, its
   * own alignment, size, leading and colour. A dialog that opened on generic defaults
   * would ask the user to re-type the paragraph they selected.
   */
  initialValues: (context): DialogParams => {
    const selection = context.textEdit;
    if (selection === undefined) return {};
    return {
      text: selection.block.text,
      align: selection.block.align,
      fontSize: selection.block.style.fontSize,
      leading: selection.block.style.leading,
      color: selection.block.style.color,
    };
  },
  fields: [
    {
      kind: 'multiline',
      id: 'text',
      labelKey: 'textedit.field.text',
      hintKey: 'textedit.field.textHint',
      defaultValue: '',
      rows: 8,
    },
    {
      kind: 'select',
      id: 'align',
      labelKey: 'textedit.field.align',
      options: [
        { value: 'left', labelKey: 'textedit.align.left' },
        { value: 'center', labelKey: 'textedit.align.center' },
        { value: 'right', labelKey: 'textedit.align.right' },
        { value: 'justify', labelKey: 'textedit.align.justify' },
      ],
      defaultValue: 'left',
    },
    {
      kind: 'number',
      id: 'fontSize',
      labelKey: 'textedit.field.fontSize',
      defaultValue: 12,
      min: 4,
      max: 200,
      step: 0.5,
      unitKey: 'textedit.unit.pt',
    },
    {
      kind: 'number',
      id: 'leading',
      labelKey: 'textedit.field.leading',
      defaultValue: 14,
      min: 4,
      max: 400,
      step: 0.5,
      unitKey: 'textedit.unit.pt',
    },
    {
      kind: 'select',
      id: 'font',
      labelKey: 'textedit.field.font',
      options: [
        { value: 'auto', labelKey: 'textedit.font.auto' },
        { value: 'noto-sans', labelKey: 'textedit.font.notoSans' },
        { value: 'noto-sans-semibold', labelKey: 'textedit.font.notoSansSemibold' },
      ],
      defaultValue: 'auto',
    },
    {
      kind: 'color',
      id: 'color',
      labelKey: 'textedit.field.color',
      defaultValue: '#000000',
    },
    {
      kind: 'checkbox',
      id: 'hyphenate',
      labelKey: 'textedit.field.hyphenate',
      defaultValue: false,
    },
  ],
  run: async (params, context) => {
    const selection = context.textEdit;
    if (selection === undefined) {
      throw new ToolError('selection-empty', { engine: 'model' });
    }
    const text = String(params.text ?? '').trim();
    const align = String(params.align ?? selection.block.align);
    const fontSize = Number(params.fontSize ?? selection.block.style.fontSize);
    const leading = Number(params.leading ?? selection.block.style.leading);
    const color = String(params.color ?? selection.block.style.color);
    const hyphenate = params.hyphenate === true;
    const face = faceFor(String(params.font ?? 'auto'), selection, text);
    const metrics = selection.fonts.metrics[face.id];
    if (metrics === undefined) {
      throw new ToolError('font-missing', {
        engine: 'pdf-text-engine',
        engineMessage: `no metric table for face ${face.id}`,
      });
    }

    context.onProgress({ phase: 'reflow', labelKey: 'op.progress.textEdit.layout' });
    const request = planTextEdit(
      {
        page: withColor(selection.model, selection.block.id, color),
        blockId: selection.block.id,
        replacement: text,
        options: {
          align: align as 'left' | 'center' | 'right' | 'justify',
          fontSize,
          leading,
          hyphenate,
        },
        font: face,
      },
      metrics,
    );
    // The writer fetches the font from our own origin; the id → path map is
    // the served catalogue, never a third-party URL.
    const outcome = await applyTextEdit(
      context.bytes,
      { ...request, fonts: TEXT_FONT_FILES },
      {
        signal: context.signal,
        onProgress: context.onProgress,
      },
    );
    const report: OperationReport = outcome.report;
    const files: readonly OutputFile[] = [
      { name: context.name, bytes: outcome.bytes, mime: 'application/pdf' },
    ];
    return {
      files,
      report,
      noticeKey: 'textedit.done',
      noticeParams: { count: request.insert[0]?.lines.length ?? 0 },
    };
  },
};
