/**
 * Reading mode, step 2: local-only read-aloud.
 *
 * Web Speech can speak through remote voices, so the locked decision is enforced here
 * at the only place that picks a voice: a voice is eligible when
 * `localService === true` **and** its language is the requested one. If none is
 * installed the hook reports `available: false` and the caller disables the controls
 * with an explanation — never a silent fallback to a cloud voice, and no network call
 * of our own anywhere in this path.
 *
 * The page is queued as sentence-sized utterances so the first words are audible
 * immediately instead of after the engine has synthesised a whole page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { splitUtterances } from './text';
import { pickLocalVoice } from './voice';

/** Below 0.5 engines slur, above 2 they drop words: the range the pane offers. */
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;
export const DEFAULT_SPEECH_RATE = 1;

export interface ReadAloudApi {
  /** A usable local voice exists — the only gate the controls have to respect. */
  readonly available: boolean;
  readonly speaking: boolean;
  readonly paused: boolean;
  readonly play: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly stop: () => void;
  readonly rate: number;
  readonly setRate: (rate: number) => void;
}

export interface ReadAloudOptions {
  /**
   * Language of the voice to look for, matched as a prefix of the voice's tag (see
   * `pickLocalVoice`): the document's own, or the interface's when it declares none.
   */
  readonly lang: string;
}

/** `null` without Web Speech: the caller then has nothing to offer. The hook only ever runs in a browser window. */
function speechSynthesisOrNull(): SpeechSynthesis | null {
  if (!('speechSynthesis' in window)) return null;
  return window.speechSynthesis;
}

/**
 * Reads `text` aloud. Calling the hook with new text (a page change) stops the queue
 * and resets the controls, and unmounting always cancels — the engine's queue is
 * document-global, so a forgotten utterance would keep talking behind a closed pane.
 */
export function useReadAloud(text: string, options: ReadAloudOptions): ReadAloudApi {
  const { lang } = options;
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>(
    () => speechSynthesisOrNull()?.getVoices() ?? [],
  );
  const [rate, setRateState] = useState(DEFAULT_SPEECH_RATE);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  /** The current page's utterances, so a rate change can resume at the same sentence. */
  const chunks = useRef<readonly string[]>([]);
  /** Sentence the engine is on, tracked through each utterance's `onstart`. */
  const current = useRef(0);

  // Chromium answers `getVoices()` with an empty list until `voiceschanged` has fired,
  // so the list has to be read again; it is also the only source of `localService`.
  useEffect(() => {
    const synthesis = speechSynthesisOrNull();
    if (synthesis === null) return undefined;
    const refresh = () => setVoices(synthesis.getVoices());
    refresh();
    synthesis.addEventListener('voiceschanged', refresh);
    return () => synthesis.removeEventListener('voiceschanged', refresh);
  }, []);

  const voice = useMemo(() => pickLocalVoice(voices, lang), [voices, lang]);

  const speak = useCallback(
    (from: number, parts: readonly string[], speed: number) => {
      // A voice exists only when the engine listed one, so the engine is there too.
      if (voice === null) return;
      const synthesis = window.speechSynthesis;
      // The queue belongs to this reading: a new play replaces whatever the previous
      // page had left in it.
      synthesis.cancel();
      for (let index = from; index < parts.length; index += 1) {
        // `index` is inside `parts`, so the lookup always finds a sentence.
        const utterance = new SpeechSynthesisUtterance(parts[index] as string);
        utterance.voice = voice;
        utterance.lang = voice.lang;
        utterance.rate = speed;
        utterance.onstart = () => {
          current.current = index;
          setSpeaking(true);
          setPaused(false);
        };
        utterance.onend = () => {
          if (index === parts.length - 1) setSpeaking(false);
        };
        utterance.onerror = () => setSpeaking(false);
        synthesis.speak(utterance);
      }
    },
    [voice],
  );

  useEffect(() => {
    const synthesis = speechSynthesisOrNull();
    // A new page is a new reading: stop the old queue, prepare this page's utterances
    // and put the controls back. The queue is document-global, so nothing else
    // — not even closing the pane — would stop a forgotten utterance.
    synthesis?.cancel();
    chunks.current = splitUtterances(text);
    current.current = 0;
    setSpeaking(false);
    setPaused(false);
    return () => synthesis?.cancel();
  }, [text]);

  const play = useCallback(() => {
    if (voice === null || chunks.current.length === 0) return;
    speak(0, chunks.current, rate);
  }, [rate, speak, voice]);

  const pause = useCallback(() => {
    const synthesis = speechSynthesisOrNull();
    if (synthesis === null || !synthesis.speaking) return;
    synthesis.pause();
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    speechSynthesisOrNull()?.resume();
    setPaused(false);
  }, []);

  const stop = useCallback(() => {
    speechSynthesisOrNull()?.cancel();
    current.current = 0;
    setSpeaking(false);
    setPaused(false);
  }, []);

  const setRate = useCallback(
    (next: number) => {
      const clamped = Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, next));
      setRateState(clamped);
      // Web Speech fixes the rate when an utterance starts, so a page already being
      // read would keep the old speed until its next sentence: restart at the
      // sentence the engine reported through `onstart`.
      // `speaking` is only ever true after a play, which needs sentences, and a new page resets it with them.
      if (speaking && !paused) speak(current.current, chunks.current, clamped);
    },
    [paused, speak, speaking],
  );

  return useMemo<ReadAloudApi>(
    () => ({ available: voice !== null, speaking, paused, play, pause, resume, stop, rate, setRate }),
    [pause, play, paused, rate, resume, setRate, speaking, stop, voice],
  );
}
