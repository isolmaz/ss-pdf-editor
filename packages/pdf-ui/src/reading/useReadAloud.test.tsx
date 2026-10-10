// @vitest-environment happy-dom
/**
 * Read-aloud against a fake Web Speech: the voice gate (local and in the requested language only),
 * the sentence queue a play hands the engine, the controls' states as the engine reports them
 * through utterance events, rate changes restarting at the sentence being read, and the queue being
 * cancelled when the page changes or the pane goes.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SPEECH_RATE, MIN_SPEECH_RATE, useReadAloud } from './useReadAloud';

class FakeUtterance {
  voice: unknown = null;
  lang = '';
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

interface FakeVoice {
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
}

class FakeSynthesis extends EventTarget {
  voices: FakeVoice[] = [];
  speaking = false;
  /** Everything the hook did, in order. */
  readonly log: string[] = [];
  queue: FakeUtterance[] = [];

  getVoices() {
    return this.voices;
  }
  speak(utterance: FakeUtterance) {
    this.log.push(`speak:${utterance.text}`);
    this.queue.push(utterance);
    this.speaking = true;
  }
  cancel() {
    this.log.push('cancel');
    this.queue = [];
    this.speaking = false;
  }
  pause() {
    this.log.push('pause');
  }
  resume() {
    this.log.push('resume');
  }
}

const GERMAN: FakeVoice = { name: 'Anna', lang: 'de-DE', localService: true };
const GERMAN_CLOUD: FakeVoice = { name: 'Cloud', lang: 'de-DE', localService: false };
const ENGLISH: FakeVoice = { name: 'Sam', lang: 'en-US', localService: true };

const TEXT = 'First sentence. Second sentence. Third sentence.';

let synthesis: FakeSynthesis;
let original: PropertyDescriptor | undefined;

beforeEach(() => {
  synthesis = new FakeSynthesis();
  original = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synthesis });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
});

afterEach(() => {
  cleanup();
  if (original === undefined) Reflect.deleteProperty(window, 'speechSynthesis');
  else Object.defineProperty(window, 'speechSynthesis', original);
  vi.unstubAllGlobals();
});

function mount(text = TEXT, lang = 'de') {
  return renderHook(({ value, language }) => useReadAloud(value, { lang: language }), {
    initialProps: { value: text, language: lang },
  });
}

describe('useReadAloud without Web Speech', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'speechSynthesis');
  });

  it('is unavailable and every control stays inert, while the rate still follows the slider', () => {
    const { result, unmount } = mount();
    expect(result.current).toMatchObject({ available: false, speaking: false, paused: false, rate: 1 });
    act(() => {
      result.current.play();
      result.current.pause();
      result.current.resume();
      result.current.stop();
    });
    expect(result.current).toMatchObject({ available: false, speaking: false, paused: false });
    act(() => result.current.setRate(1.5));
    expect(result.current.rate).toBe(1.5);
    unmount();
  });
});

describe('useReadAloud voice gate', () => {
  it('is available only for a local voice in the requested language', () => {
    synthesis.voices = [GERMAN_CLOUD, ENGLISH];
    const { result, rerender } = mount();
    expect(result.current.available).toBe(false);
    rerender({ value: TEXT, language: 'en' });
    expect(result.current.available).toBe(true);
  });

  it('never speaks without a local voice', () => {
    synthesis.voices = [GERMAN_CLOUD];
    const { result } = mount();
    act(() => result.current.play());
    expect(synthesis.log).not.toContain('speak:First sentence.');
    expect(synthesis.speaking).toBe(false);
  });

  it('picks voices up when the platform announces them later', () => {
    const { result } = mount();
    expect(result.current.available).toBe(false);
    synthesis.voices = [GERMAN];
    act(() => {
      synthesis.dispatchEvent(new Event('voiceschanged'));
    });
    expect(result.current.available).toBe(true);
  });

  it('stops listening for new voices when it unmounts', () => {
    const { result, unmount } = mount();
    unmount();
    synthesis.voices = [GERMAN];
    synthesis.dispatchEvent(new Event('voiceschanged'));
    expect(result.current.available).toBe(false);
  });
});

describe('useReadAloud playing', () => {
  beforeEach(() => {
    synthesis.voices = [ENGLISH, GERMAN];
  });

  it('queues one utterance per sentence with the local voice, its language and the rate', () => {
    const { result } = mount();
    act(() => result.current.play());
    expect(synthesis.log.slice(-4)).toEqual([
      'cancel',
      'speak:First sentence.',
      'speak:Second sentence.',
      'speak:Third sentence.',
    ]);
    for (const utterance of synthesis.queue) {
      expect(utterance.voice).toBe(GERMAN);
      expect(utterance.lang).toBe('de-DE');
      expect(utterance.rate).toBe(1);
    }
    // Nothing is "speaking" until the engine says so.
    expect(result.current).toMatchObject({ speaking: false, paused: false });
  });

  it('does nothing when the page has no text', () => {
    const { result } = mount('   ');
    act(() => result.current.play());
    expect(synthesis.queue).toEqual([]);
    expect(synthesis.log).not.toContainEqual(expect.stringMatching(/^speak:/));
  });

  it('follows the engine: speaking from the first start, finished after the last sentence', () => {
    const { result } = mount();
    act(() => result.current.play());
    const [first, second, third] = synthesis.queue as [FakeUtterance, FakeUtterance, FakeUtterance];
    act(() => first.onstart?.());
    expect(result.current).toMatchObject({ speaking: true, paused: false });
    act(() => first.onend?.());
    expect(result.current.speaking).toBe(true);
    act(() => second.onstart?.());
    act(() => second.onend?.());
    expect(result.current.speaking).toBe(true);
    act(() => third.onstart?.());
    act(() => third.onend?.());
    expect(result.current.speaking).toBe(false);
  });

  it('is not speaking any more after an utterance fails', () => {
    const { result } = mount();
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    expect(result.current.speaking).toBe(true);
    act(() => synthesis.queue[0]?.onerror?.());
    expect(result.current.speaking).toBe(false);
  });

  it('pauses a reading in progress and resumes it', () => {
    const { result } = mount();
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    act(() => result.current.pause());
    expect(synthesis.log.at(-1)).toBe('pause');
    expect(result.current).toMatchObject({ speaking: true, paused: true });
    act(() => result.current.resume());
    expect(synthesis.log.at(-1)).toBe('resume');
    expect(result.current.paused).toBe(false);
  });

  it('does not pause when nothing is being spoken', () => {
    const { result } = mount();
    act(() => result.current.pause());
    expect(synthesis.log).not.toContain('pause');
    expect(result.current.paused).toBe(false);
  });

  it('clears a pause when the engine starts the next sentence', () => {
    const { result } = mount();
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    act(() => result.current.pause());
    act(() => synthesis.queue[1]?.onstart?.());
    expect(result.current.paused).toBe(false);
  });

  it('stops: the queue is cancelled and the controls return to idle', () => {
    const { result } = mount();
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    act(() => result.current.pause());
    act(() => result.current.stop());
    expect(synthesis.log.at(-1)).toBe('cancel');
    expect(synthesis.queue).toEqual([]);
    expect(result.current).toMatchObject({ speaking: false, paused: false });
  });
});

describe('useReadAloud rate', () => {
  beforeEach(() => {
    synthesis.voices = [GERMAN];
  });

  it('keeps the rate inside the range the pane offers', () => {
    const { result } = mount();
    act(() => result.current.setRate(9));
    expect(result.current.rate).toBe(MAX_SPEECH_RATE);
    act(() => result.current.setRate(0.1));
    expect(result.current.rate).toBe(MIN_SPEECH_RATE);
    act(() => result.current.setRate(1.25));
    expect(result.current.rate).toBe(1.25);
  });

  it('applies to the next play', () => {
    const { result } = mount();
    act(() => result.current.setRate(1.5));
    act(() => result.current.play());
    expect(synthesis.queue.map((utterance) => utterance.rate)).toEqual([1.5, 1.5, 1.5]);
  });

  it('restarts at the sentence being read when the rate changes mid-reading', () => {
    const { result } = mount();
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    act(() => synthesis.queue[1]?.onstart?.());
    act(() => result.current.setRate(2));
    expect(synthesis.log.slice(-3)).toEqual(['cancel', 'speak:Second sentence.', 'speak:Third sentence.']);
    expect(synthesis.queue.map((utterance) => utterance.rate)).toEqual([2, 2]);
  });

  it('leaves a paused or idle reading alone when the rate changes', () => {
    const { result } = mount();
    act(() => result.current.setRate(2));
    expect(synthesis.log.filter((entry) => entry.startsWith('speak:'))).toEqual([]);
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    act(() => result.current.pause());
    const before = synthesis.log.length;
    act(() => result.current.setRate(0.5));
    expect(synthesis.log).toHaveLength(before);
    expect(result.current.rate).toBe(0.5);
  });
});

describe('useReadAloud when the voice goes away', () => {
  it('does not restart a reading for a language that has no local voice', () => {
    synthesis.voices = [GERMAN];
    const { result, rerender } = mount();
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    rerender({ value: TEXT, language: 'fr' });
    expect(result.current.available).toBe(false);
    const before = synthesis.log.length;
    act(() => result.current.setRate(2));
    expect(synthesis.log).toHaveLength(before);
    expect(result.current.rate).toBe(2);
  });
});

describe('useReadAloud page changes and unmounting', () => {
  beforeEach(() => {
    synthesis.voices = [GERMAN];
  });

  it('cancels the old queue and resets the controls for a new page, which then plays its own text', () => {
    const { result, rerender } = mount();
    act(() => result.current.play());
    act(() => synthesis.queue[0]?.onstart?.());
    expect(result.current.speaking).toBe(true);
    rerender({ value: 'Next page.', language: 'de' });
    expect(synthesis.log.at(-1)).toBe('cancel');
    expect(synthesis.queue).toEqual([]);
    expect(result.current).toMatchObject({ speaking: false, paused: false });
    act(() => result.current.play());
    expect(synthesis.queue.map((utterance) => utterance.text)).toEqual(['Next page.']);
  });

  it('cancels the queue when the pane unmounts', () => {
    const { result, unmount } = mount();
    act(() => result.current.play());
    expect(synthesis.speaking).toBe(true);
    unmount();
    expect(synthesis.speaking).toBe(false);
    expect(synthesis.queue).toEqual([]);
  });
});
