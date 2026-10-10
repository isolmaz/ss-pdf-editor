// @vitest-environment happy-dom
/**
 * The camera screen: what the user is told while the camera starts and when it cannot, the live
 * outline of the page and when it settles or lets go, the shutter, the camera list and the
 * choice of photos from files. The camera is the fake of `camera.fixtures.ts`; the page detector
 * runs on the synthetic frames of `scan.fixtures.ts` (only the canvas read of the video is replaced).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detectPage } from 'pdf-core/ops/scan-detect';
import type { RasterImage } from 'pdf-core/ops/scan-geometry';
import { createTranslator } from 'pdf-shared';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, type MockInstance, vi } from 'vitest';
import { CameraView, type CameraViewProps } from './CameraView';
import { type FakeCamera, FRONT_CAMERA, installCamera, sizeVideo } from './camera.fixtures';
import { type PageFractions, rasterOf } from './scan.fixtures';

const t = createTranslator('en');

const frames = vi.hoisted(() => ({ next: null as RasterImage | null, sizes: [] as number[] }));

vi.mock('pdf-core/ops/scan-browser', () => ({
  frameToRaster: (_video: HTMLVideoElement, maxSide: number) => {
    frames.sizes.push(maxSide);
    return frames.next;
  },
}));

const FRAME_W = 400;
const FRAME_H = 300;
const CLOSE: PageFractions = { left: 0.2, top: 40 / 300, right: 0.8, bottom: 260 / 300 };
/** A little to the right of `CLOSE`: the page settling. */
const NEARBY: PageFractions = { left: 0.22, top: 40 / 300, right: 0.82, bottom: 260 / 300 };
/** Half a picture away: the page was moved. */
const FAR: PageFractions = { left: 0.45, top: 0.5, right: 0.95, bottom: 0.95 };

let camera: FakeCamera;
let timers: MockInstance<typeof window.setInterval>;
let onPhotos: Mock<CameraViewProps['onPhotos']>;
let onShowPages: Mock<CameraViewProps['onShowPages']>;

const frameOf = (at: PageFractions) => rasterOf('page', FRAME_W, FRAME_H, at);

/** The corners the detector finds in a frame, as fractions of it: what the outline is drawn from. */
function found(at: PageFractions): Array<[number, number]> {
  const quad = (detectPage(frameOf(at)) as NonNullable<ReturnType<typeof detectPage>>).quad;
  return quad.map((point) => [point.x / FRAME_W, point.y / FRAME_H]);
}

/** The outline's corners in percent of the picture, as drawn. */
function drawn(): Array<[number, number]> {
  const polygon = screen.getByTestId('scan-live-outline').querySelector('polygon') as SVGPolygonElement;
  return (polygon.getAttribute('points') as string).split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    return [(x as number) / 100, (y as number) / 100];
  });
}

function expectDrawn(expected: Array<[number, number]>) {
  const actual = drawn();
  for (const [index, [x, y]] of expected.entries()) {
    expect(actual[index]?.[0]).toBeCloseTo(x, 9);
    expect(actual[index]?.[1]).toBeCloseTo(y, 9);
  }
}

function renderView(overrides: Partial<CameraViewProps> = {}) {
  return render(
    <CameraView
      t={t}
      onPhotos={onPhotos}
      pageCount={0}
      onShowPages={onShowPages}
      disabled={false}
      {...overrides}
    />,
  );
}

const video = () => screen.getByLabelText('Camera preview') as HTMLVideoElement;
const shutter = () => screen.getByRole('button', { name: 'Take photo' });

/**
 * Resolves once the view is live and its outline timer exists. The text only says the view
 * committed as live; React starts the timer in a passive effect that, outside `act`, can run
 * in a later task — a tick before then advances the fake clock with nothing registered on it.
 */
async function outlineTimerStarted() {
  await screen.findByText('Looking for the page…');
  // Polled on the real clock (node's timers are not faked): `waitFor` polls on `setInterval`, which is.
  for (let polls = 0; polls < 400; polls += 1) {
    if (timers.mock.calls.some(([, delay]) => delay === 280)) return;
    await sleep(5);
  }
  throw new Error('the outline timer was never started');
}

/** The view with a live camera and a sized video, timers for the outline faked. */
async function renderLive(overrides: Partial<CameraViewProps> = {}) {
  const view = renderView(overrides);
  await outlineTimerStarted();
  sizeVideo(video(), FRAME_W, FRAME_H);
  return view;
}

/** One outline tick. */
function tick() {
  act(() => {
    vi.advanceTimersByTime(280);
  });
}

beforeEach(() => {
  camera = installCamera();
  onPhotos = vi.fn();
  onShowPages = vi.fn();
  frames.next = frameOf(CLOSE);
  frames.sizes.length = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  timers = vi.spyOn(window, 'setInterval');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  camera.remove();
  // The spy wraps the fake clock's `setInterval`: put it back before the clock itself.
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'hidden');
});

describe('CameraView while the camera starts', () => {
  it('says it is starting, then that it is looking for the page, and gives the framing hint', async () => {
    renderView();
    expect(screen.getByText('Starting the camera…')).toBeTruthy();
    expect(shutter().hasAttribute('disabled')).toBe(true);
    await screen.findByText('Looking for the page…');
    expect(screen.queryByText('Starting the camera…')).toBeNull();
    expect(screen.getByText('Lay the document on a plain surface and fit it in the frame.')).toBeTruthy();
    expect(shutter().hasAttribute('disabled')).toBe(false);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('stops the camera when the view is left', async () => {
    const view = await renderLive();
    view.unmount();
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
  });
});

describe('CameraView problems', () => {
  it.each([
    ['NotAllowedError', 'Camera permission was not granted.'],
    ['NotFoundError', 'No camera was found on this device.'],
    ['NotReadableError', 'The camera is in use by another application.'],
    ['SomethingElse', 'The camera could not be started.'],
  ])('explains a %s refusal and offers to try again', async (name, message) => {
    camera.getUserMedia.mockRejectedValueOnce(new DOMException('refused', name));
    renderView();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(message)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(shutter().hasAttribute('disabled')).toBe(true);
  });

  it('starts the camera again, on the same device, when asked to try again', async () => {
    camera.getUserMedia.mockRejectedValueOnce(new DOMException('refused', 'NotAllowedError'));
    renderView();
    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('Looking for the page…');
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells an insecure page why, with no way to retry', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    renderView();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The camera only opens on a secure connection (https).')).toBeTruthy();
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('tells a browser without camera access so, with no way to retry', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    renderView();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('This browser does not support camera access.')).toBeTruthy();
    expect(within(alert).getByText('You can continue by picking photos below.')).toBeTruthy();
    expect(within(alert).queryByRole('button')).toBeNull();
  });
});

describe('CameraView live outline', () => {
  it('outlines the page the detector finds in a 400 px copy of the frame', async () => {
    await renderLive();
    expect(screen.queryByTestId('scan-live-outline')).toBeNull();
    tick();
    expect(frames.sizes).toEqual([400]);
    expectDrawn(found(CLOSE));
    expect(screen.getByText('Page found')).toBeTruthy();
  });

  it('settles: a page that moved a little is drawn between where it was and where it is now', async () => {
    await renderLive();
    tick();
    const before = drawn();
    const after = found(NEARBY);
    frames.next = frameOf(NEARBY);
    tick();
    expectDrawn(
      before.map(([x, y], index) => [
        0.55 * x + 0.45 * (after[index]?.[0] as number),
        0.55 * y + 0.45 * (after[index]?.[1] as number),
      ]),
    );
  });

  it('follows a page that was moved far, at once', async () => {
    await renderLive();
    tick();
    frames.next = frameOf(FAR);
    tick();
    expectDrawn(found(FAR));
  });

  it('lets go of the outline after three frames without a page', async () => {
    await renderLive();
    tick();
    frames.next = rasterOf('plain', FRAME_W, FRAME_H);
    tick();
    tick();
    expect(screen.getByTestId('scan-live-outline')).toBeTruthy();
    tick();
    expect(screen.queryByTestId('scan-live-outline')).toBeNull();
    expect(screen.getByText('Looking for the page…')).toBeTruthy();
  });

  it('counts the misses again from the next page it finds', async () => {
    await renderLive();
    tick();
    frames.next = rasterOf('plain', FRAME_W, FRAME_H);
    tick();
    tick();
    frames.next = frameOf(CLOSE);
    tick();
    frames.next = rasterOf('plain', FRAME_W, FRAME_H);
    tick();
    tick();
    expect(screen.getByTestId('scan-live-outline')).toBeTruthy();
  });

  it('shows no outline while nothing has ever been found, however many frames pass', async () => {
    frames.next = rasterOf('plain', FRAME_W, FRAME_H);
    await renderLive();
    tick();
    tick();
    tick();
    tick();
    expect(screen.queryByTestId('scan-live-outline')).toBeNull();
    expect(screen.getByText('Looking for the page…')).toBeTruthy();
  });

  it('does nothing for a frame the video has not produced yet', async () => {
    frames.next = frameOf(CLOSE);
    renderView();
    await outlineTimerStarted();
    sizeVideo(video(), FRAME_W, FRAME_H, 1);
    tick();
    expect(frames.sizes).toEqual([]);
    expect(screen.queryByTestId('scan-live-outline')).toBeNull();
  });

  it('does nothing while the page is hidden', async () => {
    await renderLive();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    tick();
    expect(frames.sizes).toEqual([]);
    expect(screen.queryByTestId('scan-live-outline')).toBeNull();
  });

  it('does nothing for a frame that cannot be read', async () => {
    frames.next = null;
    await renderLive();
    tick();
    expect(frames.sizes).toEqual([400]);
    expect(screen.queryByTestId('scan-live-outline')).toBeNull();
  });

  it('stops outlining when the view is left', async () => {
    const view = await renderLive();
    view.unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(frames.sizes).toEqual([]);
  });
});

/**
 * Renders after the view in the same tree; when the tree is removed, its layout cleanup runs
 * once React has detached the video's ref but before the view's own effect cleanup has
 * cleared the timer — the moment the outline timer can fire with no video.
 */
function TimerFiresOnLeave() {
  useLayoutEffect(
    () => () => {
      vi.advanceTimersByTime(280);
    },
    [],
  );
  return null;
}

describe('CameraView leaving while the outline timer is due', () => {
  it('lets a tick that lands after the video is detached pass, without reading a frame', async () => {
    const view = render(
      <>
        <CameraView t={t} onPhotos={onPhotos} pageCount={0} onShowPages={onShowPages} disabled={false} />
        <TimerFiresOnLeave />
      </>,
    );
    await outlineTimerStarted();
    sizeVideo(video(), FRAME_W, FRAME_H);
    expect(() => view.unmount()).not.toThrow();
    expect(frames.sizes).toEqual([]);
    expect(camera.track.stop).toHaveBeenCalledTimes(1);
  });
});

describe('CameraView picture shape', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480);
  });

  const stageBox = () => video().parentElement as HTMLElement;

  it('fits a 4:3 picture until the video says its size, then the video’s own shape', async () => {
    await renderLive();
    expect(stageBox().style.width).toBe('480px');
    expect(stageBox().style.height).toBe('360px');
    sizeVideo(video(), 1920, 1080);
    fireEvent(video(), new Event('loadedmetadata'));
    await waitFor(() => expect(stageBox().style.height).toBe('270px'));
    expect(stageBox().style.width).toBe('480px');
  });

  it('follows the video when its size changes', async () => {
    await renderLive();
    sizeVideo(video(), 1080, 1920);
    fireEvent(video(), new Event('resize'));
    await waitFor(() => expect(stageBox().style.width).toBe('270px'));
    expect(stageBox().style.height).toBe('480px');
  });

  it('keeps the shape it has while the video reports no size', async () => {
    await renderLive();
    sizeVideo(video(), 0, 0);
    fireEvent(video(), new Event('loadedmetadata'));
    fireEvent(video(), new Event('resize'));
    expect(stageBox().style.height).toBe('360px');
  });

  it('keeps the shape it has while the video reports a width but no height', async () => {
    await renderLive();
    sizeVideo(video(), 1280, 0);
    fireEvent(video(), new Event('resize'));
    expect(stageBox().style.height).toBe('360px');
  });
});

describe('CameraView shutter', () => {
  it('hands the still, named after the moment it was taken, to the caller', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const still = new Blob(['still'], { type: 'image/jpeg' });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => done(still));
    await renderLive();
    fireEvent.click(shutter());
    await waitFor(() => expect(onPhotos).toHaveBeenCalledTimes(1));
    expect(onPhotos).toHaveBeenCalledWith([{ blob: still, name: 'camera-1700000000000.jpg' }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is unavailable while the photo is being taken', async () => {
    const still = Promise.withResolvers<Blob | null>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => {
      void still.promise.then(done);
    });
    await renderLive();
    fireEvent.click(shutter());
    await waitFor(() => expect(shutter().hasAttribute('disabled')).toBe(true));
    await act(async () => {
      still.resolve(new Blob(['still']));
    });
    await waitFor(() => expect(shutter().hasAttribute('disabled')).toBe(false));
    expect(onPhotos).toHaveBeenCalledTimes(1);
  });

  it('says so when the photo could not be taken, and keeps the camera for another try', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await renderLive();
    fireEvent.click(shutter());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The photo could not be taken. Try again.');
    expect(onPhotos).not.toHaveBeenCalled();
    expect(shutter().hasAttribute('disabled')).toBe(false);
  });

  it('clears the earlier failure when the next photo is taken', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await renderLive();
    fireEvent.click(shutter());
    await screen.findByRole('alert');
    getContext.mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => done(new Blob(['ok'])));
    fireEvent.click(shutter());
    await waitFor(() => expect(onPhotos).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('is unavailable while the dialog is busy', async () => {
    await renderLive({ disabled: true });
    expect(shutter().hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Choose photos' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('CameraView photos from files', () => {
  const input = () => screen.getByTestId('scan-file-input') as HTMLInputElement;

  it('hands the chosen files, with their names, to the caller', async () => {
    renderView();
    const first = new File(['one'], 'one.jpg', { type: 'image/jpeg' });
    const second = new File(['two'], 'two.png', { type: 'image/png' });
    await userEvent.setup({ document }).upload(input(), [first, second]);
    expect(onPhotos).toHaveBeenCalledWith([
      { blob: first, name: 'one.jpg' },
      { blob: second, name: 'two.png' },
    ]);
    // The same file can be chosen again.
    expect(input().value).toBe('');
  });

  it('hands over nothing when the chooser is closed with no file', () => {
    renderView();
    fireEvent.change(input(), { target: { files: [] } });
    expect(onPhotos).not.toHaveBeenCalled();
  });

  it('hands over nothing when the change event carries no file list', () => {
    renderView();
    fireEvent.change(input(), { target: { files: null } });
    expect(onPhotos).not.toHaveBeenCalled();
  });

  it('opens the file chooser from the button', () => {
    renderView();
    const click = vi.spyOn(input(), 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Choose photos' }));
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('CameraView pages', () => {
  it('counts the pages and is unavailable while there are none', () => {
    renderView();
    const button = screen.getByRole('button', { name: 'Pages (0)' });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('goes to the pages when there are some', () => {
    renderView({ pageCount: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Pages (3)' }));
    expect(onShowPages).toHaveBeenCalledTimes(1);
  });

  it('is unavailable while the dialog is busy', () => {
    renderView({ pageCount: 3, disabled: true });
    expect(screen.getByRole('button', { name: 'Pages (3)' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('CameraView camera list', () => {
  it('offers no list for a single camera', async () => {
    camera.enumerateDevices.mockResolvedValue([FRONT_CAMERA]);
    await renderLive();
    expect(screen.queryByText('Camera')).toBeNull();
  });

  it('lists the cameras, shows the one in use, and restarts on the one picked', async () => {
    await renderLive();
    const picker = screen.getByRole('combobox', { name: 'Camera' });
    expect(picker.textContent).toContain('Back camera');
    camera.settings = { deviceId: 'front', width: 640, height: 480 };
    const user = userEvent.setup({ document });
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'Front camera' }));
    await waitFor(() => expect(picker.textContent).toContain('Front camera'));
    expect(camera.getUserMedia).toHaveBeenLastCalledWith({
      video: { width: { ideal: 4096 }, height: { ideal: 3072 }, deviceId: { exact: 'front' } },
      audio: false,
    });
  });

  it('keeps the camera running when the one in use is picked again', async () => {
    await renderLive();
    const user = userEvent.setup({ document });
    await user.click(screen.getByRole('combobox', { name: 'Camera' }));
    await user.click(await screen.findByRole('option', { name: 'Back camera' }));
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('names the device by its id when the list does not hold it', async () => {
    camera.settings = { deviceId: 'unlisted', width: 640, height: 480 };
    await renderLive();
    expect(screen.getByRole('combobox', { name: 'Camera' }).textContent).toContain('unlisted');
  });
});
