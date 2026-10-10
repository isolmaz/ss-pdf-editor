// @vitest-environment happy-dom
/**
 * A pick the detector's review no longer holds (its candidate was dropped in the same turn the
 * row was pressed) is remembered like any other pick but walks the viewer nowhere. The real
 * panel only lists candidates the review holds, so this one drives the panel's callback itself.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FormDetection } from 'pdf-core/ops/form-detect';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FormsPanel } from './FormsSurface';
import { detectFinished, detectStarted, formsStore, initialFormsState } from './forms-store';

vi.mock('pdf-ui/panels', () => ({
  FormDetectPanel: (props: { onSelect: (id: string) => void }) => (
    <button type="button" onClick={() => props.onSelect('gone')}>
      Pick a dropped candidate
    </button>
  ),
  FormPanel: () => null,
}));

const t = createTranslator('en');

beforeEach(() => formsStore.set(initialFormsState()));
afterEach(cleanup);

it('remembers a pick the review no longer holds and walks the viewer nowhere', async () => {
  const store = new SessionStore();
  const tab = store.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
  detectStarted(tab.id, tab.working.id);
  detectFinished(tab.id, tab.working.id, { candidates: [] } as unknown as FormDetection);
  const goToPage = vi.fn();
  render(
    <FormsPanel
      t={t}
      tab={tab}
      canEdit
      goToPage={goToPage}
      onDetect={vi.fn()}
      onApply={vi.fn()}
      onFill={vi.fn()}
    />,
  );

  await userEvent.setup().click(await screen.findByRole('button', { name: 'Pick a dropped candidate' }));
  expect(formsStore.get().formDetect?.selectedId).toBe('gone');
  expect(goToPage).not.toHaveBeenCalled();
});
