/**
 * The pinned Noto Sans program, fetched from our own origin — the one face every text
 * this app draws into a document is written with.
 *
 * Why it matters: the standard 14 fonts use WinAnsi encoding, which has no `ş ğ ı İ`;
 * the source project stamped and watermarked with a standard font and silently produced
 * broken Turkish (`REPORT.md §3` A9/A10).
 *
 * The bytes are engine-neutral, so they live here rather than in one engine's adapter:
 * the MuPDF writers (`engines/mupdf-write.ts`) embed them and the text model measures
 * them, and the session cache is shared between the two.
 */

import { ToolError } from 'pdf-shared';
import { NOTO_ASSETS } from '../assets';

const fontCache = new Map<boolean, Promise<Uint8Array>>();

/**
 * The pinned Noto Sans bytes. Fetched from our own origin once and kept for the
 * session: the app makes no third-party request (`K9`), so a missing asset is an
 * `asset-missing` error the offline readiness screen can act on — not a silent
 * fallback to a font that cannot spell Turkish.
 *
 * A **failed** fetch is not cached: an offline blip while embedding the first stamp
 * would otherwise fail every later font use in the session. The key is dropped only
 * while it still holds the request that failed, so a newer request for the same
 * face survives an older rejection.
 */
export function notoSansBytes(bold = false): Promise<Uint8Array> {
  const cached = fontCache.get(bold);
  if (cached !== undefined) return cached;
  const url = bold ? NOTO_ASSETS.semiBold : NOTO_ASSETS.regular;
  const request = fetch(url).then(async (response) => {
    if (!response.ok) {
      throw new ToolError('asset-missing', {
        engine: 'fs',
        path: url,
        engineMessage: `font asset responded ${response.status}`,
      });
    }
    return new Uint8Array(await response.arrayBuffer());
  });
  fontCache.set(bold, request);
  request.catch(() => {
    if (fontCache.get(bold) === request) fontCache.delete(bold);
  });
  return request;
}
