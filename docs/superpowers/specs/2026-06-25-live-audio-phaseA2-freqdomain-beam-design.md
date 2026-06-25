# Live audio — Phase A2 design (FreqDomainBeam runtime + opt-in beam mode)

**Date:** 2026-06-25
**Status:** design, approved (user delegated the open choices to me).
**Branch:** `feat/live-audio-phaseA-nullsteering` (continues after A1 `3575932`).
**Builds on:** A1 `computeBeamWeights` (`src/live/mvdr-solver.ts`), the existing `FftRadix2`, the beam/engine seam.

---

## 1. Goal & scope

Port the Python `_FreqDomainBeam` STFT runtime (`polaris_beamformer.py:602-783`) to TypeScript and wire it
into `LiveEngine` as an **opt-in beam mode**, default-off byte-identical. A2 delivers a working
**superdirective** (diffuse-noise MVDR) frequency-domain beam that rejects isotropic room noise far better
than the delay-sum beam, steered via `setLook`. **In scope:** the STFT/MAC runtime, the weight-recompute on
re-steer, the `LiveBeam` interface, the opt-in `LiveConfig.beam` wiring. **Out of scope:** explicit nulls +
the null-budget arbiter (A3), the data-adaptive **measured-R** MVDR wiring of the live covariance (A3 — A2 is
analytic Γ superdirective only), multi-beam (A4/A5).

## 2. Architecture

### 2.1 `LiveBeam` interface (new, in `beam.ts` or `types.ts`)
Both beams implement it so the engine treats them interchangeably:
```ts
export interface LiveBeam {
  setLook(azimuthDeg: number, offNadirDeg?: number): void;
  process(channels: Float32Array[]): Float32Array;   // per-channel in, mono out
  reset(): void;
}
```
`StreamingDelaySumBeam` already has `setLook`/`process`; A2 adds `reset()` to it (drop any history — it is
near-stateless, so `reset` is a no-op or clears its small state) and declares it `implements LiveBeam`.

### 2.2 `freq-domain-beam.ts` (new) — `FreqDomainBeam implements LiveBeam`
A windowed overlap-add STFT with one complex weight vector `W(f)` per rfft bin (the **superdirective**
solution from A1). Port of `_FreqDomainBeam`.
- **Constructor** `(geom: ArrayGeometry, sampleRate: number, opts?: { frame?: number; loading?: number; offNadirDeg?: number })`
  — `frame` default `FREQ_BEAM_FRAME = 1024`, `hop = frame/2 = 512`, symmetric Hann window
  (`w[i] = 0.5·(1 − cos(2πi/(F−1)))`, matching `np.hanning`), 50 % overlap (near-COLA). `loading` default
  `DEFAULT_SUPERDIRECTIVE_LOADING` (from A1). Pre-allocates: per-channel sliding input frame buffers
  (`F×M`), an overlap-add accumulator (`F`), an input FIFO and an output FIFO (the output FIFO primed with
  `F` zeros = framing latency), the rfft frequencies (`rfftfreq(F, 1/sr)`), an `FftRadix2(F)`, and the
  weight table `W` (initialised to the look at 0°).
- **`setLook(az, offNadir?)`** — store the look; **recompute** the weight table via A1:
  `W = computeBeamWeights(geom, freqsHz, bearingDirection(az, offNadir), [], { loading })`. This is the
  "plan + commit" of the Python — but in single-threaded JS `setLook` and `process` run **sequentially on
  one thread**, so the publish is trivially atomic (no lock, no race). The solve (~a few ms over 513 bins)
  runs only when the look **changes** (a no-op guard skips recompute if az/offNadir are unchanged), and
  re-steers are infrequent (the autosteer is throttled to `detectionHops` and only fires on real movement),
  so the amortised cost on the block path is small. (A future optimisation: offload the solve to a Worker;
  out of A2 scope — documented.)
- **`process(channels)`** — the MAC runtime (port of `_FreqDomainBeam.process`): append the block to the
  input FIFO; while ≥ `hop` samples are buffered, slide each channel's frame left by `hop` and append the
  new hop, window + `rfft` each channel, compute `Y[k] = Σ_m conj(W[k][m])·X_m[k]` (pure MAC — no solve),
  `irfftInto` to a frame, overlap-add, push `hop` samples to the output FIFO. Return `n` samples from the
  output FIFO (front-padded with zeros on the startup underflow). Round-trip latency ≈ `F + H` (~35 ms at
  44.1 kHz).
- **`reset()`** — drop the streaming history (input/output FIFOs, frames, OLA) but keep `W`.
- Float64 internal STFT math; the output mono is `Float32Array` (matching the delay-sum beam).
- Constants exported: `FREQ_BEAM_FRAME = 1024`.

### 2.3 `engine.ts` / `types.ts` / `index.ts` (modify) — opt-in wiring
- `types.ts`: `LiveConfig.beam?: 'delaySum' | 'freqDomain'` (default `delaySum`).
- `engine.ts`: `private readonly beam: LiveBeam;` — built in the constructor: `config.beam === 'freqDomain'`
  ⇒ `new FreqDomainBeam(config.geom, sr, { loading?, offNadirDeg: this._offNadirDeg })`, else the current
  `new StreamingDelaySumBeam(...)`. `setLook`/`process` calls are unchanged (the interface). No `BeamOutput`
  field change — the mono is the same shape; A2 keeps the meter/telemetry identical.
- `index.ts`: export `FreqDomainBeam`, `FREQ_BEAM_FRAME`, `type LiveBeam`.
- **Byte-identical-when-off:** `config.beam` absent or `'delaySum'` ⇒ the existing `StreamingDelaySumBeam`
  path, untouched. Every existing engine test stays green (the new `reset()` on the delay-sum beam is
  additive and unused by the default path).

## 3. Data flow

```
channels(8×n) ─▶ beam.process ─▶ mono(n) ─▶ [AEC] ─▶ cleaner ─▶ PEQ ─▶ AGC ─▶ band-limit ─▶ voice-gate ─▶ meter
  beam = freqDomain: STFT(1024/512) → per-bin MAC Y=Σ conj(W)·X → irfft → OLA → FIFO   (W from A1, recomputed on setLook)
  beam = delaySum (default): unchanged time-domain fractional-delay-and-sum
```

## 4. Real-time safety / performance

- **Single-threaded model:** `setLook` (control + the autosteer call inside `onBlock`) and `process` are
  sequential on one thread — the weight publish is atomic for free; no lock. The heavy solve happens on
  `setLook` only when the look changes (infrequent); `process` is pure MAC + FFT (bounded, no solve).
- **Allocation:** the STFT buffers, FFT, and weight table are pre-allocated in the constructor; `process`
  reuses them (the per-hop `rfft` returns the FFT's reused buffers — snapshot per channel as the Python
  does). One output `Float32Array` per call (block convention). The recompute on `setLook` allocates a fresh
  `W` (off the per-block path).
- **Latency:** ~35 ms when `freqDomain` is active; **zero** when off (delay-sum unchanged). Documented.
- A2's spec will **benchmark** the per-re-steer solve (`computeBeamWeights` over 513 bins) in a test to
  confirm it is within a few ms (well under a re-steer interval), and the per-block MAC to confirm it is
  cheap.

## 5. Testing (hardware-free, vitest)

- **`freq-domain-beam.ts`:** a **plane-wave at the look azimuth** (synthetic 8-channel block via the same
  helper the delay-sum tests use) is reconstructed at the output with ~unity gain and low distortion
  (steady-state RMS ≈ source, after the ~35 ms latency); a plane-wave at a **different azimuth** comes out
  **attenuated** (directivity); **off-axis diffuse-ish rejection beats delay-sum** (compare the superdirective
  beam's off-axis response to the delay-sum beam's at a mid-band tone — superdirective is tighter);
  **block-size adaptation** — feeding arbitrary block sizes (e.g. 200, 512, 1000) yields the same total
  output as one big block (FIFO correctness); **`setLook` re-steers** (output follows a moved source);
  **`reset()`** clears history (re-feeding reproduces a fresh run); **latency** ≈ `F + H` samples of
  front-padding at startup; the per-re-steer solve completes quickly (timed, generous bound) and `process`
  output is finite over a long run.
- **`engine.ts`:** `beam: 'freqDomain'` ⇒ the engine runs without throwing and emits mono toward a synthetic
  source (the beam steers); `beam` absent / `'delaySum'` ⇒ **byte-identical** (existing engine tests pass);
  the emitted `BeamOutput` shape is unchanged.

## 6. Deliverables & staged commits

1. `feat(live): LiveBeam interface; StreamingDelaySumBeam implements it (+ reset)` (beam.ts/types.ts).
2. `feat(live): FreqDomainBeam STFT superdirective runtime` (`freq-domain-beam.ts` + tests).
3. `feat(live): opt-in freqDomain beam mode in LiveEngine` (`engine.ts`/`types.ts`/`index.ts` + tests).

## 7. Honest limits (documented)

- A2 is **superdirective only** (analytic diffuse-Γ) — no explicit nulls (A3) and no data-adaptive measured-R
  MVDR wiring yet (A3 wires the live `StreamingCovarianceAccumulator.snapshot()` as the noise provider).
- Adds ~35 ms latency when active. The per-re-steer weight solve runs **synchronously** on the block thread
  (bounded, infrequent); a Worker offload is a future optimisation.
- Azimuth/off-nadir steering only (a planar ring can't resolve elevation), same as the delay-sum beam.
- Single beam (multi-talker is A4/A5).

## 8. Risks / unknowns to validate during build

- **STFT COLA reconstruction:** the Hann-1024/512 overlap-add must reconstruct a pass-through (unity W)
  near-exactly — guarded by a round-trip test (feed identity-steered weights, expect the windowed source
  back within ripple tolerance).
- **rfft buffer reuse:** `FftRadix2.rfft` returns reused buffers — each channel's spectrum must be snapshotted
  before the next channel's `rfft` (port the Python's per-channel handling). Guarded by the multichannel
  reconstruction test.
- **FIFO block-size adaptation:** arbitrary in/out block sizes must not drop or duplicate samples — guarded
  by the block-size test.
- **Re-steer no-op guard + cost:** unchanged look must NOT recompute (guarded by a test) and the recompute
  cost is benchmarked.
- **Default-off byte-identical:** the `LiveBeam` interface + the new `reset()` on the delay-sum beam must not
  change the default path — guarded by the existing engine suite.

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; `dependencies` stays `{}`.
- The freq-domain beam reconstructs an on-look source, attenuates off-look, beats delay-sum off-axis, adapts
  block sizes, re-steers, and is byte-identical when off.

## References (Python / TS, file:line)

- `conf_pipeline_control/polaris_beamformer.py:602-783` (`_FreqDomainBeam` — STFT 1024/512 Hann, `process`
  MAC/OLA/FIFO, `plan_look`/`commit_look`, latency).
- TS reuse: `src/live/mvdr-solver.ts` (A1 `computeBeamWeights`), `src/live/fft.ts` (`FftRadix2`
  `rfft`/`irfftInto`), `src/live/beam.ts` (`StreamingDelaySumBeam` interface to match), `src/live/engine.ts`
  (the beam seam), `src/beamformer/beamformer.ts` (`bearingDirection`).
