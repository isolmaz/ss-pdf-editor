/**
 * Offline readiness and preparation, against the failures that make it lie.
 *
 * The cases worth testing are the ones the previous implementation got wrong: a partially
 * cached capability reported as ready, and a cache from another release counted as
 * evidence for this one. Both are silent — the user only finds out when the feature fails
 * with no network to fall back on.
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfflineCapability, WorkerReadiness } from './offline';
import {
  allOfflinePaths,
  capabilityReadiness,
  incompleteCapabilities,
  manifestVersion,
  OFFLINE_CAPABILITIES,
  offlineReadiness,
  prepareOffline,
  requestOfflineReadiness,
  requiredCapabilities,
} from './offline';

const PINS = [
  { path: 'engines/pdfjs/pdf.worker.mjs', sha256: 'aa' },
  { path: 'engines/mupdf/mupdf-wasm.wasm', sha256: 'bb' },
];
const VERSION = manifestVersion(PINS, '1.2.3');

function manifest(capabilities: Partial<Record<OfflineCapability, readonly string[]>> = {}) {
  return {
    version: VERSION,
    capabilities: {
      core: ['/editor/'],
      pdfjs: ['/engines/pdfjs/pdf.worker.mjs'],
      mupdf: ['/engines/mupdf/mupdf-wasm.wasm', '/engines/mupdf/mupdf.js'],
      tesseract: ['/engines/tesseract/worker.min.js', '/engines/tesseract/lang/fast/tur.traineddata.gz'],
      fonts: ['/fonts/noto/NotoSans-Regular.ttf'],
      ...capabilities,
    },
  };
}

describe('manifestVersion', () => {
  it('changes when a pinned asset changes, and when the release stamp changes', () => {
    const base = manifestVersion(PINS, '1.2.3');
    expect(base).toBe(VERSION);
    // A rebuilt engine under the same path must not reuse the cache identity: the path is
    // immutable-cached for a year, so identical identity would serve the old bytes.
    expect(
      manifestVersion([{ path: PINS[0]?.path ?? '', sha256: 'cc' }, ...PINS.slice(1)], '1.2.3'),
    ).not.toBe(base);
    expect(manifestVersion(PINS, '1.2.4')).not.toBe(base);
    // The stamp is also the visible prefix of the identity, so comparing whole strings
    // cannot show that it is *hashed*: two builds with the same pins and different stamps
    // must differ in the digest too, or the digest says nothing about the release.
    const digest = (version: string) => version.slice(version.lastIndexOf('-') + 1);
    expect(digest(manifestVersion(PINS, '1.2.4'))).not.toBe(digest(base));
    // Order in the pin file is not a fact about the assets.
    expect(manifestVersion([...PINS].reverse(), '1.2.3')).toBe(base);
  });
});

describe('capabilityReadiness', () => {
  it('is ready only when every required path is present', () => {
    const cached = new Set(['/engines/mupdf/mupdf-wasm.wasm', '/engines/mupdf/mupdf.js']);
    expect(capabilityReadiness(manifest(), 'mupdf', cached)).toEqual({ ready: true, missing: [] });
    // The old check would have called this ready: one file whose URL contains "mupdf".
    expect(capabilityReadiness(manifest(), 'mupdf', new Set(['/engines/mupdf/mupdf-wasm.wasm']))).toEqual({
      ready: false,
      missing: ['/engines/mupdf/mupdf.js'],
    });
  });

  it('does not accept a different file of the same engine as a stand-in', () => {
    const half = new Set(['/engines/tesseract/worker.min.js']);
    expect(capabilityReadiness(manifest(), 'tesseract', half)).toEqual({
      ready: false,
      missing: ['/engines/tesseract/lang/fast/tur.traineddata.gz'],
    });
  });

  it('compares paths exactly, so a directory request is not the file inside it', () => {
    expect(capabilityReadiness(manifest(), 'core', new Set(['/editor']))).toEqual({
      ready: false,
      missing: ['/editor/'],
    });
  });
});

describe('offlineReadiness', () => {
  it('calls a complete cache of this build fully ready', () => {
    const cached = new Set(allOfflinePaths(manifest()));
    const readiness = offlineReadiness(manifest(), cached, VERSION);
    expect(readiness.matchesBuild).toBe(true);
    expect(readiness.fullyReady).toBe(true);
  });

  it('is not fully ready while any capability of this build is incomplete', () => {
    const all = allOfflinePaths(manifest());
    const cached = new Set(all.filter((path) => path !== '/engines/mupdf/mupdf.js'));
    const readiness = offlineReadiness(manifest(), cached, VERSION);
    expect(readiness.matchesBuild).toBe(true);
    expect(readiness.fullyReady).toBe(false);
    expect(readiness.capabilities.mupdf).toEqual({ ready: false, missing: ['/engines/mupdf/mupdf.js'] });
    expect(readiness.capabilities.pdfjs.ready).toBe(true);
  });

  it('refuses to count a cache written by another release', () => {
    const cached = new Set(allOfflinePaths(manifest()));
    const readiness = offlineReadiness(manifest(), cached, '1.2.2-deadbeef');
    expect(readiness.matchesBuild).toBe(false);
    expect(readiness.fullyReady).toBe(false);
    // Every capability is reported missing, with its real requirements, rather than
    // inheriting a stale "ready" from a cache this build cannot vouch for.
    expect(readiness.capabilities.pdfjs.missing).toEqual(manifest().capabilities.pdfjs);
  });

  it('treats an empty cache and a null version as nothing prepared', () => {
    const readiness = offlineReadiness(manifest(), new Set(), null);
    expect(readiness.fullyReady).toBe(false);
    expect(readiness.capabilities.core.ready).toBe(false);
  });
});

describe('requiredCapabilities', () => {
  it('always asks for MuPDF, because core editing writes with it, and OCR only when OCR is on', () => {
    expect(requiredCapabilities({ ocr: false })).toEqual(['core', 'pdfjs', 'mupdf', 'fonts']);
    expect(requiredCapabilities({ ocr: true })).toEqual(['core', 'pdfjs', 'mupdf', 'fonts', 'tesseract']);
  });
});

describe('the shipped path list matches the pinned assets', () => {
  const pins = JSON.parse(readFileSync('tools/asset-pins.json', 'utf8')) as {
    engines: Record<string, { files: { path: string }[] }>;
  };
  const offline = allOfflinePaths({ version: VERSION, capabilities: OFFLINE_CAPABILITIES });

  it('names only paths that exist in tools/asset-pins.json', () => {
    // The list is data (so the worker and the build can read it), which means nothing but
    // this test stops it from drifting away from the assets the repository actually pins.
    const pinned = new Set<string>();
    for (const engine of Object.values(pins.engines)) {
      for (const file of engine.files) pinned.add(`/${file.path}`);
    }
    // The shell's pages and scripts are build outputs, not pinned engine assets. The
    // interface fonts it caches are pinned, so they are checked like every other asset.
    const shell = new Set(OFFLINE_CAPABILITIES.core.filter((path) => !path.startsWith('/fonts/')));
    // An empty list would satisfy the check below for nothing.
    expect(offline.length).toBeGreaterThan(0);
    expect(pinned.size).toBeGreaterThan(0);
    const missing = offline.filter((path) => !pinned.has(path) && !shell.has(path));
    expect(missing).toEqual([]);
  });

  it('lists every pinned file the OCR and MuPDF capabilities need', () => {
    // The optional `lang/best/` packs are downloaded on demand, not cached ahead of time.
    const needed = [
      ...(pins.engines.tesseract?.files ?? [])
        .map((file) => `/${file.path}`)
        .filter((path) => !path.includes('/lang/best/')),
      ...(pins.engines.mupdf?.files ?? []).map((file) => `/${file.path}`),
    ];
    expect(needed.length).toBeGreaterThan(0);
    const listed = new Set(offline);
    expect(needed.filter((path) => !listed.has(path))).toEqual([]);
  });
});

describe('the page ↔ worker exchange', () => {
  /** A controlling worker that answers each request with `reply(message)`. */
  function stubWorker(reply: (message: Record<string, unknown>) => unknown): Record<string, unknown>[] {
    const received: Record<string, unknown>[] = [];
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {
          postMessage(message: Record<string, unknown>, ports: MessagePort[]) {
            received.push(message);
            ports[0]?.postMessage(reply(message));
          },
        },
      },
    });
    return received;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers null — not "nothing ready" — when no worker controls the page', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } });
    expect(await requestOfflineReadiness()).toBeNull();
    expect(await prepareOffline(['core'])).toBeNull();
  });

  it('trusts only the well-formed parts of a readiness reply', async () => {
    stubWorker(() => ({
      type: 'READINESS_STATUS',
      version: 'v7',
      matchesBuild: 'yes',
      capabilities: {
        core: { ready: true, missing: [] },
        mupdf: { ready: false, missing: ['/engines/mupdf/mupdf.js'] },
        fonts: { ready: 'true', missing: [] },
        pdfjs: { ready: false, missing: [3] },
      },
    }));
    const readiness = await requestOfflineReadiness();
    // `matchesBuild` is a boolean claim: the string "yes" is not one.
    expect(readiness?.matchesBuild).toBe(false);
    expect(readiness?.version).toBe('v7');
    expect(Object.keys(readiness?.capabilities ?? {}).sort()).toEqual(['core', 'mupdf']);
    expect(
      incompleteCapabilities(readiness as WorkerReadiness, requiredCapabilities({ ocr: false })),
    ).toEqual(['mupdf']);
  });

  it('judges a preparation only by what it fetches: OCR, cached on first use, is left out', async () => {
    stubWorker(() => ({
      type: 'READINESS_STATUS',
      version: 'v7',
      matchesBuild: true,
      capabilities: {
        core: { ready: true, missing: [] },
        pdfjs: { ready: true, missing: [] },
        mupdf: { ready: true, missing: [] },
        fonts: { ready: true, missing: [] },
        tesseract: { ready: false, missing: ['/engines/tesseract/tur.traineddata.gz'] },
      },
    }));
    const readiness = (await requestOfflineReadiness()) as WorkerReadiness;
    expect(incompleteCapabilities(readiness, requiredCapabilities({ ocr: false }))).toEqual([]);
    expect(incompleteCapabilities(readiness, requiredCapabilities({ ocr: true }))).toEqual(['tesseract']);
  });

  it('ignores a reply that is not the one it asked for', async () => {
    stubWorker(() => ({ type: 'SOMETHING_ELSE' }));
    expect(await requestOfflineReadiness()).toBeNull();
  });

  it('asks for exactly the paths of the requested capabilities and reports what the worker did', async () => {
    const received = stubWorker(() => ({ type: 'PREPARE_DONE', version: 'v7', count: 4, failed: ['/a', 5] }));
    const result = await prepareOffline(['core', 'fonts']);
    expect(received[0]).toEqual({
      type: 'PREPARE_PACKAGE',
      urls: [...OFFLINE_CAPABILITIES.core, ...OFFLINE_CAPABILITIES.fonts],
    });
    expect(result).toEqual({ version: 'v7', prepared: 4, failed: ['/a'] });
  });

  it('reads a bare readiness reply as no version, no match and no capabilities, skipping entries that are not objects', async () => {
    stubWorker(() => ({ type: 'READINESS_STATUS', capabilities: { core: 5, fonts: null } }));
    expect(await requestOfflineReadiness()).toEqual({ version: null, matchesBuild: false, capabilities: {} });
    stubWorker(() => ({ type: 'READINESS_STATUS', capabilities: 'none' }));
    expect(await requestOfflineReadiness()).toEqual({ version: null, matchesBuild: false, capabilities: {} });
  });

  it('answers null when the worker replies with something that is not an object', async () => {
    stubWorker(() => 'READINESS_STATUS');
    expect(await requestOfflineReadiness()).toBeNull();
    stubWorker(() => null);
    expect(await requestOfflineReadiness()).toBeNull();
  });

  it('answers null when the worker never replies within the wait, closing its port', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const received: Record<string, unknown>[] = [];
      vi.stubGlobal('navigator', {
        serviceWorker: {
          controller: { postMessage: (message: Record<string, unknown>) => received.push(message) },
        },
      });
      const pending = requestOfflineReadiness();
      vi.advanceTimersByTime(4_999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      vi.advanceTimersByTime(1);
      expect(await pending).toBeNull();
      expect(received).toEqual([{ type: 'CHECK_READINESS' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers null when the worker refuses the message', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        controller: {
          postMessage() {
            throw new Error('worker is gone');
          },
        },
      },
    });
    expect(await requestOfflineReadiness()).toBeNull();
  });

  it('reads a preparation reply that carries no version, count or failure list as nothing prepared', async () => {
    stubWorker(() => ({ type: 'PREPARE_DONE', failed: 'all' }));
    expect(await prepareOffline(['core'])).toEqual({ version: null, prepared: 0, failed: [] });
  });

  it('ignores a preparation reply of another kind', async () => {
    stubWorker(() => ({ type: 'READINESS_STATUS' }));
    expect(await prepareOffline(['core'])).toBeNull();
  });

  it('reports every requested path as failed when the worker says the preparation failed', async () => {
    stubWorker(() => ({ type: 'PREPARE_FAILED' }));
    const result = await prepareOffline(['fonts']);
    expect(result).toEqual({ version: null, prepared: 0, failed: [...OFFLINE_CAPABILITIES.fonts] });
  });
});
