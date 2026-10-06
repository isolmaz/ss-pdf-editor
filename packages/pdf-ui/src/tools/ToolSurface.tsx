/**
 * The reader's tool overlays (reading mode, magnifier, snapshot, presentation).
 * Their own import path for the same reason as the shell surface:
 * the root barrel is not reducible by a bundler.
 *
 * The mark tools live here too — `MarkInteractionLayer` plus the `MarkTarget`
 * contract it consumes, and `StampPlacementLayer`, the click that places a picture — because selection, the marquee and the move are one
 * surface shared by every mark family, and the shell codes against exactly this
 * import (`pdf-ui/tools`). `ToolProperties` is re-exported from the same path so
 * there is one specifier for a tool's controls and its surface.
 */

export { selectionBoxes, type TextSelection } from '../ops/AnnotationLayer';
export { FieldCandidateLayer, type FieldCandidateLayerProps } from '../ops/FieldCandidateLayer';
export {
  MarkInteractionLayer,
  type MarkInteractionLayerProps,
  type MarkInteractionMode,
} from '../ops/MarkInteractionLayer';
export { type MarkFamily, type MarkRect, type MarkTarget, markTargetKey } from '../ops/mark-interaction';
export {
  type StampPlacement,
  StampPlacementLayer,
  type StampPlacementLayerProps,
  type StampPlacementSource,
} from '../ops/StampPlacementLayer';
export { ReadingPane, type ReadingPaneProps } from '../reading/ReadingPane';
export { Magnifier, type MagnifierProps } from './Magnifier';
export { SnapshotMenu, type SnapshotMenuProps } from './SnapshotMenu';
export {
  type CanvasShapeKind,
  type CanvasToolId,
  ToolProperties,
  type ToolPropertiesProps,
} from './ToolProperties';
export { usePresentation } from './usePresentation';
