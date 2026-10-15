import type { PdfDocumentHandle } from 'pdf-core';
import type { AnnotationMark } from 'pdf-core/ops/annotations';
import { useEffect, useMemo, useState } from 'react';

/** A thumbnail's caption: the page number, with the file's own label before it when the two differ. */
export function pageCaption(label: string | undefined, pageIndex: number): string {
  const number = String(pageIndex + 1);
  return label === undefined || label === '' || label === number ? number : `${label} (${number})`;
}

/**
 * The file's page labels. Written by the page-labels tool and shown by every other reader;
 * without them here the tool's result was visible everywhere but in the app.
 */
export function usePageLabels(document: PdfDocumentHandle): readonly string[] | null {
  const [labels, setLabels] = useState<readonly string[] | null>(null);
  useEffect(() => {
    let current = true;
    setLabels(null);
    document.getPageLabels().then(
      (read) => {
        if (current) setLabels(read);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [document]);
  return labels;
}

export const NO_MARKS: readonly AnnotationMark[] = [];

/**
 * The session's marks the file does not hold yet, by page. The main view draws them over the
 * page; a thumbnail without them showed a page the reader had already marked as clean.
 */
export function useMarksByPage(
  marks: readonly AnnotationMark[] | undefined,
): ReadonlyMap<number, readonly AnnotationMark[]> {
  return useMemo(() => {
    const byPage = new Map<number, AnnotationMark[]>();
    for (const mark of marks ?? []) {
      const list = byPage.get(mark.pageIndex);
      if (list === undefined) byPage.set(mark.pageIndex, [mark]);
      else list.push(mark);
    }
    return byPage;
  }, [marks]);
}
