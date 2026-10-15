/**
 * The run every write that holds the document follows, so no handler spells it out again: an
 * operation already holding the document is refused out loud, the controller its Cancel aborts is
 * registered as the running one, the busy gate is held until the work settles, and a failure is
 * a notice rather than an unhandled rejection.
 */

import { ToolError, type Translator } from 'pdf-shared';
import {
  beginOperation,
  endOperation,
  isBusy,
  operationRunning,
  refuseBusy,
  setBusy,
  showNotice,
} from './core-store';

/** A failure as the status line words it: what happened, then what to do; anything unexpected is `internal`. */
export function failureLine(error: unknown, t: Translator): string {
  const toolError = error instanceof ToolError ? error : new ToolError('internal', { engine: 'model' });
  return `${t(toolError.messageKey)} ${t(toolError.hintKey)}`;
}

/**
 * Run `work` holding the busy gate with a Cancel the user can press. `work` receives the signal
 * of the registered controller and passes it to every engine call it makes: that is what makes
 * Cancel stop it. A run Cancel aborted ends silently — the user asked for that; any other failure
 * is a notice. The gate is released only while this run still owns it (a newer operation that
 * took the document keeps it).
 */
export async function runGatedOperation(
  t: Translator,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (isBusy() || operationRunning()) {
    refuseBusy(t);
    return;
  }
  const controller = beginOperation();
  setBusy(true);
  try {
    await work(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) showNotice(failureLine(error, t));
  } finally {
    if (endOperation(controller)) setBusy(false);
  }
}
