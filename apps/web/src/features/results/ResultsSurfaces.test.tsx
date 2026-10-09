// @vitest-environment happy-dom
/**
 * The result surfaces follow the results store: the print dialog and the scanner are on screen
 * exactly while the store says so, their own controls write it back, and the accessibility and
 * PDF/A panels hand what they produce to the shell. The dialogs' internals are pdf-ui's own
 * (and tested there); here they are stand-ins that expose the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { ScannedDocument } from 'pdf-ui/scan';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { AccessibilityDock, PdfADock, PrintDialogHost, ScanDialogHost } from './ResultsSurfaces';
import type { AccessibilityOutcome } from './results-actions';
import { initialResultsState, openPrintDialog, openScanDialog, resultsStore } from './results-store';

vi.mock('pdf-ui/printing', async () => {
  const { createElement } = await import('react');
  return {
    PrintDialog: (props: {
      viewer: unknown;
      open: boolean;
      onClose: () => void;
      onNotice: (message: string) => void;
      onProduced: (file: { name: string; bytes: Uint8Array }) => void;
    }) =>
      createElement(
        'section',
        {
          'aria-label': 'print dialog',
          'data-open': String(props.open),
          'data-viewer': String(props.viewer),
        },
        createElement('button', { type: 'button', onClick: props.onClose }, 'close print'),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onNotice('print said') },
          'notify print',
        ),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onProduced({ name: 'p.pdf', bytes: new Uint8Array([1]) }) },
          'produce print',
        ),
      ),
  };
});
vi.mock('pdf-ui/scan', async () => {
  const { createElement } = await import('react');
  return {
    ScanDialog: (props: {
      mode: string;
      onClose: () => void;
      onDocument: (result: unknown) => Promise<string | undefined>;
    }) =>
      createElement(
        'section',
        { 'aria-label': `scan dialog ${props.mode}` },
        createElement('button', { type: 'button', onClick: props.onClose }, 'close scan'),
        createElement(
          'button',
          { type: 'button', onClick: () => void props.onDocument({ name: 's.pdf' }) },
          'produce scan',
        ),
      ),
  };
});
vi.mock('pdf-ui/panels', async () => {
  const { createElement } = await import('react');
  type Outcome = { bytes: Uint8Array; notes: []; steps: string[] };
  return {
    AccessibilityPanel: (props: {
      language: string;
      currentPage: number;
      canEdit: boolean;
      read: () => Promise<Uint8Array>;
      onGoToPage: (page: number) => void;
      onWritten: (outcome: Outcome) => void;
      onTagged: (outcome: Outcome) => void;
      onAltWritten: (outcome: Outcome) => void;
      onNotice: (message: string) => void;
    }) => {
      const outcome = (steps: string[]): Outcome => ({ bytes: new Uint8Array([1]), notes: [], steps });
      return createElement(
        'section',
        {
          'aria-label': 'accessibility panel',
          'data-language': props.language,
          'data-page': String(props.currentPage),
          'data-can-edit': String(props.canEdit),
        },
        createElement('button', { type: 'button', onClick: () => props.onWritten(outcome(['fix'])) }, 'fix'),
        createElement('button', { type: 'button', onClick: () => props.onTagged(outcome(['tag'])) }, 'tag'),
        createElement(
          'button',
          { type: 'button', onClick: () => props.onAltWritten(outcome(['alt'])) },
          'alt',
        ),
        createElement('button', { type: 'button', onClick: () => props.onGoToPage(5) }, 'go'),
        createElement('button', { type: 'button', onClick: () => props.onNotice('a11y said') }, 'notify'),
        createElement('button', { type: 'button', onClick: () => void props.read() }, 'read'),
      );
    },
    PdfAPanel: (props: {
      read: () => Promise<Uint8Array>;
      onConvert: () => void;
      onNotice: (message: string) => void;
    }) =>
      createElement(
        'section',
        { 'aria-label': 'pdfa panel' },
        createElement('button', { type: 'button', onClick: props.onConvert }, 'convert'),
        createElement('button', { type: 'button', onClick: () => props.onNotice('pdfa said') }, 'notify'),
        createElement('button', { type: 'button', onClick: () => void props.read() }, 'read'),
      ),
  };
});

const t = createTranslator('en');

// The dialogs and panels are dynamic chunks (mocked here): resolve them once up front so no test races the first import.
beforeAll(async () => {
  await Promise.all([import('pdf-ui/printing'), import('pdf-ui/scan'), import('pdf-ui/panels')]);
}, 120_000);
beforeEach(() => {
  resultsStore.set(initialResultsState());
  coreStore.set(initialCoreState());
});
afterEach(cleanup);

describe('PrintDialogHost', () => {
  it('shows the print dialog exactly while the store says it is open', async () => {
    render(<PrintDialogHost t={t} viewer={null} onProduced={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'print dialog' })).toBeNull();

    act(() => openPrintDialog());
    expect(await screen.findByRole('region', { name: 'print dialog' })).toBeTruthy();
  });

  it('hands the dialog the viewer on screen and writes its close and notices back', async () => {
    const user = userEvent.setup();
    const viewer = { goToPage: vi.fn() } as unknown as ViewerApi;
    render(<PrintDialogHost t={t} viewer={viewer} onProduced={vi.fn()} />);
    act(() => openPrintDialog());
    const dialog = await screen.findByRole('region', { name: 'print dialog' });
    expect(dialog.getAttribute('data-open')).toBe('true');
    expect(dialog.getAttribute('data-viewer')).toBe(String(viewer));

    await user.click(screen.getByRole('button', { name: 'notify print' }));
    expect(coreStore.get().notice).toBe('print said');

    await user.click(screen.getByRole('button', { name: 'close print' }));
    expect(resultsStore.get().printOpen).toBe(false);
    expect(screen.queryByRole('region', { name: 'print dialog' })).toBeNull();
  });

  it('passes the imposed file to the shell', async () => {
    const user = userEvent.setup();
    const onProduced = vi.fn(() => Promise.resolve());
    render(<PrintDialogHost t={t} viewer={null} onProduced={onProduced} />);
    act(() => openPrintDialog());

    await user.click(await screen.findByRole('button', { name: 'produce print' }));

    expect(onProduced).toHaveBeenCalledWith({ name: 'p.pdf', bytes: new Uint8Array([1]) });
  });
});

describe('ScanDialogHost', () => {
  it('shows the scanner, in document mode, exactly while the store says it is open', async () => {
    const user = userEvent.setup();
    render(<ScanDialogHost t={t} onDocument={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'scan dialog document' })).toBeNull();

    act(() => openScanDialog());
    expect(await screen.findByRole('region', { name: 'scan dialog document' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'close scan' }));
    expect(resultsStore.get().scanOpen).toBe(false);
    expect(screen.queryByRole('region', { name: 'scan dialog document' })).toBeNull();
  });

  it('passes the scanned document to the shell', async () => {
    const user = userEvent.setup();
    const onDocument = vi.fn((_result: ScannedDocument) => Promise.resolve(undefined));
    render(<ScanDialogHost t={t} onDocument={onDocument} />);
    act(() => openScanDialog());

    await user.click(await screen.findByRole('button', { name: 'produce scan' }));

    expect(onDocument).toHaveBeenCalledWith({ name: 's.pdf' });
  });
});

describe('AccessibilityDock', () => {
  function dock() {
    const read = vi.fn(() => Promise.resolve(new Uint8Array([7])));
    const onWritten = vi.fn((_outcome: AccessibilityOutcome) => Promise.resolve());
    const onGoToPage = vi.fn();
    render(
      <AccessibilityDock
        t={t}
        read={read}
        language="tr"
        currentPage={2}
        canEdit={false}
        onGoToPage={onGoToPage}
        onWritten={onWritten}
      />,
    );
    return { read, onWritten, onGoToPage };
  }

  it('says what it is loading until the panel arrives, then shows it with the shell’s state', async () => {
    dock();
    const loading = screen.getByText(t('panel.accessibility'));
    expect(loading.getAttribute('aria-busy')).toBe('true');

    const panel = await screen.findByRole('region', { name: 'accessibility panel' });
    expect(panel.getAttribute('data-language')).toBe('tr');
    expect(panel.getAttribute('data-page')).toBe('2');
    expect(panel.getAttribute('data-can-edit')).toBe('false');
  });

  it('sends the PDF/UA fix, the tags editor and the alt-text writer through the same hand-over', async () => {
    const user = userEvent.setup();
    const { onWritten } = dock();
    await screen.findByRole('region', { name: 'accessibility panel' });

    await user.click(screen.getByRole('button', { name: 'fix' }));
    await user.click(screen.getByRole('button', { name: 'tag' }));
    await user.click(screen.getByRole('button', { name: 'alt' }));

    const bytes = new Uint8Array([1]);
    expect(onWritten.mock.calls).toEqual([
      [{ bytes, notes: [], steps: ['fix'] }],
      [{ bytes, notes: [], steps: ['tag'] }],
      [{ bytes, notes: [], steps: ['alt'] }],
    ]);
  });

  it('turns pages, reads the working bytes and reports notices on the status line', async () => {
    const user = userEvent.setup();
    const { read, onGoToPage } = dock();
    await screen.findByRole('region', { name: 'accessibility panel' });

    await user.click(screen.getByRole('button', { name: 'go' }));
    await user.click(screen.getByRole('button', { name: 'read' }));
    await user.click(screen.getByRole('button', { name: 'notify' }));

    expect(onGoToPage).toHaveBeenCalledWith(5);
    expect(read).toHaveBeenCalledOnce();
    expect(coreStore.get().notice).toBe('a11y said');
  });
});

describe('PdfADock', () => {
  it('says what it is loading, then opens the conversion dialog, reads bytes and reports notices', async () => {
    const user = userEvent.setup();
    const read = vi.fn(() => Promise.resolve(new Uint8Array([7])));
    const onConvert = vi.fn();
    render(<PdfADock t={t} read={read} onConvert={onConvert} />);
    expect(screen.getByText(t('panel.pdfa')).getAttribute('aria-busy')).toBe('true');
    await screen.findByRole('region', { name: 'pdfa panel' });

    await user.click(screen.getByRole('button', { name: 'convert' }));
    await user.click(screen.getByRole('button', { name: 'read' }));
    await user.click(screen.getByRole('button', { name: 'notify' }));

    expect(onConvert).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(coreStore.get().notice).toBe('pdfa said');
  });
});
