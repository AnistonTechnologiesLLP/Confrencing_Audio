import { ArrayGeometry, type Complex } from '../beamformer/geometry.js';
import { bearingDirection } from '../beamformer/beamformer.js';
import { FftRadix2 } from './fft.js';
import { computeBeamWeights, DEFAULT_SUPERDIRECTIVE_LOADING } from './mvdr-solver.js';
import type { LiveBeam } from './beam.js';

/** STFT frame for the frequency-domain beam (hop = frame/2). */
export const FREQ_BEAM_FRAME = 1024;

export interface FreqDomainBeamOptions {
  frame?: number;
  loading?: number;
  offNadirDeg?: number;
}

/**
 * Frequency-domain **superdirective** (diffuse-noise MVDR) beamformer. A Hann overlap-add STFT
 * (1024/512) with one complex weight vector `W(f)` per rfft bin (A1's `computeBeamWeights`). Per hop:
 * `Y[k] = Σ_m conj(W[k][m])·X_m[k]` (pure MAC). `setLook` recomputes the weights (single-threaded, so the
 * publish is atomic for free). Round-trip latency ≈ frame + hop (~35 ms). Port of Python `_FreqDomainBeam`.
 */
export class FreqDomainBeam implements LiveBeam {
  private readonly geom: ArrayGeometry;
  private readonly sr: number;
  private readonly F: number;
  private readonly H: number;
  private readonly M: number;
  private readonly nb: number;
  private readonly loading: number;
  private readonly win: Float64Array;
  private readonly freqsHz: number[];
  private readonly fft: FftRadix2;

  private readonly inbuf: Float64Array[]; // [M] sliding analysis frames (F)
  private fifo: Float64Array[];           // [M] input FIFO
  private fill = 0;                        // buffered input samples (same across channels)
  private readonly ola: Float64Array;     // F overlap-add accumulator
  private outq: Float64Array;             // mono output FIFO (primed with F zeros = framing latency)
  private outFill: number;

  private readonly frame: Float64Array;   // F windowed scratch
  private readonly Yre: Float64Array;     // nb MAC accumulator
  private readonly Yim: Float64Array;     // nb
  private readonly irOut: Float64Array;   // F

  private W: Complex[][];                  // [nb][M]
  private azimuthDeg = 0;
  private offNadirDeg: number;

  constructor(geom: ArrayGeometry, sampleRate: number, opts: FreqDomainBeamOptions = {}) {
    this.geom = geom;
    this.sr = sampleRate;
    this.F = opts.frame ?? FREQ_BEAM_FRAME;
    this.H = this.F >> 1;
    this.M = geom.nChannels;
    this.nb = this.F / 2 + 1;
    this.loading = opts.loading ?? DEFAULT_SUPERDIRECTIVE_LOADING;
    this.offNadirDeg = opts.offNadirDeg ?? 90;
    this.win = new Float64Array(this.F);
    for (let i = 0; i < this.F; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.F - 1));
    this.freqsHz = [];
    for (let k = 0; k < this.nb; k++) this.freqsHz.push((k * this.sr) / this.F);
    this.fft = new FftRadix2(this.F);
    this.inbuf = Array.from({ length: this.M }, () => new Float64Array(this.F));
    this.fifo = Array.from({ length: this.M }, () => new Float64Array(this.F * 2));
    this.ola = new Float64Array(this.F);
    this.outq = new Float64Array(this.F * 2);
    this.outFill = this.F; // prime F zeros = framing latency
    this.frame = new Float64Array(this.F);
    this.Yre = new Float64Array(this.nb);
    this.Yim = new Float64Array(this.nb);
    this.irOut = new Float64Array(this.F);
    this.W = [];
    this.recompute();
  }

  private recompute(): void {
    const look = bearingDirection(this.azimuthDeg, this.offNadirDeg);
    this.W = computeBeamWeights(this.geom, this.freqsHz, look, [], { loading: this.loading });
  }

  setLook(azimuthDeg: number, offNadirDeg: number = this.offNadirDeg): void {
    if (azimuthDeg === this.azimuthDeg && offNadirDeg === this.offNadirDeg) return; // no-op
    this.azimuthDeg = azimuthDeg;
    this.offNadirDeg = offNadirDeg;
    this.recompute();
  }

  process(channels: Float32Array[]): Float32Array {
    const n = channels[0]!.length;
    const F = this.F, H = this.H, M = this.M, nb = this.nb;

    // grow input FIFO if needed, then copy this block in at offset `fill`
    if (this.fill + n > this.fifo[0]!.length) {
      const cap = Math.max(this.fifo[0]!.length * 2, this.fill + n);
      this.fifo = this.fifo.map((old) => { const next = new Float64Array(cap); next.set(old.subarray(0, this.fill)); return next; });
    }
    for (let m = 0; m < M; m++) {
      const dst = this.fifo[m]!;
      const src = channels[m]!;
      for (let i = 0; i < n; i++) dst[this.fill + i] = src[i]!;
    }
    this.fill += n;

    while (this.fill >= H) {
      // per channel: slide the analysis frame left by H, append the new hop, window, rfft, MAC
      this.Yre.fill(0);
      this.Yim.fill(0);
      for (let m = 0; m < M; m++) {
        const ib = this.inbuf[m]!;
        ib.copyWithin(0, H);                         // slide left by H
        const fm = this.fifo[m]!;
        for (let i = 0; i < H; i++) ib[F - H + i] = fm[i]!; // append hop
        for (let i = 0; i < F; i++) this.frame[i] = ib[i]! * this.win[i]!;
        const X = this.fft.rfft(this.frame);         // reused buffers — consume now, before the next channel
        const wr = this.W; // [nb][M]
        for (let k = 0; k < nb; k++) {
          const w = wr[k]![m]!;                       // conj(W) = (w.re, -w.im)
          const xr = X.re[k]!, xi = X.im[k]!;
          this.Yre[k] = this.Yre[k]! + w.re * xr + w.im * xi;   // Re{ conj(w)·x }
          this.Yim[k] = this.Yim[k]! + w.re * xi - w.im * xr; // Im{ conj(w)·x }
        }
      }
      // shift input FIFO left by H
      for (let m = 0; m < M; m++) this.fifo[m]!.copyWithin(0, H, this.fill);
      this.fill -= H;
      // irfft + overlap-add
      this.fft.irfftInto(this.Yre, this.Yim, this.irOut);
      this.ola.copyWithin(0, H);
      this.ola.fill(0, F - H);
      for (let i = 0; i < F; i++) this.ola[i] = this.ola[i]! + this.irOut[i]!;
      // push first H of ola to the output FIFO
      if (this.outFill + H > this.outq.length) {
        const next = new Float64Array(Math.max(this.outq.length * 2, this.outFill + H));
        next.set(this.outq.subarray(0, this.outFill));
        this.outq = next;
      }
      for (let i = 0; i < H; i++) this.outq[this.outFill + i] = this.ola[i]!;
      this.outFill += H;
    }

    // drain n samples (front-padded with zeros on startup underflow)
    const out = new Float32Array(n);
    if (this.outFill >= n) {
      for (let i = 0; i < n; i++) out[i] = this.outq[i]!;
      this.outq.copyWithin(0, n, this.outFill);
      this.outFill -= n;
    } else {
      const pad = n - this.outFill;
      for (let i = 0; i < this.outFill; i++) out[pad + i] = this.outq[i]!;
      this.outFill = 0;
    }
    return out;
  }

  reset(): void {
    for (let m = 0; m < this.M; m++) { this.inbuf[m]!.fill(0); this.fifo[m]!.fill(0); }
    this.fill = 0;
    this.ola.fill(0);
    this.outq.fill(0);
    this.outFill = this.F; // re-prime
  }

  /** Test hook: a cheap hash of the current weight table (to detect recompute vs no-op). */
  debugWeightsHash(): number {
    let h = 0;
    for (let k = 0; k < this.nb; k += 37) for (let m = 0; m < this.M; m++) {
      const w = this.W[k]![m]!;
      h = (h * 31 + Math.round(w.re * 1e6) + Math.round(w.im * 1e6)) | 0;
    }
    return h;
  }
}
