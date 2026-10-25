/**
 * Redaction.
 *
 * The marks this dialog erases are the rectangles the user drew on the page
 * (`context.redactions`, gathered by `ops/RedactionLayer.tsx`), and they are read
 * here rather than derived: the marks and the erasure have to be the same
 * geometry (`dialogs/types.ts`).
 *
 * *Not* exposed: "find text and mark" (a pattern find). A
 * `RedactRect` is a rectangle in MuPDF page points, while `searchPdfText` returns
 * character offsets in the extracted text (`pageIndex`, `index`, `length`,
 * `snippet`) — the two cannot be connected without text geometry, and pdf-core
 * exposes none: measuring a match means calling MuPDF's `page.search` and taking
 * the union of the hit's quads, which is engine work that belongs in a core
 * operation (`searchTextRects`), not in a dialog (the dialog layer never touches
 * MuPDF, `dialogs/types.ts`). Until that operation exists a search field here
 * could not produce a single mark, so the dialog ships without it and the page
 * scope that would have scoped the search is absent for the same reason — the
 * marks carry their own page, and `RedactOptions` has no page set to fill.
 */

import { note, redactDocument } from 'pdf-core';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';

/**
 * The `imageMethod` values are MuPDF's own redaction constants
 * (`applyRedactions(..., REDACT_IMAGE_*)`):
 * `0` leaves images alone, `1` removes a whole image the mark touches, `2` clears
 * only the pixels inside the box.
 */
const IMAGE_METHOD: Record<string, 0 | 1 | 2> = {
  none: 0,
  remove: 1,
  pixels: 2,
};

/**
 * `textMethod: 0` is `REDACT_TEXT_REMOVE` in the same engine, and the
 * only value that means "redact": the other one leaves the text under the mark in
 * the file. Redaction with text left in place is not a capability the product
 * offers, so this is a constant rather than a field.
 */
const TEXT_METHOD = 0;

export const redactDialog: OperationDialogSpec = {
  id: 'redact',
  titleKey: 'redact.title',
  introKey: 'redact.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  // True erasure: the glyphs are removed from the file, not covered.
  destructive: true,
  fields: [
    {
      id: 'imageMethod',
      kind: 'radio',
      labelKey: 'redact.imageMethod',
      hintKey: 'redact.imageMethodHint',
      defaultValue: 'none',
      options: [
        { value: 'none', labelKey: 'redact.imageMethod.none' },
        { value: 'remove', labelKey: 'redact.imageMethod.remove' },
        { value: 'pixels', labelKey: 'redact.imageMethod.pixels' },
      ],
    },
    {
      id: 'clean',
      kind: 'checkboxList',
      labelKey: 'redact.cleanMetadata',
      hintKey: 'redact.cleanHint',
      defaultValue: [],
      options: [
        { value: 'info', labelKey: 'redact.cleanInfo' },
        { value: 'attachments', labelKey: 'redact.cleanAttachments' },
      ],
    },
  ],
  run: async (params, context) => {
    const marks = [...(context.redactions ?? [])];
    if (marks.length === 0) {
      // The dialog's confirm button cannot be disabled for this (`fieldErrors`
      // covers page scopes and number ranges, `dialogs/fields.tsx`), so the guard
      // sits at the top of the run, before any engine work: an empty mark list
      // would otherwise be a full write that erases nothing.
      throw new ToolError('selection-empty', {
        engine: 'ui',
        engineMessage: 'redact: no marks were drawn',
      });
    }

    const clean = Array.isArray(params.clean) ? (params.clean as readonly string[]) : [];

    const outcome = await redactDocument(
      context.bytes,
      {
        marks,
        imageMethod: IMAGE_METHOD[String(params.imageMethod)] ?? 0,
        textMethod: TEXT_METHOD,
        cleanMetadata: clean.includes('info'),
        // "Attachments (all)": the attached files of the name tree, the `/AF` lists and the
        // file-attachment annotations — the engine finds them in the file itself, not through a
        // list this dialog would read first.
        cleanAttachments: clean.includes('attachments'),
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    // `redactDocument` throws `verification-failed` when a mark still holds text, an annotation or a
    // form field, or when a pattern or soft mask of a marked page shows text, so a result that got
    // here is a verified one: there is no failed or partial verification to report.
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: {
        ...outcome.report,
        notes: [
          ...outcome.report.notes,
          note('changed', 'redact.markCount', { count: marks.length }),
          // The verification is the operation's measurement of the *produced* bytes; the
          // notice repeats it because it is the one sentence a redaction must not leave
          // to the report panel.
          note('preserved', 'redact.verify.done'),
          // A clean export does not imply the local traces are gone.
          note('warning', 'redact.warning.localTrace'),
        ],
      },
      noticeKey: 'redact.verify.done',
    };
  },
};
