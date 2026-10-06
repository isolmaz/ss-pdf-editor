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

export type OcrWord = {
  readonly text: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly confidence: number;
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
 * loads would otherwise make every later OCR run fail for the session. The slot is
 * cleared only while it still holds the attempt that failed — a blanket clear
 * would throw away a newer in-flight load.
 */
export function loadTesseract(): Promise<TesseractModule> {
  if (tesseractModule !== null) return tesseractModule;
  const attempt = import(/* @vite-ignore */ TESSERACT_ASSETS.module).then(
    (module: { readonly default?: TesseractModule }) => module.default ?? (module as TesseractModule),
  );
  tesseractModule = attempt;
  attempt.catch(() => {
    if (tesseractModule === attempt) tesseractModule = null;
  });
  return attempt;
}

/** `.../lang/fast/tur.traineddata.gz` — the pinned layout, one directory per quality. */
export function tesseractLanguageUrl(code: OcrLanguageCode, quality: OcrQuality): string {
  const directory = quality === 'fast' ? TESSERACT_ASSETS.fastLangPath : TESSERACT_ASSETS.bestLangPath;
  return `${directory}/${code}.traineddata.gz`;
}

/**
 * One worker per language set + quality, kept between pages: worker startup, the
 * 2.9 MiB wasm core instantiation and the traineddata load dominate a single page's
 * cost, so paying them per page would make a 20-page scan unusable. The cache is
 * keyed by what the worker was initialized with — a worker is not re-initializable
 * cheaply, and mixing language sets in one worker would silently degrade accuracy.
 */
interface WorkerEntry {
  readonly key: string;
  /**
   * Filled in after the entry object exists — `createWorker` reports progress while
   * it is still resolving, so the logger needs a reachable entry before the worker
   * does (see `createWorkerEntry`).
   */
  worker: TesseractWorker;
  /** Per-call sink, replaced by whichever `recognizePage` currently owns the worker. */
  onProgress: ((fraction: number) => void) | undefined;
}

const workers = new Map<string, Promise<WorkerEntry>>();

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
 * Settle with whichever comes first: the engine's answer or the abort. A late
 * rejection of `work` is swallowed by the already-settled promise, so terminating a
 * worker mid-recognition cannot surface as an unhandled rejection.
 */
async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function createWorkerEntry(
  languages: readonly OcrLanguageCode[],
  quality: OcrQuality,
): Promise<WorkerEntry> {
  const tesseract = await loadTesseract();
  const key = workerKey(languages, quality);
  /**
   * The entry exists *before* the worker is created, and its `worker` is filled in
   * afterwards. It has to: tesseract reports progress ("initializing tesseract",
   * "loading language traineddata") **while `createWorker` is still resolving**, so
   * a `logger` that read the binding being initialised threw
   * `Cannot access 'entry' before initialization` on every run — an error the user
   * never saw, but one that made OCR log a page error each time.
   */
  const entry: WorkerEntry = { key, onProgress: undefined, worker: undefined as unknown as TesseractWorker };
  entry.worker = await tesseract.createWorker([...languages], undefined, {
    workerPath: TESSERACT_ASSETS.worker,
    corePath: TESSERACT_ASSETS.core,
    langPath: quality === 'fast' ? TESSERACT_ASSETS.fastLangPath : TESSERACT_ASSETS.bestLangPath,
    gzip: true,
    logger: (message) => forwardProgress(message, entry.onProgress),
  });
  return entry;
}

async function acquireWorker(
  languages: readonly OcrLanguageCode[],
  quality: OcrQuality,
): Promise<WorkerEntry> {
  const key = workerKey(languages, quality);
  const cached = workers.get(key);
  if (cached !== undefined) {
    // A failed start (missing asset, worker crash) must not poison the cache.
    try {
      return await cached;
    } catch (error) {
      workers.delete(key);
      throw error;
    }
  }
  const pending = createWorkerEntry(languages, quality);
  workers.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    workers.delete(key);
    throw error;
  }
}

async function releaseWorker(entry: WorkerEntry): Promise<void> {
  workers.delete(entry.key);
  entry.onProgress = undefined;
  try {
    await entry.worker.terminate();
  } catch {
    // Terminating a worker that already died (abort raced a crash) is expected
    // control flow; the wasm heap is gone either way.
  }
}

/** Drop every cached worker — the operation's cleanup step. */
export async function terminateOcrWorkers(): Promise<void> {
  const pending = [...workers.values()];
  workers.clear();
  await Promise.all(
    pending.map(async (entry) => {
      try {
        // Awaited, not fired and forgotten: `terminate()` resolves once the worker's wasm
        // heap is actually released, and an OCR operation's caller treats this function's
        // resolution as “the memory is back”. Returning early made that a lie.
        await (await entry).worker.terminate().catch(() => undefined);
      } catch {
        // Never-started worker: nothing to terminate.
      }
    }),
  );
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
  const entry = await acquireWorker(input.languages, input.quality);
  throwIfAborted(input.signal);

  entry.onProgress = input.onProgress;
  const onAbort = () => {
    void releaseWorker(entry);
  };
  input.signal.addEventListener('abort', onAbort, { once: true });
  try {
    // `recognize` runs synchronously inside the wasm core, so it cannot be
    // interrupted from the outside; the race makes the *caller* return an AbortError
    // immediately once the worker has been terminated, instead of waiting for a
    // worker that will never answer again.
    const result = await raceWithAbort(
      entry.worker.recognize(
        input.image,
        {},
        // Blocks are the only output carrying word boxes; text/hocr/tsv would each
        // serialize the whole page again for nothing.
        { blocks: true, text: false, hocr: false, tsv: false },
      ),
      input.signal,
    );
    if (input.signal.aborted) throw abortError();
    return {
      words: collectWords(result.data, input.scale),
      confidence: result.data.confidence,
    };
  } catch (error) {
    if (input.signal.aborted) throw abortError();
    throw mapTesseractError(error, 'recognize');
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    if (entry.onProgress === input.onProgress) entry.onProgress = undefined;
  }
}

function collectWords(page: Page, scale: number): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
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
          });
        }
      }
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
 * Availability probe for the offline readiness screen: a HEAD
 * request to the exact pinned path. It reports what the browser can actually reach,
 * which is the question the screen asks; a network failure is an answer ("not
 * available"), not an error to surface.
 */
export async function isOcrLanguageAvailable(code: OcrLanguageCode, quality: OcrQuality): Promise<boolean> {
  try {
    const response = await fetch(tesseractLanguageUrl(code, quality), { method: 'HEAD' });
    return response.ok;
  } catch {
    // Offline or blocked: the language is not available right now.
    return false;
  }
}
