/**
 * The link dialog (“Link & outline editing”).
 *
 * A link is added over a rectangle the user dragged: `ops/link-edit.ts` takes that
 * rectangle in the space a drag on the rendered page measures in, and the annotation
 * layer hands it over through the run context (`link`). So this dialog asks only for
 * what a drag cannot say — where the link goes — and reads nothing from the document.
 *
 * The rectangle is not part of the file the user sees twice: the link writer writes an
 * `/A` action with a visible border, which is what Acrobat's own link tool writes.
 */

import type { LinkDestination } from 'pdf-core/ops/link-edit';
import { applyLinkEdit } from 'pdf-core/ops/link-edit';
import { ToolError } from 'pdf-shared';
import type { DialogParams, OperationDialogSpec, OpRunContext } from '../dialogs/types';

function destinationFor(params: DialogParams): LinkDestination {
  const kind = String(params.kind ?? 'uri');
  if (kind === 'page') {
    const page = Number(params.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
      throw new ToolError('value-out-of-range', {
        engine: 'ui',
        engineMessage: `link destination page ${String(params.page)} is not a 1-based page number`,
      });
    }
    return { kind: 'page', pageIndex: page - 1 };
  }
  if (kind !== 'uri') {
    throw new ToolError('value-out-of-range', {
      engine: 'ui',
      engineMessage: `unknown link target "${kind}"`,
    });
  }
  const uri = String(params.uri ?? '').trim();
  if (uri === '') {
    throw new ToolError('selection-empty', { engine: 'ui', engineMessage: 'request.uri is empty' });
  }
  return { kind: 'uri', uri };
}

export const linkAddDialog: OperationDialogSpec = {
  id: 'link-add',
  titleKey: 'link.title',
  introKey: 'link.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      kind: 'radio',
      id: 'kind',
      labelKey: 'link.field.kind',
      options: [
        { value: 'uri', labelKey: 'link.kind.uri' },
        { value: 'page', labelKey: 'link.kind.page' },
      ],
      defaultValue: 'uri',
      columns: 2,
    },
    {
      kind: 'text',
      id: 'uri',
      labelKey: 'link.field.uri',
      defaultValue: '',
      placeholderKey: 'link.field.uriPlaceholder',
      visibleWhen: { field: 'kind', equals: ['uri'] },
    },
    {
      kind: 'number',
      id: 'page',
      labelKey: 'link.field.page',
      defaultValue: 1,
      min: 1,
      max: 100_000,
      visibleWhen: { field: 'kind', equals: ['page'] },
    },
  ],
  run: async (params, context: OpRunContext) => {
    const target = context.link;
    if (target === undefined) {
      // The dialog is only reachable through the drag that fills this, so a missing
      // rectangle is a broken host rather than a user error — and it must refuse
      // instead of inventing a rectangle somewhere on the page.
      throw new ToolError('internal', {
        engine: 'ui',
        engineMessage: 'no rectangle was handed to the link dialog',
      });
    }
    const outcome = await applyLinkEdit(
      context.bytes,
      { add: [{ target, destination: destinationFor(params) }] },
      { signal: context.signal, onProgress: context.onProgress },
    );
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'link.done',
    };
  },
};
