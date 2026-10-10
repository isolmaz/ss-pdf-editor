// @vitest-environment happy-dom
/**
 * The properties tab: what the panel is handed from the facts and the trust stores, where each of
 * its controls leads, and the retry alert a failed read puts in its place.
 *
 * The panel itself (`pdf-ui`) is replaced by a stand-in that shows what it was handed and exposes
 * each callback as a button: the certificate and CRL parsers it owns need real certificates and
 * are covered with the panel.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { revocationListFrom, SessionStore, trustRootFrom } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNotice, coreStore } from '../core/core-store';
import { type DocumentFacts, factsFailed, factsRead, factsReading } from './facts-store';
import { PropertiesFacts } from './PropertiesFacts';
import { trustStore } from './trust-store';

const files = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('../../drafts', () => ({ readAppFile: vi.fn(), writeAppFile: files.write }));
vi.mock('pdf-ui/panels', () => ({
  PropertiesPanel: (props: {
    fonts: readonly unknown[] | null;
    attachments: readonly unknown[];
    signatures: readonly unknown[];
    security: { encrypted: boolean } | null;
    loading: boolean;
    disabled: boolean;
    trustRoots: readonly { label: string }[];
    revocationLists: readonly { label: string }[];
    onRemoveTrustRoot: (id: string) => void;
    onImportTrustRoots: (roots: unknown[]) => void;
    onRemoveRevocationList: (id: string) => void;
    onImportRevocationLists: (lists: unknown[]) => void;
    onAddAttachments: (files: File[]) => void;
    onRemoveAttachment: (name: string) => void;
    onReadAttachment: (name: string) => void;
  }) => (
    <section aria-label="stand-in">
      <p>
        {props.loading ? 'loading' : 'loaded'}
        {props.disabled ? ' disabled' : ' enabled'}
      </p>
      <p>{`fonts:${props.fonts === null ? 'none' : props.fonts.length}`}</p>
      <p>{`attachments:${props.attachments.length} signatures:${props.signatures.length}`}</p>
      <p>{`security:${props.security === null ? 'none' : String(props.security.encrypted)}`}</p>
      <p>{`roots:${props.trustRoots.map((root) => root.label).join(',')}`}</p>
      <p>{`lists:${props.revocationLists.map((list) => list.label).join(',')}`}</p>
      <button type="button" onClick={() => props.onImportTrustRoots([rootB])}>
        import root
      </button>
      <button type="button" onClick={() => props.onRemoveTrustRoot(rootA.id)}>
        remove root
      </button>
      <button type="button" onClick={() => props.onImportRevocationLists([listB])}>
        import list
      </button>
      <button type="button" onClick={() => props.onRemoveRevocationList(listA.id)}>
        remove list
      </button>
      <button type="button" onClick={() => props.onAddAttachments([new File(['x'], 'x.txt')])}>
        add attachment
      </button>
      <button type="button" onClick={() => props.onRemoveAttachment('x.txt')}>
        remove attachment
      </button>
      <button type="button" onClick={() => props.onReadAttachment('x.txt')}>
        read attachment
      </button>
    </section>
  ),
}));

const t = createTranslator('en');
const rootA = trustRootFrom(new Uint8Array([1, 2, 3]), 'Root A', 1);
const rootB = trustRootFrom(new Uint8Array([4, 5, 6]), 'Root B', 2);
const summary = { thisUpdate: null, nextUpdate: null, revokedCount: 0, delta: false };
const listA = revocationListFrom(new Uint8Array([7, 8]), 'CRL A', summary, 1);
const listB = revocationListFrom(new Uint8Array([9, 10]), 'CRL B', summary, 2);
const empty = trustStore.get();
const tab = new SessionStore().openDocument({
  name: 'a.pdf',
  bytes: new Uint8Array([1]),
  sha256: 'a',
  pageCount: 1,
});

const facts: DocumentFacts = {
  tabId: tab.id,
  version: tab.working.id,
  fonts: [{ baseFont: 'Helvetica' } as never],
  attachments: [{ name: 'a.txt', description: '', size: 1 }],
  signatures: [],
  security: { encrypted: false, permissions: [] },
};

function view(overrides: Partial<Parameters<typeof PropertiesFacts>[0]> = {}) {
  const handlers = {
    onRetry: vi.fn(),
    onAddAttachments: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onReadAttachment: vi.fn(),
  };
  render(<PropertiesFacts t={t} tab={tab} disabled={false} {...handlers} {...overrides} />);
  return handlers;
}

beforeEach(() => {
  factsReading();
  trustStore.set(empty);
  clearNotice();
  files.write.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('PropertiesFacts', () => {
  it('shows the panel as loading until the facts of the tab are read, then what they hold', async () => {
    view({ disabled: true });
    expect(await screen.findByText('loading disabled')).toBeTruthy();
    expect(screen.getByText('fonts:none')).toBeTruthy();
    expect(screen.getByText('security:none')).toBeTruthy();

    act(() => factsRead(facts));

    expect(screen.getByText('loaded disabled')).toBeTruthy();
    expect(screen.getByText('fonts:1')).toBeTruthy();
    expect(screen.getByText('attachments:1 signatures:0')).toBeTruthy();
    expect(screen.getByText('security:false')).toBeTruthy();
  });

  it('hands the panel the imported roots and lists, and stores what the user imports or removes', async () => {
    const user = userEvent.setup();
    trustStore.set({ roots: [rootA], lists: [listA] });
    view();
    expect(await screen.findByText('roots:Root A')).toBeTruthy();
    expect(screen.getByText('lists:CRL A')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'import root' }));
    expect(screen.getByText(/^roots:Root A,Root B$/)).toBeTruthy();
    expect(coreStore.get().notice).toBe(t('props.sig.roots.added', { count: 1 }));

    await user.click(screen.getByRole('button', { name: 'remove root' }));
    expect(screen.getByText('roots:Root B')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'import list' }));
    expect(screen.getByText('lists:CRL A,CRL B')).toBeTruthy();
    expect(coreStore.get().notice).toBe(t('props.sig.crls.added', { count: 1 }));

    await user.click(screen.getByRole('button', { name: 'remove list' }));
    expect(screen.getByText('lists:CRL B')).toBeTruthy();
    expect(files.write).toHaveBeenCalledTimes(4);
  });

  it('passes the attachment actions through to the shell', async () => {
    const user = userEvent.setup();
    const handlers = view();
    await user.click(await screen.findByRole('button', { name: 'add attachment' }));
    await user.click(screen.getByRole('button', { name: 'remove attachment' }));
    await user.click(screen.getByRole('button', { name: 'read attachment' }));

    expect(handlers.onAddAttachments).toHaveBeenCalledWith([expect.objectContaining({ name: 'x.txt' })]);
    expect(handlers.onRemoveAttachment).toHaveBeenCalledWith('x.txt');
    expect(handlers.onReadAttachment).toHaveBeenCalledWith('x.txt');
  });

  it('puts an alert with a retry button in place of the panel when the facts could not be read', async () => {
    const user = userEvent.setup();
    const failure = new ToolError('internal', { engine: 'model' });
    const handlers = view();
    await screen.findByText('loading enabled');

    act(() => factsFailed({ tabId: tab.id, version: tab.working.id, error: failure }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(`${t(failure.messageKey)} ${t(failure.hintKey)}`);
    expect(screen.queryByRole('region', { name: 'stand-in' })).toBeNull();
    await user.click(screen.getByRole('button', { name: t('inspection.retry') }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });
});
