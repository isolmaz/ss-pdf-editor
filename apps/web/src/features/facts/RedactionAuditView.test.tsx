// @vitest-environment happy-dom
/**
 * The redaction audit tab: what it shows before and after a run, what each run searches for, and
 * what the user is told when it finds something, finds nothing, or cannot run.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionStore } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { writeOverlay } from '../core/overlays';
import { RedactionAuditView } from './RedactionAuditView';
import { redactionAuditStore, runRedactionAudit } from './redaction-audit';

const ops = vi.hoisted(() => ({
  materializeBase: vi.fn(),
  redactionNeedles: vi.fn(),
  auditRedactedDocument: vi.fn(),
}));
vi.mock('../../operations', async (original) => ({
  ...(await original<typeof import('../../operations')>()),
  materializeBase: ops.materializeBase,
  redactionNeedles: ops.redactionNeedles,
}));
vi.mock('../../lazy-ops', () => ({ auditRedactedDocument: ops.auditRedactedDocument }));

const t = createTranslator('en');
const bytes = new Uint8Array([1, 2, 3]);
const handle = { name: 'handle' } as never;

const clean = {
  findings: [],
  objectCount: 1,
  revisionCount: 1,
  incrementalChains: 0,
  bytes: 3,
};
const residual = {
  ...clean,
  findings: [
    { kind: 'residual-text', severity: 'content', key: 'audit.residual', params: { count: 2 } },
    { kind: 'metadata', severity: 'info', key: 'audit.metadata' },
  ],
};

function openSession(withHandle = true) {
  const store = new SessionStore();
  const tab = store.openDocument({ name: 'a.pdf', bytes, sha256: 'a', pageCount: 1 });
  if (withHandle) adoptHandle(tab.id, handle);
  return { store, tab };
}

// The panel is a dynamic chunk: load it once up front so no test races the first import.
beforeAll(async () => {
  await import('pdf-ui/panels');
}, 120_000);
beforeEach(() => {
  coreStore.set(initialCoreState());
  redactionAuditStore.set({ report: null, loading: false });
  ops.materializeBase.mockReset().mockResolvedValue(bytes);
  ops.redactionNeedles.mockReset().mockResolvedValue([]);
  ops.auditRedactedDocument.mockReset().mockResolvedValue(clean);
});
afterEach(cleanup);

describe('runRedactionAudit', () => {
  it('does nothing with no document, or one without an engine handle', async () => {
    await runRedactionAudit({ store: new SessionStore(), t, erasedTerms: () => [] });
    const { store } = openSession(false);
    await runRedactionAudit({ store, t, erasedTerms: () => [] });

    expect(ops.materializeBase).not.toHaveBeenCalled();
    expect(redactionAuditStore.get()).toEqual({ report: null, loading: false });
  });

  it('searches for the words already erased plus those the pending marks cover, once each', async () => {
    const { store, tab } = openSession();
    const mark = { id: 'm1', pageIndex: 0 } as never;
    writeOverlay(store, 'redactions', [{ id: 'r1', mark }] as never, 'tools.redact');
    ops.redactionNeedles.mockResolvedValue(['beta', 'gamma']);

    await runRedactionAudit({ store, t, erasedTerms: (id) => (id === tab.id ? ['alpha', 'beta'] : []) });

    expect(ops.materializeBase).toHaveBeenCalledWith({ store, t, tab: store.active, handle });
    expect(ops.redactionNeedles).toHaveBeenCalledWith(bytes, [mark], { signal: expect.any(AbortSignal) });
    expect(ops.auditRedactedDocument).toHaveBeenCalledWith(bytes, ['alpha', 'beta', 'gamma']);
    expect(redactionAuditStore.get()).toEqual({ report: clean, loading: false });
    expect(coreStore.get().notice).toBe(
      'The redaction audit ran against 3 term(s); the result is in the panel.',
    );
  });

  it('announces residual content instead of the term count', async () => {
    const { store } = openSession();
    ops.auditRedactedDocument.mockResolvedValue(residual);

    await runRedactionAudit({ store, t, erasedTerms: () => [] });

    expect(coreStore.get().notice).toBe(t('audit.notice.residual', { count: 1 }));
  });

  it('is loading while it runs, and says why when it cannot', async () => {
    const { store } = openSession();
    const failure = new ToolError('internal', { engine: 'model' });
    ops.materializeBase.mockRejectedValue(failure);

    const running = runRedactionAudit({ store, t, erasedTerms: () => [] });
    expect(redactionAuditStore.get().loading).toBe(true);
    await running;

    expect(redactionAuditStore.get()).toEqual({ report: null, loading: false });
    expect(coreStore.get().notice).toBe(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
  });

  it('reports a failure that is not a tool error as an internal one', async () => {
    const { store } = openSession();
    ops.auditRedactedDocument.mockRejectedValue(new Error('worker gone'));
    const internal = new ToolError('internal', { engine: 'model' });

    await runRedactionAudit({ store, t, erasedTerms: () => [] });

    expect(coreStore.get().notice).toBe(`${t(internal.messageKey)} ${t(internal.hintKey)}`);
  });
});

describe('RedactionAuditView', () => {
  it('shows the tab, runs the audit when asked, and shows what it found', async () => {
    const user = userEvent.setup();
    const { store, tab } = openSession();
    ops.auditRedactedDocument.mockResolvedValue(residual);
    render(<RedactionAuditView store={store} t={t} erasedTerms={() => ['secret']} />);

    await user.click(await screen.findByRole('button', { name: t('audit.rerun') }));

    await vi.waitFor(() => expect(redactionAuditStore.get().report).toBe(residual));
    expect(ops.auditRedactedDocument).toHaveBeenCalledWith(bytes, ['secret']);
    expect(await screen.findByRole('region', { name: t('audit.findings') })).toBeTruthy();
    dropHandle(tab.id);
  });

  it('shows the running state while the audit runs', async () => {
    const { store } = openSession();
    render(<RedactionAuditView store={store} t={t} erasedTerms={() => []} />);
    await screen.findByRole('button', { name: t('audit.rerun') });

    act(() => redactionAuditStore.set({ loading: true }));

    expect(screen.getByRole('status', { name: t('audit.loading') })).toBeTruthy();
  });
});
