/**
 * The camera's failure vocabulary and its up-front check, with no browser around: what each
 * `getUserMedia` rejection means to the user, and why a page without a camera API is told so
 * before the browser is asked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cameraUnavailable, classifyCameraError } from './useCamera';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyCameraError', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['PermissionDeniedError', 'denied'],
    ['NotSupportedError', 'unsupported'],
    ['TypeError', 'unsupported'],
    ['NotFoundError', 'none'],
    ['DevicesNotFoundError', 'none'],
    ['OverconstrainedError', 'none'],
    ['NotReadableError', 'busy'],
    ['TrackStartError', 'busy'],
    ['AbortError', 'busy'],
    ['SomethingElse', 'failed'],
  ] as const)('reads %s as "%s"', (name, problem) => {
    expect(classifyCameraError(new DOMException('refused', name))).toBe(problem);
  });

  it('reads a plain Error by its name, and anything that is not an error as a failure', () => {
    const error = new Error('no device');
    error.name = 'NotFoundError';
    expect(classifyCameraError(error)).toBe('none');
    expect(classifyCameraError('NotAllowedError')).toBe('failed');
    expect(classifyCameraError(undefined)).toBe('failed');
  });
});

describe('cameraUnavailable outside a page', () => {
  it('is "unsupported" where there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(cameraUnavailable()).toBe('unsupported');
  });

  it('is "unsupported" where the navigator has no media devices', () => {
    vi.stubGlobal('navigator', {});
    expect(cameraUnavailable()).toBe('unsupported');
  });

  it('is "unsupported" where the media devices cannot be asked for a stream', () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(cameraUnavailable()).toBe('unsupported');
  });

  it('is null where a stream can be asked for', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.reject(new Error('unused')) } });
    expect(cameraUnavailable()).toBeNull();
  });
});
