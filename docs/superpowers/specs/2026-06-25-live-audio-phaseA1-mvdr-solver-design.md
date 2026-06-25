# Live audio — Phase A1 design (per-bin MVDR/LCMV solver)

**Date:** 2026-06-25
**Status:** design, approved (user delegated the open choices to me: dedicated `mvdr-solver.ts`, defer RTF-MVDR).
**Branch:** `feat/live-audio-phaseA-nullsteering` (off `master` `c213423`; the whole Phase A stacks here).
**Part of:** Phase A (multi-talker + null-steering). A1 is the pure compute kernel A2's runtime calls off the audio lock.

---

## 1. Goal & scope

Port the Python `_FreqDomainBeam._compute_weights` (`polaris_beamformer.py:672-755`) — the per-FFT-bin
LCMV/MVDR weight solver — to a **pure, hardware-free, zero-dep** TypeScript module. It turns *(array
geometry, look direction, null directions, optional measured noise covariance, per-bin frequencies)* into a
**per-bin complex weight table** `W` (`nBins × nChannels`). **In scope:** the solver math (superdirective +
data-adaptive MVDR + LCMV nulls + the DC ridge). **Out of scope:** the STFT/streaming runtime + plan/commit
(A2), the null-budget/seat-null arbiter (A3), RTF-MVDR (GEVD relative-transfer-function steering,
`rtf_mvdr.py` — a later refinement, explicitly deferred).

## 2. Architecture — `src/live/mvdr-solver.ts` (new, pure, browser-safe)

### 2.1 Reuse vs. new
Reuses the validated narrowband primitives from `src/beamformer/` (pure stdlib, browser-safe; the live layer
already imports `geometry.js`):
- `steeringVector(geom, unit, freqHz): Complex[]` — the plane-wave manifold `a(u,f) = exp(+jk·(p·u))`.
- `diffuseCoherence(geom, freqHz): number[][]` — the active-capsule diffuse field `Γ_ij = sinc(k·d_ij)`.
- The complex Gauss-Jordan `solve(A, b)` — **currently private in `beamformer.ts`; this phase exports it**
  (a one-line additive `export`, plus `SingularMatrixError`; the offline tests are unaffected).
- `Complex` + ops (`cadd`/`csub`/`cmul`/`cscale`/`cconj`/`cdiv`/`cabs`/`complex`), `SOUND_SPEED_MPS`,
  `ArrayGeometry`, `Direction` — from `geometry.js`/`steering.js`.

The one genuinely-new piece is solving a **complex** measured `R` (the offline `weightsConstrained` only
solves a **real** `R` via `solveReal`). A1 builds `R` as `Complex[][]` always (`Γ` complexified, im = 0;
measured `R` Hermitian) and uses the complex `solve` — exactly matching the Python (`gamma.astype(complex)` +
`np.linalg.solve`).

### 2.2 Core API
```ts
export interface MeasuredNoise {
  bandBins: readonly number[];     // rfft bin indices that carry a measured covariance (the DOA band)
  cov: readonly Complex[][][];     // cov[i] = the M×M Hermitian covariance for bin bandBins[i] (full channels)
}
export interface BeamWeightOptions {
  loading?: number;                // diagonal loading; default DEFAULT_SUPERDIRECTIVE_LOADING; floored at 1e-9
  measured?: MeasuredNoise | null; // data-adaptive MVDR overlay; null/absent ⇒ analytic superdirective
}
export function computeBeamWeights(
  geom: ArrayGeometry,
  freqsHz: readonly number[],
  look: Direction,
  nulls: readonly Direction[],
  opts?: BeamWeightOptions,
): Complex[][];                     // [bin][channel]; inactive channels = {re:0,im:0}
```
Helpers/constants exported: `acceptableNulls(geom, look, nulls): Direction[]` (§2.4),
`DEFAULT_SUPERDIRECTIVE_LOADING` (the Python value), `MVDR_LOADING_FLOOR = 1e-9`, `LCMV_DC_RIDGE = 1e-10`.

### 2.3 Per-bin algorithm (faithful to `_compute_weights`)
For each bin `b` with frequency `f = freqsHz[b]`, over active capsules `idx` (na of them):
1. `a = steeringVector(geom, look.unit, f)` restricted to `idx` (na-vector).
2. `R = Γ(f) + loading·I` as `Complex[][]` (`Γ` from `diffuseCoherence`, complexified; `loading =
   max(1e-9, opts.loading ?? DEFAULT)`).
3. **Measured overlay (data-adaptive MVDR):** if `opts.measured` and `b ∈ bandBins`: take the active
   submatrix `rn` of `cov[i]`, apply **trace-relative loading** `rn += loading · max(mean(diag(rn).re),
   1e-20) · I`, and set `R = rn` (replace, not add — matches Python `R[band] = rn`).
4. **Solve:**
   - **K = 0 → MVDR:** `t = solve(R, a)`; `denom = aᴴ·t`; `w = t / denom`.
   - **K > 0 → LCMV:** `C = [a(look), a(φ₁)…a(φ_K)]` (na × (1+K)); `g = [1,0,…,0]`; `rinvC[q] =
     solve(R, C[:,q])`; `small = CᴴR⁻¹C` ((1+K)×(1+K)); add **trace-relative ridge** `small +=
     1e-10·max(tr(small).re, 1e-30)·I` (keeps DC/low-f finite where manifolds collapse); `y = solve(small,
     g)`; `w_i = Σ_q y_q · rinvC[q]_i`.
5. **Scatter:** place `w` into a full `nChannels` row of `W` at the active slots; inactive channels stay 0.

### 2.4 `acceptableNulls`
A minimal, defensive vetting (the *rich* budget arbiter — tiers/salience/seat-nulls — is A3): drop any null
whose direction ≈ the look (within a small angular epsilon, so `C` doesn't go singular), then cap the list at
`na − 1` (an array of `na` active capsules forms at most `na − 1` independent nulls). `computeBeamWeights`
calls `acceptableNulls` internally so a caller can pass raw candidate nulls safely. (Mirrors Python
`_acceptable_nulls(nulls, look, na-1)`.)

## 3. Data flow

```
(geom, freqsHz, look, nulls, measured?) ─ computeBeamWeights ─▶ W[bin][channel]  (consumed by A2's MAC loop)
                                            per bin: R=Γ+load (+measured overlay) → MVDR(K=0)|LCMV(K>0)+ridge → scatter
```

## 4. Real-time safety / performance

A1 is the **off-lock** kernel — A2 calls it in `plan` (multi-ms budget), never on the audio callback. So A1
optimizes for **correctness and clarity**, not per-call allocation. It allocates the `W` table and per-bin
scratch freely. (The realtime MAC loop that consumes `W` is A2's concern.) Pure function, no shared state, no
streaming history. The cost is `O(nBins · na³)` (Gauss-Jordan per bin); A2's spec will benchmark the full
513-bin solve against its plan budget — A1 only needs to be correct here.

## 5. Testing (hardware-free, vitest)

- **Cross-validation against the offline layer:** with `measured` absent, `computeBeamWeights` at a sampled
  set of freqs must equal the offline `superdirectiveWeights(geom, look, nulls, f, loading)` bin-for-bin
  (within fp tolerance), and with `loading=0`/identity-`R` it must equal `lcmvWeights(geom, look, nulls, f)`.
  This proves the per-bin port reproduces the validated narrowband math.
- **Beam-pattern properties:** the weights give **unity response at the look** (`|wᴴa(look)| ≈ 1`) and a
  **deep null at each `φ`** (`|wᴴa(φ)| ≈ 0`, e.g. < −40 dB) at a mid-band frequency.
- **Data-adaptive MVDR:** feed a synthetic rank-1 interferer covariance `R = σ²·a(φ_i)a(φ_i)ᴴ + εI` as
  `measured` on a band bin → the resulting weights put a **null toward φ_i** (response there ≪ the look),
  proving the measured-R path nulls the actual interferer field (not just analytic Γ).
- **DC/low-f stability:** the DC bin (f = 0) and a very-low-f bin stay **finite** (the ridge), with and
  without nulls — no NaN/Inf, no throw.
- **Guards:** more than `na − 1` nulls is capped by `acceptableNulls` (no throw, no singular solve); a null
  coincident with the look is dropped; inactive capsules get exactly `{0,0}` weight; a dead capsule (inactive
  index) is excluded from the solve and zero in `W`.
- **Determinism:** same inputs → identical `W` (pure).

## 6. Deliverables & staged commits

1. `feat(beamformer): export the complex solve for the live MVDR solver` (one-line `export` in
   `beamformer.ts` + an export test if useful).
2. `feat(live): per-bin MVDR/LCMV beam-weight solver` (`mvdr-solver.ts` core: superdirective + LCMV + ridge +
   `acceptableNulls` + the cross-validation/beam-pattern tests).
3. `feat(live): data-adaptive MVDR (measured covariance overlay)` (the `measured` path + its tests).
   (2 and 3 may merge into one task if small; the controller decides at SDD time.)

## 7. Honest limits (documented)

- A1 is the **solver only** — no STFT, no streaming, no realtime application (A2); no null-budget arbiter
  (A3). Calling it per block on the audio thread would be wrong — it is the plan-path kernel.
- **RTF-MVDR deferred** (GEVD relative-transfer-function steering). A1 is plane-wave-manifold MVDR.
- Diffuse-`Γ` superdirective is the analytic fallback; the data-adaptive null quality is bounded by the
  measured covariance the owner supplies (A2 wires the live `StreamingCovarianceAccumulator` snapshot).

## 8. Risks / unknowns to validate during build

- **Real-vs-complex solve parity:** A1 solves a complexified real `Γ` with the complex `solve` while the
  offline layer uses `solveReal` — they must agree (guarded by the cross-validation test; tolerance set to fp
  noise).
- **DC ridge:** the `1e-10·trace` ridge must be negligible in-band yet keep the singular DC/low-f bins finite
  (guarded by the DC-stability test + the in-band null-depth test).
- **Trace-relative loading on measured `R`:** must match Python (`loading · mean(diag.re)`) so the
  measured-R MVDR is well-conditioned (guarded by the data-adaptive test).
- **Exporting `solve`** must not regress the offline beamformer (additive export only; run the offline
  beamformer tests).

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; `dependencies` stays `{}`.
- `computeBeamWeights` matches the offline narrowband design per-bin, places exact nulls, nulls a measured
  interferer, and is DC-stable.

## References (Python / TS, file:line)

- `conf_pipeline_control/polaris_beamformer.py:602-755` (`_FreqDomainBeam._compute_weights` — Γ, loading,
  measured overlay, K=0 MVDR vs K>0 LCMV, DC ridge, scatter; `_acceptable_nulls`).
- `conf_pipeline_control/beamformer.py` (`superdirective_weights`, `lcmv_weights`, `weights_constrained` —
  the narrowband source of truth).
- TS reuse: `src/beamformer/beamformer.ts` (`steeringVector`, `diffuseCoherence`, private `solve` → export,
  `superdirectiveWeights`/`lcmvWeights` for cross-validation), `src/beamformer/geometry.ts` (`Complex` + ops,
  `SOUND_SPEED_MPS`, `ArrayGeometry`), `src/beamformer/steering.ts` (`Direction`, `lookDirection`).
