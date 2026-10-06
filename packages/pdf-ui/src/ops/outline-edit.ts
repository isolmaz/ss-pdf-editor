/**
 * The outline dialog (`PLAN.md §5/Phase 4`: “Link & outline editing”).
 *
 * Four modes over one tree, because that is how an outline is actually edited: rewrite
 * the whole thing from a list (the paste-a-table case), append a child under a node,
 * rename one, delete one. The op underneath keeps `/First`/`/Last`/`/Next`/`/Prev` and
 * `/Count` correct and verifies the produced file by reading the outline back, so this
 * dialog owns only the one thing it can know: what the user typed.
 *
 * Paths are child indices joined with dots — `1.2` is the **first** top-level item's
 * **second** child, because both steps are 1-based (`ops/outline-edit.ts` resolves
 * 0-based child indices) — and empty means the top level. The field's placeholder shows
 * the form rather than describing it in prose.
 */

import type { OutlineEditRequest, OutlineNodeInput } from 'pdf-core/ops/outline-edit';
import { applyOutlineEdit } from 'pdf-core/ops/outline-edit';
import { ToolError } from 'pdf-shared';
import type { DialogParams, OperationDialogSpec } from '../dialogs/types';

/** `1.2` → `[0, 1]`; empty → `[]` (the top level). */
function parsePath(raw: string): readonly number[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  const steps: number[] = [];
  for (const part of trimmed.split('.')) {
    // `Number('1e2')` is 100 and `Number('0x2')` is 2: a path step is a typed integer,
    // so it is read as one instead of accepting every numeric notation JavaScript has.
    const text = part.trim();
    if (!/^\d+$/.test(text)) {
      throw new ToolError('value-out-of-range', {
        engine: 'ui',
        engineMessage: `outline path step "${part}" is not a 1-based index`,
      });
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ToolError('value-out-of-range', {
        engine: 'ui',
        engineMessage: `outline path step "${part}" is not a 1-based index`,
      });
    }
    steps.push(value - 1);
  }
  return steps;
}

/**
 * One node per line as `Title | page`. The page is 1-based because that is what the
 * user reads in the status bar; the op takes 0-based indices, which is why the
 * conversion happens here and nowhere else. A line without `|` is a title with no
 * destination — legal, and the op writes no `/Dest` for it.
 */
function parseNodes(raw: string): readonly OutlineNodeInput[] {
  const nodes: OutlineNodeInput[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const separator = trimmed.lastIndexOf('|');
    const title = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim();
    if (title === '') {
      throw new ToolError('selection-empty', {
        engine: 'ui',
        engineMessage: `outline line ${index + 1} has no title`,
      });
    }
    if (separator === -1) {
      nodes.push({ title, destination: null });
      continue;
    }
    const page = Number(trimmed.slice(separator + 1).trim());
    if (!Number.isInteger(page) || page < 1) {
      throw new ToolError('value-out-of-range', {
        engine: 'ui',
        engineMessage: `outline line ${index + 1} has page "${trimmed.slice(separator + 1).trim()}" (expected 1-based)`,
      });
    }
    nodes.push({ title, destination: { pageIndex: page - 1 } });
  }
  return nodes;
}

/**
 * A field the user must fill. Empty is `selection-empty`, the same code the list parser
 * uses for a line with no title: telling the user "this document cannot do that" for a
 * blank text box is a lie about the document (`PLAN.md §3.1`).
 */
function requireField(raw: string, field: string): string {
  const value = raw.trim();
  if (value === '') {
    throw new ToolError('selection-empty', { engine: 'ui', engineMessage: `${field} is empty` });
  }
  return value;
}

function requestFor(params: DialogParams): OutlineEditRequest {
  const mode = String(params.mode ?? 'add-child');
  const title = String(params.title ?? '').trim();
  switch (mode) {
    case 'add-child': {
      const page = Number(params.page ?? 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
        throw new ToolError('value-out-of-range', {
          engine: 'ui',
          engineMessage: `destination page ${String(params.page)} is not a 1-based page number`,
        });
      }
      return {
        kind: 'add-child',
        parentPath: parsePath(String(params.path ?? '')),
        node: { title: requireField(title, 'request.title'), destination: { pageIndex: page - 1 } },
      };
    }
    case 'rename':
      return {
        kind: 'rename',
        path: parsePath(requireField(String(params.path ?? ''), 'request.path')),
        title: requireField(title, 'request.title'),
      };
    case 'remove':
      return { kind: 'remove', path: parsePath(requireField(String(params.path ?? ''), 'request.path')) };
    case 'replace-all':
      return { kind: 'replace-all', nodes: parseNodes(String(params.nodes ?? '')) };
    default:
      // Every other mode is a request the dialog cannot build: silently running the
      // whole-tree rewrite for a value nobody offered would be the worst default.
      throw new ToolError('value-out-of-range', {
        engine: 'ui',
        engineMessage: `unknown outline mode "${mode}"`,
      });
  }
}

export const outlineEditDialog: OperationDialogSpec = {
  id: 'outline-edit',
  titleKey: 'outline.title',
  introKey: 'outline.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      kind: 'select',
      id: 'mode',
      labelKey: 'outline.field.mode',
      options: [
        { value: 'replace-all', labelKey: 'outline.mode.replaceAll' },
        { value: 'add-child', labelKey: 'outline.mode.addChild' },
        { value: 'rename', labelKey: 'outline.mode.rename' },
        { value: 'remove', labelKey: 'outline.mode.remove' },
      ],
      // `replace-all` with an empty list clears the outline, so it is not what an
      // unedited dialog submits: the first field decides, and the user chooses it.
      defaultValue: 'add-child',
    },
    {
      kind: 'multiline',
      id: 'nodes',
      labelKey: 'outline.field.nodes',
      hintKey: 'outline.field.nodesHint',
      defaultValue: '',
      rows: 10,
      visibleWhen: { field: 'mode', equals: ['replace-all'] },
    },
    {
      kind: 'text',
      id: 'path',
      labelKey: 'outline.field.path',
      hintKey: 'outline.field.pathHint',
      defaultValue: '',
      placeholderKey: 'outline.field.pathPlaceholder',
      visibleWhen: { field: 'mode', equals: ['add-child', 'rename', 'remove'] },
    },
    {
      kind: 'text',
      id: 'title',
      labelKey: 'outline.field.title',
      defaultValue: '',
      visibleWhen: { field: 'mode', equals: ['add-child', 'rename'] },
    },
    {
      kind: 'number',
      id: 'page',
      labelKey: 'outline.field.page',
      defaultValue: 1,
      min: 1,
      max: 100_000,
      visibleWhen: { field: 'mode', equals: ['add-child'] },
    },
  ],
  run: async (params, context) => {
    const request = requestFor(params);
    const outcome = await applyOutlineEdit(context.bytes, request, {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'outline.done',
    };
  },
};
