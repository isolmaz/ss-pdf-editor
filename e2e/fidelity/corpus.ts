/**
 * The real-world half of the fidelity set: documents nobody generated for this repository.
 *
 *  - `publicSamples()` — the redistributable PDFs listed in `corpus.json`. Each entry names
 *    its URL, size, SHA-256 and the licence it may be used under (US federal government works;
 *    `licenseUrl` is the primary page that says so). They are never stored in the repository:
 *    each is downloaded once into a cache folder under `node_modules/.cache`, checked against
 *    the pinned hash (a replaced or truncated download fails loudly, naming the entry), and
 *    cut down to the pages the entry says to use.
 *  - `localSamples()` — the owner's own PDFs in `e2e/fixtures/local/`. That folder is
 *    git-ignored; those files are read from disk, labelled `local`, and never leave the machine.
 *
 * `mupdf` is a dependency of `packages/pdf-core`, not of the repository root, so it is
 * resolved from there (the same way `e2e/tool-fixture.ts` does).
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FidelitySample } from './samples';

/** One entry of `corpus.json`. */
interface CorpusEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** Lower-case hex SHA-256 of the whole downloaded file. */
  readonly sha256: string;
  /** Byte size of the whole downloaded file. */
  readonly bytes: number;
  readonly license: string;
  /** The primary page that states the licence. */
  readonly licenseUrl: string;
  readonly source: string;
  /** 0-based pages to keep, ascending; absent = all pages. */
  readonly pages?: readonly number[];
  /** True when the kept pages are an image with no text layer. */
  readonly ocr: boolean;
  /** Per-kept-page plain text, for entries whose pages are image-only. */
  readonly groundTruth?: readonly string[];
}

// ---------------------------------------------------------------------------
// the slice of MuPDF used here (the root does not declare `mupdf`)
// ---------------------------------------------------------------------------

interface MuStructuredText {
  asText(): string;
  destroy(): void;
}
interface MuPage {
  toStructuredText(options: string): MuStructuredText;
  destroy(): void;
}
interface MuDocument {
  countPages(): number;
  loadPage(index: number): MuPage;
  destroy(): void;
}
interface MuPdfDocument extends MuDocument {
  graftPage(to: number, source: MuPdfDocument, sourcePage: number): void;
  saveToBuffer(options: string): { asUint8Array(): Uint8Array; destroy(): void };
}
interface MuModule {
  readonly Document: { openDocument(bytes: Uint8Array, magic: string): MuDocument };
  readonly PDFDocument: {
    new (): MuPdfDocument;
    openDocument(bytes: Uint8Array, magic: string): { asPDF(): MuPdfDocument };
  };
}

const coreRequire = createRequire(new URL('../../packages/pdf-core/package.json', import.meta.url));

let mupdfModule: Promise<MuModule> | null = null;

/** The MuPDF module, loaded once (a failed load is not memoised). */
function loadMupdf(): Promise<MuModule> {
  mupdfModule ??= (import(pathToFileURL(coreRequire.resolve('mupdf')).href) as Promise<MuModule>).catch(
    (error: unknown) => {
      mupdfModule = null;
      throw error;
    },
  );
  return mupdfModule;
}

/** Whether any page of `bytes` carries extractable text (a text layer, even an invisible one). */
async function hasExtractableText(bytes: Uint8Array): Promise<boolean> {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  try {
    for (let index = 0; index < doc.countPages(); index += 1) {
      const page = doc.loadPage(index);
      try {
        const stext = page.toStructuredText('');
        try {
          if (/\S/u.test(stext.asText())) return true;
        } finally {
          stext.destroy();
        }
      } finally {
        page.destroy();
      }
    }
    return false;
  } finally {
    doc.destroy();
  }
}

/**
 * A new document holding only the 0-based `pages` of `bytes`, in the order given. The pages are
 * grafted with the resources they use, so the other pages' content, the structure tree and the
 * form fields do not travel (a 26-page tagged PDF would otherwise stay megabytes for one page).
 */
async function keepPages(id: string, bytes: Uint8Array, pages: readonly number[]): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const source = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  const kept = new mupdf.PDFDocument();
  try {
    const count = source.countPages();
    for (const page of pages) {
      if (!Number.isInteger(page) || page < 0 || page >= count) {
        throw new Error(`corpus sample "${id}": page ${page} is outside the document (${count} pages)`);
      }
      kept.graftPage(-1, source, page);
    }
    const saved = kept.saveToBuffer('garbage=compact,compress,objstms');
    try {
      return saved.asUint8Array().slice();
    } finally {
      saved.destroy();
    }
  } finally {
    kept.destroy();
    source.destroy();
  }
}

// ---------------------------------------------------------------------------
// public samples
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 60_000;

/** The default download cache: inside `node_modules`, so it is git-ignored and survives `git clean`. */
const DEFAULT_CACHE_DIR = fileURLToPath(
  new URL('../../node_modules/.cache/fidelity-corpus', import.meta.url),
);

/** The default folder of the owner's local PDFs (git-ignored). */
const DEFAULT_LOCAL_DIR = fileURLToPath(new URL('../fixtures/local', import.meta.url));

/** `url` fetched with a timeout and one retry. */
async function download(entry: CorpusEntry): Promise<Uint8Array> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(entry.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      failure = error;
    }
  }
  throw new Error(`corpus sample "${entry.id}": download of ${entry.url} failed: ${String(failure)}`);
}

/** The pinned file of `entry`: from the cache when it still matches, otherwise downloaded once. */
async function pinnedBytes(entry: CorpusEntry, cacheDir: string): Promise<Uint8Array> {
  const cached = join(cacheDir, `${entry.id}.pdf`);
  try {
    const bytes = new Uint8Array(await readFile(cached));
    if (
      bytes.byteLength === entry.bytes &&
      createHash('sha256').update(bytes).digest('hex') === entry.sha256
    ) {
      return bytes;
    }
  } catch {
    // not cached yet: download below
  }
  const bytes = await download(entry);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== entry.bytes || digest !== entry.sha256) {
    throw new Error(
      `corpus sample "${entry.id}": ${entry.url} no longer matches the pinned file ` +
        `(expected ${entry.bytes} bytes, sha256 ${entry.sha256}; got ${bytes.byteLength} bytes, sha256 ${digest})`,
    );
  }
  await mkdir(cacheDir, { recursive: true });
  const partial = `${cached}.${process.pid}.tmp`;
  await writeFile(partial, bytes);
  await rename(partial, cached);
  return bytes;
}

/**
 * The redistributable real-world PDFs of `corpus.json`, downloaded once into `cacheDir`
 * (default `node_modules/.cache/fidelity-corpus`), verified against their pinned SHA-256 and
 * reduced to their `pages`. Throws, naming the entry, on a download failure, a hash mismatch,
 * or an `ocr` flag that disagrees with the kept pages.
 */
export async function publicSamples(cacheDir: string = DEFAULT_CACHE_DIR): Promise<FidelitySample[]> {
  const entries = JSON.parse(
    await readFile(new URL('./corpus.json', import.meta.url), 'utf8'),
  ) as CorpusEntry[];
  return Promise.all(
    entries.map(async (entry): Promise<FidelitySample> => {
      const whole = await pinnedBytes(entry, cacheDir);
      const bytes = entry.pages === undefined ? whole : await keepPages(entry.id, whole, entry.pages);
      const textless = !(await hasExtractableText(bytes));
      if (textless !== entry.ocr) {
        throw new Error(
          `corpus sample "${entry.id}": corpus.json says ocr=${entry.ocr} but the kept pages ` +
            `${textless ? 'have no' : 'do have a'} text layer`,
        );
      }
      return {
        id: entry.id,
        title: entry.title,
        origin: 'public',
        license: entry.license,
        ocr: entry.ocr,
        bytes,
        ...(entry.groundTruth === undefined ? {} : { groundTruth: entry.groundTruth }),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// local samples
// ---------------------------------------------------------------------------

/**
 * A ground-truth file split into per-page texts. A page ends at a form feed character or at a
 * line holding only `\f`; a trailing separator does not start an empty page.
 */
function splitGroundTruth(text: string): string[] {
  const pages = text
    .replace(/\r\n?/gu, '\n')
    .split(/\f|^[ \t]*\\f[ \t]*$/mu)
    .map((page) => page.trim());
  while (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
  return pages;
}

/** A stable id from a file name: `My CV (final).pdf` -> `local-my-cv-final`. */
function localId(fileName: string): string {
  const stem = basename(fileName).replace(/\.pdf$/iu, '');
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return `local-${slug === '' ? 'pdf' : slug}`;
}

/**
 * Every `*.pdf` in `dir` (default `e2e/fixtures/local`, git-ignored) as an origin-`local`
 * sample. `ocr` is true when no page has extractable text; `groundTruth` comes from a sibling
 * `<name>.gt.txt` when present. A missing folder yields no samples.
 */
export async function localSamples(dir: string = DEFAULT_LOCAL_DIR): Promise<FidelitySample[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const pdfs = names.filter((name) => /\.pdf$/iu.test(name)).sort();
  const samples: FidelitySample[] = [];
  for (const name of pdfs) {
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    let groundTruth: string[] | undefined;
    try {
      groundTruth = splitGroundTruth(await readFile(join(dir, name.replace(/\.pdf$/iu, '.gt.txt')), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    samples.push({
      id: localId(name),
      title: name.replace(/\.pdf$/iu, ''),
      origin: 'local',
      license: 'local only, never committed',
      ocr: !(await hasExtractableText(bytes)),
      bytes,
      ...(groundTruth === undefined ? {} : { groundTruth }),
    });
  }
  return samples;
}
