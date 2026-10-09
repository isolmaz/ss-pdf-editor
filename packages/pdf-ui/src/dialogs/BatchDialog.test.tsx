// @vitest-environment happy-dom
/**
 * The batch dialog: which steps a rule set holds for the values on the form, what a run reports
 * per file, and how the queue is filled (picker, folder watch, template). Runs use the real
 * `runBatch` over real PDFs; the only seam is a wrapper around it that can hold a run open so the
 * running state can be seen and cancelled.
 */

import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BatchRuleSet } from 'pdf-core/ops/batch';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mupdfForTests, textPdf } from '../pdf-fixtures';
import { BatchDialog } from './BatchDialog';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected value is missing');
  return value;
}

type RunBatch = typeof import('pdf-core/ops/batch').runBatch;

const seam = vi.hoisted(() => ({
  before: null as null | ((...args: Parameters<RunBatch>) => Promise<void>),
}));
vi.mock('pdf-core/ops/batch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdf-core/ops/batch')>();
  return {
    ...actual,
    runBatch: async (...args: Parameters<RunBatch>) => {
      await seam.before?.(...args);
      return await actual.runBatch(...args);
    },
  };
});

// Fault injection at the engine seam: the compressor can be made to fail the way mupdf does when it
// names a page and carries no message of its own, which is the one failure a real file cannot cause.
const engine = vi.hoisted(() => ({ failCompress: false }));
vi.mock('pdf-core/ops/compress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdf-core/ops/compress')>();
  const { ToolError } = await import('pdf-shared');
  return {
    ...actual,
    compressDocument: async (...args: Parameters<typeof actual.compressDocument>) => {
      if (engine.failCompress) throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: 0 });
      return await actual.compressDocument(...args);
    },
  };
});

const t = createTranslator('en');

// Everything these tests wait for (a report, a loaded ruleset, a banner) is a real condition that
// resolves on its own; the 1 s default of `findBy`/`waitFor` only races a busy machine.
configure({ asyncUtilTimeout: 20000 });

// Real work is inherent to this file: tests build PDFs with MuPDF and run the real `runBatch` over
// them, and the step-settings tests drive dozens of real interactions on a dialog that re-renders
// its whole form each time. Alone each takes well under a second; a loaded CI core several times that.
const ENGINE_WORK_TIMEOUT = 30000;
vi.setConfig({ testTimeout: ENGINE_WORK_TIMEOUT });

beforeAll(async () => {
  // Warm the engine once, outside any test's clock, so no test pays for the cold start.
  await textPdf([['warm']]);
}, ENGINE_WORK_TIMEOUT);

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  seam.before = null;
  engine.failCompress = false;
  // No inter-action timer yield: each action is already awaited, and a macrotask per action is
  // pure scheduling cost on a loaded machine.
  user = userEvent.setup({ delay: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

function show() {
  const handlers = { onClose: vi.fn(), onDownload: vi.fn(), onNotice: vi.fn() };
  render(<BatchDialog open t={t} {...handlers} />);
  return handlers;
}

const STEPS = {
  pages: 'Extract Pages',
  compress: 'Optimize / Compress',
  ocr: 'Text recognition (OCR)',
  labels: 'Page labels',
  stamp: 'Header / Footer & Page Numbering',
  metadata: 'Document properties',
  textExport: 'Export Text',
  protect: 'Security',
} as const;

const step = (label: string) => screen.getByRole('checkbox', { name: label }) as HTMLInputElement;
const checked = (label: string) => step(label).getAttribute('aria-checked') === 'true';

/** Leave exactly these steps ticked: the form starts with Compress and Properties. */
async function stepsOnly(...wanted: string[]) {
  for (const label of Object.values(STEPS)) {
    if (checked(label) !== wanted.includes(label)) await user.click(step(label));
  }
}

/** The rule set the form holds, read the way a user gets it: through "Save ruleset". */
async function savedRuleSet(onDownload: ReturnType<typeof vi.fn>): Promise<BatchRuleSet> {
  await user.click(screen.getByRole('button', { name: 'Save ruleset (JSON)' }));
  const files = onDownload.mock.calls.at(-1)?.[0] as { name: string; bytes: Uint8Array; mime: string }[];
  expect(files).toHaveLength(1);
  expect(files[0]?.mime).toBe('application/json');
  return JSON.parse(new TextDecoder().decode(files[0]?.bytes)) as BatchRuleSet;
}

describe('BatchDialog rule sets built from the form', () => {
  it('starts with Compress and Properties ticked and offers the other steps unticked', () => {
    show();
    expect(Object.values(STEPS).filter(checked)).toEqual([STEPS.compress, STEPS.metadata]);
    for (const label of Object.values(STEPS)) expect(step(label)).toBeTruthy();
  });

  it('writes the default structure-compress and an empty properties patch', async () => {
    const { onDownload } = show();
    const saved = await savedRuleSet(onDownload);
    expect(saved).toEqual({
      version: 1,
      name: 'toplu',
      steps: [
        { kind: 'compress', params: { mode: 'structure', stripMetadata: false, keepProducer: true } },
        {
          kind: 'metadata',
          params: { patch: { writeXmp: false }, clean: false, cleanXmp: false },
        },
      ],
    });
    expect(onDownload.mock.calls[0]?.[0][0].name).toBe('toplu.batch.json');
  });
});

const field = (name: string, index = 0) =>
  screen.getAllByRole('textbox', { name })[index] as HTMLInputElement;
const number = (name: string) => screen.getByRole('spinbutton', { name }) as HTMLInputElement;

/**
 * Set the field to `text` as one change. Typing would need the field focused, and the dialog moves
 * focus to its first control shortly after it opens, so keystrokes sent right after `show()` can land
 * on that control instead. One change per field also avoids a re-render of the dialog per character.
 */
function replace(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
}

describe('BatchDialog step settings', () => {
  it('names the rule set and its file after the typed name, and falls back to "toplu" when it is blank', async () => {
    const { onDownload } = show();
    replace(field('Ruleset name'), '  Invoices ');
    expect((await savedRuleSet(onDownload)).name).toBe('Invoices');
    expect(onDownload.mock.calls.at(-1)?.[0][0].name).toBe('Invoices.batch.json');

    replace(field('Ruleset name'), '   ');
    expect((await savedRuleSet(onDownload)).name).toBe('toplu');
    expect(onDownload.mock.calls.at(-1)?.[0][0].name).toBe('toplu.batch.json');
  });

  it('reads a typed page range as zero-based pages and an empty one as every page', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.pages);
    expect((await savedRuleSet(onDownload)).steps).toEqual([{ kind: 'pages', params: { pages: 'all' } }]);

    replace(field('Page range'), '1-2, 4');
    expect((await savedRuleSet(onDownload)).steps).toEqual([{ kind: 'pages', params: { pages: [0, 1, 3] } }]);
  });

  it('writes the structure method with the clear-metadata choice', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.compress);
    await user.click(screen.getByRole('checkbox', { name: 'Clear metadata' }));
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      { kind: 'compress', params: { mode: 'structure', stripMetadata: true, keepProducer: true } },
    ]);
  });

  it('writes the page-image method with its resolution, quality and greyscale, and a cleared number falls back', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.compress);
    await user.click(screen.getByRole('radio', { name: 'Convert pages to image (lossy)' }));
    await user.click(screen.getByRole('checkbox', { name: 'Convert to greyscale' }));
    replace(number('Resolution (DPI)'), '200');
    replace(number('Image quality'), '0.5');
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      { kind: 'compress', params: { mode: 'raster', pages: 'all', dpi: 200, quality: 0.5, greyscale: true } },
    ]);

    replace(number('Resolution (DPI)'), '');
    replace(number('Image quality'), '');
    const params = (await savedRuleSet(onDownload)).steps[0]?.params as { dpi: number; quality: number };
    expect([params.dpi, params.quality]).toEqual([150, 0.7]);
  });

  it('writes the recognition settings, with the other quality and the re-read choice', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.ocr);
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      {
        kind: 'ocr',
        params: { pages: 'all', languages: ['tur'], quality: 'fast', dpi: 200, existingText: 'skip' },
      },
    ]);

    await user.click(screen.getByRole('radio', { name: 'High quality' }));
    await user.click(screen.getByRole('radio', { name: 'Read again (adds a layer)' }));
    await user.click(screen.getByRole('checkbox', { name: 'English' }));
    replace(number('Resolution (DPI)'), '300');
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      {
        kind: 'ocr',
        params: {
          pages: 'all',
          languages: ['tur', 'eng'],
          quality: 'best',
          dpi: 300,
          existingText: 'overwrite',
        },
      },
    ]);
  });

  it('writes a page-label range from one-based page to zero-based start', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.labels);
    replace(number('Starting page'), '3');
    replace(field('Prefix'), 'A-');
    replace(number('Starting number'), '5');
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      {
        kind: 'page-labels',
        params: { ranges: [{ startPage: 2, style: 'decimal', prefix: 'A-', start: 5 }] },
      },
    ]);
  });

  it('writes header-and-footer stamping, then Bates numbering for the same position and sizes', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.stamp);
    await user.click(screen.getByRole('checkbox', { name: 'Skip first page' }));
    replace(number('Font size'), '12');
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      {
        kind: 'stamp',
        params: {
          kind: 'header-footer',
          pages: 'all',
          anchor: 'bottom-center',
          template: '{page} / {total}',
          startAt: 1,
          fontSize: 12,
          marginMm: 12,
          skipFirst: true,
        },
      },
    ]);

    await user.click(screen.getByRole('radio', { name: 'Bates numbering' }));
    replace(field('Prefix'), 'CASE-');
    replace(number('Number of digits'), '8');
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      {
        kind: 'stamp',
        params: {
          kind: 'bates',
          pages: 'all',
          anchor: 'bottom-center',
          prefix: 'CASE-',
          startAt: 1,
          digits: 8,
          fontSize: 12,
          marginMm: 12,
        },
      },
    ]);
  });

  it('writes only the properties that were filled in', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.metadata);
    replace(field('Title'), 'Report');
    replace(field('Subject'), 'Q3');
    await user.click(screen.getByRole('checkbox', { name: 'Also write to XMP packet' }));
    await user.click(screen.getByRole('checkbox', { name: 'Delete Info dictionary fields' }));
    await user.click(screen.getByRole('checkbox', { name: 'Delete XMP metadata packet' }));
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      {
        kind: 'metadata',
        params: { patch: { title: 'Report', subject: 'Q3', writeXmp: true }, clean: true, cleanXmp: true },
      },
    ]);

    replace(field('Title'), '');
    replace(field('Subject'), '');
    replace(field('Author'), 'Ada');
    expect((must((await savedRuleSet(onDownload)).steps[0]).params as { patch: object }).patch).toEqual({
      author: 'Ada',
      writeXmp: true,
    });
  });

  it('writes the text export in the chosen format under a batch stem', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.textExport);
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      { kind: 'text-export', params: { pages: 'all', format: 'text', baseName: 'batch' } },
    ]);
    await user.click(screen.getByRole('radio', { name: 'Markdown' }));
    expect((must((await savedRuleSet(onDownload)).steps[0]).params as { format: string }).format).toBe(
      'markdown',
    );
  });

  it('writes the passwords and exactly the permissions that stay ticked', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.protect);
    replace(screen.getByLabelText('Open password') as HTMLInputElement, 'open');
    replace(screen.getByLabelText('Owner password') as HTMLInputElement, 'owner');
    await user.click(screen.getByRole('checkbox', { name: 'Printing' }));
    await user.click(screen.getByRole('checkbox', { name: 'Editing' }));
    expect((await savedRuleSet(onDownload)).steps).toEqual([
      {
        kind: 'protect',
        params: {
          userPassword: 'open',
          ownerPassword: 'owner',
          permissions: {
            print: false,
            printHighQuality: false,
            copy: true,
            modify: true,
            annotate: false,
            form: false,
            assemble: false,
            accessibility: false,
          },
        },
      },
    ]);
  });

  it('refuses to save a rule set with no step, and to run one', async () => {
    const { onDownload } = show();
    await stepsOnly();
    expect((screen.getByRole('button', { name: 'Run batch' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save ruleset (JSON)' }));
    expect(onDownload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      'Select pages first.Select one or more pages from the Pages panel.',
    );
  });
});

const pdfInput = () =>
  document.querySelector('input[type="file"][accept^="application/pdf"]') as HTMLInputElement;
const templateInput = () =>
  document.querySelector('input[type="file"][accept^="application/json"]') as HTMLInputElement;
const pdfFile = async (name: string, pages: string[][] = [['Hello']]) =>
  new File([(await textPdf(pages)) as BlobPart], name, { type: 'application/pdf' });

/** A file the engine cannot open: the bytes are not a PDF. */
const brokenFile = (name: string) => new File(['this is not a pdf'], name, { type: 'application/pdf' });

/** Pass the queue to the dialog the way a user does, then run it and wait for the report. */
async function runQueue(files: File[]) {
  await user.upload(pdfInput(), files);
  await user.click(screen.getByRole('button', { name: 'Run batch' }));
  await screen.findByRole('heading', { name: 'File report' }, { timeout: 20000 });
}

const summary = () => screen.getAllByRole('status').map((node) => node.textContent);

describe('BatchDialog the queue', () => {
  it('opens the file chooser from the Open button and lists what was chosen, out of the 256 it holds', async () => {
    show();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(click.mock.contexts[0]).toBe(pdfInput());
    expect(pdfInput().accept).toBe('application/pdf,.pdf');
    expect(pdfInput().multiple).toBe(true);
    expect(screen.getByText('0/256')).toBeTruthy();

    await user.upload(pdfInput(), [await pdfFile('a.pdf'), await pdfFile('b.pdf')]);
    expect(screen.getByText('2/256')).toBeTruthy();
    expect(screen.getByText('a.pdf')).toBeTruthy();
    expect(screen.getByText('b.pdf')).toBeTruthy();
  });

  it('keeps the queue when the chooser is dismissed without a choice', async () => {
    show();
    await user.upload(pdfInput(), await pdfFile('a.pdf'));
    fireEvent.change(pdfInput(), { target: { files: [] } });
    expect(screen.getByText('1/256')).toBeTruthy();
  });

  it('cannot run with no file and no loaded ruleset', () => {
    show();
    expect((screen.getByRole('button', { name: 'Run batch' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('BatchDialog running', () => {
  it('runs the steps over every file and reports each one with its sizes, then downloads what finished', async () => {
    const { onDownload, onNotice } = show();
    await runQueue([await pdfFile('a.pdf'), await pdfFile('b.pdf', [['x'], ['y']])]);

    expect(summary()).toContain('2 completed, 0 failed, 0 skipped');
    expect(onNotice).toHaveBeenCalledWith('2 completed, 0 failed, 0 skipped');
    const rows = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    expect(
      rows.some((row) => /^a\.pdf — Optimize \/ Compress · \d+ → \d+ bytes, 1 page\(s\)/.test(row)),
    ).toBe(true);
    expect(
      rows.some((row) => /^b\.pdf — Optimize \/ Compress · \d+ → \d+ bytes, 2 page\(s\)/.test(row)),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Download finished files' }));
    const files = onDownload.mock.calls[0]?.[0] as { name: string; bytes: Uint8Array; mime: string }[];
    expect(files.map((file) => [file.name, file.mime])).toEqual([
      ['a.pdf', 'application/pdf'],
      ['b.pdf', 'application/pdf'],
    ]);
    expect(new TextDecoder().decode(files[0]?.bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('downloads a text export next to its PDF, named after the file it came from', async () => {
    const { onDownload } = show();
    await stepsOnly(STEPS.textExport);
    await runQueue([await pdfFile('report.pdf', [['Quarterly numbers']])]);
    await user.click(screen.getByRole('button', { name: 'Download finished files' }));
    const files = onDownload.mock.calls[0]?.[0] as { name: string; bytes: Uint8Array }[];
    expect(files.map((file) => file.name)).toEqual(['report.pdf', 'report-batch.txt']);
    expect(new TextDecoder().decode(files[1]?.bytes)).toContain('Quarterly numbers');
  });

  it('reports a file that could not be opened without stopping the others, and downloads only the good ones', async () => {
    const { onDownload } = show();
    await runQueue([brokenFile('broken.pdf'), await pdfFile('good.pdf')]);
    expect(summary()).toContain('1 completed, 1 failed, 0 skipped');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Failed at step Optimize / Compress:');

    await user.click(screen.getByRole('button', { name: 'Download finished files' }));
    expect((must(onDownload.mock.calls[0])[0] as { name: string }[]).map((file) => file.name)).toEqual([
      'good.pdf',
    ]);
  });

  it('shows what each failed file failed on, with the engine detail under it', async () => {
    show();
    const mupdf = await mupdfForTests();
    const doc = new mupdf.PDFDocument(await textPdf([['secret']]));
    const locked = new File(
      [
        new Uint8Array(
          doc.saveToBuffer('encrypt=aes-128,user-password=u,owner-password=o').asUint8Array(),
        ) as BlobPart,
      ],
      'locked.pdf',
    );
    doc.destroy();
    await runQueue([locked, brokenFile('broken.pdf')]);
    expect(screen.getAllByRole('alert').map((node) => node.textContent)).toEqual([
      'Failed at step Optimize / Compress: Encrypted documents cannot be opened for this operation.Remove the password first and try again.the document needs a password to be read',
      'Failed at step Optimize / Compress: The document looks damaged.Try opening the file in another reader.open: no objects found',
    ]);
  });

  it('shows a failure the engine gave no message for as its two sentences alone', async () => {
    show();
    engine.failCompress = true;
    await runQueue([await pdfFile('a.pdf')]);
    const alert = screen.getByRole('alert');
    expect(Array.from(alert.querySelectorAll('p')).map((line) => line.textContent)).toEqual([
      'Failed at step Optimize / Compress: Page range could not be parsed.',
      'Enter a range like 1-3, 5 or 8-10.',
    ]);
  });

  it('fails a file over the size ceiling before any step, naming no step', async () => {
    show();
    const huge = {
      name: 'huge.pdf',
      arrayBuffer: async () => new ArrayBuffer(300 * 1024 * 1024 + 1),
    } as File;
    await user.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.change(pdfInput(), { target: { files: [huge] } });
    await user.click(screen.getByRole('button', { name: 'Run batch' }));
    await screen.findByRole('heading', { name: 'File report' }, { timeout: 20000 });
    expect(screen.getByRole('alert').textContent).toMatch(
      /^Failed at step Export Text|^Failed at step Document properties:/,
    );
  });

  it('holds the running state: fields locked, Escape ignored, and Cancel stops the queue as skipped files', async () => {
    let signal: AbortSignal | undefined;
    let release: () => void = () => {};
    seam.before = async (_items, _rules, options) => {
      signal = options.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const { onClose } = show();
    await user.upload(pdfInput(), [await pdfFile('a.pdf'), await pdfFile('b.pdf')]);
    await user.click(screen.getByRole('button', { name: 'Run batch' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2));
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
    expect(field('Ruleset name').disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[1] as HTMLElement);
    expect(signal?.aborted).toBe(true);
    await act(async () => release());
    await screen.findByRole('heading', { name: 'File report' });
    expect(summary()).toContain('0 completed, 0 failed, 2 skipped');
    expect(screen.getByText(/^Batch cancelled\. Completed files:/)).toBeTruthy();
    expect(screen.getAllByText('Skipped (run stopped).')).toHaveLength(2);
  });

  it('leaves through the first Cancel button while running', async () => {
    seam.before = () => new Promise<void>(() => {});
    const { onClose } = show();
    await user.upload(pdfInput(), await pdfFile('a.pdf'));
    await user.click(screen.getByRole('button', { name: 'Run batch' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2));
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0] as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('aborts the run when the dialog is unmounted', async () => {
    let signal: AbortSignal | undefined;
    seam.before = (_items, _rules, options) => {
      signal = options.signal;
      return new Promise<void>(() => {});
    };
    show();
    await user.upload(pdfInput(), await pdfFile('a.pdf'));
    await user.click(screen.getByRole('button', { name: 'Run batch' }));
    await waitFor(() => expect(signal).toBeDefined());
    cleanup();
    expect(signal?.aborted).toBe(true);
  });

  it('closes on Escape when nothing runs', async () => {
    const { onClose } = show();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the operation phase and the file number while it runs', async () => {
    seam.before = async (_items, _rules, options) => {
      options.onProgress?.({
        itemIndex: 1,
        itemName: 'b.pdf',
        doneItems: 1,
        totalItems: 2,
        stepIndex: 0,
        step: 'compress',
        operation: { phase: 'save', labelKey: 'optimize.title' },
      });
      await new Promise<void>(() => {});
    };
    show();
    await user.upload(pdfInput(), [await pdfFile('a.pdf'), await pdfFile('b.pdf')]);
    await user.click(screen.getByRole('button', { name: 'Run batch' }));
    await screen.findByText('b.pdf', { selector: 'p' });
    expect(screen.getByText('Optimize / Compress', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
  });
});

describe('BatchDialog rulesets from a file', () => {
  const template = (steps: unknown[]) =>
    new File([JSON.stringify({ version: 1, name: 'Loaded', steps })], 'r.batch.json', {
      type: 'application/json',
    });

  it('loads a ruleset verbatim: the steps are locked, the name is taken, and Discard returns the form', async () => {
    show();
    await user.upload(
      templateInput(),
      template([{ kind: 'text-export', params: { pages: 'all', format: 'text', baseName: 'batch' } }]),
    );
    expect(
      await screen.findByText('Loaded ruleset contains 1 step(s); batch will run with this set.'),
    ).toBeTruthy();
    expect(field('Ruleset name').value).toBe('Loaded');
    expect(field('Ruleset name').disabled).toBe(true);
    expect(step(STEPS.compress).getAttribute('aria-disabled')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Discard loaded ruleset' }));
    expect(screen.queryByText(/Loaded ruleset contains/)).toBeNull();
    expect(step(STEPS.compress).getAttribute('aria-disabled')).not.toBe('true');
  });

  it('drops the loaded ruleset as soon as a step setting is edited', async () => {
    show();
    await user.upload(templateInput(), template([{ kind: 'compress', params: { mode: 'structure' } }]));
    await screen.findByText(/Loaded ruleset contains/);
    await user.click(screen.getByRole('checkbox', { name: 'Clear metadata' }));
    expect(screen.queryByText(/Loaded ruleset contains/)).toBeNull();
  });

  it('says why a ruleset file could not be read', async () => {
    show();
    await user.upload(templateInput(), new File(['{ nope'], 'bad.json', { type: 'application/json' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      "This file format is not supported.Pick a PDF file. the template is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
    );
  });

  it('opens the ruleset chooser, for JSON files, from the Load button', async () => {
    show();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click');
    await user.click(screen.getByRole('button', { name: 'Load ruleset' }));
    expect(click.mock.contexts[0]).toBe(templateInput());
    expect(templateInput().accept).toBe('application/json,.json');
  });

  it('ignores a dismissed template chooser', () => {
    show();
    fireEvent.change(templateInput(), { target: { files: { length: 0, item: () => null } } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('can run a loaded ruleset with no queue, and says the run has nothing to work with', async () => {
    show();
    await user.upload(templateInput(), template([{ kind: 'compress', params: { mode: 'structure' } }]));
    await screen.findByText(/Loaded ruleset contains/);
    await user.click(screen.getByRole('button', { name: 'Run batch' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'This operation has nothing to work with yet.Choose the file or images it asks for in the panel, or scan a page, then run it again.',
    );
    expect(screen.getByText('0/0')).toBeTruthy();
  });

  it('refuses a page range it cannot read and says which field', async () => {
    show();
    await stepsOnly(STEPS.pages);
    replace(field('Page range'), 'zzz');
    await user.upload(pdfInput(), await pdfFile('a.pdf'));
    await user.click(screen.getByRole('button', { name: 'Run batch' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read step settings.pages: zzz');
  });
});

describe('BatchDialog watching a folder', () => {
  const pdf = (name: string, size = 1) => new File([new Uint8Array(size)], name, { type: 'application/pdf' });

  /** A directory handle whose PDFs are whatever `contents.current` holds; `hold` delays a listing. */
  function folder(name: string, initial: File[]) {
    const contents = { current: initial };
    let hold: Promise<void> | null = null;
    const handle = {
      kind: 'directory',
      name,
      async *values() {
        if (hold !== null) await hold;
        yield { kind: 'directory', name: 'sub' };
        yield { kind: 'file', name: 'notes.txt', getFile: async () => pdf('notes.txt') };
        for (const file of contents.current)
          yield { kind: 'file', name: file.name, getFile: async () => file };
      },
    };
    return { handle, contents, holdListing: (gate: Promise<void>) => (hold = gate) };
  }

  function offerPicker(...handles: unknown[]) {
    const queue = [...handles];
    const picker = vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new DOMException('dismissed', 'AbortError');
      return next;
    });
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: picker });
    return picker;
  }

  const watch = () => fireEvent.click(screen.getByRole('button', { name: 'Watch Folder' }));
  const tick = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('offers no folder watching where the browser cannot pick a directory', () => {
    show();
    expect(screen.queryByRole('button', { name: 'Watch Folder' })).toBeNull();
  });

  it('queues the PDFs of the folder, follows changes every four seconds, and stops on request', async () => {
    const dir = folder('Inbox', [pdf('a.pdf'), pdf('b.pdf')]);
    offerPicker(dir.handle);
    const { onNotice } = show();
    watch();
    await screen.findByText('Watching folder: Inbox');
    expect(screen.getByText('2/256')).toBeTruthy();
    expect(onNotice).toHaveBeenLastCalledWith('2 PDF files queued from folder.');
    expect(screen.queryByText('notes.txt')).toBeNull();

    onNotice.mockClear();
    await tick();
    expect(onNotice).not.toHaveBeenCalled();

    dir.contents.current = [pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf')];
    await tick();
    expect(onNotice).toHaveBeenLastCalledWith('3 PDF files queued from folder.');
    expect(screen.getByText('3/256')).toBeTruthy();

    dir.contents.current = [pdf('a.pdf'), pdf('b.pdf'), pdf('d.pdf')];
    await tick();
    expect(screen.getByText('d.pdf')).toBeTruthy();
    expect(screen.queryByText('c.pdf')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stop Watching' }));
    expect(screen.queryByText('Watching folder: Inbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Watch Folder' })).toBeTruthy();
    onNotice.mockClear();
    dir.contents.current = [pdf('z.pdf')];
    await tick();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('queues nothing, and says nothing, for an empty folder; a dismissed picker changes nothing', async () => {
    const empty = folder('Empty', []);
    offerPicker(empty.handle);
    const { onNotice } = show();
    watch();
    await screen.findByText('Watching folder: Empty');
    expect(onNotice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Watching' }));

    watch();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByText(/Watching folder/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Watch Folder' })).toBeTruthy();
  });

  it('keeps watching through a listing that fails', async () => {
    const dir = folder('Flaky', [pdf('a.pdf')]);
    offerPicker(dir.handle);
    const { onNotice } = show();
    watch();
    await screen.findByText('Watching folder: Flaky');
    onNotice.mockClear();
    dir.handle.values = async function* () {
      // The listing yields nothing before the folder refuses to be read.
      yield* [];
      throw new Error('permission revoked');
    };
    await tick();
    expect(onNotice).not.toHaveBeenCalled();
    expect(screen.getByText('Watching folder: Inbox'.replace('Inbox', 'Flaky'))).toBeTruthy();
  });

  it('does not start watching again when Stop came before the first listing finished', async () => {
    const dir = folder('Slow', [pdf('a.pdf')]);
    let open: () => void = () => {};
    dir.holdListing(new Promise<void>((resolve) => (open = resolve)));
    offerPicker(dir.handle);
    const { onNotice } = show();
    watch();
    await screen.findByText('Watching folder: Slow');
    fireEvent.click(screen.getByRole('button', { name: 'Stop Watching' }));
    await act(async () => open());
    onNotice.mockClear();
    dir.contents.current = [pdf('a.pdf'), pdf('b.pdf')];
    await tick();
    expect(onNotice).not.toHaveBeenCalled();
    expect(screen.queryByText('b.pdf')).toBeNull();
  });

  it('follows only the last folder when two pickers were opened', async () => {
    const first = folder('One', [pdf('one.pdf')]);
    const second = folder('Two', [pdf('two.pdf')]);
    offerPicker(first.handle, second.handle);
    show();
    watch();
    watch();
    await screen.findByText('Watching folder: Two');
    first.contents.current = [pdf('one.pdf'), pdf('more.pdf')];
    await tick();
    expect(screen.queryByText('more.pdf')).toBeNull();
    expect(screen.getByText('two.pdf')).toBeTruthy();
  });

  it('shows no banner for a folder without a name, and releases the timer when closed while watching', async () => {
    const dir = folder('', [pdf('a.pdf')]);
    offerPicker(dir.handle);
    const { onNotice } = show();
    watch();
    await screen.findByRole('button', { name: 'Stop Watching' });
    expect(screen.queryByText(/Watching folder/)).toBeNull();
    cleanup();
    onNotice.mockClear();
    dir.contents.current = [pdf('x.pdf')];
    await tick();
    expect(onNotice).not.toHaveBeenCalled();
  });
});
