/**
 * Offline capability packages and their readiness.
 *
 * The service worker caches static assets; this module decides what a *capability* needs
 * before it may be called ready, and it is the only place that answers “can I open this
 * document offline”.
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
 * ## Why the manifest is versioned
 *
 * `/engines/**` and `/fonts/**` are served as immutable for a year and the worker is
 * cache-first there, so a release that changes an engine build but keeps the path would be
 * served the **old** bytes under the new shell — the exact mixing this module exists to
 * prevent. The manifest therefore carries an identity: a digest over the pinned
 * `path + sha256` list plus the release stamp. A cache entry written under a different
 * identity is not evidence for this build, and the readiness answer says so instead of
 * counting it.
 *
 * `offline-packages.json` is the **single** list of paths: `tools/assemble-dist.mjs` reads
 * the same file to write `dist/offline-manifest.json` and to stamp the copied `sw.js`, so
 * the app, the worker and the build cannot drift apart. The build derives the version from
 * `tools/asset-pins.json` — the table `verify-assets` enforces — so changing a pinned asset
 * changes the cache name, the manifest and the worker together.
 */

import packages from './offline-packages.json';

/** The four capabilities a user can prepare for offline use. */
export type OfflineCapability = 'core' | 'pdfjs' | 'mupdf' | 'tesseract' | 'fonts';

export interface OfflineManifest {
  /** The release identity: the same for every asset of one build, different across builds. */
  readonly version: string;
  /** Exact same-origin paths a capability needs, in fetch order. */
  readonly capabilities: Readonly<Record<OfflineCapability, readonly string[]>>;
}

/** The capability path lists as they are shipped, before a version is attached. */
export const OFFLINE_CAPABILITIES: Readonly<Record<OfflineCapability, readonly string[]>> =
  packages.capabilities;

const CAPABILITIES: readonly OfflineCapability[] = ['core', 'pdfjs', 'mupdf', 'tesseract', 'fonts'];

/** A capability is ready only when every path it needs is present in the cache. */
export interface CapabilityReadiness {
  readonly ready: boolean;
  /** The required paths that are not cached; empty exactly when `ready` is true. */
  readonly missing: readonly string[];
}

export interface OfflineReadiness {
  /** The identity the answer was computed against. */
  readonly version: string;
  /** `false` when the cache belongs to another release: nothing may be called ready. */
  readonly matchesBuild: boolean;
  readonly capabilities: Readonly<Record<OfflineCapability, CapabilityReadiness>>;
  /** `true` only when every capability of this build is complete. */
  readonly fullyReady: boolean;
}

/**
 * The identity of one build's asset set.
 *
 * `pins` is the repository's own pin table, so the identity changes exactly when a pinned
 * asset changes — which is when the immutable-cached copy would be wrong. `stamp` is the
 * release's own version string, so two builds that happen to pin identical bytes still do
 * not share a cache identity.
 */
export function manifestVersion(
  pins: readonly { readonly path: string; readonly sha256: string }[],
  stamp: string,
): string {
  let hash = 0x811c9dc5;
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  feed(stamp);
  // Sorted, so the identity is a fact about the asset *set*, not about the pin file order.
  for (const pin of [...pins].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    feed(pin.path);
    feed(pin.sha256);
  }
  return `${stamp}-${hash.toString(16).padStart(8, '0')}`;
}

/** Every path any capability needs, de-duplicated — what a preparation pass fetches. */
export function allOfflinePaths(manifest: OfflineManifest): readonly string[] {
  const paths = new Set<string>();
  for (const capability of CAPABILITIES) {
    for (const path of manifest.capabilities[capability]) paths.add(path);
  }
  return [...paths];
}

/**
 * Whether a capability is complete, given the paths the cache actually holds.
 *
 * `cachedPaths` is a set of pathnames, and the comparison is exact: a trailing-slash
 * directory request and the file inside it are different entries, and a path the engine
 * asks for with a query string is not the same entry as the bare path.
 */
export function capabilityReadiness(
  manifest: OfflineManifest,
  capability: OfflineCapability,
  cachedPaths: ReadonlySet<string>,
): CapabilityReadiness {
  const missing = manifest.capabilities[capability].filter((path) => !cachedPaths.has(path));
  return { ready: missing.length === 0, missing };
}

/** The whole answer, including whether the cache belongs to this build at all. */
export function offlineReadiness(
  manifest: OfflineManifest,
  cachedPaths: ReadonlySet<string>,
  cachedVersion: string | null,
): OfflineReadiness {
  const matchesBuild = cachedVersion === manifest.version;
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      // A cache written by another release is not evidence for this one: an old engine
      // under a new shell is the failure this identity exists to catch.
      matchesBuild
        ? capabilityReadiness(manifest, capability, cachedPaths)
        : { ready: false, missing: manifest.capabilities[capability] },
    ]),
  ) as Record<OfflineCapability, CapabilityReadiness>;
  return {
    version: manifest.version,
    matchesBuild,
    capabilities,
    fullyReady: CAPABILITIES.every((capability) => capabilities[capability].ready),
  };
}

/**
 * The capabilities a document needs before it can be opened offline.
 *
 * `pdfjs` is unconditional — it is what renders every document — and so is `mupdf`: it
 * writes document properties, and the other writers are moving onto it
 * (`engines/mupdf-write.ts`), so core editing is not ready offline without it. OCR is
 * the one conditional package, and the caller decides; guessing here would either block
 * an open that would have worked or promise one that would not.
 */
export function requiredCapabilities(input: { readonly ocr: boolean }): readonly OfflineCapability[] {
  const required: OfflineCapability[] = ['core', 'pdfjs', 'mupdf', 'fonts'];
  if (input.ocr) required.push('tesseract');
  return required;
}

/**
 * The worker's answer, as the shell receives it. A reply is trusted only after it is
 * checked field by field: it arrives from another context, so it is input, not a value.
 */
export interface WorkerReadiness {
  readonly version: string | null;
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
 */
export async function prepareOffline(
  capabilities: readonly OfflineCapability[],
): Promise<PreparationResult | null> {
  const manifest = { version: '', capabilities: OFFLINE_CAPABILITIES };
  const urls = capabilities.flatMap((capability) => [...manifest.capabilities[capability]]);
  return await askWorker(
    { type: 'PREPARE_PACKAGE', urls },
    (data) => {
      if (data.type === 'PREPARE_FAILED') return { version: null, prepared: 0, failed: urls };
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

/** The capabilities whose assets are absent, for a notice that names what is missing. */
export function incompleteCapabilities(readiness: WorkerReadiness): readonly string[] {
  return Object.entries(readiness.capabilities)
    .filter(([, value]) => !value.ready)
    .map(([name]) => name);
}
