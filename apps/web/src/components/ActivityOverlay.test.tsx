/**
 * What the activity overlay shows for each kind of progress a job can report: no step count,
 * a count of zero, a running count, and work in flight that reports nothing.
 *
 * The translator stub renders the dictionary key (with its parameters), so the markup names
 * what the user would read.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityOverlay, type ActivityProgress } from './ActivityOverlay';

const t = Object.assign(
  (key: string, params?: Record<string, string | number>) =>
    params === undefined ? key : `${key}:${Object.values(params).join('/')}`,
  { locale: 'en' as const },
) as never;

function render(progress: ActivityProgress | null, activity: string | null = null): string {
  return renderToStaticMarkup(
    <ActivityOverlay
      t={t}
      notice={null}
      onDismiss={() => undefined}
      progress={progress}
      onCancel={() => undefined}
      activity={activity}
    />,
  );
}

describe('ActivityOverlay progress', () => {
  it('shows a running count as a label with done/total and the matching bar width and ARIA values', () => {
    const markup = render({ labelKey: 'progress.label', done: 1, total: 4 });
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="4"');
    expect(markup).toContain('aria-valuenow="1"');
    expect(markup).toContain('op.progress:progress.label/1/4');
    expect(markup).toContain('style="width:25%"');
  });

  it('counts a missing done as nothing finished yet', () => {
    const markup = render({ labelKey: 'progress.label', total: 2 });
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('op.progress:progress.label/0/2');
    expect(markup).toContain('style="width:0%"');
  });

  it('shows an indeterminate full bar and only the label for a job that reports no total, or a total of zero', () => {
    for (const markup of [
      render({ labelKey: 'progress.label' }),
      render({ labelKey: 'progress.label', done: 0, total: 0 }),
    ]) {
      expect(markup).toContain('role="progressbar"');
      // No value for assistive technology to read out as "0 of 0".
      expect(markup).not.toContain('aria-valuenow');
      expect(markup).not.toContain('aria-valuemax');
      expect(markup).toContain('style="width:100%"');
      expect(markup).not.toContain('op.progress');
    }
  });

  it('names work in flight that reports no steps, and hands over to the progress bar once it reports', () => {
    const working = render(null, 'Opening the document…');
    expect(working).toContain('Opening the document…');
    expect(working).not.toContain('role="progressbar"');
    const both = render({ labelKey: 'progress.label', done: 1, total: 2 }, 'Opening the document…');
    expect(both).toContain('role="progressbar"');
    expect(both).not.toContain('Opening the document…');
  });
});
