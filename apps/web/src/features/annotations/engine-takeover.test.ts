/**
 * Taking over what the engine's annotation editor produced: which entries become marks, what the
 * engine is told to drop, what the session and the status line receive — and what is left alone.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingOverlays } from '../../operations';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { writeAnnotations } from './annotation-marks';
import {
  annotationsStore,
  chooseAuthor,
  chooseColor,
  chooseOpacity,
  initialAnnotationsState,
} from './annotations-store';
import { takeEngineAnnotations } from './engine-takeover';

const t = createTranslator('en');
const notice = () => coreStore.get().notice;

/** An engine highlight over a text selection (annotation type 9), in PDF user space. */
const highlight = (id: string, value: Record<string, unknown> = {}) => ({
  id,
  value: {
    annotationType: 9,
    pageIndex: 0,
    quadPoints: [10, 700, 110, 700, 10, 690, 110, 690],
    ...value,
  },
});

let session: SessionStore;
let handle: PdfDocumentHandle;
let entries: ReturnType<typeof highlight>[];
const dropAnnotationEntry = vi.fn();

function viewerFor(document: PdfDocumentHandle, unmeasured: readonly number[] = []): ViewerApi {
  return {
    document,
    captureAnnotationEntries: () => entries,
    dropAnnotationEntry,
    pageGeometry: (index: number) =>
      unmeasured.includes(index) ? null : { x: 0, y: 0, width: 600, height: 800 },
  } as unknown as ViewerApi;
}

const host = (api: ViewerApi | null) => ({ session, t, viewer: { current: api } });

beforeEach(() => {
  vi.clearAllMocks();
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 2 });
  handle = { pageCount: 2 } as unknown as PdfDocumentHandle;
  adoptHandle(session.active?.id ?? '', handle);
  entries = [highlight('e1')];
  return () => {
    dropHandle(session.active?.id ?? '');
  };
});

describe('takeEngineAnnotations', () => {
  it('takes nothing without a viewer', () => {
    expect(takeEngineAnnotations(host(null))).toEqual([]);
    expect(dropAnnotationEntry).not.toHaveBeenCalled();
  });

  it('takes nothing from a viewer that is not showing the active tab`s document', () => {
    const other = { pageCount: 1 } as unknown as PdfDocumentHandle;
    expect(takeEngineAnnotations(host(viewerFor(other)))).toEqual([]);
    expect(dropAnnotationEntry).not.toHaveBeenCalled();
  });

  it('takes nothing when there is no active tab', () => {
    session = new SessionStore();
    expect(takeEngineAnnotations(host(viewerFor(handle)))).toEqual([]);
  });

  it('takes nothing when the engine holds no entries', () => {
    entries = [];
    expect(takeEngineAnnotations(host(viewerFor(handle)))).toEqual([]);
    expect(notice()).toBeNull();
  });

  it('leaves entries it cannot model in the engine, untouched and unannounced', () => {
    entries = [highlight('own', { id: 'pdf-annotation' }), highlight('stamp', { annotationType: 13 })];
    expect(takeEngineAnnotations(host(viewerFor(handle)))).toEqual([]);
    expect(dropAnnotationEntry).not.toHaveBeenCalled();
    expect(pendingOverlays(session.active).annotations).toEqual([]);
    expect(notice()).toBeNull();
  });

  it('turns an entry into a mark with a fresh id, drops it from the engine, stores it and says so', () => {
    const taken = takeEngineAnnotations(host(viewerFor(handle)));
    expect(taken).toHaveLength(1);
    expect(taken[0]?.kind).toBe('highlight');
    expect(taken[0]?.id).not.toBe('e1');
    expect(taken[0]?.quads).toEqual([[10, 100, 110, 110]]);
    expect(dropAnnotationEntry).toHaveBeenCalledWith('e1');
    expect(pendingOverlays(session.active).annotations).toEqual(taken);
    expect(notice()).toBe(t('ann.captured', { count: 1 }));
  });

  it('adds to the marks the session already holds', () => {
    writeAnnotations(session, [
      {
        id: 'old',
        kind: 'note',
        pageIndex: 0,
        quads: [],
        color: '#000',
        opacity: 1,
        contents: '',
        author: '',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const taken = takeEngineAnnotations(host(viewerFor(handle)));
    expect(pendingOverlays(session.active).annotations.map((mark) => mark.id)).toEqual(['old', taken[0]?.id]);
  });

  it('draws with the style as it is when the entry is taken, not as it was when the handler was built', () => {
    const build = host(viewerFor(handle));
    chooseColor('#123456');
    chooseOpacity(0.7);
    chooseAuthor('Grace');
    const [mark] = takeEngineAnnotations(build);
    expect([mark?.color, mark?.opacity, mark?.author]).toEqual(['#123456', 0.7, 'Grace']);
  });

  it('lets the engine`s own record win where it carries a value', () => {
    entries = [highlight('e1', { color: [255, 0, 0], opacity: 0.5, user: 'Bob' })];
    chooseAuthor('Grace');
    const [mark] = takeEngineAnnotations(host(viewerFor(handle)));
    expect([mark?.color, mark?.opacity, mark?.author]).toEqual(['#ff0000', 0.5, 'Bob']);
  });

  it('skips an entry on a page the viewer cannot measure', () => {
    entries = [highlight('e1', { pageIndex: 1 })];
    expect(takeEngineAnnotations(host(viewerFor(handle, [1])))).toEqual([]);
    expect(dropAnnotationEntry).not.toHaveBeenCalled();
  });

  it('reads the viewer`s document when none is named', () => {
    const api = viewerFor(handle);
    expect(takeEngineAnnotations(host(api))).toHaveLength(1);
    expect(takeEngineAnnotations(host(api), null)).toEqual([]);
  });
});
