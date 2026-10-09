/** The document canvas: the viewer, every mark layer drawn over its pages, and the dock edge handles. */

import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { LinkTargetRect } from 'pdf-core/ops/link-edit';
import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { type CanvasToolId, MarkInteractionLayer, type StampPlacement } from 'pdf-ui/tools';
import { AnnotationLayer, type AnnotationTool } from 'pdf-ui/ui';
import { PdfViewerPane, type ViewerApi } from 'pdf-ui/viewer';
import { Suspense } from 'react';
import { useAnnotationMarks } from '../annotations/annotation-marks';
import { useAnnotationStyle } from '../annotations/annotations-store';
import { selectTool, showLeftDock, showRightDock, useCore } from '../core/core-store';
import { FieldCandidateHost } from '../forms/FormsSurface';
import { useExistingAnnotations } from '../forms/forms-store';
import { useMarks } from '../marks/marks-store';
import { useVisibleMarks } from '../marks/overlays';
import { RedactionMarkLayer } from '../marks/RedactionSurfaces';
import type { MarkActions } from '../marks/use-mark-actions';
import { MeasureOverlay } from '../measure/MeasureOverlay';
import { ReadingOrderLayer } from '../reading/ReadingOrderLayer';
import { layoutChanged, setCurrentPage, useSave, zoomChanged } from '../save/save-store';
import { openNote } from '../selection/selection-actions';
import { selectMarks, useSelection } from '../selection/selection-store';
import { TextToolSurface } from '../selection/TextToolSurface';
import { StampPlacementHost } from '../stamps/StampSurface';
import type { ShellActions } from './shell-actions';
import { useEditState } from './use-edit-state';

/**
 * The canonical tool → the overlay's creation gesture. Selection belongs to the common
 * interaction layer. Every annotation creator stays controlled by the shell; arming pdf.js's
 * separate editors would repaint the base canvas and introduce a second selection and history owner.
 */
const ANNOTATION_LAYER_TOOLS: Readonly<Partial<Record<CanvasToolId, AnnotationTool>>> = {
  highlight: 'highlight',
  underline: 'underline',
  strikeout: 'strikeout',
  squiggly: 'squiggly',
  ink: 'ink',
  shapes: 'shapes',
  note: 'note',
  link: 'link',
  freetext: 'freetext',
};

export interface ViewerAreaProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly actions: Pick<ShellActions, 'openDialog'> & {
    readonly transformTargets: MarkActions['transformTargets'];
    readonly onReady: (api: ViewerApi | null) => void;
    readonly onDocumentReleased: (handle: PdfDocumentHandle) => void;
    readonly onModifiedChange: () => void;
    readonly onPlaceStamp: (placement: StampPlacement) => void;
    readonly onResizeStamp: (key: string, rect: readonly [number, number, number, number]) => void;
    /** The link tool dragged a region: it is held for the dialog that asks where it should point. */
    readonly onLinkRegion: (region: LinkTargetRect) => void;
  };
}

export function ViewerArea({ session, tier, t, actions }: ViewerAreaProps) {
  const { activeTab, activeHandle, canEdit, locked, viewingOnly } = useEditState(session, tier);
  const canvasTool = useCore((state) => state.canvasTool);
  const shape = useCore((state) => state.shape);
  const leftDock = useCore((state) => state.leftDock);
  const rightDock = useCore((state) => state.rightDock);
  const rightTab = useCore((state) => state.rightTab);
  const viewer = useSave((state) => state.viewer);
  const currentPage = useSave((state) => state.currentPage);
  // The overlays follow the pages' layout, which they can only be placed on once the viewer is there:
  // a layout the viewer reports before it has handed back its API has nothing to redraw.
  // The revision is a value the overlay depends on, handed to the layer that reads the pages'
  // geometry as it renders: the compiler keeps the overlay's elements while their props are the
  // same, and the viewer object they hold is the same across layouts.
  const layout = useSave((state) => (state.viewer === null ? 0 : state.layoutRevision));
  const selectedKeys = useSelection((state) => state.selectedKeys);
  const markTargets = useMarks((state) => state.targets);
  const visibleMarks = useVisibleMarks(activeTab);
  const existingAnnotations = useExistingAnnotations(activeTab);
  const { setAnnotations } = useAnnotationMarks(session);
  const { color, opacity, thickness, author, textColor, fontSize } = useAnnotationStyle();
  const annotationLayerTool = ANNOTATION_LAYER_TOOLS[canvasTool] ?? null;
  const markMode = canvasTool === 'select' ? 'select' : null;
  if (activeHandle === null) return null;
  return (
    <>
      {/* Persistent edge handle to reopen Left Dock */}
      {!leftDock ? (
        <button
          type="button"
          title={t('nav.togglePages')}
          aria-label={t('nav.togglePages')}
          onClick={() => showLeftDock()}
          className="absolute start-0 top-3 z-30 flex h-9 w-4 items-center justify-center rounded-e-md border border-s-0 border-kumo-line bg-kumo-base/95 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong pdf-floating-shadow transition-all"
        >
          <CaretRight size={12} weight="bold" className="rtl:-scale-x-100" />
        </button>
      ) : null}

      {/* Persistent edge handle to reopen Right Dock */}
      {!rightDock ? (
        <button
          type="button"
          title={t('tools.all')}
          aria-label={t('tools.all')}
          onClick={() => showRightDock()}
          className="absolute end-0 top-3 z-30 flex h-9 w-4 items-center justify-center rounded-s-md border border-e-0 border-kumo-line bg-kumo-base/95 text-kumo-subtle hover:bg-kumo-recessed hover:text-kumo-strong pdf-floating-shadow transition-all"
        >
          <CaretLeft size={12} weight="bold" className="rtl:-scale-x-100" />
        </button>
      ) : null}

      <PdfViewerPane
        document={activeHandle}
        documentKey={activeTab?.id}
        t={t}
        handTool={canvasTool === 'hand'}
        onReady={actions.onReady}
        onDocumentReleased={actions.onDocumentReleased}
        onCurrentPageChange={setCurrentPage}
        onScaleChange={zoomChanged}
        onModifiedChange={actions.onModifiedChange}
        onLayoutChange={layoutChanged}
        onReplace={canEdit ? (query) => actions.openDialog('find-replace', { find: query }) : undefined}
        // The mark layers live inside the viewer's scroll content, so the browser
        // scrolls them with the pages; outside it they were re-placed only on the
        // next render and slid over the text while the reader scrolled.
        overlay={
          viewer === null || activeTab === null ? null : (
            <>
              {/* A protected tab is read-only: no area can be marked on it. */}
              <RedactionMarkLayer t={t} viewer={viewer} session={session} enabled={!locked && !viewingOnly} />
              {/* Measurements remain visible after switching to selection. Only creation
                  and the settings strip follow the armed tool, not the marks themselves. */}
              <MeasureOverlay
                t={t}
                session={session}
                viewer={viewer}
                marks={visibleMarks.measures}
                canEdit={canEdit}
                color={color}
                opacity={opacity}
                thickness={thickness}
                author={author}
              />
              {/* The visual layer survives transient edit locks. Only its creator is
                  disarmed: unmounting the marks during a checkpoint made them flash. */}
              <AnnotationLayer
                t={t}
                viewer={viewer}
                tool={canEdit ? annotationLayerTool : null}
                marks={visibleMarks.annotations}
                color={color}
                opacity={opacity}
                thickness={thickness}
                author={author}
                shape={shape}
                textColor={textColor}
                fontSize={fontSize}
                onCreate={(mark) => {
                  setAnnotations((marks) => [...marks, mark]);
                  session.setDirty(activeTab.id, true);
                  // A note is a comment: it opens its contents for editing at once,
                  // selected, so the sentence the user is about to write has a home.
                  if (mark.kind === 'note') openNote(mark);
                }}
                onDone={() => selectTool('select')}
                onRegion={(region) => {
                  // The rectangle is already in the writer's own space; the dialog
                  // only asks where it should point.
                  actions.onLinkRegion(region);
                  actions.openDialog('link-add');
                }}
              />
              {/* The common layer: one identity space, one hit test, one selection across
                  every mark family — the session's annotations, its measurements, its
                  redaction intents and the annotations the file already carries. It is
                  mounted whenever the viewer is, with `mode={null}` when no tool of its
                  own is armed, because a layer that unmounted would drop the selection
                  chrome with it. */}
              <MarkInteractionLayer
                viewer={viewer}
                mode={markMode}
                targets={markTargets}
                selectedKeys={selectedKeys}
                // Saved marks become editable only when their current inventory
                // is ready; unread does not mean the PDF contains no annotations.
                disabled={!canEdit || existingAnnotations === null}
                onSelectionChange={selectMarks}
                onMove={(keys, dx, dy) => void actions.transformTargets(keys, { dx, dy, rotation: 0 })}
                onResize={actions.onResizeStamp}
                resizeLabel={t('stamp.resize')}
              />
              <StampPlacementHost viewer={viewer} canEdit={canEdit} t={t} onPlace={actions.onPlaceStamp} />
              <FieldCandidateHost t={t} tab={activeTab} viewer={viewer} canEdit={canEdit} />
              <TextToolSurface
                viewer={viewer}
                currentPage={currentPage}
                t={t}
                onEdit={() => actions.openDialog('text-edit')}
              />
              {/* The accessibility panel's numbered reading-order boxes. */}
              {rightDock && rightTab === 'accessibility' ? (
                <Suspense fallback={null}>
                  <ReadingOrderLayer t={t} viewer={viewer} layout={layout} />
                </Suspense>
              ) : null}
            </>
          )
        }
      />
    </>
  );
}
