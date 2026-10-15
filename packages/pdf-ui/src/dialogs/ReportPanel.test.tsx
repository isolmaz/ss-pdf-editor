// @vitest-environment happy-dom
/**
 * The operation report: what was removed or warned about first, then the page count and size,
 * then what changed and was preserved, each sentence read from the dictionary — and the
 * technical lines folded into one closed section.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import type { OperationNote, OperationReport } from 'pdf-core/ops/types';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationReportPanel } from './ReportPanel';

const t = createTranslator('en');

const report = (overrides: Partial<OperationReport> = {}): OperationReport => ({
  engine: 'model',
  pageCount: 4,
  inputBytes: 2048,
  outputBytes: 1024,
  incremental: false,
  steps: [],
  notes: [],
  ...overrides,
});

afterEach(cleanup);

const technical = () => document.querySelector('details') as HTMLDetailsElement;

describe('OperationReportPanel', () => {
  it('states the page count and the size delta up front', () => {
    render(<OperationReportPanel t={t} report={report()} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Operation report' })).toBeTruthy();
    const facts = within(screen.getAllByRole('list')[0] as HTMLElement)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(facts).toEqual(['4 page(s)', 'Size: 2.0 KB → 1.0 KB']);
  });

  it('takes the heading it is given, so a result still to be applied can call itself a review', () => {
    render(<OperationReportPanel t={t} report={report()} title="Review the result" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Review the result' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Operation report' })).toBeNull();
  });

  it('says so when the output grew', () => {
    render(<OperationReportPanel t={t} report={report({ outputBytes: 4096 })} />);
    expect(screen.getByText('Size: 2.0 KB → 4.0 KB (increased)')).toBeTruthy();
  });

  it('keeps how the file was written in a closed technical section', () => {
    const { unmount } = render(<OperationReportPanel t={t} report={report()} />);
    expect(technical().open).toBe(false);
    expect(within(technical()).getByText('Technical details').tagName).toBe('SUMMARY');
    expect(within(technical()).getByText('Fully rewritten (not incremental)')).toBeTruthy();
    expect(screen.getAllByText('Fully rewritten (not incremental)')).toHaveLength(1);
    unmount();
    render(<OperationReportPanel t={t} report={report({ incremental: true })} />);
    expect(within(technical()).getByText('Written incrementally')).toBeTruthy();
  });

  it('shows no steps sentence for a run that reports no steps, and joins the ones it reports in the technical section', () => {
    const { unmount } = render(<OperationReportPanel t={t} report={report()} />);
    expect(screen.queryByText(/Executed steps/)).toBeNull();
    unmount();
    render(<OperationReportPanel t={t} report={report({ steps: ['pages', 'verify'] })} />);
    expect(within(technical()).getByText('Executed steps: pages, verify')).toBeTruthy();
  });

  const note = (kind: OperationNote['kind'], key: OperationNote['key']): OperationNote => ({
    kind,
    key,
    params: { count: 3, page: 4 },
  });

  it('puts the producer line in the technical section and leaves a plain preserved note outside it', () => {
    render(
      <OperationReportPanel
        t={t}
        report={report({
          notes: [
            {
              kind: 'preserved',
              key: 'op.note.metadata.producerKept',
              params: { producer: 'SsPdfEditor (MuPDF 1.28)' },
            },
            note('preserved', 'op.scope.all'),
          ],
        })}
      />,
    );
    expect(within(technical()).getByText('Producer string preserved: SsPdfEditor (MuPDF 1.28)')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Preserved' })).toBeTruthy();
    expect(screen.getByText('All pages (3)').closest('details')).toBeNull();
    expect(screen.queryAllByText(/Producer string preserved/)).toHaveLength(1);
  });

  it('never folds a loss or a warning away, even one that carries a technical key', () => {
    render(
      <OperationReportPanel
        t={t}
        report={report({
          notes: [
            { kind: 'lost', key: 'op.note.metadata.producerKept', params: { producer: 'LOST-PRODUCER' } },
            { kind: 'warning', key: 'op.note.redact.producerKept' },
          ],
        })}
      />,
    );
    expect(screen.getByText('Producer string preserved: LOST-PRODUCER').closest('details')).toBeNull();
    expect(screen.getByRole('heading', { level: 4, name: 'Lost' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Warnings' })).toBeTruthy();
  });

  it('reads what was removed and what to watch before the numbers, and what changed after them', () => {
    render(
      <OperationReportPanel
        t={t}
        report={report({
          notes: [
            note('preserved', 'op.scope.all'),
            note('changed', 'op.scope.current'),
            note('warning', 'op.scope.selection'),
            note('lost', 'op.scope.custom'),
          ],
        })}
      />,
    );
    const lines = Array.from(document.querySelectorAll('h4, li'))
      .filter((element) => element.closest('details') === null)
      .map((element) => element.textContent);
    expect(lines).toEqual([
      'Lost',
      'Custom range',
      'Warnings',
      'Selected pages (3)',
      '4 page(s)',
      'Size: 2.0 KB → 1.0 KB',
      'Changes',
      'Current page (4)',
      'Preserved',
      'All pages (3)',
    ]);
  });

  it('groups the notes loss-first and leaves out the groups that have none', () => {
    render(
      <OperationReportPanel
        t={t}
        report={report({
          notes: [note('preserved', 'op.scope.all'), note('lost', 'op.scope.custom')],
        })}
      />,
    );
    const headings = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Lost', 'Preserved']);
  });

  it('adds the caller notes after the report notes of the same group', () => {
    render(
      <OperationReportPanel
        t={t}
        report={report({ notes: [note('warning', 'op.scope.all')] })}
        notes={[note('warning', 'op.scope.custom'), note('changed', 'op.scope.empty')]}
      />,
    );
    const headings = screen.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Warnings', 'Changes']);
    const warnings = screen.getByRole('heading', { level: 4, name: 'Warnings' }).nextElementSibling;
    expect(
      within(warnings as HTMLElement)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['All pages (3)', 'Custom range']);
  });
});
