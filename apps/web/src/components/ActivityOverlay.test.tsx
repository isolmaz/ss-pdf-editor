/**
 * What the activity overlay shows for each kind of progress a job can report: no step count,
 * a count of zero, a running count, and work in flight that reports nothing.
 *
 * The translator is the real English one, so the markup is what the user would read — a raw
 * `{page}` or a fractional count would show up in it.
 */

import { createTranslator } from 'pdf-shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityOverlay, type ActivityProgress } from './ActivityOverlay';

const t = createTranslator('en');

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
    const markup = render({ labelKey: 'compare.running', done: 1, total: 4 });
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="4"');
    expect(markup).toContain('aria-valuenow="1"');
    expect(markup).toContain('Comparing… (1/4)');
    expect(markup).toContain('style="width:25%"');
  });

  it('fills the label`s own counters with whole numbers while the bar still moves inside a page', () => {
    // OCR reports `position + fraction`: 2.4 means the third page is 40 % recognized.
    const markup = render({ labelKey: 'ocr.running', done: 2.4, total: 10 });
    expect(markup).toContain('Recognizing page 3/10 (2/10)');
    expect(markup).not.toContain('{');
    expect(markup).not.toContain('2.4');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('style="width:24%"');
  });

  it('counts a missing done as nothing finished yet', () => {
    const markup = render({ labelKey: 'compare.running', total: 2 });
    expect(markup).toContain('aria-valuenow="0"');
    expect(markup).toContain('Comparing… (0/2)');
    expect(markup).toContain('style="width:0%"');
  });

  it('shows an indeterminate full bar and only the label for a job that reports no total, or a total of zero', () => {
    for (const markup of [
      render({ labelKey: 'compare.running' }),
      render({ labelKey: 'compare.running', done: 0, total: 0 }),
    ]) {
      expect(markup).toContain('role="progressbar"');
      // No value for assistive technology to read out as "0 of 0".
      expect(markup).not.toContain('aria-valuenow');
      expect(markup).not.toContain('aria-valuemax');
      expect(markup).toContain('style="width:100%"');
      expect(markup).toContain('>Comparing…<');
      expect(markup).not.toContain('(0/0)');
    }
  });

  it('names work in flight that reports no steps, and hands over to the progress bar once it reports', () => {
    const working = render(null, 'Opening the document…');
    expect(working).toContain('Opening the document…');
    expect(working).not.toContain('role="progressbar"');
    const both = render({ labelKey: 'compare.running', done: 1, total: 2 }, 'Opening the document…');
    expect(both).toContain('role="progressbar"');
    expect(both).not.toContain('Opening the document…');
  });
});
