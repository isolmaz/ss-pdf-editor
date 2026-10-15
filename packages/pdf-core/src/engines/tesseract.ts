/**
 * Tesseract adapter: the only place that
 * talks to `tesseract.js`.
 *
 * **Zero network beyond our origin.** `tesseract.js` defaults every asset to a
 * jsDelivr CDN URL (`src/worker/browser/defaultOptions.js` → `workerPath`,
 * `src/worker-script/index.js:130` → `langPath`). All three are therefore passed
 * explicitly from `TESSERACT_ASSETS`, and `corePath` ends in `js` so the worker
 * loads exactly the file we pinned instead of probing directory variants
 * (`src/worker-script/browser/getCore.js:21`). A CDN fetch would be both a
 * privacy leak and an offline failure.
 *
 * The module, the worker and the wasm core are all downloaded on first use —
 * nothing of this reaches the first-paint bundle.
 *
 * Cancellation is a real `worker.terminate()`: a recognize() call is
 * synchronous inside the wasm core and cannot be interrupted from outside, so the
 * only honest cancel is to drop the worker (and the wasm heap with it) and rethrow
 * an `AbortError` for the caller to map onto the `aborted` error code.
 */

import { ToolError, toToolError } from 'pdf-shared';
import type { LoggerMessage, Page, Worker as TesseractWorker } from 'tesseract.js';
import { TESSERACT_ASSETS } from '../assets';
import { throwIfAborted } from '../ops/types';

/** A reading of a word: the text and how sure (0–100) the engine was of it. */
export type OcrReading = {
  readonly text: string;
  readonly confidence: number;
};

export type OcrWord = {
  readonly text: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly confidence: number;
  /**
   * Where tesseract put the word, as running indices over the page (page-unique, in reading
   * order): its block, its paragraph and its text line. Absent on words that did not come from
   * `recognizePage`.
   */
  readonly block?: number;
  readonly paragraph?: number;
  readonly line?: number;
  /** The font size the word was written with (page points), for words read from a text layer: its box is the em box, not ink. */
  readonly size?: number;
  /** The baseline of the word's line in page points, when tesseract found one. */
  readonly baseline?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** The other readings of the word the second look saw (the first read, a reread that was not adopted), each with the confidence it was read at: the ink decides between them and `text` (`ocr-font-match.ts`). */
  readonly alternatives?: readonly OcrReading[];
};

/**
 * Every language pack the build serves (tesseract's codes). Turkish and English ship both
 * models and are cached for offline use with the OCR package; the others ship the
 * integerized "best" model only and are fetched from this origin the first time they are
 * used (the service worker keeps them after that). The `4.0.0` packs also carry the legacy
 * engine's data, which the LSTM-only worker never reads: for Chinese it is 27 MB, more than
 * the 25 MiB a deployed asset may be, and over the extra languages it would add ~190 MB
 * the worker cannot use.
 */
export const OCR_LANGUAGE_CODES_ALL = [
  'tur',
  'eng',
  'deu',
  'fra',
  'spa',
  'ita',
  'por',
  'nld',
  'pol',
  'ces',
  'hun',
  'ron',
  'swe',
  'aze',
  'kmr',
  'rus',
  'ukr',
  'bul',
  'ell',
  'ara',
  'fas',
  'heb',
  'hin',
  'chi_sim',
  'chi_tra',
  'jpn',
  'kor',
] as const;
export type OcrLanguageCode = (typeof OCR_LANGUAGE_CODES_ALL)[number];
export type OcrQuality = 'fast' | 'best';

/** The languages that ship the `fast` model too. */
const FAST_LANGUAGES: ReadonlySet<OcrLanguageCode> = new Set(['tur', 'eng']);

/**
 * The quality a run can have: `fast` only when every language has a fast model, since one
 * worker loads every language from one directory. Otherwise the run uses `best`.
 */
export function effectiveOcrQuality(languages: readonly OcrLanguageCode[], quality: OcrQuality): OcrQuality {
  return quality === 'fast' && languages.some((language) => !FAST_LANGUAGES.has(language)) ? 'best' : quality;
}

export interface RecognizeInput {
  /**
   * Segment the page automatically (the engine's mode 3: columns, blocks, lines) instead of as
   * one block (its default, 6). The exact-layout Word export reads scans so.
   */
  readonly automaticLayout?: boolean;
  readonly image: Blob;
  /** pixels per PDF point (dpi/72) — converts the returned boxes back to page points */
  readonly scale: number;
  readonly languages: readonly OcrLanguageCode[];
  readonly quality: OcrQuality;
  readonly signal: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
}

export interface RecognizeResult {
  readonly words: readonly OcrWord[];
  readonly confidence: number;
}

type TesseractModule = typeof import('tesseract.js');

let tesseractModule: Promise<TesseractModule> | null = null;

/**
 * The engine comes from our own pinned asset, not from the bundle. That is the
 * same rule the worker, the core and the language packs already follow, and it is
 * what keeps this module's module-scope order intact: bundled, tesseract's own
 * `logger` throws `Cannot access 'i' before initialization` on every OCR run in
 * the production build (the unminified build is clean, so it is a bundling
 * artefact, not an engine defect). The ESM build's only export is the module
 * object as `default`.
 *
 * A **failed** import is not cached: a dropped connection while the engine chunk
 * loads would otherwise make every later OCR run fail for the session.
 */
export function loadTesseract(): Promise<TesseractModule> {
  if (tesseractModule !== null) return tesseractModule;
  const attempt = import(/* @vite-ignore */ TESSERACT_ASSETS.module).then(
    (module: { readonly default?: TesseractModule }) => module.default ?? (module as TesseractModule),
  );
  tesseractModule = attempt;
  // Until this runs the slot holds `attempt` (a caller in between is handed `attempt`, never a
  // new load), so clearing it unconditionally cannot discard a newer in-flight attempt.
  attempt.catch(() => {
    tesseractModule = null;
  });
  return attempt;
}

/** `.../lang/fast/tur.traineddata.gz` — the pinned layout, one directory per quality. */
export function tesseractLanguageUrl(code: OcrLanguageCode, quality: OcrQuality): string {
  const directory = quality === 'fast' ? TESSERACT_ASSETS.fastLangPath : TESSERACT_ASSETS.bestLangPath;
  return `${directory}/${code}.traineddata.gz`;
}

/**
 * A pool of workers per language set + quality, kept between pages: worker startup, the
 * 2.9 MiB wasm core instantiation and the traineddata load dominate a single page's
 * cost, so paying them per page would make a 20-page scan unusable. The cache is
 * keyed by what the worker was initialized with — a worker is not re-initializable
 * cheaply, and mixing language sets in one worker would silently degrade accuracy.
 * A worker reads one thing at a time (a caller leases it, and gives it back): the pool
 * holds one worker, or as many as its claims allow to read pages side by side.
 *
 * The pools are shared by whatever runs: two operations that read with the same language set
 * share its workers. So a pool is owned by the operations that **claimed** it
 * (`claimOcrWorkers`), and it is closed when the last of them lets go: an operation that
 * finishes takes back only the pools nobody else still holds, never a worker another
 * operation is reading with.
 */
interface WorkerEntry {
  readonly pool: Pool;
  /**
   * Filled in after the entry object exists — `createWorker` reports progress while
   * it is still resolving, so the logger needs a reachable entry before the worker
   * does (see `createWorkerEntry`).
   */
  worker: TesseractWorker;
  /** Per-call sink of whichever `recognizePage` currently holds the worker. */
  onProgress: ((fraction: number) => void) | undefined;
}

interface Pool {
  readonly key: string;
  /** Started workers, leased or idle. */
  readonly workers: Set<WorkerEntry>;
  readonly starting: Set<Promise<WorkerEntry>>;
  readonly idle: WorkerEntry[];
  /** Callers that found every worker busy and the pool full: each is woken when a worker is given back or lost. */
  readonly waiting: Array<() => void>;
  /** The operations holding the pool, each with the number of workers it asked to read pages side by side. */
  readonly claims: Map<OcrWorkerClaim, number>;
  closed: boolean;
}

/** At most this many workers of a language set: each holds a wasm heap with the language models. */
const MAX_POOL = 3;
/** Machines reporting less memory (GiB, `navigator.deviceMemory`) than this read with one worker. */
const MIN_MEMORY_FOR_POOL = 4;
/**
 * How long one read may take before its worker is taken for dead. A read is a synchronous run of
 * the wasm core, so a worker whose thread died answers nothing at all, and without a bound the
 * page would wait for it for ever. It is far above the slowest honest read (a dense page, three
 * `best` models, a slow phone); the reader's own cancel ends a read sooner.
 */
export const OCR_READ_TIMEOUT_MS = 10 * 60_000;

const pools = new Map<string, Pool>();

/** One language set at one quality an operation is going to read with, and how many workers it may use at once. */
export interface OcrWorkerRequest {
  readonly languages: readonly OcrLanguageCode[];
  readonly quality: OcrQuality;
  /** Workers reading pages side by side, 1 to 3 (`MAX_POOL`); one by default. */
  readonly workers?: number;
}

/** An operation's hold on the pools it reads with. */
export interface OcrWorkerClaim {
  /**
   * Let go of every pool this claim holds. A pool nobody else holds is closed: its workers are
   * terminated, and the promise resolves once their memory is back. A pool another operation
   * still holds stays as it is. Calling it again does nothing.
   */
  release(): Promise<void>;
}

/**
 * Hold the pools of `requests` for one operation (an OCR run, a Word export) until its `release`.
 * A pool lets as many workers read pages side by side as the largest request of its holders asks
 * for; a language set nobody asked about has one (the second look's English alone).
 */
export function claimOcrWorkers(requests: readonly OcrWorkerRequest[]): OcrWorkerClaim {
  const held = new Set<Pool>();
  let released: Promise<void> | undefined;
  const claim: OcrWorkerClaim = {
    release: () => {
      released ??= Promise.all(
        [...held].map(async (pool) => {
          pool.claims.delete(claim);
          if (pool.claims.size === 0) await closePool(pool);
        }),
      ).then(() => undefined);
      return released;
    },
  };
  for (const { languages, quality, workers } of requests) {
    const pool = poolOf(languages, quality);
    const asked = Math.max(1, Math.min(MAX_POOL, Math.floor(workers ?? 1)));
    pool.claims.set(claim, Math.max(asked, pool.claims.get(claim) ?? 1));
    held.add(pool);
  }
  return claim;
}

function poolOf(languages: readonly OcrLanguageCode[], quality: OcrQuality): Pool {
  const key = workerKey(languages, quality);
  let pool = pools.get(key);
  if (pool === undefined) {
    pool = {
      key,
      workers: new Set(),
      starting: new Set(),
      idle: [],
      waiting: [],
      claims: new Map(),
      closed: false,
    };
    pools.set(key, pool);
  }
  return pool;
}

/**
 * How many workers this machine reads pages with side by side: one per core but one, at most 3
 * (each holds a wasm heap with the language models), at least 1; one on a machine that reports
 * less than 4 GiB of memory — and on one that does not report it at all. `navigator.deviceMemory`
 * is a Chromium API: Firefox, Safari and every iOS browser leave it undefined, and those are
 * exactly the devices where three wasm heaps with the language models get the tab killed, while
 * one worker is only slower. An unknown amount of memory is therefore taken for a small one.
 */
export function suggestedOcrWorkers(): number {
  const { hardwareConcurrency, deviceMemory } =
    (globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator ?? {};
  if (typeof deviceMemory !== 'number' || !(deviceMemory >= MIN_MEMORY_FOR_POOL)) return 1;
  return Math.max(1, Math.min(MAX_POOL, (hardwareConcurrency ?? 1) - 1));
}

function workerKey(languages: readonly OcrLanguageCode[], quality: OcrQuality): string {
  return `${quality}|${[...languages].sort().join('+')}`;
}

/**
 * `status: 'recognizing text'` is the only phase whose `progress` is the page's own
 * 0..1 prediction (the other statuses report asset loading). Forwarding the rest
 * would make the caller's bar jump backwards when a second language loads.
 */
function forwardProgress(message: LoggerMessage, onProgress: ((fraction: number) => void) | undefined): void {
  if (onProgress === undefined) return;
  if (message.status !== 'recognizing text') return;
  if (!Number.isFinite(message.progress)) return;
  onProgress(Math.min(1, Math.max(0, message.progress)));
}

function abortError(): Error {
  const error = new Error('OCR aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Settle with whichever comes first: the engine's answer, the abort, or `OCR_READ_TIMEOUT_MS`
 * (a `timeout` error: the worker is taken for dead). A late rejection of `work` is swallowed by
 * the already-settled promise, so terminating a worker mid-recognition cannot surface as an
 * unhandled rejection.
 */
async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      settle();
      reject(
        new ToolError('timeout', {
          engine: 'tesseract',
          engineMessage: `the worker did not answer within ${OCR_READ_TIMEOUT_MS / 1000} s`,
        }),
      );
    }, OCR_READ_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

async function createWorkerEntry(
  pool: Pool,
  languages: readonly OcrLanguageCode[],
  quality: OcrQuality,
): Promise<WorkerEntry> {
  const tesseract = await loadTesseract();
  /**
   * The entry exists *before* the worker is created, and its `worker` is filled in
   * afterwards. It has to: tesseract reports progress ("initializing tesseract",
   * "loading language traineddata") **while `createWorker` is still resolving**, so
   * a `logger` that read the binding being initialised threw
   * `Cannot access 'entry' before initialization` on every run — an error the user
   * never saw, but one that made OCR log a page error each time.
   */
  const entry: WorkerEntry = { pool, onProgress: undefined, worker: undefined as unknown as TesseractWorker };
  entry.worker = await tesseract.createWorker([...languages], undefined, {
    workerPath: TESSERACT_ASSETS.worker,
    corePath: TESSERACT_ASSETS.core,
    langPath: quality === 'fast' ? TESSERACT_ASSETS.fastLangPath : TESSERACT_ASSETS.bestLangPath,
    gzip: true,
    logger: (message) => forwardProgress(message, entry.onProgress),
  });
  return entry;
}

function wake(pool: Pool): void {
  pool.waiting.shift()?.();
}

/** Resumes when `wake` reaches the caller (the queue is first come, first served), or throws when `signal` aborts first — and then the caller is no longer in the queue to swallow a wake meant for the next one. */
async function waitForWorker(pool: Pool, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const resume = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      pool.waiting.splice(pool.waiting.indexOf(resume), 1);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pool.waiting.push(resume);
  });
}

/** A worker of the pool, started if it has room, else the next one given back; the caller has it to itself until `giveBack`. */
async function acquireWorker(
  languages: readonly OcrLanguageCode[],
  quality: OcrQuality,
  signal: AbortSignal,
): Promise<WorkerEntry> {
  const pool = poolOf(languages, quality);
  for (;;) {
    const idle = pool.idle.pop();
    if (idle !== undefined) return idle;
    // The room the claims ask for: the largest request of the operations holding the pool, one if none does.
    if (pool.workers.size + pool.starting.size < Math.max(1, ...pool.claims.values())) {
      const pending = createWorkerEntry(pool, languages, quality);
      pool.starting.add(pending);
      try {
        const entry = await pending;
        pool.workers.add(entry);
        return entry;
      } finally {
        // A failed start (missing asset, worker crash) frees its place: the next caller starts again.
        pool.starting.delete(pending);
        wake(pool);
      }
    }
    await waitForWorker(pool, signal);
    if (pool.closed) throw abortError();
  }
}

/** The worker is free for the next caller. */
function giveBack(entry: WorkerEntry): void {
  const { pool } = entry;
  if (!pool.workers.has(entry)) return;
  entry.onProgress = undefined;
  pool.idle.push(entry);
  wake(pool);
}

/** Terminate a worker and forget it (the abort of its caller, a read that failed); a waiting caller takes its place. */
async function releaseWorker(entry: WorkerEntry): Promise<void> {
  entry.onProgress = undefined;
  const { pool } = entry;
  pool.workers.delete(entry);
  wake(pool);
  try {
    await entry.worker.terminate();
  } catch {
    // Terminating a worker that already died (abort raced a crash) is expected
    // control flow; the wasm heap is gone either way.
  }
}

/** Close a pool whoever holds it: its waiting callers are sent away, its workers terminated and forgotten. */
async function closePool(pool: Pool): Promise<void> {
  pool.closed = true;
  if (pools.get(pool.key) === pool) pools.delete(pool.key);
  for (const resume of pool.waiting.splice(0)) resume();
  // Workers still starting are waited for, then terminated with the rest.
  await Promise.allSettled(pool.starting);
  await Promise.all(
    [...pool.workers].map(async (entry) => {
      // Awaited, not fired and forgotten: `terminate()` resolves once the worker's wasm
      // heap is actually released, and an OCR operation's caller treats the resolution of
      // its claim's `release` as “the memory is back”. Returning early made that a lie.
      await entry.worker.terminate().catch(() => undefined);
    }),
  );
  pool.workers.clear();
  pool.idle.length = 0;
}

/**
 * Drop every pool, whatever claims it — the reset of a test run or a shutdown. An operation
 * does not call this: it lets go of its own share through its claim (`claimOcrWorkers`), which
 * leaves the pools other operations still hold alone.
 */
export async function terminateOcrWorkers(): Promise<void> {
  await Promise.all([...pools.values()].map(closePool));
}

/**
 * Recognize one rendered page image.
 *
 * Returned boxes are divided by `scale`, so they come back in **page points of the
 * rendered image** (origin top-left, y down — tesseract's own orientation). The
 * caller maps them onto the page: the rendered image carries the page's rotation,
 * so a rotated page lands in user space through the viewport transform
 * (`ops/ocr.ts`, which owns that conversion).
 */
export async function recognizePage(input: RecognizeInput): Promise<RecognizeResult> {
  throwIfAborted(input.signal);
  if (input.languages.length === 0) {
    throw new ToolError('unsupported', {
      engine: 'tesseract',
      engineMessage: 'no OCR language selected',
    });
  }
  let entry: WorkerEntry;
  try {
    entry = await acquireWorker(input.languages, input.quality, input.signal);
  } catch (error) {
    // The start is where a missing core, language pack or worker script fails; those are the
    // messages `TESSERACT_ERROR_CODES` names, so they have to reach it.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapTesseractError(error, 'start');
  }
  if (input.signal.aborted) {
    giveBack(entry);
    throw abortError();
  }

  entry.onProgress = input.onProgress;
  return await readOn(entry, input.signal, async () => {
    const read = () =>
      entry.worker.recognize(
        input.image,
        {},
        // Blocks are the only output carrying word boxes; text/hocr/tsv would each
        // serialize the whole page again for nothing.
        { blocks: true, text: false, hocr: false, tsv: false },
      );
    const result = await (input.automaticLayout === true ? inMode(entry.worker, PSM_AUTO, read) : read());
    return {
      words: collectWords(result.data, input.scale),
      confidence: result.data.confidence,
    };
  });
}

/**
 * Run `work` on the worker the caller leased, and give it back — unless it can no longer be trusted.
 *
 * `recognize` runs synchronously inside the wasm core, so it cannot be interrupted from the
 * outside; the race makes the *caller* return an AbortError immediately once the worker has been
 * terminated, instead of waiting for a worker that will never answer again. It also bounds the
 * wait: a worker whose thread died answers nothing, and `OCR_READ_TIMEOUT_MS` ends that read.
 *
 * A read that fails for any reason but the caller's abort leaves the worker in an unknown state
 * (a crashed wasm heap, a thread that is gone). It is terminated and forgotten rather than given
 * back, so the next page starts a fresh worker instead of failing on a dead one.
 */
async function readOn<T>(entry: WorkerEntry, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const onAbort = () => {
    void releaseWorker(entry);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await raceWithAbort(work(), signal);
  } catch (error) {
    if (signal.aborted) throw abortError();
    await releaseWorker(entry);
    throw mapTesseractError(error, 'recognize');
  } finally {
    signal.removeEventListener('abort', onAbort);
    giveBack(entry);
  }
}

export interface RecognizeWordInput {
  /** A tight, upscaled crop of one word. */
  readonly image: Blob;
  readonly languages: readonly OcrLanguageCode[];
  readonly quality: OcrQuality;
  readonly signal: AbortSignal;
}

/** The page segmentation modes of the engine's `tessedit_pageseg_mode`: a worker starts in `SINGLE_BLOCK`, which page reads rely on. */
const PSM_AUTO = '3';
const PSM_SINGLE_BLOCK = '6';
const PSM_SINGLE_WORD = '8';

/** `work` with the worker in segmentation `mode`; the default mode is put back whatever happens, since the worker is shared by every page. */
async function inMode<T>(worker: TesseractWorker, mode: string, work: () => Promise<T>): Promise<T> {
  await worker.setParameters({ tessedit_pageseg_mode: mode as never });
  try {
    return await work();
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: PSM_SINGLE_BLOCK as never });
  }
}

/**
 * Read one cropped word as a word (single-word page segmentation) with the given languages.
 * The worker is one of those page reads share, so the mode is put back afterwards. `null` when
 * the crop holds no text.
 */
export async function recognizeWord(
  input: RecognizeWordInput,
): Promise<{ text: string; confidence: number } | null> {
  throwIfAborted(input.signal);
  let entry: WorkerEntry;
  try {
    entry = await acquireWorker(input.languages, input.quality, input.signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapTesseractError(error, 'start');
  }
  if (input.signal.aborted) {
    giveBack(entry);
    throw abortError();
  }
  return await readOn(entry, input.signal, () =>
    inMode(entry.worker, PSM_SINGLE_WORD, async () => {
      const result = await entry.worker.recognize(
        input.image,
        {},
        { blocks: false, text: true, hocr: false, tsv: false },
      );
      const text = result.data.text.trim();
      return text.length === 0 ? null : { text, confidence: result.data.confidence };
    }),
  );
}

function collectWords(page: Page, scale: number): OcrWord[] {
  const words: OcrWord[] = [];
  let paragraphIndex = 0;
  let lineIndex = 0;
  for (const [blockIndex, block] of (page.blocks ?? []).entries()) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const found = line.baseline?.has_baseline === true ? line.baseline : undefined;
        const baseline =
          found === undefined
            ? undefined
            : { x0: found.x0 / scale, y0: found.y0 / scale, x1: found.x1 / scale, y1: found.y1 / scale };
        for (const word of line.words) {
          const text = word.text.trim();
          // Whitespace-only "words" carry no box worth writing and would add empty
          // entries to the invisible layer.
          if (text.length === 0) continue;
          words.push({
            text,
            x0: word.bbox.x0 / scale,
            y0: word.bbox.y0 / scale,
            x1: word.bbox.x1 / scale,
            y1: word.bbox.y1 / scale,
            confidence: word.confidence,
            block: blockIndex,
            paragraph: paragraphIndex,
            line: lineIndex,
            ...(baseline === undefined ? {} : { baseline }),
          });
        }
        lineIndex += 1;
      }
      paragraphIndex += 1;
    }
  }
  return words;
}

const TESSERACT_ERROR_CODES: readonly (readonly [RegExp, ToolError['code']])[] = [
  [
    /failed to load tesseractcore|failed to load language|traineddata|language.*not.*(found|load)/i,
    'ocr-language-missing',
  ],
  [/failed to fetch|networkerror|load failed|404|not found/i, 'asset-missing'],
  [/out of memory|abort\(|memory/i, 'out-of-memory'],
];

export function mapTesseractError(error: unknown, context: string): ToolError {
  if (error instanceof ToolError) return error;
  const raw = error instanceof Error ? error.message : String(error);
  const engineMessage = `${context}: ${raw}`;
  for (const [pattern, code] of TESSERACT_ERROR_CODES) {
    if (pattern.test(raw)) {
      return new ToolError(code, { engine: 'tesseract', engineMessage }, { cause: error });
    }
  }
  return toToolError(new Error(engineMessage), 'tesseract');
}

/**
 * Availability probe for the offline readiness screen: a GET request to the exact pinned
 * path, of which only the status is read. It reports what the browser can actually reach,
 * which is the question the screen asks; a network failure is an answer ("not
 * available"), not an error to surface.
 *
 * It is a GET and not a HEAD because the service worker answers GETs only
 * (`public/sw.js` `isCacheable`): a HEAD goes straight to the network, so a pack the device
 * holds in the worker's cache was reported missing offline and the run was refused as
 * `ocr-language-missing`. The pack is a multi-megabyte model the worker downloads for itself
 * when it starts, so the body is cancelled unread as soon as the status is known.
 */
export async function isOcrLanguageAvailable(code: OcrLanguageCode, quality: OcrQuality): Promise<boolean> {
  try {
    const response = await fetch(tesseractLanguageUrl(code, quality), { method: 'GET' });
    const available = response.ok;
    await response.body?.cancel().catch(() => undefined);
    return available;
  } catch {
    // Offline or blocked: the language is not available right now.
    return false;
  }
}
