/**
 * Draft validation and engine-value encoding.
 *
 * A draft read from storage is untrusted input, and the two ways it can lie are the ones
 * worth testing: a journal that was silently *repaired* (so the restored cursor points at
 * a different state), and an engine value that was silently *projected* (so the restored
 * annotation is not the one that was saved).
 */

import { describe, expect, it } from 'vitest';
import type { Draft, DraftSnapshot } from './drafts';
import {
  decodeEngineValues,
  draftFor,
  EMPTY_ENGINE_VALUES,
  encodeEngineValues,
  isRestorable,
  parseDraft,
  sortDrafts,
  sourceKeyFor,
} from './drafts';
import { JOURNAL_SCHEMA } from './journal';

function entry(seq: number, id: string): Record<string, unknown> {
  return {
    id,
    seq,
    labelKey: 'op.progress.compose.rotate',
    engine: 'model',
    schema: JOURNAL_SCHEMA,
    timestamp: 1_700_000_000_000 + seq,
    op: {
      kind: 'document.change',
      payload: {
        before: null,
        beforeOverlays: null,
        afterOverlays: null,
        after: id,
        engine: 'mupdf',
        steps: [],
      },
    },
  };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const snapshot: DraftSnapshot = {
    id: 'snap-1',
    key: 'snapshot-snap-1',
    pageCount: 2,
    inputBytes: 4096,
    labelKey: 'op.progress.compose.rotate',
  };
  return {
    id: 'draft-1',
    name: 'sozlesme.pdf',
    pageCount: 2,
    size: 2048,
    dirty: true,
    updatedAt: 1,
    sourceKey: 'src-abc',
    engineValues: EMPTY_ENGINE_VALUES,
    journal: [entry(0, 'e0'), entry(1, 'e1')],
    journalCursor: 1,
    snapshots: [snapshot],
    workingId: 'snap-1',
    ...overrides,
  };
}

describe('parseDraft — the journal is read as a unit', () => {
  it('accepts a draft this build wrote, cursor included', () => {
    const parsed = parseDraft(draft());
    expect(parsed).not.toBeNull();
    expect(parsed?.journal).toHaveLength(2);
    expect(parsed?.journalCursor).toBe(1);
    expect(parsed?.snapshots?.[0]?.key).toBe('snapshot-snap-1');
  });

  it('rejects a journal with a malformed entry instead of silently shifting the cursor', () => {
    // The dangerous shape: one entry lost, the cursor kept. A filter would leave two
    // entries and a cursor of 1 pointing at the *other* state.
    const broken = draft({
      journal: [entry(0, 'e0'), { id: 'e1', seq: 1 }, entry(2, 'e2')],
      journalCursor: 3,
    });
    expect(parseDraft(broken)).toBeNull();
  });

  it('rejects a journal whose sequence does not advance by one', () => {
    expect(parseDraft(draft({ journal: [entry(0, 'e0'), entry(3, 'e1')] }))).toBeNull();
  });

  it('rejects duplicate entry ids', () => {
    expect(parseDraft(draft({ journal: [entry(0, 'same'), entry(1, 'same')] }))).toBeNull();
  });

  it('rejects a cursor outside the journal rather than clamping it', () => {
    expect(parseDraft(draft({ journalCursor: 5 }))).toBeNull();
    expect(parseDraft(draft({ journalCursor: -1 }))).toBeNull();
    expect(parseDraft(draft({ journalCursor: 1.5 }))).toBeNull();
    // An absent cursor means "everything is applied", which is what the model writes.
    expect(parseDraft(draft({ journalCursor: undefined }))?.journalCursor).toBe(2);
  });

  it('rejects page counts and sizes that are not safe non-negative integers', () => {
    expect(parseDraft(draft({ pageCount: 0 }))?.pageCount).toBe(0);
    expect(parseDraft(draft({ pageCount: -1 }))).toBeNull();
    expect(parseDraft(draft({ pageCount: 1.5 }))).toBeNull();
    expect(parseDraft(draft({ pageCount: 2 ** 53 }))).toBeNull();
    expect(parseDraft(draft({ size: Number.NaN }))).toBeNull();
  });

  it('rejects a snapshot set whose ids or keys collide, or whose workingId is absent', () => {
    const first: DraftSnapshot = {
      id: 'a',
      key: 'k1',
      pageCount: 1,
      inputBytes: 10,
      labelKey: 'op.progress.compose.rotate',
    };
    const duplicateId: DraftSnapshot = {
      id: 'a',
      key: 'k2',
      pageCount: 1,
      inputBytes: 10,
      labelKey: 'op.progress.compose.rotate',
    };
    const duplicateKey: DraftSnapshot = {
      id: 'b',
      key: 'k1',
      pageCount: 1,
      inputBytes: 10,
      labelKey: 'op.progress.compose.rotate',
    };
    expect(parseDraft(draft({ snapshots: [first, duplicateId] }))).toBeNull();
    expect(parseDraft(draft({ snapshots: [first, duplicateKey] }))).toBeNull();
    expect(parseDraft(draft({ snapshots: [first], workingId: 'ghost' }))).toBeNull();
    expect(
      parseDraft(draft({ snapshots: [{ id: 'a', key: 'k1', pageCount: 0, inputBytes: 1, labelKey: 'l' }] })),
    ).toBeNull();
  });

  it('keeps a draft with no snapshots at all restorable', () => {
    const parsed = parseDraft(draft({ snapshots: undefined, workingId: undefined }));
    expect(parsed?.snapshots).toEqual([]);
  });
});

describe('encodeEngineValues — nothing is stored as something else', () => {
  it('round-trips plain values', async () => {
    const encoded = await encodeEngineValues([
      ['field.1', { value: 'İbrahim', kind: 'text' }],
      ['field.2', { value: 3, flags: [true, null] }],
    ]);
    expect(encoded.dropped).toBe(0);
    expect(encoded.entries.map((item) => item.key)).toEqual(['field.1', 'field.2']);
    expect(encoded.entries[0]?.value).toEqual({ value: 'İbrahim', kind: 'text' });
  });

  it('drops a typed array instead of projecting it into an index-keyed object', async () => {
    // `Object.entries(new Uint8Array([1, 2]))` is `{0: 1, 1: 2}` — an object that is not
    // the value that was saved, and that a restore would hand back as a plain record.
    const encoded = await encodeEngineValues([
      ['mask', { bytes: new Uint8Array([1, 2, 3]) }],
      ['ok', { value: 1 }],
    ]);
    expect(encoded.entries.map((item) => item.key)).toEqual(['ok']);
    expect(encoded.dropped).toBe(1);
  });

  it('drops other non-plain objects, class instances and promises', async () => {
    class Marker {
      readonly id = 1;
    }
    const encoded = await encodeEngineValues([
      ['map', new Map([['a', 1]])],
      ['date', new Date(0)],
      ['marker', new Marker()],
      ['promise', Promise.resolve(1)],
      ['plain', { value: 'kept' }],
    ]);
    expect(encoded.entries.map((item) => item.key)).toEqual(['plain']);
    expect(encoded.dropped).toBe(4);
  });

  it('charges the bitmap budget only for entries that survive', async () => {
    const bitmap = new Blob([new Uint8Array(64)]);
    // A budget of 100 bytes: the first entry claims 64 for its bitmap and is then refused
    // because a sibling member is unrepresentable. The bytes it claimed must come back, or
    // the second entry — which fits — would be dropped for no reason.
    const encoded = await encodeEngineValues(
      [
        ['doomed', { mask: bitmap, doomed: new Uint8Array(4) }],
        ['survivor', { mask: new Blob([new Uint8Array(32)]) }],
      ],
      100,
    );
    expect(encoded.entries.map((item) => item.key)).toEqual(['survivor']);
    expect(encoded.dropped).toBe(1);
  });

  it('still refuses a bitmap that cannot fit the budget at all', async () => {
    const encoded = await encodeEngineValues([['big', { mask: new Blob([new Uint8Array(200)]) }]], 100);
    expect(encoded.entries).toHaveLength(0);
    expect(encoded.dropped).toBe(1);
  });
});

describe('parseDraft — engine values survive the JSON round trip', () => {
  it('keeps plain entries and counts the ones that are not plain objects', () => {
    const parsed = parseDraft(
      draft({
        engineValues: {
          entries: [{ key: 'a', value: { value: 'x' } }, { key: 'b', value: 7 }, 'garbage'],
          dropped: 1,
        },
      }),
    ) as Draft | null;
    expect(parsed?.engineValues.entries.map((item) => item.key)).toEqual(['a']);
    expect(parsed?.engineValues.dropped).toBe(1);
  });
});

describe('parseDraft — every journal entry field is checked', () => {
  function withEntry(patch: Record<string, unknown>) {
    return draft({ journal: [{ ...entry(0, 'e0'), ...patch }], journalCursor: 1 });
  }

  it('accepts the baseline entry the mutations below start from', () => {
    expect(parseDraft(withEntry({}))).not.toBeNull();
  });

  it.each([
    ['an empty id', { id: '' }],
    ['a non-string id', { id: 7 }],
    ['an empty labelKey', { labelKey: '' }],
    ['a missing labelKey', { labelKey: undefined }],
    ['an unknown engine', { engine: 'qpdf' }],
    ['another schema version', { schema: JOURNAL_SCHEMA + 1 }],
    ['a fractional timestamp', { timestamp: 1.5 }],
    ['a missing timestamp', { timestamp: undefined }],
    ['a negative seq', { seq: -1 }],
    ['no operation', { op: undefined }],
    ['a null operation', { op: null }],
    ['an operation without a kind', { op: { payload: null } }],
  ])('rejects an entry with %s', (_name, patch) => {
    expect(parseDraft(withEntry(patch))).toBeNull();
  });
});

describe('parseDraft — required fields and optional carry-over', () => {
  it('rejects a draft without a string id, name or sourceKey', () => {
    expect(parseDraft(draft({ id: 3 }))).toBeNull();
    expect(parseDraft(draft({ name: undefined }))).toBeNull();
    expect(parseDraft(draft({ sourceKey: undefined }))).toBeNull();
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('draft')).toBeNull();
  });

  it('rejects a snapshot missing its label, id or byte count', () => {
    const base = { id: 'a', key: 'k', pageCount: 1, inputBytes: 10, labelKey: 'op.progress.compose.rotate' };
    const only = (snapshot: Record<string, unknown>) =>
      parseDraft(draft({ snapshots: [snapshot], workingId: undefined }));
    expect(only({ ...base, labelKey: undefined })).toBeNull();
    expect(only({ ...base, inputBytes: -1 })).toBeNull();
    expect(only({ ...base, id: undefined })).toBeNull();
    expect(only(base)?.snapshots).toHaveLength(1);
  });

  it('carries dirty, updatedAt and the optional state fields through unchanged', () => {
    const parsed = parseDraft(
      draft({
        dirty: true,
        updatedAt: 1234,
        stateId: 'state-9',
        savedState: 'state-3',
        overlays: { annotations: [] },
        sourcePageCount: 7,
      }),
    );
    expect(parsed).toMatchObject({
      dirty: true,
      updatedAt: 1234,
      stateId: 'state-9',
      savedState: 'state-3',
      overlays: { annotations: [] },
      sourcePageCount: 7,
      workingId: 'snap-1',
    });
    expect(parseDraft(draft({ dirty: false, updatedAt: undefined }))).toMatchObject({
      dirty: false,
      updatedAt: 0,
    });
    expect(parseDraft(draft({ savedState: null }))?.savedState).toBeNull();
    const bare = parseDraft(draft());
    expect(bare).not.toHaveProperty('stateId');
    expect(bare).not.toHaveProperty('overlays');
  });

  it('drops an engine value whose key is not a string', () => {
    const parsed = parseDraft(
      draft({
        engineValues: {
          entries: [
            { key: 4, value: { a: 1 } },
            { key: 'ok', value: { a: 1 } },
          ],
          dropped: 0,
        },
      }),
    );
    expect(parsed?.engineValues.entries.map((item) => item.key)).toEqual(['ok']);
  });
});

describe('encodeEngineValues — refusals', () => {
  it('drops a non-finite number, a scalar and a value nested too deep', async () => {
    const nested = (levels: number): Record<string, unknown> =>
      levels === 0 ? { leaf: 1 } : { next: nested(levels - 1) };
    const encoded = await encodeEngineValues([
      ['nan', { value: Number.NaN }],
      ['inf', { value: Number.POSITIVE_INFINITY }],
      ['deep', nested(20)],
      ['shallow', nested(2)],
      ['scalar', 5 as unknown as object],
    ]);
    expect(encoded.entries.map((item) => item.key)).toEqual(['shallow']);
    expect(encoded.dropped).toBe(4);
  });
});

describe('engine values — bitmaps survive the full save/restore trip', () => {
  it('stores a Blob as bytes and type and returns an identical Blob', async () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 255, 128]);
    const encoded = await encodeEngineValues([
      [
        'ink',
        { mask: new Blob([original], { type: 'image/png' }), label: 'x', list: [new Blob([original])] },
      ],
    ]);
    // What storage keeps is JSON, so the trip goes through a real stringify/parse.
    const stored = JSON.parse(JSON.stringify(encoded));
    const parsed = parseDraft(draft({ engineValues: stored }));
    const decoded = decodeEngineValues(parsed?.engineValues ?? EMPTY_ENGINE_VALUES);
    expect(decoded.map(([key]) => key)).toEqual(['ink']);
    const value = decoded[0]?.[1] as { mask: Blob; label: string; list: Blob[] };
    expect(value.label).toBe('x');
    expect(value.mask).toBeInstanceOf(Blob);
    expect(value.mask.type).toBe('image/png');
    expect([...new Uint8Array(await value.mask.arrayBuffer())]).toEqual([...original]);
    const listed = value.list[0] as Blob;
    expect(listed).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await listed.arrayBuffer())]).toEqual([...original]);
  });

  it('leaves plain values alone when decoding', () => {
    expect(
      decodeEngineValues({ entries: [{ key: 'a', value: { n: 1, s: ['x', null] } }], dropped: 0 }),
    ).toEqual([['a', { n: 1, s: ['x', null] }]]);
  });
});

describe('draft helpers', () => {
  const base = {
    id: 'd',
    name: 'n.pdf',
    pageCount: 1,
    size: 1,
    sourceKey: 's',
  };

  it('draftFor defaults the cursor to "everything applied" and carries optional fields only when given', () => {
    const journal = [entry(0, 'a'), entry(1, 'b')] as never;
    const made = draftFor({ ...base, dirty: true, journal, now: 42 });
    expect(made.journalCursor).toBe(2);
    expect(made.updatedAt).toBe(42);
    expect(made.engineValues).toBe(EMPTY_ENGINE_VALUES);
    expect(made).not.toHaveProperty('stateId');
    const explicit = draftFor({ ...base, dirty: false, journal, journalCursor: 1, stateId: 'st', now: 1 });
    expect(explicit.journalCursor).toBe(1);
    expect(explicit.stateId).toBe('st');
  });

  it('sortDrafts puts the newest first and leaves its input alone', () => {
    const old = parseDraft(draft({ id: 'old', updatedAt: 1 })) as Draft;
    const fresh = parseDraft(draft({ id: 'fresh', updatedAt: 9 })) as Draft;
    const input = [old, fresh];
    expect(sortDrafts(input).map((item) => item.id)).toEqual(['fresh', 'old']);
    expect(input.map((item) => item.id)).toEqual(['old', 'fresh']);
  });

  it('isRestorable keeps a dirty draft or one with history, and drops a clean empty one', () => {
    const clean = parseDraft(draft({ dirty: false, journal: [], journalCursor: 0 })) as Draft;
    expect(isRestorable(clean)).toBe(false);
    expect(isRestorable({ ...clean, dirty: true })).toBe(true);
    expect(isRestorable(parseDraft(draft({ dirty: false })) as Draft)).toBe(true);
  });

  it('sourceKeyFor falls back to the document id and does not prefix an already-keyed hash twice', () => {
    expect(sourceKeyFor('doc-1', null)).toBe('doc-1');
    expect(sourceKeyFor('doc-1', '')).toBe('doc-1');
    expect(sourceKeyFor('doc-1', 'abc')).toBe('src-abc');
    expect(sourceKeyFor('doc-1', 'src-abc')).toBe('src-abc');
    expect(sourceKeyFor('doc-1', 'fp-abc')).toBe('fp-abc');
  });
});

describe('encodeEngineValues and parseDraft — the remaining shapes', () => {
  it('drops an entry whose array or members cannot be represented, and keeps a plain one', async () => {
    const encoded = await encodeEngineValues([
      ['list', { items: [1, new Map()] }],
      ['callback', { onChange: () => 1 }],
      ['big', { count: 10n }],
      ['plain', { items: [1, 'two'] }],
    ]);
    expect(encoded.entries).toEqual([{ key: 'plain', value: { items: [1, 'two'] } }]);
    expect(encoded.dropped).toBe(3);
  });

  it('drops a plain object that is a thenable through a hidden `then`, which the member walk would not see', async () => {
    const thenable = { value: 1 };
    Object.defineProperty(thenable, 'then', { value: () => undefined, enumerable: false });
    const encoded = await encodeEngineValues([['thenable', thenable]]);
    expect(encoded.entries).toEqual([]);
    expect(encoded.dropped).toBe(1);
  });

  it('gives a stored bitmap without a type the generic byte type', async () => {
    const decoded = decodeEngineValues({
      entries: [{ key: 'mask', value: { image: { __pdfEditorBitmap: 'AQID', type: 5 } } }],
      dropped: 0,
    });
    const [key, value] = decoded[0] ?? [];
    expect(key).toBe('mask');
    const image = value?.image;
    if (!(image instanceof Blob)) throw new Error('the bitmap did not come back as a Blob');
    expect(image.type).toBe('application/octet-stream');
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('reads a draft written before journals and engine values existed as an empty history', () => {
    const parsed = parseDraft(
      draft({
        journal: undefined,
        journalCursor: undefined,
        engineValues: undefined,
        snapshots: undefined,
        workingId: undefined,
      }),
    );
    expect(parsed?.journal).toEqual([]);
    expect(parsed?.journalCursor).toBe(0);
    expect(parsed?.engineValues).toEqual({ entries: [], dropped: 0 });
    expect(parseDraft(draft({ engineValues: { entries: [], dropped: 'many' } }))?.engineValues.dropped).toBe(
      0,
    );
  });

  it('refuses a journal entry or a snapshot that is not an object', () => {
    expect(parseDraft(draft({ journal: [null], journalCursor: 1 }))).toBeNull();
    expect(parseDraft(draft({ journal: ['entry'], journalCursor: 1 }))).toBeNull();
    expect(parseDraft(draft({ snapshots: [null] }))).toBeNull();
    expect(parseDraft(draft({ snapshots: ['snap-1'] }))).toBeNull();
  });
});
