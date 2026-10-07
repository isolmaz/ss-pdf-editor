/**
 * `parseXmp` promises never to throw. The XML parser is a third-party dependency, so its failure
 * is injected at its import: a parser that throws must come out as a packet that is not
 * well-formed, not as an exception in the caller.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@xmldom/xmldom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xmldom/xmldom')>();
  return {
    ...actual,
    DOMParser: class {
      parseFromString(): never {
        throw new Error('parser blew up');
      }
    },
  };
});

const { parseXmp } = await import('./pdfa-xmp');

describe('parseXmp when the parser fails', () => {
  it('answers a packet that is not well-formed', () => {
    const parsed = parseXmp(new TextEncoder().encode('<a/>'));
    expect(parsed.wellFormed).toBe(false);
    expect(parsed.properties.size).toBe(0);
    expect(parsed.claim).toEqual({ part: null, conformance: null });
  });
});
