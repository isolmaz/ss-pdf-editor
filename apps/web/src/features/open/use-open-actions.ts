import { useMemo } from 'react';
import { createOpenActions, type OpenActions, type OpenDeps } from './open-actions';

/**
 * The open handlers bound to what the shell holds, rebuilt only when one of those changes —
 * the identity the shortcut and command memos depend on.
 */
export function useOpenActions(deps: OpenDeps): OpenActions {
  const { session, t, tier, cancelRef, refuseBusy, setCurrentPage, setRedactionMarks } = deps;
  return useMemo(
    () => createOpenActions({ session, t, tier, cancelRef, refuseBusy, setCurrentPage, setRedactionMarks }),
    [session, t, tier, cancelRef, refuseBusy, setCurrentPage, setRedactionMarks],
  );
}
