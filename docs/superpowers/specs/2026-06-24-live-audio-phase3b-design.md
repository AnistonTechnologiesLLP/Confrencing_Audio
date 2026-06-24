# Live audio — Phase 3b design (real-time dereverb)

**Date:** 2026-06-24
**Status:** design, approved
**Base:** `feat/live-audio-phase3a-nr` (`5df1c1d`). Branch: `feat/live-audio-phase3b-dereverb`.
**Builds on:** Phase 3a (the `StreamingSpectralProcessor` STFT base + `OmlsaProcessor` + `LevelPreservingCleaner`
+ `LiveConfig.cleaning`).

---

## 1. Goal & scope

The second sub-phase of the cleaning chain: **single-channel statistical dereverberation** — suppress the LATE
reverberation tail (the boxy/distant room "ring") that is distinct from the steady-noise NR of 3a. It is the
next stage in the Python's proven chain order (`… → dereverb → post-NR → AGC → …`), so it runs **before** the
3a denoiser. It reuses the entire Phase-3a STFT machinery; the only new DSP is the gain law.

**In scope:** a `StreamingDereverb` STFT stage (Lebart 2001 / Habets late-reverb spectral subtraction); an
ordered cleaner **chain** so dereverb runs before the denoiser; opt-in wiring via `LiveConfig.cleaning.dereverb`.
**Out of scope (later sub-phases):** AEC (3c); AGC/PEQ/band-limit/voice-gate (3d); DeepFilterNet3 (optional ONNX).

## 2. Architecture — new/changed modules (all pure, zero-dep, browser-safe, under `src/live/`)

### 2.1 `spectral-processor.ts` (modify) — one-line access change
Change `private readonly gFloor` → **`protected readonly gFloor`** so the dereverb subclass can use the base's
gain floor (the base computes `gFloor = 10^(floorDb/20)`). No other base change; `F`/`H`/`nb`/`_gBuf` are already
`protected`, and `computeGain` is the existing `protected` override hook (returns the raw per-bin gain; the base
`processHop` does the shared 3-tap freq + one-pole temporal smoothing + `amount` blend).

### 2.2 `dereverb.ts` (new) — `StreamingDereverb`
`class StreamingDereverb extends StreamingSpectralProcessor`, overriding only `computeGain` and `reset`, plus a
constructor that adds the reverb state. Port of the Python `StreamingDereverb` (`streaming_cleaner.py:182-247`):
- **Constructor** `(sampleRate: number, opts?: DereverbOptions)` where
  `interface DereverbOptions extends SpectralOptions { t60?: number; beta?: number; gminDb?: number; earlyMs?: number }`.
  Calls `super(sampleRate, { ...opts, floorDb: gminDb })` so the inherited `gFloor = 10^(gminDb/20)` IS the
  dereverb floor (gminDb overrides any caller `floorDb`). Then, using `sampleRate` (in scope) and the inherited
  `this.H`/`this.nb`:
  - `_a = exp(−13.8155 · H / (t60 · sampleRate))` — per-frame 60 dB (= ln 10⁶) T60-decay pole.
  - `_d = max(1, round(earlyMs/1000 · sampleRate / H))` — early-reflection delay in frames.
  - `_R = new Float64Array(nb)` — per-bin late-reverb PSD (one-pole IIR state).
  - `_phist = new Float64Array(_d * nb)` — flat ring of the last `_d` power frames (the delayed tap); `_phistIdx = 0`.
- **`override computeGain(power, _noiseMag): Float64Array`** (the `noiseMag` arg is unused — dereverb is
  VAD-independent and uses its own `_R`). Per hop, for each bin `k` (row = `_phist.subarray(_phistIdx*nb, …)`):
  `const pd = row[k]; row[k] = power[k]; _R[k] = _a·_R[k] + (1−_a)·pd; gBuf[k] = max(1 − beta·_R[k]/(power[k]+1e-20), gFloor)`.
  After the bin loop, `_phistIdx = (_phistIdx + 1) % _d`. Return `this._gBuf` (the inherited pre-allocated buffer
  — no hot-path allocation). The base then applies the shared smoothing + `amount`.
- **`override reset()`**: `super.reset()` then `_R.fill(0)`, `_phist.fill(0)`, `_phistIdx = 0`.
- Constants exported: `DEREVERB_T60 = 0.5`, `DEREVERB_BETA = 1.6`, `DEREVERB_GMIN_DB = -10`, `DEREVERB_EARLY_MS = 48`.

### 2.3 `cleaner-chain.ts` (new) — `ChainedCleaner`
`class ChainedCleaner implements Cleaner` (the `Cleaner` contract from `level-preserving-cleaner.ts`): holds an
ordered `Cleaner[]`; `process(block, noiseGate)` runs each stage in order, threading the output of one into the
next; `reset()` resets each. This composes the stages uniformly (and is the slot-in point for 3c/3d). Trivial,
allocation-free (it reuses each stage's own output arrays).

### 2.4 `engine.ts` / `types.ts` / `index.ts` (modify) — chain wiring
- `types.ts`: `CleaningConfig` gains `dereverb?: { t60?: number; beta?: number; gminDb?: number; earlyMs?: number }`.
  `BeamOutput.cleaning` gains an **omit-when-absent** `dereverb?: boolean` (so existing 3a `BeamOutput.cleaning`
  shapes stay byte-identical when dereverb is off).
- `engine.ts`: replace the single-cleaner build with an ordered-stage build. Build a `Cleaner[]`:
  if `cc.dereverb` → push `new StreamingDereverb(sr, cc.dereverb)`; if `cc.engine !== 'off'` → push the denoiser
  (`StreamingSpectralProcessor` for `gate`, else `OmlsaProcessor`). If the list is empty → no cleaner
  (cleaning truly off). Otherwise `inner = stages.length === 1 ? stages[0] : new ChainedCleaner(stages)`, then
  `this.cleaner = cc.preserveLevel ? new LevelPreservingCleaner(inner) : inner`. `cleaningInfo` becomes
  `{ engine: cc.engine, preserved, ...(cc.dereverb ? { dereverb: true } : {}) }` (omit-when-absent → 3a shapes
  unchanged). The build condition becomes `cc !== undefined && (cc.engine !== 'off' || cc.dereverb !== undefined)`.
  The `onBlock` cleaning call is unchanged (it already runs `this.cleaner.process(mono, noiseGate)` after the beam
  and before the meter).
- `index.ts`: export `StreamingDereverb`, `DereverbOptions` (type), the `DEREVERB_*` constants, and `ChainedCleaner`.

## 3. Data flow

```
adapter.onBlock → beam.process → mono
  → [Phase-2 auto-steer]
  → if (cleaner) mono = cleaner.process(mono, noiseGate)   // cleaner = LevelPreserving( Chain[ dereverb?, denoise? ] )
  → meter.update(mono)                                     // meter sees the fully-cleaned signal
  → emit BeamOutput { …, cleaning?: { engine, preserved, dereverb? } }
```
Stage order inside the chain — **dereverb first, then denoise** — matches the Python (`… → dereverb → post-NR → …`):
remove the room tail, then the steady noise; the level-preserving makeup (if on) wraps the whole chain so it
restores the level both stages cut.

## 4. Real-time safety

`StreamingDereverb` pre-allocates `_R` and the `_phist` ring in its constructor and writes the gain into the
inherited pre-allocated `_gBuf` — **no per-hop allocation** (the delayed tap is read-then-overwritten in place,
no `Pd` copy). It inherits the base's bit-exact passthrough when off / during warmup (returns the SAME input
object until `totalFrames ≥ warmupFrames`), and the single-threaded contract. `ChainedCleaner` allocates nothing
on the hot path.

## 5. Testing (hardware-free, vitest)

- **`dereverb.ts`:** feed a **synthetic reverberant** signal — e.g. white noise (or a short tone burst) convolved
  with a sparse exponential-decay tail (a few delayed, decayed copies) — and after warmup assert the dereverb
  measurably **reduces the late-tail energy** (the decaying portion after the burst) while largely preserving the
  direct/early portion; assert per-bin gain ∈ `[gFloor, 1]` (only removes, never boosts, never hard-mutes); assert
  `beta=0` ⇒ gain ≡ 1 (pure passthrough of the reconstructed signal); `reset()` clears `_R`/`_phist` (re-feeding
  reproduces a fresh processor's output); the `_a`/`_d` derivation matches the formulas for a known `sr`/`t60`/`earlyMs`.
- **bit-exact off:** during warmup the dereverb returns the SAME input object (inherited base behavior).
- **`cleaner-chain.ts`:** a two-stage chain applies stages in order (use two fixed-gain fake `Cleaner`s and assert
  the composed gain is the product, in order); `reset()` resets every stage; a single-element chain ≡ that stage.
- **`engine.ts`:** `cleaning:{ dereverb:{} }` (no denoiser) ⇒ `BeamOutput.cleaning` deep-equals
  `{ engine:'off', preserved:false, dereverb:true }`, runs without throwing, output not louder than off;
  `cleaning:{ dereverb:{}, engine:'omlsa' }` ⇒ `cleaning` is `{ engine:'omlsa', preserved:false, dereverb:true }`;
  `cleaning:{ engine:'omlsa' }` (no dereverb) ⇒ `cleaning` has **no** `dereverb` key (3a shape unchanged — the
  existing 3a engine tests still pass); `cleaning` absent ⇒ no cleaning field.

## 6. Deliverables & staged commits

1. `feat(live): expose StreamingSpectralProcessor.gFloor to subclasses` (the one-line `protected` change; covered
   by the dereverb tests in the next commit — no behavior change, so folded forward).
2. `feat(live): streaming single-channel dereverb (Lebart/Habets late-reverb suppression)` (`dereverb.ts` + tests;
   includes the `gFloor` change from (1) if kept as one commit).
3. `feat(live): ordered cleaner chain` (`cleaner-chain.ts` + tests).
4. `feat(live): wire opt-in dereverb into the cleaning chain` (`engine.ts`/`types.ts`/`index.ts` + tests).
5. `docs: document Phase 3b (real-time dereverb)` (README/CHANGELOG/CLAUDE.md) + final gate.

(The plan may merge (1) into (2) since the `protected` change is only exercised by the dereverb subclass.)

## 7. Honest limits (documented)

- **Statistical** single-channel dereverb (Lebart/Habets), not a true inverse/RIR-deconvolution — it estimates and
  subtracts the late-reverb PSD; it cannot recover masked detail.
- Assumes a **fixed T60** (default 0.5 s); a very different room benefits from tuning `t60`/`beta`.
- Shares the ~12 ms STFT latency and the ~0.7 s min-stat warmup gate (bit-exact passthrough until then).
- Only **late** reverb is suppressed (energy older than `earlyMs` ≈ 48 ms); early reflections are kept (they aid
  intelligibility). Gain floored at Gmin (−10 dB) so it never hard-mutes.

## 8. Risks / unknowns to validate during build

- The `_a`/`_d` formulas and the read-then-overwrite ring (off-by-one on `_d`, or copying vs in-place) — guarded by
  the late-tail-reduction + `_a`/`_d`-derivation tests.
- The `BeamOutput.cleaning` shape change must stay omit-when-absent so the **existing 3a engine tests remain green**
  — guarded by re-running the full suite (the 3a tests assert the exact `{ engine, preserved }` shape).
- `floorDb` vs `gminDb` precedence (gminDb must win) — guarded by a gain-range test.

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; the new dereverb/chain/engine tests pass hardware-free;
  `dependencies` stays `{}`.
- `cleaning:{ dereverb:{} }` measurably reduces the late-reverb tail; `cleaning` absent and the 3a-only shapes are
  byte-identical to Phase 3a.

## References (Python, file:line)

- `conf_pipeline_control/streaming_cleaner.py:182-247` (`StreamingDereverb` — `_init_state`, `_gain`).
- `conf_pipeline_control/polaris_beamformer.py:145-148` (defaults: T60 0.5, β 1.6, Gmin −10 dB, early 48 ms).
- Stage order (`… → dereverb → post-NR → AGC → …`): `conf_pipeline_control/CLAUDE.md` "live DSP chain".
- TS base: `src/live/spectral-processor.ts` (`computeGain` hook, `gFloor`, pre-allocated `_gBuf`), Phase-3a
  `omlsa.ts` (the subclass-overrides-computeGain pattern), `level-preserving-cleaner.ts` (`Cleaner` contract).
