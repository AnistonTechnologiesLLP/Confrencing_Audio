/**
 * Streaming spatial-covariance accumulator for live DOA. Bridges the engine's
 * arbitrary per-block channels to fixed Hann STFT frames (FRAME/HOP), takes the
 * rfft of each channel, restricts to a speech band, accumulates the per-bin outer
 * product xxᴴ, and EMA-smooths it into R(f). Pure, Float64, zero-dep. Mirrors the
 * Python live tap (FRAME=1024 / HOP=512 / alpha=0.05).
 */
import { FftRadix2 } from './fft.js';
import type { Complex } from '../beamformer/geometry.js';

export const COV_FRAME = 1024;
export const COV_HOP = 512;

export class StreamingCovarianceAccumulator {
  private readonly M: number;
  private readonly fft: FftRadix2;
  private readonly hann: Float64Array;
  private readonly band: number[]; // rfft bin indices in [fLo, fHi]
  private readonly freqsBand: number[];
  private readonly alpha: number;
  private readonly warmup: number;
  private fifo: Float64Array[]; // per channel, capacity grows as needed
  private fill = 0;
  private readonly frame = new Float64Array(COV_FRAME);
  private readonly specRe: Float64Array[]; // per channel band spectra (reused)
  private readonly specIm: Float64Array[];
  private readonly R: Complex[][][]; // nBand × M × M, EMA-accumulated in place
  private _framesSeen = 0;

  constructor(opts: { channels: number; sampleRate: number; fLoHz?: number; fHiHz?: number; alpha?: number; warmupFrames?: number }) {
    this.M = opts.channels;
    this.alpha = opts.alpha ?? 0.05;
    this.warmup = opts.warmupFrames ?? 4;
    this.fft = new FftRadix2(COV_FRAME);
    this.hann = new Float64Array(COV_FRAME);
    for (let i = 0; i < COV_FRAME; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (COV_FRAME - 1));
    const fLo = opts.fLoHz ?? 300;
    const fHi = opts.fHiHz ?? 3800;
    this.band = [];
    this.freqsBand = [];
    for (let k = 0; k <= COV_FRAME / 2; k++) {
      const f = (k * opts.sampleRate) / COV_FRAME;
      if (f >= fLo && f <= fHi) {
        this.band.push(k);
        this.freqsBand.push(f);
      }
    }
    this.fifo = Array.from({ length: this.M }, () => new Float64Array(COV_FRAME * 2));
    this.specRe = Array.from({ length: this.M }, () => new Float64Array(this.band.length));
    this.specIm = Array.from({ length: this.M }, () => new Float64Array(this.band.length));
    this.R = this.band.map(() =>
      Array.from({ length: this.M }, () => Array.from({ length: this.M }, () => ({ re: 0, im: 0 }))),
    );
  }

  get framesSeen(): number {
    return this._framesSeen;
  }

  /**
   * Feed one engine block (M channels, equal length). Processes any completed hops.
   *
   * `gate` (default `true`) controls whether each completed frame's outer product is folded into the running
   * covariance: pass `false` on speech frames to keep a **noise-only** covariance (the data-adaptive MVDR use —
   * folding the target in would null the talker). The frame buffer still advances either way, so the framing
   * stays aligned when noise resumes; `framesSeen` (the warmup counter) only advances on folded frames.
   */
  accumulate(channels: Float32Array[], gate = true): void {
    const n = channels[0]?.length ?? 0;
    if (n === 0) return;
    if (this.fill + n > this.fifo[0]!.length) this.grow(this.fill + n);
    for (let m = 0; m < this.M; m++) {
      const dst = this.fifo[m]!;
      const src = channels[m]!;
      for (let i = 0; i < n; i++) dst[this.fill + i] = src[i]!;
    }
    this.fill += n;
    while (this.fill >= COV_FRAME) {
      if (gate) this.processFrame();
      for (let m = 0; m < this.M; m++) this.fifo[m]!.copyWithin(0, COV_HOP, this.fill);
      this.fill -= COV_HOP;
    }
  }

  private grow(need: number): void {
    let cap = this.fifo[0]!.length;
    while (cap < need) cap *= 2;
    this.fifo = this.fifo.map((old) => {
      const next = new Float64Array(cap);
      next.set(old.subarray(0, this.fill));
      return next;
    });
  }

  private processFrame(): void {
    const a = this.alpha;
    for (let m = 0; m < this.M; m++) {
      const buf = this.fifo[m]!;
      for (let i = 0; i < COV_FRAME; i++) this.frame[i] = buf[i]! * this.hann[i]!;
      const X = this.fft.rfft(this.frame);
      const sr = this.specRe[m]!;
      const si = this.specIm[m]!;
      for (let b = 0; b < this.band.length; b++) {
        const k = this.band[b]!;
        sr[b] = X.re[k]!;
        si[b] = X.im[k]!;
      }
    }
    for (let b = 0; b < this.band.length; b++) {
      const Rb = this.R[b]!;
      for (let i = 0; i < this.M; i++) {
        const xir = this.specRe[i]![b]!;
        const xii = this.specIm[i]![b]!;
        for (let j = 0; j < this.M; j++) {
          const xjr = this.specRe[j]![b]!;
          const xji = this.specIm[j]![b]!;
          // inst = X_i · conj(X_j)
          const instRe = xir * xjr + xii * xji;
          const instIm = xii * xjr - xir * xji;
          const cell = Rb[i]![j]!;
          cell.re = (1 - a) * cell.re + a * instRe;
          cell.im = (1 - a) * cell.im + a * instIm;
        }
      }
    }
    this._framesSeen += 1;
  }

  /** Deep-copied band covariance + band frequencies + the rfft bin indices, or null until warmed up. */
  snapshot(): { rBand: Complex[][][]; freqs: number[]; band: number[] } | null {
    if (this._framesSeen < this.warmup) return null;
    const rBand = this.R.map((mat) => mat.map((row) => row.map((c) => ({ re: c.re, im: c.im }))));
    return { rBand, freqs: this.freqsBand.slice(), band: this.band.slice() };
  }

  reset(): void {
    this.fill = 0;
    this._framesSeen = 0;
    for (const mat of this.R) for (const row of mat) for (const c of row) { c.re = 0; c.im = 0; }
  }
}
