# Live audio — Phase 3c design (real-time AEC)

**Date:** 2026-06-24
**Status:** design, approved
**Base:** `master` (Phase 3b merged via PR #4). Branch: `feat/live-audio-phase3c-aec`.
**Builds on:** Phase 2 (`FftRadix2.rfft`), Phase 3a (`irfft`/`irfftInto`, the STFT/overlap-add + pre-allocated-scratch
patterns), Phase 3b (the cleaning chain it runs *before*).

---

## 1. Goal & scope

Third sub-phase of the cleaning chain: **acoustic echo cancellation (AEC)** — cancel the loudspeaker echo (the
far-end voice the room mics pick up from the speakers) so the remote side doesn't hear itself. It runs **first**
in the chain (`beam → AEC → dereverb → denoise → …`), matching the Python stage order. Port of the Python
`StreamingAec` (`streaming_aec.py`) — a **frequency-domain partitioned-block NLMS** adaptive filter over the same
Hann 512/256 STFT the cleaning stages use, so it reuses `FftRadix2` (rfft + irfft) and stays **zero-dependency**.

**In scope:** the `StreamingAec` adaptive filter; a pure-TS far-end **reference ring** + a host-push input path
(`LiveEngine.pushReference`); opt-in wiring via `LiveConfig.aec`; ERLE telemetry. **Out of scope (later):** Phase
3d (AGC/PEQ/band-limit/voice-gate); a coherence double-talk detector; a Node-side loopback reference adapter
(future `src/live-node/` helper); bulk-delay auto-estimation / clock-drift compensation (v1 limitation, matches
Python).

## 2. The reference-input model (the key architectural decision)

The mic and the far-end reference are **separate signals on independent clocks**. The browser-safe `src/live/`
core can't open a loopback device, so **reference acquisition is the host's job** (the Node host already renders
the far-end via `NodeOutputSink.write`). Therefore:

- **`LiveEngine.pushReference(block: Float32Array): void`** — the host calls this with the exact audio it's
  playing to the speakers (next to its playback write). It writes a pure-TS `ReferenceRing`.
- The AEC stage pulls `ring.recent(n)` per mic block. **No bulk-delay estimation** in v1 — the K-tap filter
  (≈93 ms at 16 taps) absorbs the bounded play-out + acoustic delay; an optional static `refDelaySamples` knob
  lets the host pre-offset. Independent clocks / drift uncompensated (documented v1 limit, matches Python).
- **AEC is NOT a `Cleaner`.** The `Cleaner` contract is `process(block, noiseGate)` — no reference arg. So AEC
  is a **separate engine stage** with its own `process(mic, ref, nearEndActive)` signature, run before the
  `this.cleaner` chain. The `Cleaner` interface is NOT widened.

## 3. Architecture — new/changed modules (all pure, zero-dep, browser-safe, under `src/live/`)

### 3.1 `reference-ring.ts` (new) — `ReferenceRing`
A thread-free (JS is single-threaded) circular mono buffer. Port of the Python `_Ring`:
- `constructor(sampleRate: number, seconds = 2)` → capacity `n = round(sampleRate · seconds)`, a `Float32Array(n)`,
  a write index, a filled count.
- `push(block: Float32Array): void` — append; on wrap, modulo; if `block.length ≥ n` keep only the newest `n`.
- `recent(out: Float32Array): Float32Array` — fill `out` with the most recent `out.length` samples, **newest
  last**, zero-**front**-padded if fewer than `out.length` have been written. (Caller passes a pre-allocated
  buffer — no hot-path allocation.) Also `reset()`.

### 3.2 `aec.ts` (new) — `StreamingAec`
Frequency-domain partitioned-block NLMS over the Hann 512/256 STFT, port of the Python `StreamingAec`
(`streaming_aec.py`). Complex math stored as paired `Float64Array`s (re/im), row-major `[k*nb + f]`.
- **Constants** (from `streaming_aec.py:45-50`, but the runtime callers pass `nTaps=16`, so default **16**):
  `AEC_FRAME=512`, `AEC_NTAPS=16` (echo tail ≈ K·H/sr ≈ 93 ms), `AEC_MU=0.3`, `AEC_LEAK=0.999`,
  `AEC_REF_FLOOR=1e-7`, `AEC_ERLE_ALPHA=0.95`; weight clamp ±10; `1e-12`/`1e-20` epsilons.
- **State** (pre-allocated in the ctor): `win`=Hann(F); FIFOs `inqM`/`inqR` (input sample queues), `inbufM`/`inbufR`
  (F, sliding analysis frames), `ola` (F), `outq` (primed to F = one frame of latency); `Wre`/`Wim` (`K·nb`),
  `rfifoRe`/`rfifoIm` (`K·nb`, newest at row 0); ERLE accumulators `micPow`/`errPow`/`erleDb`/`farend`.
- **Per hop** (driven by the `inq` FIFOs at the H cadence, mirroring the cleaning stages' framing):
  1. slide `inbufM`/`inbufR` left by H, append the new H samples; window → `Mt = rfft(inbufM·win)`,
     `Rt = rfft(inbufR·win)` (n/2+1 complex bins).
  2. shift `rfifo` rows down by one (newest→row 0), write `Rt` into row 0.
  3. predicted echo `yhat[f] = Σ_{k} (Wre[k,f]+iWim[k,f])·(rfifoRe[k,f]+i·rfifoIm[k,f])`.
  4. error `e = Mt − yhat` (complex, per bin).
  5. far-end gate: `rpow = mean(|Rt|²)`; `farend = rpow > AEC_REF_FLOOR`.
  6. **adapt** (only if `farend` AND NOT `nearEndActive`): `denom[f] = Σ_k |rfifo[k,f]|² + 1e-12`;
     `step[f] = mu·e[f]/denom[f]`; `W[f,k] = leak·W[f,k] + step[f]·conj(rfifo[k,f])`; clamp `Wre`/`Wim` to ±10.
  7. **ERLE** (only if `farend`): `micPow = α·micPow + (1−α)·mean(|Mt|²)`; `errPow = α·errPow + (1−α)·mean(|e|²)`;
     `erleDb = 10·log10((micPow+1e-20)/(errPow+1e-20))`.
  8. `y = irfft(e)` (reuse `irfftInto` into a pre-allocated scratch); overlap-add into `ola`; drain H to `outq`.
- **`process(mic: Float32Array, ref: Float32Array | null, nearEndActive = false): Float32Array`** — `ref` null ⇒
  treat as zeros (no cancellation; still an OLA reconstruction). Returns a same-length `Float32Array` from `outq`
  (front-padded with zeros on the one-time startup underflow). `reset(): void`; `get erleDb(): number`;
  `get farendActive(): boolean`.
- **`nearEndActive` is always passed `false`** by the engine (the SRP-PHAT/energy VAD also sees the echo, so
  gating adaptation on it would freeze the filter exactly when it must learn). Double-talk robustness rests on
  the leaky NLMS (`leak=0.999`) + the ±10 clamp — same as the Python; a coherence DTD is a documented future add.

### 3.3 `engine.ts` / `types.ts` / `index.ts` (modify) — opt-in wiring
- `types.ts`: `interface AecConfig { nTaps?: number; mu?: number; leak?: number; refFloor?: number; refSeconds?: number; refDelaySamples?: number }`;
  `LiveConfig` gains `aec?: AecConfig`; `BeamOutput` gains an **omit-when-absent** `aec?: { erleDb: number; farendActive: boolean }`.
- `engine.ts`:
  - new fields `aec: StreamingAec | null = null`, `refRing: ReferenceRing | null = null`, a pre-allocated `refScratch: Float32Array`, `aecActive = false`.
  - **`pushReference(block: Float32Array): void`** — `this.refRing?.push(block)` (no-op when AEC isn't configured).
  - constructor: if `config.aec` → build `new StreamingAec(sr, opts)` + `new ReferenceRing(sr, refSeconds)` + the
    `refScratch`; set `aecActive = true`.
  - in `onBlock`, **after** `beam.process(channels) → mono` and **before** the Phase-2 auto-steer + the cleaner:
    `if (this.aec) { const ref = this.refRing.recent(this.refScratch); mono = this.aec.process(mono, ref, false); }`
    then the existing meter / DOA / cleaner stages see the echo-cancelled `mono`. (Matches the Python order:
    AEC first.)
  - emit `...(this.aecActive ? { aec: { erleDb: this.aec.erleDb, farendActive: this.aec.farendActive } } : {})`.
- `index.ts`: export `StreamingAec`, `ReferenceRing`, the `AEC_*` constants, `AecConfig` (type).
- **Byte-identical-when-off** is enforced at config level: no `LiveConfig.aec` ⇒ `this.aec` null ⇒ `mono`
  untouched ⇒ no `aec` field. (Like the cleaner, the AEC is NOT bit-exact even when idle-but-built — it's an OLA
  reconstruction with ~12 ms latency — so the off-guarantee is "config omits `aec`", not an in-process bypass.)

## 4. Data flow

```
host playback → engine.pushReference(farEndBlock)  → ReferenceRing
adapter.onBlock(channels) → beam.process → mono
  → if (aec) mono = aec.process(mono, refRing.recent(scratch), false)   // NEW — cancel echo first
  → [Phase-2 auto-steer]
  → if (cleaner) mono = cleaner.process(mono, noiseGate)                // dereverb → denoise (Phase 3a/3b)
  → meter.update(mono)
  → emit BeamOutput { …, aec?: { erleDb, farendActive }, cleaning?: {…} }
```

## 5. Real-time safety

All AEC + ring buffers pre-allocated in the constructor (complex weight/FIFO arrays, the per-hop scratch, the
`refScratch`); **no per-hop allocation** (reuse `irfftInto`; write `yhat`/`e`/`step`/`denom` into pre-allocated
scratch). Single-threaded (no locks — the Python's `_lock` guards against a separate control thread; JS has none).
The far-end gate skips adaptation on silent-reference frames. `process` never throws on a missing/short reference
(null ⇒ zeros; longer/shorter ⇒ the `recent(scratch)` fixed-size pull handles it).

## 6. Testing (hardware-free, vitest)

- **`reference-ring.ts`:** `recent` returns newest-last, zero-front-padded before fill; correct after wrap-around;
  a `block ≥ capacity` keeps only the newest `n`; `reset` clears.
- **`aec.ts`:** build a **synthetic echo** — `ref` = a deterministic signal, `mic = (h ⊛ ref)` for a short known
  impulse response `h` (a few delayed, scaled taps within the K-tap span) + optional low near-end. Feed `ref`
  and `mic` block-by-block; after warm-up assert **ERLE rises** (`erleDb` climbs above a threshold) and the
  **residual-echo RMS drops materially** vs the un-cancelled mic. Assert: `ref=null` ⇒ no cancellation but finite
  output (OLA reconstruction); near-end-only (zero reference) ⇒ `farendActive=false`, no adaptation, signal
  passes ~through; the weights stay bounded (±10 clamp); `reset()` drops the filter + ERLE (re-feeding reproduces
  a fresh run); the `rfft→`(filter)`→irfft` framing reconstructs at unity when `W=0` (first frames).
- **`engine.ts`:** `aec:{}` config ⇒ `BeamOutput.aec` present (`{ erleDb, farendActive }`), runs without throwing,
  output not louder than off; **`aec` absent ⇒ no `aec` field** (byte-identical; the existing Phase-3a/3b shapes
  unchanged); `pushReference` + a `MockCaptureAdapter` emitting `beamTone + echo(pushedRef)` ⇒ the AEC measurably
  reduces the echo (ERLE > 0) vs no-AEC. (The mock's mono is beam-coherent; assert the wiring + a real reduction
  on the injected echo, not a fabricated number.)

## 7. Deliverables & staged commits

1. `feat(live): far-end reference ring` (`reference-ring.ts` + tests).
2. `feat(live): streaming acoustic echo canceller (frequency-domain partitioned-block NLMS)` (`aec.ts` + tests).
3. `feat(live): wire opt-in AEC + pushReference into LiveEngine` (`engine.ts`/`types.ts`/`index.ts` + tests).
4. `docs: document Phase 3c (real-time AEC)` (README/CHANGELOG/CLAUDE.md) + final gate.

## 8. Honest limits (documented)

- The **host must supply the far-end reference** via `pushReference` (it has it — it's the program audio); the
  browser-safe core can't capture loopback. A Node-side auto-loopback reference adapter is a future add.
- **No bulk-delay auto-estimation and no clock-drift compensation** (v1) — the echo path must fit within the
  ~93 ms tap span; long sessions on independent clocks can drift out of range (the filter then silently stops
  cancelling). A static `refDelaySamples` is the only mitigation.
- **Post-beam, single-beam** AEC (cancels the beamformed mono, not per-mic pre-beam) — re-steering mid-call
  changes the echo path and forces re-convergence.
- **No double-talk detector** — `nearEndActive` stays `false`; robustness is the leaky NLMS + clamp only.
- Adds **~12 ms** STFT latency when active; **none** when off (config omits `aec`).

## 9. Risks / unknowns to validate during build

- Complex-arithmetic indexing (`[k*nb+f]` row-major for `W`/`rfifo`; the `conj` in the gradient) — the classic
  AEC bug; guarded by the ERLE-rises + residual-drop test on a known impulse response.
- The reference FIFO shift direction (newest at row 0; `yhat = Σ_k W[k]·rfifo[k]`) — guarded by the same test.
- Far-end gate threshold + the startup `outq` priming (one-frame latency, front-pad on underflow) — guarded by
  the framing/round-trip tests.
- `BeamOutput.aec` omit-when-absent must keep the existing Phase-3a/3b engine-shape tests green.

## 10. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` green; the AEC/ring/engine tests pass hardware-free;
  `dependencies` stays `{}` (frequency-domain NLMS is pure DSP, reuses the existing FFT).
- On a synthetic echo, the AEC raises ERLE and cuts the residual; `aec` absent is byte-identical to Phase 3b.
- On the real POLARIS (manual, not CI): with the host pushing the program audio as reference, the far-end echo in
  the cleaned mono is audibly reduced (ERLE shown in the Live tab is the at-a-glance proof).

## References (Python, file:line)

- `conf_pipeline_control/streaming_aec.py` — `StreamingAec` (partitioned-block NLMS: F=512/H=256, K, rfifo, yhat
  via einsum, NLMS update with `conj(rfifo)`, ±10 clamp, far-end gate `rpow>ref_floor`, ERLE EMA, `process(mic,
  ref, near_end_active)`, `reset`, `erle_db`/`farend_active`).
- `conf_pipeline_control/reference_capture.py` — `_Ring` (2 s mono ring, `recent(n)` newest-last zero-front-padded)
  + the loopback capture (Node-side equivalent is out of scope; the host-push model replaces it).
- `conf_pipeline_control/polaris_beamformer.py` — stage order (`AEC first`), `near_end_active=False` rationale,
  ERLE surfacing, the opt-in default-off recipe.
- TS reuse: `src/live/fft.ts` (`rfft`, `irfft`/`irfftInto`), `src/live/spectral-processor.ts` (the STFT framing +
  pre-allocated-scratch pattern), `src/live/engine.ts`/`types.ts` (the onBlock seam, omit-when-absent spread).
