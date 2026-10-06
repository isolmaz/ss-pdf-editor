/**
 * Sanitise the document (`pdf-core/ops/sanitize.ts`).
 *
 * One dialog, one operation: the categories are checkboxes, with what *hides* things on and
 * what is *content* (external links, comments, form fields) off. The result **replaces** the
 * working document — it is a new version in the journal, so undo brings the original back —
 * and the report lists, per category, what was found and removed and that the output was read
 * back to prove it.
 */

import { type SanitizeOptions, sanitizeDocument } from 'pdf-core/ops/sanitize';
import type { OperationDialogSpec } from '../dialogs/types';

/** Dialog values to the operation's options; a value the dialog never offers reads as off. */
function optionsFrom(params: Readonly<Record<string, unknown>>): SanitizeOptions {
  const chosen = new Set(Array.isArray(params.remove) ? (params.remove as readonly string[]) : []);
  const forms = params.forms === 'flatten' || params.forms === 'remove' ? params.forms : 'keep';
  return {
    javascript: chosen.has('javascript'),
    files: chosen.has('files'),
    metadata: chosen.has('metadata'),
    privateData: chosen.has('private'),
    thumbnails: chosen.has('thumbnails'),
    layers: chosen.has('layers'),
    links: chosen.has('links'),
    comments: chosen.has('comments'),
    forms,
  };
}

export const sanitizeDialog: OperationDialogSpec = {
  id: 'sanitize',
  titleKey: 'sanitize.title',
  introKey: 'sanitize.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  // The removed content is gone from the new version for good; undo returns the old one.
  destructive: true,
  fields: [
    {
      id: 'remove',
      kind: 'checkboxList',
      labelKey: 'sanitize.remove',
      hintKey: 'sanitize.removeHint',
      defaultValue: ['javascript', 'files', 'metadata', 'private', 'thumbnails', 'layers'],
      options: [
        { value: 'javascript', labelKey: 'sanitize.opt.javascript' },
        { value: 'files', labelKey: 'sanitize.opt.files' },
        { value: 'metadata', labelKey: 'sanitize.opt.metadata' },
        { value: 'private', labelKey: 'sanitize.opt.private' },
        { value: 'thumbnails', labelKey: 'sanitize.opt.thumbnails' },
        { value: 'layers', labelKey: 'sanitize.opt.layers' },
        { value: 'links', labelKey: 'sanitize.opt.links' },
        { value: 'comments', labelKey: 'sanitize.opt.comments' },
      ],
    },
    {
      id: 'forms',
      kind: 'radio',
      labelKey: 'sanitize.forms',
      hintKey: 'sanitize.formsHint',
      defaultValue: 'keep',
      options: [
        { value: 'keep', labelKey: 'sanitize.forms.keep' },
        { value: 'flatten', labelKey: 'sanitize.forms.flatten' },
        { value: 'remove', labelKey: 'sanitize.forms.remove' },
      ],
    },
  ],
  run: async (params, context) => {
    const outcome = await sanitizeDocument(context.bytes, optionsFrom(params), {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    // Unused objects are the save's housekeeping, not something the user chose to remove.
    const removed = outcome.counts
      .filter((entry) => entry.category !== 'unused')
      .reduce((sum, entry) => sum + entry.removed, 0);
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'sanitize.done',
      noticeParams: { count: removed },
    };
  },
};
