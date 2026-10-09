// @vitest-environment happy-dom
/**
 * The persistence commands the shell hands to its menus: bound to the session and translator,
 * and stable until one of those changes.
 */

import { cleanup, render } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PersistenceActions, usePersistenceActions } from './use-persistence-actions';

const commands = vi.hoisted(() => ({
  toggleSensitiveSession: vi.fn(),
  purgeActiveDocument: vi.fn(),
  sweepVault: vi.fn(),
  checkOffline: vi.fn(),
  prepareOfflinePackages: vi.fn(),
}));
vi.mock('./draft-persist', () => ({ toggleSensitiveSession: commands.toggleSensitiveSession }));
vi.mock('./draft-vault', () => ({
  purgeActiveDocument: commands.purgeActiveDocument,
  sweepVault: commands.sweepVault,
}));
vi.mock('./offline-actions', () => ({
  checkOffline: commands.checkOffline,
  prepareOfflinePackages: commands.prepareOfflinePackages,
}));

const en = createTranslator('en');
const tr = createTranslator('tr');

function Probe(props: {
  readonly session: SessionStore;
  readonly t: typeof en;
  readonly out: PersistenceActions[];
}) {
  props.out.push(usePersistenceActions(props.session, props.t));
  return null;
}

afterEach(() => {
  cleanup();
  for (const command of Object.values(commands)) command.mockReset();
});

describe('usePersistenceActions', () => {
  it('runs each command against the session and the translator', () => {
    const session = new SessionStore();
    const out: PersistenceActions[] = [];
    render(<Probe session={session} t={en} out={out} />);
    const actions = out[0];
    if (actions === undefined) throw new Error('not rendered');

    actions.toggleSensitiveSession();
    actions.purgeActiveDocument();
    actions.sweepVault();
    actions.checkOffline();
    actions.prepareOfflinePackages();

    expect(commands.toggleSensitiveSession).toHaveBeenCalledWith(session, en);
    expect(commands.purgeActiveDocument).toHaveBeenCalledWith(session, en);
    expect(commands.sweepVault).toHaveBeenCalledWith(session, en);
    expect(commands.checkOffline).toHaveBeenCalledWith(en);
    expect(commands.prepareOfflinePackages).toHaveBeenCalledWith(en);
  });

  it('keeps the same commands until the translator changes', () => {
    const session = new SessionStore();
    const out: PersistenceActions[] = [];
    const { rerender } = render(<Probe session={session} t={en} out={out} />);
    rerender(<Probe session={session} t={en} out={out} />);
    expect(out[1]).toBe(out[0]);
    rerender(<Probe session={session} t={tr} out={out} />);
    expect(out[2]).not.toBe(out[0]);
    out[2]?.checkOffline();
    expect(commands.checkOffline).toHaveBeenCalledWith(tr);
  });
});
