// @vitest-environment happy-dom
/**
 * The status bar states where the user is (page, zoom), which limit profile applies, what
 * the memory budget looks like, whether the session is sensitive, which limit the document
 * hit and what its signatures amount to — each as words, with nothing implied.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import type { SignatureVerification } from 'pdf-core/ops/signature-status';
import { createTranslator, type LimitVerdict } from 'pdf-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from './StatusBar';

const t = createTranslator('en');

afterEach(cleanup);

const signature = (overrides: Partial<SignatureVerification> = {}): SignatureVerification => ({
  fieldName: 'Sig1',
  subFilter: 'adbe.pkcs7.detached',
  signer: 'Alice',
  signedAt: '2026-05-01',
  integrity: 'valid',
  trust: 'trusted',
  revocation: 'not-revoked',
  coverage: 'covers-whole-document',
  changesAfterSigning: 0,
  trustPath: [],
  certificateValidity: 'valid',
  certificateNotBefore: null,
  certificateNotAfter: '2099-01-01T00:00:00.000Z',
  trustReason: null,
  reasonKey: 'props.sig.reason.valid',
  timestamp: null,
  revocationChecks: [],
  validationTime: null,
  validationTimeSource: 'clock',
  ...overrides,
});

function show(overrides: Partial<StatusBarProps> = {}) {
  const ok: LimitVerdict = { kind: 'ok' };
  return render(
    <StatusBar t={t} pageIndex={2} pageCount={10} zoom={1.25} tier="desktop" limits={ok} {...overrides} />,
  );
}

const bar = () => screen.getByRole('contentinfo');

describe('StatusBar page and zoom', () => {
  it('reads the page as "Page 3 of 10" and the zoom as a rounded percentage', () => {
    show({ zoom: 1.256 });
    expect(within(bar()).getByText('Page 3 of 10')).toBeTruthy();
    expect(within(bar()).getByText('126%')).toBeTruthy();
  });

  it('says "—" for both when no page is open', () => {
    show({ pageIndex: null, pageCount: null });
    expect(within(bar()).getAllByText('—')).toHaveLength(2);
  });

  it('says "—" for the page when the count is not known, yet keeps the zoom', () => {
    show({ pageIndex: 0, pageCount: null });
    expect(within(bar()).getByText('—')).toBeTruthy();
    expect(within(bar()).getByText('125%')).toBeTruthy();
  });

  it('shows the navigation controls instead of the plain readout when given', () => {
    show({ navigation: <button type="button">Go to page</button> });
    expect(within(bar()).getByRole('button', { name: 'Go to page' })).toBeTruthy();
    expect(within(bar()).queryByText('Page 3 of 10')).toBeNull();
    expect(within(bar()).queryByText('125%')).toBeNull();
  });

  it('always carries the privacy claim, with the full sentence as its title', () => {
    show();
    const claim = within(bar()).getByText('The document never leaves your device.');
    expect(claim.getAttribute('title')).toBe('The document never leaves your device.');
  });
});

describe('StatusBar limit profile', () => {
  it('names the desktop profile with its hint', () => {
    show({ tier: 'desktop' });
    const badge = within(bar()).getByText('Desktop limits');
    expect(badge.parentElement?.getAttribute('title')).toBe(t('shell.deviceTier.desktopHint'));
  });

  it('names the mobile profile with its hint', () => {
    show({ tier: 'mobile' });
    const badge = within(bar()).getByText('Mobile limits');
    expect(badge.parentElement?.getAttribute('title')).toBe(t('shell.deviceTier.mobileHint'));
  });
});

describe('StatusBar limit verdict', () => {
  it.each<[LimitVerdict, string | null]>([
    [{ kind: 'ok' }, null],
    [{ kind: 'warn', reason: 'pages' }, 'Large document: editing may feel slower.'],
    [
      { kind: 'viewing-only', reason: 'bytes' },
      'This document is large for mobile; editing is off, viewing stays on.',
    ],
    [{ kind: 'blocked', reason: 'pages' }, 'The document exceeds the page limit.'],
    [{ kind: 'blocked', reason: 'bytes' }, 'The document exceeds the size limit.'],
  ])('%j states %j', (limits, sentence) => {
    show({ limits });
    const sentences = [
      'Large document: editing may feel slower.',
      'This document is large for mobile; editing is off, viewing stays on.',
      'The document exceeds the page limit.',
      'The document exceeds the size limit.',
    ];
    const shown = sentences.filter((text) => within(bar()).queryByText(text) !== null);
    expect(shown).toEqual(sentence === null ? [] : [sentence]);
  });
});

describe('StatusBar signatures', () => {
  it('says nothing for a document with no signature', () => {
    show({ signatures: [] });
    expect(within(bar()).queryByText(/signature|Signatures|modification/i)).toBeNull();
  });

  it('counts the signatures when they all verify and nothing was written after them', () => {
    show({ signatures: [signature(), signature({ fieldName: 'Sig2' })] });
    expect(within(bar()).getByText('Signatures: 2').className).toContain('text-kumo-subtle');
  });

  it('counts the revisions after the newest signature when there are some', () => {
    show({ signatures: [signature({ changesAfterSigning: 1 }), signature({ changesAfterSigning: 3 })] });
    expect(within(bar()).getByText('3 modification(s) after signing').className).toContain(
      'text-kumo-warning',
    );
  });

  it('says a signature cannot be verified when any of them is invalid, ahead of the other facts', () => {
    show({ signatures: [signature({ integrity: 'invalid', changesAfterSigning: 2 }), signature()] });
    expect(within(bar()).getByText('Signature cannot be verified').className).toContain('text-kumo-danger');
    expect(within(bar()).queryByText(/modification/)).toBeNull();
  });
});

describe('StatusBar memory meter', () => {
  const meter = () => bar().querySelector('[title^="Memory:"]') as HTMLElement;
  const fill = () => meter().querySelector('[style]') as HTMLElement;
  const MB = 1024 * 1024;

  it('is absent without a memory reading', () => {
    show();
    expect(bar().querySelector('[title^="Memory:"]')).toBeNull();
  });

  it('reads kilobytes below a megabyte and megabytes above, with the used share as a percentage', () => {
    show({ memoryUsage: { usedBytes: 512 * 1024, budgetBytes: 2 * MB } });
    expect(meter().getAttribute('title')).toBe('Memory: 512 KB / 2.0 MB (%25)');
    expect(within(meter()).getByText('512 KB / 2.0 MB')).toBeTruthy();
    expect(fill().style.width).toBe('25%');
  });

  it.each([
    [0.5, 'bg-pdf-accent'],
    [0.75, 'bg-kumo-warning'],
    [0.89, 'bg-kumo-warning'],
    [0.9, 'bg-kumo-danger'],
    [1.5, 'bg-kumo-danger'],
  ])('fills at %s of the budget with %s', (ratio, tone) => {
    show({ memoryUsage: { usedBytes: ratio * 100 * MB, budgetBytes: 100 * MB } });
    expect(fill().className).toContain(tone);
    expect(fill().style.width).toBe(`${Math.min(100, Math.round(ratio * 100))}%`);
  });

  it('shows an empty bar for a budget of zero instead of dividing by it', () => {
    show({ memoryUsage: { usedBytes: 5 * MB, budgetBytes: 0 } });
    expect(meter().getAttribute('title')).toBe('Memory: 5.0 MB / 0 KB (%0)');
    expect(fill().style.width).toBe('0%');
    expect(fill().className).toContain('bg-pdf-accent');
  });
});

describe('StatusBar sensitive session', () => {
  it('states it when active and is silent otherwise', () => {
    const view = show({ sensitive: true });
    expect(within(bar()).getByText('Sensitive session: persistent draft disabled.')).toBeTruthy();
    view.unmount();

    show();
    expect(screen.queryByText('Sensitive session: persistent draft disabled.')).toBeNull();
  });
});
