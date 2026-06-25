/** Default block cadence the scorer's EMA alphas are derived for (~32 ms). */
export const VG_HOP_SECONDS = 0.032;
/** Fast envelope EMA time constant (upper syllabic corner), seconds. */
export const VG_TAU_FAST = 0.03;
/** Slow envelope EMA time constant (DC / lower corner), seconds. */
export const VG_TAU_SLOW = 0.15;
/** Smoothing time constant for the rectified band-passed envelope, seconds. */
export const VG_TAU_MOD = 0.3;
/** Modulation depth that maps to a full (1.0) speech score. */
export const VG_MOD_REF = 0.25;
/** Guards the modulation-depth denominator at silence. */
export const VG_LEVEL_FLOOR = 1e-4;

export interface SpeechPresenceOptions {
  hopSeconds?: number;
  tauFast?: number;
  tauSlow?: number;
  tauMod?: number;
  modRef?: number;
}

/** One-pole EMA coefficient for a time constant `tau` at the given hop cadence. */
export function alphaFor(hopSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return 1;
  return 1 - Math.exp(-hopSeconds / tauSeconds);
}

/**
 * Per-hop, level-invariant speech-vs-steady-noise score in `[0, 1]` from the output RMS
 * envelope. A difference-of-EMAs band-pass on the envelope (≈3-8 Hz syllabic band) divided
 * by the slow level: a steady fan is near-DC → ~0; a louder fan does not help because level
 * is the denominator. Pure (no FFT). Port of `multikit.py:SpeechPresenceScorer`.
 */
export class SpeechPresenceScorer {
  private readonly aFast: number;
  private readonly aSlow: number;
  private readonly aMod: number;
  private readonly modRef: number;
  private fast = 0;
  private slow = 0;
  private mod = 0;

  constructor(opts: SpeechPresenceOptions = {}) {
    const hop = opts.hopSeconds ?? VG_HOP_SECONDS;
    this.aFast = alphaFor(hop, opts.tauFast ?? VG_TAU_FAST);
    this.aSlow = alphaFor(hop, opts.tauSlow ?? VG_TAU_SLOW);
    this.aMod = alphaFor(hop, opts.tauMod ?? VG_TAU_MOD);
    this.modRef = Math.max(1e-6, opts.modRef ?? VG_MOD_REF);
  }

  /** Fold one hop's output RMS in and return the speech-presence score. */
  update(rms: number, noiseFloor = 0): number {
    const env = rms > 0 ? rms : 0;
    this.fast += this.aFast * (env - this.fast);
    this.slow += this.aSlow * (env - this.slow);
    const bp = this.fast - this.slow; // band-passed envelope (~syllabic)
    this.mod += this.aMod * (Math.abs(bp) - this.mod); // smoothed modulation energy
    const level = Math.max(this.slow, noiseFloor, VG_LEVEL_FLOOR);
    return Math.min(1, this.mod / level / this.modRef);
  }

  reset(): void {
    this.fast = 0;
    this.slow = 0;
    this.mod = 0;
  }
}
