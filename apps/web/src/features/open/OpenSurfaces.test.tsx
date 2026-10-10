// @vitest-environment happy-dom
/**
 * The surfaces of opening: the start screen's header, the password question and the hidden
 * file input, as the user sees and drives them.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeHeader, OpenFileInput, PasswordPromptHost } from './OpenSurfaces';
import { fileInput } from './open-actions';
import { askPassword, initialOpenState, openStore } from './open-store';

const t = createTranslator('en');

beforeEach(() => {
  openStore.set(initialOpenState());
  fileInput.current = null;
});
afterEach(cleanup);

describe('HomeHeader', () => {
  function header(over: Partial<Parameters<typeof HomeHeader>[0]> = {}) {
    const handlers = { onSettings: vi.fn(), onPalette: vi.fn(), onOpen: vi.fn() };
    render(<HomeHeader t={t} title="PDF Studio" activeDocumentName={null} {...handlers} {...over} />);
    return handlers;
  }

  it('names the product and says what the start screen is for', () => {
    header();
    expect(screen.getByText('PDF Studio')).toBeTruthy();
    expect(screen.getByText(t('shell.homeTagline'))).toBeTruthy();
  });

  it('opens the settings, the palette and the file picker from their own buttons', async () => {
    const user = userEvent.setup();
    const handlers = header();

    await user.click(screen.getByRole('button', { name: t('settings.open') }));
    await user.click(screen.getByRole('button', { name: t('shell.commandPalette') }));
    await user.click(screen.getByRole('button', { name: t('shell.open') }));

    expect(handlers.onSettings).toHaveBeenCalledOnce();
    expect(handlers.onPalette).toHaveBeenCalledOnce();
    expect(handlers.onOpen).toHaveBeenCalledOnce();
  });

  it('offers no way back while no document is open', () => {
    header();
    expect(screen.queryByText(new RegExp(t('shell.backToDocument')))).toBeNull();
  });

  it('offers the way back to the open document, which hides the start screen', async () => {
    const user = userEvent.setup();
    openStore.set({ showHomeScreen: true });
    header({ activeDocumentName: 'contract.pdf' });

    await user.click(screen.getByRole('button', { name: `${t('shell.backToDocument')} (contract.pdf)` }));

    expect(openStore.get().showHomeScreen).toBe(false);
  });
});

describe('PasswordPromptHost', () => {
  const file = new File(['x'], 'locked.pdf');

  it('shows nothing while no file waits for a password', () => {
    render(<PasswordPromptHost t={t} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks for the password of the waiting file by name', async () => {
    askPassword({ file, incorrect: false });
    render(<PasswordPromptHost t={t} onSubmit={vi.fn()} />);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/locked\.pdf/)).toBeTruthy();
  });

  it('hands the file, its handle and the typed password back, and closes', async () => {
    const user = userEvent.setup();
    const handle = {} as FileSystemFileHandle;
    const onSubmit = vi.fn();
    askPassword({ file, handle, incorrect: true });
    render(<PasswordPromptHost t={t} onSubmit={onSubmit} />);

    await user.type(await screen.findByLabelText(t('password.label')), 'secret');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledWith(file, handle, 'secret');
    expect(openStore.get().passwordPrompt).toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancelling closes the question and drops the tool that waited for the file', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    openStore.set({ pendingHomeCommand: 'rotate' });
    askPassword({ file, incorrect: false });
    render(<PasswordPromptHost t={t} onSubmit={onSubmit} />);

    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(openStore.get()).toMatchObject({ passwordPrompt: null, pendingHomeCommand: null });
  });
});

describe('OpenFileInput', () => {
  function input(): HTMLInputElement {
    return document.querySelector('input[type="file"]') as HTMLInputElement;
  }

  it('accepts PDFs and every convertible type, and stays out of sight', () => {
    render(<OpenFileInput onFile={vi.fn()} />);
    expect(input().accept).toMatch(/^application\/pdf,\.pdf,/);
    expect(input().accept).toContain('.docx');
    expect(input().className).toBe('hidden');
  });

  it('is the input the picker path clicks', () => {
    render(<OpenFileInput onFile={vi.fn()} />);
    expect(fileInput.current).toBe(input());
  });

  it('hands the chosen file on and clears the input so the same file can be chosen again', async () => {
    const user = userEvent.setup();
    const onFile = vi.fn();
    render(<OpenFileInput onFile={onFile} />);
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });

    await user.upload(input(), file);

    expect(onFile).toHaveBeenCalledWith(file);
    expect(input().value).toBe('');
  });

  it('ignores a change that chose nothing', () => {
    const onFile = vi.fn();
    render(<OpenFileInput onFile={onFile} />);

    fireEvent.change(input());

    expect(onFile).not.toHaveBeenCalled();
  });

  it('drops the tool that waited for a file when the user cancels the plain input', () => {
    openStore.set({ pendingHomeCommand: 'rotate' });
    render(<OpenFileInput onFile={vi.fn()} />);

    fireEvent(input(), new Event('cancel'));

    expect(openStore.get().pendingHomeCommand).toBeNull();
  });

  it('stops listening for the cancel when it unmounts', () => {
    const view = render(<OpenFileInput onFile={vi.fn()} />);
    const detached = input();
    view.unmount();
    openStore.set({ pendingHomeCommand: 'rotate' });

    fireEvent(detached, new Event('cancel'));

    expect(openStore.get().pendingHomeCommand).toBe('rotate');
  });
});
