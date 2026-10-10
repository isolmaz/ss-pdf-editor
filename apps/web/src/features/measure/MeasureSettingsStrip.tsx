import type { Translator } from 'pdf-shared';
import { lazy, Suspense } from 'react';
import {
  chooseMeasureMode,
  setMeasureGrid,
  setMeasureScale,
  setMeasureSnapGrid,
  setMeasureSnapPoints,
  setMeasureSpacing,
  stopMeasure,
  useMeasure,
  useMeasureMode,
} from './measure-store';

/** The settings strip arrives with the tool: the ruler geometry is not first-paint code. */
const MeasureSettings = lazy(async () => {
  const module = await import('pdf-ui');
  return { default: module.MeasureSettings };
});

export interface MeasureSettingsStripProps {
  readonly t: Translator;
  /**
   * The annotation style the ruler shares with the marker tools: a ruler and a highlighter are
   * the same kind of mark, so the strip edits the same state the marker tools do.
   */
  readonly color: string;
  readonly onColor: (color: string) => void;
  readonly opacity: number;
  readonly onOpacity: (opacity: number) => void;
  readonly thickness: number;
  readonly onThickness: (thickness: number) => void;
  readonly author: string;
  readonly onAuthor: (author: string) => void;
}

/**
 * The tool strip's measure settings, wired to the measure store. It reads the armed mode, the
 * scale, the grid and the live reading from it, so the live reading re-renders this strip and
 * not the shell.
 */
export function MeasureSettingsStrip({
  t,
  color,
  onColor,
  opacity,
  onOpacity,
  thickness,
  onThickness,
  author,
  onAuthor,
}: MeasureSettingsStripProps) {
  const mode = useMeasureMode();
  const scale = useMeasure((state) => state.scale);
  const grid = useMeasure((state) => state.grid);
  const spacing = useMeasure((state) => state.spacing);
  const snapGrid = useMeasure((state) => state.snapGrid);
  const snapPoints = useMeasure((state) => state.snapPoints);
  const reading = useMeasure((state) => state.reading);
  return (
    <Suspense fallback={null}>
      <MeasureSettings
        t={t}
        mode={mode}
        onMode={chooseMeasureMode}
        scale={scale}
        onScale={setMeasureScale}
        grid={grid}
        onGrid={setMeasureGrid}
        gridSpacing={spacing}
        onGridSpacing={setMeasureSpacing}
        snapGrid={snapGrid}
        onSnapGrid={setMeasureSnapGrid}
        snapPoints={snapPoints}
        onSnapPoints={setMeasureSnapPoints}
        color={color}
        onColor={onColor}
        opacity={opacity}
        onOpacity={onOpacity}
        thickness={thickness}
        onThickness={onThickness}
        author={author}
        onAuthor={onAuthor}
        reading={reading}
        onStop={stopMeasure}
      />
    </Suspense>
  );
}
