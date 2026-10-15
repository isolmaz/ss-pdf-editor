/**
 * Offline capability packages and their readiness.
 *
 * The service worker caches static assets and computes readiness (`public/sw.js`); this module
 * names the *capabilities* a document needs, asks the worker for its answer and asks it to
 * fill the cache. It is the only place the shell asks “can I open this document offline”.
 *
 * ## Why a manifest instead of a substring search
 *
 * The previous readiness check asked whether *any* cached URL contained `tesseract`, so a
 * single cached OCR file stood for a complete OCR package. That is not a check, it is a
 * coincidence: it reports “ready” for a half-downloaded language pack and sends the user
 * into a failure they cannot see coming. Readiness here is a **set containment** test over
 * the exact paths the engine adapters fetch, so a missing `tur.traineddata.gz` or a missing
 * core WASM makes the capability `missing`, with the absent paths named.
 *
 * ## Why engine URLs and the manifest are versioned
 *
 * `/engines/**` is served as immutable for a year and the worker is cache-first there, so an
 * engine build that changed under an unchanged URL would be served the **old** bytes — by
 * the browser's own HTTP cache, and by the worker's `fetch` that fills its cache — under the
 * new shell: the exact mixing this module exists to prevent. An engine's URL therefore names
 * its pinned version, `/engines/<engine>/<version>/<file>` (`pdf-core`'s `assets.ts`), and the
 * manifest lists those URLs. A cached entry of another version is a different URL, which the
 * worker's containment test reports as missing instead of counting it.
 *
 * `/fonts/**` and the shell are not versioned in their URL and are not immutable
 * (`public/_headers` makes the browser revalidate them); what keeps the worker's copies of
 * them current is the manifest's identity, the release version `tools/assemble-dist.mjs`
 * stamps into the cache name, the manifest and `sw.js` alike: the package version, a digest
 * of every pinned byte, and a digest of the editor build itself (`tools/release-version.mjs`).
 * It changes with a pin *and* with a code-only deploy, so each release has a cache of its own.
 * The worker compares that identity with its own (`matchesBuild`) and answers that nothing is
 * ready while they differ: a cache written for another release is not evidence for this one.
 *
 * `offline-packages.json` is the **single** list of paths: `tools/assemble-dist.mjs` reads
 * the same file to write `dist/offline-manifest.json`. The page (`OFFLINE_CAPABILITIES`) and
 * the build each add an engine's version from `packages/pdf-core/src/engine-versions.json`,
 * which `verify-assets` holds against `tools/asset-pins.json`, so the app, the worker and the
 * build cannot drift apart.
 *
 * ## Why the editor's own code is a capability
 *
 * The editor is its own set of hashed files: the entry the page loads before the worker
 * controls it, and a chunk per tool that is fetched only when the tool is opened. Nothing
 * but a preparation caches those for a first-visit user, so a readiness that ignored them
 * said "ready" to a device that could not open a PDF offline. `app` is that set. Its names
 * exist only after the build, so its list in `offline-packages.json` is empty and the
 * build writes the real one into the manifest the worker reads; the page asks for it by
 * name, as it does every other capability.
 */

import { servedEnginePath } from 'pdf-core/assets';
import packages from './offline-packages.json';

/** The capabilities a user can prepare for offline use. */
export type OfflineCapability = 'core' | 'app' | 'pdfjs' | 'mupdf' | 'tesseract' | 'fonts';

/**
 * The capability path lists as they are shipped, with every engine file at its served,
 * versioned URL — the URLs the adapters request and the build's manifest lists. `app` is
 * empty here: the build lists the editor's own chunks in the manifest it deploys, and
 * `tools/assemble-dist.mjs` refuses an `app` list in `offline-packages.json`, so there is
 * nothing to map.
 */
export const OFFLINE_CAPABILITIES: Readonly<Record<OfflineCapability, readonly string[]>> = {
  core: packages.capabilities.core.map((path) => servedEnginePath(path)),
  app: [],
  pdfjs: packages.capabilities.pdfjs.map((path) => servedEnginePath(path)),
  mupdf: packages.capabilities.mupdf.map((path) => servedEnginePath(path)),
  tesseract: packages.capabilities.tesseract.map((path) => servedEnginePath(path)),
  fonts: packages.capabilities.fonts.map((path) => servedEnginePath(path)),
};

/** A capability is ready only when every path it needs is present in the cache. */
export interface CapabilityReadiness {
  readonly ready: boolean;
  /** The required paths that are not cached; empty exactly when `ready` is true. */
  readonly missing: readonly string[];
}

/**
 * The capabilities a document needs before it can be opened offline.
 *
 * `app` is unconditional too: opening, editing and exporting all run through the editor's
 * own chunks, and a device that holds the engines but not those cannot open anything.
 * `pdfjs` is unconditional — it is what renders every document — and so is `mupdf`: it
 * writes document properties, and the other writers are moving onto it
 * (`engines/mupdf-write.ts`), so core editing is not ready offline without it. OCR is
 * the one conditional package, and the caller decides; guessing here would either block
 * an open that would have worked or promise one that would not.
 */
export function requiredCapabilities(input: { readonly ocr: boolean }): readonly OfflineCapability[] {
  const required: OfflineCapability[] = ['core', 'app', 'pdfjs', 'mupdf', 'fonts'];
  if (input.ocr) required.push('tesseract');
  return required;
}

/**
 * The worker's answer, as the shell receives it. A reply is trusted only after it is
 * checked field by field: it arrives from another context, so it is input, not a value.
 */
export interface WorkerReadiness {
  /** The release the manifest names. */
  readonly version: string | null;
  /**
   * Whether the worker answering is the release that manifest names. A worker of an older
   * release, still serving while an update waits, reports `false` and every capability not
   * ready: its cache was filled for a build the manifest no longer describes.
   */
  readonly matchesBuild: boolean;
  readonly capabilities: Readonly<Record<string, CapabilityReadiness>>;
}

/** The worker's answer to a preparation pass. */
export interface PreparationResult {
  readonly version: string | null;
  readonly prepared: number;
  readonly failed: readonly string[];
}

function isCapabilityReadiness(value: unknown): value is CapabilityReadiness {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CapabilityReadiness>;
  return (
    typeof candidate.ready === 'boolean' &&
    Array.isArray(candidate.missing) &&
    candidate.missing.every((entry) => typeof entry === 'string')
  );
}

/** One request/response over a `MessageChannel`, with a bounded wait. */
async function askWorker<T>(
  message: Record<string, unknown>,
  read: (data: Record<string, unknown>) => T | null,
  timeoutMs = 30_000,
): Promise<T | null> {
  const worker = navigator.serviceWorker?.controller;
  if (worker === undefined || worker === null) return null;
  return await new Promise<T | null>((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timer);
      channel.port1.close();
      const data = event.data;
      if (typeof data !== 'object' || data === null) {
        resolve(null);
        return;
      }
      resolve(read(data as Record<string, unknown>));
    };
    try {
      worker.postMessage(message, [channel.port2]);
    } catch {
      clearTimeout(timer);
      channel.port1.close();
      resolve(null);
    }
  });
}

/**
 * What this build's cache holds, or `null` when there is no worker to ask.
 *
 * `null` is deliberately distinct from “nothing is ready”: the first is “this browser has
 * no service worker at all”, the second is “a cache exists and it is incomplete”. The UI
 * words them differently because they are different problems.
 */
export async function requestOfflineReadiness(): Promise<WorkerReadiness | null> {
  return await askWorker(
    { type: 'CHECK_READINESS' },
    (data) => {
      if (data.type !== 'READINESS_STATUS') return null;
      const capabilities: Record<string, CapabilityReadiness> = {};
      const raw = data.capabilities;
      if (typeof raw === 'object' && raw !== null) {
        for (const [name, value] of Object.entries(raw)) {
          if (isCapabilityReadiness(value)) capabilities[name] = value;
        }
      }
      return {
        version: typeof data.version === 'string' ? data.version : null,
        matchesBuild: data.matchesBuild === true,
        capabilities,
      };
    },
    5_000,
  );
}

/**
 * Fills the cache for the requested capabilities. `null` when the worker is unavailable
 * or did not answer; `failed` lists the paths that did not make it, so an interrupted
 * preparation is reported rather than rounded up to success.
 *
 * The worker is asked by capability name, not by URL: it resolves the names against the
 * manifest the build wrote, which is the only place the editor's own chunks (`app`) are
 * listed. When the worker fails outright, the paths this module ships name what was lost;
 * a request that is only build-listed capabilities is reported by their names.
 *
 * The shipped paths travel too, as `urls`: a worker from before the capability protocol
 * (still serving during an update window) ignores `capabilities`, and without `urls` it
 * would fetch every package, OCR's 25 MiB included. The current worker ignores `urls`.
 */
export async function prepareOffline(
  capabilities: readonly OfflineCapability[],
): Promise<PreparationResult | null> {
  const shipped = capabilities.flatMap((capability) => [...OFFLINE_CAPABILITIES[capability]]);
  const lost = shipped.length > 0 ? shipped : [...capabilities];
  return await askWorker(
    { type: 'PREPARE_PACKAGE', capabilities: [...capabilities], urls: shipped },
    (data) => {
      if (data.type === 'PREPARE_FAILED') return { version: null, prepared: 0, failed: lost };
      if (data.type !== 'PREPARE_DONE') return null;
      return {
        version: typeof data.version === 'string' ? data.version : null,
        prepared: typeof data.count === 'number' ? data.count : 0,
        failed: Array.isArray(data.failed) ? data.failed.filter((entry) => typeof entry === 'string') : [],
      };
    },
    5 * 60_000,
  );
}

/**
 * The capabilities among `wanted` whose assets are absent, for a notice that names what is
 * missing. Only what the preparation fetches is asked about: OCR is cached the first time it
 * runs, so its absence after "Prepare" is not an unfinished preparation.
 */
export function incompleteCapabilities(
  readiness: WorkerReadiness,
  wanted: readonly OfflineCapability[],
): readonly OfflineCapability[] {
  return wanted.filter((name) => readiness.capabilities[name]?.ready === false);
}
