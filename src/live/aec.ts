// src/live/aec.ts
/**
 * Real-time acoustic echo canceller: a frequency-domain partitioned-block NLMS
 * adaptive filter over the Hann 512/256 overlap-add STFT (reuses FftRadix2 — zero-dep).
 * Per hop it estimates the echo as a K-tap sum of complex-weighted past reference
 * spectra, subtracts it from the mic spectrum, and adapts the weights by leaky NLMS on
 * far-end-active frames. Pure Float64, no hot-path allocation. Port of the Python
 * StreamingAec.
 */
import { FftRadix2 } from './fft.js';

export const AEC_FRAME = 512;
export const AEC_NTAPS = 16;
export const AEC_MU = 0.3;
export const AEC_LEAK = 0.999;
export const AEC_REF_FLOOR = 1e-7;
export const AEC_ERLE_ALPHA = 0.95;
const CLAMP = 10;

export interface AecOptions {
  frame?: number;
  nTaps?: number;
  mu?: number;
  leak?: number;
  refFloor?: number;
  erleAlpha?: number;
}

export class StreamingAec {
  private readonly F: number;
  private readonly H: number;
  private readonly nb: number;
  private readonly K: number;
  private readonly fft: FftRadix2;
  private readonly win: Float64Array;
  private readonly mu: number;
  private readonly leak: number;
  private readonly refFloor: number;
  private readonly erleAlpha: number;
  // input FIFOs (mic + ref move together; same block length each call)
  private qM: Float64Array;
  private qR: Float64Array;
  private qFill = 0;
  // sliding analysis frames + windowed copies
  private readonly inbufM: Float64Array;
  private readonly inbufR: Float64Array;
  private readonly frameM: Float64Array;
  private readonly frameR: Float64Array;
  // snapshots of the rfft outputs (rfft reuses its buffers — must copy)
  private readonly MtRe: Float64Array;
  private readonly MtIm: Float64Array;
  private readonly RtRe: Float64Array;
  private readonly RtIm: Float64Array;
  // complex filter weights + reference FIFO (row-major [k*nb + f], newest at row 0)
  private readonly Wre: Float64Array;
  private readonly Wim: Float64Array;
  private readonly rfRe: Float64Array;
  private readonly rfIm: Float64Array;
  // per-hop scratch
  private readonly eRe: Float64Array;
  private readonly eIm: Float64Array;
  private readonly irOut: Float64Array;
  // overlap-add synthesis
  private readonly ola: Float64Array;
  private qOut: Float64Array;
  private outFill: number;
  // ERLE state
  private _micPow = 0;
  private _errPow = 0;
  private _erleDb = 0;
  private _farend = false;

  constructor(sampleRate: number, opts: AecOptions = {}) {
    void sampleRate;
    this.F = Math.max(2, (Math.trunc(opts.frame ?? AEC_FRAME) >> 1) << 1);
    this.H = this.F >> 1;
    this.nb = this.F / 2 + 1;
    this.K = Math.max(1, Math.trunc(opts.nTaps ?? AEC_NTAPS));
    this.fft = new FftRadix2(this.F);
    this.win = new Float64Array(this.F);
    for (let i = 0; i < this.F; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.F - 1));
    this.mu = opts.mu ?? AEC_MU;
    this.leak = opts.leak ?? AEC_LEAK;
    this.refFloor = opts.refFloor ?? AEC_REF_FLOOR;
    this.erleAlpha = opts.erleAlpha ?? AEC_ERLE_ALPHA;
    this.qM = new Float64Array(this.F * 2);
    this.qR = new Float64Array(this.F * 2);
    this.inbufM = new Float64Array(this.F);
    this.inbufR = new Float64Array(this.F);
    this.frameM = new Float64Array(this.F);
    this.frameR = new Float64Array(this.F);
    this.MtRe = new Float64Array(this.nb);
    this.MtIm = new Float64Array(this.nb);
    this.RtRe = new Float64Array(this.nb);
    this.RtIm = new Float64Array(this.nb);
    this.Wre = new Float64Array(this.K * this.nb);
    this.Wim = new Float64Array(this.K * this.nb);
    this.rfRe = new Float64Array(this.K * this.nb);
    this.rfIm = new Float64Array(this.K * this.nb);
    this.eRe = new Float64Array(this.nb);
    this.eIm = new Float64Array(this.nb);
    this.irOut = new Float64Array(this.F);
    this.ola = new Float64Array(this.F);
    this.qOut = new Float64Array(this.F * 2);
    this.outFill = this.F; // prime one frame of latency (zeros)
  }

  get erleDb(): number {
    return this._erleDb;
  }

  get farendActive(): boolean {
    return this._farend;
  }

  process(mic: Float32Array, ref: Float32Array | null, nearEndActive = false): Float32Array {
    const n = mic.length;
    if (this.qFill + n > this.qM.length) {
      const sz = Math.max(this.qM.length * 2, this.qFill + n);
      const nm = new Float64Array(sz); nm.set(this.qM.subarray(0, this.qFill)); this.qM = nm;
      const nr = new Float64Array(sz); nr.set(this.qR.subarray(0, this.qFill)); this.qR = nr;
    }
    for (let i = 0; i < n; i++) {
      this.qM[this.qFill + i] = mic[i]!;
      this.qR[this.qFill + i] = ref !== null ? (ref[i] ?? 0) : 0;
    }
    this.qFill += n;
    let farendSeen = false;
    while (this.qFill >= this.H) {
      this.processHop(nearEndActive);
      farendSeen = farendSeen || this._farend;
      this.qM.copyWithin(0, this.H, this.qFill);
      this.qR.copyWithin(0, this.H, this.qFill);
      this.qFill -= this.H;
    }
    this._farend = farendSeen;
    const out = new Float32Array(n);
    const avail = Math.min(n, this.outFill);
    const pad = n - avail;
    for (let i = 0; i < avail; i++) out[pad + i] = this.qOut[i]!;
    this.qOut.copyWithin(0, avail, this.outFill);
    this.outFill -= avail;
    return out;
  }

  private processHop(nearEndActive: boolean): void {
    const { F, H, nb, K } = this;
    // slide analysis frames, append the new hop, window
    this.inbufM.copyWithin(0, H);
    this.inbufR.copyWithin(0, H);
    for (let i = 0; i < H; i++) { this.inbufM[F - H + i] = this.qM[i]!; this.inbufR[F - H + i] = this.qR[i]!; }
    for (let i = 0; i < F; i++) { this.frameM[i] = this.inbufM[i]! * this.win[i]!; this.frameR[i] = this.inbufR[i]! * this.win[i]!; }
    // rfft mic, snapshot (rfft reuses its output buffers), then rfft ref
    const M = this.fft.rfft(this.frameM);
    for (let f = 0; f < nb; f++) { this.MtRe[f] = M.re[f]!; this.MtIm[f] = M.im[f]!; }
    const R = this.fft.rfft(this.frameR);
    for (let f = 0; f < nb; f++) { this.RtRe[f] = R.re[f]!; this.RtIm[f] = R.im[f]!; }
    // shift the reference FIFO down one row (newest -> row 0)
    for (let k = K - 1; k >= 1; k--) {
      const dst = k * nb, src = (k - 1) * nb;
      for (let f = 0; f < nb; f++) { this.rfRe[dst + f] = this.rfRe[src + f]!; this.rfIm[dst + f] = this.rfIm[src + f]!; }
    }
    for (let f = 0; f < nb; f++) { this.rfRe[f] = this.RtRe[f]!; this.rfIm[f] = this.RtIm[f]!; }
    // predicted echo yhat[f] = sum_k W[k,f]·rfifo[k,f]; error e = Mt - yhat
    for (let f = 0; f < nb; f++) {
      let yr = 0, yi = 0;
      for (let k = 0; k < K; k++) {
        const idx = k * nb + f;
        const wr = this.Wre[idx]!, wi = this.Wim[idx]!, rr = this.rfRe[idx]!, ri = this.rfIm[idx]!;
        yr += wr * rr - wi * ri;
        yi += wr * ri + wi * rr;
      }
      this.eRe[f] = this.MtRe[f]! - yr;
      this.eIm[f] = this.MtIm[f]! - yi;
    }
    // far-end activity gate
    let rpow = 0;
    for (let f = 0; f < nb; f++) rpow += this.RtRe[f]! * this.RtRe[f]! + this.RtIm[f]! * this.RtIm[f]!;
    rpow /= nb;
    this._farend = rpow > this.refFloor;
    // NLMS adapt (far-end active and not near-end double-talk): W = leak·W + (mu·e/denom)·conj(rfifo)
    if (this._farend && !nearEndActive) {
      for (let f = 0; f < nb; f++) {
        let denom = 1e-12;
        for (let k = 0; k < K; k++) { const idx = k * nb + f; denom += this.rfRe[idx]! * this.rfRe[idx]! + this.rfIm[idx]! * this.rfIm[idx]!; }
        const sr = (this.mu * this.eRe[f]!) / denom;
        const si = (this.mu * this.eIm[f]!) / denom;
        for (let k = 0; k < K; k++) {
          const idx = k * nb + f;
          const rr = this.rfRe[idx]!, ri = this.rfIm[idx]!;
          // step·conj(r): real = sr·rr + si·ri ; imag = si·rr − sr·ri
          let wr = this.leak * this.Wre[idx]! + (sr * rr + si * ri);
          let wi = this.leak * this.Wim[idx]! + (si * rr - sr * ri);
          if (wr > CLAMP) wr = CLAMP; else if (wr < -CLAMP) wr = -CLAMP;
          if (wi > CLAMP) wi = CLAMP; else if (wi < -CLAMP) wi = -CLAMP;
          this.Wre[idx] = wr; this.Wim[idx] = wi;
        }
      }
    }
    // ERLE (far-end active frames)
    if (this._farend) {
      let mp = 0, ep = 0;
      for (let f = 0; f < nb; f++) {
        mp += this.MtRe[f]! * this.MtRe[f]! + this.MtIm[f]! * this.MtIm[f]!;
        ep += this.eRe[f]! * this.eRe[f]! + this.eIm[f]! * this.eIm[f]!;
      }
      mp /= nb; ep /= nb;
      this._micPow = this.erleAlpha * this._micPow + (1 - this.erleAlpha) * mp;
      this._errPow = this.erleAlpha * this._errPow + (1 - this.erleAlpha) * ep;
      this._erleDb = 10 * Math.log10((this._micPow + 1e-20) / (this._errPow + 1e-20));
    }
    // irfft(e) + overlap-add; drain H to the output FIFO
    this.fft.irfftInto(this.eRe, this.eIm, this.irOut);
    for (let i = 0; i < F; i++) this.ola[i]! += this.irOut[i]!;
    if (this.outFill + H > this.qOut.length) { const nq = new Float64Array(this.qOut.length * 2); nq.set(this.qOut.subarray(0, this.outFill)); this.qOut = nq; }
    for (let i = 0; i < H; i++) this.qOut[this.outFill + i] = this.ola[i]!;
    this.outFill += H;
    this.ola.copyWithin(0, H);
    this.ola.fill(0, F - H);
  }

  reset(): void {
    this.qFill = 0;
    this.outFill = this.F;
    this.qM.fill(0);
    this.qR.fill(0);
    this.inbufM.fill(0);
    this.inbufR.fill(0);
    this.ola.fill(0);
    this.qOut.fill(0);
    this.Wre.fill(0);
    this.Wim.fill(0);
    this.rfRe.fill(0);
    this.rfIm.fill(0);
    this._micPow = 0;
    this._errPow = 0;
    this._erleDb = 0;
    this._farend = false;
  }
}
