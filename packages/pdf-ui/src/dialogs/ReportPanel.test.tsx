// @vitest-environment happy-dom
/**
 * The operation report: the facts of the run, then what it lost, warned about, changed and
 * preserved — in that order — each sentence read from the dictionary.
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

describe('OperationReportPanel', () => {
  it('states the page count, the size delta and that the file was rewritten', () => {
    render(<OperationReportPanel t={t} report={report()} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Operation report' })).toBeTruthy();
    const facts = within(screen.getAllByRole('list')[0] as HTMLElement)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(facts).toEqual(['4 page(s)', 'Size: 2.0 KB → 1.0 KB', 'Fully rewritten (not incremental)']);
  });

  it('says so when the output grew and when the file stayed incremental', () => {
    render(<OperationReportPanel t={t} report={report({ outputBytes: 4096, incremental: true })} />);
    expect(screen.getByText('Size: 2.0 KB → 4.0 KB (increased)')).toBeTruthy();
    expect(screen.getByText('Written incrementally')).toBeTruthy();
  });

  it('shows no steps sentence for a run that reports no steps, and joins the ones it reports', () => {
    const { unmount } = render(<OperationReportPanel t={t} report={report()} />);
    expect(screen.queryByText(/Executed steps/)).toBeNull();
    unmount();
    render(<OperationReportPanel t={t} report={report({ steps: ['pages', 'verify'] })} />);
    expect(screen.getByText('Executed steps: pages, verify')).toBeTruthy();
  });

  const note = (kind: OperationNote['kind'], key: OperationNote['key']): OperationNote => ({
    kind,
    key,
    params: { count: 3 },
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
    expect(headings).toEqual(['Losses', 'Preserved']);
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
