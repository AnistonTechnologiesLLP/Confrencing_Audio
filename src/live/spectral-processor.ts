/**
 * Streaming single-channel post-beam spectral noise suppressor: Hann overlap-add
 * STFT (FRAME/HOP), a VAD-independent minimum-statistics noise floor, and a gentle
 * single-pole Wiener gate (with 3-tap frequency + one-pole temporal smoothing).
 * Byte-identical passthrough until the floor has warmed up. Pluggable per-bin gain
 * law (subclasses override computeGain). Pure, Float64, zero-dep. Port of the
 * Python _PostNoiseSuppressor.
 */
import { FftRadix2 } from './fft.js';

export const NR_FRAME = 512;
export const NR_HOP = 256;

export interface SpectralOptions {
  frame?: number;
  hop?: number;
  floorDb?: number;
  oversub?: number;
  gainAlpha?: number;
  warmupFrames?: number;
  powerAlpha?: number;
  minstatSub?: number;
  minstatSublen?: number;
  minstatBias?: number;
  amount?: number;
}

export class StreamingSpectralProcessor {
  protected readonly F: number;
  protected readonly H: number;
  protected readonly nb: number;
  private readonly fft: FftRadix2;
  private readonly win: Float64Array;
  private readonly gFloor: number;
  private readonly oversub: number;
  private readonly gainAlpha: number;
  private readonly warmup: number;
  private readonly powerAlpha: number;
  private readonly subN: number;
  private readonly subLen: number;
  private readonly bias: number;
  private readonly amount: number;
  // streaming buffers
  private fifo: Float64Array;
  private fill = 0;
  private readonly inbuf: Float64Array;
  private readonly frame: Float64Array;
  private readonly ola: Float64Array;
  private outq: Float64Array;
  private outFill = 0;
  // floor state
  private readonly noiseMag: Float64Array;
  private readonly gainPrev: Float64Array;
  private readonly pSmooth: Float64Array;
  private readonly submin: Float64Array;
  private readonly minbuf: Float64Array[]; // subN × nb
  private subFrame = 0;
  private subIdx = 0;
  private totalFrames = 0;
  private _engaged = false;

  constructor(sampleRate: number, opts: SpectralOptions = {}) {
    void sampleRate;
    this.F = Math.max(2, (Math.trunc(opts.frame ?? NR_FRAME) >> 1) << 1);
    this.H = opts.hop ?? this.F >> 1;
    this.nb = this.F / 2 + 1;
    this.fft = new FftRadix2(this.F);
    this.win = new Float64Array(this.F);
    for (let i = 0; i < this.F; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.F - 1));
    this.gFloor = Math.min(1, Math.pow(10, (opts.floorDb ?? -15) / 20));
    this.oversub = Math.max(0, opts.oversub ?? 1.5);
    this.gainAlpha = opts.gainAlpha ?? 0.5;
    this.warmup = Math.max(0, opts.warmupFrames ?? 16);
    this.powerAlpha = opts.powerAlpha ?? 0.8;
    this.subN = Math.max(1, opts.minstatSub ?? 8);
    this.subLen = Math.max(1, opts.minstatSublen ?? 16);
    this.bias = Math.max(1, opts.minstatBias ?? 1.5);
    this.amount = Math.min(1, Math.max(0, opts.amount ?? 1));
    this.fifo = new Float64Array(this.F * 2);
    this.inbuf = new Float64Array(this.F);
    this.frame = new Float64Array(this.F);
    this.ola = new Float64Array(this.F);
    this.outq = new Float64Array(this.F * 2);
    this.noiseMag = new Float64Array(this.nb);
    this.gainPrev = new Float64Array(this.nb).fill(1);
    this.pSmooth = new Float64Array(this.nb);
    this.submin = new Float64Array(this.nb).fill(Infinity);
    this.minbuf = Array.from({ length: this.subN }, () => new Float64Array(this.nb).fill(Infinity));
  }

  get engaged(): boolean {
    return this._engaged;
  }

  /** Wiener gate gain law (base). Subclasses override. */
  protected computeGain(power: Float64Array, noiseMag: Float64Array): Float64Array {
    const g = new Float64Array(this.nb);
    for (let k = 0; k < this.nb; k++) {
      const n2 = noiseMag[k]! * noiseMag[k]!;
      const wiener = power[k]! / (power[k]! + this.oversub * n2 + 1e-20);
      g[k] = this.gFloor + (1 - this.gFloor) * wiener;
    }
    return g;
  }

  process(block: Float32Array, noiseGate: boolean): Float32Array {
    if (!this._engaged && this.totalFrames + Math.floor((this.fill + block.length) / this.H) < this.warmup) {
      // fast path: definitely still warming up → run the floor update but return input byte-identical
      this.feedAndFrame(block, noiseGate, false);
      if (!this._engaged) return block;
    }
    const out = this.feedAndFrame(block, noiseGate, true);
    return out ?? block;
  }

  /** Accumulate the block, process complete hops; when `emit`, return the cleaned mono. */
  // noiseGate is unused by the base (the min-stat floor is VAD-independent); a subclass needing per-call VAD must override process()
  private feedAndFrame(block: Float32Array, _noiseGate: boolean, emit: boolean): Float32Array | null {
    const n = block.length;
    if (this.fill + n > this.fifo.length) {
      const next = new Float64Array(Math.max(this.fifo.length * 2, this.fill + n));
      next.set(this.fifo.subarray(0, this.fill));
      this.fifo = next;
    }
    for (let i = 0; i < n; i++) this.fifo[this.fill + i] = block[i]!;
    this.fill += n;
    while (this.fill >= this.H) {
      this.processHop();
      this.fifo.copyWithin(0, this.H, this.fill);
      this.fill -= this.H;
    }
    if (!emit || !this._engaged) return null;
    // drain n samples from outq (front-pad with zeros on the one-time engagement underflow)
    const out = new Float32Array(n);
    const avail = Math.min(n, this.outFill);
    const pad = n - avail;
    for (let i = 0; i < avail; i++) out[pad + i] = this.outq[i]!;
    this.outq.copyWithin(0, avail, this.outFill);
    this.outFill -= avail;
    return out;
  }

  private processHop(): void {
    const { F, H, nb } = this;
    // slide analysis buffer left by H, append the new hop
    this.inbuf.copyWithin(0, H);
    for (let i = 0; i < H; i++) this.inbuf[F - H + i] = this.fifo[i]!;
    for (let i = 0; i < F; i++) this.frame[i] = this.inbuf[i]! * this.win[i]!;
    const X = this.fft.rfft(this.frame);
    // per-bin power + min-statistics floor
    const power = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      const p = X.re[k]! * X.re[k]! + X.im[k]! * X.im[k]!;
      power[k] = p;
      this.pSmooth[k] = this.totalFrames === 0 ? p : this.powerAlpha * this.pSmooth[k]! + (1 - this.powerAlpha) * p;
      if (this.pSmooth[k]! < this.submin[k]!) this.submin[k] = this.pSmooth[k]!;
    }
    this.subFrame += 1;
    if (this.subFrame >= this.subLen) {
      this.minbuf[this.subIdx]!.set(this.submin);
      this.subIdx = (this.subIdx + 1) % this.subN;
      // new sub-window starts tracking from the current smoothed power (minimum-statistics)
      for (let k = 0; k < nb; k++) this.submin[k] = this.pSmooth[k]!;
      this.subFrame = 0;
    }
    for (let k = 0; k < nb; k++) {
      let pmin = this.submin[k]!;
      for (let s = 0; s < this.subN; s++) if (this.minbuf[s]![k]! < pmin) pmin = this.minbuf[s]![k]!;
      this.noiseMag[k] = Math.sqrt(this.bias * pmin);
    }
    this.totalFrames += 1;
    if (!this._engaged && this.totalFrames >= this.warmup) this._engaged = true;
    if (!this._engaged) return;
    // gain law + smoothing
    let g = this.computeGain(power, this.noiseMag);
    const gs = new Float64Array(nb);
    gs[0] = g[0]!;
    gs[nb - 1] = g[nb - 1]!;
    for (let k = 1; k < nb - 1; k++) gs[k] = 0.25 * g[k - 1]! + 0.5 * g[k]! + 0.25 * g[k + 1]!;
    for (let k = 0; k < nb; k++) {
      const v = this.gainAlpha * gs[k]! + (1 - this.gainAlpha) * this.gainPrev[k]!;
      this.gainPrev[k] = v;
      gs[k] = this.amount < 1 ? this.amount * v + (1 - this.amount) : v;
    }
    // apply, irfft, overlap-add
    const yr = new Float64Array(nb);
    const yi = new Float64Array(nb);
    for (let k = 0; k < nb; k++) { yr[k] = gs[k]! * X.re[k]!; yi[k] = gs[k]! * X.im[k]!; }
    const y = this.fft.irfft(yr, yi);
    for (let i = 0; i < F; i++) this.ola[i]! += y[i]!;
    if (this.outFill + H > this.outq.length) {
      const next = new Float64Array(this.outq.length * 2);
      next.set(this.outq.subarray(0, this.outFill));
      this.outq = next;
    }
    for (let i = 0; i < H; i++) this.outq[this.outFill + i] = this.ola[i]!;
    this.outFill += H;
    this.ola.copyWithin(0, H);
    this.ola.fill(0, F - H);
  }

  reset(): void {
    this.fill = 0;
    this.outFill = 0;
    this.subFrame = 0;
    this.subIdx = 0;
    this.totalFrames = 0;
    this._engaged = false;
    this.inbuf.fill(0);
    this.ola.fill(0);
    this.noiseMag.fill(0);
    this.gainPrev.fill(1);
    this.pSmooth.fill(0);
    this.submin.fill(Infinity);
    for (const b of this.minbuf) b.fill(Infinity);
  }
}
