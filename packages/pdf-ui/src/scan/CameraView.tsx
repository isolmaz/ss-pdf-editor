/**
 * The scanner's first screen: the live camera with the page outlined as it is found, a
 * shutter, and a way to pick photos from files instead (a laptop without a camera, a
 * denied permission, a photograph already taken).
 *
 * The camera is started when this view mounts and stopped when it unmounts, so it never
 * runs behind the crop or the page list. The outline is the same detector the photograph
 * gets (`detectPage`), run on a 400 px copy of the current frame a few times a second; its
 * corners are smoothed so the outline does not jitter, and it disappears after a few
 * misses rather than hanging where the page used to be. It is a guide for framing: the
 * corners that count are the ones the user confirms on the photograph.
 */

import { Select } from '@cloudflare/kumo/components/select';
import { Camera, Images, Stack } from '@phosphor-icons/react';
import { frameToRaster } from 'pdf-core/ops/scan-browser';
import { detectPage } from 'pdf-core/ops/scan-detect';
import { type Point, type Quad, scaleQuad } from 'pdf-core/ops/scan-geometry';
import type { MessageKey, Translator } from 'pdf-shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { FittedStage } from './FittedStage';
import { type CameraProblem, useCamera } from './useCamera';

export interface CameraViewProps {
  readonly t: Translator;
  /** A photograph taken, or several chosen from files. */
  readonly onPhotos: (photos: readonly { readonly blob: Blob; readonly name: string }[]) => void;
  readonly pageCount: number;
  readonly onShowPages: () => void;
  readonly disabled: boolean;
}

const PROBLEM_KEYS: Readonly<Record<CameraProblem, { message: MessageKey; hint: MessageKey }>> = {
  denied: { message: 'scan.camera.denied', hint: 'scan.camera.deniedHint' },
  none: { message: 'scan.camera.none', hint: 'scan.camera.noneHint' },
  insecure: { message: 'scan.camera.insecure', hint: 'scan.camera.insecureHint' },
  unsupported: { message: 'scan.camera.unsupported', hint: 'scan.camera.unsupportedHint' },
  busy: { message: 'scan.camera.busy', hint: 'scan.camera.busyHint' },
  failed: { message: 'scan.camera.failed', hint: 'scan.camera.failedHint' },
};

/** How often the outline is recomputed, and how many misses in a row clear it. */
const OUTLINE_INTERVAL_MS = 280;
const OUTLINE_MISSES = 3;

function meanDistance(a: Quad, b: Quad): number {
  let sum = 0;
  for (let index = 0; index < 4; index += 1) {
    sum += Math.hypot(
      (a[index] as Point).x - (b[index] as Point).x,
      (a[index] as Point).y - (b[index] as Point).y,
    );
  }
  return sum / 4;
}

export function CameraView({ t, onPhotos, pageCount, onShowPages, disabled }: CameraViewProps) {
  const camera = useCamera();
  const { start, videoRef } = camera;
  const [aspect, setAspect] = useState(4 / 3);
  const [outline, setOutline] = useState<Quad | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const smoothed = useRef<Quad | null>(null);
  const misses = useRef(0);
  const deviceLabelId = useId();

  useEffect(() => {
    start();
  }, [start]);

  // The live outline.
  useEffect(() => {
    if (camera.status !== 'live') return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (video === null || video.readyState < 2 || document.hidden) return;
      const frame = frameToRaster(video, 400);
      if (frame === null) return;
      const found = detectPage(frame);
      if (found === null) {
        misses.current += 1;
        if (misses.current >= OUTLINE_MISSES && smoothed.current !== null) {
          smoothed.current = null;
          setOutline(null);
        }
        return;
      }
      misses.current = 0;
      const next = scaleQuad(found.quad, 1 / frame.width, 1 / frame.height);
      const previous = smoothed.current;
      // Close to where it was: blend, so the outline settles; far away: the page moved.
      const blended =
        previous !== null && meanDistance(previous, next) < 0.08
          ? (next.map((point, index) => ({
              x: (previous[index] as Point).x * 0.55 + point.x * 0.45,
              y: (previous[index] as Point).y * 0.55 + point.y * 0.45,
            })) as unknown as Quad)
          : next;
      smoothed.current = blended;
      setOutline(blended);
    }, OUTLINE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [camera.status, videoRef]);

  const shoot = async () => {
    if (capturing || disabled) return;
    setCapturing(true);
    setFailure(null);
    try {
      const blob = await camera.capture();
      onPhotos([{ blob, name: `camera-${Date.now()}.jpg` }]);
    } catch {
      setFailure(t('scan.capture.failed'));
    } finally {
      setCapturing(false);
    }
  };

  const problem =
    camera.status === 'problem' && camera.problem !== null ? PROBLEM_KEYS[camera.problem] : null;
  const live = camera.status === 'live';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative min-h-[220px] flex-1 overflow-hidden rounded-md bg-black">
        <FittedStage aspect={aspect} className={`size-full ${problem === null ? '' : 'invisible'}`}>
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label={t('scan.camera.label')}
            className="size-full"
            onLoadedMetadata={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth > 0 && videoHeight > 0) setAspect(videoWidth / videoHeight);
            }}
            onResize={(event) => {
              const { videoWidth, videoHeight } = event.currentTarget;
              if (videoWidth > 0 && videoHeight > 0) setAspect(videoWidth / videoHeight);
            }}
          />
          {outline === null || !live ? null : (
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="pointer-events-none absolute inset-0 size-full"
              aria-hidden="true"
              data-testid="scan-live-outline"
            >
              <polygon
                points={outline.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')}
                fill="rgba(47,111,237,0.18)"
                stroke="#5b9dff"
                strokeWidth={3}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
        </FittedStage>
        {camera.status === 'starting' ? (
          <p
            role="status"
            className="absolute inset-0 flex items-center justify-center text-xs text-white/80"
          >
            {t('scan.camera.starting')}
          </p>
        ) : null}
        {live ? (
          <p
            role="status"
            className="pointer-events-none absolute top-2 left-2 rounded bg-black/55 px-2 py-0.5 text-[11px] text-white"
          >
            {outline === null ? t('scan.live.searching') : t('scan.live.found')}
          </p>
        ) : null}
        {problem === null ? null : (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-kumo-recessed p-4 text-center"
          >
            <p className="text-sm font-semibold text-kumo-strong">{t(problem.message)}</p>
            <p className="max-w-[44ch] text-xs text-kumo-subtle">{t(problem.hint)}</p>
            {camera.problem === 'insecure' || camera.problem === 'unsupported' ? null : (
              <Button onClick={() => start(camera.deviceId)}>{t('scan.camera.retry')}</Button>
            )}
          </div>
        )}
      </div>

      {failure === null ? null : (
        <p role="alert" className="text-xs text-kumo-danger">
          {failure}
        </p>
      )}
      {live ? <p className="text-[11px] text-kumo-subtle">{t('scan.live.hint')}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="outline" disabled={disabled} onClick={() => fileInput.current?.click()}>
            <Images size={16} aria-hidden="true" />
            {t('scan.choose')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-label={t('scan.choose')}
            data-testid="scan-file-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length > 0) onPhotos(files.map((file) => ({ blob: file, name: file.name })));
            }}
          />
          {camera.devices.length > 1 ? (
            <div className="min-w-0 max-w-44">
              <span id={deviceLabelId} className="sr-only">
                {t('scan.camera.select')}
              </span>
              <Select<string>
                size="sm"
                aria-labelledby={deviceLabelId}
                value={camera.deviceId ?? ''}
                renderValue={(value) => camera.devices.find((device) => device.id === value)?.label ?? value}
                onValueChange={(next) => {
                  if (next !== null && next !== camera.deviceId) start(next);
                }}
              >
                {camera.devices.map((device) => (
                  <Select.Option key={device.id} value={device.id}>
                    {device.label}
                  </Select.Option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>

        <Button
          variant="primary"
          aria-label={t('scan.capture')}
          disabled={!live || capturing || disabled}
          onClick={() => void shoot()}
          data-testid="scan-shutter"
        >
          <Camera size={18} weight="fill" aria-hidden="true" />
          {t('scan.capture')}
        </Button>

        <Button variant="outline" disabled={pageCount === 0 || disabled} onClick={onShowPages}>
          <Stack size={16} aria-hidden="true" />
          {t('scan.pages.go', { count: pageCount })}
        </Button>
      </div>
    </div>
  );
}
