import { describe, expect, it } from 'vitest';
import { SessionStore, type SessionTab } from './session';
import { workingBytesKey } from './source';

const document = {
  name: 'a.pdf',
  bytes: new Uint8Array([1, 2, 3]),
  sha256: 'a'.repeat(64),
  pageCount: 3,
};

describe('workingBytesKey', () => {
  it('names the source master until an operation produced bytes, and then the produced version', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document);
    expect(workingBytesKey(tab)).toBe('source');

    const produced = store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([9]),
      pageCount: 3,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['step'],
      overlays: null,
    });
    expect(workingBytesKey(store.active as SessionTab)).toBe(produced.id);
    expect(workingBytesKey({ working: { ...tab.working, produced } })).toBe(produced.id);
  });

  it('stays put through an overlay step, which mints a new working id over the same bytes', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document);
    store.setOverlays(tab.id, { annotations: [{ id: 'm1' }] }, 'ann.transform');
    const marked = store.active as SessionTab;
    expect(marked.working.id).not.toBe(tab.working.id);
    expect(workingBytesKey(marked)).toBe('source');

    const produced = store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([9]),
      pageCount: 3,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['step'],
      overlays: null,
    });
    store.setOverlays(tab.id, { annotations: [{ id: 'm2' }] }, 'ann.transform');
    const next = store.active as SessionTab;
    expect(next.working.id).not.toBe(marked.working.id);
    expect(workingBytesKey(next)).toBe(produced.id);
  });

  it('follows an undo and a redo to the bytes they land on', () => {
    const store = new SessionStore();
    const tab = store.openDocument(document);
    const produced = store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([9]),
      pageCount: 3,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['step'],
      overlays: null,
    });
    store.setOverlays(tab.id, { annotations: [{ id: 'm1' }] }, 'ann.transform');

    store.undo(tab.id);
    expect(workingBytesKey(store.active as SessionTab)).toBe(produced.id);
    store.undo(tab.id);
    expect(workingBytesKey(store.active as SessionTab)).toBe('source');
    store.redo(tab.id);
    expect(workingBytesKey(store.active as SessionTab)).toBe(produced.id);
  });
});
