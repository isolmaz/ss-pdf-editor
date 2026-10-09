// @vitest-environment happy-dom
/**
 * The XFA fill dialog on a real dynamic form: pdf.js opens the form with its XFA renderer, the
 * dialog's `PDFViewer` lays it out as HTML inputs, and what is typed there is what the dialog
 * saves or exports. Only two seams are replaced: the standard-font fetch (served from the
 * installed `pdfjs-dist`) and the layout the browser would give the viewer container (happy-dom
 * has none, so the viewer would show no page). The seam on `openWithPdfjs` lets a test hold a
 * load open; by default it is the real one.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeDatasets } from '../../../pdf-core/src/ops/xfa';
import { mupdfForTests } from '../pdf-fixtures';
import { pureXfaPdf } from '../xfa-pure.fixtures';
import { XfaFormDialog, type XfaFormDialogProps } from './XfaFormDialog';

type OpenWithPdfjs = typeof import('pdf-core/engines/pdfjs-handle').openWithPdfjs;

const seam = vi.hoisted(() => ({
  open: null as null | ((...args: Parameters<OpenWithPdfjs>) => Promise<unknown>),
}));
vi.mock('pdf-core/engines/pdfjs-handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdf-core/engines/pdfjs-handle')>();
  return {
    ...actual,
    openWithPdfjs: (...args: Parameters<OpenWithPdfjs>) =>
      seam.open === null ? actual.openWithPdfjs(...args) : seam.open(...args),
  };
});

// happy-dom replaces `URL`, so the workspace is found from the working directory (the repository root).
const coreRequire = createRequire(join(process.cwd(), 'packages', 'pdf-core', 'package.json'));
const fontsDir = `${coreRequire
  .resolve('pdfjs-dist/package.json')
  .replaceAll('\\', '/')
  .replace(/package\.json$/, '')}standard_fonts/`;
const t = createTranslator('en');

const LAYOUT = { clientWidth: 800, clientHeight: 600, offsetWidth: 800, offsetHeight: 600 } as const;
const originals = new Map<string, PropertyDescriptor | undefined>();

/** The data the form is bound to: what the fields show, and what a typed value replaces. */
const DATA =
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Ada</Name><Notes>first</Notes></form1></xfa:data></xfa:datasets>';

/** The pure XFA fixture with its fields bound to data nodes, as a form that was filled before is. */
async function boundFormPdf(): Promise<Uint8Array> {
  const mupdf = await mupdfForTests();
  const doc = new mupdf.PDFDocument(await pureXfaPdf());
  writeDatasets(doc, DATA);
  const saved = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return saved;
}

let bytes: Uint8Array;

beforeAll(async () => {
  // The editor has pdf.js loaded long before this dialog opens, and the viewer module reads
  // `globalThis.pdfjsLib` that loading sets.
  await import('pdfjs-dist');
  bytes = await boundFormPdf();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(readFileSync(`${fontsDir}${String(url).slice(String(url).lastIndexOf('/') + 1)}`)),
  );
  for (const [name, value] of Object.entries(LAYOUT)) {
    originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
});

afterEach(() => {
  cleanup();
  seam.open = null;
  vi.unstubAllGlobals();
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
    else Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  originals.clear();
});

function props(overrides: Partial<XfaFormDialogProps> = {}): XfaFormDialogProps {
  return {
    t,
    bytes,
    onClose: vi.fn(),
    onSave: vi.fn(async () => undefined),
    onExport: vi.fn(),
    ...overrides,
  };
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

/** The dialog once pdf.js has laid the form out: its inputs exist and the buttons are live. */
async function opened(overrides: Partial<XfaFormDialogProps> = {}) {
  const given = props(overrides);
  const view = render(<XfaFormDialog {...given} />);
  await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2), { timeout: 20000 });
  return { given, view };
}

describe('XfaFormDialog on a dynamic form', () => {
  it('shows the form as inputs holding the stored values, with nothing to save yet', async () => {
    await opened();
    const [name, notes] = screen.getAllByRole('textbox') as HTMLInputElement[];
    expect(name?.value).toBe('Ada');
    expect(notes?.value).toBe('first');
    expect(screen.queryByText('Preparing the form…')).toBeNull();
    expect(button('Save to document').disabled).toBe(true);
    expect(button('Export data (XML)').disabled).toBe(false);
  }, 30000);

  it('says it is preparing the form until pdf.js has opened it', async () => {
    render(<XfaFormDialog {...props()} />);
    expect(screen.getByRole('status').textContent).toBe('Preparing the form…');
    expect(button('Export data (XML)').disabled).toBe(true);
    await waitFor(() => expect(screen.queryByText('Preparing the form…')).toBeNull(), { timeout: 20000 });
  }, 30000);

  it('saves what was typed through the verification and hands the outcome to the host', async () => {
    const { given } = await opened();
    const [name] = screen.getAllByRole('textbox') as HTMLInputElement[];
    await userEvent.clear(name as HTMLInputElement);
    await userEvent.type(name as HTMLInputElement, 'Zed');
    await waitFor(() => expect(button('Save to document').disabled).toBe(false));

    await userEvent.click(button('Save to document'));
    await waitFor(() => expect(given.onSave).toHaveBeenCalledTimes(1));
    const outcome = vi.mocked(given.onSave).mock.calls[0]?.[0];
    expect(outcome?.changed).toBe(1);
    expect(outcome?.report.steps).toEqual(['xfa.datasets', 'verify']);
    expect(outcome?.report.incremental).toBe(true);
    expect(outcome?.bytes.byteLength).toBeGreaterThan(bytes.byteLength);
  }, 40000);

  it('says there is nothing to save when the typed values end up as the stored ones', async () => {
    const { given } = await opened();
    const [name] = screen.getAllByRole('textbox') as HTMLInputElement[];
    await userEvent.type(name as HTMLInputElement, 'x');
    await userEvent.type(name as HTMLInputElement, '{Backspace}');
    await waitFor(() => expect(button('Save to document').disabled).toBe(false));

    await userEvent.click(button('Save to document'));
    await waitFor(() => expect(screen.getByText('The form has no change to save.')).toBeTruthy());
    expect(given.onSave).not.toHaveBeenCalled();
  }, 40000);

  it('says why the host could not save, and lets the user try again', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    await opened({ onSave });
    await userEvent.type(screen.getAllByRole('textbox')[0] as HTMLInputElement, 'Q');
    await waitFor(() => expect(button('Save to document').disabled).toBe(false));

    await userEvent.click(button('Save to document'));
    await waitFor(() =>
      expect(
        screen.getByText('Something unexpected went wrong. Try again; report it if it keeps happening.'),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(button('Save to document').disabled).toBe(false));

    await userEvent.click(button('Save to document'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Something unexpected went wrong/)).toBeNull();
  }, 40000);

  it('exports what the form shows now as a data file and says how many values it holds', async () => {
    const { given } = await opened();
    await userEvent.click(button('Export data (XML)'));
    await waitFor(() => expect(given.onExport).toHaveBeenCalledTimes(1));
    const file = vi.mocked(given.onExport).mock.calls[0]?.[0];
    expect(file?.mime).toMatch(/xml/);
    expect(new TextDecoder().decode(file?.bytes)).toContain('<form1');
    expect(screen.getByText(`${file?.values} data value(s) exported.`)).toBeTruthy();
  }, 40000);

  it('closes at once when nothing was typed', async () => {
    const { given } = await opened();
    await userEvent.click(button('Close'));
    expect(given.onClose).toHaveBeenCalledTimes(1);
  }, 30000);

  it('asks once before it discards typed values, then closes', async () => {
    const { given } = await opened();
    await userEvent.type(screen.getAllByRole('textbox')[0] as HTMLInputElement, 'Q');
    await waitFor(() => expect(button('Save to document').disabled).toBe(false));

    await userEvent.click(button('Close'));
    expect(given.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('not saved');

    await userEvent.click(button('Close without saving'));
    expect(given.onClose).toHaveBeenCalledTimes(1);
  }, 30000);

  it('treats Escape as a request to close, never as closing by itself', async () => {
    const { given } = await opened();
    await userEvent.keyboard('{Escape}');
    expect(given.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  }, 30000);
});

describe('XfaFormDialog when the form cannot be filled', () => {
  it('says so for a form pdf.js does not render as XFA, and offers nothing to save or export', async () => {
    render(<XfaFormDialog {...props({ bytes: await pureXfaPdf({ needsRendering: false }) })} />);
    const alert = await screen.findByRole('alert', {}, { timeout: 20000 });
    expect(alert.textContent).toBe(
      'This is a static XFA form: its pages are already in the PDF. Use “Flatten form fields”, or “Remove XFA” to keep only the AcroForm.',
    );
    expect(button('Export data (XML)').disabled).toBe(true);
    expect(button('Save to document').disabled).toBe(true);
  }, 30000);
});

/** A real open, held until the test lets it finish. */
function heldOpen() {
  const releases: (() => void)[] = [];
  const handles: PdfDocumentHandle[] = [];
  seam.open = async (...args: Parameters<OpenWithPdfjs>) => {
    const actual = await vi.importActual<typeof import('pdf-core/engines/pdfjs-handle')>(
      'pdf-core/engines/pdfjs-handle',
    );
    const handle = await actual.openWithPdfjs(...args);
    handles.push(handle);
    await new Promise<void>((release) => releases.push(release));
    return handle;
  };
  return {
    handles,
    releaseAll: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}

describe('XfaFormDialog while a load is in flight', () => {
  it('destroys a document that finished opening after the dialog was closed', async () => {
    const held = heldOpen();
    const { unmount } = render(<XfaFormDialog {...props()} />);
    await waitFor(() => expect(held.handles).toHaveLength(1), { timeout: 20000 });
    const destroy = vi.spyOn(held.handles[0] as PdfDocumentHandle, 'destroy');
    unmount();
    held.releaseAll();
    await waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  }, 30000);

  it('does not let the failure of an abandoned load replace the form that replaced it', async () => {
    let failFirst: (cause: Error) => void = () => {};
    let calls = 0;
    const actual = await vi.importActual<typeof import('pdf-core/engines/pdfjs-handle')>(
      'pdf-core/engines/pdfjs-handle',
    );
    seam.open = (...args: Parameters<OpenWithPdfjs>) => {
      calls += 1;
      if (calls === 1) return new Promise((_ok, fail) => (failFirst = fail));
      return actual.openWithPdfjs(...args);
    };
    const given = props();
    const { rerender } = render(<XfaFormDialog {...given} />);
    await waitFor(() => expect(calls).toBe(1));
    rerender(<XfaFormDialog {...given} bytes={bytes.slice()} />);
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2), { timeout: 20000 });

    await act(async () => failFirst(new Error('stale')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  }, 40000);

  it('closes without an error when the engine cannot release the document', async () => {
    const actual = await vi.importActual<typeof import('pdf-core/engines/pdfjs-handle')>(
      'pdf-core/engines/pdfjs-handle',
    );
    let destroy: ReturnType<typeof vi.fn> | null = null;
    seam.open = async (...args: Parameters<OpenWithPdfjs>) => {
      const handle = await actual.openWithPdfjs(...args);
      const real = handle.destroy.bind(handle);
      destroy = vi.fn(async () => {
        await real();
        throw new Error('worker already gone');
      });
      return { ...handle, destroy, raw: handle.raw, saveDocument: () => handle.saveDocument() };
    };
    const { view } = await opened();
    view.unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  }, 30000);

  it('reports an unexpected error rather than exporting when the document is being reloaded', async () => {
    const given = props();
    const { given: shown, view } = await opened(given);
    seam.open = () => new Promise(() => {});
    view.rerender(<XfaFormDialog {...shown} bytes={bytes.slice()} />);
    await userEvent.click(button('Export data (XML)'));
    await waitFor(() =>
      expect(
        screen.getByText('Something unexpected went wrong. Try again; report it if it keeps happening.'),
      ).toBeTruthy(),
    );
    expect(shown.onExport).not.toHaveBeenCalled();
  }, 40000);
});
