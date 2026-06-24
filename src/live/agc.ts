/**
 * Target-loudness automatic gain control: normalizes a mono block toward a target RMS
 * via a slewed scalar gain (one-pole EMA), held on silence (no floor pump), then a
 * peak limiter so a large boost never clips. Control-pure (output-RMS-driven only).
 * Pure, zero-dep. Port of the Python TargetLoudnessAgc.
 */
import { ExponentialTracker } from './exponential-tracker.js';

export const AGC_MAX_GAIN_DB = 18;
export const AGC_SLEW_ALPHA = 0.15;
export const AGC_SILENCE_DB = -55;
export const AGC_CEILING_DB = -1;
export const AGC_LIMIT_RELEASE_ALPHA = 0.05;

export interface AgcOptions {
  targetDb: number;
  maxGainDb?: number;
  slewAlpha?: number;
  silenceDb?: number;
}

export class TargetLoudnessAgc {
  private readonly targetRms: number;
  private readonly gainMax: number;
  private readonly gainMin: number;
  private readonly silenceRms: number;
  private readonly ceiling: number;
  private readonly slew: ExponentialTracker;
  private lim = 1;

  constructor(sampleRate: number, opts: AgcOptions) {
    void sampleRate;
    this.targetRms = Math.pow(10, opts.targetDb / 20);
    const maxGainDb = opts.maxGainDb ?? AGC_MAX_GAIN_DB;
    this.gainMax = Math.pow(10, maxGainDb / 20);
    this.gainMin = Math.pow(10, -maxGainDb / 20);
    this.silenceRms = Math.pow(10, (opts.silenceDb ?? AGC_SILENCE_DB) / 20);
    this.ceiling = Math.pow(10, AGC_CEILING_DB / 20);
    this.slew = new ExponentialTracker(opts.slewAlpha ?? AGC_SLEW_ALPHA);
  }

  /** Current slewed gain (linear) — for telemetry. */
  get gainLinear(): number {
    return this.slew.value;
  }

  process(block: Float32Array, freeze = false): Float32Array {
    let s = 0;
    for (const v of block) s += v * v;
    const blockRms = Math.sqrt(s / Math.max(1, block.length));
    let desired: number;
    if (freeze || blockRms <= this.silenceRms) {
      desired = this.slew.value || 1; // hold (1 before the slew is seeded; gain is never legitimately 0)
    } else {
      desired = Math.min(this.gainMax, Math.max(this.gainMin, this.targetRms / blockRms));
    }
    const g = this.slew.update(desired);
    const out = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) out[i]! = block[i]! * g;
    // peak limiter: instant attack, slow release, ceiling (mirrors LevelPreservingCleaner)
    let peak = 0;
    for (const v of out) { const a = Math.abs(v); if (a > peak) peak = a; }
    const need = peak > this.ceiling ? this.ceiling / peak : 1;
    this.lim = need < this.lim ? need : this.lim + AGC_LIMIT_RELEASE_ALPHA * (Math.min(1, need) - this.lim);
    if (this.lim < 1) for (let i = 0; i < out.length; i++) out[i]! *= this.lim;
    return out;
  }

  reset(): void {
    this.slew.reset();
    this.lim = 1;
  }
}
