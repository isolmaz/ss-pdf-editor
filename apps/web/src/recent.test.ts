import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRecentDocument,
  clearRecentDocuments,
  loadRecentDocuments,
  removeRecentDocument,
  saveRecentDocuments,
  toggleStarRecentDocument,
} from './recent';

let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

const doc = (id: string, name: string, extra: { starred?: boolean; openedAt?: number } = {}) => ({
  id,
  name,
  sizeBytes: 10,
  pageCount: 2,
  openedAt: extra.openedAt ?? 1,
  ...(extra.starred === undefined ? {} : { starred: extra.starred }),
});

describe('recent documents', () => {
  it('adds the newest first and replaces an earlier opening of the same id or name', () => {
    addRecentDocument(doc('a', 'one.pdf'));
    addRecentDocument(doc('b', 'two.pdf'));
    const list = addRecentDocument(doc('c', 'one.pdf', { openedAt: 5 }));
    expect(list.map((item) => [item.id, item.name])).toEqual([
      ['c', 'one.pdf'],
      ['b', 'two.pdf'],
    ]);
    expect(loadRecentDocuments()).toEqual(list);
  });

  it('a reopened starred file keeps its star, and an explicit value wins', () => {
    addRecentDocument(doc('a', 'one.pdf', { starred: true }));
    expect(addRecentDocument(doc('b', 'one.pdf'))[0]?.starred).toBe(true);
    expect(addRecentDocument(doc('c', 'one.pdf', { starred: false }))[0]?.starred).toBe(false);
  });

  it('stamps the opening time when none is given', () => {
    vi.spyOn(Date, 'now').mockReturnValue(4242);
    const { id, name, sizeBytes, pageCount } = doc('a', 'one.pdf');
    expect(addRecentDocument({ id, name, sizeBytes, pageCount })[0]?.openedAt).toBe(4242);
    vi.restoreAllMocks();
  });

  it('removes, stars and clears by id', () => {
    addRecentDocument(doc('a', 'one.pdf'));
    addRecentDocument(doc('b', 'two.pdf'));
    expect(toggleStarRecentDocument('a').find((item) => item.id === 'a')?.starred).toBe(true);
    expect(toggleStarRecentDocument('a').find((item) => item.id === 'a')?.starred).toBe(false);
    expect(removeRecentDocument('a').map((item) => item.id)).toEqual(['b']);
    expect(clearRecentDocuments()).toEqual([]);
    expect(loadRecentDocuments()).toEqual([]);
  });

  it('drops stored entries of the wrong shape and unreadable stored values', () => {
    values.set('pdf_editor_recent_docs_v1', JSON.stringify([doc('a', 'ok.pdf'), { id: 'x' }, null, 'text']));
    expect(loadRecentDocuments().map((item) => item.id)).toEqual(['a']);
    values.set('pdf_editor_recent_docs_v1', '{"not":"an array"}');
    expect(loadRecentDocuments()).toEqual([]);
    values.set('pdf_editor_recent_docs_v1', '{broken');
    expect(loadRecentDocuments()).toEqual([]);
  });

  it('tolerates a store that refuses writes', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => saveRecentDocuments([doc('a', 'one.pdf')])).not.toThrow();
  });
});
