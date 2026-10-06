/**
 * The tesseract engine chunk cache: the runtime-loaded ESM build
 * (`TESSERACT_ASSETS.module`, served from our own origin) is imported once and shared,
 * and a **failed** import must not be remembered — a dropped connection while the chunk
 * loads would otherwise make every later OCR run fail until a hard refresh.
 *
 * The chunk is mocked at its asset path; the engine object below is what the loader
 * hands back, and the getter is the loader's `module.default` step, so every counted
 * access is one pass of the loader's own import step.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TESSERACT_ASSETS } from '../assets';

/** The literal the mock below intercepts — kept next to the assertion that it matches. */
const TESSERACT_MODULE = '/engines/tesseract/tesseract.esm.min.js';

const state = vi.hoisted(() => ({
  /** Passes of the loader's `module.default` step — one per import attempt it makes. */
  accesses: 0,
  /** How many of the next accesses fail; a retry finds this at zero again. */
  failures: 0,
  error: new Error('tesseract chunk unavailable'),
  engine: { recognize: () => 'stub engine' },
}));

vi.mock('/engines/tesseract/tesseract.esm.min.js', () => ({
  get default(): typeof state.engine {
    state.accesses += 1;
    if (state.failures > 0) {
      state.failures -= 1;
      throw state.error;
    }
    return state.engine;
  },
}));

/** The chunk cache lives in module scope, so every test needs its own module instance. */
async function freshLoader(): Promise<typeof import('./tesseract')> {
  vi.resetModules();
  return await import('./tesseract');
}

describe('loadTesseract', () => {
  beforeEach(() => {
    state.accesses = 0;
    state.failures = 0;
  });

  it('loads the pinned chunk once and gives simultaneous callers one shared attempt', async () => {
    expect(TESSERACT_ASSETS.module).toBe(TESSERACT_MODULE); // otherwise the mock above intercepts nothing
    const { loadTesseract } = await freshLoader();

    const first = loadTesseract();
    const second = loadTesseract();
    expect(second).toBe(first);
    expect(state.accesses).toBe(0); // the attempt is still in flight

    const engine = await first;
    expect(await second).toBe(engine);
    expect(engine).toBe(state.engine);
    expect(state.accesses).toBe(1);
  });

  it('forgets a failed chunk load so the next call loads again', async () => {
    const { loadTesseract } = await freshLoader();
    state.failures = 1;
    await expect(loadTesseract()).rejects.toBe(state.error);
    expect(state.accesses).toBe(1);

    const engine = await loadTesseract();
    expect(engine).toBe(state.engine);
    expect(state.accesses).toBe(2);
  });

  it('gives simultaneous retries exactly one fresh attempt', async () => {
    const { loadTesseract } = await freshLoader();
    state.failures = 1;
    await expect(loadTesseract()).rejects.toBe(state.error);

    const first = loadTesseract();
    const second = loadTesseract();
    expect(second).toBe(first);
    expect(await second).toBe(state.engine);
    expect(state.accesses).toBe(2); // one failed attempt, one retry — not two
  });

  it('keeps a loaded chunk for every later caller', async () => {
    const { loadTesseract } = await freshLoader();
    const engine = await loadTesseract();
    expect(state.accesses).toBe(1);

    expect(loadTesseract()).toBe(loadTesseract());
    expect(await loadTesseract()).toBe(engine);
    expect(state.accesses).toBe(1);
  });
});
