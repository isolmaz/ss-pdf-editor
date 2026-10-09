/**
 * The one writer of a tab's pending overlay lists: what lands in the session and its journal,
 * and the writes that are not edits.
 */

import { SessionStore } from 'pdf-model';
import { describe, expect, it } from 'vitest';
import { pendingOverlays } from '../../operations';
import { writeOverlay } from './overlays';

function openSession() {
  const session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]), sha256: 'hash', pageCount: 1 });
  return session;
}
const marks = (...ids: string[]) => ids as never;
const journalLength = (session: SessionStore) => session.active?.journal.entries.length ?? 0;

describe('writeOverlay', () => {
  it('writes nothing with no active tab', () => {
    const session = new SessionStore();
    writeOverlay(session, 'annotations', marks('a'), 'ann.engineEdit');
    expect(session.active).toBeNull();
  });

  it('replaces one list, keeps the others, and journals one step named by the label', () => {
    const session = openSession();
    writeOverlay(session, 'annotations', marks('a'), 'ann.engineEdit');
    writeOverlay(session, 'measures', marks('m'), 'tools.measure');

    expect(pendingOverlays(session.active)).toMatchObject({
      annotations: ['a'],
      measures: ['m'],
      redactions: [],
    });
    expect(session.active?.journal.entries.map((entry) => entry.labelKey)).toEqual([
      'ann.engineEdit',
      'tools.measure',
    ]);
    expect(session.active?.dirty).toBe(true);
  });

  it('computes an updater change from the list that is there', () => {
    const session = openSession();
    writeOverlay(session, 'redactions', marks('r1'), 'panel.redaction');
    writeOverlay(session, 'redactions', (current) => [...current, 'r2'] as never, 'panel.redaction');
    expect(pendingOverlays(session.active).redactions).toEqual(['r1', 'r2']);
  });

  it('names a step by what changed, from the list before and after', () => {
    const session = openSession();
    const seen: unknown[] = [];
    writeOverlay(session, 'annotations', marks('a'), (before, after) => {
      seen.push([before, after]);
      return 'ann.engineEdit';
    });
    expect(seen).toEqual([[[], ['a']]]);
    expect(session.active?.journal.entries[0]?.labelKey).toBe('ann.engineEdit');
  });

  it('does not journal the very list that is there, or one empty list replacing another', () => {
    const session = openSession();
    writeOverlay(session, 'annotations', marks(), 'ann.engineEdit');
    expect(journalLength(session)).toBe(0);

    const list = marks('a');
    writeOverlay(session, 'annotations', list, 'ann.engineEdit');
    writeOverlay(session, 'annotations', (current) => current, 'ann.engineEdit');
    writeOverlay(session, 'annotations', list, 'ann.engineEdit');
    expect(journalLength(session)).toBe(1);
  });
});
