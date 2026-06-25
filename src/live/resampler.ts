/**
 * Phase-coherent streaming polyphase resampler (`up`/`down`) — pure TS, zero-dep.
 *
 * The TS pipeline has no scipy `resample_poly`, so this hand-rolls the polyphase resample AND the streaming
 * accounting. The naive "resample(concat(history, x))[trim:]" overlap-save is WRONG for a rational resampler
 * (it resets the polyphase commutator phase every block, the integer-floor trim drifts a fraction of a sample
 * per block, and it emits the FIR's unsettled right edge) — together that dragged a 44.1↔48 kHz round-trip to
 * ≈ −10 dB THD+N. This instead emits only the SETTLED interior with exact cumulative-integer accounting: it
 * holds back `_margin` future samples for right-edge settling, keeps `_winStart` an exact multiple of `down`
 * so the polyphase phase never resets, and tracks emitted output by a running count so nothing is floored away
 * or duplicated. Drift-free by construction; adds a fixed ~`_margin`-sample lookahead. Port of the Python
 * `deepfilter_cleaner._StreamingResampler`.
 */

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Modified Bessel function of the first kind, order 0 (for the Kaiser window). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; k < 50; k++) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/**
 * A length-`L` Kaiser-windowed-sinc low-pass FIR (cutoff as a fraction of Nyquist), unity DC gain.
 * The anti-alias prototype filter for the polyphase resampler.
 */
function kaiserSincLowpass(L: number, cutoffNyquist: number, beta: number): Float64Array {
  const h = new Float64Array(L);
  const M = L - 1;
  const center = M / 2;
  const i0beta = besselI0(beta);
  const fc = cutoffNyquist / 2; // cycles/sample
  let sum = 0;
  for (let n = 0; n < L; n++) {
    const t = n - center;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const r = (2 * n) / M - 1;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0beta;
    h[n] = sinc * w;
    sum += h[n]!;
  }
  for (let n = 0; n < L; n++) h[n] = h[n]! / sum; // normalize to unity DC gain
  return h;
}

export interface ResamplerOptions {
  /** Half-length of the prototype filter (taps = 2·halfLen·max(up,down)+1). Higher = deeper stopband. */
  halfLen?: number;
  /** Kaiser window beta (higher = deeper stopband, wider transition). */
  beta?: number;
}

export class StreamingResampler {
  private readonly up: number;
  private readonly down: number;
  private readonly margin: number;
  private readonly h: Float64Array; // anti-alias FIR, scaled by `up` (polyphase passband gain = 1)
  private win: Float64Array = new Float64Array(0); // sliding input window
  private winStart = 0; // global index of win[0]; INVARIANT: a multiple of `down`
  private outDone = 0; // cumulative output samples emitted (drift-free accounting)

  constructor(up: number, down: number, opts: ResamplerOptions = {}) {
    const g = gcd(up, down);
    this.up = up / g;
    this.down = down / g;
    const maxUD = Math.max(this.up, this.down);
    this.margin = 4 * maxUD + 1;
    const halfLen = opts.halfLen ?? 16;
    const beta = opts.beta ?? 9.0;
    const L = 2 * halfLen * maxUD + 1;
    const proto = kaiserSincLowpass(L, 1 / maxUD, beta);
    this.h = new Float64Array(L);
    for (let i = 0; i < L; i++) this.h[i] = proto[i]! * this.up; // polyphase gain
  }

  /** Single-shot polyphase resample of `win`: `y[m] = Σ_j h[m·down − j·up] · win[j]`. */
  private resamplePoly(win: Float64Array): Float64Array {
    const { up, down, h } = this;
    const L = h.length;
    const inLen = win.length;
    const outLen = Math.ceil((inLen * up) / down);
    const y = new Float64Array(outLen);
    for (let m = 0; m < outLen; m++) {
      const k = m * down;
      const jMin = Math.max(0, Math.ceil((k - L + 1) / up));
      const jMax = Math.min(inLen - 1, Math.floor(k / up));
      let acc = 0;
      for (let j = jMin; j <= jMax; j++) acc += h[k - j * up]! * win[j]!;
      y[m] = acc;
    }
    return y;
  }

  process(x: Float32Array): Float32Array {
    if (x.length === 0) return new Float32Array(0);
    const { up, down, margin } = this;
    // append x to the sliding window
    const win = new Float64Array(this.win.length + x.length);
    win.set(this.win);
    for (let i = 0; i < x.length; i++) win[this.win.length + i] = x[i]!;
    this.win = win;

    const usableEnd = this.winStart + this.win.length - margin;
    if (usableEnd <= this.winStart) return new Float32Array(0); // not enough settled input yet

    const target = Math.max(Math.floor((usableEnd * up - 1) / down), this.outDone);
    const y = this.resamplePoly(this.win);
    const base = Math.floor((this.winStart * up) / down); // exact: winStart is a multiple of down
    const out = new Float32Array(target - this.outDone);
    for (let i = 0; i < out.length; i++) out[i] = y[this.outDone - base + i]!;
    this.outDone = target;

    const newStart = Math.floor((usableEnd - margin) / down) * down; // keep margin past-context, stay on a down-multiple
    if (newStart > this.winStart) {
      this.win = this.win.slice(newStart - this.winStart);
      this.winStart = newStart;
    }
    return out;
  }

  reset(): void {
    this.win = new Float64Array(0);
    this.winStart = 0;
    this.outDone = 0;
  }
}
