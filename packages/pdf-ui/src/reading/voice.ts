/**
 * The `K19` voice gate, in one place: which voices may ever speak document text.
 *
 * Web Speech happily speaks through a cloud voice when the platform offers one, so the
 * rule "only `localService === true`" is not a preference but the privacy contract
 * (`PLAN.md §3.7`, `K19`): if no local voice in the right language is installed, the
 * feature is unavailable with an explanation — never a silent fallback to a remote
 * voice. This module is DOM-free on purpose so the gate can be exercised without a
 * browser; the hook supplies the platform's voice list.
 */

/** The `SpeechSynthesisVoice` fields the gate reads. */
export interface LocalVoiceLike {
  readonly lang: string;
  readonly localService: boolean;
}

/**
 * The eligible voice, or `null` when the device has none. Eligibility is **local AND in
 * the requested language**: a remote voice is a leak, a foreign-language voice
 * mispronounces every word. Between eligible voices an exact language tag ("tr") beats
 * a regional variant ("tr-TR").
 */
export function pickLocalVoice<T extends LocalVoiceLike>(voices: readonly T[], lang: string): T | null {
  const wanted = lang.toLowerCase();
  const eligible = voices.filter(
    (voice) => voice.localService === true && voice.lang.toLowerCase().startsWith(wanted),
  );
  return eligible.find((voice) => voice.lang.toLowerCase() === wanted) ?? eligible[0] ?? null;
}
