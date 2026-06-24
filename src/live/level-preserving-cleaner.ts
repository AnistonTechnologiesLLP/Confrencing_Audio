/**
 * Wraps any cleaner with a speech-gated makeup gain that restores the ~5–7 dB
 * every denoiser cuts from the talker — SNR-neutrally (noise and speech scale
 * together) and boost-only — plus a peak limiter so the makeup never clips.
 * Held on silence (no noise-floor pumping). Error-resilient. Port of the Python
 * _LevelPreservingCleaner.
 */
import { ExponentialTracker } from './exponential-tracker.js';

export interface Cleaner {
  process(block: Float32Array, noiseGate: boolean): Float32Array;
  reset(): void;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length));
}

export class LevelPreservingCleaner implements Cleaner {
  private readonly inner: Cleaner;
  private readonly maxGain: number;
  private readonly ceiling: number;
  private readonly silenceRms: number;
  private readonly lin: ExponentialTracker;
  private readonly lout: ExponentialTracker;
  private readonly slew: ExponentialTracker;
  private readonly limRelease: number;
  private target = 1;
  private lim = 1;

  constructor(inner: Cleaner, opts: { maxGainDb?: number; levelAlpha?: number; slewAlpha?: number; ceilingDb?: number; releaseAlpha?: number; silenceDb?: number } = {}) {
    this.inner = inner;
    this.maxGain = Math.pow(10, (opts.maxGainDb ?? 8) / 20);
    this.ceiling = Math.pow(10, (opts.ceilingDb ?? -1) / 20);
    this.silenceRms = Math.pow(10, (opts.silenceDb ?? -55) / 20);
    this.lin = new ExponentialTracker(opts.levelAlpha ?? 0.05);
    this.lout = new ExponentialTracker(opts.levelAlpha ?? 0.05);
    this.slew = new ExponentialTracker(opts.slewAlpha ?? 0.08);
    this.limRelease = Math.min(1, Math.max(0, opts.releaseAlpha ?? 0.05));
  }

  process(block: Float32Array, noiseGate: boolean): Float32Array {
    let cleaned: Float32Array;
    try {
      cleaned = this.inner.process(block, noiseGate);
    } catch {
      return block; // inner failed → raw passthrough (never silence)
    }
    try {
      const rin = rms(block);
      // update the makeup target only on speech frames above the silence floor
      if (!noiseGate && rin > this.silenceRms) {
        const lin = this.lin.update(rin);
        const lout = this.lout.update(rms(cleaned));
        if (lout > 1e-9) this.target = Math.min(this.maxGain, Math.max(1, lin / lout));
      }
      const gain = this.slew.update(this.target);
      const out = new Float32Array(cleaned.length);
      for (let i = 0; i < cleaned.length; i++) out[i] = cleaned[i]! * gain;
      // peak limiter: instant attack, slow release, ceiling
      let peak = 0;
      for (const v of out) { const a = Math.abs(v); if (a > peak) peak = a; }
      const need = peak > this.ceiling ? this.ceiling / peak : 1;
      const relTarget = Math.min(1, need);
      this.lim = need < this.lim ? need : this.lim + this.limRelease * (relTarget - this.lim);
      if (this.lim < 1) for (let i = 0; i < out.length; i++) out[i]! *= this.lim;
      return out;
    } catch {
      return cleaned; // makeup failed → cleaned passthrough
    }
  }

  reset(): void {
    this.inner.reset();
    this.lin.reset();
    this.lout.reset();
    this.slew.reset();
    this.target = 1;
    this.lim = 1;
  }
}
