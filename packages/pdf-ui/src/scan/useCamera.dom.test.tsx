// @vitest-environment happy-dom
/**
 * The camera hook against a fake browser camera: the constraints the stream is asked for, the
 * state it reaches (live with the device list, or a named problem), what a restart or an
 * unmount does to a stream that arrives late, and the still it takes — from the sensor when the
 * camera offers a larger photo than its video, from the video frame otherwise.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACK_CAMERA, type FakeCamera, installCamera, sizeVideo, streamOf } from './camera.fixtures';
import { type UseCamera, useCamera } from './useCamera';

let camera: FakeCamera;
let current: UseCamera;

/** Mounts the hook, with a `<video>` for it to drive unless `withVideo` is false. */
function Harness({ withVideo = true }: { withVideo?: boolean }) {
  current = useCamera();
  return withVideo ? (
    <video ref={current.videoRef} data-testid="video">
      <track kind="captions" />
    </video>
  ) : null;
}

function videoElement(): HTMLVideoElement {
  return document.querySelector('video') as HTMLVideoElement;
}

beforeEach(() => {
  camera = installCamera();
});

afterEach(() => {
  cleanup();
  camera.remove();
  Reflect.deleteProperty(window, 'ImageCapture');
  vi.restoreAllMocks();
});

async function startAndWait(deviceId?: string | null) {
  await act(async () => {
    current.start(deviceId);
  });
  await waitFor(() => expect(current.status).not.toBe('starting'));
}

describe('useCamera start', () => {
  it('asks for the rear camera at the highest resolution, then reports the live stream and the cameras', async () => {
    render(<Harness />);
    expect(current.status).toBe('idle');
    await startAndWait();
    expect(camera.getUserMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 4096 }, height: { ideal: 3072 }, facingMode: { ideal: 'environment' } },
      audio: false,
    });
    expect(camera.play).toHaveBeenCalledTimes(1);
    expect(videoElement().srcObject).toBe(camera.stream);
    expect(current.status).toBe('live');
    expect(current.problem).toBeNull();
    expect(current.deviceId).toBe('back');
    expect(current.size).toEqual({ width: 1920, height: 1080 });
    expect(current.devices).toEqual([
      { id: 'back', label: 'Back camera' },
      { id: 'front', label: 'Front camera' },
    ]);
  });

  it('asks for exactly the chosen camera when one is named', async () => {
    render(<Harness />);
    camera.settings = { deviceId: 'front', width: 640, height: 480 };
    await startAndWait('front');
    expect(camera.getUserMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 4096 }, height: { ideal: 3072 }, deviceId: { exact: 'front' } },
      audio: false,
    });
    expect(current.deviceId).toBe('front');
    expect(current.size).toEqual({ width: 640, height: 480 });
  });

  it('numbers cameras that have no name, and ignores devices that are not cameras', async () => {
    camera.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
      { kind: 'videoinput', deviceId: 'one', label: '' },
      { kind: 'videoinput', deviceId: 'two', label: '' },
    ]);
    render(<Harness />);
    await startAndWait();
    expect(current.devices).toEqual([
      { id: 'one', label: '1' },
      { id: 'two', label: '2' },
    ]);
  });

  it('falls back to the requested device when the track does not say which camera it is', async () => {
    camera.settings = { width: 800, height: 600 };
    render(<Harness />);
    await startAndWait('front');
    expect(current.deviceId).toBe('front');
  });

  it('falls back to the first listed camera when neither the track nor the request names one', async () => {
    camera.settings = { width: 800, height: 600 };
    render(<Harness />);
    await startAndWait();
    expect(current.deviceId).toBe(BACK_CAMERA.deviceId);
  });

  it('has no device and no size when nothing says which camera it is or how large', async () => {
    camera.settings = {};
    camera.enumerateDevices.mockResolvedValue([]);
    render(<Harness />);
    await startAndWait();
    expect(current.status).toBe('live');
    expect(current.deviceId).toBeNull();
    expect(current.size).toBeNull();
    expect(current.devices).toEqual([]);
  });

  it('has no size when the track reports a width but no height', async () => {
    camera.settings = { deviceId: 'back', width: 800 };
    render(<Harness />);
    await startAndWait();
    expect(current.size).toBeNull();
  });

  it('is live with no cameras listed when the list cannot be read', async () => {
    camera.enumerateDevices.mockRejectedValue(new Error('refused'));
    render(<Harness />);
    await startAndWait();
    expect(current.status).toBe('live');
    expect(current.devices).toEqual([]);
    expect(current.deviceId).toBe('back');
  });

  it('is live even when the video cannot be played', async () => {
    camera.play.mockRejectedValue(new DOMException('interrupted', 'AbortError'));
    render(<Harness />);
    await startAndWait();
    expect(current.status).toBe('live');
  });

  it('is live without a video element to show the stream in', async () => {
    render(<Harness withVideo={false} />);
    await startAndWait();
    expect(current.status).toBe('live');
    expect(camera.play).not.toHaveBeenCalled();
  });

  it('reports a camera it was refused as a named problem', async () => {
    camera.getUserMedia.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    render(<Harness />);
    await startAndWait();
    expect(current.status).toBe('problem');
    expect(current.problem).toBe('denied');
  });

  it('reports an insecure page without asking the browser', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    render(<Harness />);
    await startAndWait();
    expect(current.status).toBe('problem');
    expect(current.problem).toBe('insecure');
    expect(camera.getUserMedia).not.toHaveBeenCalled();
  });

  it('reports a browser without a camera API', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    render(<Harness />);
    await startAndWait();
    expect(current.problem).toBe('unsupported');
  });
});

describe('useCamera restarts and unmounting', () => {
  it('stops the stream it replaces, and ignores a stream that arrives after a newer start', async () => {
    const late = { stop: vi.fn() };
    const lateStream = streamOf(late);
    const slow = Promise.withResolvers<unknown>();
    camera.getUserMedia.mockImplementationOnce(() => slow.promise);
    render(<Harness />);
    act(() => current.start());
    camera.settings = { deviceId: 'front', width: 640, height: 480 };
    await startAndWait('front');
    expect(current.deviceId).toBe('front');
    await act(async () => {
      slow.resolve(lateStream);
    });
    // The slow first stream is shut at once and never shown.
    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(current.deviceId).toBe('front');
    expect(current.status).toBe('live');
  });

  it('stops the running stream when a new one is asked for', async () => {
    render(<Harness />);
    await startAndWait();
    expect(camera.track.stop).not.toHaveBeenCalled();
    await startAndWait('front');
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
  });

  it('ignores a device list that arrives after a newer start', async () => {
    const slow = Promise.withResolvers<unknown[]>();
    camera.enumerateDevices.mockImplementationOnce(() => slow.promise);
    render(<Harness />);
    act(() => current.start());
    await waitFor(() => expect(camera.enumerateDevices).toHaveBeenCalledTimes(1));
    camera.settings = { deviceId: 'front', width: 640, height: 480 };
    await startAndWait('front');
    await act(async () => {
      slow.resolve([BACK_CAMERA]);
    });
    expect(current.deviceId).toBe('front');
    expect(current.devices).toEqual([
      { id: 'back', label: 'Back camera' },
      { id: 'front', label: 'Front camera' },
    ]);
  });

  it('ignores a refusal that arrives after a newer start', async () => {
    const slow = Promise.withResolvers<unknown>();
    camera.getUserMedia.mockImplementationOnce(() => slow.promise);
    render(<Harness />);
    act(() => current.start());
    await startAndWait('front');
    await act(async () => {
      slow.reject(new DOMException('no', 'NotAllowedError'));
    });
    expect(current.status).toBe('live');
    expect(current.problem).toBeNull();
  });

  it('releases the camera when the view is left', async () => {
    const view = render(<Harness />);
    await startAndWait();
    expect(camera.track.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
  });

  it('takes the stream off the video when the camera is restarted', async () => {
    render(<Harness />);
    await startAndWait();
    const video = videoElement();
    expect(video.srcObject).toBe(camera.stream);
    camera.getUserMedia.mockImplementationOnce(() => Promise.withResolvers<unknown>().promise);
    act(() => current.start());
    expect(video.srcObject).toBeNull();
  });

  it('stops a stream that arrives after the view was left', async () => {
    const slow = Promise.withResolvers<unknown>();
    camera.getUserMedia.mockImplementationOnce(() => slow.promise);
    const view = render(<Harness />);
    act(() => current.start());
    view.unmount();
    await act(async () => {
      slow.resolve(camera.stream);
    });
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
  });
});

describe('useCamera capture', () => {
  /** A 2D context and encoder for the canvases `capture` makes, recording what was drawn. */
  function canvasFake(options: { context?: boolean; blob?: Blob | null } = {}) {
    const drawn: Array<{ source: unknown; x: number; y: number; width: number; height: number }> = [];
    const sizes: Array<{ width: number; height: number }> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      if (options.context === false) return null;
      return {
        drawImage: (source: unknown, x: number, y: number) => {
          drawn.push({ source, x, y, width: this.width, height: this.height });
        },
      } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      done: BlobCallback,
      type?: string,
      quality?: unknown,
    ) {
      sizes.push({ width: this.width, height: this.height });
      expect([type, quality]).toEqual(['image/jpeg', 0.95]);
      done(options.blob === undefined ? new Blob(['frame'], { type: 'image/jpeg' }) : options.blob);
    });
    return { drawn, sizes };
  }

  async function live() {
    render(<Harness />);
    await startAndWait();
    sizeVideo(videoElement(), 1920, 1080);
  }

  function imageCapture(options: {
    widest?: number;
    tallest?: number;
    photo?: Blob;
    failOn?: 'capabilities' | 'photo';
  }) {
    const takePhoto = vi.fn(async (_settings?: unknown) => {
      if (options.failOn === 'photo') throw new Error('refused');
      return options.photo ?? new Blob(['sensor'], { type: 'image/jpeg' });
    });
    const tracks: unknown[] = [];
    class FakeImageCapture {
      constructor(track: unknown) {
        tracks.push(track);
      }
      async getPhotoCapabilities() {
        if (options.failOn === 'capabilities') throw new Error('no photo mode');
        return {
          ...(options.widest === undefined ? {} : { imageWidth: { max: options.widest } }),
          ...(options.tallest === undefined ? {} : { imageHeight: { max: options.tallest } }),
        };
      }
      takePhoto = takePhoto;
    }
    Object.defineProperty(window, 'ImageCapture', { configurable: true, value: FakeImageCapture });
    return { takePhoto, tracks };
  }

  it('has nothing to photograph before the camera is live', async () => {
    render(<Harness />);
    await expect(current.capture()).rejects.toThrow('camera is not live');
  });

  it('has nothing to photograph without a video element', async () => {
    render(<Harness withVideo={false} />);
    await startAndWait();
    await expect(current.capture()).rejects.toThrow('camera is not live');
  });

  it('takes the frame from the video when the browser has no still-photo API', async () => {
    const canvas = canvasFake();
    await live();
    const blob = await current.capture();
    expect(await blob.text()).toBe('frame');
    expect(canvas.drawn).toEqual([{ source: videoElement(), x: 0, y: 0, width: 1920, height: 1080 }]);
    expect(canvas.sizes).toEqual([{ width: 1920, height: 1080 }]);
  });

  it('takes the sensor photo, at its full size, when it is clearly larger than the video', async () => {
    const sensor = imageCapture({ widest: 4000, tallest: 3000 });
    const canvas = canvasFake();
    await live();
    const blob = await current.capture();
    expect(await blob.text()).toBe('sensor');
    expect(sensor.tracks).toEqual([camera.track]);
    expect(sensor.takePhoto).toHaveBeenCalledWith({ imageWidth: 4000, imageHeight: 3000 });
    expect(canvas.drawn).toEqual([]);
  });

  it('asks only for the width when the camera gives no maximum height', async () => {
    const sensor = imageCapture({ widest: 4000 });
    await live();
    await current.capture();
    expect(sensor.takePhoto).toHaveBeenCalledWith({ imageWidth: 4000 });
  });

  it('keeps to the video when the photo mode is no larger than it', async () => {
    const sensor = imageCapture({ widest: 2000, tallest: 1125 });
    canvasFake();
    await live();
    expect(await (await current.capture()).text()).toBe('frame');
    expect(sensor.takePhoto).not.toHaveBeenCalled();
  });

  it('keeps to the video when the camera states no photo width', async () => {
    const sensor = imageCapture({});
    canvasFake();
    await live();
    expect(await (await current.capture()).text()).toBe('frame');
    expect(sensor.takePhoto).not.toHaveBeenCalled();
  });

  it('keeps to the video when the sensor returns an empty photo', async () => {
    imageCapture({ widest: 4000, photo: new Blob([]) });
    canvasFake();
    await live();
    expect(await (await current.capture()).text()).toBe('frame');
  });

  it('keeps to the video when the camera has no photo mode', async () => {
    imageCapture({ failOn: 'capabilities' });
    canvasFake();
    await live();
    expect(await (await current.capture()).text()).toBe('frame');
  });

  it('keeps to the video when the camera refuses the photo size', async () => {
    const sensor = imageCapture({ widest: 4000, failOn: 'photo' });
    canvasFake();
    await live();
    expect(await (await current.capture()).text()).toBe('frame');
    expect(sensor.takePhoto).toHaveBeenCalledTimes(1);
  });

  it('says so when the canvas has no 2D context', async () => {
    canvasFake({ context: false });
    await live();
    await expect(current.capture()).rejects.toThrow('no 2D canvas context');
  });

  it('says so when the frame cannot be encoded', async () => {
    canvasFake({ blob: null });
    await live();
    await expect(current.capture()).rejects.toThrow('the frame could not be encoded');
  });
});
