/**
 * Live, real-time beamforming for the TS pipeline — fractional-delay-and-sum.
 *
 * The OFFLINE `src/beamformer` produces narrowband complex weights at one design
 * frequency; those cannot be applied to broadband time-domain audio. The live
 * path instead aligns capsules by their geometric arrival delay and sums — a
 * frequency-invariant operation. Faithful port of the Python engine's
 * `_FracDelaySumBeam` (`conf_pipeline_control/polaris_beamformer.py`).
 */
import { ArrayGeometry, SOUND_SPEED_MPS } from '../beamformer/geometry.js';

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
