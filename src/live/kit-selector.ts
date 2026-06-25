/**
 * Hysteresis/hold selection across kits (arrays), driven by per-kit speech-presence scores.
 *
 * Port of `conf_pipeline_control/multikit.py:KitSelector`. Hold the active kit, switch to a
 * challenger only when it beats the incumbent by `switchMargin` AND clears `speechThreshold`
 * (fast attack to a new speaker); on a silent / fan-only room, hold the last-active kit and
 * report no speaker — never switch *to* a non-talker. Time is caller-supplied (monotonic
 * seconds) so it is deterministic and testable. The scores come from per-kit
 * {@link SpeechPresenceScorer}s (the caller owns them); this class is pure selection logic.
 */

/** A challenger must beat the incumbent's score by this to switch. */
export const DEFAULT_SWITCH_MARGIN = 0.12;
/** Coast the "active speaker" through pauses this long (seconds). */
export const DEFAULT_KIT_HOLD_SECONDS = 0.4;
/** A score above this counts as speech present. */
export const DEFAULT_SPEECH_THRESHOLD = 0.15;

/** The selector's per-tick decision. */
export interface SelectionState {
  active: number; // index of the kit being output
  switching: boolean; // true on the tick a switch was just committed (start a cross-fade)
  speechPresent: boolean; // is anyone actually talking (coasted through brief pauses)?
  scores: number[]; // the per-kit speech-presence scores this tick
}

export interface KitSelectorOptions {
  nKits?: number;
  switchMargin?: number;
  holdSeconds?: number;
  speechThreshold?: number;
}

export class KitSelector {
  private readonly nKits: number;
  private readonly switchMargin: number;
  private readonly holdSeconds: number;
  private readonly speechThreshold: number;
  private active = 0;
  private lastSpeechT: number | null = null;

  constructor(opts: KitSelectorOptions = {}) {
    this.nKits = opts.nKits ?? 2;
    if (this.nKits < 1) throw new Error('nKits must be >= 1');
    this.switchMargin = opts.switchMargin ?? DEFAULT_SWITCH_MARGIN;
    this.holdSeconds = opts.holdSeconds ?? DEFAULT_KIT_HOLD_SECONDS;
    this.speechThreshold = opts.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD;
  }

  /** Fold one tick's per-kit scores in (monotonic `t`, seconds) and return the selection. */
  update(scores: readonly number[], t: number): SelectionState {
    if (scores.length !== this.nKits) {
      throw new Error(`expected ${this.nKits} scores, got ${scores.length}`);
    }
    let best = 0;
    for (let i = 1; i < this.nKits; i++) if (scores[i]! > scores[best]!) best = i; // argmax, ties → first
    const incScore = scores[this.active]!;
    const anySpeech = scores[best]! > this.speechThreshold;

    let switching = false;
    if (anySpeech && best !== this.active && scores[best]! >= incScore + this.switchMargin) {
      this.active = best; // fast attack to a clearly-louder speaker
      switching = true;
    }

    if (anySpeech) this.lastSpeechT = t;
    const present =
      anySpeech || (this.lastSpeechT !== null && t - this.lastSpeechT <= this.holdSeconds);

    return { active: this.active, switching, speechPresent: present, scores: [...scores] };
  }

  reset(): void {
    this.active = 0;
    this.lastSpeechT = null;
  }
}
