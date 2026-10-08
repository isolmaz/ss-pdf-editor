/**
 * LibreOffice as the reference reader of the exported Word files: `toPdf` converts a DOCX to
 * PDF headlessly, so the result can be rendered and compared with the original page.
 *
 * The binary is `$LIBREOFFICE` when set, else `soffice` on the PATH.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 180_000;

/**
 * Two LibreOffice processes on one user profile fight over its lock and the second one
 * silently hands its job to the first, then exits. Each Playwright worker is its own process,
 * so the profile is per process; inside a worker the conversions are queued.
 */
const profileDir = join(tmpdir(), `fidelity-lo-profile-${process.pid}`);
let queue: Promise<unknown> = Promise.resolve();
let cleanupRegistered = false;

function binary(): string {
  return process.env.LIBREOFFICE?.trim() || 'soffice';
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // A profile left in the temp directory is harmless.
    }
  });
}

/**
 * LibreOffice's PDF export recompresses every picture as 90 % JPEG and caps it at 300 dpi by
 * default. What is measured is the DOCX, not that recompression, so pictures are written
 * losslessly at their own resolution. Comments (the low-confidence OCR marks) are review notes,
 * not page content, so the page is measured without them.
 */
const PDF_EXPORT =
  'pdf:writer_pdf_Export:{"UseLosslessCompression":{"type":"boolean","value":"true"},"ReduceImageResolution":{"type":"boolean","value":"false"},"ExportNotes":{"type":"boolean","value":"false"},"ExportNotesInMargin":{"type":"boolean","value":"false"}}';

function convert(docxPath: string, outDir: string): Promise<string> {
  const command = binary();
  const expected = join(outDir, `${basename(docxPath, extname(docxPath))}.pdf`);
  rmSync(expected, { force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  registerCleanup();
  const args = [
    '--headless',
    '--norestore',
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--convert-to',
    PDF_EXPORT,
    '--outdir',
    outDir,
    docxPath,
  ];
  const { promise, resolve: done, reject } = Promise.withResolvers<string>();
  execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(
          new Error(
            `LibreOffice was not found (tried "${command}"). Install it or set LIBREOFFICE to the path of soffice(.exe).`,
          ),
        );
      } else if (error.killed) {
        reject(new Error(`LibreOffice did not finish converting ${docxPath} within ${TIMEOUT_MS / 1000} s`));
      } else {
        reject(new Error(`LibreOffice failed on ${docxPath}: ${error.message}\n${stderr}`));
      }
      return;
    }
    if (!existsSync(expected)) {
      reject(new Error(`LibreOffice exited without writing ${expected}\n${stdout}\n${stderr}`));
      return;
    }
    done(expected);
  });
  return promise;
}

/** Convert `docxPath` to `<outDir>/<name>.pdf` and return that path. Conversions run one at a time. */
export function toPdf(docxPath: string, outDir: string): Promise<string> {
  const job = queue.then(() => convert(resolve(docxPath), resolve(outDir)));
  queue = job.catch(() => undefined);
  return job;
}
