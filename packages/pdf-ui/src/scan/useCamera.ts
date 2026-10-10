/**
 * The camera behind the scanner: permission, device list, a live stream and a still.
 *
 * Why it looks the way it does:
 *  - **Failures have names the user can act on.** `getUserMedia` rejects with a handful
 *    of `DOMException`s; each is mapped to one of the dialog's own messages (denied, no
 *    camera, in use by another application, insecure context, unsupported) rather than
 *    shown raw, and a page that is not a secure context is told so before the browser is
 *    even asked.
 *  - **The rear camera first.** On a phone `facingMode: environment` is the camera that
 *    photographs documents; the user can pick another from the list. The device list is
 *    only filled with names after permission is granted, so it is read after the stream
 *    starts, and the active device is chosen by id from then on.
 *  - **The highest resolution there is.** The stream asks for 4096 px and the browser
 *    gives what the camera has. A still comes from `ImageCapture.takePhoto` when the
 *    camera can take photographs larger than its video (the sensor's full size), and from
 *    the video frame otherwise.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraProblem = 'denied' | 'none' | 'insecure' | 'unsupported' | 'busy' | 'failed';

export interface CameraDevice {
  readonly id: string;
  readonly label: string;
}

export interface CameraState {
  readonly status: 'idle' | 'starting' | 'live' | 'problem';
  readonly problem: CameraProblem | null;
  readonly devices: readonly CameraDevice[];
  readonly deviceId: string | null;
  /** The video's own size, once frames are flowing. */
  readonly size: { readonly width: number; readonly height: number } | null;
}

/** Classify what `getUserMedia` threw. Exported for the dialog's tests and probes. */
export function classifyCameraError(error: unknown): CameraProblem {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'NotSupportedError':
    case 'TypeError':
      return 'unsupported';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'none';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    default:
      return 'failed';
  }
}

/** Why the camera cannot even be asked, or `null` when it can. */
export function cameraUnavailable(): CameraProblem | null {
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure';
  if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
    return 'unsupported';
  }
  return null;
}

interface ImageCaptureLike {
  getPhotoCapabilities(): Promise<{ imageWidth?: { max: number }; imageHeight?: { max: number } }>;
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number }): Promise<Blob>;
}
type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureLike;

export interface UseCamera extends CameraState {
  readonly videoRef: React.RefObject<HTMLVideoElement | null>;
  readonly start: (deviceId?: string | null) => void;
  /** A still of what the camera sees, at the best resolution it offers. */
  readonly capture: () => Promise<Blob>;
}

export function useCamera(): UseCamera {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Bumped by every start and by the unmount, so a slow `getUserMedia` that resolves late is ignored. */
  const generation = useRef(0);
  const [state, setState] = useState<CameraState>({
    status: 'idle',
    problem: null,
    devices: [],
    deviceId: null,
    size: null,
  });

  const release = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream !== null) for (const track of stream.getTracks()) track.stop();
    const video = videoRef.current;
    if (video !== null) video.srcObject = null;
  }, []);

  const start = useCallback(
    (deviceId?: string | null) => {
      generation.current += 1;
      const mine = generation.current;
      release();
      const blocked = cameraUnavailable();
      if (blocked !== null) {
        setState((current) => ({ ...current, status: 'problem', problem: blocked }));
        return;
      }
      setState((current) => ({ ...current, status: 'starting', problem: null }));
      const video: MediaTrackConstraints = {
        width: { ideal: 4096 },
        height: { ideal: 3072 },
        ...(deviceId === undefined || deviceId === null
          ? { facingMode: { ideal: 'environment' } }
          : { deviceId: { exact: deviceId } }),
      };
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
          if (mine !== generation.current) {
            for (const track of stream.getTracks()) track.stop();
            return;
          }
          streamRef.current = stream;
          const element = videoRef.current;
          if (element !== null) {
            element.srcObject = stream;
            await element.play().catch(() => undefined);
          }
          const settings = stream.getVideoTracks()[0]?.getSettings();
          const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
          if (mine !== generation.current) return;
          const devices = all
            .filter((device) => device.kind === 'videoinput')
            .map((device, index) => ({ id: device.deviceId, label: device.label || `${index + 1}` }));
          setState({
            status: 'live',
            problem: null,
            devices,
            deviceId: settings?.deviceId ?? deviceId ?? devices[0]?.id ?? null,
            size:
              settings?.width !== undefined && settings.height !== undefined
                ? { width: settings.width, height: settings.height }
                : null,
          });
        } catch (error) {
          if (mine !== generation.current) return;
          const problem = classifyCameraError(error);
          setState((current) => ({ ...current, status: 'problem', problem }));
        }
      })();
    },
    [release],
  );

  // Never leave a camera running behind a closed dialog.
  useEffect(() => {
    return () => {
      generation.current += 1;
      release();
    };
  }, [release]);

  const capture = useCallback(async (): Promise<Blob> => {
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (video === null || track === undefined) throw new Error('camera is not live');

    const Constructor = (window as unknown as { ImageCapture?: ImageCaptureConstructor }).ImageCapture;
    if (Constructor !== undefined) {
      try {
        const grabber = new Constructor(track);
        const capabilities = await grabber.getPhotoCapabilities();
        const widest = capabilities.imageWidth?.max ?? 0;
        // Only when the sensor's still is clearly larger than the video: a camera whose
        // photo mode is the same size as its video gains nothing from the slower path.
        if (widest > video.videoWidth * 1.25) {
          const photo = await grabber.takePhoto({
            imageWidth: widest,
            ...(capabilities.imageHeight === undefined ? {} : { imageHeight: capabilities.imageHeight.max }),
          });
          if (photo.size > 0) return photo;
        }
      } catch {
        // Expected control flow: a camera without a photo mode, or one that refuses the
        // size, is photographed from its video frame instead.
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2D canvas context');
    context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    canvas.width = 0;
    canvas.height = 0;
    if (blob === null) throw new Error('the frame could not be encoded');
    return blob;
  }, []);

  return { ...state, videoRef, start, capture };
}
