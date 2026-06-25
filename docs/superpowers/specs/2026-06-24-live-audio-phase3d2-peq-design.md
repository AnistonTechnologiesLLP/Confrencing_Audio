# Live audio — Phase 3d-2 design (parametric EQ)

**Date:** 2026-06-24
**Status:** design, approved (part of the approved Phase-3d decomposition)
**Base:** continues `feat/live-audio-phase3d1-agc` (`7dc3924`, stacked on 3c/3d-1). Same branch (3d builds push together).
**Builds on:** the existing shared `PeqBand` model, the engine onBlock seam.

---

## 1. Goal & scope

Second Phase-3d sub-phase: a **parametric EQ** (tone shaping) on the cleaned mono. It runs **after** the cleaner
and **before** the AGC (`cleaner → PEQ → AGC → meter`), matching the Python order so the AGC then levels the
shaped tone. Port of the Python `StreamingPeq` (`peq.py`) — a cascade of RBJ Audio-EQ-Cookbook biquads. The
Python uses scipy `sosfilt` for the recursion; the **zero-dep TS port hand-rolls both the RBJ coefficient math
and a Direct-Form-II-transposed biquad recursion**. **In scope:** PEQ only. **Out of scope:** band-limit +
voice-gate (3d-3).

## 2. Architecture — new/changed modules (pure, zero-dep, browser-safe, under `src/live/`)

### 2.1 `peq.ts` (new) — `StreamingPeq`
A cascade of up to `PEQ_MAX_BANDS` (4) second-order sections, one per enabled band. Reuses the existing shared
**`PeqBand`** / **`PeqBandType`** types from `src/model/dsp-blocks.ts` (type-only import — schema-parity for free,
byte-identical to the Python band shape). Port of `peq.py`.
- **Band types** (`PeqBandType`): `bell` | `lowShelf` | `highShelf` | `highpass` | `lowpass`.
- **RBJ coefficient design** (`peq.py:35-75`, pure math, no scipy): per band with `w0 = 2π·f0/fs`, `cw = cos w0`,
  `sw = sin w0`, `alpha = sw/(2q)`, and `A = 10^(gainDb/40)` for bell/shelf:
  - **bell:** `b0=1+alpha·A, b1=−2cw, b2=1−alpha·A; a0=1+alpha/A, a1=−2cw, a2=1−alpha/A`.
  - **lowShelf:** `sq=2√A·alpha, ap1=A+1, am1=A−1; b0=A(ap1−am1·cw+sq), b1=2A(am1−ap1·cw), b2=A(ap1−am1·cw−sq);
    a0=ap1+am1·cw+sq, a1=−2(am1+ap1·cw), a2=ap1+am1·cw−sq`.
  - **highShelf:** `sq=2√A·alpha, ap1=A+1, am1=A−1; b0=A(ap1+am1·cw+sq), b1=−2A(am1+ap1·cw), b2=A(ap1+am1·cw−sq);
    a0=ap1−am1·cw+sq, a1=2(am1−ap1·cw), a2=ap1−am1·cw−sq`.
  - **highpass:** `b0=(1+cw)/2, b1=−(1+cw), b2=(1+cw)/2; a0=1+alpha, a1=−2cw, a2=1−alpha`.
  - **lowpass:** `b0=(1−cw)/2, b1=1−cw, b2=(1−cw)/2; a0=1+alpha, a1=−2cw, a2=1−alpha`.
  - **normalize:** every coefficient ÷ `a0` → a section `{ b0, b1, b2, a1, a2 }` (with `a0=1`).
- **No-op guards** (skip the band, no section): `f0` outside `(0, 0.4995·fs)` or `q ≤ 0` (peq.py:38); a bell/shelf
  with `|gainDb| < 1e-6` is identity → skip (peq.py:40-41); `highpass`/`lowpass` are never skipped on gain.
- **Recursion** — **Direct-Form-II transposed** per section (matches scipy `sosfilt`'s state form), Float64 state
  `[s1, s2]` per section, processed in cascade (each section's output feeds the next): for each sample `x`:
  `y = b0·x + s1; s1 = b1·x − a1·y + s2; s2 = b2·x − a2·y; x ← y`. **Denormal flush:** after each sample, if
  `|s1| < 1e-25` set `s1 = 0` (same for `s2`).
- **State preservation:** `setBands` rebuilds the sections; when the new enabled-section **count equals** the old,
  keep the existing `[s1,s2]` state (no click on a live re-tune); otherwise allocate fresh zero state.
- **Bit-exact passthrough when off:** when there are **no enabled sections**, `process` returns the SAME input
  array object (no copy) — so the suite stays byte-identical.
- Contract: `constructor(sampleRate: number, bands?: readonly PeqBand[])`; `setBands(bands?: readonly PeqBand[]): void`;
  `process(block: Float32Array, noiseGate?: boolean): Float32Array` (the `noiseGate` arg is accepted-and-ignored
  so the signature is uniform; the EQ is not VAD-driven); `reset(): void` (zero the section state).
- Constants exported: `PEQ_DENORMAL_FLOOR = 1e-25`. (`PEQ_MAX_BANDS`/`PEQ_BAND_TYPES` are reused from the model.)

### 2.2 `engine.ts` / `types.ts` / `index.ts` (modify) — opt-in wiring
- `types.ts`: `interface PeqConfig { bands: PeqBand[] }` (import `PeqBand` type from `../model/dsp-blocks.js`);
  `LiveConfig` gains `peq?: PeqConfig`. (No `BeamOutput` field — PEQ is a linear filter with no scalar telemetry.)
- `engine.ts`: a private `peq: StreamingPeq | null = null`; built in the constructor when `config.peq` is set with
  ≥1 band (`new StreamingPeq(sr, config.peq.bands)`). In `onBlock`, **after** the cleaner stage and **before**
  the AGC stage: `if (this.peq) mono = this.peq.process(mono);`.
- `index.ts`: export `StreamingPeq`, `PEQ_DENORMAL_FLOOR`, and re-export the `PeqBand`/`PeqBandType`/`PeqConfig`
  types for live consumers.
- **Byte-identical-when-off** at config level: no `LiveConfig.peq` (or no enabled bands) ⇒ `this.peq` null (or the
  PEQ returns the same object) ⇒ `mono` untouched ⇒ no new `BeamOutput` field. Existing engine-shape tests stay green.

## 3. Data flow

```
… → beam → [AEC] → cleaner(dereverb→denoise) → if (peq) mono = peq.process(mono) → if (agc) mono = agc.process(mono) → meter → emit
```

## 4. Real-time safety

Coefficients + per-section `[s1,s2]` state pre-allocated in `setBands`; `process` allocates one output
`Float32Array` (cleaning-chain convention) and reuses the section state — no other hot-path allocation. **Float64**
for the coefficient + state math (the Python uses float64 explicitly to avoid cancellation at low `f/fs`, e.g. a
50 Hz bell at 44.1 kHz). Single-threaded (the Python's atomic `sections` rebind is for its lock; JS doesn't need
it, but `setBands` still replaces the whole sections array reference). Denormal flush guards against subnormal
stall.

## 5. Testing (hardware-free, vitest)

- **`peq.ts`:** a **+12 dB bell at 1 kHz (Q 1)** applied to a 1 kHz sine **boosts** its RMS by ~+12 dB while a
  far-off-frequency sine (e.g. 100 Hz) is ~unchanged; a **lowpass at 500 Hz** strongly attenuates a 4 kHz sine
  and passes a 100 Hz sine; a **highpass at 500 Hz** does the opposite; **no enabled bands** ⇒ `process` returns
  the SAME object (bit-exact passthrough), and a 0 dB bell is skipped (identity); the coefficient math matches a
  hand-computed RBJ section for a known `(type,f0,gainDb,q,fs)`; `setBands` with the same count preserves state
  (no discontinuity), a different count resets it; `reset()` zeros the state (re-feeding reproduces a fresh run);
  an `f0` above Nyquist or `q≤0` is skipped; the filter output is finite (no NaN/denormal stall) over a long run.
- **`engine.ts`:** `peq:{ bands:[+6dB bell @1k] }` ⇒ the emitted mono is shaped (its level changes vs no-PEQ) and
  runs without throwing; `peq` absent ⇒ the `BeamOutput` shape is unchanged (existing Phase-3a/b/c/3d-1 tests pass);
  PEQ runs **before** the AGC (so the AGC levels the EQ'd tone) — verify the stage order in the wiring.

## 6. Deliverables & staged commits

1. `feat(live): parametric EQ (RBJ biquad cascade)` (`peq.ts` + tests).
2. `feat(live): wire opt-in PEQ into LiveEngine (before the AGC)` (`engine.ts`/`types.ts`/`index.ts` + tests).
3. `docs: document Phase 3d-2 (parametric EQ)` (README/CHANGELOG/CLAUDE.md) — folded into the final 3d docs at PR time.

## 7. Honest limits (documented)

- Up to 4 bands (matching the config schema). Exact IIR (not an STFT spectral multiply) — chosen because a high-Q
  notch's long impulse response would alias across STFT frames.
- Float64 internal math; the output is Float32. No look-ahead / linear-phase option (minimum-phase IIR — there's
  a small phase shift, as with any biquad EQ).
- Adds no latency itself (sample-by-sample IIR).

## 8. Risks / unknowns to validate during build

- The RBJ coefficient signs (especially the shelves) and the `/40` (not `/20`) in `A = 10^(gainDb/40)` — guarded
  by the hand-computed-section test + the boost/attenuate behavior tests.
- The DF-II-transposed recursion + cascade order (each section feeds the next) — guarded by the band-shape tests.
- State preservation on same-count re-tune vs reset on count-change — guarded by the `setBands` tests.
- Bit-exact passthrough (same object) when no enabled bands — guarded by the off test; keeps the engine shapes green.

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; the PEQ/engine tests pass hardware-free; `dependencies`
  stays `{}` (the biquad is hand-rolled, no scipy/DSP lib).
- A bell boosts its band, shelves/HP/LP behave correctly; `peq` absent is byte-identical to Phase 3d-1.

## References (Python, file:line)

- `conf_pipeline_control/peq.py` (`StreamingPeq`, `_biquad` RBJ coefficient math lines 35-75, the `sosfilt` state
  recursion, denormal flush 1e-25, no-op guards, same-count state preservation, bit-exact passthrough).
- TS reuse: `src/model/dsp-blocks.ts` (`PeqBand`, `PeqBandType`, `PEQ_MAX_BANDS=4`, `PEQ_BAND_TYPES` — already
  byte-identical to the Python schema); `src/live/engine.ts`/`types.ts` (the onBlock seam, the AGC stage to
  insert before).
