/**
 * Editability measurement — `PLAN.md §5/Phase 4b`: *which text is really editable?*
 * and, for the answer that is "editable, but not in its own font", the `4e` product
 * expectation. Non-editable blocks come back as `not-editable` so the UI can mark
 * them with its red frame; nothing here is silent.
 *
 * ## Why the answer is a name test and not a font inspection
 *
 * The extractor reports a font *name*, not an embedding flag, and no font programme
 * is readable in a useful way anyway: the spike measured that a font read back from a
 * saved file answers glyph id 0 for **every** character, so the original programme is
 * never reused and every edit round embeds a fresh one (archived spike `text-replace/NOTES.md`,
 * round-2 variant A). Editability therefore asks the only question that has an
 * answer: *can we reproduce this block's face, or does the block need a substitute?*
 *
 * The verdict ladder (`verdictOf`), first match wins — the order is the order the
 * facts matter, most fundamental first:
 *
 *   1. `no-glyphs` → **not-editable**. Nothing to edit.
 *   2. `rotated` → **not-editable** (`vertical`/`reversed` lines). The write path
 *      draws horizontal lines only, so a rotated block would be re-written at the
 *      wrong angle — and the spike solved rotation by carrying a direction vector,
 *      which the writer's request type does not have
 *      (archived spike `text-replace/replace.ts:74-95`, `placement.dir`).
 *   3. `skewed` → **not-editable**. A slightly rotated baseline cannot be reproduced
 *      horizontally, and a "small" skew is exactly what a user notices as damage.
 *   4. `type3` → **not-editable**. Type3 text is vector artwork with a font-like
 *      wrapper; re-rendering it as text changes the drawing itself.
 *   5. `standard-font` → **substituted**. A base-14 face is never embedded, and we do
 *      not write base-14 text: the built-in faces carry no Turkish diacritics
 *      (`tools/fetch-engines.mjs:122-126`).
 *   6. `embedded-font` → **substituted**. An embedded programme we do not ship —
 *      subset or not, it cannot be extended, and its glyphs for new characters
 *      simply are not in the file (`4e`'s expectation-setting).
 *   7. `ok` → **editable**. The block's face is one this package ships
 *      (`DEFAULT_FONT_CANDIDATES`), so re-rendering reproduces family, weight and
 *      italic exactly.
 *
 * `scanned` and `image-only` are page-level answers (see `EditabilityReport.pageReason`):
 * they describe a page with no text layer, which carries no block to attach a
 * verdict to.
 */
import { candidateMatchesFontName, DEFAULT_FONT_CANDIDATES, describeFontName } from './fonts';
import { blockOrientation } from './model';
import type { BlockEditability, EditabilityReport, TextBlock, TextPage } from './types';

/** Per-block verdicts plus the page-level answer. */
export function measureEditability(page: TextPage): EditabilityReport {
  const blocks = page.blocks.map(verdictOf);
  let editableCount = 0;
  for (const block of blocks) {
    if (block.verdict !== 'not-editable') editableCount += 1;
  }
  return {
    pageIndex: page.pageIndex,
    blocks,
    editableCount,
    nonEditableCount: blocks.length - editableCount,
    pageReason:
      page.blocks.length === 0
        ? 'scanned'
        : blocks.every((block) => block.reason === 'no-glyphs')
          ? 'image-only'
          : 'ok',
  };
}

function verdictOf(block: TextBlock): BlockEditability {
  const fontName = block.style.fontName;
  const info = describeFontName(fontName ?? '');
  // A subset prefix is proof of embedding; a base-14 name is proof of the opposite
  // (the reader supplies the programme); anything else is assumed embedded, which is
  // the safe direction — see `describeFontName`.
  const fontEmbedded = info.subset || !info.standard14;
  const hasGlyphs = block.lines.some((line) => line.words.some((word) => word.glyphs.length > 0));
  if (!hasGlyphs) {
    return {
      blockId: block.id,
      verdict: 'not-editable',
      reason: 'no-glyphs',
      fontEmbedded,
      substitutionRequired: false,
    };
  }
  const orientation = blockOrientation(block);
  if (orientation === 'vertical' || orientation === 'reversed') {
    return {
      blockId: block.id,
      verdict: 'not-editable',
      reason: 'rotated',
      fontEmbedded,
      substitutionRequired: false,
    };
  }
  if (orientation === 'skewed') {
    return {
      blockId: block.id,
      verdict: 'not-editable',
      reason: 'skewed',
      fontEmbedded,
      substitutionRequired: false,
    };
  }
  if (info.type3) {
    return {
      blockId: block.id,
      verdict: 'not-editable',
      reason: 'type3',
      fontEmbedded,
      substitutionRequired: false,
    };
  }
  if (info.standard14) {
    return {
      blockId: block.id,
      verdict: 'substituted',
      reason: 'standard-font',
      fontEmbedded,
      substitutionRequired: true,
    };
  }
  // The one test that can say "we ship this programme ourselves": the reported name
  // is one of the catalogue's faces *and* the style agrees with it on every axis.
  const reproducesFace =
    fontName !== null &&
    DEFAULT_FONT_CANDIDATES.some(
      (candidate) =>
        candidateMatchesFontName(candidate, fontName) &&
        candidate.family === block.style.fontFamily &&
        candidate.bold === block.style.bold &&
        candidate.italic === block.style.italic,
    );
  if (reproducesFace) {
    return {
      blockId: block.id,
      verdict: 'editable',
      reason: 'ok',
      fontEmbedded,
      substitutionRequired: false,
    };
  }
  return {
    blockId: block.id,
    verdict: 'substituted',
    reason: 'embedded-font',
    fontEmbedded,
    substitutionRequired: true,
  };
}
