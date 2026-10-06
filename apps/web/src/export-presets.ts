/**
 * What the export dialog's "Compressed PDF" level means for the Optimize form.
 *
 * The dialog used to read the level and drop it, so HIGH, MEDIUM and LOW all opened the
 * same form. The level now fills the form's own fields, which the user can still change
 * before running it:
 *
 *  - LOW — lossless structure rewrite; the document's text, links and metadata stay.
 *  - MEDIUM — the same rewrite, and the Info metadata is cleared too.
 *  - HIGH — pages become images (the form's own warning says what that costs) at a
 *    reduced resolution and JPEG quality.
 */

import type { FieldValue } from 'pdf-ui';

export type CompressionLevel = 'high' | 'medium' | 'low';

export function compressionPresets(level: string | undefined): Readonly<Record<string, FieldValue>> {
  switch (level) {
    case 'high':
      return { mode: 'raster', dpi: 110, quality: 0.5 };
    case 'medium':
      return { mode: 'structure', stripMetadata: true };
    default:
      return { mode: 'structure', stripMetadata: false };
  }
}
