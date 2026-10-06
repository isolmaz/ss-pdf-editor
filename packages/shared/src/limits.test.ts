import { describe, expect, it, vi } from 'vitest';
import { BUILD_BUDGETS, checkDocumentLimits, detectDeviceTier, LIMITS } from './limits';

/**
 * The two-tier limits. A wrong verdict here either
 * blocks a document the app could open or lets a document through that will
 * exhaust the tab, so the boundaries are tested on both tiers.
 */

const MIB = 1024 * 1024;

describe('checkDocumentLimits', () => {
  it('accepts an ordinary desktop document', () => {
    expect(checkDocumentLimits('desktop', 40, 8 * MIB)).toEqual({ kind: 'ok' });
  });

  it('warns before the desktop ceiling instead of blocking', () => {
    expect(checkDocumentLimits('desktop', LIMITS.desktop.warnPages + 1, 20 * MIB)).toEqual({
      kind: 'warn',
      reason: 'pages',
    });
  });

  it('blocks above the desktop page ceiling', () => {
    expect(checkDocumentLimits('desktop', LIMITS.desktop.maxPages + 1, 20 * MIB)).toEqual({
      kind: 'blocked',
      reason: 'pages',
    });
  });

  it('blocks above the desktop byte ceiling', () => {
    expect(checkDocumentLimits('desktop', 10, LIMITS.desktop.maxBytes + 1)).toEqual({
      kind: 'blocked',
      reason: 'bytes',
    });
  });

  it('switches a large mobile document to viewing mode by pages and by bytes', () => {
    expect(checkDocumentLimits('mobile', 400, 20 * MIB)).toEqual({ kind: 'viewing-only', reason: 'pages' });
    expect(checkDocumentLimits('mobile', 100, 80 * MIB)).toEqual({ kind: 'viewing-only', reason: 'bytes' });
  });

  it('keeps a small mobile document editable', () => {
    expect(checkDocumentLimits('mobile', 200, 30 * MIB)).toEqual({ kind: 'ok' });
  });

  it('keeps the first-paint budget the build is measured against', () => {
    expect(BUILD_BUDGETS.firstPaintJsGzipBytes).toBe(250 * 1024);
    expect(BUILD_BUDGETS.maxAssetBytes).toBe(25 * MIB);
  });

  it('pins the contract numbers themselves, not values read back from the table under test', () => {
    expect(LIMITS.desktop).toMatchObject({ warnPages: 1500, maxPages: 2000, maxBytes: 300 * MIB });
    expect(LIMITS.mobile).toMatchObject({
      warnPages: 300,
      maxPages: 2000,
      maxBytes: 300 * MIB,
      viewingOnlyAbovePages: 300,
      viewingOnlyAboveBytes: 64 * MIB,
    });
  });

  it('draws the desktop lines exactly: at a limit is fine, one past it is not', () => {
    expect(checkDocumentLimits('desktop', 1500, 10 * MIB)).toEqual({ kind: 'ok' });
    expect(checkDocumentLimits('desktop', 1501, 10 * MIB)).toEqual({ kind: 'warn', reason: 'pages' });
    expect(checkDocumentLimits('desktop', 2000, 10 * MIB)).toEqual({ kind: 'warn', reason: 'pages' });
    expect(checkDocumentLimits('desktop', 2001, 10 * MIB)).toEqual({ kind: 'blocked', reason: 'pages' });
    expect(checkDocumentLimits('desktop', 10, 300 * MIB)).toEqual({ kind: 'ok' });
    expect(checkDocumentLimits('desktop', 10, 300 * MIB + 1)).toEqual({ kind: 'blocked', reason: 'bytes' });
  });

  it('draws the mobile lines exactly, by pages and by bytes', () => {
    expect(checkDocumentLimits('mobile', 300, 10 * MIB)).toEqual({ kind: 'ok' });
    expect(checkDocumentLimits('mobile', 301, 10 * MIB)).toEqual({ kind: 'viewing-only', reason: 'pages' });
    expect(checkDocumentLimits('mobile', 10, 64 * MIB)).toEqual({ kind: 'ok' });
    expect(checkDocumentLimits('mobile', 10, 64 * MIB + 1)).toEqual({
      kind: 'viewing-only',
      reason: 'bytes',
    });
    expect(checkDocumentLimits('mobile', 2000, 10 * MIB)).toEqual({ kind: 'viewing-only', reason: 'pages' });
    expect(checkDocumentLimits('mobile', 2001, 10 * MIB)).toEqual({ kind: 'blocked', reason: 'pages' });
    expect(checkDocumentLimits('mobile', 10, 300 * MIB)).toEqual({ kind: 'viewing-only', reason: 'bytes' });
    expect(checkDocumentLimits('mobile', 10, 300 * MIB + 1)).toEqual({ kind: 'blocked', reason: 'bytes' });
  });

  it('blocks on the hard ceiling even when the document would also be view-only', () => {
    expect(checkDocumentLimits('mobile', 2001, 80 * MIB)).toEqual({ kind: 'blocked', reason: 'pages' });
    expect(checkDocumentLimits('mobile', 400, 300 * MIB + 1)).toEqual({ kind: 'blocked', reason: 'bytes' });
    expect(checkDocumentLimits('desktop', 2001, 300 * MIB + 1)).toEqual({ kind: 'blocked', reason: 'pages' });
  });

  it('keeps the landing-page budget as well', () => {
    expect(BUILD_BUDGETS.firstPaintLandingBytes).toBe(60 * 1024);
  });
});

describe('detectDeviceTier', () => {
  const tierFor = (userAgent: string | undefined, coarsePointer: boolean) => {
    vi.stubGlobal('navigator', userAgent === undefined ? undefined : { userAgent });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: coarsePointer && query === '(pointer: coarse)',
    }));
    try {
      return detectDeviceTier();
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it('is desktop without a navigator, desktop for a desktop agent, mobile for a mobile agent or a coarse pointer', () => {
    expect(tierFor(undefined, false)).toBe('desktop');
    expect(tierFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false)).toBe('desktop');
    expect(tierFor('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', false)).toBe('mobile');
    expect(tierFor('Mozilla/5.0 (Linux; Android 14)', false)).toBe('mobile');
    expect(tierFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', true)).toBe('mobile');
  });
});
