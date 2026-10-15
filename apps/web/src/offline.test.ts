/**
 * Offline readiness and preparation, against the failures that make it lie.
 *
 * What the page owns is the list of what a capability needs and the exchange with the worker
 * that computes readiness (`tools/audit/regressions.cjs` runs the worker itself). The list has
 * to name the URLs the adapters actually request, at the version the pins give the engine:
 * the browser keeps `/engines/**` for a year, so a URL that does not change with the bytes
 * would hand a new shell the old engine, silently, with no network to fall back on.
 */

import { readFileSync } from 'node:fs';
import type * as RealAssets from 'pdf-core/assets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineVersions } from '../../../tools/fetch-engines.mjs';
import type { WorkerReadiness } from './offline';
import {
  incompleteCapabilities,
  OFFLINE_CAPABILITIES,
  prepareOffline,
  requestOfflineReadiness,
  requiredCapabilities,
} from './offline';
import packages from './offline-packages.json';

describe('requiredCapabilities', () => {
  it("always asks for the editor's own code and MuPDF, because core editing runs on both, and OCR only when OCR is on", () => {
    expect(requiredCapabilities({ ocr: false })).toEqual(['core', 'app', 'pdfjs', 'mupdf', 'fonts']);
    expect(requiredCapabilities({ ocr: true })).toEqual([
      'core',
      'app',
      'pdfjs',
      'mupdf',
      'fonts',
      'tesseract',
    ]);
  });
});

describe('the shipped path list matches the pinned assets', () => {
  const pins = JSON.parse(readFileSync('tools/asset-pins.json', 'utf8')) as {
    engines: Record<string, { files: { path: string; sha256: string }[] }>;
  };
  const versions = engineVersions(pins);
  const offline = [...new Set(Object.values(OFFLINE_CAPABILITIES).flat())];

  /**
   * A pin's path as the browser requests it, worked out here from the pins alone (not from
   * `engine-versions.json`, which is what the list under test reads): an engine file sits in
   * its version directory, a font keeps its path.
   */
  function servedUrl(pinPath: string): string {
    const [root = '', id = '', ...rest] = pinPath.split('/');
    return root === 'engines' ? `/engines/${id}/${versions[id]}/${rest.join('/')}` : `/${pinPath}`;
  }

  it('names only URLs of pinned files, each engine file at the version its pins give', () => {
    // The list is data (so the worker and the build can read it), which means nothing but
    // this test stops it from drifting away from the assets the repository actually pins.
    const pinned = new Set<string>();
    for (const engine of Object.values(pins.engines)) {
      for (const file of engine.files) pinned.add(servedUrl(file.path));
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

  it('puts a version directory in every engine URL, and none in a font or shell path', () => {
    const engineUrls = offline.filter((path) => path.startsWith('/engines/'));
    expect(engineUrls.length).toBeGreaterThan(0);
    for (const url of engineUrls) {
      const [, , id = '', version = ''] = url.split('/');
      expect(version, url).toMatch(/^v[0-9a-f]{12}$/);
      expect(version, url).toBe(versions[id]);
    }
    const versioned = offline.filter(
      (path) => !path.startsWith('/engines/') && /\/v[0-9a-f]{12}\//.test(path),
    );
    expect(versioned).toEqual([]);
  });

  it('is the logical list in offline-packages.json with only the engine files moved to their version', () => {
    for (const [name, list] of Object.entries(packages.capabilities)) {
      const shipped = OFFLINE_CAPABILITIES[name as keyof typeof OFFLINE_CAPABILITIES];
      expect(shipped.length, name).toBe(list.length);
      list.forEach((logical, index) => {
        const url = shipped[index];
        if (logical.startsWith('/engines/')) expect(url, logical).toBe(servedUrl(logical.slice(1)));
        else expect(url, logical).toBe(logical);
      });
    }
  });

  it("leaves the editor's own chunks to the build, which is the only place their hashed names exist", () => {
    // `tools/assemble-dist.mjs` refuses a non-empty list and writes the real one into the manifest.
    expect(OFFLINE_CAPABILITIES.app).toEqual([]);
  });

  it('lists every pinned file the OCR and MuPDF capabilities need', () => {
    // The optional `lang/best/` packs are downloaded on demand, not cached ahead of time. The
    // tesseract core carries its wasm inline (`tesseract-core-simd-lstm.wasm.js`), so the
    // `.wasm` pinned beside it is requested by nothing and is not part of the capability.
    const ocrPaths = (pins.engines.tesseract?.files ?? [])
      .map((file) => file.path)
      .filter((path) => !path.includes('/lang/best/'))
      .filter((path) => !path.endsWith('/tesseract-core-simd-lstm.wasm'));
    const mupdfPaths = (pins.engines.mupdf?.files ?? []).map((file) => file.path);
    const needed = [...ocrPaths, ...mupdfPaths].map(servedUrl);
    expect(needed.length).toBeGreaterThan(0);
    const listed = new Set(offline);
    expect(needed.filter((path) => !listed.has(path))).toEqual([]);
  });

  it('lists the URL of every file the adapters request, as they build it', async () => {
    // The unit setup swaps some of these for installed-package paths; the real ones are what ships.
    const assets = await vi.importActual<typeof RealAssets>('pdf-core/assets');
    const listed = new Set(offline);
    const requested = [
      assets.PDFJS_ASSETS.worker,
      // pdf.js appends the file name to these directories.
      `${assets.PDFJS_ASSETS.cmaps}Adobe-Japan1-UCS2.bcmap`,
      `${assets.PDFJS_ASSETS.standardFonts}FoxitSerif.pfb`,
      `${assets.PDFJS_ASSETS.wasm}openjpeg.wasm`,
      `${assets.PDFJS_ASSETS.wasm}qcms_bg.wasm`,
      assets.MUPDF_ASSETS.js,
      // The wasm engine resolves its neighbours next to the module it was imported from.
      new URL('mupdf-wasm.js', `https://editor.test${assets.MUPDF_ASSETS.js}`).pathname,
      new URL('mupdf-wasm.wasm', `https://editor.test${assets.MUPDF_ASSETS.js}`).pathname,
      assets.TESSERACT_ASSETS.module,
      assets.TESSERACT_ASSETS.worker,
      assets.TESSERACT_ASSETS.core,
      ...assets.OCR_LANGUAGE_CODES.map(
        (code) => `${assets.TESSERACT_ASSETS.fastLangPath}/${code}.traineddata.gz`,
      ),
      assets.NOTO_ASSETS.regular,
      assets.NOTO_ASSETS.semiBold,
    ];
    expect(requested.filter((url) => !listed.has(url))).toEqual([]);
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

  it("asks for the requested capabilities by name — the editor's own chunks included — and reports what the worker did", async () => {
    const received = stubWorker(() => ({ type: 'PREPARE_DONE', version: 'v7', count: 4, failed: ['/a', 5] }));
    const result = await prepareOffline(['core', 'app', 'fonts']);
    // Names, not URLs: the chunks of `app` are hashed, so only the build's manifest, which the
    // worker reads, can say which files they are.
    // The shipped paths ride along so a worker that predates the capability protocol fetches
    // only those, not every package (OCR's 25 MiB included), during the update window.
    expect(received[0]).toEqual({
      type: 'PREPARE_PACKAGE',
      capabilities: ['core', 'app', 'fonts'],
      urls: [...OFFLINE_CAPABILITIES.core, ...OFFLINE_CAPABILITIES.app, ...OFFLINE_CAPABILITIES.fonts],
    });
    expect(result).toEqual({ version: 'v7', prepared: 4, failed: ['/a'] });
  });

  it('sends no path for a capability only the build can list, so an old worker fetches nothing for it', async () => {
    const received = stubWorker(() => ({ type: 'PREPARE_DONE', version: 'v7', count: 0, failed: [] }));
    await prepareOffline(['app']);
    expect(received[0]).toEqual({ type: 'PREPARE_PACKAGE', capabilities: ['app'], urls: [] });
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

  it('never reports a failed preparation as empty, even when only build-listed capabilities were asked for', async () => {
    // `app` has no path in the shipped list, so an empty `failed` would read as success.
    stubWorker(() => ({ type: 'PREPARE_FAILED' }));
    expect(await prepareOffline(['app'])).toEqual({ version: null, prepared: 0, failed: ['app'] });
  });
});
