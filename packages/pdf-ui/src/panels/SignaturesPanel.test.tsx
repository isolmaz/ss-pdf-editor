// @vitest-environment happy-dom
/**
 * The signatures panel: every signature field the engine lists, with whether it is signed, and
 * a jump to its page. A field the engine gave no page for is listed but cannot be walked to; a
 * failed read is a message and a shell notice; an answer for a document that is no longer the
 * open one never replaces the open one's list. The engine's field reader has its own suite, so
 * it answers here with what its contract describes.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { PdfSignatureField } from 'pdf-core/signature-fields';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignaturesPanel } from './SignaturesPanel';

const { listPdfSignatureFields } = vi.hoisted(() => ({ listPdfSignatureFields: vi.fn() }));
vi.mock('pdf-core/signature-fields', () => ({ listPdfSignatureFields }));

const t = createTranslator('en');
const doc = (name: string) => ({ name }) as unknown as PdfDocumentHandle;

beforeEach(() => {
  listPdfSignatureFields.mockReset();
});
afterEach(cleanup);

const field = (overrides: Partial<PdfSignatureField>): PdfSignatureField => ({
  name: 'Sig1',
  id: '10R',
  pageIndex: 0,
  signed: true,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SignaturesPanel', () => {
  it('shows a loading state until the engine answers', async () => {
    const pending = deferred<readonly PdfSignatureField[]>();
    listPdfSignatureFields.mockReturnValue(pending.promise);
    const { container } = render(<SignaturesPanel document={doc('a')} t={t} onGoToPage={vi.fn()} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    pending.resolve([]);
    expect(await screen.findByText('This document has no signature fields.')).toBeTruthy();
  });

  it('lists each field with its state and walks to the page a signed field sits on', async () => {
    listPdfSignatureFields.mockResolvedValue([
      field({ name: 'Approver', pageIndex: 2, signed: true }),
      field({ name: 'Witness', id: '11R', pageIndex: 0, signed: false }),
    ]);
    const onGoToPage = vi.fn();
    const user = userEvent.setup();
    render(<SignaturesPanel document={doc('a')} t={t} onGoToPage={onGoToPage} />);

    const list = await screen.findByRole('list', { name: 'Signatures' });
    const items = list.querySelectorAll('li');
    expect(items[0]?.textContent).toBe('ApproverSigned');
    expect(items[1]?.textContent).toBe('WitnessUnsigned field');

    await user.click(screen.getByRole('button', { name: /Approver/ }));
    expect(onGoToPage).toHaveBeenCalledExactlyOnceWith(2);
    expect(screen.getByRole('button', { name: /Approver/ }).getAttribute('title')).toBe('Go to page 3');
    await user.click(screen.getByRole('button', { name: /Witness/ }));
    expect(onGoToPage).toHaveBeenLastCalledWith(0);
  });

  it('lists a field with no page by its name and cannot walk to it', async () => {
    listPdfSignatureFields.mockResolvedValue([field({ name: 'Loose', pageIndex: null, signed: false })]);
    const onGoToPage = vi.fn();
    render(<SignaturesPanel document={doc('a')} t={t} onGoToPage={onGoToPage} />);

    const button = await screen.findByRole('button', { name: /Loose/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('Loose');
    await userEvent.setup().click(button);
    expect(onGoToPage).not.toHaveBeenCalled();
  });

  it('says what failed and tells the shell when the read fails', async () => {
    listPdfSignatureFields.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    render(<SignaturesPanel document={doc('a')} t={t} onGoToPage={vi.fn()} onNotice={onNotice} />);

    const failure = new ToolError('internal', { engine: 'pdfjs' });
    const sentence = `${t(failure.messageKey)} ${t(failure.hintKey)}`;
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(sentence);
  });

  it('still shows the failure when the shell takes no notices', async () => {
    listPdfSignatureFields.mockImplementation(async () => {
      throw new Error('boom');
    });
    render(<SignaturesPanel document={doc('a')} t={t} onGoToPage={vi.fn()} />);
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(`${t(failure.messageKey)} ${t(failure.hintKey)}`)).toBeTruthy();
  });

  it('keeps the open document list when an earlier document answers late', async () => {
    const first = deferred<readonly PdfSignatureField[]>();
    const second = deferred<readonly PdfSignatureField[]>();
    listPdfSignatureFields.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onNotice = vi.fn();
    const { rerender } = render(
      <SignaturesPanel document={doc('a')} t={t} onGoToPage={vi.fn()} onNotice={onNotice} />,
    );
    rerender(<SignaturesPanel document={doc('b')} t={t} onGoToPage={vi.fn()} onNotice={onNotice} />);

    second.resolve([field({ name: 'Current' })]);
    expect(await screen.findByRole('button', { name: /Current/ })).toBeTruthy();
    first.resolve([field({ name: 'Stale' })]);
    await first.promise;
    expect(screen.queryByRole('button', { name: /Stale/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Current/ })).toBeTruthy();
  });

  it('ignores a failure of an earlier document once another is open', async () => {
    const first = deferred<readonly PdfSignatureField[]>();
    listPdfSignatureFields
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([field({ name: 'Current' })]);
    const onNotice = vi.fn();
    const { rerender } = render(
      <SignaturesPanel document={doc('a')} t={t} onGoToPage={vi.fn()} onNotice={onNotice} />,
    );
    rerender(<SignaturesPanel document={doc('b')} t={t} onGoToPage={vi.fn()} onNotice={onNotice} />);
    expect(await screen.findByRole('button', { name: /Current/ })).toBeTruthy();

    first.reject(new Error('late failure'));
    await first.promise.catch(() => undefined);
    expect(onNotice).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Current/ })).toBeTruthy();
  });
});
