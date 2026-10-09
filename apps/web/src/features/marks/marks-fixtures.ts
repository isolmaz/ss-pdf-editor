/** Test builders for the marks feature: a session with marks on it, a host, and their targets. */

import type { AnnotationMark, ExistingAnnotation } from 'pdf-core';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type JsonValue, SessionStore, type SessionTab } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { type MarkTarget, markTargetKey } from 'pdf-ui/tools';
import { type Mock, vi } from 'vitest';
import type { MarkedRedaction } from '../../annotation-interaction';
import type { DocumentContext, PendingOverlays } from '../../operations';
import { annotationsStore, initialAnnotationsState } from '../annotations/annotations-store';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle } from '../core/handles';
import { formsStore, initialFormsState } from '../forms/forms-store';
import { initialSelectionState, selectionStore } from '../selection/selection-store';
import type { MarksHost } from './host';
import { initialMarksState, marksStore } from './marks-store';
import { initialRedactionState, redactionStore } from './redaction-store';

export const t = createTranslator('en');

/** An engine handle with no engine behind it (`hasEngineEdits` is mocked where it matters). */
export function fakeHandle(): PdfDocumentHandle {
  return { raw: {}, pageCount: 2, destroy: vi.fn(async () => undefined) } as unknown as PdfDocumentHandle;
}

/** One promise the test settles by hand. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** One macrotask: every microtask the code under test queued has run. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Replace a tab's pending overlay, as the writers do: one journal step. */
export function writeMarks(session: SessionStore, tabId: string, overlays: PendingOverlays): void {
  session.setOverlays(tabId, overlays as unknown as JsonValue, 'panel.redaction');
}

export const redactionMark = (id: string, pageIndex = 0): MarkedRedaction => ({
  id,
  mark: { pageIndex, space: 'app-v1', rect: [10, 10, 50, 30] },
});

export const redactionTarget = (id: string, pageIndex = 0): MarkTarget => ({
  key: markTargetKey('redaction', id, pageIndex),
  family: 'redaction',
  id,
  pageIndex,
  boxes: [[10, 10, 50, 30]],
  label: 'Redaction',
});

export const annotationMark = (id: string): AnnotationMark => ({
  id,
  kind: 'note',
  pageIndex: 0,
  quads: [],
  color: '#ffcc00',
  opacity: 1,
  contents: '',
  author: 'Ada',
  createdAt: '2026-01-01T00:00:00.000Z',
});

/** An annotation the file carries; `marker` is the session mark this app wrote it for, if any. */
export const fileAnnotation = (id: string, marker: string | null = null): ExistingAnnotation => ({
  id,
  subtype: 'Square',
  pageIndex: 0,
  kind: null,
  rect: [60, 60, 90, 90],
  contents: '',
  marker,
  author: '',
  modified: null,
  pageBox: [0, 0, 200, 200],
});

export const existingTarget = (id: string, pageIndex = 0): MarkTarget => ({
  key: markTargetKey('existing', id, pageIndex),
  family: 'existing',
  id,
  pageIndex,
  boxes: [[60, 60, 90, 90]],
  label: 'Square · in file',
});

export interface MarksWorld {
  readonly session: SessionStore;
  readonly tab: SessionTab;
  readonly handle: PdfDocumentHandle;
  readonly host: MarksHost & {
    readonly canEdit: { current: boolean };
    readonly setHandle: Mock;
    readonly refuseBusy: Mock;
    readonly checkpointEngineValues: Mock;
  };
}

/**
 * Reset every store the marks feature reads, open one tab with the engine handle `handle`, put
 * two redaction marks on it, and describe them (and one mark the file carries) as targets.
 */
export function marksWorld(overrides: Partial<MarksHost> = {}): MarksWorld {
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  formsStore.set(initialFormsState());
  marksStore.set(initialMarksState());
  redactionStore.set(initialRedactionState());
  selectionStore.set(initialSelectionState());
  const session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'hash', pageCount: 2 });
  const tab = session.active as SessionTab;
  const handle = fakeHandle();
  adoptHandle(tab.id, handle);
  writeMarks(session, tab.id, {
    annotations: [],
    measures: [],
    redactions: [redactionMark('r1'), redactionMark('r2')],
  });
  marksStore.set({ targets: [redactionTarget('r1'), redactionTarget('r2'), existingTarget('e1')] });
  const host = {
    session,
    t,
    cancel: { current: null },
    canEdit: { current: true },
    contextFor: (forTab: SessionTab, forHandle: PdfDocumentHandle): DocumentContext => ({
      store: session,
      t,
      tab: forTab,
      handle: forHandle,
    }),
    setHandle: vi.fn(),
    refuseBusy: vi.fn(),
    checkpointEngineValues: vi.fn(async () => false),
    ...overrides,
  } as MarksWorld['host'];
  return { session, tab, handle, host };
}
