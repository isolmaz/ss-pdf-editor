/**
 * Save routing and execution planning.
 *
 * The router does not pick a chain of engines "just in case": it picks the
 * paths the change type actually needs, then orders those steps by dependency.
 *
 *   1. freeze a session version  →  the caller's job (session version id)
 *   2. produce the base PDF      →  original bytes | saveDocument | extractPages | full rewrite
 *   3. dependency-ordered transforms (erase before insert, metadata after the
 *      final MuPDF write, encryption last content step, signature very last)
 *   4. verification
 *   5. write, then mark **only that version** saved
 *
 * Any non-incremental writer ends the fast path and must appear in the save
 * report (`incremental: false`).
 */

export type SavePathId =
  | 'no-op'
  | 'decrypt-input'
  | 'pdfjs-save-document'
  | 'pdfjs-extract-pages'
  | 'writer-steps'
  | 'mupdf-rewrite'
  | 'metadata-write'
  | 'qpdf-encrypt'
  | 'signature-finalize';

export type SaveEngine = 'pdfjs' | 'mupdf' | 'qpdf' | 'signature' | 'model';

export interface ChangeSummary {
  /** pdf.js-native annotation edits (highlight, ink, stamp, note, comment…). */
  readonly annotations: boolean;
  /** Form field values. */
  readonly forms: boolean;
  /** Page add / delete / duplicate / reorder. */
  readonly pageOrder: boolean;
  /** Stamps, header/footer, Bates, text boxes, images drawn into the page. */
  readonly overlays: boolean;
  /** Media/Crop/Trim/Bleed/Art boxes. */
  readonly boxes: boolean;
  /** OCG layer writes. */
  readonly layers: boolean;
  /** Form widget writes (creation/update outside pdf.js's own model). */
  readonly widgets: boolean;
  /** Info + XMP. */
  readonly metadata: boolean;
  /** True erasure — forces a MuPDF full rewrite. */
  readonly redaction: boolean;
  readonly encryption: boolean;
  readonly signature: boolean;
}

export const NO_CHANGES: ChangeSummary = {
  annotations: false,
  forms: false,
  pageOrder: false,
  overlays: false,
  boxes: false,
  layers: false,
  widgets: false,
  metadata: false,
  redaction: false,
  encryption: false,
  signature: false,
};

export interface SaveStep {
  readonly id: SavePathId;
  readonly engine: SaveEngine;
  readonly note: string;
}

export interface SavePlan {
  /** Which paths apply (diagnostics + save report). */
  readonly paths: readonly SavePathId[];
  /** Dependency-ordered execution steps. */
  readonly steps: readonly SaveStep[];
  /** True only for the pdf.js incremental fast path. */
  readonly incremental: boolean;
  /** A full rewrite normalises object numbering/compression/XMP — say so. */
  readonly rewritesStructure: boolean;
  /** Encrypted input must be decrypted into memory before plain-bytes engines run. */
  readonly decryptsInput: boolean;
  /** Protection of an encrypted input is re-applied unless the user removed it. */
  readonly reprotects: boolean;
}

export function isEmptyChangeSet(changes: ChangeSummary): boolean {
  return Object.values(changes).every((changed) => changed === false);
}

export interface PlanSaveOptions {
  /** The session input was password-protected (no writer can read it until it is decrypted). */
  readonly encryptedInput?: boolean;
  /** The user explicitly asked to remove password protection. */
  readonly removeProtection?: boolean;
}

export function planSave(changes: ChangeSummary, options: PlanSaveOptions = {}): SavePlan {
  if (isEmptyChangeSet(changes)) {
    return {
      paths: ['no-op'],
      steps: [],
      incremental: true,
      rewritesStructure: false,
      decryptsInput: false,
      reprotects: false,
    };
  }

  const encryptedInput = options.encryptedInput === true;
  const removeProtection = options.removeProtection === true;
  const needsWriterSteps = changes.overlays || changes.boxes || changes.layers || changes.widgets;
  const needsPlainBytes = needsWriterSteps || changes.metadata || changes.redaction;

  const steps: SaveStep[] = [];
  const paths: SavePathId[] = [];

  // 1) Encrypted input: the writers refuse a document they cannot read, and MuPDF must
  //    authenticate first anyway. Decrypt into memory; never write the plain bytes to a draft.
  if (encryptedInput && needsPlainBytes) {
    steps.push({
      id: 'decrypt-input',
      engine: 'qpdf',
      note: 'decrypt to an in-memory working representation (never persisted as a draft)',
    });
    paths.push('decrypt-input');
  }

  // 2) Base PDF — exactly one path.
  if (changes.redaction) {
    steps.push({
      id: 'mupdf-rewrite',
      engine: 'mupdf',
      note: 'full rewrite with cleanup; incremental saving is impossible afterwards',
    });
    paths.push('mupdf-rewrite');
  } else if (changes.pageOrder) {
    steps.push({
      id: 'pdfjs-extract-pages',
      engine: 'pdfjs',
      note: 'page composition preserving outline/AcroForm/labels',
    });
    paths.push('pdfjs-extract-pages');
  } else if (changes.annotations || changes.forms) {
    steps.push({
      id: 'pdfjs-save-document',
      engine: 'pdfjs',
      note: 'incremental file format; no re-serialisation',
    });
    paths.push('pdfjs-save-document');
  }

  if (needsWriterSteps) {
    steps.push({
      id: 'writer-steps',
      engine: 'mupdf',
      note: 'only the writers whose operations exist run; each declares a preservation contract',
    });
    paths.push('writer-steps');
  }

  // 3) Metadata after the final MuPDF write (MuPDF normalises Info/XMP), and
  //    always after a rewrite so the producer line is merged, never stripped.
  if (changes.metadata || changes.redaction) {
    steps.push({
      id: 'metadata-write',
      engine: 'mupdf',
      note: 'Info + XMP with the merged producer line',
    });
    paths.push('metadata-write');
  }

  // 4) Protection last content step: re-apply for an encrypted input, or apply
  //    the user's requested encryption. Never silently downgrade protection.
  const reprotects = encryptedInput && !removeProtection;
  if (changes.encryption || reprotects) {
    steps.push({
      id: 'qpdf-encrypt',
      engine: 'qpdf',
      note: changes.encryption
        ? 'AES-256 + permissions; output re-opened and checked'
        : 're-apply input protection (no silent downgrade)',
    });
    paths.push('qpdf-encrypt');
  }

  // 5) Signature finalises the document — after content and encryption.
  if (changes.signature) {
    steps.push({
      id: 'signature-finalize',
      engine: 'signature',
      note: 'ByteRange + CMS; verified with an independent verifier',
    });
    paths.push('signature-finalize');
  }

  const incremental = paths.length === 1 && paths[0] === 'pdfjs-save-document' && !encryptedInput;

  return {
    paths,
    steps,
    incremental,
    rewritesStructure: changes.redaction || needsWriterSteps || changes.pageOrder,
    decryptsInput: encryptedInput && needsPlainBytes,
    reprotects,
  };
}
