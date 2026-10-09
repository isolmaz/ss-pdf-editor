/**
 * The tool strip's place under the header. The strip itself is in the editor chunk (`editor.ts`);
 * until that has loaded, and whenever no editor is shown, the row is absent, as it is on the home
 * screen.
 */

import { useEditorSurfaces } from './editor-store';
import type { ToolStripProps } from './ToolStrip';
import { useEditState } from './use-edit-state';

export function ToolStripHost(props: ToolStripProps) {
  const { activeTab, isHome } = useEditState(props.session, props.tier);
  const editor = useEditorSurfaces();
  if (isHome || activeTab === null || editor === null) return null;
  return <editor.ToolStrip {...props} />;
}
