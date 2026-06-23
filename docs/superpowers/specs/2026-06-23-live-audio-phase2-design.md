# Live audio — Phase 2 design (DOA + auto-steer + lock-to-seat)

**Date:** 2026-06-23
**Status:** design, approved (delegated)
**Base:** `master` with Phase 1 merged (PR #1, `0a31edc`). Branch: `feat/live-audio-phase2-doa`.
**Builds on:** Phase 1 (`docs/superpowers/specs/2026-06-23-live-audio-phase1-design.md`) — the pluggable
live core (`src/live/`: `CaptureAdapter`, `StreamingDelaySumBeam`, `LiveEngine`, `LevelMeter`,
`MockCaptureAdapter`) and the offline beamformer geometry / Complex helpers (`src/beamformer/geometry.ts`)
and the ported seat-mapper (`src/seat-mapper/`).

---

## 1. Goal & scope

Make the Phase-1 single beam **steer itself**. Phase 2 adds, all engine-side (no browser UI):

1. **Live DOA readout** — a real-time **SRP-PHAT** direction-of-arrival estimate over a 2° azimuth
   grid (band-limited 300–3800 Hz), peak-picked to detected talker bearings + a VAD "active" flag.
2. **Auto-follow** — the single fractional-delay-and-sum beam re-aims at the **dominant in-sector
   talker**, with a hold/switch machine so it does not jitter or flip between talkers.
3. **Lock-to-seat** — pin the beam to a chosen room seat's azimuth, reusing the ported seat-mapper.

**Out of scope (deferred):**
- **Simultaneous multi-talker capture + null-steering** — needs a frequency-domain LCMV beam (the
  Phase-1 beam is a *single* time-domain delay-sum with no null DOF). A later phase.
- **Elevation / range** — a planar array measures azimuth only (see §8).
- The **cleaning chain** (AEC / dereverb / noise-suppression) — a later phase.

This is one cohesive sub-project (one spec / one plan), like Phase 1.

## 2. Key technical decisions (from grounded research)

- **Pure-TS FFT, zero-dep.** DOA needs only a **forward real FFT** (`rfft`) to build the spatial
  covariance — no inverse. A compact **radix-2 Cooley–Tukey** `rfft` (1024-pt → 513 complex bins,
  **Float64**, precomputed twiddles) is correct and fast enough: ~86 transforms/s per channel at
  44.1 kHz / 512-hop is well within budget. **No new dependency** — the repo's zero-dep invariant holds.
- **Throttle DOA to the hop cadence**, not per audio sample — the FFT/covariance run on 512-sample
  hops; detection runs every K hops (~8 Hz).
- **Azimuth is fully resolved; elevation is not.** A planar z=0 ring's phase depends only on the
  in-plane projection, so it **cannot tell a source above the array plane from below** (the "front/back"
  the Python docs muddle). But **azimuth 0–360° is unambiguous**, so live continuous *azimuth*
  auto-steer is viable. Off-nadir stays fixed at **90°** (horizontal); the elevation limit is documented.
- **Wrap-aware tracking is a hold/switch machine, NOT an EMA.** EMA-ing a raw azimuth smears across the
  0/360 seam and across talker switches; instead commit to the strongest talker and switch only past a
  margin (port of the Python `_TalkerTracker`).

## 3. Architecture — new modules (all pure, zero-dep, browser-safe, under `src/live/`)

```
src/live/
  fft.ts          # Fft1024: radix-2 rfft (Float64, precomputed twiddles) + naiveDft (test ref)
  covariance.ts   # StreamingCovarianceAccumulator: FIFO → Hann frames → rfft → band-slice →
                  #   outer product xxᴴ → EMA-smoothed R(f); snapshot()
  doa.ts          # SRP-PHAT: steeringCube, phatWhiten, srpPhatMap, detect → DoaResult;
                  #   sector-gate helpers; Detection/DoaResult types (ports conf_pipeline_control/doa.py)
  tracker.ts      # TalkerTracker: wrap-aware hold/switch machine (circularSep, switchMargin, hold)
  autosteer.ts    # AutoSteerController: detections + sector/seat → one look azimuth or "hold"
  engine.ts       # EXTEND: optional auto-steer mode wiring
  types.ts        # EXTEND: AutoSteerConfig, BeamOutput additions
  index.ts        # EXTEND: export the new public surface
```

`src/live-node/`, `src/beamformer/`, `src/model/`, `src/seat-mapper/` are unchanged (consumed, not
modified). The `./live` subpath already exists; no new package export is needed.

### 3.1 `fft.ts`
`class Fft1024` with `rfft(frame: Float64Array /*len 1024*/): { re: Float64Array; im: Float64Array }`
(513 bins). Precompute twiddles + bit-reversal table in the constructor; reuse output buffers (no
hot-path allocation). `naiveDft(frame: number[])` (O(N²) reference) lives alongside for tests. Float64
throughout (phase precision at 3.8 kHz matters for the covariance).

### 3.2 `covariance.ts`
`class StreamingCovarianceAccumulator` (constructed from `geom`, `sampleRate`, optional band/EMA opts):
- A per-channel **FIFO** absorbs arbitrary engine block sizes and emits fixed **FRAME=1024 / HOP=512**
  Hann-windowed frames.
- Per hop: `rfft` each of the M active channels; slice to the **band bins** in [300, 3800] Hz
  (precomputed from `sampleRate`); form the per-bin outer product `xb·xbᴴ` → `(nBand, M, M)` Hermitian;
  **EMA**-accumulate into `R(f)` with `alpha≈0.05` (~230 ms memory).
- `accumulate(channels: Float32Array[]): void` (fed per engine block); `snapshot(): { rBand: Complex[][][]; freqs: number[] } | null` (null until warmed up ~4–8 frames); `hopsReady`/`framesSeen` for cadence; `reset()`.
- Mirrors `live.py` (`_FRAME`/`_HOP`/`_cov_alpha=0.05`, per-hop accumulation) and `doa.py`
  `covariance_from_clip` framing so offline tuning matches.

### 3.3 `doa.ts`  (port of `conf_pipeline_control/doa.py`)
- `steeringCube(positionsActive, units, freqs): Complex[][][]` — `a[f][g][m] = cexpj(2π·f/c·(p_m·u_g))`.
- `phatWhiten(rBand): Complex[][][]` — `r̂ = r/(|r|+1e-12)` per entry.
- `srpPhatMap(rBand, freqs, positionsActive, gridDeg, offNadirDeg): number[]` — `P(az)=Σ_f aᴴ R̂ a` (real).
- `detect(rBand, freqs, geom, opts): DoaResult` — slice to active capsules, build the 2° grid, SRP map →
  dB re median → VAD floor → greedy **circular** peak-pick (`maxTalkers`, `minSeparationDeg`,
  `minSalienceDb`). `Detection { azimuthDeg; salienceDb; inSector? }`,
  `DoaResult { detections; gridDeg; powerDb; active }`.
- Wrap-aware sector helpers: `circularSep`, `inSector`, `inAnySector`, `sectorGate`, `sectorGateMulti`
  (with `frontOffsetDeg`). Uses the existing Complex helpers (`cexpj/cabs/cdiv/cconj/cmul`) and
  `directionUnit` from `beam.ts`. **Defaults:** `DEFAULT_F_LO=300`, `DEFAULT_F_HI=3800`, `gridStep=2°`,
  `offNadir=90°`, `maxTalkers=3`, `minSeparation=40°`, `minSalience=3 dB`, `vadFloor=3 dB`.

### 3.4 `tracker.ts`  (port of the Python `_TalkerTracker`)
`class TalkerTracker` — a wrap-aware **hold/switch** state machine. `update(detections, opts): { azimuthDeg: number | null; held: boolean; active: boolean }`:
- Sector-gate; pick the strongest in-sector detection.
- If none held → commit to it. If held → **switch only if** `circularSep(new, held) ≥ switchMargin`
  (default **20°**); else hold the committed angle (reject jitter).
- On silence (no in-sector detection), **hold** for `holdHops` (≈0.6 s × updateHz) then release (null).
- `reset()` on mode change. **Does not EMA the angle** (see §2). Constants from `autosteer.py`/
  `polaris_beamformer.py`: `holdSeconds=0.6`, `switchMarginDeg=20`, `updateHz=8`.

### 3.5 `autosteer.ts`
`class AutoSteerController` (single-beam): given a `DoaResult`, a sector/seat constraint, and the current
look, returns the next look azimuth (or "hold"). For `mode='follow'` it follows the tracker's committed
talker; for `mode='lockSeat'` it returns the fixed seat azimuth (and still runs DOA for the readout but
ignores it for steering). Pure (no engine mutation) — returns a decision the engine applies. A small
deadband avoids redundant re-aims.

## 4. Integration with the Phase-1 `LiveEngine`

`LiveConfig` gains an optional field (default keeps Phase-1 behavior, **backward-compatible**):

```ts
type AutoSteerMode = 'manual' | 'follow' | 'lockSeat';
interface AutoSteerConfig {
  mode: AutoSteerMode;
  sector?: { centerDeg: number; halfWidthDeg: number; frontOffsetDeg?: number }; // gate detections
  // lock-to-seat needs the room + which seat:
  room?: SystemConfig;        // the config holding the room/seats + this array's bearingDeg
  arrayId?: string;
  seatId?: string;
  detectionHops?: number;     // K: run detect every K covariance hops (512 samples each).
                              //   Default chosen so detect runs ~8 Hz (≈ every 11 hops at 44.1 kHz).
  doa?: Partial<DetectOptions>;
}
// LiveConfig: + autoSteer?: AutoSteerConfig   (absent ⇒ mode 'manual' ⇒ Phase 1 unchanged)
```

`BeamOutput` gains (all optional, populated only when auto-steer is active):
```ts
  detected?: { azimuths: number[]; salienceDb: number[] } | null; // null while warming up
  doaActive?: boolean;                                            // VAD: anyone talking?
  mode?: AutoSteerMode;
  lockedTarget?: { azimuthDeg: number; seatId?: string } | null;
```

**Engine loop:** at construction, if `autoSteer && mode !== 'manual'`, build the
`StreamingCovarianceAccumulator` + `TalkerTracker` + `AutoSteerController`; if `mode==='lockSeat'`,
resolve the seat azimuth **once** via `seatAzimuthForArray(room, arrayId, seatId)` (needs the array's
`bearingDeg`; if unresolved, **fall back to `follow`** and surface it). Per block: `beam.process` + meter
as today, **plus** `cov.accumulate(channels)`; every **K** hops, `snapshot()` → `detect` → `tracker.update`
→ `autosteer` → if the decision changed the look, `beam.setLook(az)` (atomic; drops beam history). Emit the
extended `BeamOutput`. **Manual mode** runs none of this (zero overhead).

**Real-time safety:** FFT/covariance at hop cadence only; pre-allocated FFT/cov buffers; the re-aim is a
single synchronous `setLook`; warm-up suppresses detections until `R` converges; the tracker's hold/switch
prevents thrash. JS is single-threaded so no locks are needed (unlike the Python `_cov_lock`).

## 5. Data flow

```
adapter.onBlock(channels[M], sr)
  → beam.process(channels) → mono ; meter.update(mono)            (Phase 1, unchanged)
  → cov.accumulate(channels)                                       (NEW, every block)
  → every K hops: R = cov.snapshot()
        → doa.detect(R, freqs, geom) → DoaResult
        → tracker.update(detections, sector) → committed azimuth | hold | release
        → autosteer.decide(mode, committed, lockedSeatAz) → lookAz | null
        → if lookAz changed: beam.setLook(lookAz)                  (atomic re-aim)
  → emit BeamOutput { mono, rmsDb, …, detected, doaActive, mode, lockedTarget }
```

## 6. Testing (hardware-free, vitest)

- **`fft.ts`:** `rfft` vs `naiveDft` (rel-err < 1e-9 on random/impulse/chirp frames); Parseval
  (`Σ|X|² ≈ N·Σ|x|²`); single-tone → energy concentrated in its bin; (forward-only — no IFFT to test).
- **`covariance.ts`:** feed a synthetic plane wave (extend the mock to **multi-arrival**); assert each
  `R(f)` is Hermitian and that `doa.detect` on the snapshot recovers the source azimuth within ~a grid
  step; FIFO bridges odd block sizes (e.g. 300, 480) to 512-hop framing without drift.
- **`doa.ts`:** synthesize `R(f)` for a known azimuth (via `steeringCube` of a single source) → `detect`
  finds it within the beamwidth; two sources ≥40° apart are both found; `< minSeparation` apart merge to
  one; silence → `active=false`, no detections; sector gate excludes out-of-sector bearings; `circularSep`
  wraps (350°↔10° = 20°). Optionally cross-check against a Python-generated `R(f)` fixture (≤1e-6).
- **`tracker.ts`:** commits to the strongest; **does not** switch for a < `switchMargin` move; **does**
  switch past it; holds through a brief silence then releases; wrap-correct near 0/360.
- **`autosteer.ts`:** `follow` returns the dominant in-sector bearing; out-of-sector ignored; `lockSeat`
  returns the fixed seat azimuth regardless of detections; deadband suppresses tiny re-aims.
- **`engine.ts`:** with a `MockCaptureAdapter` emitting a plane wave from azimuth A, `mode:'follow'`
  re-aims the beam toward A (its `BeamOutput.detected` reports ~A and the mono reinforces); `mode:'manual'`
  leaves the beam static (DOA not run); `mode:'lockSeat'` resolves the seat azimuth via the seat-mapper and
  pins there; an unposed array (no `bearingDeg`) falls back to `follow`.

## 7. Deliverables & staged commits

1. `feat(live): pure-TS radix-2 rfft (Fft1024) + naive-DFT reference` (`fft.ts` + tests).
2. `feat(live): streaming spatial-covariance accumulator` (`covariance.ts` + tests; extend mock to multi-arrival).
3. `feat(live): SRP-PHAT DOA detector + sector gating` (`doa.ts` + tests).
4. `feat(live): wrap-aware talker hold/switch tracker` (`tracker.ts` + tests).
5. `feat(live): single-beam auto-steer controller` (`autosteer.ts` + tests).
6. `feat(live): wire auto-steer / lock-to-seat into LiveEngine` (`engine.ts`/`types.ts`/`index.ts` + tests).
7. `docs: document Phase 2 (live DOA + auto-steer)` (README/CHANGELOG/CLAUDE.md) + final gate.

## 8. Honest limits (documented in code + README)

- **Azimuth-only.** No range; off-nadir fixed at 90°. A planar ring **cannot resolve above-vs-below the
  array plane** (the in-plane phase is identical) — for a ceiling/desk array where talkers are on one
  side this is immaterial, but it is a real limit.
- **Resolution ≈ beamwidth** (~λ/aperture): two talkers closer than ~`minSeparation` (40°) merge into one
  peak.
- **Band-limited 300–3800 Hz.** Above the array's spatial-aliasing cutoff (~5.6 kHz for ~30.6 mm capsule
  spacing) the SRP map grows phantom (grating) peaks; the scan band stays below it.
- **Single-talker follow.** One beam follows the dominant talker (or a locked seat); simultaneous
  multi-talker capture is a later (frequency-domain) phase.
- **Responsiveness.** DOA EMA + hold (~0.2–0.6 s) trades onset latency for stability; a `setLook` drops
  beam history (~ms gap) on re-aim — fine for voice.

## 9. Risks / unknowns to validate during build

- `rfft` correctness — guarded by the naive-DFT/Parseval/tone tests (the radix-2 bit-reversal + the
  real-from-complex recombination are the classic bug sites).
- The `einsum`→explicit-loop translation in SRP-PHAT (dimension order `f,i,j` / `f,g,m`) — guarded by the
  single-source recovery test.
- FIFO/hop framing drift across odd block sizes — guarded by the covariance framing test.
- Real-time budget on the actual device (FFT per hop × 8 ch) — validated live; throttle `detectionHops`
  if needed.
- Lock-to-seat needs the array `bearingDeg` set (Phase-1/`setArrayBearing`); fall back to `follow` if absent.

## 10. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; all DOA/auto-steer tests pass **hardware-free**;
  `dependencies` stays `{}` (pure-TS FFT, no new dep).
- `mode:'follow'` re-aims the beam at a synthetic source and reports its bearing; `mode:'manual'` is
  byte-identical to Phase-1 behavior; `mode:'lockSeat'` pins via the seat-mapper.
- On the real POLARIS (manual validation, not CI): the beam follows a moving talker without audible
  thrash, and lock-to-seat holds a chosen seat.

## References (research, file:line)

- DOA: `conf_pipeline_control/doa.py:34–35,62–216` (SRP-PHAT, peak-pick, sector gates, defaults).
- Live covariance: `conf_pipeline_control/live.py:55–56,172,452–459,588–597` (`_FRAME/_HOP`, `_cov_alpha`,
  per-hop accumulation, snapshot).
- Tracking / auto-steer: `conf_pipeline_control/tracking.py:1–132`, `autosteer.py:58–186,281–357`,
  `polaris_beamformer.py:80–81,182–240` (hold/switch, hysteresis constants).
- Phase-1 seam: `src/live/engine.ts`, `src/live/types.ts`, `src/live/beam.ts` (`directionUnit`,
  `steerRealDelays`, `setLook`), `src/beamformer/geometry.ts` (Complex, `ArrayGeometry`),
  `src/seat-mapper/seat-mapper.ts` (`seatAzimuthForArray`, `nearestSeatForArray`).
