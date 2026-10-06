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
