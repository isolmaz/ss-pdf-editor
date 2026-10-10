/**
 * The text tool's layer. It wears its own layer rather than sharing the annotation one: it reads
 * the page's structured text (an engine call) and paints block boxes, and the annotation layer's
 * gesture set has nothing to do with it. It is inert unless its own tool is armed, and it only
 * mounts once its bytes are in hand — anything else would paint a model of a document nobody
 * asked for.
 */

import type { Translator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import { lazy, Suspense } from 'react';
import { selectTool, useCore } from '../core/core-store';
import { textBlockPicked, useTextTool } from './text-tool-store';

// A dynamic chunk: the shell's first paint must not carry the text engine (the entry budget is locked).
const TextLayer = lazy(async () => {
  const module = await import('pdf-ui/text-edit');
  return { default: module.TextLayer };
});

/** The block overlay while the text tool is armed; a picked paragraph opens the text-edit dialog. */
export function TextToolSurface({
  viewer,
  layout,
  currentPage,
  t,
  onEdit,
}: {
  readonly viewer: ViewerApi | null;
  /** The shell's layout revision, for the blocks to be placed again at each layout. */
  readonly layout: number;
  readonly currentPage: number;
  readonly t: Translator;
  /** Open the text-edit dialog on the block just picked. */
  readonly onEdit: () => void;
}) {
  const armed = useCore((state) => state.canvasTool === 'text');
  const bytes = useTextTool((state) => state.bytes);
  if (!armed || viewer === null || bytes === null) return null;
  return (
    <Suspense fallback={null}>
      <TextLayer
        t={t}
        viewer={viewer}
        layout={layout}
        bytes={bytes}
        pageIndex={currentPage}
        onSelect={(selection) => {
          textBlockPicked(selection);
          selectTool('select');
          onEdit();
        }}
        onClose={() => selectTool('select')}
      />
    </Suspense>
  );
}
