/**
 * Shared fixture recipe constants for spike #5 (throwaway — `PLAN.md §9/K21`).
 *
 * The fixture PDF is built **in Node** (`make-fixture.mjs`) and the page only
 * measures it, so the AcroForm field name/value travel between the two sides
 * through this one file instead of being written down twice.
 */

/** Text field the save step fills; `saveDocument()` on an empty storage returns nothing to measure. */
export const FIELD_NAME = 'spike5.note';
export const FIELD_INITIAL_VALUE = 'spike-5 initial value';
export const FIELD_SAVED_VALUE = 'spike-5 saved value';

/** A4 in PDF points — the fixture page size. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
