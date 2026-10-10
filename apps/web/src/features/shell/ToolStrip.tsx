/** The strip under the header: the armed tool's settings (or the protected-copy notice) and the XFA banner. */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { ToolProperties } from 'pdf-ui/tools';
import { Button } from 'pdf-ui/ui';
import {
  chooseAuthor,
  chooseColor,
  chooseFontSize,
  chooseOpacity,
  chooseTextColor,
  chooseThickness,
  useAnnotationStyle,
} from '../annotations/annotations-store';
import { selectShape, selectTool, useCore } from '../core/core-store';
import { XfaBanner } from '../forms/FormsSurface';
import { useExistingAnnotations } from '../forms/forms-store';
import { useRedactionMarks } from '../marks/redaction';
import type { MarkActions } from '../marks/use-mark-actions';
import { MeasureSettingsStrip } from '../measure/MeasureSettingsStrip';
import { useMeasureMode } from '../measure/measure-store';
import { useSave } from '../save/save-store';
import { clearMarkSelection, useSelection } from '../selection/selection-store';
import type { ShellActions } from './shell-actions';
import { useEditState } from './use-edit-state';

export interface ToolStripProps {
  readonly session: SessionStore;
  readonly tier: DeviceTier;
  readonly t: Translator;
  readonly actions: Pick<ShellActions, 'openDialog' | 'openXfaForm'> & {
    readonly unlockActiveCopy: () => Promise<void>;
    readonly removeTargets: MarkActions['removeTargets'];
    readonly transformTargets: MarkActions['transformTargets'];
  };
}

export function ToolStrip({ session, tier, t, actions }: ToolStripProps) {
  const { activeTab, canEdit, locked, isHome } = useEditState(session, tier);
  const busy = useCore((state) => state.busy);
  const canvasTool = useCore((state) => state.canvasTool);
  const shape = useCore((state) => state.shape);
  const viewer = useSave((state) => state.viewer);
  const measureMode = useMeasureMode();
  const selectedKeys = useSelection((state) => state.selectedKeys);
  const { redactionMarks } = useRedactionMarks(session);
  const existingAnnotations = useExistingAnnotations(activeTab);
  const style = useAnnotationStyle();
  if (isHome || activeTab === null) return null;
  return (
    <>
      {/* The tool strip: one row of **fixed height** whatever the armed tool offers — the
          measure tool's own settings included — so arming a tool never moves the document.
          It scrolls sideways on a narrow screen instead of wrapping into a taller row. */}
      <div className="flex h-9 shrink-0 items-center overflow-x-auto overflow-y-hidden border-b border-kumo-line bg-kumo-base px-3">
        {locked ? (
          <div role="status" className="flex min-w-max items-center gap-2 text-[11px] text-kumo-warning">
            <span>{t('locked.banner')}</span>
            <Button size="sm" shape="base" disabled={busy} onClick={() => void actions.unlockActiveCopy()}>
              {t('locked.unlockCopy')}
            </Button>
          </div>
        ) : measureMode !== null && viewer !== null ? (
          <MeasureSettingsStrip
            t={t}
            // Colour, opacity, thickness and author are the annotation style: a
            // ruler and a highlighter are the same kind of mark, so the ruler's
            // settings edit the same state the marker tools do.
            color={style.color}
            onColor={chooseColor}
            opacity={style.opacity}
            onOpacity={chooseOpacity}
            thickness={style.thickness}
            onThickness={chooseThickness}
            author={style.author}
            onAuthor={chooseAuthor}
          />
        ) : (
          <ToolProperties
            t={t}
            tool={canvasTool}
            color={style.color}
            opacity={style.opacity}
            thickness={style.thickness}
            author={style.author}
            shape={shape}
            textColor={style.textColor}
            fontSize={style.fontSize}
            onTextColor={chooseTextColor}
            onFontSize={chooseFontSize}
            redactionCount={redactionMarks.length}
            onApplyRedaction={() => actions.openDialog('redact')}
            onTool={selectTool}
            selectedCount={selectedKeys.length}
            disabled={!canEdit || (canvasTool === 'select' && existingAnnotations === null)}
            onColor={chooseColor}
            onOpacity={chooseOpacity}
            onThickness={chooseThickness}
            onAuthor={chooseAuthor}
            onShape={selectShape}
            // Selection actions share one intent across every mark family.
            onDeleteSelection={() => void actions.removeTargets(selectedKeys)}
            onRotateSelection={() =>
              void actions.transformTargets(selectedKeys, { dx: 0, dy: 0, rotation: 90 })
            }
            onMoveSelection={(dx, dy) => void actions.transformTargets(selectedKeys, { dx, dy, rotation: 0 })}
            onClearSelection={clearMarkSelection}
          />
        )}
      </div>
      <XfaBanner
        t={t}
        tab={activeTab}
        canEdit={canEdit}
        onFill={actions.openXfaForm}
        onOpenDialog={actions.openDialog}
      />
    </>
  );
}
