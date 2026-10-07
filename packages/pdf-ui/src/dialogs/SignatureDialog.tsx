/**
 * The simple-signature dialog: draw, type or photograph a signature (or initials), then
 * place it on the page.
 *
 * It produces a picture, nothing more — `StampSource`, a trimmed PNG — and the shell places
 * it as a `/Stamp` annotation (`pdf-core/ops/image-stamp.ts`). The dialog says so in plain
 * words: a picture of a signature is not a certified digital signature, and the certificate
 * signing stays where it was (`ops/sign.ts`).
 *
 * Remembering a signature is opt-in and local: the shell keeps the picture in this browser
 * only (`apps/web/src/signature-store.ts`) when the box is ticked, and every remembered
 * entry can be used or deleted from the top of this dialog.
 */

import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { Translator } from 'pdf-shared';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';
import {
  bytesOfDataUrl,
  HANDWRITING_FACES,
  INK_COLORS,
  type InkColor,
  inkFromPhoto,
  loadHandwritingFonts,
  type SavedSignature,
  type StampSource,
  trimmedPng,
} from '../ops/stamp-source';

export interface SignatureDialogProps {
  readonly t: Translator;
  readonly saved: readonly SavedSignature[];
  /** `false` in a sensitive session: nothing is stored, so the box is not offered. */
  readonly canRemember?: boolean;
  readonly onClose: () => void;
  /** The picture to place, and whether the user asked to remember it on this device. */
  readonly onPlace: (source: StampSource, remember: boolean) => void;
  readonly onForget: (id: string) => void;
}

type Tab = 'draw' | 'type' | 'upload';
type Role = 'signature' | 'initials';

/** The drawing surface's own pixels; the canvas is scaled to the dialog by CSS. */
const PAD_WIDTH = 1200;
const PAD_HEIGHT = 400;

interface StrokePoint {
  readonly x: number;
  readonly y: number;
  readonly time: number;
}

/**
 * Smooth strokes whose width follows the pen's speed: quadratic segments through the
 * midpoints of the sampled points (so a stroke has no corners where the samples are), each
 * a little thinner when the hand moved fast — the way ink behaves.
 */
function paintStrokes(
  context: CanvasRenderingContext2D,
  strokes: readonly StrokePoint[][],
  color: string,
): void {
  context.clearRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const MAX = 7;
  const MIN = 2.5;
  for (const stroke of strokes) {
    const first = stroke[0];
    if (first === undefined) continue;
    if (stroke.length === 1) {
      context.beginPath();
      context.arc(first.x, first.y, MAX / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    let width = MAX;
    let from = first;
    for (let index = 1; index < stroke.length; index += 1) {
      const point = stroke[index] as StrokePoint;
      const next = stroke[index + 1];
      const end =
        next === undefined
          ? point
          : { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2, time: point.time };
      const previous = stroke[index - 1] as StrokePoint;
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const speed = distance / Math.max(point.time - previous.time, 1);
      const target = Math.max(MIN, MAX - speed * 1.6);
      width = width * 0.7 + target * 0.3;
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.quadraticCurveTo(point.x, point.y, end.x, end.y);
      context.stroke();
      from = end;
    }
  }
}

/** A typed name in a handwriting face, as large as fits the pad. */
function paintTyped(context: CanvasRenderingContext2D, text: string, family: string, color: string): void {
  context.clearRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
  const value = text.trim();
  if (value === '') return;
  let size = 220;
  context.font = `${size}px "${family}", cursive`;
  const measured = context.measureText(value).width;
  if (measured > PAD_WIDTH * 0.9) size = Math.max(24, Math.floor((size * PAD_WIDTH * 0.9) / measured));
  context.font = `${size}px "${family}", cursive`;
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(value, PAD_WIDTH / 2, PAD_HEIGHT / 2);
}

export function SignatureDialog({
  t,
  saved,
  canRemember = true,
  onClose,
  onPlace,
  onForget,
}: SignatureDialogProps) {
  const [tab, setTab] = useState<Tab>('draw');
  const [role, setRole] = useState<Role>('signature');
  const [ink, setInk] = useState<InkColor>('black');
  const [name, setName] = useState('');
  const [face, setFace] = useState<(typeof HANDWRITING_FACES)[number]['id']>('dancing');
  const [photo, setPhoto] = useState<File | null>(null);
  const [threshold, setThreshold] = useState(70);
  const [photoSource, setPhotoSource] = useState<StampSource | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const padRef = useRef<HTMLCanvasElement | null>(null);
  const typedRef = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<StrokePoint[][]>([]);
  const drawing = useRef(false);
  const fileId = useId();
  const color = INK_COLORS[ink];

  useEffect(() => {
    void loadHandwritingFonts().then(() => setFontsReady(true));
  }, []);

  const repaintPad = useCallback(() => {
    const context = padRef.current?.getContext('2d');
    if (context) paintStrokes(context, strokes.current, color);
  }, [color]);

  useEffect(() => {
    if (tab === 'draw') repaintPad();
  }, [repaintPad, tab]);

  useEffect(() => {
    if (tab !== 'type') return;
    const context = typedRef.current?.getContext('2d');
    // A canvas does not repaint when a face finishes loading, so the generic face stands
    // in until the handwriting faces are ready and this effect runs again.
    const family = fontsReady
      ? (HANDWRITING_FACES.find((item) => item.id === face)?.family ?? 'cursive')
      : 'cursive';
    if (context) paintTyped(context, name, family, color);
  }, [color, face, fontsReady, name, tab]);

  useEffect(() => {
    if (photo === null) {
      setPhotoSource(null);
      return;
    }
    let cancelled = false;
    setPhotoError(null);
    inkFromPhoto(photo, threshold, color, role)
      .then((source) => {
        if (!cancelled) setPhotoSource(source);
      })
      .catch(() => {
        if (!cancelled) {
          setPhotoSource(null);
          setPhotoError(t('sig.upload.failed', { name: photo.name }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [color, photo, role, t, threshold]);

  const padPoint = (event: ReactPointerEvent<HTMLCanvasElement>): StrokePoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * PAD_WIDTH,
      y: ((event.clientY - bounds.top) / bounds.height) * PAD_HEIGHT,
      time: event.timeStamp,
    };
  };

  const ready = tab === 'draw' ? strokeCount > 0 : tab === 'type' ? name.trim() !== '' : photoSource !== null;

  const place = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let source: StampSource | null = null;
      if (tab === 'draw' && padRef.current) source = await trimmedPng(padRef.current, role);
      if (tab === 'type' && typedRef.current) source = await trimmedPng(typedRef.current, role);
      if (tab === 'upload') source = photoSource === null ? null : { ...photoSource, role };
      if (source !== null) onPlace(source, canRemember && remember);
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (value: Role) => t(value === 'signature' ? 'sig.role.signature' : 'sig.role.initials');
  const tabs: readonly { readonly id: Tab; readonly label: string }[] = [
    { id: 'draw', label: t('sig.tab.draw') },
    { id: 'type', label: t('sig.tab.type') },
    { id: 'upload', label: t('sig.tab.upload') },
  ];

  return (
    <Dialog.Root
      open
      // The shell opens the dialog (it has no trigger), so the popup only ever asks to close.
      onOpenChange={(_open, details) => {
        details.cancel();
        onClose();
      }}
    >
      <Dialog
        size="lg"
        className="pdf-floating-shadow flex max-h-[90vh] w-full flex-col gap-3 overflow-y-auto p-5"
      >
        <Dialog.Title className="text-sm font-semibold text-kumo-strong">
          {t('sig.dialog.title')}
        </Dialog.Title>
        <Dialog.Description className="text-xs text-kumo-subtle">{t('sig.dialog.intro')}</Dialog.Description>

        {saved.length > 0 ? (
          <section aria-label={t('sig.saved')} className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold tracking-wider text-kumo-subtle uppercase">
              {t('sig.saved')}
            </h3>
            <ul className="flex flex-wrap gap-2">
              {saved.map((item) => {
                const label = roleLabel(item.role);
                return (
                  <li
                    key={item.id}
                    className="flex items-center gap-1 rounded-md border border-kumo-line bg-white p-1"
                  >
                    <button
                      type="button"
                      aria-label={t('sig.saved.use', { label })}
                      className="flex h-10 w-28 items-center justify-center rounded hover:bg-kumo-tint"
                      onClick={() =>
                        onPlace(
                          {
                            role: item.role,
                            bytes: bytesOfDataUrl(item.dataUrl),
                            dataUrl: item.dataUrl,
                            pixelWidth: item.width,
                            pixelHeight: item.height,
                          },
                          false,
                        )
                      }
                    >
                      <img src={item.dataUrl} alt="" className="max-h-9 max-w-26 object-contain" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('sig.saved.delete', { label })}
                      className="rounded px-1 text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-danger"
                      onClick={() => onForget(item.id)}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label={t('sig.dialog.title')}
            className="flex gap-1 rounded-md bg-kumo-recessed p-0.5"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  tab === item.id
                    ? 'bg-kumo-base text-kumo-strong shadow-sm'
                    : 'text-kumo-subtle hover:text-kumo-default'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <fieldset className="flex items-center gap-3 text-xs text-kumo-default">
            <legend className="sr-only">{t('sig.role')}</legend>
            {(['signature', 'initials'] as const).map((value) => (
              <label key={value} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="sig-role"
                  checked={role === value}
                  onChange={() => setRole(value)}
                />
                {roleLabel(value)}
              </label>
            ))}
          </fieldset>
        </div>

        {tab === 'draw' ? (
          <div className="flex flex-col gap-1.5">
            <canvas
              ref={padRef}
              width={PAD_WIDTH}
              height={PAD_HEIGHT}
              role="img"
              aria-label={t('sig.draw.area')}
              className="aspect-[3/1] w-full touch-none rounded-md border border-dashed border-kumo-line bg-white"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drawing.current = true;
                strokes.current = [...strokes.current, [padPoint(event)]];
                repaintPad();
              }}
              onPointerMove={(event) => {
                if (!drawing.current) return;
                const current = strokes.current[strokes.current.length - 1];
                if (current === undefined) return;
                const samples =
                  typeof event.nativeEvent.getCoalescedEvents === 'function'
                    ? event.nativeEvent.getCoalescedEvents()
                    : [event.nativeEvent];
                const bounds = event.currentTarget.getBoundingClientRect();
                for (const sample of samples) {
                  current.push({
                    x: ((sample.clientX - bounds.left) / bounds.width) * PAD_WIDTH,
                    y: ((sample.clientY - bounds.top) / bounds.height) * PAD_HEIGHT,
                    time: sample.timeStamp,
                  });
                }
                repaintPad();
              }}
              onPointerUp={() => {
                if (!drawing.current) return;
                drawing.current = false;
                setStrokeCount(strokes.current.length);
              }}
              onPointerCancel={() => {
                drawing.current = false;
                setStrokeCount(strokes.current.length);
              }}
            />
            <div className="flex items-center justify-between text-[11px] text-kumo-subtle">
              <span>{t('sig.draw.hint')}</span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="hover:text-kumo-strong disabled:opacity-40"
                  disabled={strokeCount === 0}
                  onClick={() => {
                    strokes.current = strokes.current.slice(0, -1);
                    setStrokeCount(strokes.current.length);
                    repaintPad();
                  }}
                >
                  {t('sig.draw.undo')}
                </button>
                <button
                  type="button"
                  className="hover:text-kumo-strong disabled:opacity-40"
                  disabled={strokeCount === 0}
                  onClick={() => {
                    strokes.current = [];
                    setStrokeCount(0);
                    repaintPad();
                  }}
                >
                  {t('sig.draw.clear')}
                </button>
              </span>
            </div>
          </div>
        ) : null}

        {tab === 'type' ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-kumo-default">
                {t('sig.type.label')}
                <input
                  type="text"
                  value={name}
                  maxLength={80}
                  autoComplete="name"
                  placeholder={t('sig.type.placeholder')}
                  onChange={(event) => setName(event.target.value)}
                  className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm focus:border-kumo-focus focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-kumo-default">
                {t('sig.type.font')}
                <select
                  value={face}
                  onChange={(event) => setFace(event.target.value as typeof face)}
                  className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm focus:border-kumo-focus focus:outline-none"
                >
                  {HANDWRITING_FACES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <canvas
              ref={typedRef}
              width={PAD_WIDTH}
              height={PAD_HEIGHT}
              role="img"
              aria-label={t('sig.preview')}
              className="aspect-[3/1] w-full rounded-md border border-dashed border-kumo-line bg-white"
            />
          </div>
        ) : null}

        {tab === 'upload' ? (
          <div className="flex flex-col gap-2">
            <label
              htmlFor={fileId}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-kumo-line bg-kumo-recessed/40 px-3 py-2 text-xs hover:border-kumo-focus"
            >
              <span className="rounded-sm border border-kumo-line bg-kumo-base px-2 py-0.5 font-medium">
                {t('sig.upload.choose')}
              </span>
              <span className="min-w-0 truncate text-kumo-subtle">
                {photo?.name ?? t('dialog.field.noFile')}
              </span>
              <input
                id={fileId}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(event) => {
                  setPhoto(event.target.files?.[0] ?? null);
                  event.target.value = '';
                }}
              />
            </label>
            <p className="text-[11px] text-kumo-subtle">{t('sig.upload.hint')}</p>
            <label className="flex items-center gap-2 text-xs text-kumo-default">
              {t('sig.upload.threshold')}
              <input
                type="range"
                min={20}
                max={95}
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
                className="flex-1"
              />
            </label>
            <div className="flex aspect-[3/1] w-full items-center justify-center rounded-md border border-dashed border-kumo-line bg-white">
              {photoSource === null ? (
                <span className="text-[11px] text-kumo-subtle">{photoError ?? t('sig.preview')}</span>
              ) : (
                <img
                  src={photoSource.dataUrl}
                  alt={t('sig.preview')}
                  className="max-h-full max-w-full object-contain"
                />
              )}
            </div>
          </div>
        ) : null}

        <fieldset className="flex flex-wrap items-center gap-3 text-xs text-kumo-default">
          <legend className="sr-only">{t('sig.color')}</legend>
          <span>{t('sig.color')}</span>
          {(Object.keys(INK_COLORS) as InkColor[]).map((value) => (
            <label key={value} className="flex items-center gap-1">
              <input type="radio" name="sig-ink" checked={ink === value} onChange={() => setInk(value)} />
              <span
                aria-hidden="true"
                className="inline-block size-3 rounded-full"
                style={{ background: INK_COLORS[value] }}
              />
              {t(`sig.color.${value}`)}
            </label>
          ))}
        </fieldset>

        {canRemember ? (
          <label className="flex items-start gap-2 text-xs text-kumo-default">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>
              {t('sig.remember')}
              <span className="block text-[11px] text-kumo-subtle">{t('sig.remember.hint')}</span>
            </span>
          </label>
        ) : null}

        <p className="rounded-md bg-kumo-recessed px-3 py-2 text-[11px] text-kumo-subtle">
          {t('sig.notCertified')}
        </p>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line/60 pt-3">
          {ready ? null : <span className="me-auto text-[11px] text-kumo-subtle">{t('sig.empty')}</span>}
          <Button size="sm" variant="outline" onClick={onClose}>
            {t('sig.cancel')}
          </Button>
          <Button size="sm" variant="primary" disabled={!ready || busy} onClick={() => void place()}>
            {t('sig.place')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
