/**
 * Writers and readers the shell runs only on a user action, loaded on their first call.
 *
 * Each export has the signature of the function it stands for, so a call site does not
 * change; the module behind it becomes its own chunk instead of part of the shell's first
 * paint (the entry chunk sits near its 250 KiB budget). Only modules that nothing else in
 * the entry graph imports by value are listed here — a module that is also imported
 * statically stays in the entry chunk whatever this file does.
 *
 * A failed chunk load rejects that one call; the next call imports again (`import()` is
 * not memoised on failure).
 */

type Lazy<F extends (...args: never[]) => Promise<unknown>> = (...args: Parameters<F>) => ReturnType<F>;

export const removePdfAnnotations: Lazy<
  typeof import('pdf-core/ops/annotation-remove').removePdfAnnotations
> = async (...args) => (await import('pdf-core/ops/annotation-remove')).removePdfAnnotations(...args);

export const applyLayerWrite: Lazy<typeof import('pdf-core/ops/layer-write').applyLayerWrite> = async (
  ...args
) => (await import('pdf-core/ops/layer-write')).applyLayerWrite(...args);

export const addAttachments: Lazy<typeof import('pdf-core/ops/attachments-write').addAttachments> = async (
  ...args
) => (await import('pdf-core/ops/attachments-write')).addAttachments(...args);

export const removeAttachments: Lazy<
  typeof import('pdf-core/ops/attachments-write').removeAttachments
> = async (...args) => (await import('pdf-core/ops/attachments-write')).removeAttachments(...args);

export const auditRedactedDocument: Lazy<
  typeof import('pdf-core/ops/redact-audit').auditRedactedDocument
> = async (...args) => (await import('pdf-core/ops/redact-audit')).auditRedactedDocument(...args);

export const listPdfFonts: Lazy<typeof import('pdf-core/ops/pdf-fonts').listPdfFonts> = async (...args) =>
  (await import('pdf-core/ops/pdf-fonts')).listPdfFonts(...args);

export const addImageStamp: Lazy<typeof import('pdf-core/ops/image-stamp').addImageStamp> = async (...args) =>
  (await import('pdf-core/ops/image-stamp')).addImageStamp(...args);

export const resizeImageStamp: Lazy<typeof import('pdf-core/ops/image-stamp').resizeImageStamp> = async (
  ...args
) => (await import('pdf-core/ops/image-stamp')).resizeImageStamp(...args);

export const convertToPdf: Lazy<typeof import('pdf-core/ops/convert').convertToPdf> = async (...args) =>
  (await import('pdf-core/ops/convert')).convertToPdf(...args);

export const imagesToPdf: Lazy<typeof import('pdf-core/ops/images').imagesToPdf> = async (...args) =>
  (await import('pdf-core/ops/images')).imagesToPdf(...args);

export const syncXfaDatasets: Lazy<typeof import('pdf-core/ops/xfa-form').syncXfaDatasets> = async (
  ...args
) => (await import('pdf-core/ops/xfa-form')).syncXfaDatasets(...args);

export const inspectXfa: Lazy<typeof import('pdf-core/ops/xfa-form').inspectXfa> = async (...args) =>
  (await import('pdf-core/ops/xfa-form')).inspectXfa(...args);
