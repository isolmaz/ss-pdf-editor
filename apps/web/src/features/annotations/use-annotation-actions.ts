/** The annotation handlers bound to the shell's host, and the two effects that keep them honest. */

import type { AnnotationMark, ExistingAnnotation } from 'pdf-core';
import type { ViewerApi } from 'pdf-ui/viewer';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { type AnnotationDataFormat, exportAnnotationData, importAnnotationData } from './annotation-data';
import { existingAnnotationsRead } from './annotations-store';
import { takeEngineAnnotations } from './engine-takeover';
import type { AnnotationHost } from './host';
import { settleNativeEditors, sweepOrphanAnnotations } from './orphans';

export interface AnnotationActions {
  readonly exportAnnotationData: (format: AnnotationDataFormat) => Promise<void>;
  readonly importAnnotationData: (file: File) => Promise<void>;
  /** Take over what the engine's editor produced for `api` (the viewer's current document by default). */
  readonly takeEngineAnnotations: (api?: ViewerApi | null) => readonly AnnotationMark[];
  /** Commit native editors; whether the engine still holds entries that must be materialised. */
  readonly settleNativeEditors: () => boolean;
  readonly sweepOrphanAnnotations: () => Promise<void>;
}

/**
 * The handlers, rebuilt only when what they run on changes. The tool style is not a dependency:
 * `takeEngineAnnotations` is handed to the viewer pane, whose load effect depends on it, and
 * reading the style at call time is what stops "change the colour" from tearing down and
 * rebuilding the pdf.js stack.
 */
export function useAnnotationActions(host: AnnotationHost): AnnotationActions {
  const { session, t, viewer, cancel, contextFor, setHandle } = host;
  return useMemo(() => {
    const bound: AnnotationHost = { session, t, viewer, cancel, contextFor, setHandle };
    return {
      exportAnnotationData: (format) => exportAnnotationData(bound, format),
      importAnnotationData: (file) => importAnnotationData(bound, file),
      takeEngineAnnotations: (api) => takeEngineAnnotations(bound, api),
      settleNativeEditors: () => settleNativeEditors(bound),
      sweepOrphanAnnotations: () => sweepOrphanAnnotations(bound),
    };
  }, [session, t, viewer, cancel, contextFor, setHandle]);
}

/**
 * Entering select (`markMode` is `'select'`) hands the pointer to the common layer, so a
 * restored native gesture is committed and taken over, and an entry the app cannot model is
 * materialised into bytes rather than silently kept.
 */
export function useSettleNativeEditors(markMode: 'select' | null, actions: AnnotationActions): void {
  useEffect(() => {
    if (markMode === null) return;
    if (!actions.settleNativeEditors()) return;
    void actions.sweepOrphanAnnotations();
  }, [markMode, actions]);
}

/**
 * Publish the file's annotations for the bytes on screen to the store, for the handlers that
 * read them at call time. Committed with the render that computed them, so a handler never
 * sees a list that describes a version already replaced.
 */
export function usePublishExistingAnnotations(existing: readonly ExistingAnnotation[] | null): void {
  useLayoutEffect(() => existingAnnotationsRead(existing), [existing]);
}
