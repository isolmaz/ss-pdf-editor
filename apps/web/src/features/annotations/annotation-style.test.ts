// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultToolStyles,
  readStoredAuthor,
  readStoredStyles,
  STYLED_TOOLS,
  storeAuthor,
  storeStyles,
  styledToolOf,
} from './annotation-style';

const KEY = 'pdf_editor_annotation_styles_v1';

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('the stored annotation styles', () => {
  it('are the defaults on a first visit', () => {
    expect(readStoredStyles()).toEqual(defaultToolStyles());
  });

  it('come back as stored, tool by tool', () => {
    const styles = {
      ...defaultToolStyles(),
      ink: { color: '#00ff00', opacity: 0.5, thickness: 9, fontSize: 30 },
    };
    storeStyles(styles);
    expect(readStoredStyles()).toEqual(styles);
  });

  it('keep the default for each field that is not valid, and for each tool that is missing', () => {
    const defaults = defaultToolStyles();
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ink: { color: 'red', opacity: 5, thickness: 0, fontSize: '12' },
        shapes: { color: '#AABBCC', opacity: 0.1, thickness: 20, fontSize: 72 },
        note: 'yellow',
        freetext: null,
      }),
    );
    const styles = readStoredStyles();
    expect(styles.ink).toEqual(defaults.ink);
    expect(styles.shapes).toEqual({ color: '#AABBCC', opacity: 0.1, thickness: 20, fontSize: 72 });
    expect(styles.note).toEqual(defaults.note);
    expect(styles.freetext).toEqual(defaults.freetext);
    expect(styles.highlight).toEqual(defaults.highlight);
  });

  it.each([['not json'], ['null'], ['5'], ['[]']])('fall back to the defaults for %s', (text) => {
    localStorage.setItem(KEY, text);
    expect(readStoredStyles()).toEqual(defaultToolStyles());
  });

  it('fall back to the defaults when the storage is blocked, and a blocked write loses only the memory', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    expect(readStoredStyles()).toEqual(defaultToolStyles());
    expect(() => storeStyles(defaultToolStyles())).not.toThrow();
  });
});

describe('the stored author', () => {
  it('is empty on a first visit and comes back as stored', () => {
    expect(readStoredAuthor()).toBe('');
    storeAuthor('Ada Lovelace');
    expect(readStoredAuthor()).toBe('Ada Lovelace');
  });

  it('is empty when the storage is blocked, and a blocked write loses only the memory', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    expect(readStoredAuthor()).toBe('');
    expect(() => storeAuthor('Ada')).not.toThrow();
  });
});

describe('the style a tool uses', () => {
  it('is its own for a tool that has one, and the marker`s for a tool without', () => {
    for (const tool of STYLED_TOOLS) expect(styledToolOf(tool)).toBe(tool);
    expect(styledToolOf('select')).toBe('highlight');
    expect(styledToolOf('redact')).toBe('highlight');
  });
});
