/**
 * A finished measurement joins the active tab's `measures` overlay as one undoable step.
 */

import type { MeasureMark } from 'pdf-core/ops/measure';
import { scaleForRatio } from 'pdf-core/ops/measure';
import { SessionStore } from 'pdf-model';
import { describe, expect, it } from 'vitest';
import { pendingOverlays } from '../../operations';
import { addMeasureMark } from './measure-marks';

function mark(id: string): MeasureMark {
  return {
    id,
    pageIndex: 0,
    mode: 'distance',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    scale: scaleForRatio(100),
    color: '#ff0000',
    opacity: 1,
    thickness: 2,
    author: 'Ada',
    contents: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('addMeasureMark', () => {
  it('appends the mark to the active tab, journals one step named for the tool and marks it dirty', () => {
    const session = new SessionStore();
    session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'h', pageCount: 1 });

    addMeasureMark(session, mark('m1'));
    addMeasureMark(session, mark('m2'));

    expect(pendingOverlays(session.active).measures.map((entry) => entry.id)).toEqual(['m1', 'm2']);
    expect(session.active?.journal.entries.map((entry) => entry.labelKey)).toContain('tools.measure');
    expect(session.active?.dirty).toBe(true);
  });

  it('does nothing without an active tab', () => {
    const session = new SessionStore();
    addMeasureMark(session, mark('m1'));
    expect(session.active).toBeNull();
  });
});
