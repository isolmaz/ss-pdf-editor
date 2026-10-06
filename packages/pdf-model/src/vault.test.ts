/**
 * The vault retention policy, against the cases that make deletion dangerous.
 *
 * The cases worth testing are not “does the happy path delete” but the ones where a
 * wrong answer destroys a document: a shared source blob, an incomplete inventory, a
 * document whose manifest was deleted but whose bytes are still in the vault, and two
 * manifests pointing at one key.
 */

import { describe, expect, it } from 'vitest';
import type { Draft, DraftInventory, DraftSnapshot } from './drafts';
import { keysForDraft, planDocumentCleanup, planVaultCleanup } from './vault';

function draft(id: string, sourceKey: string, snapshotKeys: readonly string[] = []): Draft {
  return {
    id,
    name: `${id}.pdf`,
    pageCount: 1,
    size: 1024,
    dirty: true,
    updatedAt: 1,
    sourceKey,
    snapshots: snapshotKeys.map(
      (key, index): DraftSnapshot => ({
        id: `${id}-snap-${index}`,
        key,
        pageCount: 1,
        inputBytes: 512,
        labelKey: 'op.test' as DraftSnapshot['labelKey'],
      }),
    ),
    engineValues: { entries: [], dropped: 0 },
    journal: [],
  };
}

function inventory(drafts: readonly Draft[], extra: Partial<DraftInventory> = {}): DraftInventory {
  return { drafts, unreadable: [], ...extra };
}

describe('keysForDraft', () => {
  it('names the source blob and every snapshot blob the document owns', () => {
    expect(keysForDraft(draft('a', 'src-hash', ['snapshot-1', 'snapshot-2']))).toEqual([
      'src-hash',
      'snapshot-1',
      'snapshot-2',
    ]);
    expect(keysForDraft(draft('b', 'src-only'))).toEqual(['src-only']);
  });
});

describe('planVaultCleanup', () => {
  it('deletes only the blobs nothing references', () => {
    const plan = planVaultCleanup({
      open: [{ source: 'src-open', snapshots: ['snapshot-open'] }],
      storedSources: ['src-open', 'snapshot-open', 'src-manifest', 'snapshot-manifest', 'src-orphan'],
      inventory: inventory([draft('kept', 'src-manifest', ['snapshot-manifest'])]),
    });
    expect(plan).toEqual({ ok: true, deleteKeys: ['src-orphan'], retained: 4 });
  });

  it('refuses when the directory could not be listed', () => {
    // The dangerous case: an empty `drafts` array from a *failed* enumeration looks
    // exactly like “no drafts”, and sweeping on that removes every live document's bytes.
    const plan = planVaultCleanup({
      open: [],
      storedSources: ['src-a', 'src-b'],
      inventory: inventory([], { enumerationFailed: true }),
    });
    expect(plan).toEqual({ ok: false, reason: 'incomplete-inventory' });
  });

  it('refuses when a manifest could not be read', () => {
    const plan = planVaultCleanup({
      open: [],
      storedSources: ['src-a'],
      inventory: inventory([draft('readable', 'src-a')], { unreadable: ['broken.json'] }),
    });
    expect(plan).toEqual({ ok: false, reason: 'incomplete-inventory' });
  });

  it('keeps a blob shared by two manifests', () => {
    // Two documents, one content-addressed source: the same bytes opened twice.
    const plan = planVaultCleanup({
      open: [],
      storedSources: ['src-shared'],
      inventory: inventory([draft('one', 'src-shared'), draft('two', 'src-shared')]),
    });
    expect(plan).toEqual({ ok: true, deleteKeys: [], retained: 1 });
  });

  it('keeps a blob another window reported as live', () => {
    const plan = planVaultCleanup({
      open: [],
      storedSources: ['src-other-window', 'src-orphan'],
      inventory: inventory([]),
      peerReferences: ['src-other-window'],
    });
    expect(plan).toEqual({ ok: true, deleteKeys: ['src-orphan'], retained: 1 });
  });
});

describe('planDocumentCleanup', () => {
  const input = {
    open: [{ source: 'src-open', snapshots: [] }],
    storedSources: ['src-open', 'src-shared', 'src-doomed', 'snapshot-doomed', 'snapshot-shared'],
    inventory: inventory([
      draft('doomed', 'src-doomed', ['snapshot-doomed']),
      draft('other', 'src-shared', ['snapshot-shared']),
    ]),
  };

  it('removes exactly the keys no other document holds', () => {
    expect(
      planDocumentCleanup({ manifestId: 'doomed', keys: ['src-doomed', 'snapshot-doomed'] }, input),
    ).toEqual(['src-doomed', 'snapshot-doomed']);
  });

  it('keeps a key that another manifest also references', () => {
    expect(planDocumentCleanup({ manifestId: 'doomed', keys: ['src-shared'] }, input)).toEqual([]);
  });

  it('keeps a key a document still open in this window references', () => {
    expect(planDocumentCleanup({ manifestId: 'doomed', keys: ['src-open'] }, input)).toEqual([]);
  });

  it('keeps a key another window reported as live', () => {
    expect(
      planDocumentCleanup(
        { manifestId: 'doomed', keys: ['src-doomed', 'snapshot-doomed'] },
        { ...input, peerReferences: ['snapshot-doomed'] },
      ),
    ).toEqual(['src-doomed']);
  });

  it('keeps a snapshot key an open document in this window references', () => {
    expect(
      planDocumentCleanup(
        { manifestId: 'doomed', keys: ['src-doomed', 'snapshot-doomed'] },
        { ...input, open: [{ source: 'src-open', snapshots: ['snapshot-doomed'] }] },
      ),
    ).toEqual(['src-doomed']);
  });

  it('keeps a snapshot key another manifest also references', () => {
    expect(planDocumentCleanup({ manifestId: 'doomed', keys: ['snapshot-shared'] }, input)).toEqual([]);
  });

  it('returns null rather than a plan when the inventory is incomplete', () => {
    expect(
      planDocumentCleanup(
        { manifestId: 'doomed', keys: ['src-doomed'] },
        { ...input, inventory: inventory([], { enumerationFailed: true }) },
      ),
    ).toBeNull();
    expect(
      planDocumentCleanup(
        { manifestId: 'doomed', keys: ['src-doomed'] },
        {
          ...input,
          inventory: inventory([draft('doomed', 'src-doomed')], { unreadable: ['x.json'] }),
        },
      ),
    ).toBeNull();
  });
});
