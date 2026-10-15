/** The strip under the header: the armed tool's settings (or the protected-copy notice) and the XFA banner. */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { ToolProperties } from 'pdf-ui/tools';
import { Button } from 'pdf-ui/ui';
import { styledToolOf } from '../annotations/annotation-style';
import {
  chooseAuthor,
  chooseStyle,
  useAnnotationAuthor,
  useToolStyle,
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
  const author = useAnnotationAuthor();
  // Each tool edits its own style; a tool without one shows no style controls, so the marker's
  // stands in for it and is never written.
  const styled = styledToolOf(canvasTool);
  const style = useToolStyle(styled);
  const measureStyle = useToolStyle('measure');
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
            color={measureStyle.color}
            onColor={(color) => chooseStyle('measure', { color })}
            opacity={measureStyle.opacity}
            onOpacity={(opacity) => chooseStyle('measure', { opacity })}
            thickness={measureStyle.thickness}
            onThickness={(thickness) => chooseStyle('measure', { thickness })}
            author={author}
            onAuthor={chooseAuthor}
          />
        ) : (
          <ToolProperties
            t={t}
            tool={canvasTool}
            color={style.color}
            opacity={style.opacity}
            thickness={style.thickness}
            author={author}
            shape={shape}
            textColor={style.color}
            fontSize={style.fontSize}
            onTextColor={(color) => chooseStyle(styled, { color })}
            onFontSize={(fontSize) => chooseStyle(styled, { fontSize })}
            redactionCount={redactionMarks.length}
            onApplyRedaction={() => actions.openDialog('redact')}
            onTool={selectTool}
            selectedCount={selectedKeys.length}
            disabled={!canEdit || (canvasTool === 'select' && existingAnnotations === null)}
            onColor={(color) => chooseStyle(styled, { color })}
            onOpacity={(opacity) => chooseStyle(styled, { opacity })}
            onThickness={(thickness) => chooseStyle(styled, { thickness })}
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
