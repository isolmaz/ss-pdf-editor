/**
 * The shell's key table. The handler tries the rows in order and the first match wins, so
 * two rows on one chord leave the second unreachable — reading mode sat silently behind find
 * and replace on `Ctrl+H` that way.
 */

import { describe, expect, it } from 'vitest';
import { SHELL_SHORTCUTS, shortcutHint } from './useShortcuts';

describe('SHELL_SHORTCUTS', () => {
  it('gives every chord to one row only', () => {
    const owners = new Map<string, string>();
    const clashes: string[] = [];
    for (const row of SHELL_SHORTCUTS) {
      for (const chord of row.chords) {
        for (const key of [chord.key, ...(chord.alias === undefined ? [] : [chord.alias])]) {
          const id = `${key.toLowerCase()}|${chord.accel === true}|${chord.shift === true}`;
          const owner = owners.get(id);
          if (owner !== undefined && owner !== row.id) clashes.push(`${id}: ${owner} and ${row.id}`);
          else owners.set(id, row.id);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('opens reading mode with F9 and find and replace with Ctrl+H', () => {
    expect(shortcutHint('view.reading')).toBe('F9');
    expect(shortcutHint('edit.find-replace')).toMatch(/^(Ctrl|⌘)\+H$/);
  });
});
