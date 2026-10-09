/**
 * A stand-in for the browser's camera, for the DOM tests: `navigator.mediaDevices`, the
 * stream and its track, and a `<video>` that can play. happy-dom has none of them, so the
 * camera hook and the screens built on it run against these.
 */

import { type Mock, vi } from 'vitest';

export interface FakeTrackSettings {
  deviceId?: string;
  width?: number;
  height?: number;
}

/** A stream whose only content is `tracks`: what `srcObject` accepts and `getUserMedia` resolves with. */
export function streamOf(...tracks: unknown[]): MediaStream {
  class FakeStream extends MediaStream {
    override getTracks(): MediaStreamTrack[] {
      return tracks as MediaStreamTrack[];
    }
    override getVideoTracks(): MediaStreamTrack[] {
      return tracks as MediaStreamTrack[];
    }
  }
  return new FakeStream();
}

export interface FakeCamera {
  readonly track: { stop: Mock; getSettings: () => FakeTrackSettings };
  readonly stream: MediaStream;
  /** What the next stream's track reports about itself. */
  settings: FakeTrackSettings;
  readonly getUserMedia: Mock;
  readonly enumerateDevices: Mock;
  readonly play: Mock;
  /** Put the browser back as it was. */
  remove(): void;
}

export const BACK_CAMERA = { kind: 'videoinput', deviceId: 'back', label: 'Back camera' } as const;
export const FRONT_CAMERA = { kind: 'videoinput', deviceId: 'front', label: 'Front camera' } as const;

/** Install a camera that streams `settings`' size from the back camera. */
export function installCamera(initial: FakeTrackSettings = {}): FakeCamera {
  const camera: FakeCamera = {
    settings: { deviceId: 'back', width: 1920, height: 1080, ...initial },
    track: {
      stop: vi.fn(),
      getSettings: () => camera.settings,
    },
    stream: undefined as unknown as MediaStream,
    getUserMedia: vi.fn(async () => camera.stream),
    enumerateDevices: vi.fn(async () => [BACK_CAMERA, FRONT_CAMERA]),
    play: vi.fn(async () => undefined),
    remove: () => {
      Reflect.deleteProperty(navigator, 'mediaDevices');
      Reflect.deleteProperty(window, 'isSecureContext');
      Reflect.deleteProperty(HTMLMediaElement.prototype, 'play');
    },
  };
  (camera as { stream: MediaStream }).stream = streamOf(camera.track);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: camera.getUserMedia, enumerateDevices: camera.enumerateDevices },
  });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: camera.play });
  return camera;
}

/** Give a `<video>` the size a camera frame would have (happy-dom reports 0 × 0). */
export function sizeVideo(video: HTMLVideoElement, width: number, height: number, readyState = 4): void {
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
  Object.defineProperty(video, 'readyState', { configurable: true, value: readyState });
}
