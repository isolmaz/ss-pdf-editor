import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './session';

/**
 * Session store behaviour: one source of truth for open
 * documents, stable snapshots for `useSyncExternalStore`, and a dirty flag that
 * belongs to exactly one document.
 */

const document = (name: string, pageCount = 3) => ({
  name,
  bytes: new Uint8Array([1, 2, 3]),
  sha256: 'a'.repeat(64),
  pageCount,
});

describe('SessionStore', () => {
  it('opens a document as the active tab with a working version per page', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('sozlesme.pdf', 5));
    expect(store.getSnapshot().tabs).toHaveLength(1);
    expect(store.getSnapshot().activeId).toBe(tab.id);
    expect(tab.working.pageOrder).toHaveLength(5);
    expect(tab.working.pageOrder.every((page) => page.sourceId === tab.source.id)).toBe(true);
    expect(tab.dirty).toBe(false);
  });

  it('keeps the snapshot reference stable until something changes', () => {
    const store = new SessionStore();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.openDocument(document('a.pdf'));
    expect(store.getSnapshot()).not.toBe(first);
  });

  it('falls back to a neighbour when the active tab closes, and to null when none is left', () => {
    const store = new SessionStore();
    const first = store.openDocument(document('a.pdf'));
    const second = store.openDocument(document('b.pdf'));
    expect(store.getSnapshot().activeId).toBe(second.id);

    store.closeTab(second.id);
    expect(store.getSnapshot().activeId).toBe(first.id);

    store.closeTab(first.id);
    expect(store.getSnapshot().activeId).toBeNull();
    expect(store.getSnapshot().tabs).toHaveLength(0);
    expect(store.active).toBeNull();
  });

  it('marks only the addressed document dirty', () => {
    const store = new SessionStore();
    const first = store.openDocument(document('a.pdf'));
    const second = store.openDocument(document('b.pdf'));
    store.setDirty(second.id, true);
    const [one, two] = store.getSnapshot().tabs;
    expect(one?.dirty).toBe(false);
    expect(two?.dirty).toBe(true);
    expect(first.dirty).toBe(false);
  });

  it('preserves unapplied intent across a byte operation and its undo/redo', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('intent.pdf'));
    const before = { annotations: [{ id: 'baked' }], measures: [], redactions: [{ id: 'pending' }] };
    const after = { annotations: [], measures: [], redactions: [{ id: 'pending' }] };
    store.setOverlays(tab.id, before, 'ann.engineEdit');
    store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([4, 5, 6]),
      pageCount: 3,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['stamp'],
      overlays: after,
    });
    expect(store.active?.working.overlays).toEqual(after);
    store.undo(tab.id);
    expect(store.active?.working.overlays).toEqual(before);
    store.redo(tab.id);
    expect(store.active?.working.overlays).toEqual(after);
  });

  it('compares undo and redo with the last successful output rather than cursor zero', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('saved.pdf'));
    store.setOverlays(tab.id, { redactions: ['intent'] }, 'ann.engineEdit');
    store.undo(tab.id);
    expect(store.active?.dirty).toBe(false);
    store.redo(tab.id);
    const saved = store.active;
    if (saved === null) throw new Error('missing tab');
    store.addOutput(tab.id, {
      id: 'output',
      fromWorkingVersion: saved.working.id,
      fromState: saved.working.stateId,
      encrypted: false,
      steps: [],
      appliedSteps: [],
      incremental: true,
      writtenTo: { fileName: 'saved.pdf', savedAt: 1, sha256: 'output-hash' },
    });
    expect(store.active?.dirty).toBe(false);
    store.undo(tab.id);
    expect(store.active?.dirty).toBe(true);
    store.redo(tab.id);
    expect(store.active?.dirty).toBe(false);
    store.undo(tab.id);
    store.setOverlays(tab.id, { redactions: ['different'] }, 'ann.engineEdit');
    expect(store.active?.dirty).toBe(true);
    expect(store.active?.journal.canRedo).toBe(false);
  });

  it('does not mark a newer edit saved when an older output completes', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('late.pdf'));
    store.setOverlays(tab.id, { annotations: ['first'] }, 'ann.engineEdit');
    const frozen = store.active;
    if (frozen === null) throw new Error('missing tab');
    store.setOverlays(tab.id, { annotations: ['second'] }, 'ann.engineEdit');
    store.addOutput(tab.id, {
      id: 'late',
      fromWorkingVersion: frozen.working.id,
      fromState: frozen.working.stateId,
      encrypted: false,
      steps: [],
      appliedSteps: [],
      incremental: true,
    });
    expect(store.active?.dirty).toBe(true);
    store.undo(tab.id);
    expect(store.active?.dirty).toBe(false);
  });

  it('ignores activation of an unknown document', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    const before = store.getSnapshot();
    store.setActive('missing');
    expect(store.getSnapshot()).toBe(before);
    store.setActive(tab.id);
    expect(store.getSnapshot()).toBe(before);
  });

  it('publishes to subscribers and stops when they unsubscribe', () => {
    const store = new SessionStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const tab = store.openDocument(document('a.pdf'));
    store.closeTab('missing');
    unsubscribe();
    store.closeTab(tab.id);
    expect(calls).toBe(1);
  });

  it('rejects an empty source instead of opening a document that cannot be rendered', () => {
    const store = new SessionStore();
    expect(() => store.openDocument({ ...document('empty.pdf'), bytes: new Uint8Array() })).toThrow();
    expect(store.getSnapshot().tabs).toHaveLength(0);
  });

  it('closing a background tab keeps the active tab, and closing the active one prefers the next tab', () => {
    const store = new SessionStore();
    const a = store.openDocument(document('a.pdf'));
    const b = store.openDocument(document('b.pdf'));
    const c = store.openDocument(document('c.pdf'));
    store.closeTab(a.id);
    expect(store.getSnapshot().activeId).toBe(c.id);
    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual([b.id, c.id]);
    const d = store.openDocument(document('d.pdf'));
    store.setActive(c.id);
    store.closeTab(c.id);
    expect(store.getSnapshot().activeId).toBe(d.id);
    store.setActive(b.id);
    store.closeTab(b.id);
    expect(store.getSnapshot().activeId).toBe(d.id);
  });

  it('forgets the snapshots of a closed tab', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([1]),
      pageCount: 3,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: [],
      overlays: null,
    });
    expect(store.snapshotsFor(tab.id)).toHaveLength(1);
    store.closeTab(tab.id);
    expect(store.snapshotsFor(tab.id)).toEqual([]);
  });

  it('setOverlays with the very same overlays journals nothing and publishes nothing', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    const overlays = { annotations: ['one'] };
    store.setOverlays(tab.id, overlays, 'ann.engineEdit');
    const snapshot = store.getSnapshot();
    store.setOverlays(tab.id, overlays, 'ann.engineEdit');
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.active?.journal.length).toBe(1);
  });

  it('setDirty publishes only a real change, and a new edit state is a new identity', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    const clean = store.getSnapshot();
    store.setDirty(tab.id, false);
    expect(store.getSnapshot()).toBe(clean);
    store.setDirty(tab.id, true);
    const dirtyState = store.active?.working.stateId;
    expect(store.active?.dirty).toBe(true);
    expect(dirtyState).not.toBe(tab.working.stateId);
    store.setDirty(tab.id, false);
    expect(store.active?.dirty).toBe(false);
    expect(store.active?.savedState).toBe(dirtyState);
  });

  it('renames, flags sensitive and attaches a handle on exactly the addressed tab', () => {
    const store = new SessionStore();
    const a = store.openDocument(document('a.pdf'));
    const b = store.openDocument(document('b.pdf'));
    const handle = { kind: 'file', name: 'b.pdf' } as unknown as FileSystemFileHandle;
    store.renameTab(a.id, 'renamed.pdf');
    store.setSensitive(b.id, true);
    store.setHandle(b.id, handle);
    const [one, two] = store.getSnapshot().tabs;
    expect([one?.name, two?.name]).toEqual(['renamed.pdf', 'b.pdf']);
    expect([one?.sensitive, two?.sensitive]).toEqual([false, true]);
    expect(one?.source.handle).toBeUndefined();
    expect(two?.source.handle).toBe(handle);
  });
});

describe('SessionStore — byte operations and their snapshots', () => {
  const apply = (store: SessionStore, tabId: string, byte: number) =>
    store.applyOperation({
      tabId,
      bytes: new Uint8Array([byte]),
      pageCount: 3,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['step'],
      overlays: null,
    });

  it('applyOperation publishes, makes the output the working version and marks the tab dirty', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    const before = store.getSnapshot();
    const produced = apply(store, tab.id, 9);
    expect(calls).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.producedFor(tab.id)).toBe(produced);
    expect(store.active?.dirty).toBe(true);
    expect(store.snapshotsFor(tab.id)).toEqual([produced]);
    expect(() => apply(store, 'missing', 1)).toThrow(/unknown tab/);
  });

  it('undo returns to the source bytes and redo to the produced bytes', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    const produced = apply(store, tab.id, 9);
    const undone = store.undo(tab.id);
    expect(undone.kind === 'done' && undone.step.kind === 'document' && undone.step.produced).toBeNull();
    expect(store.producedFor(tab.id)).toBeNull();
    expect(store.active?.dirty).toBe(false);
    const redone = store.redo(tab.id);
    expect(redone.kind === 'done' && redone.step.kind === 'document' && redone.step.produced).toBe(produced);
    expect(store.producedFor(tab.id)).toBe(produced);
    expect(store.undo('missing')).toEqual({ kind: 'empty' });
    store.undo(tab.id);
    expect(store.undo(tab.id)).toEqual({ kind: 'empty' });
  });

  it('previewHistory names the target without moving anything', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    const produced = apply(store, tab.id, 9);
    const snapshot = store.getSnapshot();
    expect(store.previewHistory(tab.id, 'undo').kind).toBe('done');
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.producedFor(tab.id)).toBe(produced);
    expect(store.previewHistory(tab.id, 'redo')).toEqual({ kind: 'empty' });
  });

  it('releases the snapshots of an abandoned redo branch, byte or overlay, and only those', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    const first = apply(store, tab.id, 1);
    const second = apply(store, tab.id, 2);
    expect(store.snapshotsFor(tab.id)).toEqual([first, second]);
    store.undo(tab.id);
    const third = apply(store, tab.id, 3);
    expect(store.snapshotsFor(tab.id).map((item) => item.id)).toEqual([first.id, third.id]);

    store.undo(tab.id);
    store.setOverlays(tab.id, { annotations: ['branch'] }, 'ann.engineEdit');
    expect(store.snapshotsFor(tab.id).map((item) => item.id)).toEqual([first.id]);
  });

  it('keeps the newest snapshots inside the byte budget', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    // The store only reads `byteLength`, so a 70 MiB stand-in avoids allocating 280 MiB.
    const huge = { byteLength: 70 * 1024 * 1024 } as unknown as Uint8Array;
    const made = [1, 2, 3, 4].map(() =>
      store.applyOperation({
        tabId: tab.id,
        bytes: huge,
        pageCount: 3,
        labelKey: 'ann.engineEdit',
        engine: 'mupdf',
        steps: [],
        overlays: null,
      }),
    );
    // 4 x 70 MiB against max(64 MiB, 3 x 70 MiB): the oldest goes, three stay.
    expect(store.snapshotsFor(tab.id).map((item) => item.id)).toEqual(made.slice(1).map((item) => item.id));
  });

  it('restoreHistory reinstates the journal cursor, the working snapshot and the dirty verdict', () => {
    const source = new SessionStore();
    const origin = source.openDocument(document('a.pdf'));
    const first = apply(source, origin.id, 1);
    const second = apply(source, origin.id, 2);
    source.undo(origin.id);
    const tabNow = source.active;
    if (tabNow === null) throw new Error('missing tab');
    const draft = {
      id: origin.id,
      name: 'a.pdf',
      pageCount: 3,
      size: 3,
      dirty: true,
      updatedAt: 1,
      sourceKey: 'k',
      engineValues: { entries: [], dropped: 0 },
      journal: [...tabNow.journal.entries],
      journalCursor: tabNow.journal.cursor,
      workingId: first.id,
      stateId: tabNow.working.stateId,
      savedState: null,
    };
    const target = new SessionStore();
    const fresh = target.openDocument(document('a.pdf'));
    target.restoreHistory(fresh.id, draft as never, [first, second]);
    expect(target.active?.journal.cursor).toBe(1);
    expect(target.active?.journal.length).toBe(2);
    expect(target.active?.journal.canRedo).toBe(true);
    expect(target.producedFor(fresh.id)?.id).toBe(first.id);
    expect(target.snapshotsFor(fresh.id)).toEqual([first, second]);
    expect(target.active?.working.stateId).toBe(draft.stateId);
    expect(target.active?.dirty).toBe(true);
    expect(target.active?.savedState).toBeNull();
  });
});

describe('a burst of form edits is one undo step', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const typing = (store: SessionStore, tabId: string, value: string) =>
    store.setOverlays(tabId, { engineValues: [value] }, 'ann.engineEdit', { coalesceWithinMs: 1500 });

  it('folds keystrokes into one step whose undo returns to before the typing', () => {
    vi.useFakeTimers({ now: 1_000 });
    const store = new SessionStore();
    const tab = store.openDocument(document('form.pdf'));
    for (const value of ['A', 'Ac', 'Acm', 'Acme']) {
      typing(store, tab.id, value);
      vi.advanceTimersByTime(200);
    }
    expect(store.active?.journal.length).toBe(1);
    expect(store.active?.working.overlays).toEqual({ engineValues: ['Acme'] });
    expect(store.active?.dirty).toBe(true);
    store.undo(tab.id);
    expect(store.active?.working.overlays ?? null).toBeNull();
    expect(store.active?.dirty).toBe(false);
  });

  it('starts a new step after a pause, after a save, or after another kind of edit', () => {
    vi.useFakeTimers({ now: 1_000 });
    const store = new SessionStore();
    const tab = store.openDocument(document('form.pdf'));
    typing(store, tab.id, 'A');
    vi.advanceTimersByTime(1_600);
    typing(store, tab.id, 'Ab');
    expect(store.active?.journal.length).toBe(2);

    // Saved here: more typing must stay undoable back to exactly the saved value.
    store.setDirty(tab.id, false);
    typing(store, tab.id, 'Abc');
    expect(store.active?.journal.length).toBe(3);
    expect(store.active?.dirty).toBe(true);

    store.setOverlays(tab.id, { engineValues: ['Abc'], annotations: ['mark'] }, 'ann.transform');
    typing(store, tab.id, 'Abcd');
    expect(store.active?.journal.length).toBe(5);
  });

  it('never folds without the option', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('form.pdf'));
    store.setOverlays(tab.id, { engineValues: ['A'] }, 'ann.engineEdit');
    store.setOverlays(tab.id, { engineValues: ['Ab'] }, 'ann.engineEdit');
    expect(store.active?.journal.length).toBe(2);
  });
});

describe('a history restored from storage', () => {
  /** A journal entry as a stored draft carries it: `parseDraft` checks its shape, not its payload. */
  const entry = (seq: number, kind: string, payload: unknown) => ({
    id: `entry-${seq}`,
    seq,
    labelKey: 'ann.engineEdit',
    engine: 'model' as const,
    op: { kind, payload },
    schema: 2,
    timestamp: 1,
  });
  const produced = (id: string) => ({
    id,
    bytes: new Uint8Array([7]),
    pageCount: 2,
    inputBytes: 3,
    labelKey: 'ann.engineEdit' as const,
  });
  const draft = (fields: Record<string, unknown>) =>
    ({
      id: 'draft',
      name: 'a.pdf',
      pageCount: 3,
      size: 3,
      dirty: false,
      updatedAt: 1,
      sourceKey: 'k',
      engineValues: { entries: [], dropped: 0 },
      journal: [],
      ...fields,
    }) as never;
  const restored = (fields: Record<string, unknown>, snapshots: ReturnType<typeof produced>[] = []) => {
    const store = new SessionStore();
    const other = store.openDocument(document('other.pdf'));
    const tab = store.openDocument(document('a.pdf'));
    store.restoreHistory(tab.id, draft(fields), snapshots);
    return { store, tab, other };
  };

  it('derives the saved state of a draft that did not store one', () => {
    const journal = [
      entry(0, 'document.overlays', { before: null, after: 1 }),
      entry(1, 'document.overlays', { before: 1, after: 2 }),
    ];
    const savedState = (fields: Record<string, unknown>) => restored(fields).store.active?.savedState;
    // An unsaved session has no saved state at all.
    expect(savedState({ dirty: true, journal })).toBeNull();
    // A clean one was saved at its own state: the stored id, else the entry before the cursor.
    expect(savedState({ stateId: 'state-9', journal })).toBe('state-9');
    expect(savedState({ journal, journalCursor: 1 })).toBe('entry-0');
    expect(savedState({ journal })).toBe('entry-1');
    expect(savedState({ journal: [] })).toBe('source');
    // A stored saved state wins over every derivation.
    expect(savedState({ dirty: true, journal, savedState: 'entry-0' })).toBe('entry-0');
  });

  it('touches only the addressed tab, and nothing for a tab that is not open', () => {
    const { store, tab, other } = restored({
      journal: [entry(0, 'document.overlays', { before: null, after: 1 })],
    });
    const [first, second] = store.getSnapshot().tabs;
    expect(first?.id).toBe(other.id);
    expect(first?.journal.length).toBe(0);
    expect(second?.id).toBe(tab.id);
    expect(second?.journal.length).toBe(1);
    const before = store.getSnapshot();
    store.restoreHistory('missing', draft({}), [produced('p')]);
    expect(store.getSnapshot()).toBe(before);
    expect(store.snapshotsFor('missing')).toEqual([]);
    store.addOutput(tab.id, { id: 'out' } as never);
    expect(store.getSnapshot().tabs.map((item) => item.outputs.length)).toEqual([0, 1]);
  });

  it('opens on the source when the stored working version has no snapshot', () => {
    const { store, tab } = restored({ workingId: 'gone' }, [produced('kept')]);
    expect(store.producedFor(tab.id)).toBeNull();
    expect(store.active?.working.pageOrder).toHaveLength(3);
  });

  it('refuses to step onto an entry it cannot replay, and leaves the cursor where it was', () => {
    const cases = [
      entry(0, 'something.else', null),
      entry(0, 'document.change', null),
      entry(0, 'document.change', { before: null }),
      // Undo steps to `before`: a snapshot the store does not hold.
      entry(0, 'document.change', { before: 'not-kept', after: 'also-not-kept' }),
    ];
    for (const stored of cases) {
      const { store, tab } = restored({ journal: [stored] });
      const result = store.undo(tab.id);
      expect(result.kind === 'done' && result.step.kind, stored.op.kind).toBe('unavailable');
      expect(store.active?.journal.cursor).toBe(1);
      expect(store.previewHistory(tab.id, 'redo')).toEqual({ kind: 'empty' });
    }
    expect(new SessionStore().previewHistory('missing', 'undo')).toEqual({ kind: 'empty' });
  });

  it('a new edit over a stored redo tail releases only the snapshots that tail alone named', () => {
    const journal = [
      // Before the cursor: payloads a build of this app never wrote, but storage can hold.
      entry(0, 'document.change', undefined),
      entry(1, 'document.change', { before: 'shared', after: 'shared' }),
      // The redo tail: one snapshot only it names, one an earlier entry also names, and
      // entries that name nothing.
      entry(2, 'document.change', { before: 'shared', after: 'tail-only' }),
      entry(3, 'document.change', { before: 'tail-only', after: 'shared' }),
      entry(4, 'document.overlays', { before: null, after: 1 }),
      entry(5, 'document.change', null),
    ];
    const { store, tab } = restored({ journal, journalCursor: 2, workingId: 'shared' }, [
      produced('shared'),
      produced('tail-only'),
      produced('unnamed'),
    ]);
    const made = store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([9]),
      pageCount: 2,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: [],
      overlays: null,
    });
    expect(store.snapshotsFor(tab.id).map((item) => item.id)).toEqual(['shared', 'unnamed', made.id]);
  });

  it('a new edit over a tail that names no snapshot keeps every snapshot', () => {
    const journal = [
      entry(0, 'document.overlays', { before: null, after: 1 }),
      entry(1, 'document.change', { before: null }),
    ];
    const { store, tab } = restored({ journal, journalCursor: 1 }, [produced('a'), produced('b')]);
    store.setOverlays(tab.id, { annotations: ['new'] }, 'ann.engineEdit');
    expect(store.snapshotsFor(tab.id).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('previewing an overlay step names it without changing what is shown', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document('a.pdf'));
    store.setOverlays(tab.id, { annotations: ['mark'] }, 'ann.engineEdit');
    const preview = store.previewHistory(tab.id, 'undo');
    expect(preview.kind === 'done' && preview.step.kind).toBe('overlays');
    expect(store.active?.working.overlays).toEqual({ annotations: ['mark'] });
  });
});

describe('what a tab carries from its inputs', () => {
  it('keeps the file handle it was opened from, and the label params of an operation on both the snapshot and the step', () => {
    const store = new SessionStore();
    const handle = { name: 'a.pdf' } as unknown as FileSystemFileHandle;
    const tab = store.openDocument({ ...document('a.pdf'), handle });
    expect(tab.source.handle).toBe(handle);
    const made = store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([1]),
      pageCount: 3,
      labelKey: 'ann.engineEdit',
      labelParams: { count: 2 },
      engine: 'mupdf',
      steps: [],
      overlays: null,
    });
    expect(made.labelParams).toEqual({ count: 2 });
    expect(store.active?.journal.entries[0]?.labelParams).toEqual({ count: 2 });
  });
});
