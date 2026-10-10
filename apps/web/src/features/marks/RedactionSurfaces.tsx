/**
 * The redaction feature's two pieces of the shell's markup: the layer the user draws areas to
 * erase on, and the right dock's list of drawn marks with the tool's own controls.
 */

import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { markTargetKey } from 'pdf-ui/tools';
import { Button, RedactionLayer, RedactionPanel } from 'pdf-ui/ui';
import type { ViewerApi } from 'pdf-ui/viewer';
import type { MarkedRedaction } from '../../annotation-interaction';
import { selectTool, toggleTool, useCore } from '../core/core-store';
import { useMarks } from './marks-store';
import { writeRedactions } from './redaction';

/**
 * The layer a drag on a page marks an area to erase with; nothing unless the redact tool is
 * armed and marking is allowed (`enabled` is `false` on a protected or viewing-only document).
 */
export function RedactionMarkLayer({
  t,
  viewer,
  session,
  enabled,
}: {
  readonly t: Translator;
  readonly viewer: ViewerApi;
  readonly session: SessionStore;
  readonly enabled: boolean;
}) {
  const armed = useCore((state) => state.canvasTool === 'redact');
  if (!armed || !enabled) return null;
  return (
    <RedactionLayer
      t={t}
      viewer={viewer}
      onMark={(mark) => writeRedactions(session, (marks) => [...marks, { id: crypto.randomUUID(), mark }])}
      onDone={() => selectTool('select')}
    />
  );
}

/**
 * The redaction dock: the marks drawn so far, each removable, the tool's toggle and the button
 * that opens the redaction dialog.
 */
export function RedactionDock({
  t,
  marks,
  canEdit,
  removeTargets,
  onApply,
}: {
  readonly t: Translator;
  readonly marks: readonly MarkedRedaction[];
  readonly canEdit: boolean;
  /** The one removal intent (`removeTargets`). */
  readonly removeTargets: (keys: readonly string[]) => boolean;
  /** Open the redaction dialog. */
  readonly onApply: () => void;
}) {
  const armed = useCore((state) => state.canvasTool === 'redact');
  const targets = useMarks((state) => state.targets);
  return (
    <RedactionPanel
      t={t}
      marks={marks.map((item) => ({
        id: item.id,
        pageIndex: item.mark.pageIndex,
      }))}
      onRemove={(id) => void removeTargets([markTargetKey('redaction', id, 0)])}
      onClear={() =>
        void removeTargets(
          targets.filter((target) => target.family === 'redaction').map((target) => target.key),
        )
      }
    >
      <Button
        size="sm"
        shape="base"
        aria-pressed={armed}
        disabled={!canEdit}
        onClick={() => toggleTool('redact')}
      >
        {armed ? t('redact.tool.stop') : t('redact.tool.start')}
      </Button>
      <Button
        size="sm"
        shape="base"
        variant="primary"
        disabled={!canEdit || marks.length === 0}
        onClick={onApply}
      >
        {t('redact.title')}
      </Button>
    </RedactionPanel>
  );
}
