/**
 * The notice line as data: what the shell says when a draft restore
 * ends, when a promise it cannot await rejects, and what a verification table reads as.
 *
 * These are cases a person would only see in the product: a restore that applied
 * **nothing** must say so, a rejected `applyEngineValues` must be caught, and a picker's
 * failure sentence must not replace the message of the document that failed to open. Each
 * of those is a *choice of sentence plus its count*, which is what the descriptors below
 * are — asserting them asserts the behaviour, not the wording, so a translation change does
 * not break the test and a dropped count does.
 */

import type { Translator } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  appendWarning,
  auditNotice,
  engineValuesNotices,
  failureNotices,
  noticeLine,
  storedCopyWarning,
  verificationNotices,
} from './notices';
import type { DocumentFact, FactCheck, WriteVerification } from './operations';

function verification(
  checks: readonly FactCheck[],
  declared: readonly DocumentFact[] = [],
): WriteVerification {
  return {
    state: checks.some((check) => check.verdict === 'degraded') ? 'degraded' : 'verified',
    pageCount: 3,
    operation: { kind: 'declared', steps: [] },
    declared,
    checks,
    sampledPages: [0, 1, 2],
  };
}

describe('engineValuesNotices', () => {
  it('reports a restore that applied nothing instead of staying silent', () => {
    const notices = engineValuesNotices({ applied: 0, carried: 4, dropped: 4 });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.key).toBe('draft.engineValuesLost');
    expect(notices[0]?.params).toEqual({ count: 4 });
  });

  it('never claims a loss of zero, and never hides a real one', () => {
    expect(engineValuesNotices({ applied: 3, carried: 3, dropped: 0 })).toEqual([
      { key: 'draft.engineValues', params: { count: 3 } },
    ]);
    expect(engineValuesNotices({ applied: 2, carried: 3, dropped: 1 })).toEqual([
      { key: 'draft.engineValues', params: { count: 2 } },
      { key: 'draft.engineValuesDropped', params: { count: 1 } },
    ]);
  });
});

describe('failureNotices', () => {
  it('keeps the real error of a rejected open', () => {
    const rejection = new ToolError('file-too-large', { engine: 'model' });
    expect(failureNotices(rejection, 'error.corrupt-document.message')).toEqual([
      { key: rejection.messageKey },
      { key: rejection.hintKey },
    ]);
  });

  it('falls back only when the cause is not a ToolError', () => {
    expect(failureNotices(new Error('kaboom'), 'notice.engineReleaseFailed')).toEqual([
      { key: 'notice.engineReleaseFailed' },
    ]);
    expect(failureNotices(undefined, 'error.write-failed.message')).toEqual([
      { key: 'error.write-failed.message' },
    ]);
  });
});

describe('verificationNotices', () => {
  const verified: FactCheck = { fact: 'pageOrder', verdict: 'verified' };
  const degraded: FactCheck = { fact: 'textContent', verdict: 'degraded', reason: 'budget' };
  const unsupported: FactCheck = { fact: 'signatures', verdict: 'unsupported', reason: 'trust-policy' };

  it('names the verified facts, and does not bury a clean save under its declared list', () => {
    const notices = verificationNotices(verification([verified, unsupported]));
    expect(notices.map((notice) => notice.key)).toEqual(['verify.verified', 'verify.unsupported']);
    expect(notices[0]?.facts).toEqual([{ key: 'verify.fact.pageOrder' }]);
    expect(notices[1]?.facts).toEqual([
      { key: 'verify.fact.signatures', reason: 'verify.reason.trust-policy' },
    ]);
  });

  it('carries the reason of a shortcut and the declared changes once something is not clean', () => {
    const notices = verificationNotices(verification([verified, degraded], ['textContent']));
    expect(notices.map((notice) => notice.key)).toEqual([
      'verify.verified',
      'verify.degraded',
      'verify.declared',
    ]);
    expect(notices[1]?.facts).toEqual([{ key: 'verify.fact.textContent', reason: 'verify.reason.budget' }]);
    expect(notices[2]?.facts).toEqual([{ key: 'verify.fact.textContent' }]);
  });
});

describe('verificationNotices parameters', () => {
  it('hands a fact check’s own numbers to the sentence that names its reason', () => {
    const changed: FactCheck = {
      fact: 'rotation',
      verdict: 'degraded',
      reason: 'changed',
      params: { page: 2 },
    };
    const notices = verificationNotices(verification([changed], ['rotation']));
    expect(notices[0]?.facts).toEqual([
      { key: 'verify.fact.rotation', reason: 'verify.reason.changed', reasonParams: { page: 2 } },
    ]);
  });
});

describe('auditNotice', () => {
  it('separates "nothing to look for" from "looked and found nothing"', () => {
    expect(auditNotice({ terms: 0, contentFindings: 0 })).toEqual({
      key: 'audit.notice.terms',
      params: { count: 0 },
    });
    expect(auditNotice({ terms: 2, contentFindings: 1 })).toEqual({
      key: 'audit.notice.residual',
      params: { count: 1 },
    });
  });
});

describe('renderNotice', () => {
  it('translates the fact names and their reasons into the sentence it renders', () => {
    // A stub dictionary: the test asserts which keys were asked for and in what order,
    // which is the whole contract between a descriptor and the notice line.
    const asked: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }[] = [];
    const t: Translator = Object.assign(
      (key: Parameters<Translator>[0], params?: Readonly<Record<string, string | number>>) => {
        asked.push(params === undefined ? { key } : { key, params });
        return key;
      },
      { locale: 'en' as const },
    );
    const rendered = noticeLine(
      [
        {
          key: 'verify.degraded',
          facts: [
            { key: 'verify.fact.textContent', reason: 'verify.reason.sampled', reasonParams: { count: 3 } },
          ],
        },
      ],
      t,
    );
    expect(asked).toEqual([
      { key: 'verify.fact.textContent' },
      { key: 'verify.reason.sampled', params: { count: 3 } },
      { key: 'verify.degraded', params: { facts: 'verify.fact.textContent (verify.reason.sampled)' } },
    ]);
    expect(rendered).toBe('verify.degraded');
  });

  it('interpolates a descriptor’s own numbers, next to the facts it names', () => {
    const asked: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }[] = [];
    const t: Translator = Object.assign(
      (key: Parameters<Translator>[0], params?: Readonly<Record<string, string | number>>) => {
        asked.push(params === undefined ? { key } : { key, params });
        return key + JSON.stringify(params ?? {});
      },
      { locale: 'en' as const },
    );
    expect(noticeLine([{ key: 'draft.engineValues', params: { count: 3 } }], t)).toBe(
      'draft.engineValues{"count":3}',
    );
    asked.length = 0;
    noticeLine(
      [{ key: 'verify.degraded', params: { count: 2 }, facts: [{ key: 'verify.fact.rotation' }] }],
      t,
    );
    expect(asked.at(-1)).toEqual({
      key: 'verify.degraded',
      params: { count: 2, facts: 'verify.fact.rotation{}' },
    });
  });
});

describe('storedCopyWarning', () => {
  // A stub dictionary that echoes the key: the contract is which reason the sentence names.
  const t: Translator = Object.assign(
    (key: Parameters<Translator>[0], params?: Readonly<Record<string, string | number>>) =>
      params === undefined ? key : `${key}[${params.reason}]`,
    { locale: 'en' as const },
  );

  it('names a full store as a full store', () => {
    expect(storedCopyWarning(new DOMException('full', 'QuotaExceededError'), t)).toBe(
      'draft.sourceNotStored[error.quota-exceeded.message]',
    );
  });

  it('keeps the message of a ToolError, and calls any other storage failure a failed write', () => {
    expect(storedCopyWarning(new ToolError('out-of-memory', { engine: 'fs' }), t)).toBe(
      'draft.sourceNotStored[error.out-of-memory.message]',
    );
    expect(storedCopyWarning(new DOMException('locked', 'NoModificationAllowedError'), t)).toBe(
      'draft.sourceNotStored[draft.storageRefused]',
    );
    expect(storedCopyWarning('nope', t)).toBe('draft.sourceNotStored[draft.storageRefused]');
  });
});

describe('appendWarning', () => {
  it('adds the warning after the success line and leaves a clean line alone', () => {
    expect(appendWarning('Opened.', 'Not stored.')).toBe('Opened. Not stored.');
    expect(appendWarning('Opened.', null)).toBe('Opened.');
  });
});
