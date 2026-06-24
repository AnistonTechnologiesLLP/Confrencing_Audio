import { SpeechPresenceScorer } from './speech-presence.js';

/** Speech-presence score above which the gate is fully open. */
export const VG_THRESHOLD = 0.35;
/** Shallow floor (duck, NOT mute) so a missed onset is recoverable, dB. */
export const VG_FLOOR_DB = -15;
/** Fast attack — open quickly on returning speech (onset-safe), ms. */
export const VG_ATTACK_MS = 8;
/** Slow release — hold open through brief intra-phrase pauses, ms. */
export const VG_RELEASE_MS = 180;

export interface VoiceGateOptions {
  threshold?: number;
  floorDb?: number;
  attackMs?: number;
  releaseMs?: number;
  modRef?: number;
}

/**
 * Streaming "voice only" output gate: attenuate non-speech toward a shallow floor with a
 * FAST attack / SLOW release, driven by the level-invariant syllabic-modulation scorer.
 * Runs LAST (after the AGC). Onset-safe (a sharp level rise opens it before the scorer
 * confirms) and shallow (a duck, not a mute). Port of `voice_gate.py:VoiceOnlyGate`.
 */
export class StreamingVoiceGate {
  private readonly fs: number;
  private readonly threshold: number;
  private readonly floor: number;
  private readonly attackMs: number;
  private readonly releaseMs: number;
  private readonly modRef: number | undefined;
  private scorer: SpeechPresenceScorer | null = null;
  private scorerHop = 0;
  private gain = 1;
  private prevRms = 0;
  private _gateOpen = true;
  private _reductionDb = 0;
  private _score = 1;

  constructor(sampleRate: number, opts: VoiceGateOptions = {}) {
    this.fs = sampleRate;
    this.threshold = opts.threshold ?? VG_THRESHOLD;
    this.floor = Math.pow(10, (opts.floorDb ?? VG_FLOOR_DB) / 20);
    this.attackMs = Math.max(0.1, opts.attackMs ?? VG_ATTACK_MS);
    this.releaseMs = Math.max(0.1, opts.releaseMs ?? VG_RELEASE_MS);
    this.modRef = opts.modRef;
  }

  /** Rebuild the scorer when the block cadence changes (the EMA alphas depend on hopSeconds). */
  private ensure(hopSeconds: number): void {
    if (this.scorer !== null && Math.abs(hopSeconds - this.scorerHop) < 1e-5) return;
    this.scorer = new SpeechPresenceScorer({
      hopSeconds,
      ...(this.modRef !== undefined ? { modRef: this.modRef } : {}),
    });
    this.scorerHop = hopSeconds;
  }

  process(block: Float32Array, noiseGate?: boolean): Float32Array {
    void noiseGate;
    const n = block.length;
    if (n === 0) return block;
    const hopSeconds = n / this.fs;
    this.ensure(hopSeconds);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += block[i]! * block[i]!;
    const rms = Math.sqrt(sum / n);
    this._score = this.scorer!.update(rms);
    // open on speech, OR on a sharp level rise (anticipate a just-started talker — protect the first syllable)
    const onset = rms > 3 * Math.max(this.prevRms, 1e-6);
    this.prevRms = rms;
    const target = this._score >= this.threshold || onset ? 1 : this.floor;
    const tauMs = target > this.gain ? this.attackMs : this.releaseMs; // fast attack / slow release
    const a = 1 - Math.exp(-hopSeconds / Math.max(1e-4, tauMs / 1000));
    const gNew = this.gain + a * (target - this.gain);
    const out = new Float32Array(n);
    if (n === 1) {
      out[0] = block[0]! * gNew;
    } else {
      const step = (gNew - this.gain) / (n - 1); // de-click: linear ramp across the block
      for (let i = 0; i < n; i++) out[i] = block[i]! * (this.gain + step * i);
    }
    this.gain = gNew;
    this._gateOpen = gNew > 0.5;
    this._reductionDb = gNew < 0.999 ? -20 * Math.log10(Math.max(gNew, 1e-6)) : 0;
    return out;
  }

  reset(): void {
    this.scorer = null;
    this.scorerHop = 0;
    this.gain = 1;
    this.prevRms = 0;
    this._gateOpen = true;
    this._reductionDb = 0;
    this._score = 1;
  }

  get gateOpen(): boolean {
    return this._gateOpen;
  }

  get reductionDb(): number {
    return this._reductionDb;
  }

  get score(): number {
    return this._score;
  }
}
