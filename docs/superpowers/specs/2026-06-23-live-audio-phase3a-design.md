# Live audio — Phase 3a design (post-beam noise suppression)

**Date:** 2026-06-23
**Status:** design, approved (delegated)
**Base:** `feat/live-audio-phase2-doa` (`e1c2d18`). Branch: `feat/live-audio-phase3a-nr`.
**Builds on:** Phase 1 (live core), Phase 2 (DOA/auto-steer + the pure-TS `FftRadix2` forward FFT and the
streaming-FIFO pattern in `covariance.ts`).

---

## 1. Goal & scope (and the Phase-3 decomposition)

Phase 3 is the **cleaning chain** — the largest part of the Python live layer. It is too big for one
spec, so it decomposes into sub-phases. **This spec is the first: Phase 3a, post-beam noise suppression**
— the "suppress steady fans/AC" feature, which also builds the **streaming STFT spectral-processor
framework** that the rest of the chain reuses.

| Sub-phase | Content | Dep |
|---|---|---|
| **3a (this spec)** | `irfft` + STFT overlap-add base + min-statistics noise floor + **gate/OM-LSA/Wiener** denoisers + **level-preserving makeup**, opt-in post-beam | **zero-dep** |
| 3b | dereverb (same STFT base, different gain law) | zero-dep |
| 3c | AEC (partitioned-block NLMS + far-end reference) | zero-dep |
| 3d | level/tone: AGC, PEQ (pure-TS biquad), band-limit, voice-gate | zero-dep |
| later/optional | DeepFilterNet3 (needs ONNX) — an optional peer-dep behind a subpath, like `naudiodon2` | dep |

The pure-DSP denoisers (gate/OM-LSA/Wiener) are pure-numpy in Python → **cleanly portable to zero-dep TS**.
The Python memory shows **OM-LSA alone hits −21.7 dB** on steady noise (vs −5.5 dB for the light gate), so
DFN3/ONNX is **not needed** for the fan-killer; the zero-dep core is the proven path.

**3a scope:** noise suppression on the beamformed mono only. **Out of scope (later sub-phases):** dereverb,
AEC, AGC/PEQ/band-limit/voice-gate, DFN3.

## 2. Architecture — new/changed modules (all pure, zero-dep, browser-safe, under `src/live/`)

### 2.1 `fft.ts` (modify) — add `irfft`
Add an inverse real FFT reusing the Phase-2 forward `FftRadix2`. Algorithm (port of the standard approach):
given the `n/2+1` half-spectrum `X`, (a) rebuild the conjugate-symmetric full spectrum
`Y` (`Y[0]=X[0]`, `Y[k]=X[k]` for `1..n/2`, `Y[n−k]=conj(X[k])` for `1..n/2−1`); (b) the inverse DFT equals
`conj(FFT(conj(Y)))/n`. Expose `irfft(re: Float64Array, im: Float64Array): Float64Array` (length `n`) on
`FftRadix2`, reusing the existing complex butterfly (add a private full-complex forward pass, or reuse the
forward path on the conjugated spectrum). Validated by `rfft→irfft` round-trip (≤1e-9) and known
spectrum→signal.

### 2.2 `spectral-processor.ts` (new) — the STFT base + minimum-statistics gate
`class StreamingSpectralProcessor` — Hann **FRAME=512 / HOP=256** (50% overlap, COLA), a per-channel FIFO
bridging arbitrary engine block sizes to fixed hops (the `covariance.ts` pattern), `rfft → per-bin gain →
irfft → overlap-add`. State + behavior ported from the Python `_PostNoiseSuppressor`:
- **Minimum-statistics noise floor** (default, VAD-independent): per-bin smoothed power `P_s` (EMA
  `power_alpha=0.8`, seeded to `P` on the first frame); a sliding minimum over `minstat_sub=8`
  sub-windows × `minstat_sublen=16` frames (≈ 0.7 s); `p_min = min(current submin, min over the buffer)`;
  `noise_mag = sqrt(minstat_bias · p_min)` with `minstat_bias=1.5`.
- **Gate/Wiener gain** (the base law): `wiener = P/(P + oversub·noise_mag² + 1e-20)` (`oversub=1.5`);
  `g = g_floor + (1−g_floor)·wiener`, `g_floor = 10^(floor_db/20)` (`floor_db=−15` → ≈0.178); 3-tap
  frequency smooth (`0.25,0.5,0.25`, DC/Nyquist pass through) + one-pole temporal smooth (`gain_alpha=0.5`).
- **Warmup-passthrough:** until `total_frames ≥ warmup_frames` (16), `process` returns the input block
  **byte-identical** (no STFT) — and likewise a **bit-exact passthrough when disabled** (return the SAME
  array object). One ~one-frame seam at engagement (inaudible during noise).
- **`amount`** (0..1) blends the gain toward unity for gentler cleaning (Light/Medium/Full).
- Contract: `process(block: Float32Array, noiseGate: boolean): Float32Array`, `reset(): void`. A pluggable
  per-bin `gain(...)` hook lets subclasses swap the law. JS is single-threaded — no lock needed (unlike
  the Python `_lock`).

Constants exported: `NR_FRAME=512`, `NR_HOP=256`, `NR_FLOOR_DB=-15`, `NR_OVERSUB=1.5`, `NR_GAIN_ALPHA=0.5`,
`NR_WARMUP_FRAMES=16`, `NR_POWER_ALPHA=0.8`, `NR_MINSTAT_SUB=8`, `NR_MINSTAT_SUBLEN=16`, `NR_MINSTAT_BIAS=1.5`.

### 2.3 `omlsa.ts` (new) — OM-LSA / Wiener gain laws (the deep cut)
`class OmlsaProcessor extends StreamingSpectralProcessor`, overriding only the per-bin gain (and adding a
`_prevClean` state). Port of the Python `StreamingCleaner._gain` (pure-numpy, no scipy):
- **Decision-directed a-priori SNR** (Ephraim–Malah, `alpha=0.985`): `ξ = α·prevClean/noise² + (1−α)·gpost`,
  `gpost = max(γ−1, 0)`, `γ = P/noise²`; clamp `ξ ≥ ξ_floor = 10^(gmin_db/10)` (`gmin_db=−18`).
- **Decision-directed Wiener** `g_w = ξ/(1+ξ)`; `prevClean = (g_w·|X|)²` carried to the next frame.
- **OM-LSA** (`omlsa` mode): `ν = clip(g_w·γ, 1e-3, 500)`; `g_h1 = min(g_w·exp(0.5·E1(ν)), 1.0)`;
  speech-presence `spp = γ/(γ + γ_thresh)` (`γ_thresh=2.0`); final `g = g_h1^spp · g_floor^(1−spp)`.
- **`wiener` mode:** `g = max(g_w, g_floor)` (cheaper, no E1). **`gate` mode:** delegate to the base law.
- **`expE1(x)`** — the exponential integral E1 via Abramowitz–Stegun (vendored, no scipy): for `x ≤ 1`,
  `−ln x + Σ a_k x^k` (coeffs `−0.57721566, 0.99999193, −0.24991055, 0.05519968, −0.00976004, 0.00107857`);
  for `x > 1`, `e^{−x}/x · (x²+2.334733x+0.250621)/(x²+3.330657x+1.681534)`.
- Then the same 3-tap frequency + one-pole temporal smoothing as the base.

### 2.4 `exponential-tracker.ts` (new) — one-pole EMA
`class ExponentialTracker(alpha)` — `update(x): number` returns `y = α·x + (1−α)·y` (seeded on first call);
`reset()`. Used by the makeup/limiter. Pure, ~15 lines.

### 2.5 `level-preserving-cleaner.ts` (new) — speech-gated makeup (the "voice stays full" fix)
`class LevelPreservingCleaner` wraps any `StreamingSpectralProcessor` (same `process`/`reset` contract).
Every denoiser cuts the talker ~5–7 dB; this restores it **SNR-neutrally** (noise and speech scale
together, so matching the post-clean speech level preserves SNR). Port of the Python
`_LevelPreservingCleaner`:
- On **speech frames** (`noiseGate=false` AND input RMS > silence floor `−55 dB`): track input RMS and
  cleaned-output RMS via slow EMAs (`α=0.05`), target makeup `= clip(rmsIn/rmsOut, 1.0, 8 dB)`; otherwise
  **hold** the target (no ramp-up on silence). Slew the applied gain toward target (`α=0.08`, no pumping).
- **Peak limiter:** instant attack / slow release (`α=0.05`), ceiling **−1 dB** (≈0.891), so makeup never
  clips. **Boost-only** (never attenuates).
- Error-resilient: if the inner cleaner throws, return the raw block (never silence); if the makeup math
  throws, return the cleaned block.
- Constants: `MAKEUP_MAX_GAIN_DB=8`, `MAKEUP_LEVEL_ALPHA=0.05`, `MAKEUP_SLEW_ALPHA=0.08`, `CEILING_DB=−1`,
  `LIMIT_RELEASE_ALPHA=0.05`, `SILENCE_DB=−55`.

### 2.6 `engine.ts` / `types.ts` / `index.ts` (modify) — opt-in wiring
- `LiveConfig.cleaning?: { engine: 'off'|'gate'|'omlsa'|'wiener'; strength?: number; preserveLevel?: boolean }`
  — default **absent/`off`** ⇒ **byte-identical to Phase 2** (no cleaner built, `onBlock` skips the stage).
  `strength` ∈ 0..1 → the cleaner `amount`. `preserveLevel` wraps the cleaner in `LevelPreservingCleaner`.
- In `onBlock`, **after** `beam.process(channels) → mono` (and the Phase-2 auto-steer step) and **before**
  `meter.update(mono)`, run `mono = cleaner.process(mono, noiseGate)` when a cleaner exists. `noiseGate`
  comes from the Phase-2 `doaActive` (active ⇒ speech ⇒ `noiseGate=false`) when auto-steer is on, else
  `false` (treat as speech — conservative; the min-stat floor is VAD-independent anyway).
- `BeamOutput.cleaning?: { engine: string; preserved: boolean }` surfaces the active stage.

## 3. Data flow

```
adapter.onBlock(channels, sr)
  → beam.process(channels) → mono            (Phase 1)
  → [Phase-2 auto-steer covariance/DOA/setLook]
  → if (cleaner) mono = cleaner.process(mono, noiseGate)   (NEW — Phase 3a)
  → meter.update(mono)                       (now reflects the cleaned signal)
  → emit BeamOutput { …, cleaning?: { engine, preserved } }
```

## 4. Real-time safety

Pre-allocated FFT/STFT/min-stat buffers (no hot-path allocation); the STFT runs at the hop cadence;
bit-exact passthrough when off (same array object) and during warmup; single-threaded (no locks). The
makeup limiter prevents clipping. The min-stat floor learns continuously (no VAD dependency).

## 5. Testing (hardware-free, vitest)

- **`fft.ts` `irfft`:** `rfft→irfft` round-trips a random/impulse/chirp frame to ≤1e-9; a known spectrum
  (DC, single bin, Nyquist) → the known time signal.
- **`spectral-processor.ts`:** Hann 50%-overlap **COLA** reconstructs unity gain; **off / warmup** return
  the SAME input object (bit-exact); a **steady-noise** input (white/again-and-again) is **attenuated**
  after warmup while a **clean tone** passes largely intact (RMS-reduction on noise ≫ on the tone); the
  FIFO bridges odd block sizes (300, 480) to the same result as 256-hop blocks; `reset()` clears state.
- **`omlsa.ts`:** `expE1` matches reference values (e.g. E1(1)≈0.2194, E1(0.5)≈0.5598) within tolerance;
  the OM-LSA gain ∈ [g_floor, 1]; on a noisy signal OM-LSA reduces noise RMS **more than** the gate.
- **`exponential-tracker.ts`:** converges to a constant input; first-call seed.
- **`level-preserving-cleaner.ts`:** a synthetic −6 dB cleaner → ~+6 dB makeup (capped at 8); a lossless
  (unity) cleaner → ~no-op; silence input → no makeup ramp; the limiter caps output at the ceiling;
  a throwing inner cleaner → raw passthrough (no exception escapes).
- **`engine.ts`:** with a `MockCaptureAdapter` emitting beam + added steady noise, `cleaning:'omlsa'`
  yields a lower steady-noise RMS than `cleaning:'off'`; **`cleaning` absent/`'off'` is byte-identical** to
  Phase 2 (the mono is the SAME object the beam produced); `preserveLevel:true` restores level.

## 6. Deliverables & staged commits

1. `feat(live): inverse real FFT (irfft) on FftRadix2` (`fft.ts` + tests).
2. `feat(live): streaming STFT spectral processor + minimum-statistics noise gate` (`spectral-processor.ts` + tests).
3. `feat(live): OM-LSA / Wiener denoiser gain laws + expE1` (`omlsa.ts` + tests).
4. `feat(live): one-pole ExponentialTracker` (`exponential-tracker.ts` + tests).
5. `feat(live): level-preserving makeup cleaner` (`level-preserving-cleaner.ts` + tests).
6. `feat(live): wire opt-in post-beam noise suppression into LiveEngine` (`engine.ts`/`types.ts`/`index.ts` + tests).
7. `docs: document Phase 3a (post-beam noise suppression)` (README/CHANGELOG/CLAUDE.md) + final gate.

## 7. Honest limits (documented)

- Adds **~12 ms** STFT latency (512/256 @ 44.1 kHz) when a cleaner is active; **none** when off.
- The min-statistics floor needs **~0.7 s** to learn; until `warmup_frames` (16) the output is bit-exact
  passthrough (no premature suppression).
- The makeup gain is **boost-only**, **≤8 dB**, and speech-gated (held on silence) to avoid pumping the
  noise floor; it restores loudness, not SNR (denoisers cut noise and speech together).
- Single-talker, single-channel post-beam NR (not a substitute for AEC/dereverb — later sub-phases).

## 8. Risks / unknowns to validate during build

- `irfft` sign/conjugation (the classic bug) — guarded by the round-trip test.
- Hann **COLA** requires even FRAME + exactly 50% hop — guarded by the COLA test.
- The OM-LSA `expE1` branch at `x=1` and the `ν` clamp (E1 explodes as ν→0) — guarded by the E1 + gain-range tests.
- The min-stat cold-start (seed `P_s=P` on the first frame; `_minbuf` starts at +∞) — guarded by the warmup/attenuation tests.
- Makeup overshoot with latency — capped at 8 dB + the −1 dB limiter (per the Python tuning).

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; all NR tests pass **hardware-free**; `dependencies`
  stays `{}` (the denoisers + makeup are pure DSP).
- `cleaning:'omlsa'` measurably reduces steady-noise RMS; `cleaning` absent is **byte-identical** to Phase 2.
- On the real POLARIS (manual, not CI): a steady fan/AC is audibly suppressed while the talker stays full.

## References (research, file:line)

- STFT base + min-stat: `polaris_beamformer.py:108–141,779–939` (`_PostNoiseSuppressor`, constants, floor,
  Wiener gate, warmup).
- OM-LSA gain law: `streaming_cleaner.py:59–64,67–90,127–179` (defaults, `_exp1`, `_gain` omlsa/wiener/gate).
- Level-preserve: `polaris_beamformer.py:128–141,942–1029` (`_LevelPreservingCleaner`, makeup + limiter).
- Engine seam: `src/live/engine.ts`, `src/live/types.ts`, `src/live/meter.ts` (Phase-1/2 onBlock flow);
  Phase-2 `src/live/fft.ts` (`FftRadix2`) + `src/live/covariance.ts` (the FIFO pattern).
