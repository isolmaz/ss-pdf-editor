import { describe, expect, it } from 'vitest';
import { isToolError, TOOL_ERROR_CODES, ToolError, toToolError } from './errors';
import { tr } from './i18n/tr';

/**
 * The error contract. The defect this guards against is the one found in the
 * source project: an engine code outside the
 * contract reaching the UI as `[object Object]`. So the test asserts the thing
 * the user actually depends on — every code has Turkish user text and a hint,
 * and unknown failures are wrapped rather than leaked.
 */

describe('ToolError contract', () => {
  it('has Turkish user text and a hint for every code', () => {
    const missing: string[] = [];
    for (const code of TOOL_ERROR_CODES) {
      const error = new ToolError(code, { engine: 'test' });
      for (const key of [error.messageKey, error.hintKey]) {
        if (typeof tr[key as keyof typeof tr] !== 'string' || tr[key as keyof typeof tr].length === 0) {
          missing.push(`${code} → ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the engine text for diagnostics without using it as the user message', () => {
    const error = new ToolError('unsupported', { engine: 'qpdf', engineMessage: 'Unable to process' });
    expect(error.message).toContain('Unable to process');
    expect(error.code).toBe('unsupported');
    expect(tr[error.messageKey as keyof typeof tr]).not.toContain('Unable to process');
  });

  it('passes a ToolError through unchanged and wraps everything else', () => {
    const original = new ToolError('wrong-password', { engine: 'pdfjs' });
    expect(toToolError(original)).toBe(original);

    const abort = toToolError(new DOMException('stopped', 'AbortError'), 'fs');
    expect(abort.code).toBe('aborted');
    expect(abort.details.engine).toBe('fs');

    const unknown = toToolError(new Error('kaboom'), 'mupdf');
    expect(unknown.code).toBe('internal');
    expect(unknown.details.engineMessage).toBe('kaboom');
    expect(isToolError(unknown)).toBe(true);
    expect(isToolError({ code: 'internal' })).toBe(false);
  });

  it('names the message and the hint of every code separately, after the code', () => {
    for (const code of TOOL_ERROR_CODES) {
      const error = new ToolError(code, { engine: 'test' });
      expect(error.messageKey, code).toBe(`error.${code}.message`);
      expect(error.hintKey, code).toBe(`error.${code}.hint`);
      expect(tr[error.messageKey as keyof typeof tr], code).not.toBe(tr[error.hintKey as keyof typeof tr]);
    }
  });

  it('lists each code once, and includes the codes the wrapper itself produces', () => {
    expect(new Set(TOOL_ERROR_CODES).size).toBe(TOOL_ERROR_CODES.length);
    expect(TOOL_ERROR_CODES).toContain('internal');
    expect(TOOL_ERROR_CODES).toContain('aborted');
    for (const wrapped of [
      toToolError(new Error('x')),
      toToolError('x'),
      toToolError(new DOMException('s', 'AbortError')),
    ]) {
      expect(TOOL_ERROR_CODES).toContain(wrapped.code);
    }
  });

  it('keeps the original failure as the cause, and the engine text of whatever was thrown', () => {
    const original = new Error('kaboom');
    const wrapped = toToolError(original, 'qpdf');
    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toBe('[internal] qpdf: kaboom');

    const thrownString = toToolError('plain text', 'fs');
    expect(thrownString.code).toBe('internal');
    expect(thrownString.details).toMatchObject({ engine: 'fs', engineMessage: 'plain text' });
    expect(thrownString.cause).toBe('plain text');

    const thrownObject = { weird: true };
    expect(toToolError(thrownObject).cause).toBe(thrownObject);
  });

  it('wraps a non-abort DOMException as internal, and an abort keeps its text', () => {
    expect(toToolError(new DOMException('quota', 'QuotaExceededError')).code).toBe('internal');
    const abort = toToolError(new DOMException('stopped by user', 'AbortError'), 'fs');
    expect(abort.details.engineMessage).toBe('stopped by user');
    expect(abort.message).toBe('[aborted] fs: stopped by user');
  });

  it('carries an explicit cause through the constructor', () => {
    const cause = new Error('root');
    expect(new ToolError('write-failed', { engine: 'fs' }, { cause }).cause).toBe(cause);
    expect(new ToolError('write-failed', { engine: 'fs', cause }).cause).toBe(cause);
  });
});
