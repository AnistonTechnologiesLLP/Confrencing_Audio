# Live audio — Phase 3d-3 design (voice-gate + band-limit)

**Date:** 2026-06-24
**Status:** design, approved-with-a-scope-correction (see §0)
**Base:** continues `feat/live-audio-phase3d1-agc` (`6acaf26`, after 3d-1 AGC + 3d-2 PEQ). Same branch (3d pushes together).
**Builds on:** Phase 3d-2 `StreamingPeq` (reused for band-limit), the engine onBlock seam, the `ExponentialTracker` pattern.

---

## 0. Scope correction (source-driven)

The approved Phase-3d decomposition named 3d-3 as "**band-limit + voice-gate**". Reading the authoritative
Python live chain (`conf_pipeline_control/live.py:580-609`) the actual post-beam order is:

```
AEC → (transient) → dereverb → denoise → PEQ → AGC → voice-gate(LAST)
```

There is **no separate post-AGC "band-limit" stage**. The literal "band-limit" in the Python is the
**beam-output anti-alias FIR** (`polaris_beamformer.py`, a *beamformer* concern applied at the beam, ~5.6 kHz
Hann-sinc lowpass) — not a cleaning-chain stage — and a *speech* band-limit (cut rumble < ~100 Hz, hiss
> ~7-8 kHz) is exactly what the Phase-3d-2 **`StreamingPeq` already does** via its `highpass`/`lowpass` band
types. So:

- **Voice-gate** is the genuine new 3d-3 deliverable (a faithful port of `VoiceOnlyGate` + its
  `SpeechPresenceScorer`).
- **Band-limit** is delivered as a thin, first-class **opt-in config that reuses `StreamingPeq`** (a dedicated
  HP+LP filter instance) — **zero new DSP module** (DRY; no redundant biquad). The beam anti-alias FIR is a
  separate, optional beamformer feature and is explicitly out of scope here.

This keeps both named features while staying faithful to the source and YAGNI.

## 1. Goal & scope

Add the final two opt-in tone/level stages to the live cleaning chain:
- a **speech band-limit** (opt-in HP+LP) that trims out-of-band rumble/hiss before the AGC levels the signal;
- a **voice-only output gate** that ducks non-speech (gaps, steady fan/hum, knocks) using a level-invariant
  syllabic-modulation speech-presence score, running **last** (after the AGC), onset-safe and shallow (a duck,
  not a mute).

**In scope:** `SpeechPresenceScorer`, `StreamingVoiceGate`, band-limit-via-PEQ wiring. **Out of scope:** the
beam anti-alias FIR; a competing-talker remover (that is spatial nulling, not this gate); the transient
de-thump stage (no transient stage in TS).

## 2. Architecture — new/changed modules (pure, zero-dep, browser-safe, under `src/live/`)

### 2.1 `speech-presence.ts` (new) — `SpeechPresenceScorer`
A per-hop, **level-invariant** speech-vs-steady-noise score in `[0,1]` from the output RMS envelope. Port of
`multikit.py:SpeechPresenceScorer` (pure — three one-pole EMAs, no FFT). A difference-of-EMAs band-pass on the
envelope (≈3-8 Hz syllabic band) divided by the slow level: a steady fan is near-DC → ~0; a louder fan does not
help because level is the denominator.
- One-pole coefficient helper `alphaFor(hopSeconds, tauSeconds)` = `tau ≤ 0 ? 1 : 1 − exp(−hop/tau)`.
- Constructor `(opts?: { hopSeconds?; tauFast?; tauSlow?; tauMod?; modRef? })` with defaults
  `hopSeconds=0.032, tauFast=0.03, tauSlow=0.15, tauMod=0.30, modRef=0.25`. Precompute `aFast/aSlow/aMod` from
  `hopSeconds`; `modRef = max(1e-6, modRef)`. State `fast=slow=mod=0`.
- `update(rms: number, noiseFloor = 0): number`:
  `env = max(rms, 0); fast += aFast·(env−fast); slow += aSlow·(env−slow); bp = fast−slow;
   mod += aMod·(|bp|−mod); level = max(slow, noiseFloor, 1e-4); return min(1, (mod/level)/modRef)`.
- `reset(): void` (`fast=slow=mod=0`).
- Constants exported: `VG_HOP_SECONDS=0.032`, `VG_TAU_FAST=0.03`, `VG_TAU_SLOW=0.15`, `VG_TAU_MOD=0.30`,
  `VG_MOD_REF=0.25`, `VG_LEVEL_FLOOR=1e-4`.

### 2.2 `voice-gate.ts` (new) — `StreamingVoiceGate`
A speech-presence output gate: attenuate non-speech toward a shallow floor with a **fast attack / slow
release**, driven by the scorer. Port of `voice_gate.py:VoiceOnlyGate`. Same `process(block[, noiseGate]) →
block` / `reset()` contract as the other stages.
- Constructor `(sampleRate: number, opts?: VoiceGateOptions)` where
  `interface VoiceGateOptions { threshold?; floorDb?; attackMs?; releaseMs?; modRef? }`, defaults
  `threshold=0.35, floorDb=-15, attackMs=8, releaseMs=180`. `floor = 10^(floorDb/20)`,
  `attackMs = max(0.1, attackMs)`, `releaseMs = max(0.1, releaseMs)`.
- It owns a `SpeechPresenceScorer`, **rebuilt when the block cadence changes** (`|hopSeconds − builtHop| ≥ 1e-5`)
  because the EMA alphas depend on `hopSeconds = n/sampleRate` (a driver-chosen / short final block must not
  mis-weight the estimate). `modRef` (if given) is passed to the scorer.
- `process(block, noiseGate?)` (the `noiseGate` arg is accepted-and-ignored):
  1. `n = block.length`; if `n === 0` return block. `hopSeconds = n/sampleRate`; ensure the scorer for this hop.
  2. `rms = sqrt(mean(block²))` (Float64 accumulate); `score = scorer.update(rms)`.
  3. **onset:** `onset = rms > 3·max(prevRms, 1e-6)` (anticipate a just-started talker the scorer hasn't yet
     confirmed — protect the first syllable); then `prevRms = rms`.
  4. `target = (score ≥ threshold || onset) ? 1 : floor`.
  5. `tau = target > gain ? attackMs : releaseMs` (fast attack / slow release);
     `a = 1 − exp(−hopSeconds / max(1e-4, tau/1000))`; `gNew = gain + a·(target − gain)`.
  6. **de-click within the block:** ramp the gain **linearly from `gain` to `gNew`** across the n samples
     (`g(i) = gain + (gNew − gain)·i/(n−1)`, or constant `gNew` when `n === 1`); `out[i] = block[i]·g(i)`.
  7. `gain = gNew`; telemetry: `gateOpen = gNew > 0.5`,
     `lastReductionDb = gNew < 0.999 ? −20·log10(max(gNew,1e-6)) : 0`, `score` stored.
- `reset(): void` (drop the scorer so it rebuilds, `gain=1, prevRms=0, gateOpen=true, lastReductionDb=0,
  score=1`).
- Getters for telemetry: `get gateOpen(): boolean`, `get reductionDb(): number`, `get score(): number`.
- Constants exported: `VG_THRESHOLD=0.35`, `VG_FLOOR_DB=-15`, `VG_ATTACK_MS=8`, `VG_RELEASE_MS=180`.

### 2.3 `engine.ts` / `types.ts` / `index.ts` (modify) — opt-in wiring
- `types.ts`:
  - `interface BandLimitConfig { highpassHz?: number; lowpassHz?: number }` (at least one set to be active).
  - `interface VoiceGateConfig { threshold?; floorDb?; attackMs?; releaseMs?; modRef? }`.
  - `LiveConfig` gains `bandLimit?: BandLimitConfig` and `voiceGate?: VoiceGateConfig`.
  - `BeamOutput` gains an **omit-when-absent** `voiceGate?: { open: boolean; reductionDb: number; score: number }`
    (band-limit is linear — no telemetry field).
- `engine.ts`:
  - A private `bandLimit: StreamingPeq | null = null` built when `config.bandLimit` has a HP and/or LP: assemble
    `PeqBand[]` = `[{type:'highpass', freqHz:highpassHz, gainDb:0, q:0.70710678},]` and/or
    `[{type:'lowpass', freqHz:lowpassHz, gainDb:0, q:0.70710678}]`, then `new StreamingPeq(sr, bands)` (null if no
    band resolves — the PEQ's own no-op guards also drop out-of-range cutoffs).
  - A private `voiceGate: StreamingVoiceGate | null = null` built when `config.voiceGate` is set.
  - In `onBlock`, the chain order (**updated after the whole-branch review to match the Python chain**
    `PEQ → AGC → band-limit → voice-gate`):
    `… cleaner → if (peq) mono = peq.process(mono) → if (agc) mono = agc.process(mono,false) →
     if (bandLimit) mono = bandLimit.process(mono) → if (voiceGate) mono = voiceGate.process(mono) →
     meter.update → emit`.
    (Band-limit runs **after** the AGC — Python-chain parity; band-limit is linear so the magnitude response is
    position-independent among the linear stages, only the AGC's loudness reference differs. Voice-gate runs
    **last**, after everything, so the level-invariant score sees the final operating point and the meter/emitted
    mono reflect the gate.)
  - Emit `...(this.voiceGate ? { voiceGate: { open: this.voiceGate.gateOpen, reductionDb:
    this.voiceGate.reductionDb, score: this.voiceGate.score } } : {})`.
- `index.ts`: export `SpeechPresenceScorer` + its constants, `StreamingVoiceGate` + its constants + `VoiceGateOptions`,
  and re-export `BandLimitConfig`/`VoiceGateConfig` types.
- **Byte-identical-when-off:** no `bandLimit` ⇒ no filter; no `voiceGate` ⇒ no stage + no `BeamOutput.voiceGate`
  field. Existing Phase-3a/3b/3c/3d-1/3d-2 engine-shape tests stay green.

## 3. Data flow

```
… → beam → [AEC] → cleaner(dereverb→denoise) → [PEQ] → [AGC] → [bandLimit:PEQ HP+LP] → [voiceGate] → meter → emit
                                                                                              BeamOutput { …, voiceGate?: { open, reductionDb, score } }
```
(Band-limit position updated to after-AGC per the whole-branch review — Python-chain parity.)

## 4. Real-time safety

The scorer is three scalar EMAs (no allocation). The voice-gate allocates one output `Float32Array` per call
(stage convention) and computes the in-block ramp inline (no `linspace` allocation — a running gain). The band-limit
is a reused `StreamingPeq` (pre-allocated sections + state). The scorer rebuild on a hop-cadence change is the only
allocation outside the steady state and happens at most once per cadence. Single-threaded (no lock). The gate is a
shallow duck (floor −15 dB), onset-protected, so a missed onset is recoverable — never a hard mute.

## 5. Testing (hardware-free, vitest)

- **`speech-presence.ts`:** a **steady** RMS sequence (constant envelope) → score → ~0 (well below threshold); a
  **syllabically-modulated** RMS sequence (e.g. alternating high/low every few hops at ~4-6 Hz) → score rises
  toward 1 and crosses 0.35; **level-invariance** — scaling the whole modulated sequence by 10× yields ~the same
  score (within tolerance); `reset()` zeroes the state (re-feeding reproduces the run); `alphaFor(hop, 0) === 1`
  and `alphaFor(hop, τ) ∈ (0,1)`.
- **`voice-gate.ts`:** **steady noise** (constant RMS, low score) → after enough blocks the gain **ducks** toward
  the floor (output RMS ≈ `floor × input`, within tolerance); **modulated speech** → the gate **opens** (gain ≈ 1,
  output ≈ input); a **sudden loud onset** opens the gate **immediately** (the onset branch — first loud block is
  not floored even before the scorer confirms); the **attack is faster than the release** (measure the per-block
  gain step opening vs closing); the floor is a **duck not a mute** (ducked output is `≥ floor×input`, never 0);
  the in-block **ramp** de-clicks (no full-scale jump between the first and last sample on a gain change);
  `reset()` restores `gain=1`/open; telemetry `gateOpen`/`reductionDb`/`score` are consistent with the gain;
  a **1-sample block** uses constant gain (no divide-by-zero in the ramp).
- **`engine.ts`:** `voiceGate:{}` ⇒ `BeamOutput.voiceGate` is `{ open, reductionDb, score }` and runs without
  throwing; `bandLimit:{ highpassHz:120, lowpassHz:7000 }` ⇒ runs, the emitted mono is band-limited (a sub-100 Hz
  or super-8 kHz tone is attenuated vs no band-limit) and adds **no** `BeamOutput` field; both absent ⇒ no
  `voiceGate` field (byte-identical to Phase 3d-2; existing engine-shape tests pass); the **stage order** is
  band-limit → PEQ → AGC → voice-gate (verify in the wiring).

## 6. Deliverables & staged commits

1. `feat(live): syllabic-modulation speech-presence scorer` (`speech-presence.ts` + tests).
2. `feat(live): voice-only output gate` (`voice-gate.ts` + tests).
3. `feat(live): wire opt-in band-limit (PEQ reuse) + voice-gate into LiveEngine` (`engine.ts`/`types.ts`/`index.ts` + tests).
4. Docs for the whole Phase-3d tier (AGC + PEQ + band-limit + voice-gate) — one commit at PR time.

## 7. Honest limits (documented)

- The voice-gate is a **timbre/modulation** test, not a spatial one — it does **not** remove a competing human
  voice in the pickup zone (that is speech); only zone-nulling does. It is a shallow duck (−15 dB), onset-safe.
- The band-limit reuses the PEQ biquads (2nd-order Butterworth HP/LP at Q≈0.707) — gentle 12 dB/oct skirts, not a
  brick-wall; it is a speech-band trim, not the beam anti-alias FIR.
- Voice-gate adds no latency (block-rate gain with an in-block ramp); band-limit adds none (IIR).
- The scorer's modulation reference (`modRef`) was tuned at the 2-kit operating point; it is exposed on the
  voice-gate config to re-tune at the post-AGC point if needed.

## 8. Risks / unknowns to validate during build

- The scorer's level-invariance + the difference-of-EMAs band-pass — guarded by the steady-vs-modulated +
  10×-scale tests.
- The voice-gate's onset branch (`rms > 3·prevRms`) and the fast-attack/slow-release asymmetry — guarded by the
  onset + attack-faster-than-release tests.
- The in-block linear ramp with `n === 1` (no `/(n−1)` divide-by-zero) — guarded by the 1-sample test.
- `BeamOutput.voiceGate` omit-when-absent + no band-limit field must keep the prior engine-shape tests green.

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; the new unit + engine tests pass hardware-free;
  `dependencies` stays `{}` (scorer + gate are pure; band-limit reuses the existing biquad).
- The gate ducks steady noise and opens on speech/onset; the band-limit trims out-of-band energy; both absent is
  byte-identical to Phase 3d-2.

## References (Python, file:line)

- `conf_pipeline_control/voice_gate.py` (`VoiceOnlyGate` — threshold/floor/attack/release, scorer rebuild on hop,
  onset branch, in-block ramp, telemetry).
- `conf_pipeline_control/multikit.py` (`SpeechPresenceScorer` + `_alpha`, constants `DEFAULT_HOP_SECONDS=0.032`,
  `DEFAULT_TAU_FAST=0.03`, `DEFAULT_TAU_SLOW=0.15`, `DEFAULT_TAU_MOD=0.30`, `DEFAULT_MOD_REF=0.25`,
  `_LEVEL_FLOOR=1e-4`).
- `conf_pipeline_control/live.py:580-609` (the canonical chain order — voice-gate is the LAST stage; no separate
  band-limit stage).
- TS reuse: `src/live/peq.ts` (`StreamingPeq` HP/LP for the band-limit), `src/live/engine.ts`/`types.ts` (the
  onBlock seam, omit-when-absent spread).
