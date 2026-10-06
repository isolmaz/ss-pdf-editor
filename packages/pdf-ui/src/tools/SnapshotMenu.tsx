import { Copy, DownloadSimple } from '@phosphor-icons/react';
import { ToolError, type Translator, toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { findViewerDom, pagesInView, type ViewerDom } from './viewer-dom';
import './tools.css';

/**
 * View snapshot: the pages the viewport shows right now,
 * composed into one PNG, ready for the clipboard or a file.
 *
 * The bitmap is the viewer's **own render pipeline output** — the canvases pdf.js
 * already painted, at `devicePixelRatio × scale` device pixels — instead of a
 * second render call from a component (engines are reached through
 * the pane, never directly). Pages are placed where pdf.js laid them out, so
 * spreads, margins and the page gap come out the way they look on screen.
 *
 * Both actions report through `onNotice` with the shell's dictionary text; a
 * failure becomes the `ToolError` contract the shell already renders rather than
 * a raw English message.
 */

/**
 * Blob URLs are revoked once the download has started; the same
 * delay the shell's Export uses gives the browser time to pick the file up.
 */
const REVOKE_DELAY_MS = 10_000;

export interface SnapshotMenuProps {
  readonly viewer: ViewerApi | null;
  readonly open: boolean;
  readonly onClose: () => void;
  /** The interface language's translator: the panel's words follow the shell's locale. */
  readonly t: Translator;
  /** The shell's notice line (`App.tsx` state) — receives already-translated text. */
  readonly onNotice?: (message: string) => void;
}

type SnapshotState =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'ready'; readonly blob: Blob; readonly name: string }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * The clipboard action exists only where the async clipboard can take a PNG;
 * without it the action is absent rather than broken.
 */
function canCopyImage(): boolean {
  return typeof ClipboardItem === 'function' && typeof navigator.clipboard?.write === 'function';
}

/** A rejected clipboard write is a real failure — permission, or no clipboard at all. */
function copyFailure(error: unknown): ToolError {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return new ToolError(
      'permission-denied',
      { engine: 'ui', engineMessage: error.message },
      { cause: error },
    );
  }
  return toToolError(error, 'ui');
}

/**
 * Canvas has no CSS colour resolution of its own, so a token is resolved through
 * a probe element: the paper behind the pages stays the theme's paper in light
 * and dark alike (the token layer is the only colour vocabulary).
 */
function tokenColour(token: string): string {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  probe.style.display = 'none';
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

/**
 * Draws every page the viewport shows into `target`, stacked top to bottom at
 * the viewer's own spacing. The composite is `devicePixelRatio × scale` — the
 * resolution pdf.js painted at — so each page is a 1:1 blit.
 */
function composeView(dom: ViewerDom, target: HTMLCanvasElement): { readonly page: number } | null {
  const images = pagesInView(dom);
  const first = images[0];
  if (first === undefined) return null;

  let left = first.rect.left;
  let top = first.rect.top;
  let right = first.rect.right;
  let bottom = first.rect.bottom;
  for (const image of images) {
    left = Math.min(left, image.rect.left);
    top = Math.min(top, image.rect.top);
    right = Math.max(right, image.rect.right);
    bottom = Math.max(bottom, image.rect.bottom);
  }

  const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  target.width = Math.max(1, Math.round((right - left) * dpr));
  target.height = Math.max(1, Math.round((bottom - top) * dpr));
  const context = target.getContext('2d');
  if (context === null) return null;
  context.fillStyle = tokenColour('--color-pdf-paper');
  context.fillRect(0, 0, target.width, target.height);
  for (const image of images) {
    context.drawImage(
      image.canvas,
      (image.rect.left - left) * dpr,
      (image.rect.top - top) * dpr,
      image.rect.width * dpr,
      image.rect.height * dpr,
    );
  }
  return { page: first.index };
}

/** File name for a capture: the page it starts on, and when it was taken. */
function snapshotName(page: number, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `snapshot-${page + 1}-${stamp}.png`;
}

export function SnapshotMenu({ viewer, open, onClose, t, onNotice }: SnapshotMenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const urlsRef = useRef(new Set<string>());
  const timersRef = useRef(new Set<number>());
  const [snapshot, setSnapshot] = useState<SnapshotState>({ kind: 'preparing' });
  const visible = open && viewer !== null;

  // The callbacks live in a ref: composing a capture must run once per open, not
  // every time the shell re-renders with a fresh arrow function.
  const handlers = useRef({ onClose, onNotice, t });
  useEffect(() => {
    handlers.current = { onClose, onNotice, t };
  });

  const releaseUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current.clear();
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current.clear();
  }, []);
  useEffect(() => releaseUrls, [releaseUrls]);

  const notice = useCallback((message: string) => {
    const { onNotice: report, onClose: close } = handlers.current;
    if (report === undefined) {
      // No notice channel: the panel carries the message so nothing fails silently.
      setSnapshot({ kind: 'failed', message });
      return;
    }
    report(message);
    close();
  }, []);

  useEffect(() => {
    if (!visible || viewer === null) return undefined;
    const target = previewRef.current;
    if (target === null) return undefined;

    const controller = new AbortController();
    setSnapshot({ kind: 'preparing' });
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      notice(handlers.current.t(toToolError(error, 'ui').messageKey));
    };

    try {
      const dom = findViewerDom(viewer);
      const capture = dom === null ? null : composeView(dom, target);
      if (capture === null) {
        fail(new ToolError('internal', { engine: 'ui', engineMessage: 'no rendered page in the viewport' }));
      } else {
        target.toBlob((blob) => {
          if (controller.signal.aborted) return; // closed while the encoder ran
          if (blob === null) {
            fail(new ToolError('internal', { engine: 'ui', engineMessage: 'canvas.toBlob returned null' }));
            return;
          }
          setSnapshot({ kind: 'ready', blob, name: snapshotName(capture.page, new Date()) });
        }, 'image/png');
      }
    } catch (error) {
      fail(error);
    }

    return () => {
      controller.abort();
      // A full-view capture is tens of megabytes: free it with the panel.
      target.width = 0;
      target.height = 0;
    };
  }, [visible, viewer, notice]);

  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      handlers.current.onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel === null || !(event.target instanceof Node) || panel.contains(event.target)) return;
      handlers.current.onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [visible]);

  const copyToClipboard = useCallback(async () => {
    if (snapshot.kind !== 'ready') return;
    const blob = snapshot.blob;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notice(handlers.current.t('tools.snapshotCopied'));
    } catch (error) {
      notice(handlers.current.t(copyFailure(error).messageKey));
    }
  }, [snapshot, notice]);

  const download = useCallback(() => {
    if (snapshot.kind !== 'ready') return;
    const url = URL.createObjectURL(snapshot.blob);
    urlsRef.current.add(url);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = snapshot.name;
    anchor.click();
    // Revoked once the download has started; the timer is tracked, so closing or
    // unmounting the panel cannot leave a blob URL behind.
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      urlsRef.current.delete(url);
      timersRef.current.delete(timer);
    }, REVOKE_DELAY_MS);
    timersRef.current.add(timer);
    notice(handlers.current.t('tools.snapshotSaved', { name: snapshot.name }));
  }, [snapshot, notice]);

  if (!visible) return null;
  const ready = snapshot.kind === 'ready';

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('tools.snapshot')}
      className="pdf-tools-snapshot pdf-overlay-shadow flex w-64 flex-col gap-2 rounded-md border border-kumo-line bg-kumo-base p-2"
    >
      <p className="text-xs font-semibold text-kumo-strong">{t('tools.snapshot')}</p>
      <canvas ref={previewRef} className="pdf-tools-snapshot-preview self-center rounded-sm" />
      {snapshot.kind === 'failed' ? (
        <p role="status" className="text-xs text-kumo-warning">
          {snapshot.message}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        {canCopyImage() ? (
          <Button icon={Copy} disabled={!ready} onClick={() => void copyToClipboard()}>
            {t('tools.snapshotCopy')}
          </Button>
        ) : null}
        <Button variant="primary" icon={DownloadSimple} disabled={!ready} onClick={download}>
          {t('tools.snapshotDownload')}
        </Button>
      </div>
    </div>
  );
}
