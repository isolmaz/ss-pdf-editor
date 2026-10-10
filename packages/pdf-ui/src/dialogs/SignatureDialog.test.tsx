// @vitest-environment happy-dom
/**
 * The simple-signature dialog: drawing, typing or photographing a signature and what it hands
 * to the shell. The canvases are real pixels — every canvas element is backed by the Skia
 * canvas pdf.js itself uses in Node (`skia-canvas.fixtures`) — so the picture that reaches
 * `onPlace` is really drawn, trimmed to its ink and PNG-encoded; only the DOM objects around the
 * pixels (`getContext`, `toBlob`, `createImageBitmap`, a pad that has a size) are stand-ins.
 *
 * The pad is 1200 × 400 canvas pixels shown 600 × 200 CSS pixels at the page's origin, so a
 * client point is half the pad point it draws.
 */

import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSignature, StampSource } from '../ops/stamp-source';
import { skia, skiaImageBitmap } from '../skia-canvas.fixtures';
import { SignatureDialog, type SignatureDialogProps } from './SignatureDialog';

const t = createTranslator('en');

// Everything waited for here (a PNG being encoded, a picture being read, a font loading) is a real
// condition that resolves on its own; the 1 s default of `findBy`/`waitFor` only races a busy machine.
configure({ asyncUtilTimeout: 20000 });

// Real pixel work is inherent to this file: every canvas is a Skia surface, so each drawn stroke, each
// typed character and each picture is really painted and PNG-encoded. Alone a test takes a fraction
// of a second; a loaded CI core several times that.
vi.setConfig({ testTimeout: 30000 });

let user: ReturnType<typeof userEvent.setup>;

beforeAll(async () => {
  // The font test imports a second copy of the dialog (it needs `FontFace` stubbed before the module
  // reads it). Load that graph once here, outside any test's clock, so the transform is cached.
  vi.resetModules();
  await import('./SignatureDialog');
}, 30000);

type Surface = ReturnType<typeof skia.createCanvas>;
const surfaces = new WeakMap<HTMLCanvasElement, Surface>();
/** Every `font` a canvas context was given, in order: which face a typed signature was drawn in. */
let fonts: string[] = [];

/** The Skia surface behind a canvas element, resized when the element was. */
function surfaceOf(element: HTMLCanvasElement): Surface {
  let surface = surfaces.get(element);
  if (surface === undefined) {
    surface = skia.createCanvas(element.width, element.height);
    surfaces.set(element, surface);
  }
  if (surface.width !== element.width) surface.width = element.width;
  if (surface.height !== element.height) surface.height = element.height;
  return surface;
}

/** A 2D context over the element's surface that also accepts another element as a drawing source. */
function contextOf(element: HTMLCanvasElement): unknown {
  const context = surfaceOf(element).getContext('2d') as object;
  return new Proxy(context, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'drawImage') {
        return (source: unknown, ...rest: number[]) =>
          (value as (...args: unknown[]) => void).call(
            target,
            source instanceof HTMLCanvasElement ? surfaceOf(source) : source,
            ...rest,
          );
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === 'font') fonts.push(String(value));
      return Reflect.set(target, property, value);
    },
  });
}

beforeEach(() => {
  // No inter-action timer yield: each action is already awaited.
  user = userEvent.setup({ delay: null });
  fonts = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return contextOf(this);
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    done: BlobCallback,
    type = 'image/png',
  ) {
    done(new Blob([new Uint8Array(surfaceOf(this).toBuffer(type as 'image/png'))], { type }));
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement,
    type = 'image/png',
  ) {
    return surfaceOf(this).toDataURL(type);
  } as never);
  vi.stubGlobal('createImageBitmap', skiaImageBitmap);
  // A pad that has a size, as the page's layout gives it; happy-dom lays nothing out.
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 600,
    bottom: 200,
    width: 600,
    height: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  if (!('setPointerCapture' in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => {},
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function show(overrides: Partial<SignatureDialogProps> = {}) {
  const handlers = { onClose: vi.fn(), onPlace: vi.fn(), onForget: vi.fn() };
  render(<SignatureDialog t={t} saved={[]} {...handlers} {...overrides} />);
  return handlers;
}

const pad = () => screen.getByRole('img', { name: 'Signature drawing area' });
const place = () => screen.getByRole('button', { name: 'Place' }) as HTMLButtonElement;

interface Sample {
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp: number;
}

/**
 * A pointer move on the pad. `coalesced` is what the browser's `getCoalescedEvents()` answers;
 * without it the browser has no coalescing (the property is absent), as older Safari. happy-dom
 * defines the method on every event instance (answering nothing), so the event is dressed here.
 */
function move(x: number, y: number, coalesced?: readonly Sample[]) {
  const event = new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 1, bubbles: true });
  Object.defineProperty(event, 'getCoalescedEvents', {
    configurable: true,
    value: coalesced === undefined ? undefined : () => coalesced,
  });
  act(() => {
    pad().dispatchEvent(event);
  });
}

/** One stroke across the pad, in client points (half of pad points). */
function stroke(points: readonly (readonly [number, number])[]) {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('a stroke needs a first point');
  fireEvent.pointerDown(pad(), { clientX: first[0], clientY: first[1], pointerId: 1 });
  for (const [x, y] of rest) move(x, y);
  fireEvent.pointerUp(pad(), { pointerId: 1 });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The source `onPlace` was called with, and whether the user asked to remember it. */
function placed(onPlace: ReturnType<typeof vi.fn>) {
  expect(onPlace).toHaveBeenCalledTimes(1);
  const [source, remember] = onPlace.mock.calls[0] as [StampSource, boolean];
  return { source, remember };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe('SignatureDialog drawing', () => {
  it('offers nothing to place until something is drawn', () => {
    show();
    expect(place().disabled).toBe(true);
    expect(screen.getByText('Draw, type or choose a signature first.')).toBeTruthy();
    stroke([
      [50, 50],
      [150, 50],
    ]);
    expect(place().disabled).toBe(false);
    expect(screen.queryByText('Draw, type or choose a signature first.')).toBeNull();
  });

  it('places the ink trimmed to its bounds as a PNG, with the signature role', async () => {
    const { onPlace } = show();
    await user.click(screen.getByRole('checkbox', { name: /Remember on this device/ }));
    stroke([
      [100, 50],
      [150, 50],
      [200, 50],
      [300, 50],
    ]);
    await user.click(place());

    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    const { source, remember } = placed(onPlace);
    expect(remember).toBe(true);
    expect(source.role).toBe('signature');
    expect(Array.from(source.bytes.slice(0, 4))).toEqual(PNG_MAGIC);
    expect(source.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    // The stroke spans pad x 200–600 and is about 5 px thick; the trim adds a 12 px margin each side.
    expect(source.pixelWidth).toBeGreaterThanOrEqual(400);
    expect(source.pixelWidth).toBeLessThanOrEqual(440);
    expect(source.pixelHeight).toBeGreaterThanOrEqual(24);
    expect(source.pixelHeight).toBeLessThanOrEqual(40);
  });

  it('draws a single press as a dot', async () => {
    const { onPlace } = show();
    fireEvent.pointerDown(pad(), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(pad(), { pointerId: 1 });
    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    const { source } = placed(onPlace);
    // A 7-pad-point dot plus the margin on each side.
    expect(source.pixelWidth).toBeGreaterThanOrEqual(24);
    expect(source.pixelWidth).toBeLessThanOrEqual(40);
  });

  it('thins the ink where the hand moved fast and keeps it thick where it dwelt', async () => {
    const { onPlace } = show();
    fireEvent.pointerDown(pad(), { clientX: 100, clientY: 100, pointerId: 1 });
    move(102, 100);
    await pause(20);
    move(260, 100);
    fireEvent.pointerUp(pad(), { pointerId: 1 });
    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    expect(placed(onPlace).source.pixelHeight).toBeLessThanOrEqual(34);
  });

  it('ignores a move or a release that is not part of a stroke', () => {
    show();
    move(100, 100);
    fireEvent.pointerUp(pad(), { pointerId: 1 });
    expect(place().disabled).toBe(true);
  });

  it('reads every sample the browser coalesced into one move', async () => {
    const { onPlace } = show();
    fireEvent.pointerDown(pad(), { clientX: 100, clientY: 50, pointerId: 1 });
    move(100, 50, [
      { clientX: 100, clientY: 50, timeStamp: 0 },
      { clientX: 300, clientY: 50, timeStamp: 10 },
    ]);
    fireEvent.pointerUp(pad(), { pointerId: 1 });
    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    // The move event itself stayed at pad x 200; only the coalesced samples reach pad x 600.
    expect(placed(onPlace).source.pixelWidth).toBeGreaterThanOrEqual(400);
  });

  it('keeps a stroke that was cancelled by the browser', () => {
    show();
    fireEvent.pointerDown(pad(), { clientX: 100, clientY: 100, pointerId: 1 });
    move(200, 100);
    fireEvent.pointerCancel(pad(), { pointerId: 1 });
    expect(place().disabled).toBe(false);
  });

  it('undoes the last stroke, then clears them all', () => {
    show();
    stroke([
      [50, 50],
      [100, 50],
    ]);
    stroke([
      [50, 100],
      [100, 100],
    ]);
    const undo = screen.getByRole('button', { name: 'Undo the last stroke' }) as HTMLButtonElement;
    const clear = screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);

    fireEvent.click(undo);
    expect(place().disabled).toBe(false);
    fireEvent.click(undo);
    expect(place().disabled).toBe(true);
    expect(undo.disabled).toBe(true);

    stroke([
      [50, 50],
      [100, 50],
    ]);
    fireEvent.click(clear);
    expect(place().disabled).toBe(true);
    expect(clear.disabled).toBe(true);
  });

  it('adds nothing to a stroke whose strokes were cleared while the pen was still down', async () => {
    const { onPlace } = show();
    stroke([
      [50, 50],
      [100, 50],
    ]);
    fireEvent.pointerDown(pad(), { clientX: 300, clientY: 100, pointerId: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    move(400, 100);
    fireEvent.pointerUp(pad(), { pointerId: 2 });
    expect(place().disabled).toBe(true);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('places nothing, and can be asked again, when everything drawn is off the pad', async () => {
    const { onPlace } = show();
    // The pointer is captured, so a stroke can leave the pad on every side.
    fireEvent.pointerDown(pad(), { clientX: -300, clientY: -300, pointerId: 1 });
    move(-200, -300);
    fireEvent.pointerUp(pad(), { pointerId: 1 });
    expect(place().disabled).toBe(false);

    await user.click(place());
    await waitFor(() => expect(place().disabled).toBe(false));
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('places initials when that role is chosen, in the chosen ink', async () => {
    const { onPlace } = show();
    await user.click(screen.getByRole('radio', { name: 'Initials' }));
    await user.click(screen.getByRole('radio', { name: 'Navy' }));
    stroke([
      [50, 50],
      [150, 50],
    ]);
    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    const { source, remember } = placed(onPlace);
    expect(source.role).toBe('initials');
    expect(remember).toBe(false);
  });

  it('does not offer to remember a signature in a session that stores nothing', () => {
    show({ canRemember: false });
    expect(screen.queryByRole('checkbox', { name: /Remember on this device/ })).toBeNull();
  });

  it('closes from the Cancel button and from Escape, without placing anything', async () => {
    const { onClose, onPlace } = show();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPlace).not.toHaveBeenCalled();
  });
});

describe('SignatureDialog typing', () => {
  const typeTab = () => user.click(screen.getByRole('tab', { name: 'Type' }));

  it('places a typed name as a PNG once there is a name', async () => {
    const { onPlace } = show();
    await typeTab();
    expect(screen.getByRole('tab', { name: 'Type' }).getAttribute('aria-selected')).toBe('true');
    expect(place().disabled).toBe(true);

    await user.type(screen.getByRole('textbox', { name: 'Full name' }), 'Ada');
    expect(place().disabled).toBe(false);
    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    const { source } = placed(onPlace);
    expect(Array.from(source.bytes.slice(0, 4))).toEqual(PNG_MAGIC);
    expect(source.pixelHeight).toBeGreaterThan(24);
  });

  it('shrinks a long name to fit the pad instead of cutting it off', async () => {
    const { onPlace } = show();
    await typeTab();
    // One change: a keystroke per character would redraw the 1200 × 400 pad 47 times; the name is what matters.
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), {
      target: { value: 'Maximiliana Wolfeschlegelsteinhausenbergerdorff' },
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'Great Vibes');
    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    // 90 % of the pad plus the 12 px margin each side at most.
    expect(placed(onPlace).source.pixelWidth).toBeLessThanOrEqual(1104);
  });

  it('draws in the generic cursive face until the handwriting faces have loaded, then in the chosen one', async () => {
    const loaded: { release: () => void } = { release: () => {} };
    const gate = new Promise<void>((release) => {
      loaded.release = release;
    });
    vi.stubGlobal(
      'FontFace',
      class {
        async load() {
          await gate;
          return this;
        }
      },
    );
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: () => {} } });
    vi.resetModules();
    const fresh = await import('./SignatureDialog');
    render(<fresh.SignatureDialog t={t} saved={[]} onClose={vi.fn()} onPlace={vi.fn()} onForget={vi.fn()} />);
    await typeTab();
    await user.type(screen.getByRole('textbox', { name: 'Full name' }), 'Ada');
    expect(fonts.at(-1)).toBe('220px "cursive", cursive');

    await act(async () => loaded.release());
    await waitFor(() => expect(fonts.at(-1)).toBe('220px "SsSignatureDancing", cursive'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Style' }), 'Great Vibes');
    expect(fonts.at(-1)).toBe('220px "SsSignatureVibes", cursive');
    Reflect.deleteProperty(document, 'fonts');
  });

  it('treats a name of spaces as no name', async () => {
    show();
    await typeTab();
    await user.type(screen.getByRole('textbox', { name: 'Full name' }), '   ');
    expect(place().disabled).toBe(true);
  });
});

describe('SignatureDialog from a picture', () => {
  const uploadTab = () => user.click(screen.getByRole('tab', { name: 'From a picture' }));

  /** A 60 × 20 white picture with a 20 × 10 black mark at (10, 5). */
  function signaturePicture(name = 'sig.png'): File {
    const canvas = skia.createCanvas(60, 20);
    const context = canvas.getContext('2d') as { fillStyle: string; fillRect: (...a: number[]) => void };
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 60, 20);
    context.fillStyle = '#000000';
    context.fillRect(10, 5, 20, 10);
    return new File([new Uint8Array(canvas.toBuffer('image/png'))], name, { type: 'image/png' });
  }

  const chooser = () => document.querySelector('input[type="file"]') as HTMLInputElement;

  it('turns the paper transparent, previews the ink and places it with the chosen role', async () => {
    const { onPlace } = show();
    await uploadTab();
    expect(screen.getByText('No file chosen yet')).toBeTruthy();
    expect(place().disabled).toBe(true);

    await user.upload(chooser(), signaturePicture());
    await screen.findByRole('img', { name: 'Preview' });
    expect(screen.getByText('sig.png')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Initials' }));
    await screen.findByRole('img', { name: 'Preview' });

    await waitFor(() => expect(place().disabled).toBe(false));
    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    const { source } = placed(onPlace);
    expect(source.role).toBe('initials');
    // The 20 × 10 mark plus a 1 px margin each side.
    expect([source.pixelWidth, source.pixelHeight]).toEqual([22, 12]);
  });

  it('re-cuts the picture when the background removal changes', async () => {
    show();
    await uploadTab();
    await user.upload(chooser(), signaturePicture());
    await screen.findByRole('img', { name: 'Preview' });
    fireEvent.change(screen.getByRole('slider'), { target: { value: '30' } });
    await screen.findByRole('img', { name: 'Preview' });
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('30');
  });

  it('says which picture could not be read, and offers nothing to place', async () => {
    show();
    await uploadTab();
    await user.upload(chooser(), new File(['not a picture'], 'broken.png', { type: 'image/png' }));
    expect(await screen.findByText('The picture could not be read: broken.png')).toBeTruthy();
    expect(place().disabled).toBe(true);
  });

  it('drops the picture when the file chooser comes back empty', async () => {
    show();
    await uploadTab();
    await user.upload(chooser(), signaturePicture());
    await screen.findByRole('img', { name: 'Preview' });

    fireEvent.change(chooser(), { target: { files: [] } });
    await waitFor(() => expect(screen.getByText('No file chosen yet')).toBeTruthy());
    expect(place().disabled).toBe(true);
  });

  /** Decoding that holds `first.png` open until the test settles it; every other picture decodes at once. */
  function holdFirstPicture() {
    let settle: { resolve: (bitmap: unknown) => void; reject: (cause: Error) => void } | undefined;
    vi.stubGlobal('createImageBitmap', (blob: File) =>
      blob.name === 'first.png'
        ? new Promise((resolve, reject) => {
            settle = { resolve, reject };
          })
        : skiaImageBitmap(blob),
    );
    return () => {
      if (settle === undefined) throw new Error('the first picture was never decoded');
      return settle;
    };
  }

  it('ignores the failure of a picture that was replaced before it was read', async () => {
    show();
    await uploadTab();
    const first = holdFirstPicture();
    await user.upload(chooser(), signaturePicture('first.png'));
    await user.upload(chooser(), signaturePicture('second.png'));
    await screen.findByRole('img', { name: 'Preview' });

    await act(async () => first().reject(new Error('undecodable')));
    expect(screen.queryByText('The picture could not be read: first.png')).toBeNull();
    expect(screen.getByRole('img', { name: 'Preview' })).toBeTruthy();
  });

  it('ignores the result of a picture that was replaced before it was read', async () => {
    const { onPlace } = show();
    await uploadTab();
    const first = holdFirstPicture();
    await user.upload(chooser(), signaturePicture('first.png'));
    await user.upload(chooser(), signaturePicture('second.png'));
    await screen.findByRole('img', { name: 'Preview' });

    // The replaced picture finishes late, with a bigger mark than the one that stays.
    const bigger = skia.createCanvas(200, 100);
    const context = bigger.getContext('2d') as { fillStyle: string; fillRect: (...a: number[]) => void };
    context.fillStyle = '#000000';
    context.fillRect(0, 0, 200, 100);
    await act(async () => first().resolve(Object.assign(bigger, { close: () => undefined })));

    await user.click(place());
    await waitFor(() => expect(onPlace).toHaveBeenCalledTimes(1));
    expect([placed(onPlace).source.pixelWidth, placed(onPlace).source.pixelHeight]).toEqual([22, 12]);
  });
});

describe('SignatureDialog saved signatures', () => {
  const dataUrl = 'data:image/png;base64,AAEC';
  const saved: SavedSignature[] = [
    { id: 's1', role: 'signature', dataUrl, width: 300, height: 100 },
    { id: 'i1', role: 'initials', dataUrl, width: 80, height: 60 },
  ];

  it('lists nothing when no signature was remembered', () => {
    show();
    expect(screen.queryByRole('region', { name: 'Saved signatures' })).toBeNull();
  });

  it('places a remembered signature as it was saved, without asking to remember it again', async () => {
    const { onPlace } = show({ saved });
    await user.click(screen.getByRole('button', { name: 'Use: Initials' }));
    expect(onPlace).toHaveBeenCalledExactlyOnceWith(
      { role: 'initials', bytes: new Uint8Array([0, 1, 2]), dataUrl, pixelWidth: 80, pixelHeight: 60 },
      false,
    );
  });

  it('forgets the one signature that was deleted', async () => {
    const { onForget, onPlace } = show({ saved });
    await user.click(screen.getByRole('button', { name: 'Delete saved signature: Signature' }));
    expect(onForget).toHaveBeenCalledExactlyOnceWith('s1');
    expect(onPlace).not.toHaveBeenCalled();
  });
});
