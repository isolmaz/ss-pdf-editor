/**
 * What an operation on the document on screen asks of the shell: the context it runs in, the
 * tier's verdict, and whether the document may be edited — each read from the stores when called.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialOpenState, lockTab, openStore } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { coreStore, initialCoreState, setBusy } from './core-store';
import { canEdit, deviceTier, documentContext, documentVerdict, isEditable } from './document';
import { adoptHandle, dropHandle } from './handles';

const t = createTranslator('en');
const handle = { name: 'handle' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let tab: SessionTab;

beforeEach(() => {
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  session = new SessionStore();
  tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'a', pageCount: 2 });
  adoptHandle(tab.id, handle);
  viewerChanged({ document: handle } as unknown as ViewerApi);
});
afterEach(() => dropHandle(tab.id));

describe('deviceTier', () => {
  it('is one tier, read once', () => {
    expect(['desktop', 'mobile']).toContain(deviceTier());
    expect(deviceTier()).toBe(deviceTier());
  });
});

describe('documentContext', () => {
  it('names the session, the translator, the tab and the handle an operation runs on', () => {
    expect(documentContext(session, t, tab, handle)).toEqual({ store: session, t, tab, handle });
  });
});

describe('documentVerdict', () => {
  it('judges an empty document, then the tab by its working bytes', () => {
    expect(documentVerdict(null, 'desktop').kind).not.toBe('viewing-only');
    expect(documentVerdict(tab, 'desktop').kind).not.toBe('viewing-only');
  });

  it('reads the produced version once there is one', () => {
    session.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([4, 5]),
      pageCount: 2,
      labelKey: 'panel.layers',
      engine: 'mupdf',
      steps: [],
      overlays: null,
    });
    const produced = session.active as SessionTab;
    expect(produced.working.produced?.bytes.byteLength).toBe(2);
    expect(documentVerdict(produced, 'desktop').kind).not.toBe('viewing-only');
  });
});

describe('isEditable', () => {
  const input = () => ({
    tab,
    handle,
    viewerShowsHandle: true,
    verdict: documentVerdict(tab, 'desktop'),
    locked: false,
    busy: false,
  });

  it('allows a shown, allowed, unprotected, idle document', () => {
    expect(isEditable(input())).toBe(true);
  });

  it.each([
    ['no tab', { tab: null }],
    ['no handle', { handle: null }],
    ['a viewer not showing the handle', { viewerShowsHandle: false }],
    ['a document the tier allows only to view', { verdict: { kind: 'viewing-only' } as never }],
    ['a protected document', { locked: true }],
    ['a held document', { busy: true }],
  ])('refuses %s', (_what, over) => {
    expect(isEditable({ ...input(), ...over })).toBe(false);
  });
});

describe('canEdit', () => {
  it('reads the stores at the moment it is called', () => {
    expect(canEdit(session)).toBe(true);
    setBusy(true);
    expect(canEdit(session)).toBe(false);
    setBusy(false);
    viewerChanged(null);
    expect(canEdit(session)).toBe(false);
    viewerChanged({ document: handle } as unknown as ViewerApi);
    expect(canEdit(session)).toBe(true);
    lockTab(tab.id, 'pw');
    expect(canEdit(session)).toBe(false);
  });

  it('is false with no document open, or before the tab has an engine handle', () => {
    expect(canEdit(new SessionStore())).toBe(false);
    dropHandle(tab.id);
    expect(canEdit(session)).toBe(false);
  });
});
