import type { MeasureMark } from 'pdf-core/ops/measure';
import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { lazy, Suspense } from 'react';
import { addMeasureMark } from './measure-marks';
import { setMeasureReading, stopMeasure, useMeasure, useMeasureMode } from './measure-store';

/** The layer arrives with the tool: it carries the annotation writer and the ruler geometry. */
const MeasureLayer = lazy(async () => {
  const module = await import('pdf-ui');
  return { default: module.MeasureLayer };
});

export interface MeasureOverlayProps {
  readonly t: Translator;
  readonly session: SessionStore;
  readonly viewer: ViewerApi;
  /** The shell's layout revision, for the measurements to be placed again at each layout. */
  readonly layout: number;
  /** The measurements to draw: the session's, minus any the viewer hides. */
  readonly marks: readonly MeasureMark[];
  /** The ruler takes the pointer only while the document can be edited. */
  readonly canEdit: boolean;
  /** The annotation style a new measurement is written with. */
  readonly color: string;
  readonly opacity: number;
  readonly thickness: number;
  readonly author: string;
}

/**
 * The ruler's overlay over the pages, wired to the measure store: the mode, scale and grid come
 * from it, the live reading goes back to it, and a finished measurement joins the session's
 * marks. Measurements stay drawn after the ruler is put away; only creation follows the tool.
 * It draws nothing when no ruler is armed and there is nothing to show.
 */
export function MeasureOverlay({
  t,
  session,
  viewer,
  layout,
  marks,
  canEdit,
  color,
  opacity,
  thickness,
  author,
}: MeasureOverlayProps) {
  const mode = useMeasureMode();
  const scale = useMeasure((state) => state.scale);
  const grid = useMeasure((state) => state.grid);
  const spacing = useMeasure((state) => state.spacing);
  const snapGrid = useMeasure((state) => state.snapGrid);
  const snapPoints = useMeasure((state) => state.snapPoints);
  if (mode === null && marks.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <MeasureLayer
        t={t}
        viewer={viewer}
        layout={layout}
        mode={canEdit ? mode : null}
        scale={scale}
        marks={marks}
        color={color}
        opacity={opacity}
        thickness={thickness}
        author={author}
        grid={mode !== null && grid}
        gridSpacing={spacing}
        snapGrid={snapGrid}
        snapPoints={snapPoints}
        onReading={setMeasureReading}
        onStop={stopMeasure}
        onCreate={(mark) => addMeasureMark(session, mark)}
      />
    </Suspense>
  );
}
