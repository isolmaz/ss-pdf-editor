// @vitest-environment happy-dom
/**
 * The review as a file: what the user downloads (name, type, content) and what they are told, and
 * what an imported file does to the session — new marks with ids that cannot collide, the tab
 * dirty, a notice that counts what came in and what could not be placed.
 */

import type { AnnotationMark } from 'pdf-core';
import { serializeAnnotationsJson } from 'pdf-core/ops/annotation-data';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingOverlays } from '../../operations';
import { coreStore, initialCoreState } from '../core/core-store';
import { exportAnnotationData, importAnnotationData } from './annotation-data';
import { writeAnnotations } from './annotation-marks';
import { annotationsStore, existingAnnotationsRead, initialAnnotationsState } from './annotations-store';

const t = createTranslator('en');
const notice = () => coreStore.get().notice;

const mark = (id: string, extra: Partial<AnnotationMark> = {}): AnnotationMark => ({
  id,
  kind: 'note',
  pageIndex: 0,
  quads: [[10, 10, 30, 30]],
  color: '#ffcc00',
  opacity: 1,
  contents: 'body',
  author: 'Ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

let session: SessionStore;
const marksOf = () => pendingOverlays(session.active).annotations;

/** A viewer that measures every page 800 pt tall, except the pages in `unmeasured`. */
function viewerWith(unmeasured: readonly number[] = []): { readonly current: ViewerApi } {
  return {
    current: {
      pageGeometry: (index: number) =>
        unmeasured.includes(index) ? null : { x: 0, y: 0, width: 600, height: 800 },
    } as unknown as ViewerApi,
  };
}
const host = (viewer: { readonly current: ViewerApi | null } = { current: null }) => ({ session, t, viewer });

const downloads: { name: string; blob: Blob }[] = [];

beforeEach(() => {
  coreStore.set(initialCoreState());
  annotationsStore.set(initialAnnotationsState());
  session = new SessionStore();
  session.openDocument({ name: 'report.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 3 });
  session.setDirty(session.active?.id ?? '', false);
  downloads.length = 0;
  URL.createObjectURL = (blob: Blob) => {
    downloads.push({ name: '', blob });
    return 'blob:review';
  };
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const last = downloads[downloads.length - 1];
    if (last !== undefined) last.name = this.download;
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('exporting the review', () => {
  it('does nothing without a document', async () => {
    session = new SessionStore();
    await exportAnnotationData(host(), 'json');
    expect(notice()).toBeNull();
    expect(downloads).toEqual([]);
  });

  it('says there is nothing to export instead of writing an empty file', async () => {
    await exportAnnotationData(host(), 'json');
    await exportAnnotationData(host(), 'fdf');
    await exportAnnotationData(host(), 'xfdf');
    expect(notice()).toBe(t('ann.data.empty'));
    expect(downloads).toEqual([]);
  });

  it('downloads the marks as JSON named for the file, and counts them', async () => {
    writeAnnotations(session, [mark('a'), mark('b')]);
    await exportAnnotationData(host(), 'json');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toBe('report-comments.json');
    expect(downloads[0]?.blob.type).toBe('application/json');
    const text = await downloads[0]?.blob.text();
    expect(text).toBe(new TextDecoder().decode(serializeAnnotationsJson([mark('a'), mark('b')], 3)));
    expect(notice()).toBe(t('ann.data.exported', { count: 2, name: 'report-comments.json' }));
  });

  it('downloads the marks as FDF', async () => {
    writeAnnotations(session, [mark('a')]);
    await exportAnnotationData(host(), 'fdf');
    expect(downloads[0]?.name).toBe('report-comments.fdf');
    expect(downloads[0]?.blob.type).toBe('application/vnd.fdf');
    expect(notice()).toBe(t('ann.data.exported', { count: 1, name: 'report-comments.fdf' }));
    expect(await downloads[0]?.blob.text()).toContain('%FDF');
  });

  it('downloads the whole review as XFDF, placing marks with the page height the viewer measures', async () => {
    writeAnnotations(session, [mark('a')]);
    await exportAnnotationData(host(viewerWith()), 'xfdf');
    expect(downloads[0]?.name).toBe('report-comments.xfdf');
    expect(downloads[0]?.blob.type).toBe('application/vnd.adobe.xfdf');
    expect(await downloads[0]?.blob.text()).toContain('<xfdf');
    expect(notice()).toBe(t('ann.data.xfdfExported', { count: 1, name: 'report-comments.xfdf' }));
  });

  it('adds what it had to skip to the XFDF notice: a page the viewer cannot measure', async () => {
    writeAnnotations(session, [mark('a'), mark('b', { pageIndex: 1 })]);
    await exportAnnotationData(host(viewerWith([1])), 'xfdf');
    expect(notice()).toBe(
      `${t('ann.data.xfdfExported', { count: 1, name: 'report-comments.xfdf' })} ${t('ann.data.xfdfSkipped', { count: 1 })}`,
    );
  });

  it('says the review is empty when no page can be measured', async () => {
    writeAnnotations(session, [mark('a')]);
    await exportAnnotationData(host(), 'xfdf');
    expect(notice()).toBe(t('ann.data.empty'));
    expect(downloads).toEqual([]);
  });

  it('includes the file`s own comments, read at the moment of the export', async () => {
    existingAnnotationsRead([
      {
        id: 'own',
        pageIndex: 0,
        subtype: 'Text',
        rect: [10, 10, 30, 30],
        contents: 'from the file',
        author: 'Bob',
      },
    ] as never);
    await exportAnnotationData(host(), 'xfdf');
    expect(await downloads[0]?.blob.text()).toContain('from the file');
  });

  it('hands the blob URL back after ten seconds', async () => {
    writeAnnotations(session, [mark('a')]);
    await exportAnnotationData(host(), 'json');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:review');
  });
});

describe('importing a review', () => {
  const fileOf = (content: Uint8Array | string, name = 'review') =>
    new File([typeof content === 'string' ? content : (content as unknown as BlobPart)], name);

  it('adds the marks of a JSON review, marks the tab dirty and says how many came in', async () => {
    await importAnnotationData(host(), fileOf(serializeAnnotationsJson([mark('a'), mark('b')], 3)));
    expect(marksOf().map((m) => m.contents)).toEqual(['body', 'body']);
    expect(session.active?.dirty).toBe(true);
    expect(notice()).toBe(t('ann.data.imported', { count: 2 }));
  });

  /** The parser mints one id per mark; `ids` are the next draws, then every draw is `fresh`. */
  function drawIds(...ids: string[]) {
    const draw = vi.fn().mockReturnValue('fresh');
    for (const id of ids) draw.mockReturnValueOnce(id);
    vi.stubGlobal('crypto', { randomUUID: draw });
    return draw;
  }

  it('remints an id the session already holds, so one erase never deletes two marks', async () => {
    const bytes = serializeAnnotationsJson([mark('x')], 3);
    drawIds('dup', 'dup');
    await importAnnotationData(host(), fileOf(bytes));
    await importAnnotationData(host(), fileOf(bytes));
    expect(marksOf().map((m) => m.id)).toEqual(['dup', 'fresh']);
  });

  it('keeps minting until the new id is unused', async () => {
    const bytes = serializeAnnotationsJson([mark('x')], 3);
    // The parser draws `perImport` ids for one file; the second import then draws the colliding id once more.
    const probe = drawIds();
    await importAnnotationData(host(), fileOf(bytes));
    const perImport = probe.mock.calls.length;
    session.closeTab(session.active?.id ?? '');
    session.openDocument({ name: 'report.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 3 });
    drawIds(...Array.from({ length: 2 * perImport + 1 }, () => 'dup'));
    await importAnnotationData(host(), fileOf(bytes));
    await importAnnotationData(host(), fileOf(bytes));
    expect(marksOf().map((m) => m.id)).toEqual(['dup', 'fresh']);
  });

  it('gives two marks that arrive with the same id different ids', async () => {
    drawIds('dup', 'dup');
    await importAnnotationData(host(), fileOf(serializeAnnotationsJson([mark('x'), mark('y')], 3)));
    expect(marksOf().map((m) => m.id)).toEqual(['dup', 'fresh']);
  });

  const xfdf = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>${inner}</annots></xfdf>`;

  it('turns Acrobat`s page space into the app`s with the page height the viewer measures', async () => {
    await importAnnotationData(
      host(viewerWith()),
      fileOf(xfdf('<square page="0" name="s" rect="10,20,14,40" width="1"/>')),
    );
    expect(marksOf()).toHaveLength(1);
    expect(marksOf()[0]?.quads[0]).toEqual([10.5, 760.5, 13.5, 779.5]);
  });

  it('counts a comment on a page it cannot measure as skipped instead of landing it mirrored', async () => {
    await importAnnotationData(
      host(viewerWith([1])),
      fileOf(
        xfdf(
          '<square page="0" name="s" rect="10,20,14,40" width="1"/><square page="1" name="u" rect="10,20,14,40" width="1"/>',
        ),
      ),
    );
    expect(marksOf()).toHaveLength(1);
    expect(notice()).toBe(
      `${t('ann.data.imported', { count: 1 })} ${t('ann.data.importSkipped', { count: 1 })}`,
    );
  });

  it('skips every comment when there is no viewer to measure with, and writes nothing', async () => {
    await importAnnotationData(
      host(),
      fileOf(xfdf('<square page="0" name="s" rect="10,20,14,40" width="1"/>')),
    );
    expect(marksOf()).toEqual([]);
    expect(session.active?.dirty).toBe(false);
    expect(notice()).toBe(
      `${t('ann.data.imported', { count: 0 })} ${t('ann.data.importSkipped', { count: 1 })}`,
    );
  });

  it('counts the replies and review states that came with the comments', async () => {
    await importAnnotationData(
      host(viewerWith()),
      fileOf(
        xfdf(
          '<text page="0" rect="1,1,21,21" name="a" title="X"><contents>kept</contents></text>' +
            '<text page="0" rect="1,1,21,21" name="r" inreplyto="a" title="Y"><contents>Cevap</contents></text>' +
            '<text page="0" rect="1,1,21,21" name="s" inreplyto="a" state="Rejected" statemodel="Review"/>',
        ),
      ),
    );
    expect(notice()).toBe(
      `${t('ann.data.imported', { count: 1 })} ${t('ann.data.repliesImported', { count: 2 })}`,
    );
  });

  it('adds nothing for a valid review that carries no marks', async () => {
    await importAnnotationData(host(), fileOf(serializeAnnotationsJson([], 3)));
    expect(marksOf()).toEqual([]);
    expect(session.active?.dirty).toBe(false);
    expect(notice()).toBe(t('ann.data.imported', { count: 0 }));
  });

  it('parses without a document, but has no tab to put the marks in', async () => {
    session = new SessionStore();
    await importAnnotationData(host(), fileOf(serializeAnnotationsJson([mark('a')], 3)));
    expect(notice()).toBe(t('ann.data.imported', { count: 1 }));
  });

  it('says why a file that is not a review was refused', async () => {
    await importAnnotationData(host(), fileOf('not a review'));
    expect(notice()).not.toBeNull();
    expect(notice()).not.toBe(t('ann.data.imported', { count: 0 }));
    expect(marksOf()).toEqual([]);
  });

  it('answers an unexpected failure as an unsupported format, not a crash', async () => {
    const unreadable = { arrayBuffer: () => Promise.reject(new Error('disk')) } as unknown as File;
    await importAnnotationData(host(), unreadable);
    expect(notice()).toContain(t('error.unsupported-format.message'));
  });
});
