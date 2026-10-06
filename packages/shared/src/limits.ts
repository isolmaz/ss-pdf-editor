/**
 * Two-tier limits and budgets.
 *
 * Desktop: warn at 1500 pages, hard ceiling 2000 pages / 300 MB.
 * Mobile: above ~300 pages / 64 MB the app switches to viewing mode.
 * The 300 MB desktop target is a *measured* number: spike #5 confirms it or
 * the limits are revised explicitly — never silently.
 */

export type DeviceTier = 'desktop' | 'mobile';

export interface DocumentLimits {
  readonly warnPages: number;
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
    warnPages: 300,
    maxPages: 2000,
    maxBytes: 300 * MIB,
    renderCacheBytes: 128 * MIB,
    viewingOnlyAbovePages: 300,
    viewingOnlyAboveBytes: 64 * MIB,
  },
};

/**
 * Build size targets, measured by hand. No script or gate checks the build against them;
 * `limits.test.ts` only pins the numbers.
 */
export const BUILD_BUDGETS = {
  firstPaintJsGzipBytes: 250 * 1024,
  firstPaintLandingBytes: 60 * 1024,
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
  if (pageCount > limits.warnPages) return { kind: 'warn', reason: 'pages' };
  return { kind: 'ok' };
}

/** Mobile Safari-class detection is advisory only; the UI always shows the tier. */
export function detectDeviceTier(): DeviceTier {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  const isMobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return isMobileUa || coarsePointer ? 'mobile' : 'desktop';
}
