// @vitest-environment happy-dom
/**
 * The attachments panel: the embedded files of the document with their descriptions and sizes
 * (a dash until the payload is measured or when it cannot be read), writing one out as a
 * download that is released again, and handing picked files and names to remove to the shell.
 * The attachment reader has its own suite, so it answers here with what its contract describes.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfAttachment, PdfDocumentHandle } from 'pdf-core';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentsPanel, type AttachmentsPanelProps } from './AttachmentsPanel';

const { listPdfAttachments, readPdfAttachment } = vi.hoisted(() => ({
  listPdfAttachments: vi.fn(),
  readPdfAttachment: vi.fn(),
}));
vi.mock('pdf-core', () => ({ listPdfAttachments, readPdfAttachment }));

const t = createTranslator('en');
const doc = (name: string) => ({ name }) as unknown as PdfDocumentHandle;

beforeEach(() => {
  listPdfAttachments.mockReset();
  readPdfAttachment.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const attachment = (id: string, overrides: Partial<PdfAttachment> = {}): PdfAttachment => ({
  id,
  filename: `${id}.txt`,
  description: '',
  content: null,
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

function show(props: Partial<AttachmentsPanelProps> = {}) {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <AttachmentsPanel document={doc('a')} t={t} onAdd={onAdd} onRemove={onRemove} {...props} />,
  );
  return { onAdd, onRemove, ...view, user: userEvent.setup() };
}

const picker = (container: HTMLElement) =>
  container.querySelector('input[data-attachment-picker]') as HTMLInputElement;

describe('AttachmentsPanel: the list', () => {
  it('shows a loading state until the engine answers', async () => {
    const pending = deferred<PdfAttachment[]>();
    listPdfAttachments.mockReturnValue(pending.promise);
    const { container } = show();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    pending.resolve([]);
    expect(await screen.findByText('This document has no attachments.')).toBeTruthy();
  });

  it('lists each file with its description, a dash until it is measured, then its size', async () => {
    const first = deferred<Uint8Array>();
    listPdfAttachments.mockResolvedValue([
      attachment('a', { filename: 'report.csv', description: 'Quarterly numbers' }),
      attachment('b', { filename: 'broken.bin' }),
      attachment('c', { filename: 'logo.png' }),
    ]);
    readPdfAttachment.mockImplementation(async (_doc: unknown, entry: PdfAttachment) => {
      if (entry.id === 'a') return first.promise;
      if (entry.id === 'b') throw new ToolError('internal', { engine: 'pdfjs' });
      return new Uint8Array(2048);
    });
    show();

    const list = await screen.findByRole('list', { name: 'Attachments' });
    const rows = () =>
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.textContent);
    expect(rows()).toEqual(['report.csvQuarterly numbers—', 'broken.bin—', 'logo.png—']);

    first.resolve(new Uint8Array(1234));
    await waitFor(() =>
      expect(rows()).toEqual(['report.csvQuarterly numbers1,234 byte', 'broken.bin—', 'logo.png2,048 byte']),
    );
  });

  it('says the document has no attachments and still offers to add one', async () => {
    listPdfAttachments.mockResolvedValue([]);
    show();
    expect(await screen.findByText('This document has no attachments.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add file' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says what failed and tells the shell when the list cannot be read', async () => {
    listPdfAttachments.mockImplementation(async () => {
      throw new ToolError('internal', { engine: 'pdfjs' });
    });
    const onNotice = vi.fn();
    show({ onNotice });
    const failure = new ToolError('internal', { engine: 'pdfjs' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey));
  });

  it('shows a failure even when the shell takes no notices', async () => {
    listPdfAttachments.mockImplementation(async () => {
      throw new Error('boom');
    });
    show();
    const failure = new ToolError('internal', { engine: 'ui' });
    expect(await screen.findByText(t(failure.messageKey))).toBeTruthy();
  });

  it('keeps the open document list when an earlier document answers late', async () => {
    const first = deferred<PdfAttachment[]>();
    listPdfAttachments
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([attachment('current', { filename: 'current.txt' })]);
    readPdfAttachment.mockResolvedValue(new Uint8Array(1));
    const { rerender } = show();
    rerender(<AttachmentsPanel document={doc('b')} t={t} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(await screen.findByText('current.txt')).toBeTruthy();

    await act(async () => {
      first.resolve([attachment('stale', { filename: 'stale.txt' })]);
      await first.promise;
    });
    expect(screen.queryByText('stale.txt')).toBeNull();
    expect(screen.getByText('current.txt')).toBeTruthy();
  });

  it('stops measuring the files of a document that is no longer open', async () => {
    const slow = deferred<Uint8Array>();
    listPdfAttachments
      .mockResolvedValueOnce([attachment('old', { filename: 'old.txt' })])
      .mockResolvedValueOnce([attachment('current', { filename: 'current.txt' })]);
    readPdfAttachment.mockImplementation(async (_doc: unknown, entry: PdfAttachment) =>
      entry.id === 'old' ? slow.promise : new Uint8Array(7),
    );
    const { rerender } = show();
    await screen.findByText('old.txt');
    rerender(<AttachmentsPanel document={doc('b')} t={t} onAdd={vi.fn()} onRemove={vi.fn()} />);
    expect(await screen.findByText('7 byte')).toBeTruthy();

    await act(async () => {
      slow.resolve(new Uint8Array(99));
      await slow.promise;
    });
    expect(screen.queryByText('99 byte')).toBeNull();
    expect(screen.getByText('7 byte')).toBeTruthy();
  });

  it('does not report a failure of an earlier document once another is open', async () => {
    const first = deferred<PdfAttachment[]>();
    listPdfAttachments
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([attachment('current', { filename: 'current.txt' })]);
    readPdfAttachment.mockResolvedValue(new Uint8Array(1));
    const onNotice = vi.fn();
    const { rerender } = show({ onNotice });
    rerender(
      <AttachmentsPanel document={doc('b')} t={t} onNotice={onNotice} onAdd={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(await screen.findByText('current.txt')).toBeTruthy();

    await act(async () => {
      first.reject(new Error('late failure'));
      await first.promise.catch(() => undefined);
    });
    expect(onNotice).not.toHaveBeenCalled();
    expect(screen.getByText('current.txt')).toBeTruthy();
  });
});

describe('AttachmentsPanel: adding and removing', () => {
  it('opens the file picker from the Add button and hands the picked files to the shell', async () => {
    listPdfAttachments.mockResolvedValue([]);
    const { container, onAdd, user } = show();
    await screen.findByText('This document has no attachments.');
    const input = picker(container);
    const opened = vi.fn();
    input.addEventListener('click', opened);

    await user.click(screen.getByRole('button', { name: 'Add file' }));
    expect(opened).toHaveBeenCalledOnce();

    const files = [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')];
    await user.upload(input, files);
    expect(onAdd).toHaveBeenCalledExactlyOnceWith(files);
    expect(input.value).toBe('');
  });

  it('hands nothing to the shell when the picker closes without a file', async () => {
    listPdfAttachments.mockResolvedValue([]);
    const { container, onAdd } = show();
    await screen.findByText('This document has no attachments.');
    fireEvent.change(picker(container), { target: { files: [] } });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('removes an attachment by its own filename', async () => {
    listPdfAttachments.mockResolvedValue([attachment('a', { filename: 'report.csv' }), attachment('b')]);
    readPdfAttachment.mockResolvedValue(new Uint8Array(1));
    const { onRemove, user } = show();
    await user.click(await screen.findByRole('button', { name: 'Remove attachment: report.csv' }));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(['report.csv']);
  });

  it('disables adding and removing while the host takes no writes', async () => {
    listPdfAttachments.mockResolvedValue([attachment('a')]);
    readPdfAttachment.mockResolvedValue(new Uint8Array(1));
    show({ disabled: true });
    expect(((await screen.findByRole('button', { name: 'Add file' })) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Remove attachment: a.txt' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Save attachment' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('AttachmentsPanel: saving a file', () => {
  function spyOnDownloads() {
    const blobs: Blob[] = [];
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return `blob:attachment-${blobs.length}`;
    });
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute('href') ?? '', download: this.download });
    });
    return { blobs, created, revoked, clicked };
  }

  it('downloads the payload under its filename, disables the button while reading, and revokes the URL later', async () => {
    listPdfAttachments.mockResolvedValue([attachment('a', { filename: 'report.csv' })]);
    const read = deferred<Uint8Array>();
    readPdfAttachment
      .mockResolvedValueOnce(new Uint8Array(1)) // the size measurement
      .mockReturnValueOnce(read.promise);
    const { created, revoked, clicked, blobs } = spyOnDownloads();
    show();
    const button = (await screen.findByRole('button', { name: 'Save attachment' })) as HTMLButtonElement;
    await screen.findByText('1 byte');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.click(button);
    expect((screen.getByRole('button', { name: 'Save attachment' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      read.resolve(new Uint8Array([104, 105]));
      await read.promise;
    });
    expect((screen.getByRole('button', { name: 'Save attachment' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(created).toHaveBeenCalledOnce();
    expect(await blobs[0]?.text()).toBe('hi');
    expect(clicked).toEqual([{ href: 'blob:attachment-1', download: 'report.csv' }]);
    expect(revoked).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:attachment-1');
  });

  it('revokes a download that is still waiting when the panel closes, and never again', async () => {
    listPdfAttachments.mockResolvedValue([attachment('a')]);
    readPdfAttachment.mockResolvedValue(new Uint8Array(3));
    const { revoked } = spyOnDownloads();
    const { unmount } = show();
    const button = await screen.findByRole('button', { name: 'Save attachment' });
    await screen.findByText('3 byte');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(revoked).toHaveBeenCalledExactlyOnceWith('blob:attachment-1');
    vi.advanceTimersByTime(10_000);
    expect(revoked).toHaveBeenCalledOnce();
  });

  it('tells the shell when the payload cannot be read, and lets the user try again', async () => {
    listPdfAttachments.mockResolvedValue([attachment('a')]);
    readPdfAttachment
      .mockResolvedValueOnce(new Uint8Array(1)) // the size measurement
      .mockImplementationOnce(async () => {
        throw new ToolError('internal', { engine: 'pdfjs' });
      });
    const { clicked } = spyOnDownloads();
    const onNotice = vi.fn();
    const { user } = show({ onNotice });
    const button = (await screen.findByRole('button', { name: 'Save attachment' })) as HTMLButtonElement;
    await screen.findByText('1 byte');

    await user.click(button);
    const failure = new ToolError('internal', { engine: 'pdfjs' });
    await waitFor(() => expect(onNotice).toHaveBeenCalledExactlyOnceWith(t(failure.messageKey)));
    expect(button.disabled).toBe(false);
    expect(clicked).toEqual([]);
  });

  it('stays quiet about a payload that cannot be read when the shell takes no notices', async () => {
    listPdfAttachments.mockResolvedValue([attachment('a')]);
    readPdfAttachment.mockImplementation(async () => {
      throw new Error('boom');
    });
    const { clicked } = spyOnDownloads();
    const { user } = show();
    const button = (await screen.findByRole('button', { name: 'Save attachment' })) as HTMLButtonElement;
    await user.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(clicked).toEqual([]);
  });
});
