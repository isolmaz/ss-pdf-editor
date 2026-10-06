/**
 * Page-scope resolution shared by every dialog spec (`dialogs/types.ts`).
 *
 * The field renderer (`dialogs/fields.tsx`) hands a `pageScope` back as one
 * string in exactly four forms — `'all'`, `'current'`, `'selection'` or
 * `'range:<text>'` — and every capability then has the same two questions to
 * answer: *which 0-based pages* does that mean, and *what range text* do I give
 * an operation that takes a string.
 *
 * Both answers come from `pdf-core/ops/page-ranges.ts` and never from a second
 * parser: `parsePageRanges` owns the syntax (Turkish errors, duplicates
 * rejected, out-of-range reported), `validateRanges` owns
 * the document bound. A capability that parsed the string itself would be the
 * fifth parser in the tree, and the first one to disagree about `1,1`.
 */

import { formatPageRanges, parsePageRanges, validateRanges } from 'pdf-core';
import { ToolError } from 'pdf-shared';
import type { FieldValue, OpRunContext } from '../dialogs/types';

/** The prefix that marks a `pageScope` value as the raw text the user typed. */
const RANGE_PREFIX = 'range:';

/** Unparsable scope strings are impossible through the renderer, so they fail loudly here. */
function refuse(scope: string, engineMessage: string): never {
  throw new ToolError('range-invalid', { engine: 'ui', engineMessage, path: scope });
}

/**
 * Resolve a `pageScope` field value into 0-based pages, ascending and unique.
 *
 * `'selection'` with nothing selected is a `selection-empty` failure rather than
 * an empty list: every caller would otherwise hand an engine a page set could
 * not act on, and the user would read the engine's version of that sentence.
 */
export function resolveScope(value: FieldValue | undefined, context: OpRunContext): readonly number[] {
  // A missing field or a value of the wrong kind means the whole document, which
  // is also the renderer's own default (`initialParams`).
  const scope = typeof value === 'string' ? value : 'all';
  const { pageCount } = context;
  if (pageCount <= 0) {
    throw new ToolError('selection-empty', { engine: 'ui', engineMessage: 'the document has no pages' });
  }

  switch (scope) {
    case 'all':
      return Array.from({ length: pageCount }, (_unused, page) => page);

    case 'current': {
      const { currentPage } = context;
      if (currentPage < 0 || currentPage >= pageCount) {
        refuse(scope, `current page ${currentPage} is outside the ${pageCount}-page document`);
      }
      return [currentPage];
    }

    case 'selection': {
      if (context.selectedPages.length === 0) {
        throw new ToolError('selection-empty', {
          engine: 'ui',
          engineMessage: 'page scope "selection" with an empty selection',
        });
      }
      for (const page of context.selectedPages) {
        if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
          refuse(scope, `selected page ${page} is outside the ${pageCount}-page document`);
        }
      }
      return [...new Set(context.selectedPages)].sort((left, right) => left - right);
    }

    default: {
      const text = scope.startsWith(RANGE_PREFIX) ? scope.slice(RANGE_PREFIX.length) : scope;
      return validateRanges(parsePageRanges(text, pageCount), pageCount).pages;
    }
  }
}

/**
 * The same scope as range text, for operations that take an expression
 * (`SplitOptions.ranges`). Canonical form: the validated page set, formatted by
 * `formatPageRanges`, so the dialog and the operation cannot disagree about what
 * the user asked for — the operation re-parses this string, and a typo'd
 * duplicate the parser rejected once can never reappear in it.
 */
export function scopeRangeText(value: FieldValue | undefined, context: OpRunContext): string {
  return formatPageRanges(resolveScope(value, context));
}
