/**
 * The reader's tool overlays (reading mode, magnifier, snapshot, presentation,
 * view history). Their own import path for the same reason as the shell surface:
 * the root barrel is not reducible by a bundler.
 *
 * The mark tools live here too — `MarkInteractionLayer` plus the `MarkTarget`
 * contract it consumes — because selection, the marquee and the move are one
 * surface shared by every mark family, and the shell codes against exactly this
 * import (`pdf-ui/tools`). `ToolProperties` is re-exported from the same path so
 * there is one specifier for a tool's controls and its surface.
 */

export { selectionBoxes, type TextSelection } from '../ops/AnnotationLayer';
export {
  MarkInteractionLayer,
  type MarkInteractionLayerProps,
  type MarkInteractionMode,
} from '../ops/MarkInteractionLayer';
export { type MarkFamily, type MarkTarget, markTargetKey } from '../ops/mark-interaction';
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
export { useViewHistory } from './useViewHistory';
