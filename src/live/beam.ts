/**
 * Live, real-time beamforming for the TS pipeline — fractional-delay-and-sum.
 *
 * The OFFLINE `src/beamformer` produces narrowband complex weights at one design
 * frequency; those cannot be applied to broadband time-domain audio. The live
 * path instead aligns capsules by their geometric arrival delay and sums — a
 * frequency-invariant operation. Faithful port of the Python engine's
 * `_FracDelaySumBeam` (`conf_pipeline_control/polaris_beamformer.py`).
 */
import { type ArrayGeometry, SOUND_SPEED_MPS } from '../beamformer/geometry.js';

export const DEFAULT_FRACDELAY_TAPS = 15;

/** Steering unit vector from azimuth/off-nadir (0°=+Y CW; off-nadir 0°=straight down). */
export function directionUnit(azimuthDeg: number, offNadirDeg: number): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const nadir = (offNadirDeg * Math.PI) / 180;
  const sinN = Math.sin(nadir);
  return [sinN * Math.sin(az), sinN * Math.cos(az), -Math.cos(nadir)];
}

/** `sinc(x) = sin(πx)/(πx)`, with `sinc(0) = 1` (NumPy's normalized sinc). */
function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Hann-windowed-sinc fractional-delay FIR — delays by `(taps-1)/2 + frac` samples.
 * `taps` is forced odd and floored at 5; normalized to unity DC. `frac==0` → unit
 * impulse at center. Port of `_frac_delay_kernel`.
 */
export function fracDelayKernel(frac: number, taps: number = DEFAULT_FRACDELAY_TAPS): Float64Array {
  const L = Math.max(5, Math.trunc(taps) | 1);
  const center = (L - 1) / 2;
  const k = new Float64Array(L);
  let sum = 0;
  for (let n = 0; n < L; n++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (L - 1));
    const v = sinc(n - center - frac) * hann;
    k[n] = v;
    sum += v;
  }
  for (let n = 0; n < L; n++) k[n]! /= sum;
  return k;
}

/**
 * Per-active-capsule steer delays in samples (≥ 0), aligning a plane wave from
 * `(azimuthDeg, offNadirDeg)`. Port of `_steer_real_delays`.
 */
export function steerRealDelays(
  geom: ArrayGeometry,
  azimuthDeg: number,
  offNadirDeg: number,
  sampleRate: number,
  speedOfSound: number = SOUND_SPEED_MPS,
): { idx: number[]; delays: number[] } {
  const [ux, uy, uz] = directionUnit(azimuthDeg, offNadirDeg);
  const idx = geom.activeIndices();
  const projs = idx.map((m) => {
    const e = geom.elements[m]!;
    return e[0] * ux + e[1] * uy + e[2] * uz;
  });
  const pmin = projs.length > 0 ? Math.min(...projs) : 0;
  const delays = projs.map((p) => ((p - pmin) / speedOfSound) * sampleRate);
  return { idx, delays };
}

/** NumPy `convolve(a, k, 'valid')`: out[i] = Σ_t a[i+t]·k[L-1-t], length = a.length-L+1. */
function convolveValid(a: Float64Array, k: Float64Array): Float64Array {
  const L = k.length;
  const out = new Float64Array(a.length - L + 1);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let t = 0; t < L; t++) s += a[i + t]! * k[L - 1 - t]!;
    out[i] = s;
  }
  return out;
}

/**
 * Streaming delay-and-sum with sub-sample (fractional) steer delays. Each active
 * capsule's real delay splits into an integer part (read from a per-channel
 * history ring) + a fractional remainder (a Hann-sinc FIR), continuous across
 * block boundaries via a per-channel FIR tail. Port of `_FracDelaySumBeam`.
 */
export class StreamingDelaySumBeam {
  private readonly geom: ArrayGeometry;
  private readonly fs: number;
  private readonly c: number;
  private readonly L: number; // FIR length (odd, ≥5)
  private idx: number[] = [];
  private delaysInt: number[] = [];
  private kernels: Float64Array[] = [];
  private maxd = 0;
  private hist: Float64Array[] = []; // per active capsule, length maxd
  private tail: Float64Array[] = []; // per active capsule, length L-1

  constructor(
    geom: ArrayGeometry,
    sampleRate: number,
    opts: { speedOfSound?: number; taps?: number } = {},
  ) {
    this.geom = geom;
    this.fs = sampleRate;
    this.c = opts.speedOfSound ?? SOUND_SPEED_MPS;
    this.L = Math.max(5, Math.trunc(opts.taps ?? DEFAULT_FRACDELAY_TAPS) | 1); // | 1 forces odd length
    this.setLook(0, 90);
  }

  /** Re-aim the beam. Recomputes integer delays + fractional FIRs and resets history. */
  setLook(azimuthDeg: number, offNadirDeg = 90): void {
    const { idx, delays } = steerRealDelays(this.geom, azimuthDeg, offNadirDeg, this.fs, this.c);
    const di = delays.map((d) => Math.floor(d));
    const fr = delays.map((d, i) => d - di[i]!);
    this.idx = idx;
    this.delaysInt = di;
    this.kernels = fr.map((f) => fracDelayKernel(f, this.L));
    this.maxd = di.length > 0 ? Math.max(...di) : 0;
    this.reset();
  }

  /** Drop all history (call on mode/look change to avoid stale samples). */
  reset(): void {
    const L1 = this.L - 1;
    this.hist = this.idx.map(() => new Float64Array(this.maxd));
    this.tail = this.idx.map(() => new Float64Array(L1));
  }

  /** One block in (per-channel Float32Arrays, length n), mono out (length n). */
  process(channels: Float32Array[]): Float32Array {
    const n = channels.length > 0 ? (channels[this.idx[0] ?? 0]?.length ?? 0) : 0;
    const D = this.maxd;
    const L1 = this.L - 1;
    const out = new Float64Array(n);
    for (let k = 0; k < this.idx.length; k++) {
      const m = this.idx[k]!;
      const d = this.delaysInt[k]!;
      const ker = this.kernels[k]!;
      const histM = this.hist[k]!;
      const ch = channels[m]!;
      // ext = [hist (D) | block (n)]; aligned = ext[D-d : D-d+n]
      const start = D - d;
      const aligned = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const j = start + i;
        aligned[i] = j < D ? histM[j]! : ch[j - D]!;
      }
      // col = [tail (L1) | aligned (n)]; out += convolveValid(col, ker)
      const col = new Float64Array(L1 + n);
      col.set(this.tail[k]!, 0);
      col.set(aligned, L1);
      const conv = convolveValid(col, ker);
      for (let i = 0; i < n; i++) out[i]! += conv[i]!;
      // carry: new tail = last L1 samples of col; new hist = last D of ext
      this.tail[k] = col.slice(col.length - L1);
      if (D > 0) {
        const newHist = new Float64Array(D);
        for (let i = 0; i < D; i++) {
          // new ring = last D samples of [hist | block]; correct for n<D too (reads from old hist when j<0)
          const j = n - D + i; // index into block tail (when n >= D)
          newHist[i] = j >= 0 ? ch[j]! : histM[D + j]!;
        }
        this.hist[k] = newHist;
      }
    }
    const denom = Math.max(1, this.idx.length);
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = out[i]! / denom;
    return mono;
  }
}
