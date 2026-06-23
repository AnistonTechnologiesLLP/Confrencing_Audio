/**
 * Pure-TypeScript radix-2 Cooley–Tukey FFT (decimation-in-time, in-place) for the
 * live DOA path. Float64 throughout; twiddles + bit-reversal precomputed once.
 * `rfft` runs the complex transform on a real frame (imag = 0) and returns the
 * first `n/2+1` bins (the rest are conjugate-symmetric). Forward only — DOA needs
 * no inverse. Zero dependencies.
 */

export class FftRadix2 {
  private readonly n: number;
  private readonly rev: Int32Array;
  private readonly cos: Float64Array; // W_n^k = exp(-2πi k/n), k = 0..n/2-1
  private readonly sin: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly outRe: Float64Array;
  private readonly outIm: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two ≥ 2 (got ${n})`);
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.outRe = new Float64Array(n / 2 + 1);
    this.outIm = new Float64Array(n / 2 + 1);
  }

  /** In-place complex forward FFT on the work buffers re[]/im[] (length n). */
  private fftInPlace(): void {
    const { n, rev, re, im, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const r = rev[i]!;
      if (r > i) {
        const tr = re[i]!; re[i] = re[r]!; re[r] = tr;
        const ti = im[i]!; im[i] = im[r]!; im[r] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const tw = j * step;
          const wr = cos[tw]!;
          const wi = sin[tw]!;
          const a = i + j;
          const b = a + half;
          const xr = re[b]!;
          const xi = im[b]!;
          const tr = wr * xr - wi * xi;
          const ti = wr * xi + wi * xr;
          re[b] = re[a]! - tr;
          im[b] = im[a]! - ti;
          re[a] = re[a]! + tr;
          im[a] = im[a]! + ti;
        }
      }
    }
  }

  /** Forward FFT of a real frame (length n) → first n/2+1 bins (reused buffers). */
  rfft(frame: Float64Array): { re: Float64Array; im: Float64Array } {
    const { n, re, im, outRe, outIm } = this;
    for (let i = 0; i < n; i++) { re[i] = frame[i]!; im[i] = 0; }
    this.fftInPlace();
    for (let k = 0; k <= n / 2; k++) { outRe[k] = re[k]!; outIm[k] = im[k]!; }
    return { re: outRe, im: outIm };
  }

  /**
   * Inverse real FFT: the n/2+1 half-spectrum (`re`/`im`) → the length-n real
   * signal. Uses ifft(X) = conj(fft(conj(X)))/n: rebuild the conjugate-symmetric
   * full spectrum, conjugate it, forward-FFT, take the real part / n. Returns a
   * freshly-allocated Float64Array of length n.
   */
  irfft(reHalf: Float64Array, imHalf: Float64Array): Float64Array {
    const { n, re, im } = this;
    // Build Y = conj(full spectrum X). For a real signal X[n-k] = conj(X[k]).
    re[0] = reHalf[0]!; im[0] = -imHalf[0]!;
    re[n / 2] = reHalf[n / 2]!; im[n / 2] = -imHalf[n / 2]!;
    for (let k = 1; k < n / 2; k++) {
      re[k] = reHalf[k]!; im[k] = -imHalf[k]!;        // Y[k] = conj(X[k])
      re[n - k] = reHalf[k]!; im[n - k] = imHalf[k]!;  // Y[n-k] = conj(X[n-k]) = conj(conj(X[k]))... = (reHalf[k], +imHalf[k])
    }
    this.fftInPlace();
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = re[i]! / n; // real part of conj(Z)/n = Z_re/n
    return out;
  }
}

/** Direct O(N²) DFT — reference for validating {@link FftRadix2}. First n/2+1 bins. */
export function naiveDft(frame: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const n = frame.length;
  const re = new Float64Array(n / 2 + 1);
  const im = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      sr += frame[t]! * Math.cos(ang);
      si += frame[t]! * Math.sin(ang);
    }
    re[k] = sr;
    im[k] = si;
  }
  return { re, im };
}
