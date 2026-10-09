import { describe, expect, it } from 'vitest';
import { JOURNAL_SCHEMA, type JournalEntry, OperationJournal } from './journal';

/**
 * Behavioural contract of the single chronological journal.
 * These are the properties the undo/redo UI and the save router depend on; the
 * `highlight → rotate → comment → undo×3` case is the acceptance case.
 */

const op = (kind: string, labelKey: string, engine: JournalEntry['engine'] = 'model') =>
  ({ kind, labelKey, engine, op: { kind, payload: { at: kind } } }) as const;

describe('OperationJournal', () => {
  it('undoes in strict chronological order across engines', () => {
    const journal = new OperationJournal();
    journal.append(op('highlight', 'Annotated', 'pdfjs-editor'));
    journal.append(op('rotate', 'Rotated page 3'));
    journal.append(op('comment', 'Commented', 'pdfjs-editor'));

    const undone = [journal.undo()?.op.kind, journal.undo()?.op.kind, journal.undo()?.op.kind];
    expect(undone).toEqual(['comment', 'rotate', 'highlight']);
    expect(journal.canUndo).toBe(false);
    expect(journal.cursor).toBe(0);
  });

  it('redoes forward again after undoing', () => {
    const journal = new OperationJournal();
    journal.append(op('a', 'A'));
    journal.append(op('b', 'B'));
    journal.undo();
    journal.undo();
    expect([journal.redo()?.op.kind, journal.redo()?.op.kind]).toEqual(['a', 'b']);
    expect(journal.canRedo).toBe(false);
  });

  it('truncates the redo tail on append and reports what it dropped', () => {
    const journal = new OperationJournal();
    journal.append(op('a', 'A'));
    journal.append(op('b', 'B'));
    journal.append(op('c', 'C'));
    journal.undo();
    journal.undo();

    const result = journal.append(op('d', 'D', 'mupdf'));
    expect(result.discarded.map((entry) => entry.op.kind)).toEqual(['b', 'c']);
    expect(journal.length).toBe(2);
    expect(journal.entries.map((entry) => entry.op.kind)).toEqual(['a', 'd']);
    expect(journal.canRedo).toBe(false);
    expect(result.entry.seq).toBe(1);
  });

  it('survives a JSON round trip with its cursor and keeps working', () => {
    const journal = new OperationJournal();
    journal.append(op('a', 'A'));
    journal.append(op('b', 'B'));
    journal.append(op('c', 'C'));
    journal.undo();

    const restored = OperationJournal.fromJSON(JSON.parse(JSON.stringify(journal.toJSON())));
    expect(restored.length).toBe(3);
    expect(restored.cursor).toBe(2);
    expect(restored.undo()?.op.kind).toBe('b');
    expect(restored.redo()?.op.kind).toBe('b');
  });

  it('does not alias the snapshot array it was restored from', () => {
    const source = new OperationJournal();
    source.append(op('a', 'A'));
    const snapshot = { ...source.toJSON(), entries: [...source.toJSON().entries] };
    const restored = OperationJournal.fromJSON(snapshot);
    (snapshot.entries as JournalEntry[]).push(snapshot.entries[0] as JournalEntry);
    expect(restored.length).toBe(1);
  });

  it('amends only the newest entry at the head, as one undo step with a fresh id', () => {
    const journal = new OperationJournal();
    expect(journal.amendLast({ kind: 'x', payload: 1 })).toBeUndefined();

    journal.append(op('a', 'A'));
    const second = journal.append(op('b', 'B')).entry;
    const before = journal.entries;
    const amended = journal.amendLast({ kind: 'b2', payload: 2 });
    expect(amended?.op).toEqual({ kind: 'b2', payload: 2 });
    expect(amended?.labelKey).toBe('B');
    expect(amended?.seq).toBe(second.seq);
    expect(amended?.id).not.toBe(second.id);
    expect(journal.length).toBe(2);
    expect(journal.entries.map((entry) => entry.op.kind)).toEqual(['a', 'b2']);
    expect(before.map((entry) => entry.op.kind)).toEqual(['a', 'b']);

    journal.undo();
    expect(journal.amendLast({ kind: 'nope', payload: 0 })).toBeUndefined();
    expect(journal.entries.map((entry) => entry.op.kind)).toEqual(['a', 'b2']);
    journal.undo();
    expect(journal.amendLast({ kind: 'nope', payload: 0 })).toBeUndefined();
  });

  it('restores a snapshot whose cursor is zero', () => {
    const source = new OperationJournal();
    source.append(op('a', 'A'));
    source.undo();
    const restored = OperationJournal.fromJSON(source.toJSON());
    expect(restored.cursor).toBe(0);
    expect(restored.redo()?.op.kind).toBe('a');
  });

  it('refuses a fractional or non-finite cursor', () => {
    const entries = new OperationJournal();
    entries.append(op('a', 'A'));
    entries.append(op('b', 'B'));
    for (const cursor of [0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => OperationJournal.fromJSON({ ...entries.toJSON(), cursor }), String(cursor)).toThrow(
        /cursor/,
      );
    }
  });

  it('stamps every entry with a unique id, the current schema, its position and a time', () => {
    const journal = new OperationJournal();
    const before = Date.now();
    const first = journal.append(op('a', 'A')).entry;
    const second = journal.append(op('b', 'B')).entry;
    expect(first.id).not.toBe(second.id);
    expect([first.seq, second.seq]).toEqual([0, 1]);
    expect([first.schema, second.schema]).toEqual([JOURNAL_SCHEMA, JOURNAL_SCHEMA]);
    expect(first.timestamp).toBeGreaterThanOrEqual(before);
    expect(first.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('returns nothing, and tells nobody, when there is nothing to undo or redo', () => {
    const journal = new OperationJournal();
    let calls = 0;
    journal.subscribe(() => {
      calls += 1;
    });
    expect(journal.undo()).toBeUndefined();
    expect(journal.redo()).toBeUndefined();
    journal.append(op('a', 'A'));
    expect(journal.redo()).toBeUndefined();
    expect(journal.cursor).toBe(1);
    journal.undo();
    expect(journal.undo()).toBeUndefined();
    expect(journal.cursor).toBe(0);
    expect(calls).toBe(2);
  });

  it('empties the entries and the cursor on clear, and notifies', () => {
    const journal = new OperationJournal();
    journal.append(op('a', 'A'));
    journal.append(op('b', 'B'));
    let calls = 0;
    journal.subscribe(() => {
      calls += 1;
    });
    journal.clear();
    expect([journal.length, journal.cursor, journal.canUndo, journal.canRedo]).toEqual([0, 0, false, false]);
    expect(calls).toBe(1);
  });

  it('refuses a snapshot written by another schema version', () => {
    expect(() => OperationJournal.fromJSON({ schema: JOURNAL_SCHEMA + 1, entries: [], cursor: 0 })).toThrow(
      /schema/,
    );
  });

  it('refuses a cursor that points outside the entries it restored', () => {
    // Clamping would move the document to a state the user never left: the cursor is
    // the *identity* of the restored version, so a cursor that does not fit its entries is
    // corruption to report, not a number to round.
    const entry = {
      id: 'x',
      seq: 0,
      labelKey: 'A',
      engine: 'model',
      op: { kind: 'a', payload: null },
      schema: JOURNAL_SCHEMA,
      timestamp: 1,
    } as const;
    expect(() => OperationJournal.fromJSON({ schema: JOURNAL_SCHEMA, entries: [entry], cursor: 9 })).toThrow(
      /cursor/,
    );
    expect(() => OperationJournal.fromJSON({ schema: JOURNAL_SCHEMA, entries: [entry], cursor: -1 })).toThrow(
      /cursor/,
    );
    // The boundary itself is a legal cursor: everything applied, nothing to redo.
    const restored = OperationJournal.fromJSON({ schema: JOURNAL_SCHEMA, entries: [entry], cursor: 1 });
    expect(restored.cursor).toBe(1);
    expect(restored.canRedo).toBe(false);
    expect(restored.canUndo).toBe(true);
  });

  it('notifies subscribers on every mutation and stops after unsubscribe', () => {
    const journal = new OperationJournal();
    let calls = 0;
    const unsubscribe = journal.subscribe(() => {
      calls += 1;
    });
    journal.append(op('a', 'A'));
    journal.undo();
    journal.redo();
    unsubscribe();
    journal.append(op('b', 'B'));
    expect(calls).toBe(3);
  });
});
