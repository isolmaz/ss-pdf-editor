/** The common layer's targets for the document on screen, derived once per change of the model. */

import type { AnnotationMark, ExistingAnnotation, MeasureMark } from 'pdf-core';
import type { Translator } from 'pdf-shared';
import type { MarkTarget } from 'pdf-ui/tools';
import type { ViewerApi } from 'pdf-ui/viewer';
import { useLayoutEffect, useMemo } from 'react';
import { buildMarkTargets, type MarkedRedaction } from '../../annotation-interaction';
import { markTargetsPublished } from './marks-store';

export interface MarkTargetsInput {
  readonly annotations: readonly AnnotationMark[];
  readonly measures: readonly MeasureMark[];
  readonly redactions: readonly MarkedRedaction[];
  /** The file's own annotations for the bytes on screen; `null` while the read is in flight. */
  readonly existing: readonly ExistingAnnotation[] | null;
  readonly viewer: ViewerApi | null;
  readonly t: Translator;
}

/**
 * Every mark the page shows, in the common layer's identity space: the session's
 * annotations, its measurements, its redaction intents and the annotations the file
 * itself carries, with our own saved marks deduplicated against their pending
 * copies (`annotation-interaction.ts`).
 *
 * Memoized on the model it is derived from: the geometry conversion walks every
 * existing annotation and every page, which is not work a re-render should repeat. The
 * list is published to the marks store with the render that computed it, so a handler never
 * reads targets that describe a version already replaced.
 */
export function useMarkTargets({
  annotations,
  measures,
  redactions,
  existing,
  viewer,
  t,
}: MarkTargetsInput): readonly MarkTarget[] {
  const targets = useMemo(
    () =>
      existing === null
        ? []
        : buildMarkTargets({
            annotations,
            measures,
            redactions,
            existing,
            // The page's own top edge: `viewBox[3]` read from the fields the viewer
            // has always returned (`y + height`), the same edge `pointToPage` flips
            // against. The writer's own `pageBox` wins where it is available.
            pageTop: (pageIndex) => {
              const geometry = viewer?.pageGeometry(pageIndex) ?? null;
              return geometry === null ? null : geometry.y + geometry.height;
            },
            labelFor: (family, messageKey, subtype) => {
              const name = t(messageKey);
              if (family !== 'existing') return name;
              return subtype === undefined
                ? `${name} · ${t('ann.inFile')}`
                : `${subtype} · ${t('ann.inFile')}`;
            },
          }),
    [annotations, existing, measures, redactions, t, viewer],
  );
  useLayoutEffect(() => markTargetsPublished(targets), [targets]);
  return targets;
}
