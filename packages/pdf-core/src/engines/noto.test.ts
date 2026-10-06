/**
 * The session cache for the pinned Noto Sans bytes (`notoSansBytes`). A **rejected**
 * entry must be forgotten — an offline blip while the first stamp is written must not
 * fail every later write until a hard refresh — while a *successful* entry stays put.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTO_ASSETS } from '../assets';

/** The cache lives in module scope, so every test needs its own module instance. */
async function freshAdapter(): Promise<typeof import('./noto')> {
  vi.resetModules();
  return await import('./noto');
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('notoSansBytes', () => {
  const failure = new Error('network down');

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the pinned face once and keeps the bytes for the session', async () => {
    const fetchStub = vi.fn<(input: string) => Promise<Response>>(async () => new Response('regular-noto'));
    vi.stubGlobal('fetch', fetchStub);
    const { notoSansBytes } = await freshAdapter();

    const first = notoSansBytes();
    const second = notoSansBytes();
    expect(second).toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(NOTO_ASSETS.regular);

    const bytes = await first;
    expect(decode(bytes)).toBe('regular-noto');
    expect(await second).toBe(bytes);
    expect(await notoSansBytes()).toBe(bytes);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed request, so the next call fetches again', async () => {
    const fetchStub = vi.fn<(input: string) => Promise<Response>>(async () => {
      throw failure;
    });
    vi.stubGlobal('fetch', fetchStub);
    const { notoSansBytes } = await freshAdapter();

    await expect(notoSansBytes()).rejects.toBe(failure);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    fetchStub.mockImplementation(async () => new Response('regular-noto'));
    expect(decode(await notoSansBytes())).toBe('regular-noto');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('shares one request between simultaneous callers', async () => {
    const gate = Promise.withResolvers<Response>();
    const fetchStub = vi.fn<(input: string) => Promise<Response>>(async () => await gate.promise);
    vi.stubGlobal('fetch', fetchStub);
    const { notoSansBytes } = await freshAdapter();

    const first = notoSansBytes();
    const second = notoSansBytes();
    expect(second).toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(1);

    gate.resolve(new Response('regular-noto'));
    expect(decode(await first)).toBe('regular-noto');
    expect(await second).toBe(await first);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('gives simultaneous retries after a failure exactly one new request', async () => {
    const gate = Promise.withResolvers<Response>();
    let requests = 0;
    const fetchStub = vi.fn<(input: string) => Promise<Response>>(async () => {
      requests += 1;
      if (requests === 1) throw failure;
      return await gate.promise;
    });
    vi.stubGlobal('fetch', fetchStub);
    const { notoSansBytes } = await freshAdapter();

    await expect(notoSansBytes()).rejects.toBe(failure);

    const first = notoSansBytes();
    const second = notoSansBytes();
    expect(second).toBe(first);
    expect(fetchStub).toHaveBeenCalledTimes(2);

    gate.resolve(new Response('regular-noto'));
    expect(decode(await first)).toBe('regular-noto');
    expect(await second).toBe(await first);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('does not let a replaced request evict the request that replaced it', async () => {
    // The first request is answered by a second, concurrent request for the same face:
    // a service-worker hook or a fetch polyfill can re-enter like this. The second
    // request is what the cache ends up holding, so the first one's rejection must not
    // delete it — the identity check in `notoSansBytes` is only reachable this way.
    const cached = Promise.withResolvers<Response>();
    const replaced = Promise.withResolvers<Response>();
    let first = true;
    let replacedRequest: Promise<Uint8Array> | null = null;
    const fetchStub = vi.fn<(input: string) => Promise<Response>>(async () => {
      if (first) {
        first = false;
        replacedRequest = notoSansBytes(true);
        return await cached.promise;
      }
      return await replaced.promise;
    });
    vi.stubGlobal('fetch', fetchStub);
    const { notoSansBytes } = await freshAdapter();

    const current = notoSansBytes(true);
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const stale = replacedRequest;
    expect(stale).not.toBeNull();

    replaced.reject(failure);
    await expect(stale).rejects.toBe(failure);
    cached.resolve(new Response('semi-bold-noto'));

    expect(decode(await current)).toBe('semi-bold-noto');
    expect(notoSansBytes(true)).toBe(current);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('keeps a successful face when the other face fails', async () => {
    let failSemiBold = true;
    const fetchStub = vi.fn<(input: string) => Promise<Response>>(async (url) => {
      if (url !== NOTO_ASSETS.semiBold) return new Response('regular-noto');
      if (failSemiBold) {
        failSemiBold = false;
        throw failure;
      }
      return new Response('semi-bold-noto');
    });
    vi.stubGlobal('fetch', fetchStub);
    const { notoSansBytes } = await freshAdapter();

    const regular = notoSansBytes(false);
    expect(decode(await regular)).toBe('regular-noto');

    await expect(notoSansBytes(true)).rejects.toBe(failure);
    expect(notoSansBytes(false)).toBe(regular);
    expect(fetchStub).toHaveBeenCalledTimes(2);

    expect(decode(await notoSansBytes(true))).toBe('semi-bold-noto');
    expect(notoSansBytes(false)).toBe(regular);
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('maps an HTTP failure to asset-missing and does not cache it either', async () => {
    const fetchStub = vi.fn<(input: string) => Promise<Response>>(
      async () => new Response('', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const { notoSansBytes } = await freshAdapter();

    const rejection = await notoSansBytes().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    const code = rejection instanceof Error && 'code' in rejection ? rejection.code : null;
    expect(code).toBe('asset-missing');

    fetchStub.mockImplementation(async () => new Response('regular-noto'));
    expect(decode(await notoSansBytes())).toBe('regular-noto');
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
