// @vitest-environment happy-dom
/**
 * Facts are tagged with the tab and working version they were read from, and only the tab they
 * were read from sees them.
 */

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { SessionStore, type SessionTab } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentFacts,
  currentFactsError,
  type DocumentFacts,
  factsFailed,
  factsRead,
  factsReading,
  factsStore,
  useCurrentFacts,
  useCurrentFactsError,
  useCurrentSignatures,
} from './facts-store';

function openTab(): SessionTab {
  const session = new SessionStore();
  return session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
}

function factsFor(tab: SessionTab, version = tab.working.id): DocumentFacts {
  return {
    tabId: tab.id,
    version,
    fonts: [],
    attachments: [],
    signatures: [],
    security: { encrypted: false, permissions: [] },
  };
}

const error = new ToolError('internal', { engine: 'model' });

beforeEach(factsReading);
afterEach(cleanup);

describe('document facts', () => {
  it('are shown to the tab and version they were read from, and to nothing else', () => {
    const tab = openTab();
    const other = openTab();
    factsRead(factsFor(tab));

    expect(currentFacts(tab)).toBe(factsStore.get().facts);
    expect(currentFacts(other)).toBeNull();
    expect(currentFacts(null)).toBeNull();

    factsRead(factsFor(tab, 'an-older-version'));
    expect(currentFacts(tab)).toBeNull();
  });

  it('are nothing before a read, and starting a read forgets the last one and its failure', () => {
    const tab = openTab();
    expect(currentFacts(tab)).toBeNull();

    factsRead(factsFor(tab));
    factsFailed({ tabId: tab.id, version: tab.working.id, error });
    factsReading();

    expect(currentFacts(tab)).toBeNull();
    expect(currentFactsError(tab)).toBeNull();
  });

  it('report a failed read to the tab and version it failed for', () => {
    const tab = openTab();
    factsFailed({ tabId: tab.id, version: tab.working.id, error });

    expect(currentFactsError(tab)).toBe(error);
    expect(currentFactsError(openTab())).toBeNull();
    expect(currentFactsError(null)).toBeNull();

    factsFailed({ tabId: tab.id, version: 'an-older-version', error });
    expect(currentFactsError(tab)).toBeNull();
  });
});

describe('document facts in a component', () => {
  function Reader({ tab }: { readonly tab: SessionTab | null }) {
    const facts = useCurrentFacts(tab);
    const failure = useCurrentFactsError(tab);
    return (
      <p>{`${facts === null ? 'no facts' : `facts of ${facts.tabId}`} / ${failure === null ? 'no failure' : 'failed'}`}</p>
    );
  }

  it('renders again when the facts or the failure arrive', () => {
    const tab = openTab();
    const view = render(<Reader tab={tab} />);
    expect(view.container.textContent).toBe('no facts / no failure');

    act(() => factsRead(factsFor(tab)));
    expect(view.container.textContent).toBe(`facts of ${tab.id} / no failure`);

    act(() => factsFailed({ tabId: tab.id, version: tab.working.id, error }));
    expect(view.container.textContent).toBe(`facts of ${tab.id} / failed`);

    view.rerender(<Reader tab={null} />);
    expect(view.container.textContent).toBe('no facts / no failure');
  });
});

describe('the signature verdicts in a component', () => {
  it('render it again only when the verdicts change, not for facts that carry the same ones', () => {
    const tab = openTab();
    let renders = 0;
    const view = renderHook(() => {
      renders += 1;
      return useCurrentSignatures(tab);
    });
    expect(view.result.current).toEqual([]);
    const before = renders;
    act(() => factsRead(factsFor(tab)));
    act(() => factsRead({ ...factsFor(tab), fonts: [] }));
    expect(renders).toBe(before);
    const signed = [{ status: 'valid' }] as never;
    act(() => factsRead({ ...factsFor(tab), signatures: signed }));
    expect(view.result.current).toBe(signed);
  });
});
