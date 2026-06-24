# Live audio — Phase 3d-1 design (target-loudness AGC)

**Date:** 2026-06-24
**Status:** design, approved
**Base:** `feat/live-audio-phase3c-aec` (`18c038c`, stacked on the AEC chain). Branch: `feat/live-audio-phase3d1-agc`.
**Builds on:** Phase 3a (`ExponentialTracker`, the `LevelPreservingCleaner` peak-limiter pattern), the engine onBlock seam.

---

## 1. Goal & scope

First of three Phase-3d "level & tone" sub-phases: **target-loudness automatic gain control** — normalize the
cleaned mono to a target loudness so the remote side hears a consistent level. It runs **after** the cleaning
chain (AEC → dereverb → denoise) and **before** the meter, matching the Python order (`… → denoise → PEQ → AGC
→ band-limit → voice-gate`; PEQ/band-limit/voice-gate are the later 3d-2/3d-3 sub-phases). Port of the Python
`TargetLoudnessAgc` (`agc.py`) — a trivial direct port that reuses the existing `ExponentialTracker` and the
`LevelPreservingCleaner` limiter arm. **In scope:** AGC only. **Out of scope:** PEQ (3d-2), band-limit +
voice-gate (3d-3); the `freeze`/transient-duck interaction (no transient stage in TS yet — AGC always adapts).

## 2. Architecture — new/changed modules (pure, zero-dep, browser-safe, under `src/live/`)

### 2.1 `agc.ts` (new) — `TargetLoudnessAgc`
A mono block-rate target-loudness normalizer. Port of `agc.py`. **Control-pure** (driven by the output RMS
only — no distance/room/cross-channel). Per block:
1. measure `rms = sqrt(mean(block²))`.
2. **silence-hold:** if `rms ≤ silenceRms` (silence floor −55 dB), `desired = held gain` (the current slewed
   gain, or `1` before the slew is seeded); else `desired = clamp(targetRms/rms, gainMin, gainMax)` (the
   straight target ratio, clamped to ±maxGainDb).
3. **slew** the gain through `ExponentialTracker(slewAlpha=0.15)`: `g = slew.update(desired)`.
4. apply the scalar gain: `out[i] = block[i]·g`.
5. **peak limiter** (the `LevelPreservingCleaner` arm, verbatim): instant attack / slow release, ceiling −1 dB
   (`lim = need<lim ? need : lim + 0.05·(min(1,need)−lim)`), so a loud boost never clips the converter.
- Constructor `(sampleRate: number, opts: AgcOptions)` where
  `interface AgcOptions { targetDb: number; maxGainDb?: number; slewAlpha?: number; silenceDb?: number }`
  (`targetDb` required). `targetRms = 10^(targetDb/20)`; `gainMax = 10^(maxGainDb/20)`,
  `gainMin = 10^(−maxGainDb/20)` (symmetric ±maxGainDb clamp); `silenceRms = 10^(silenceDb/20)`;
  `ceiling = 10^(−1/20)`.
- `process(block: Float32Array, freeze = false): Float32Array` (returns a new same-length `Float32Array`).
  `reset(): void` (resets the slew tracker + `lim=1`). `get gainLinear(): number` (the current slewed gain, for
  telemetry).
- Constants exported: `AGC_MAX_GAIN_DB=18`, `AGC_SLEW_ALPHA=0.15`, `AGC_SILENCE_DB=-55`, `AGC_CEILING_DB=-1`,
  `AGC_LIMIT_RELEASE_ALPHA=0.05`.
- **Held-gain guard:** before the slew is seeded `tracker.value` is `0`; the held gain must fall back to `1`
  (`this.slew.value || 1`) so the first silent block isn't muted (the AGC gain is clamped ≥ gainMin > 0, so a
  seeded value is never 0 — `|| 1` is safe).

### 2.2 `engine.ts` / `types.ts` / `index.ts` (modify) — opt-in wiring
- `types.ts`: `interface AgcConfig { targetDb: number; maxGainDb?: number; slewAlpha?: number; silenceDb?: number }`;
  `LiveConfig` gains `agc?: AgcConfig`; `BeamOutput` gains an **omit-when-absent** `agc?: { gainLinear: number }`.
- `engine.ts`: a private `agc: TargetLoudnessAgc | null = null`; built in the constructor when `config.agc` is set
  (`new TargetLoudnessAgc(sr, config.agc)`). In `onBlock`, **after** the cleaner stage and **before**
  `this.meter.update(mono)`: `if (this.agc) mono = this.agc.process(mono, false);` (`freeze` hard-`false` — no
  transient stage in TS). Emit `...(this.agc ? { agc: { gainLinear: this.agc.gainLinear } } : {})`.
- `index.ts`: export `TargetLoudnessAgc`, the `AGC_*` constants, `AgcOptions` (type), `AgcConfig` (type).
- **Byte-identical-when-off** at config level: no `LiveConfig.agc` ⇒ `this.agc` null ⇒ `mono` untouched ⇒ no
  `agc` field (so the existing Phase-3a/3b/3c engine-shape tests stay green).

## 3. Data flow

```
… → beam → [AEC] → cleaner(dereverb→denoise) → if (agc) mono = agc.process(mono) → meter.update → emit
                                                                                          BeamOutput { …, agc?: { gainLinear } }
```

## 4. Real-time safety

The only state is the slew `ExponentialTracker` + the limiter running gain `lim` (both scalars). One output
`Float32Array` per call (same convention as the cleaning stages — the AGC's RMS/gain/limiter are O(n) scalar
passes, no other allocation). Single-threaded (no lock). Silence-held so it never pumps the noise floor; the
limiter prevents clipping on a large boost.

## 5. Testing (hardware-free, vitest)

- **`agc.ts`:** a **quiet** steady block (RMS below target) ⇒ after enough blocks the gain **slews up** toward
  `targetRms/rms` (and the output RMS approaches the target); a **loud** block ⇒ gain **slews down**; the gain
  is **clamped** to ±maxGainDb (an extreme input never exceeds the clamp); **silence** ⇒ the gain is **held**
  (does not ramp up — assert `gainLinear` doesn't drift across silent blocks); the **slew is gradual** (one
  block doesn't jump straight to the target); the **peak limiter** caps the output peak at the ceiling
  (a near-full-scale boosted block stays ≤ −1 dB ≈ 0.892); `reset()` clears the slew + limiter (re-feeding
  reproduces a fresh run).
- **`engine.ts`:** `agc:{ targetDb:-20 }` ⇒ `BeamOutput.agc` is `{ gainLinear: <number> }`, runs without
  throwing, and the emitted mono level moves toward the target vs no-AGC; `agc` absent ⇒ **no `agc` field**
  (byte-identical to Phase 3c; the existing engine-shape tests pass).

## 6. Deliverables & staged commits

1. `feat(live): target-loudness AGC` (`agc.ts` + tests).
2. `feat(live): wire opt-in AGC into LiveEngine` (`engine.ts`/`types.ts`/`index.ts` + tests).
3. `docs: document Phase 3d-1 (target-loudness AGC)` (README/CHANGELOG/CLAUDE.md) + final gate.

## 7. Honest limits (documented)

- **Control-pure loudness AGC** (output-RMS-driven only) — not a multiband/broadcast loudness processor and not
  EBU-R128 integrated loudness; it's a slow one-pole gain toward a target RMS.
- The **`freeze`** path (don't pull up during a transient duck) exists in the Python via the transient
  suppressor; the TS has no transient stage yet, so the TS AGC always adapts (`freeze=false`). A future TS
  transient stage would wire `freeze`.
- Adds **no latency** itself (block-rate scalar gain), but the peak limiter is per-block (no look-ahead).
- Silence-held (≤ −55 dB) and ±18 dB-clamped so it can't pump the noise floor or run away.

## 8. Risks / unknowns to validate during build

- The held-gain guard (`slew.value || 1`) on the first/silent block — guarded by the silence-hold test.
- The peak-limiter math must match the corrected `LevelPreservingCleaner` arm (release toward `min(1,need)`) —
  guarded by the limiter test.
- `BeamOutput.agc` omit-when-absent must keep the existing Phase-3a/3b/3c engine-shape tests green.

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; the AGC/engine tests pass hardware-free; `dependencies`
  stays `{}`.
- AGC measurably moves a quiet/loud signal toward the target; `agc` absent is byte-identical to Phase 3c.

## References (Python, file:line)

- `conf_pipeline_control/agc.py` (`TargetLoudnessAgc` — RMS, clamp(target/rms), silence-hold, ExponentialTracker
  slew, peak limiter; constants `DEFAULT_AGC_MAX_GAIN_DB=18`, `_SLEW_ALPHA=0.15`, `_SILENCE_DB=-55`,
  `_CEILING_DB=-1`, `_LIMIT_RELEASE_ALPHA=0.05`).
- `conf_pipeline_control/tracking.py` (`ExponentialTracker` — matches `src/live/exponential-tracker.ts`).
- TS reuse: `src/live/exponential-tracker.ts` (the slew), `src/live/level-preserving-cleaner.ts:63-68` (the
  peak-limiter arm), `src/live/engine.ts`/`types.ts` (the onBlock seam, omit-when-absent spread).
