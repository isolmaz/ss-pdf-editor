/**
 * The review as a file (`ops/annotation-data.ts`). The session's marks leave as JSON
 * (lossless), FDF (the container Acrobat's own comment export uses, carrying the same
 * records) or XFDF, and come back the same way — a mark the engine drew is in the engine's
 * storage and a mark we own is in the session, so neither travels inside the PDF until a save
 * writes it.
 */

import type { AnnotationDataResult } from 'pdf-core/ops/annotation-data';
import { workingPageCount } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { pendingOverlays } from '../../operations';
import { showNotice } from '../core/core-store';
import { writeAnnotations } from './annotation-marks';
import { knownExistingAnnotations } from './annotations-store';
import type { AnnotationHost } from './host';

type DataHost = Pick<AnnotationHost, 'session' | 't' | 'viewer'>;

/** The media type each export format is delivered as. */
const MEDIA_TYPES = {
  json: 'application/json',
  fdf: 'application/vnd.fdf',
  xfdf: 'application/vnd.adobe.xfdf',
} as const;

export type AnnotationDataFormat = keyof typeof MEDIA_TYPES;

/** Hand `bytes` to the user as a download named `name`. */
function download(bytes: Uint8Array, name: string, format: AnnotationDataFormat): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: MEDIA_TYPES[format] });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Blob URLs are cleaned up right after the operation.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Export the active tab's review in `format`; an empty review is said, not written. */
export async function exportAnnotationData(host: DataHost, format: AnnotationDataFormat): Promise<void> {
  const { session, t } = host;
  const tab = session.active;
  if (tab === null) return;
  const marks = pendingOverlays(tab).annotations;
  const name = `${tab.name.replace(/\.pdf$/i, '')}-comments.${format}`;
  let bytes: Uint8Array;
  let message: string;
  if (format === 'xfdf') {
    // XFDF is the whole review: the file's own comments and their threads as well as the
    // session's marks, so it is loaded only when asked for.
    const { serializeXfdf } = await import('pdf-core/ops/annotation-xfdf');
    const exported = serializeXfdf({
      marks,
      existing: knownExistingAnnotations() ?? [],
      pageTop: (pageIndex) => {
        const geometry = host.viewer.current?.pageGeometry(pageIndex) ?? null;
        return geometry === null ? null : geometry.y + geometry.height;
      },
      fileName: tab.name,
    });
    if (exported.count === 0) {
      showNotice(t('ann.data.empty'));
      return;
    }
    bytes = exported.bytes;
    message =
      exported.skipped === 0
        ? t('ann.data.xfdfExported', { count: exported.count, name })
        : `${t('ann.data.xfdfExported', { count: exported.count, name })} ${t('ann.data.xfdfSkipped', { count: exported.skipped })}`;
  } else {
    if (marks.length === 0) {
      showNotice(t('ann.data.empty'));
      return;
    }
    const pageCount = workingPageCount(tab);
    const data = await import('pdf-core/ops/annotation-data');
    bytes =
      format === 'json'
        ? data.serializeAnnotationsJson(marks, pageCount)
        : data.serializeAnnotationsFdf(marks, pageCount);
    message = t('ann.data.exported', { count: marks.length, name });
  }
  download(bytes, name, format);
  showNotice(message);
}

/**
 * Import a review file into the active tab as new marks. Ids are reminted at the boundary
 * where a foreign file becomes session state: JSON import mints fresh ids, but FDF carries the
 * `/NM` the file was annotated with, and that name is not unique across documents — two
 * imports of the same review, or an import over a session that already holds the mark, would
 * produce duplicate identities. Duplicate ids break React keys and make one erase delete
 * several marks.
 */
export async function importAnnotationData(host: DataHost, file: File): Promise<void> {
  const { session, t } = host;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // XFDF is XML; everything else this reads is JSON or FDF. The XML reader is loaded only
    // for a file that starts like one.
    const head = new TextDecoder('utf-8').decode(bytes.slice(0, 64)).trimStart();
    // Both readers are their own chunks: an import is a user action, not first paint.
    const data = await import('pdf-core/ops/annotation-data');
    const parsed: AnnotationDataResult = head.startsWith('<')
      ? await (await import('pdf-core/ops/annotation-xfdf')).parseXfdf(bytes)
      : data.parseAnnotationData(bytes);
    // Acrobat's comments are in PDF user space; the page's own top edge turns them into the
    // app's space. A page the viewer cannot measure is not guessed at: its comments are
    // counted as skipped instead of landing mirrored.
    let unplaced = 0;
    const placed =
      parsed.space === 'app'
        ? parsed.marks
        : parsed.marks.flatMap((mark) => {
            const geometry = host.viewer.current?.pageGeometry(mark.pageIndex) ?? null;
            if (geometry === null) {
              unplaced += 1;
              return [];
            }
            return [data.toAppSpace(mark, geometry.y + geometry.height)];
          });
    const result = { ...parsed, marks: placed, skipped: parsed.skipped + unplaced };
    if (result.marks.length > 0) {
      writeAnnotations(session, (current) => {
        const used = new Set(current.map((mark) => mark.id));
        const imported = result.marks.map((mark) => {
          if (!used.has(mark.id)) {
            used.add(mark.id);
            return mark;
          }
          let id = crypto.randomUUID();
          while (used.has(id)) id = crypto.randomUUID();
          used.add(id);
          return { ...mark, id };
        });
        return [...current, ...imported];
      });
      const id = session.active?.id;
      if (id !== undefined) session.setDirty(id, true);
    }
    const answers = result.marks.reduce(
      (sum, mark) => sum + (mark.replies?.length ?? 0) + (mark.review === undefined ? 0 : 1),
      0,
    );
    showNotice(
      [
        t('ann.data.imported', { count: result.marks.length }),
        ...(answers === 0 ? [] : [t('ann.data.repliesImported', { count: answers })]),
        ...(result.skipped === 0 ? [] : [t('ann.data.importSkipped', { count: result.skipped })]),
      ].join(' '),
    );
  } catch (error) {
    const toolError =
      error instanceof ToolError ? error : new ToolError('unsupported-format', { engine: 'model' });
    showNotice(`${t(toolError.messageKey)} ${t(toolError.hintKey)}`);
  }
}
