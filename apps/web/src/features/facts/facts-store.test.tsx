// @vitest-environment happy-dom
/**
 * Facts are tagged with the tab and the bytes they were read from, and only the tab they were read
 * from sees them: through a mark step, which changes no byte, but not through a byte operation.
 */

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { SessionStore, type SessionTab, workingBytesKey } from 'pdf-model';
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

function openTab(session = new SessionStore()): SessionTab {
  return session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
}

/** The tab after a mark step (no new bytes), or after a byte operation. */
function marked(session: SessionStore, tab: SessionTab): SessionTab {
  session.setOverlays(tab.id, { annotations: [{ id: 'm1' }], measures: [], redactions: [] }, 'ann.transform');
  return session.active as SessionTab;
}

function produced(session: SessionStore, tab: SessionTab): SessionTab {
  session.applyOperation({
    tabId: tab.id,
    bytes: new Uint8Array([2]),
    pageCount: 1,
    labelKey: 'ann.transform',
    engine: 'mupdf',
    steps: [],
    overlays: null,
  });
  return session.active as SessionTab;
}

function factsFor(tab: SessionTab, bytesKey = workingBytesKey(tab)): DocumentFacts {
  return {
    tabId: tab.id,
    bytesKey,
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
  it('are shown to the tab and bytes they were read from, and to nothing else', () => {
    const tab = openTab();
    const other = openTab();
    factsRead(factsFor(tab));

    expect(currentFacts(tab)).toBe(factsStore.get().facts);
    expect(currentFacts(other)).toBeNull();
    expect(currentFacts(null)).toBeNull();

    factsRead(factsFor(tab, 'an-older-version'));
    expect(currentFacts(tab)).toBeNull();
  });

  it('stay the facts of a tab through a mark step, which changes no byte, and end with the bytes', () => {
    const session = new SessionStore();
    const tab = openTab(session);
    factsRead(factsFor(tab));

    const drawn = marked(session, tab);
    expect(drawn.working.id).not.toBe(tab.working.id);
    expect(currentFacts(drawn)).toBe(factsStore.get().facts);

    const next = produced(session, tab);
    expect(currentFacts(next)).toBeNull();
    factsRead(factsFor(next));
    expect(currentFacts(marked(session, next))).toBe(factsStore.get().facts);
    session.undo(tab.id);
    session.undo(tab.id);
    expect(currentFacts(session.active)).toBeNull();
  });

  it('are nothing before a read, and starting a read forgets the last one and its failure', () => {
    const tab = openTab();
    expect(currentFacts(tab)).toBeNull();

    factsRead(factsFor(tab));
    factsFailed({ tabId: tab.id, bytesKey: workingBytesKey(tab), error });
    factsReading();

    expect(currentFacts(tab)).toBeNull();
    expect(currentFactsError(tab)).toBeNull();
  });

  it('report a failed read to the tab and bytes it failed for', () => {
    const session = new SessionStore();
    const tab = openTab(session);
    factsFailed({ tabId: tab.id, bytesKey: workingBytesKey(tab), error });

    expect(currentFactsError(tab)).toBe(error);
    expect(currentFactsError(marked(session, tab))).toBe(error);
    expect(currentFactsError(produced(session, tab))).toBeNull();
    expect(currentFactsError(openTab())).toBeNull();
    expect(currentFactsError(null)).toBeNull();

    factsFailed({ tabId: tab.id, bytesKey: 'an-older-version', error });
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

    act(() => factsFailed({ tabId: tab.id, bytesKey: workingBytesKey(tab), error }));
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
