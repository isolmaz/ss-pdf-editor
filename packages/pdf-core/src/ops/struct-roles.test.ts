/**
 * Structure role resolution: a custom role means what the `/RoleMap` says it means, a loop
 * or a dead end means nothing, and every role the editor offers is a standard type.
 */

import { describe, expect, it } from 'vitest';
import { EDITOR_ROLES, resolveRole, STANDARD_ROLES } from './struct-roles';

describe('struct-roles', () => {
  it('resolves a custom role through the role map, however long the chain', () => {
    expect(resolveRole('P', {})).toBe('P');
    expect(resolveRole('Intro', { Intro: 'P' })).toBe('P');
    expect(resolveRole('A', { A: 'B', B: 'C', C: 'H2' })).toBe('H2');
  });

  it('resolves a loop, a dead end and a role no map mentions to nothing', () => {
    expect(resolveRole('A', { A: 'B', B: 'A' })).toBeNull();
    expect(resolveRole('A', { A: 'Unknown' })).toBeNull();
    expect(resolveRole('Mystery', {})).toBeNull();
    // A standard type is never remapped: it resolves to itself.
    expect(resolveRole('H1', { H1: 'P' })).toBe('H1');
  });

  it('offers only standard types in the editor, with no duplicates', () => {
    expect(EDITOR_ROLES.every((role) => STANDARD_ROLES.has(role))).toBe(true);
    expect(new Set(EDITOR_ROLES).size).toBe(EDITOR_ROLES.length);
    for (const role of ['P', 'H1', 'Figure', 'Table', 'L']) expect(EDITOR_ROLES).toContain(role);
  });
});
