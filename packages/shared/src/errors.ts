/**
 * The one error contract of the app.
 *
 * Engines speak their own error vocabularies (pdf.js, qpdf, MuPDF, tesseract,
 * fetch). Components never see those: every failure that can reach the
 * user is normalised here into a {@link ToolError} with a stable code, an i18n
 * key for the user-facing text and a "what to do next" hint key.
 *
 * Rules:
 *  - no silent catch: a `catch` either rethrows, wraps into a ToolError, or is
 *    explicitly documented as expected control flow;
 *  - raw English engine messages never reach the UI — they travel in
 *    {@link ToolError.details.engineMessage} for the save report/diagnostics.
 */

import type { MessageKey } from './i18n/tr';

export const TOOL_ERROR_CODES = [
  'unsupported',
  'password-required',
  'wrong-password',
  'range-invalid',
  'value-out-of-range',
  'selection-empty',
  'no-text',
  'no-match',
  'password-policy',
  'encrypted-unsupported',
  'corrupt-document',
  'unsupported-format',
  'file-too-large',
  'page-limit',
  'quota-exceeded',
  'out-of-memory',
  'aborted',
  'timeout',
  'write-failed',
  'verification-failed',
  'redaction-geometry-unknown',
  'pending-redactions',
  'conflict',
  'asset-missing',
  'asset-hash-mismatch',
  'asset-offline',
  'font-missing',
  'ocr-language-missing',
  'voice-unavailable',
  'permission-denied',
  'internal',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Codes whose user text is part of the product contract. */
export const TOOL_ERROR_KEYS = TOOL_ERROR_CODES.reduce<Record<ToolErrorCode, string>>(
  (keys, code) => {
    keys[code] = `error.${code}.message`;
    return keys;
  },
  {} as Record<ToolErrorCode, string>,
);

export const TOOL_ERROR_HINT_KEYS = TOOL_ERROR_CODES.reduce<Record<ToolErrorCode, string>>(
  (keys, code) => {
    keys[code] = `error.${code}.hint`;
    return keys;
  },
  {} as Record<ToolErrorCode, string>,
);

export interface ToolErrorDetails {
  /** Which engine/subsystem produced the failure (`pdfjs`, `mupdf`, `qpdf`, `model`, `ui`, `fs`). */
  readonly engine: string;
  readonly pageIndex?: number;
  readonly path?: string;
  /** Verbatim engine text. Diagnostics only — never rendered as the user message. */
  readonly engineMessage?: string;
  readonly cause?: unknown;
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: ToolErrorDetails;

  constructor(code: ToolErrorCode, details: ToolErrorDetails, options?: { cause?: unknown }) {
    super(`[${code}] ${details.engine}${details.engineMessage ? `: ${details.engineMessage}` : ''}`, {
      cause: options?.cause ?? details.cause,
    });
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }

  get messageKey(): MessageKey {
    return TOOL_ERROR_KEYS[this.code] as MessageKey;
  }

  get hintKey(): MessageKey {
    return TOOL_ERROR_HINT_KEYS[this.code] as MessageKey;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

/**
 * Last line of defence: never let a raw error escape to the UI layer.
 * Unknown shapes become `internal` with the engine message preserved.
 */
export function toToolError(value: unknown, engine = 'model'): ToolError {
  if (isToolError(value)) return value;
  if (value instanceof DOMException && value.name === 'AbortError') {
    return new ToolError('aborted', { engine, engineMessage: value.message });
  }
  if (value instanceof Error) {
    return new ToolError('internal', { engine, engineMessage: value.message }, { cause: value });
  }
  return new ToolError('internal', { engine, engineMessage: String(value) }, { cause: value });
}
