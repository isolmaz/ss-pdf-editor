import { afterEach, describe, expect, it, vi } from 'vitest';
import { isToolError, TOOL_ERROR_CODES, ToolError, toToolError } from './errors';
import { createTranslator } from './i18n';
import { tr } from './i18n/tr';

/**
 * The error contract. The defect this guards against is an engine code outside the
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
    const error = new ToolError('unsupported', { engine: 'mupdf', engineMessage: 'Unable to process' });
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

  describe('a chunk the browser could not fetch', () => {
    const CHUNK_MESSAGES = [
      'Failed to fetch dynamically imported module: http://localhost/editor/assets/pdf-1.js',
      'error loading dynamically imported module: http://localhost/editor/assets/pdf-1.js',
      'Importing a module script failed.',
      'Unable to preload CSS for /editor/assets/PrintDialog-1.css',
    ];

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('is offline when the browser has no network: connecting is what brings the chunk', () => {
      vi.stubGlobal('navigator', { onLine: false });
      for (const message of CHUNK_MESSAGES) {
        const error = toToolError(new TypeError(message), 'pdfjs');
        expect(error.code, message).toBe('asset-offline');
        expect(error.details.engineMessage).toBe(message);
      }
      expect(toToolError(new TypeError('Failed to fetch'), 'pdfjs').code).toBe('internal');
    });

    it('is stale when the browser has a network: the page outlived its release, so reloading is the cure', () => {
      vi.stubGlobal('navigator', { onLine: true });
      for (const message of CHUNK_MESSAGES) {
        const error = toToolError(new TypeError(message), 'pdfjs');
        expect(error.code, message).toBe('asset-stale');
        expect(error.messageKey).toBe('error.asset-stale.message');
        expect(error.hintKey).toBe('error.asset-stale.hint');
        expect(error.details.engineMessage).toBe(message);
      }
      expect(toToolError(new TypeError('Failed to fetch'), 'pdfjs').code).toBe('internal');
      // Its words are not the offline ones, which would send a reader whose network works the wrong way.
      expect(tr['error.asset-stale.hint']).toContain('yenileyin');
      expect(tr['error.asset-stale.hint']).not.toBe(tr['error.asset-offline.hint']);
      expect(tr['error.asset-stale.message']).not.toBe(tr['error.asset-offline.message']);
    });

    it('is offline when the runtime does not say whether it has a network', () => {
      vi.stubGlobal('navigator', {});
      expect(toToolError(new TypeError(CHUNK_MESSAGES[0] as string)).code).toBe('asset-offline');
      vi.stubGlobal('navigator', undefined);
      expect(toToolError(new TypeError(CHUNK_MESSAGES[0] as string)).code).toBe('asset-offline');
    });
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
    const wrapped = toToolError(original, 'mupdf');
    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toBe('[internal] mupdf: kaboom');

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

  it('maps a cancellation to aborted by its name, whether it is a DOMException or a plain Error', () => {
    // The shape `throwIfAborted` and the engines' own cancel paths throw.
    const plain = new Error('operation aborted');
    plain.name = 'AbortError';
    const fromPlain = toToolError(plain, 'pdfjs');
    expect(fromPlain.code).toBe('aborted');
    expect(fromPlain.details).toEqual({ engine: 'pdfjs', engineMessage: 'operation aborted' });
    expect(fromPlain.message).toBe('[aborted] pdfjs: operation aborted');

    const fromDom = toToolError(new DOMException('stopped', 'AbortError'), 'pdfjs');
    expect([fromDom.code, fromDom.details.engineMessage]).toEqual(['aborted', 'stopped']);

    // Only the name decides: an error that merely says "abort" is not a cancellation.
    expect(toToolError(new Error('operation aborted'), 'pdfjs').code).toBe('internal');
    expect(toToolError({ name: 'AbortError', message: 'not an Error' }, 'pdfjs').code).toBe('internal');
  });

  it('puts the characters a glyph-missing refusal names into its message, in both languages', () => {
    const error = new ToolError('glyph-missing', { engine: 'mupdf', params: { chars: '😀 😁' } });
    for (const locale of ['tr', 'en'] as const) {
      const translate = createTranslator(locale);
      const message = translate(error.messageKey, error.details.params);
      expect(message, locale).toContain('😀 😁');
      expect(message, locale).not.toContain('{chars}');
    }
  });

  it('carries an explicit cause through the constructor', () => {
    const cause = new Error('root');
    expect(new ToolError('write-failed', { engine: 'fs' }, { cause }).cause).toBe(cause);
    expect(new ToolError('write-failed', { engine: 'fs', cause }).cause).toBe(cause);
  });
});
