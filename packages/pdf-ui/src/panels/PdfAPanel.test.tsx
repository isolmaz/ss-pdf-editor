// @vitest-environment happy-dom
/**
 * The PDF/A panel: pressing Check reads the current bytes and shows what the checker found,
 * keeping broken rules, rules that could not be checked, passing rules and rules that do not
 * apply apart; the level to check against is the reader's choice; a failed read is a message,
 * never a half result. The checker has its own suite against real bytes, so it answers here
 * with the reports its contract describes.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type * as PdfACheckModule from 'pdf-core/ops/pdfa-check';
import type { PdfACheckReport, PdfARuleResult } from 'pdf-core/ops/pdfa-check';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfAPanel, type PdfAPanelProps } from './PdfAPanel';

const { checkPdfA } = vi.hoisted(() => ({ checkPdfA: vi.fn() }));
vi.mock('pdf-core/ops/pdfa-check', async (importOriginal) => ({
  ...(await importOriginal<typeof PdfACheckModule>()),
  checkPdfA,
}));

const t = createTranslator('en');
const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => checkPdfA.mockReset());
afterEach(cleanup);

const rule = (id: PdfARuleResult['id'], state: PdfARuleResult['state'], count = 0, samples = []) =>
  ({ id, state, count, samples }) as PdfARuleResult;

const NOT_CHECKED = ['pdfa.notChecked.fontPrograms', 'pdfa.notChecked.iccBody'];

function reportOf(overrides: Partial<PdfACheckReport>): PdfACheckReport {
  return {
    verdict: 'claims-and-meets',
    claim: { part: '2', conformance: 'B' },
    target: { part: 2, conformance: 'B' },
    targetFromClaim: true,
    rules: [],
    violations: 0,
    pageCount: 3,
    checked: [],
    unchecked: [],
    notChecked: NOT_CHECKED,
    ...overrides,
  };
}

function show(props: Partial<PdfAPanelProps> = {}) {
  const read = vi.fn(async () => BYTES);
  const onNotice = vi.fn();
  const view = render(<PdfAPanel t={t} read={read} onNotice={onNotice} {...props} />);
  return { read, onNotice, ...view, user: userEvent.setup() };
}

const check = (user: UserEvent) => user.click(screen.getByRole('button', { name: 'Check' }));

describe('PdfAPanel before a check', () => {
  it('invites the reader to check and prints the not-a-full-validation statement', () => {
    show();
    expect(screen.getByText(t('pdfa.panel.empty'))).toBeTruthy();
    expect(screen.getByText(t('pdfa.panel.disclaimer'))).toBeTruthy();
  });

  it('offers "Save as PDF/A" only when the shell gives a way into it, and calls it on press', async () => {
    const withoutConvert = show();
    expect(screen.queryByRole('button', { name: t('pdfa.panel.convert') })).toBeNull();
    withoutConvert.unmount();

    const onConvert = vi.fn();
    const { user } = show({ onConvert });
    await user.click(screen.getByRole('button', { name: t('pdfa.panel.convert') }));
    expect(onConvert).toHaveBeenCalledOnce();
  });

  it('works without a notice line', async () => {
    checkPdfA.mockResolvedValue(reportOf({}));
    const { user } = show({ onNotice: undefined });
    await check(user);
    expect(await screen.findByText(t('pdfa.verdict.claims-and-meets', { level: 'PDF/A-2b' }))).toBeTruthy();
  });
});

describe('PdfAPanel level choice', () => {
  it('checks what the file claims by default and the chosen part when the reader picks one', async () => {
    checkPdfA.mockResolvedValue(reportOf({}));
    const { user, read } = show();

    await check(user);
    await screen.findByText(t('pdfa.panel.notChecked'));
    expect(checkPdfA).toHaveBeenLastCalledWith(BYTES, {}, expect.any(AbortSignal));

    await user.selectOptions(screen.getByRole('combobox', { name: t('pdfa.panel.target') }), '3');
    await check(user);
    await screen.findByText(t('pdfa.panel.notChecked'));
    expect(checkPdfA).toHaveBeenLastCalledWith(BYTES, { part: 3 }, expect.any(AbortSignal));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('hands the read and the checker one signal that is aborted once the check ended', async () => {
    checkPdfA.mockResolvedValue(reportOf({}));
    const { user, read } = show();
    await check(user);
    await screen.findByText(t('pdfa.panel.notChecked'));
    const [context] = read.mock.calls[0] as unknown as [{ signal: AbortSignal }];
    expect(context.signal).toBe(checkPdfA.mock.calls[0]?.[2]);
    expect(context.signal.aborted).toBe(true);
  });
});

describe('PdfAPanel while checking', () => {
  it('shows a skeleton, disables the controls, and shows the result when the checker answers', async () => {
    const { promise, resolve: finish } = Promise.withResolvers<PdfACheckReport>();
    checkPdfA.mockReturnValue(promise);
    const { user, container } = show({ onConvert: () => {} });
    await check(user);

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText(t('pdfa.panel.empty'))).toBeNull();
    expect(screen.getByRole('button', { name: 'Check' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: t('pdfa.panel.convert') }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('combobox', { name: t('pdfa.panel.target') }).hasAttribute('disabled')).toBe(
      true,
    );

    await act(async () => finish(reportOf({})));
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps the earlier result on screen while a second check runs', async () => {
    checkPdfA.mockResolvedValueOnce(reportOf({ pageCount: 7 }));
    const { user, container } = show();
    await check(user);
    await screen.findByText(/^7 page\(s\)/);

    checkPdfA.mockReturnValueOnce(Promise.withResolvers<PdfACheckReport>().promise);
    await check(user);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByText(/^7 page\(s\)/)).toBeTruthy();
  });
});

describe('PdfAPanel failures', () => {
  it('says what went wrong and tells the shell when the bytes cannot be read', async () => {
    const read = vi.fn(async () => {
      throw new Error('disk gone');
    });
    const { user, onNotice } = show({ read });
    await check(user);

    const message = t('error.internal.message');
    expect(await screen.findByText(message)).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(message);
    expect(screen.queryByText(t('pdfa.panel.empty'))).toBeNull();
    expect(screen.getByRole('button', { name: 'Check' }).hasAttribute('disabled')).toBe(false);
  });

  it('clears the message when the next check succeeds', async () => {
    checkPdfA.mockRejectedValueOnce(new Error('boom'));
    const { user } = show();
    await check(user);
    await screen.findByText(t('error.internal.message'));

    checkPdfA.mockResolvedValueOnce(reportOf({}));
    await check(user);
    await screen.findByText(t('pdfa.panel.notChecked'));
    expect(screen.queryByText(t('error.internal.message'))).toBeNull();
  });

  it('survives a failure without a notice line', async () => {
    checkPdfA.mockRejectedValueOnce(new Error('boom'));
    const { user } = show({ onNotice: undefined });
    await check(user);
    expect(await screen.findByText(t('error.internal.message'))).toBeTruthy();
  });

  it('says nothing about a check that finishes after the panel is gone', async () => {
    const gate = Promise.withResolvers<Uint8Array>();
    const { user, onNotice, unmount } = show({ read: () => gate.promise });
    await check(user);
    unmount();
    gate.reject(new Error('late'));
    await sleep(0);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('does not show a result that arrives after the panel is gone', async () => {
    const { promise, resolve: finish } = Promise.withResolvers<PdfACheckReport>();
    checkPdfA.mockReturnValue(promise);
    const { user, unmount } = show();
    await check(user);
    unmount();
    await act(async () => finish(reportOf({})));
    expect(screen.queryByText(t('pdfa.panel.notChecked'))).toBeNull();
  });
});

describe('PdfAPanel verdicts', () => {
  const run = async (report: PdfACheckReport) => {
    checkPdfA.mockResolvedValue(report);
    const shown = show();
    await check(shown.user);
    await screen.findByText(t('pdfa.panel.disclaimer'));
    return shown;
  };

  it('says an unreadable file was not checked, without a summary or a list of rules', async () => {
    await run(reportOf({ verdict: 'unreadable', claim: null, pageCount: 0 }));
    expect(await screen.findByText(t('pdfa.verdict.unreadable'))).toBeTruthy();
    expect(screen.queryByText(/rule\(s\) checked/)).toBeNull();
  });

  it('says a file without a claim was checked against the default level anyway', async () => {
    await run(
      reportOf({
        verdict: 'no-claim',
        claim: null,
        target: { part: 2, conformance: 'B' },
        violations: 4,
        checked: ['fonts', 'layers'],
      }),
    );
    expect(await screen.findByText(t('pdfa.verdict.no-claim'))).toBeTruthy();
    expect(screen.getByText('It was checked against PDF/A-2b anyway: 4 violation(s) found.')).toBeTruthy();
    expect(screen.getByText('3 page(s) · 2 rule(s) checked · 4 violation(s)')).toBeTruthy();
  });

  it('names the claimed level, lower-casing the conformance letter', async () => {
    await run(reportOf({ claim: { part: '3', conformance: 'U' } }));
    expect(
      await screen.findByText('The file says it is PDF/A-3u and breaks none of the rules checked.'),
    ).toBeTruthy();
  });

  it('names a claim without part or conformance with a question mark', async () => {
    await run(reportOf({ claim: { part: null, conformance: null } }));
    expect(
      await screen.findByText('The file says it is PDF/A-? and breaks none of the rules checked.'),
    ).toBeTruthy();
  });

  it('counts the broken rules when a claiming file breaks some', async () => {
    await run(
      reportOf({
        verdict: 'claims-with-violations',
        claim: { part: '1', conformance: 'B' },
        target: { part: 1, conformance: 'B' },
        violations: 2,
        rules: [rule('fonts', 'fail', 2, [])],
      }),
    );
    expect(await screen.findByText('The file says it is PDF/A-1b but breaks 2 rule(s).')).toBeTruthy();
  });

  it('counts the broken rules for a claim missing its part and conformance', async () => {
    await run(
      reportOf({
        verdict: 'claims-with-violations',
        claim: { part: null, conformance: null },
        violations: 1,
        rules: [rule('fonts', 'fail', 1, [])],
      }),
    );
    expect(await screen.findByText('The file says it is PDF/A-? but breaks 1 rule(s).')).toBeTruthy();
  });

  it('lists what the check never looks at, whatever the verdict', async () => {
    await run(reportOf({}));
    const section = screen.getByRole('heading', { name: t('pdfa.panel.notChecked') }).closest('section');
    expect(section).not.toBeNull();
    const items = within(section as HTMLElement).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      t('pdfa.notChecked.fontPrograms'),
      t('pdfa.notChecked.iccBody'),
    ]);
  });
});

describe('PdfAPanel rule groups', () => {
  const groupedReport = reportOf({
    verdict: 'claims-with-violations',
    violations: 12,
    rules: [
      rule('fonts', 'fail', 11, [
        { pageIndex: 0, detail: 'Helvetica' },
        { pageIndex: 4 },
        { detail: 'Courier' },
        {},
      ] as never),
      rule('layers', 'unchecked'),
      rule('forms', 'pass'),
      rule('xmp-info', 'na'),
    ],
  });

  const run = async (report: PdfACheckReport) => {
    checkPdfA.mockResolvedValue(report);
    const { user } = show();
    await check(user);
    await screen.findByText(t('pdfa.panel.disclaimer'));
  };

  const groupOf = (title: string) =>
    screen.getByRole('heading', { name: title }).closest('section') as HTMLElement;

  it('titles every non-empty group with its size, in order, and omits the empty ones', async () => {
    await run(groupedReport);
    const titles = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent);
    expect(titles).toEqual([
      'Rules that are broken (1)',
      'Rules that could not be checked (1)',
      'Rules that pass (1)',
      'Rules that do not apply to this level (1)',
      t('pdfa.panel.notChecked'),
    ]);

    cleanup();
    await run(reportOf({ rules: [rule('forms', 'pass')] }));
    expect(screen.queryByRole('heading', { name: /Rules that are broken/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Rules that pass (1)' })).toBeTruthy();
  });

  it('describes a broken rule by its count, clause, samples and the number left out', async () => {
    await run(groupedReport);
    const broken = groupOf('Rules that are broken (1)');
    expect(within(broken).getByText('11×')).toBeTruthy();
    expect(within(broken).getByText(t('pdfa.violation.fonts'))).toBeTruthy();
    expect(within(broken).getByText('ISO 19005-2, clause 6.2.11.4')).toBeTruthy();
    expect(within(broken).getByText('Page 1')).toBeTruthy();
    expect(within(broken).getByText('Helvetica').tagName).toBe('CODE');
    expect(within(broken).getByText('Page 5')).toBeTruthy();
    expect(within(broken).getByText('Courier')).toBeTruthy();
    expect(within(broken).getByText('and 7 more')).toBeTruthy();
  });

  it('cites the part 1 clause and prints no "more" line when every sample is shown', async () => {
    await run(
      reportOf({
        verdict: 'claims-with-violations',
        claim: { part: '1', conformance: 'B' },
        target: { part: 1, conformance: 'B' },
        violations: 1,
        rules: [rule('fonts', 'fail', 1, [{ pageIndex: 1, detail: 'Symbol' }] as never)],
      }),
    );
    const broken = groupOf('Rules that are broken (1)');
    expect(within(broken).getByText('ISO 19005-1, clause 6.3.4')).toBeTruthy();
    expect(within(broken).queryByText(/more$/)).toBeNull();
  });

  it('cites part 2 clauses for part 3', async () => {
    await run(
      reportOf({
        verdict: 'claims-with-violations',
        claim: { part: '3', conformance: 'B' },
        target: { part: 3, conformance: 'B' },
        violations: 1,
        rules: [rule('fonts', 'fail', 1, [])],
      }),
    );
    expect(screen.getByText('ISO 19005-2, clause 6.2.11.4')).toBeTruthy();
  });

  it('describes passing, unchecked and not-applicable rules by their plain statement, with no clause', async () => {
    await run(groupedReport);
    expect(
      within(groupOf('Rules that could not be checked (1)')).getByText(t('pdfa.rule.layers')),
    ).toBeTruthy();
    expect(within(groupOf('Rules that pass (1)')).getByText(t('pdfa.rule.forms'))).toBeTruthy();
    expect(
      within(groupOf('Rules that do not apply to this level (1)')).getByText(t('pdfa.rule.xmp-info')),
    ).toBeTruthy();
    expect(screen.getAllByText(/^ISO 19005-/)).toHaveLength(1);
  });
});
