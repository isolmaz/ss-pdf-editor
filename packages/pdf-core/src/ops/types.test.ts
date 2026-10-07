import { describe, expect, it } from 'vitest';
import { formatBytes, note, throwIfAborted } from './types';

describe('formatBytes', () => {
  it('writes bytes, kilobytes and megabytes with one decimal', () => {
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5.25 * 1024 * 1024)).toBe('5.3 MB');
  });
});

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
});
