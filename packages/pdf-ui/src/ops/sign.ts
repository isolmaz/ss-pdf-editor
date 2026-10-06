/**
 * The signing dialog (“PAdES B-B (pkijs + WebCrypto, fully
 * local)”).
 *
 * Three separations this file keeps, each of them a decision rather than a style:
 *
 *  - **The identity stays in the browser.** The PKCS#12 container and its password are
 *    read here, turned into a WebCrypto key handle, and never leave the tab: no upload,
 *    no key escrow, no account. The password is used once, to unwrap the key, and
 *    is not kept in the session.
 *  - **The dialog owns no PDF.** It computes one rectangle — where the visible stamp
 *    goes — from the page box the op reads, hands it to `signPdf`, and gets bytes back.
 *    Everything about `/ByteRange`, `/Contents` and the CMS belongs to the op.
 *  - **A signature is not a save.** `resultKind: 'replace'` puts the signed bytes into the
 *    session, so the next Save or Export writes the signed file; the notice and the
 *    properties panel say what the signature covers, and the pre-save warning says what a
 *    further change will do to it.
 */

import { readPageBoxes } from 'pdf-core/ops/page-boxes';
import { signPdf } from 'pdf-core/ops/sign';
import { describeCertificate, importPkcs12 } from 'pdf-core/signature-pkcs12';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec, OpRunContext } from '../dialogs/types';

/** The four corners a visible stamp may take, as fractions of the page box. */
const CORNERS: Record<string, { readonly x: number; readonly y: number }> = {
  'bottom-right': { x: 1, y: 0 },
  'bottom-left': { x: 0, y: 0 },
  'top-right': { x: 1, y: 1 },
  'top-left': { x: 0, y: 1 },
};

/** A stamp 200×60 pt with a 24 pt margin — the size a reader shows a signature box at. */
const STAMP = { width: 200, height: 60, margin: 24 };

/**
 * The page's own media box as a lower-left corner plus extents, for the page the stamp is
 * asked to sit on. The box is read, never assumed: a page whose `/MediaBox` starts at
 * `[0 -20 …]` puts a stamp at the margin *outside* the visible area if the corner is
 * ignored.
 */
async function pageBox(bytes: Uint8Array, pageIndex: number, signal: AbortSignal) {
  const [report] = await readPageBoxes(bytes, [pageIndex], signal);
  if (report === undefined) {
    throw new ToolError('range-invalid', {
      engine: 'mupdf',
      pageIndex,
      engineMessage: 'the page has no readable /MediaBox',
    });
  }
  const [left, bottom, right, top] = report.media;
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

/**
 * Where the stamp goes, in the page's own user space: the chosen corner, inset by the
 * margin, inside the box the page really declares (a stamp drawn outside `/MediaBox`
 * is a signature no reader can see).
 */
function stampRect(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  corner: string,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const anchor = CORNERS[corner] ?? { x: 1, y: 0 };
  const width = Math.min(STAMP.width, Math.max(box.width - STAMP.margin * 2, 1));
  const height = Math.min(STAMP.height, Math.max(box.height - STAMP.margin * 2, 1));
  return {
    x: box.x + STAMP.margin + (box.width - width - STAMP.margin * 2) * anchor.x,
    y: box.y + STAMP.margin + (box.height - height - STAMP.margin * 2) * anchor.y,
    width,
    height,
  };
}

/** The PKCS#12 the user picked, or a refusal that says which of the two things is missing. */
async function identityFrom(params: Readonly<Record<string, unknown>>, context: OpRunContext) {
  const files = (params.file ?? []) as readonly File[];
  const container = files[0];
  if (container === undefined) {
    throw new ToolError('input-missing', { engine: 'ui', engineMessage: 'no PKCS#12 file was chosen' });
  }
  const bytes = new Uint8Array(await container.arrayBuffer());
  // The password is read here and dropped with this call: a wrong one is the container's
  // own integrity check failing (`refuse: a wrong password is reported, never silently
  // skipped`), not a message this layer invents.
  const identity = await importPkcs12(
    bytes,
    String(params.password ?? ''),
    (params.digest ?? 'SHA-256') as 'SHA-256' | 'SHA-384' | 'SHA-512',
  );
  const described = describeCertificate(identity.certificate);
  context.onProgress?.({ phase: 'sign', labelKey: 'op.progress.sign.prepare', done: 0, total: 1 });
  return { identity, described };
}

export const signDialog: OperationDialogSpec = {
  id: 'sign',
  titleKey: 'sign.title',
  introKey: 'sign.intro',
  confirmKey: 'sign.confirm',
  resultKind: 'replace',
  // The stamp goes on the page the reader is looking at unless they say otherwise.
  initialValues: (context) => ({ page: context.currentPage + 1 }),
  fields: [
    {
      kind: 'files',
      id: 'file',
      labelKey: 'sign.field.file',
      hintKey: 'sign.field.fileHint',
      accept: '.p12,.pfx,application/x-pkcs12,application/octet-stream',
      multiple: false,
    },
    {
      kind: 'password',
      id: 'password',
      labelKey: 'sign.field.password',
      placeholderKey: 'sign.field.passwordHint',
    },
    {
      kind: 'text',
      id: 'fieldName',
      advanced: true,
      labelKey: 'sign.field.name',
      hintKey: 'sign.field.nameHint',
      defaultValue: '',
      maxLength: 64,
    },
    {
      kind: 'select',
      id: 'digest',
      advanced: true,
      labelKey: 'sign.field.digest',
      hintKey: 'sign.field.digestHint',
      defaultValue: 'SHA-256',
      options: [
        { value: 'SHA-256', labelKey: 'sign.digest.sha256' },
        { value: 'SHA-384', labelKey: 'sign.digest.sha384' },
        { value: 'SHA-512', labelKey: 'sign.digest.sha512' },
      ],
    },
    { kind: 'checkbox', id: 'visible', labelKey: 'sign.field.visible', defaultValue: true },
    {
      kind: 'number',
      id: 'page',
      labelKey: 'sign.field.page',
      defaultValue: 1,
      min: 1,
      max: 100000,
      step: 1,
      visibleWhen: { field: 'visible', equals: [true] },
    },
    {
      kind: 'select',
      id: 'place',
      labelKey: 'sign.field.place',
      defaultValue: 'bottom-right',
      options: [
        { value: 'bottom-right', labelKey: 'sign.place.bottomRight' },
        { value: 'bottom-left', labelKey: 'sign.place.bottomLeft' },
        { value: 'top-right', labelKey: 'sign.place.topRight' },
        { value: 'top-left', labelKey: 'sign.place.topLeft' },
      ],
      visibleWhen: { field: 'visible', equals: [true] },
    },
    {
      kind: 'text',
      id: 'reason',
      advanced: true,
      labelKey: 'sign.field.reason',
      defaultValue: '',
      maxLength: 200,
    },
    {
      kind: 'text',
      id: 'location',
      advanced: true,
      labelKey: 'sign.field.location',
      defaultValue: '',
      maxLength: 200,
    },
  ],
  run: async (params, context) => {
    const { identity, described } = await identityFrom(params, context);
    const visible = params.visible === true;
    const pageIndex = Math.min(Math.max(Number(params.page ?? 1), 1), context.pageCount) - 1;
    const reason = String(params.reason ?? '').trim();
    const location = String(params.location ?? '').trim();

    const rect = visible
      ? stampRect(
          await pageBox(context.bytes, pageIndex, context.signal),
          String(params.place ?? 'bottom-right'),
        )
      : undefined;

    const outcome = await signPdf(
      context.bytes,
      {
        identity,
        field: {
          name: String(params.fieldName ?? '').trim() || undefined,
          pageIndex: visible ? pageIndex : undefined,
          rect,
          // The stamp's three lines, in the order a reader shows them; the date is the
          // signing moment the op writes into `/M` as well, so the box and the dictionary
          // never disagree.
          lines: visible
            ? [described.commonName ?? '', new Date().toISOString().slice(0, 10), reason]
            : undefined,
        },
        digest: (params.digest ?? 'SHA-256') as 'SHA-256' | 'SHA-384' | 'SHA-512',
        reason: reason === '' ? undefined : reason,
        location: location === '' ? undefined : location,
        signerName: described.commonName ?? undefined,
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'sign.done',
      noticeParams: { signer: described.commonName ?? '', expires: described.notAfter ?? '' },
    };
  },
};

/** Kept for the shell's command layer: the signer a chosen container names, without signing. */
export async function inspectContainer(
  file: File,
  password: string,
): Promise<{
  readonly commonName: string | null;
  readonly issuer: string | null;
  readonly notAfter: string | null;
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const identity = await importPkcs12(bytes, password);
  return describeCertificate(identity.certificate);
}
