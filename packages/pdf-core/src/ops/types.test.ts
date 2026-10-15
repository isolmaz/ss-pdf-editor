import { ToolError, toToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { note, throwIfAborted } from './types';

describe('note', () => {
  it('carries params only when they are given', () => {
    expect(note('changed', 'labels.note.plan')).toEqual({ kind: 'changed', key: 'labels.note.plan' });
    expect(note('changed', 'labels.note.plan', { count: 2 })).toEqual({
      kind: 'changed',
      key: 'labels.note.plan',
      params: { count: 2 },
    });
  });
});

describe('throwIfAborted', () => {
  it('throws an AbortError for an aborted signal and nothing otherwise', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });

  it('is an aborted ToolError, not an internal one, once an operation wraps it with toToolError', () => {
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      thrown = error;
    }
    const wrapped = toToolError(thrown, 'pdfjs');
    expect(wrapped).toBeInstanceOf(ToolError);
    expect(wrapped.code).toBe('aborted');
    expect(wrapped.details).toEqual({ engine: 'pdfjs', engineMessage: 'operation aborted' });
  });
});
