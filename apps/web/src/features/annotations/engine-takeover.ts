/**
 * Taking over what the engine's annotation editor produced.
 *
 * The engine holds its editors in `annotationStorage`, where the next `saveDocument()` would
 * write them. The app needs them in its own list first — the journal, the comment panel and the
 * retag step all read that list — so each captured entry becomes a mark and its storage entry
 * is removed. Leaving it would make the same annotation arrive twice: once from the storage and
 * once from our own writer.
 */

import type { AnnotationMark } from 'pdf-core';
import { marksFromEngineEntries } from 'pdf-core/ops/annotations';
import type { ViewerApi } from 'pdf-ui/viewer';
import { pendingOverlays } from '../../operations';
import { showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';
import { writeAnnotations } from './annotation-marks';
import { annotationsStore } from './annotations-store';
import type { AnnotationHost } from './host';

type TakeoverHost = Pick<AnnotationHost, 'session' | 't' | 'viewer'>;

/**
 * Takes over every annotation the engine's editor produced for `api`'s document (the viewer's
 * current one by default), and **returns them**.
 *
 * Returning the list, not only storing it, is what lets a save/export started in the same tick
 * see the marks it just captured: the state update has not rendered by then.
 */
export function takeEngineAnnotations(
  host: TakeoverHost,
  api: ViewerApi | null = host.viewer.current,
): readonly AnnotationMark[] {
  const { session, t } = host;
  if (api === null || api.document !== handleFor(session.active?.id ?? '')) return [];
  const entries = api.captureAnnotationEntries();
  if (entries.length === 0) return [];
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (let index = 0; index < api.document.pageCount; index += 1) {
    // PDF **user space**, not CSS pixels: the engine's own records and this model both express
    // geometry in points from the page's top-left. Mixing the two mapped every captured mark
    // onto the wrong part of the page — a 1527 px page box against 841.89 pt of geometry
    // (2026-09-16).
    const geometry = api.pageGeometry(index);
    if (geometry === null) continue;
    boxes[index] = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
  }
  // The engine's own record wins where it carries a value; the style is only the default for
  // the ones it does not, read now rather than when this was built.
  const { color, opacity, author } = annotationsStore.get().style;
  const marks = marksFromEngineEntries(entries, boxes, { color, opacity, author });
  if (marks.length === 0) return [];
  for (const mark of marks) api.dropAnnotationEntry(mark.id);
  const current = pendingOverlays(session.active).annotations;
  // Engine ids restart when history reopens the viewer. They identify entries only until
  // removal, never durable marks: reusing one would lose the next stroke after undo/redo by
  // confusing it with a restored owned annotation.
  const added = marks.map((mark) => ({ ...mark, id: crypto.randomUUID() }));
  writeAnnotations(session, [...current, ...added]);
  showNotice(t('ann.captured', { count: marks.length }));
  return added;
}
