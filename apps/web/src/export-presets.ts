/**
 * What the export dialog's "Compressed PDF" level means for the Optimize form.
 *
 * The level fills the form's own fields (so the three levels do not all open the same
 * form); the user can still change them before running it. The dialog names them by what
 * they give:
 *
 *  - low, "Higher quality" — lossless structure rewrite; the document's text, links and
 *    metadata stay.
 *  - medium, "Balanced" — the same rewrite, and the Info metadata is cleared too.
 *  - high, "Smaller file" — pages become images (the form's own warning says what that
 *    costs) at a reduced resolution and JPEG quality.
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
