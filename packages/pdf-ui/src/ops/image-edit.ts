/**
 * The image dialog (`PLAN.md §5/Phase 4`: “Image editing: select an image object,
 * replace, …”).
 *
 * The split with `pdf-core/ops/image-edit.ts` is the point of this file: the op owns the
 * PDF — which objects exist, which reference the page draws, what the produced file says
 * — and this dialog owns the **pixels**: it hands over encoded bytes and nothing else.
 * That is why the op can stay DOM-free, and why a picker is the action that needs no
 * canvas at all.
 *
 * The target list is document data, so it arrives through the run context as a `choice`
 * field the host resolves at open time (`OperationForm`): the images the user picks
 * from are the images of the frozen bytes the run will edit.
 *
 * Crop, rotate and re-compress all end in the same place: new encoded bytes for the same
 * object. They start from the **image's own samples** (`readImageData`) — never from the
 * rendered page, which would bake in the zoom level and anything drawn over it — assembled
 * into a canvas and encoded again with the codec the action asks for. A file whose samples
 * this writer cannot hand out (a JPX stream, a 1-bit or CMYK image, a palette) is labelled
 * as such in the target list, so the action that cannot work is visible before it is
 * chosen rather than refused after.
 */

import type { PdfImageInfo } from 'pdf-core/ops/image-edit';
import { applyImageEdit, readImageData } from 'pdf-core/ops/image-edit';
import { applyImageOpacity } from 'pdf-core/ops/image-opacity';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec, OperationRunContext, OpRunContext } from '../dialogs/types';

/**
 * The bitmap a `readImageData` result describes.
 *
 * `jpeg` is handed to the browser as a JPEG blob — a `/DCTDecode` stream is one — and
 * `raw` is wrapped in an `ImageData`, which is the only way a canvas takes pixels with no
 * file format around them.
 */
async function bitmapFor(read: Awaited<ReturnType<typeof readImageData>>): Promise<ImageBitmap | ImageData> {
  if (read.kind === 'jpeg') {
    const blob = new Blob([read.bytes as unknown as BlobPart], { type: 'image/jpeg' });
    try {
      return await createImageBitmap(blob);
    } catch (cause) {
      throw new ToolError(
        'unsupported-format',
        { engine: 'ui', engineMessage: 'the browser could not decode this image’s JPEG stream' },
        { cause },
      );
    }
  }
  if (read.kind === 'raw') {
    // `ImageData` wants a `Uint8ClampedArray` of its own; the op hands over a plain one
    // because it is DOM-free, so the copy happens exactly once, here.
    return new ImageData(Uint8ClampedArray.from(read.rgba), read.width, read.height);
  }
  throw new ToolError('unsupported', { engine: 'ui', engineMessage: `image samples: ${read.reasonKey}` });
}

/** `page:name` — one option per (page, resource) pair, because a name repeats across pages. */
function keyOf(image: PdfImageInfo): string {
  return `${image.pageIndex}:${image.name}`;
}

/** The listing the dialog offers, in document order; only what can really be replaced. */
function choicesFrom(
  context: OperationRunContext,
): readonly { readonly value: string; readonly label: string }[] {
  return (context.images ?? [])
    .filter((image) => image.editable)
    .map((image) => {
      const kilobytes = Math.max(1, Math.round(image.bytes / 1024));
      return {
        value: keyOf(image),
        label: context.t('image.choice', {
          page: image.pageIndex + 1,
          name: image.name,
          width: image.width,
          height: image.height,
          filter: image.filter ?? context.t('image.choice.raw'),
          kb: kilobytes,
          mask: image.hasMask ? context.t('image.choice.mask') : '',
          limit: image.transformable ? '' : context.t('image.choice.limit'),
        }),
      };
    });
}

/**
 * The new bytes one action asks for, from the image's own samples.
 *
 * `crop` and `rotate` re-encode as PNG — a rotation loses nothing and a crop must not
 * introduce artefacts on top of the user's cut — while `compress` re-encodes as JPEG,
 * which is the one action where a smaller file *is* the point. The canvas keeps the
 * image's own pixel size unless a crop asks for less, so the object's pixel dimensions
 * change exactly as much as the edit does.
 */
async function transformed(
  action: string,
  params: Record<string, unknown>,
  image: PdfImageInfo,
  context: OpRunContext,
): Promise<{ readonly data: Uint8Array; readonly format: 'jpeg' | 'png' }> {
  const read = await readImageData(
    context.bytes,
    { pageIndex: image.pageIndex, name: image.name },
    { signal: context.signal },
  );
  if (read.kind === 'unsupported') {
    throw new ToolError('unsupported', { engine: 'ui', engineMessage: `image samples: ${read.reasonKey}` });
  }
  const source = await bitmapFor(read);
  const width = read.width;
  const height = read.height;
  const degrees = action === 'rotate' ? Number(params.degrees ?? 90) : 0;
  const turned = degrees === 90 || degrees === 270;
  const crop =
    action === 'crop'
      ? {
          top: Number(params.cropTop ?? 0),
          right: Number(params.cropRight ?? 0),
          bottom: Number(params.cropBottom ?? 0),
          left: Number(params.cropLeft ?? 0),
        }
      : { top: 0, right: 0, bottom: 0, left: 0 };

  const sourceLeft = Math.round((crop.left / 100) * width);
  const sourceTop = Math.round((crop.top / 100) * height);
  const sourceWidth = width - sourceLeft - Math.round((crop.right / 100) * width);
  const sourceHeight = height - sourceTop - Math.round((crop.bottom / 100) * height);
  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new ToolError('value-out-of-range', {
      engine: 'ui',
      engineMessage: 'the crop removes the whole image',
    });
  }

  // The canvas is the *transformed* size: a quarter turn swaps the axes, and a crop
  // shrinks the box, so the object's own /Width and /Height end up describing what the
  // reader will draw.
  const canvas = new OffscreenCanvas(
    turned ? sourceHeight : sourceWidth,
    turned ? sourceWidth : sourceHeight,
  );
  const two = canvas.getContext('2d');
  if (two === null) {
    throw new ToolError('internal', {
      engine: 'ui',
      engineMessage: 'the browser gave no 2D context for the image edit',
    });
  }
  two.translate(canvas.width / 2, canvas.height / 2);
  two.rotate((degrees * Math.PI) / 180);
  const corner = turned ? sourceHeight : sourceWidth;
  const edge = turned ? sourceWidth : sourceHeight;
  if (source instanceof ImageData) {
    // `drawImage` cannot crop an `ImageData`, so the crop is written into a bitmap first.
    const full = new OffscreenCanvas(width, height);
    const painter = full.getContext('2d');
    if (painter === null)
      throw new ToolError('internal', { engine: 'ui', engineMessage: 'no 2D context for the image edit' });
    painter.putImageData(source, 0, 0);
    two.drawImage(
      full,
      sourceLeft,
      sourceTop,
      sourceWidth,
      sourceHeight,
      -corner / 2,
      -edge / 2,
      corner,
      edge,
    );
  } else {
    two.drawImage(
      source,
      sourceLeft,
      sourceTop,
      sourceWidth,
      sourceHeight,
      -corner / 2,
      -edge / 2,
      corner,
      edge,
    );
  }

  const quality = Math.min(Math.max(Number(params.quality ?? 0.7), 0.05), 1);
  const lossy = action === 'compress';
  const blob = await canvas.convertToBlob(lossy ? { type: 'image/jpeg', quality } : { type: 'image/png' });
  return { data: new Uint8Array(await blob.arrayBuffer()), format: lossy ? 'jpeg' : 'png' };
}

export const imageEditDialog: OperationDialogSpec = {
  id: 'image-edit',
  titleKey: 'image.title',
  introKey: 'image.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      kind: 'choice',
      id: 'target',
      labelKey: 'image.field.target',
      hintKey: 'image.field.targetHint',
      options: choicesFrom,
      defaultValue: '',
    },
    {
      kind: 'radio',
      id: 'action',
      labelKey: 'image.field.action',
      options: [
        { value: 'replace', labelKey: 'image.action.replace' },
        { value: 'compress', labelKey: 'image.action.compress' },
        { value: 'rotate', labelKey: 'image.action.rotate' },
        { value: 'crop', labelKey: 'image.action.crop' },
        { value: 'opacity', labelKey: 'image.action.opacity' },
      ],
      defaultValue: 'replace',
      columns: 2,
    },
    {
      kind: 'files',
      id: 'file',
      labelKey: 'image.field.file',
      hintKey: 'image.field.fileHint',
      accept: 'image/png,image/jpeg',
      multiple: false,
      visibleWhen: { field: 'action', equals: ['replace'] },
    },
    {
      kind: 'number',
      id: 'quality',
      labelKey: 'image.field.quality',
      hintKey: 'image.field.qualityHint',
      defaultValue: 0.7,
      min: 0.05,
      max: 1,
      step: 0.05,
      visibleWhen: { field: 'action', equals: ['compress'] },
    },
    {
      kind: 'select',
      id: 'degrees',
      labelKey: 'image.field.degrees',
      defaultValue: '90',
      options: [
        { value: '90', labelKey: 'image.degrees.90' },
        { value: '180', labelKey: 'image.degrees.180' },
        { value: '270', labelKey: 'image.degrees.270' },
      ],
      visibleWhen: { field: 'action', equals: ['rotate'] },
    },
    {
      kind: 'number',
      id: 'cropTop',
      labelKey: 'image.field.cropTop',
      defaultValue: 10,
      min: 0,
      max: 90,
      step: 1,
      visibleWhen: { field: 'action', equals: ['crop'] },
    },
    {
      kind: 'number',
      id: 'cropRight',
      labelKey: 'image.field.cropRight',
      defaultValue: 10,
      min: 0,
      max: 90,
      step: 1,
      visibleWhen: { field: 'action', equals: ['crop'] },
    },
    {
      kind: 'number',
      id: 'cropBottom',
      labelKey: 'image.field.cropBottom',
      defaultValue: 10,
      min: 0,
      max: 90,
      step: 1,
      visibleWhen: { field: 'action', equals: ['crop'] },
    },
    {
      kind: 'number',
      id: 'alpha',
      labelKey: 'image.field.alpha',
      hintKey: 'image.field.alphaHint',
      defaultValue: 0.5,
      min: 0,
      max: 1,
      step: 0.05,
      visibleWhen: { field: 'action', equals: ['opacity'] },
    },
    {
      kind: 'number',
      id: 'cropLeft',
      labelKey: 'image.field.cropLeft',
      defaultValue: 10,
      min: 0,
      max: 90,
      step: 1,
      visibleWhen: { field: 'action', equals: ['crop'] },
    },
  ],
  run: async (params, context: OpRunContext) => {
    const target = String(params.target ?? '');
    const image = (context.images ?? []).find((entry) => keyOf(entry) === target);
    if (image === undefined) {
      // The list was read when the dialog opened; a document that changed under it must
      // not silently replace a different object than the one the label named.
      throw new ToolError('selection-empty', {
        engine: 'ui',
        engineMessage: 'the chosen image is no longer in the document',
      });
    }
    const action = String(params.action ?? 'replace');
    if (action === 'opacity') {
      // Opacity is not an image-stream change: the page keeps the picture and gains a
      // graphics state around the operator that draws it (`ops/image-opacity.ts`).
      const opacity = Number(params.alpha ?? 0.5);
      const outcome = await applyImageOpacity(
        context.bytes,
        { pageIndex: image.pageIndex, name: image.name, opacity },
        { signal: context.signal, onProgress: context.onProgress },
      );
      return {
        files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
        report: outcome.report,
        noticeKey: 'image.done',
      };
    }
    let data: Uint8Array;
    let format: 'jpeg' | 'png';
    if (action === 'replace') {
      const picked = Array.isArray(params.file) ? (params.file[0] as File | undefined) : undefined;
      if (picked === undefined) {
        throw new ToolError('selection-empty', { engine: 'ui', engineMessage: 'no image file was picked' });
      }
      data = new Uint8Array(await picked.arrayBuffer());
      // The picked file goes to the engine as it is: re-encoding it here would silently
      // change what the user chose, and `embedJpg`/`embedPng` are the validators.
      format = /jpe?g$/i.test(picked.type) ? 'jpeg' : 'png';
    } else {
      if (!image.transformable) {
        // The label already said so; this is the same statement with the precise reason.
        throw new ToolError('unsupported', {
          engine: 'ui',
          engineMessage: `this image's samples cannot be read: ${image.notTransformableKey ?? 'unknown'}`,
        });
      }
      ({ data, format } = await transformed(action, params, image, context));
    }
    const outcome = await applyImageEdit(
      context.bytes,
      { replacements: [{ pageIndex: image.pageIndex, name: image.name, data, format }] },
      { signal: context.signal, onProgress: context.onProgress },
    );
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'image.done',
    };
  },
};
