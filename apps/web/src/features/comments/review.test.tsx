// @vitest-environment happy-dom
/**
 * Answering a comment: a mark the session holds keeps the reply or state itself (marked dirty,
 * said on the status line); a comment the file carries is written through the shell's one
 * file-annotation writer, as the exact record the review writer takes. Taking a reply back
 * follows the same split.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { AnnotationMark } from 'pdf-core/ops/annotations';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { markTargetKey } from 'pdf-ui/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingOverlays } from '../../operations';
import { coreStore, initialCoreState } from '../core/core-store';
import { type OverlayChange, writeOverlay } from '../core/overlays';
import { answerComment, type ReviewHost, removeReply, useCommentReview } from './review';

const writeCommentReview = vi.hoisted(() => vi.fn());
vi.mock('pdf-core/ops/annotation-review', () => ({ writeCommentReview }));

const t = createTranslator('en');

function mark(id: string, extra: Partial<AnnotationMark> = {}): AnnotationMark {
  return {
    id,
    kind: 'note',
    pageIndex: 0,
    quads: [],
    color: '#ffcc00',
    opacity: 1,
    contents: 'body',
    author: 'Ada',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function openSession(marks: readonly AnnotationMark[] = []) {
  const session = new SessionStore();
  session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'hash', pageCount: 1 });
  if (marks.length > 0) writeOverlay(session, 'annotations', marks, 'ann.engineEdit');
  const id = session.active?.id ?? '';
  session.setDirty(id, false);
  return session;
}

function hostFor(session: SessionStore, author = 'Grace') {
  const writeFileAnnotation = vi.fn(() => true);
  const removeTargets = vi.fn();
  const host: ReviewHost = {
    session,
    t,
    author,
    setAnnotations: (change: OverlayChange<readonly AnnotationMark[]>) =>
      writeOverlay(session, 'annotations', change, 'ann.engineEdit'),
    writeFileAnnotation,
    removeTargets,
  };
  return { host, writeFileAnnotation, removeTargets };
}

const marksOf = (session: SessionStore) => pendingOverlays(session.active).annotations;

beforeEach(() => {
  coreStore.set(initialCoreState());
  writeCommentReview.mockReset();
  vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-06T07:08:09.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('answerComment on a mark the session holds', () => {
  it('appends the reply to that mark only, dirties the tab and says it will be saved with the comment', () => {
    const session = openSession([mark('a'), mark('b', { replies: [] })]);
    const { host, writeFileAnnotation } = hostFor(session);

    answerComment(host, { pending: true, id: 'a', pageIndex: 0 }, { kind: 'reply', contents: 'Agreed' });

    expect(marksOf(session)[0]?.replies).toEqual([
      { id: 'uuid-1', author: 'Grace', contents: 'Agreed', createdAt: '2026-05-06T07:08:09.000Z' },
    ]);
    expect(marksOf(session)[1]).toEqual(mark('b', { replies: [] }));
    expect(session.active?.dirty).toBe(true);
    expect(coreStore.get().notice).toBe('Reply added; it is saved together with the comment.');
    expect(writeFileAnnotation).not.toHaveBeenCalled();
  });

  it('keeps earlier replies in order', () => {
    const earlier = { id: 'r0', author: 'Ada', contents: 'First', createdAt: 'x' };
    const session = openSession([mark('a', { replies: [earlier] })]);
    const { host } = hostFor(session);

    answerComment(host, { pending: true, id: 'a', pageIndex: 0 }, { kind: 'reply', contents: 'Second' });

    expect(marksOf(session)[0]?.replies?.map((reply) => reply.id)).toEqual(['r0', 'uuid-1']);
  });

  it('sets the review state with who set it and when, and names the author on the line', () => {
    const session = openSession([mark('a')]);
    const { host } = hostFor(session);

    answerComment(host, { pending: true, id: 'a', pageIndex: 0 }, { kind: 'state', state: 'Accepted' });

    expect(marksOf(session)[0]?.review).toEqual({
      state: 'Accepted',
      author: 'Grace',
      at: '2026-05-06T07:08:09.000Z',
    });
    expect(coreStore.get().notice).toBe('Accepted · Grace');
  });

  it('says only the state when no author is set', () => {
    const session = openSession([mark('a')]);
    const { host } = hostFor(session, '  ');

    answerComment(host, { pending: true, id: 'a', pageIndex: 0 }, { kind: 'state', state: 'Rejected' });

    expect(coreStore.get().notice).toBe('Rejected');
  });

  it('marks nothing dirty when no tab is open', () => {
    const session = new SessionStore();
    const setDirty = vi.spyOn(session, 'setDirty');
    const { host } = hostFor(session);

    answerComment(host, { pending: true, id: 'a', pageIndex: 0 }, { kind: 'reply', contents: 'Hi' });

    expect(setDirty).not.toHaveBeenCalled();
    expect(coreStore.get().notice).toBe('Reply added; it is saved together with the comment.');
  });
});

describe('answerComment on a comment the file carries', () => {
  it('writes a reply record through the file-annotation writer', async () => {
    const session = openSession();
    const { host, writeFileAnnotation } = hostFor(session);

    answerComment(host, { pending: false, id: '17R', pageIndex: 2 }, { kind: 'reply', contents: 'Done' });

    expect(coreStore.get().notice).toBeNull();
    expect(writeFileAnnotation).toHaveBeenCalledTimes(1);
    const [label, write, done] = writeFileAnnotation.mock.calls[0] as unknown as [
      unknown,
      (base: Uint8Array, signal: AbortSignal) => Promise<unknown>,
      string,
    ];
    expect(label).toEqual({ key: 'ann.reply.added' });
    expect(done).toBe('The reply was written to the document.');

    const outcome = { written: ['uuid-1'] };
    writeCommentReview.mockResolvedValue(outcome);
    const base = new Uint8Array([9]);
    const signal = new AbortController().signal;
    await expect(write(base, signal)).resolves.toBe(outcome);
    expect(writeCommentReview).toHaveBeenCalledWith(
      base,
      [
        {
          kind: 'reply',
          pageIndex: 2,
          parentId: '17R',
          id: 'uuid-1',
          author: 'Grace',
          createdAt: '2026-05-06T07:08:09.000Z',
          contents: 'Done',
        },
      ],
      { signal },
    );
  });

  it('writes a state record through the file-annotation writer', async () => {
    const session = openSession();
    const { host, writeFileAnnotation } = hostFor(session);

    answerComment(host, { pending: false, id: '9R', pageIndex: 0 }, { kind: 'state', state: 'Completed' });

    const [label, write, done] = writeFileAnnotation.mock.calls[0] as unknown as [
      unknown,
      (base: Uint8Array, signal: AbortSignal) => Promise<unknown>,
      string,
    ];
    expect(label).toEqual({ key: 'ann.state.changed' });
    expect(done).toBe('The review status was written to the document: Completed.');

    writeCommentReview.mockResolvedValue({});
    const base = new Uint8Array([1]);
    const signal = new AbortController().signal;
    await write(base, signal);
    expect(writeCommentReview).toHaveBeenCalledWith(
      base,
      [
        {
          kind: 'state',
          pageIndex: 0,
          parentId: '9R',
          id: 'uuid-1',
          author: 'Grace',
          createdAt: '2026-05-06T07:08:09.000Z',
          state: 'Completed',
        },
      ],
      { signal },
    );
  });
});

describe('removeReply', () => {
  it('takes a session reply off its mark and leaves the other replies and marks', () => {
    const keep = { id: 'r1', author: 'Ada', contents: 'Keep', createdAt: 'x' };
    const drop = { id: 'r2', author: 'Ada', contents: 'Drop', createdAt: 'x' };
    const session = openSession([mark('a', { replies: [keep, drop] }), mark('b', { replies: [drop] })]);
    const { host, removeTargets } = hostFor(session);

    removeReply(host, { pending: true, id: 'a', pageIndex: 0 }, 'r2');

    expect(marksOf(session)[0]?.replies).toEqual([keep]);
    expect(marksOf(session)[1]?.replies).toEqual([drop]);
    expect(removeTargets).not.toHaveBeenCalled();
  });

  it('copes with a mark that has no replies', () => {
    const session = openSession([mark('a')]);
    const { host } = hostFor(session);

    removeReply(host, { pending: true, id: 'a', pageIndex: 0 }, 'r2');

    expect(marksOf(session)[0]?.replies).toEqual([]);
  });

  it('sends a file reply through the removal intent by its key', () => {
    const session = openSession();
    const { host, removeTargets } = hostFor(session);

    removeReply(host, { pending: false, id: '17R', pageIndex: 3 }, '21R');

    expect(removeTargets).toHaveBeenCalledWith([markTargetKey('existing', '21R', 3)]);
  });
});

describe('useCommentReview', () => {
  it('binds the three panel callbacks to the host and keeps them while the host is unchanged', () => {
    const session = openSession([mark('a')]);
    const { host, removeTargets } = hostFor(session);
    const { result, rerender } = renderHook((props: ReviewHost) => useCommentReview(props), {
      initialProps: host,
    });
    const first = result.current;

    rerender(host);
    expect(result.current).toBe(first);

    act(() => result.current.onReply({ pending: true, id: 'a', pageIndex: 0 }, 'Hello'));
    expect(marksOf(session)[0]?.replies?.[0]?.contents).toBe('Hello');

    act(() => result.current.onSetState({ pending: true, id: 'a', pageIndex: 0 }, 'Marked' as never));
    expect(marksOf(session)[0]?.review?.state).toBe('Marked');

    act(() => result.current.onRemoveReply({ pending: false, id: 'x', pageIndex: 1 }, 'r'));
    expect(removeTargets).toHaveBeenCalledWith([markTargetKey('existing', 'r', 1)]);

    rerender({ ...host, author: 'Someone else' });
    expect(result.current).not.toBe(first);
    act(() => result.current.onReply({ pending: true, id: 'a', pageIndex: 0 }, 'Again'));
    expect(marksOf(session)[0]?.replies?.at(-1)?.author).toBe('Someone else');
  });
});
