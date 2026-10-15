/**
 * The run every document-holding write follows: refusal while the document is held, the busy gate
 * and the registered controller for exactly the length of the work, Cancel reaching the work, and
 * a failure as a notice.
 */

import { createTranslator, ToolError } from 'pdf-shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginOperation,
  cancelOperation,
  coreStore,
  initialCoreState,
  isBusy,
  operationRunning,
  setBusy,
} from './core-store';
import { failureLine, runGatedOperation } from './gated-operation';

const t = createTranslator('en');
const notice = () => coreStore.get().notice;

beforeEach(() => coreStore.set(initialCoreState()));

describe('failureLine', () => {
  it('words a tool error by its own message and hint', () => {
    const error = new ToolError('write-failed', { engine: 'mupdf' });
    expect(failureLine(error, t)).toBe(`${t('error.write-failed.message')} ${t('error.write-failed.hint')}`);
  });

  it('words anything else as an internal failure', () => {
    expect(failureLine(new Error('boom'), t)).toBe(
      `${t('error.internal.message')} ${t('error.internal.hint')}`,
    );
  });
});

describe('runGatedOperation', () => {
  it('holds the busy gate and a registered controller while the work runs, and releases both after', async () => {
    let during: { busy: boolean; running: boolean; signal: AbortSignal | undefined } | undefined;
    await runGatedOperation(t, async (signal) => {
      during = { busy: isBusy(), running: operationRunning(), signal };
      expect(coreStore.get().operation?.signal).toBe(signal);
    });
    expect(during).toMatchObject({ busy: true, running: true });
    expect(during?.signal?.aborted).toBe(false);
    expect(isBusy()).toBe(false);
    expect(operationRunning()).toBe(false);
    expect(notice()).toBeNull();
  });

  it('refuses while another operation holds the document, and does not run the work', async () => {
    let ran = false;
    setBusy(true);
    await runGatedOperation(t, async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(notice()).toBe(t('op.busy'));
    expect(isBusy()).toBe(true);
  });

  it('refuses while a cancellable operation is registered even if the gate reads free', async () => {
    let ran = false;
    const running = beginOperation();
    await runGatedOperation(t, async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(notice()).toBe(t('op.busy'));
    expect(coreStore.get().operation).toBe(running);
  });

  it('is stopped by Cancel: the work sees the aborted signal and the abort is silent', async () => {
    let seen: AbortSignal | undefined;
    const run = runGatedOperation(t, async (signal) => {
      seen = signal;
      cancelOperation();
      throw new ToolError('aborted', { engine: 'model' });
    });
    await run;
    expect(seen?.aborted).toBe(true);
    expect(notice()).toBeNull();
    expect(isBusy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('says a tool error that was not a Cancel, and releases the gate', async () => {
    const error = new ToolError('write-failed', { engine: 'mupdf' });
    await runGatedOperation(t, async () => {
      throw error;
    });
    expect(notice()).toBe(failureLine(error, t));
    expect(isBusy()).toBe(false);
    expect(operationRunning()).toBe(false);
  });

  it('says an unexpected failure as an internal one', async () => {
    await runGatedOperation(t, async () => {
      throw new Error('boom');
    });
    expect(notice()).toBe(`${t('error.internal.message')} ${t('error.internal.hint')}`);
    expect(isBusy()).toBe(false);
  });

  it('leaves the gate to a newer operation that took the document meanwhile', async () => {
    let newer: AbortController | undefined;
    await runGatedOperation(t, async () => {
      newer = beginOperation();
    });
    expect(coreStore.get().operation).toBe(newer);
    expect(isBusy()).toBe(true);
  });
});
