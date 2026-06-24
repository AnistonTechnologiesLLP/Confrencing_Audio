/**
 * Streaming single-channel dereverberation — a causal port of OCTOVOX's
 * dereverb_spectral (Lebart 2001 / Habets statistical late-reverb suppression).
 * A drop-in over the Phase-3a STFT base: it estimates the LATE-reverb power as a
 * delayed, T60-decayed, one-pole-smoothed copy of the observed power and applies a
 * spectral-subtraction gain G = max(1 − β·R/P, Gmin). VAD-independent; only LATE
 * reverb (older than `earlyMs`) is suppressed; the gain floor keeps it from ever
 * hard-muting. Pure, zero-dep. Port of the Python StreamingDereverb.
 */
import { StreamingSpectralProcessor, type SpectralOptions } from './spectral-processor.js';

export const DEREVERB_T60 = 0.5;
export const DEREVERB_BETA = 1.6;
export const DEREVERB_GMIN_DB = -10;
export const DEREVERB_EARLY_MS = 48;

export interface DereverbOptions extends Omit<SpectralOptions, 'floorDb'> {
  t60?: number;
  beta?: number;
  gminDb?: number;
  earlyMs?: number;
}

export class StreamingDereverb extends StreamingSpectralProcessor {
  private readonly beta: number;
  private readonly _a: number; // per-frame 60 dB decay pole
  private readonly _d: number; // early-reflection delay in frames
  private readonly _R: Float64Array; // per-bin late-reverb PSD (one-pole IIR state)
  private readonly _phist: Float64Array; // flat ring (_d × nb) of the last _d power frames
  private _phistIdx = 0;

  constructor(sampleRate: number, opts: DereverbOptions = {}) {
    const gminDb = opts.gminDb ?? DEREVERB_GMIN_DB;
    // Hand gminDb to the base as floorDb so the inherited gFloor IS the dereverb amplitude Gmin.
    super(sampleRate, { ...opts, floorDb: gminDb });
    const t60 = Math.max(0.05, opts.t60 ?? DEREVERB_T60);
    this.beta = Math.max(0, opts.beta ?? DEREVERB_BETA);
    const earlyMs = Math.max(0, opts.earlyMs ?? DEREVERB_EARLY_MS);
    this._a = Math.exp((-13.8155 * this.H) / (t60 * sampleRate)); // a = exp(-ln(1e6)·HOP/(t60·fs))
    this._d = Math.max(1, Math.round(((earlyMs / 1000) * sampleRate) / this.H));
    this._R = new Float64Array(this.nb);
    this._phist = new Float64Array(this._d * this.nb);
  }

  /** Per-frame 60 dB decay pole (diagnostic). */
  get decayPole(): number {
    return this._a;
  }

  /** Early-reflection delay in STFT frames (diagnostic). */
  get delayFrames(): number {
    return this._d;
  }

  protected override computeGain(power: Float64Array, _noiseMag: Float64Array): Float64Array {
    const nb = this.nb;
    const g = this._gBuf;
    const off = this._phistIdx * nb;
    for (let k = 0; k < nb; k++) {
      const pd = this._phist[off + k]!; // power from _d frames ago (0 until the ring fills)
      this._phist[off + k] = power[k]!; // overwrite in place with the current power (no copy)
      const r = this._a * this._R[k]! + (1 - this._a) * pd;
      this._R[k] = r;
      const sub = 1 - (this.beta * r) / (power[k]! + 1e-20);
      g[k] = sub > this.gFloor ? sub : this.gFloor;
    }
    this._phistIdx = (this._phistIdx + 1) % this._d;
    return g;
  }

  override reset(): void {
    super.reset();
    this._R.fill(0);
    this._phist.fill(0);
    this._phistIdx = 0;
  }
}
