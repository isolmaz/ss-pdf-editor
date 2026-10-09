/**
 * The measurements the session holds: the active tab's `measures` overlay, written like every
 * other pending overlay (`core/overlays.ts`) and so undoable.
 */

import type { MeasureMark } from 'pdf-core/ops/measure';
import type { SessionStore } from 'pdf-model';
import { writeOverlay } from '../core/overlays';

/** A finished measurement joins the tab's marks as one undoable step, and the tab is dirty. */
export function addMeasureMark(session: SessionStore, mark: MeasureMark): void {
  const tab = session.active;
  writeOverlay(session, 'measures', (marks) => [...marks, mark], 'tools.measure');
  if (tab !== null) session.setDirty(tab.id, true);
}
