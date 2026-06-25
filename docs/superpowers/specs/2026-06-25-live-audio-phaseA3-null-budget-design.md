# Live audio — Phase A3 design (null-budget arbiter + null-steering)

**Date:** 2026-06-25
**Status:** design, approved (user delegated open choices to me).
**Branch:** `feat/live-audio-phaseA-nullsteering` (continues after A2 `6743d53`).
**Builds on:** A1 `computeBeamWeights` (already supports LCMV nulls), A2 `FreqDomainBeam`, the engine DOA feed.

---

## 1. Goal & scope

Make the frequency-domain beam **steer nulls** at interferers and excluded areas: a deterministic
**null-budget arbiter** (`composeNulls`, port of Python `compose_nulls`) merges competing null sources into
one budgeted list, which feeds A1's LCMV path through the beam. **In scope:** `composeNulls`, the
`FreqDomainBeam.setNulls` path, and the engine wiring (auto-null detected interferers from DOA + config
exclusion/seat nulls + a `BeamOutput.activeNulls` readout). **Out of scope:** the data-adaptive **measured-R
MVDR** (now confirmed clean to wire since `COV_FRAME == FREQ_BEAM_FRAME == 1024` — it is the immediate
follow-on **A3b**, kept separate for reviewability); multi-beam (A4/A5); RTF-MVDR.

## 2. Architecture

### 2.1 `null-budget.ts` (new, pure) — `composeNulls`
Port of `polaris_beamformer.py:compose_nulls` (555-596). Merge competing null **azimuths** into one
budgeted, deterministic list for the steered beam:
```ts
export interface ComposeNullsOptions {
  exclusion?: readonly number[];        // user-drawn no-pickup azimuths (deg)
  seats?: readonly number[];            // empty-seat azimuths (deg), nearest-to-look first
  minSepDeg?: number;                   // drop a null within this of the look (default 8)
  mergeSepDeg?: number;                 // cross-source dedupe distance (default 6)
  seatNullMaxCount?: number | null;     // optionally cap seat nulls to reserve headroom
}
export function composeNulls(
  targetAzDeg: number,
  detected: readonly number[],          // measured interferer azimuths (deg) from DOA
  budget: number,                       // = M − 1
  opts?: ComposeNullsOptions,
): number[];                            // the budgeted null azimuths, in priority order
```
Algorithm (faithful):
1. `budget ≤ 0` ⇒ `[]`.
2. Drop any source azimuth within `minSepDeg` of the look (a near-look null would consume budget and make
   the LCMV constraint singular) — applied to detected, exclusion, seats.
3. Cross-source dedupe within `mergeSepDeg` (exclusion vs detected, seat vs both) — one null per constraint.
4. Fill priority into `final` (capped at `budget`): **detected interferers** first (they win the budget),
   then **exclusions** (user intent), then **seats** (nearest-to-look first, optionally `seatNullMaxCount`-capped).
   When the budget fills before an exclusion/seat fits, it is **dropped** — the caller can surface that.
- Constants exported: `NULL_MIN_SEP_DEG = 8.0`, `NULL_MERGE_SEP_DEG = 6.0` (`≥` the beam's 5° look-guard so
  the composed set survives `acceptableNulls` intact). Reuses the wrap-aware `azSep` (lift it to a shared
  helper or re-export from `mvdr-solver.ts`).

### 2.2 `freq-domain-beam.ts` (modify) — accept nulls
- Add `setNulls(azimuthsDeg: readonly number[]): void` — store the null azimuths (no-op guard if unchanged)
  and recompute `W`. `recompute()` builds `Direction[]` from the stored null azimuths via `bearingDirection`
  and passes them to `computeBeamWeights(geom, freqsHz, look, nullDirs, { loading })` (A1 already does the
  LCMV solve + `acceptableNulls` capping). `setLook` keeps the current nulls. Expose `get activeNullCount()`
  (or the accepted null azimuths) for telemetry.
- The null azimuths are array-relative (same convention as the look). The engine supplies them already in
  array-relative degrees (DOA detections are array-relative).

### 2.3 `engine.ts` / `types.ts` / `index.ts` (modify) — wiring
- `types.ts`: `LiveConfig.nulls?: { autoNullInterferers?: boolean; exclusionDeg?: number[]; seatDeg?: number[];
  seatNullMaxCount?: number }`. `BeamOutput` gains an **omit-when-absent** `activeNulls?: number[]` (the
  composed null azimuths currently applied).
- `engine.ts`: when `config.nulls` is set **and** the beam is `freqDomain` (nulls only apply to the
  freq-domain beam — the delay-sum beam has no null path), in the DOA cycle (where `this.lastDoa` is
  refreshed) compute `detected = autoNullInterferers ? lastDoa.detections (azimuths) minus the look : []`,
  then `composeNulls(look, detected, M−1, { exclusion, seats, seatNullMaxCount })` and
  `beam.setNulls(composed)` (only when the freq-domain beam). Emit `activeNulls` from the beam. Guard: if the
  beam is not `freqDomain`, `config.nulls` is ignored (documented) — or a no-op. Default (no `config.nulls`)
  ⇒ no nulls, `setNulls` never called, no `activeNulls` field (byte-identical).
- `index.ts`: export `composeNulls`, `NULL_MIN_SEP_DEG`, `NULL_MERGE_SEP_DEG`, the `ComposeNullsOptions` type.
- **Byte-identical-when-off:** no `config.nulls` ⇒ the beam runs with `[]` nulls (= A2 superdirective,
  unchanged) and emits no `activeNulls`. Existing tests stay green.

## 3. Data flow

```
DOA detections (azimuths) ┐
config.exclusion/seats    ├─ composeNulls(look, detected, M−1, …) ─▶ beam.setNulls ─▶ recompute W (LCMV) ─▶ MAC
                          ┘                                          BeamOutput.activeNulls?
```

## 4. Real-time safety

`composeNulls` is a tiny pure function over a handful of azimuths (runs in the DOA cycle, off the per-block
MAC). `setNulls` recomputes `W` (the same off-block solve as `setLook`, only when the null set changes — a
no-op guard skips it). Single-threaded ⇒ atomic publish. No new per-block allocation.

## 5. Testing (hardware-free, vitest)

- **`null-budget.ts`:** detected interferers win the budget; exclusions then seats fill the remainder; a
  near-look source (< 8°) is dropped; cross-source duplicates (< 6°) collapse to one; the budget caps the
  total at `M−1`; seats are ordered nearest-to-look and `seatNullMaxCount`-capped; `budget ≤ 0` ⇒ `[]`;
  determinism.
- **`freq-domain-beam.ts`:** `setNulls([φ])` produces a **deep null toward φ** in the beam output (drive a
  plane wave from φ → strongly attenuated vs no-null), while the look response stays ~unity; `setNulls([])`
  reverts to the A2 superdirective output (unchanged); a no-op `setNulls` (same set) doesn't recompute
  (weights-hash unchanged); `activeNullCount` reflects the accepted nulls.
- **`engine.ts`:** `beam:'freqDomain', nulls:{ exclusionDeg:[90] }` ⇒ a 90° interferer is attenuated and
  `BeamOutput.activeNulls` contains ~90; `nulls` absent ⇒ no `activeNulls` field (byte-identical);
  `autoNullInterferers` feeds DOA detections as nulls (a synthetic 2-source scene nulls the non-look one);
  `config.nulls` with the delay-sum beam is ignored (no throw).

## 6. Deliverables & staged commits

1. `feat(live): null-budget arbiter (composeNulls)` (`null-budget.ts` + tests).
2. `feat(live): FreqDomainBeam.setNulls (LCMV null-steering)` (`freq-domain-beam.ts` + tests).
3. `feat(live): wire opt-in null-steering into LiveEngine` (`engine.ts`/`types.ts`/`index.ts` + tests).

## 7. Honest limits (documented)

- A3 is **explicit/auto LCMV null-steering** (analytic superdirective R). The **data-adaptive measured-R
  MVDR** (nulling the *measured* interferer field, not just bearings) is **A3b** — clean to add (frames
  already match at 1024; the covariance snapshot needs to expose its band-bin indices).
- Nulls apply only to the `freqDomain` beam (the delay-sum beam has no null path). Up to `M−1` nulls; a
  planar array's null depth/bandwidth are bounded by its size/capsule count.
- Nulls recompute the weights (off-block, on change) — the same bounded solve as a re-steer.

## 8. Risks / unknowns to validate during build

- The priority order + dedupe in `composeNulls` (detected > exclusion > seat; near-look drop; merge) — guarded
  by the budget tests against the Python cases.
- The composed nulls must survive the beam's internal `acceptableNulls` 5° guard — `mergeSepDeg=6 ≥ 5`
  guarantees it; tested by the end-to-end null-depth test.
- `BeamOutput.activeNulls` omit-when-absent must keep the prior engine shapes green.

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; `dependencies` stays `{}`.
- A configured/auto null deeply attenuates the interferer while the look stays ~unity; nulls absent is
  byte-identical to A2.

## References (Python, file:line)

- `conf_pipeline_control/polaris_beamformer.py:555-596` (`compose_nulls`), `:507-529` (`_acceptable_nulls`,
  `_az_sep`), `:535-539` (`DEFAULT_NULL_MIN_SEP_DEG=8`, `DEFAULT_NULL_MERGE_SEP_DEG=6`).
- TS reuse: `src/live/mvdr-solver.ts` (A1 LCMV via `computeBeamWeights` + `acceptableNulls`/`azSep`),
  `src/live/freq-domain-beam.ts` (A2 `recompute`), `src/live/engine.ts` (the DOA feed + `lastDoa`).
