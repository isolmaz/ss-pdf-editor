/**
 * Two-tier limits and budgets.
 *
 * Desktop: warn at 1500 pages, hard ceiling 2000 pages / 300 MB.
 * Mobile: above ~300 pages / 64 MB the app switches to viewing mode, so it has no warning
 * of its own: a page count that would warn is already past the viewing-only line.
 * The 300 MB desktop ceiling is a *measured* number: revise the limits explicitly,
 * never silently.
 */

export type DeviceTier = 'desktop' | 'mobile';

export interface DocumentLimits {
  /** Above this the document opens with a warning; a tier that goes viewing-only first has none. */
  readonly warnPages?: number;
  readonly maxPages: number;
  readonly maxBytes: number;
  /** Render cache budget in bytes (LRU ceiling). */
  readonly renderCacheBytes: number;
  /** Above this the editor keeps opening but editing is disabled. */
  readonly viewingOnlyAbovePages?: number;
  readonly viewingOnlyAboveBytes?: number;
}

const MIB = 1024 * 1024;

export const LIMITS: Record<DeviceTier, DocumentLimits> = {
  desktop: {
    warnPages: 1500,
    maxPages: 2000,
    maxBytes: 300 * MIB,
    renderCacheBytes: 512 * MIB,
  },
  mobile: {
    maxPages: 2000,
    maxBytes: 300 * MIB,
    renderCacheBytes: 128 * MIB,
    viewingOnlyAbovePages: 300,
    viewingOnlyAboveBytes: 64 * MIB,
  },
};

/**
 * Build size targets. `pnpm check:budgets` (`tools/check-build-budgets.mjs`) gates the
 * first-paint JavaScript against `firstPaintJsGzipBytes`; the per-asset number is measured by
 * hand. `limits.test.ts` pins the numbers.
 */
export const BUILD_BUDGETS = {
  firstPaintJsGzipBytes: 250 * 1024,
  maxAssetBytes: 25 * MIB,
} as const;

export type LimitVerdict =
  | { kind: 'ok' }
  | { kind: 'warn'; reason: 'pages' }
  | { kind: 'viewing-only'; reason: 'pages' | 'bytes' }
  | { kind: 'blocked'; reason: 'pages' | 'bytes' };

/**
 * Decide what the two-tier limits say about a document. Pure and DOM-free so
 * both the UI and the model use exactly one rule set.
 */
export function checkDocumentLimits(tier: DeviceTier, pageCount: number, byteLength: number): LimitVerdict {
  const limits = LIMITS[tier];
  if (pageCount > limits.maxPages) return { kind: 'blocked', reason: 'pages' };
  if (byteLength > limits.maxBytes) return { kind: 'blocked', reason: 'bytes' };
  const viewingPages = limits.viewingOnlyAbovePages;
  const viewingBytes = limits.viewingOnlyAboveBytes;
  if (viewingPages !== undefined && pageCount > viewingPages)
    return { kind: 'viewing-only', reason: 'pages' };
  if (viewingBytes !== undefined && byteLength > viewingBytes)
    return { kind: 'viewing-only', reason: 'bytes' };
  const warnPages = limits.warnPages;
  if (warnPages !== undefined && pageCount > warnPages) return { kind: 'warn', reason: 'pages' };
  return { kind: 'ok' };
}

/**
 * Mobile Safari-class detection is advisory only; the UI always shows the tier.
 *
 * A mobile user agent is mobile. Without one, a touch-only screen is — its *primary* pointer
 * is coarse and no pointer it has is fine — but a touch-screen laptop is not: a mouse or
 * trackpad is a fine pointer, and `(pointer: coarse)` alone would put the whole desktop
 * session into the mobile tier (viewing-only above 300 pages / 64 MB).
 */
export function detectDeviceTier(): DeviceTier {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  const isMobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const touchOnly =
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches &&
    !matchMedia('(any-pointer: fine)').matches;
  return isMobileUa || touchOnly ? 'mobile' : 'desktop';
}
