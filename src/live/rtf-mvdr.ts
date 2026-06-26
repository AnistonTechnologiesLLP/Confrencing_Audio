/**
 * RTF-MVDR: data-estimated steering (relative transfer function) for the frequency-domain beam.
 *
 * The measured-R MVDR ({@link MeasuredNoise}) aims the plane-wave manifold `a0(az)` (from SRP-PHAT) into a
 * measured noise covariance. RTF-MVDR instead estimates the target's **relative transfer function** `h` from
 * the data — the real source→mic transfer (reverberation, near-field, per-capsule gain/phase mismatch) — and
 * uses `h` as the steering. Per band, `h` is the principal generalized eigenvector of `(R_target, R_noise)`
 * (the max-SNR / GEVD solution) mapped through the noise covariance: `h = R_noise · v`. The caller feeds `h`
 * into the existing per-bin MVDR solve `w = R_noise⁻¹ h / (hᴴ R_noise⁻¹ h)` — but only where `h` cross-checks
 * against the plane-wave look (cosine ≥ {@link RTF_DOA_MIN_COS}); a low score means the RTF locked onto
 * something other than the detected talker, so that band keeps the plane-wave steering.
 *
 * Faithful in formulation to the Python `rtf_mvdr.py` (`estimate_rtf_gevd` / `rtf_cosine_to_manifold`), but
 * the GEVD principal eigenvector is found by **inverse-free power iteration** on `R_noise⁻¹ R_target` (reusing
 * the zero-dep complex `solve`) instead of LAPACK `eigh` — numerically close, not bit-exact. The downstream
 * cosine gate and MVDR solve are invariant to `h`'s scale and global phase, so the eigensolver choice doesn't
 * change the trusted-band result. Runs on the control thread (off the audio callback), like the rest of the
 * weight computation. Unit-norm per band (no fixed reference capsule, so a dead/hot capsule can't break it).
 */
import { cadd, cconj, cmul, complex, type Complex } from '../beamformer/geometry.js';
import { solve } from '../beamformer/beamformer.js';

/** Per-band RTF↔plane-wave cosine below this → keep plane-wave (the SRP-PHAT cross-check). Python parity. */
export const RTF_DOA_MIN_COS = 0.5;
/** Diagonal loading for the GEVD's noise covariance (Python `estimate_rtf_gevd` default). */
export const RTF_LOADING = 1e-3;
/** Power-iteration steps for the principal generalized eigenvector (M is small; converges fast). */
const RTF_POWER_ITERS = 24;

/** A·x for complex M×M `A` and length-M `x`. */
function matvec(a: readonly Complex[][], x: readonly Complex[]): Complex[] {
  const m = a.length;
  const out: Complex[] = new Array<Complex>(m);
  for (let i = 0; i < m; i++) {
    let s: Complex = { re: 0, im: 0 };
    const row = a[i]!;
    for (let j = 0; j < m; j++) s = cadd(s, cmul(row[j]!, x[j]!));
    out[i] = s;
  }
  return out;
}

/** Euclidean norm `√Σ|x_i|²`. */
function vnorm(x: readonly Complex[]): number {
  let s = 0;
  for (const c of x) s += c.re * c.re + c.im * c.im;
  return Math.sqrt(s);
}

function trivialRtf(m: number): Complex[] {
  const v: Complex[] = Array.from({ length: m }, () => complex(0, 0));
  v[0] = complex(1, 0);
  return v;
}

/**
 * Single-band RTF via the principal generalized eigenvector of `(rTarget, rNoise)`. Returns unit-norm `h`
 * (length M); a degenerate band falls back to the trivial unit vector `e0` (which the cosine gate then
 * rejects, keeping the plane-wave steering). `rNoise` is trace-relatively diagonally loaded for a
 * positive-definite generalized problem.
 */
export function estimateRtfGevd(rTarget: readonly Complex[][], rNoise: readonly Complex[][], loading: number = RTF_LOADING): Complex[] {
  const m = rNoise.length;
  if (m === 0) return [];
  let tr = 0;
  for (let i = 0; i < m; i++) tr += rNoise[i]![i]!.re;
  const load = loading * (tr / m + 1e-20);
  const Rn: Complex[][] = rNoise.map((row, i) => row.map((x, j) => (i === j ? complex(x.re + load, x.im) : { ...x })));

  // power iteration on Rn⁻¹ rTarget → principal generalized eigenvector v (A v = λ Rn v, max λ)
  let v: Complex[] = Array.from({ length: m }, () => complex(1 / Math.sqrt(m), 0));
  for (let it = 0; it < RTF_POWER_ITERS; it++) {
    const w = matvec(rTarget, v); // rTarget · v
    let y: Complex[];
    try {
      y = solve(Rn, w); // Rn⁻¹ (rTarget v)
    } catch {
      return trivialRtf(m); // singular despite loading → degenerate
    }
    const nrm = vnorm(y);
    if (nrm < 1e-20) return trivialRtf(m);
    v = y.map((c) => complex(c.re / nrm, c.im / nrm));
  }
  const hb = matvec(Rn, v); // h = Rn · v
  const hn = vnorm(hb);
  if (hn < 1e-20) return trivialRtf(m);
  return hb.map((c) => complex(c.re / hn, c.im / hn));
}

/** Cosine similarity `|hᴴa| / (‖h‖‖a‖)` in [0, 1] — the SRP-PHAT cross-check (Python parity). */
export function rtfCosine(h: readonly Complex[], a: readonly Complex[]): number {
  let acc: Complex = { re: 0, im: 0 };
  for (let i = 0; i < h.length; i++) acc = cadd(acc, cmul(cconj(h[i]!), a[i]!)); // hᴴa
  const num = Math.hypot(acc.re, acc.im);
  const den = vnorm(h) * vnorm(a) + 1e-20;
  return num / den;
}
