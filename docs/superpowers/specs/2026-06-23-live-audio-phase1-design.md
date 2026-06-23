# Live audio in the TS pipeline — Phase 1 design

**Date:** 2026-06-23
**Status:** design, awaiting review
**Scope:** Phase 1 of a multi-phase effort to bring a live/real-time audio layer to the
TypeScript `conferencing-audio-pipeline`, which today is an offline, config-only control plane plus
a pure offline beamformer *design* layer.

---

## 1. Goal & destination

The destination (agreed) is a full live subsystem in TS, with a backend-agnostic core and two
capture backends, covering a live beam monitor → live steering (DOA) → a cleaning chain — mirroring
the capability of the Python sibling's `conf_pipeline_control` live layer. That is too large for one
spec, so it is **phased**:

- **Phase 1 (this spec)** — pluggable live core + the **Node-native** capture adapter (real 8-capsule
  POLARIS) + a fixed-beam **fractional-delay-and-sum** beamformer + mono output with a level/peak/clip
  meter, plus a Mock adapter for hardware-free tests.
- **Phase 2** — live steering: DOA estimation + auto-steer + lock-to-seat (reusing the just-ported
  `seat-mapper`).
- **Phase 3** — cleaning chain: AEC → dereverb → noise suppression (some stages need extra optional
  deps, e.g. ONNX for DeepFilterNet3).

This spec designs **Phase 1 only**; Phases 2–3 are context for the architecture.

## 2. The constraint that shaped this design

Researched, high-confidence (MDN / W3C Web Audio + MediaCapture specs): **a plain browser cannot
capture the 8 discrete channels** of the POLARIS USB array. `getUserMedia` audio is mediated by the
OS subsystem (WASAPI/CoreAudio), which **downmixes a multichannel USB device to stereo before Web
Audio sees it**; there is no API to request discrete hardware channels (`MediaStreamAudioSourceNode`
is the ceiling). True 8-capsule beamforming in a browser tab requires a native bridge (Electron/
WebView) or accepts stereo.

**Consequence:** the *core* stays backend-agnostic ("both"), but the **Node-native adapter is the real
beamforming path** (same as the Python `sounddevice`/PortAudio engine). The **browser adapter is
deferred** to a later, separately-scoped phase (its audio-sourcing question — stereo preview vs Node→
browser 8-ch streaming vs Electron — is unresolved and out of scope here).

## 3. Phase 1 scope

**In:**
- A pure, zero-dependency, browser-safe **core**: capture-adapter interface, ring buffer, block
  engine, the fractional-delay-and-sum beamformer, a level/peak/clip meter.
- A **Node-native capture adapter** for the real 8-channel array (PortAudio via `naudiodon2`,
  device selection **by name**), behind a Node-only subpath.
- A **MockCaptureAdapter** (synthetic multichannel blocks) — the CI/test driver.
- Tests: deterministic, hardware-free, asserting beamformer behaviour against the existing
  `responseDb` design math.
- Docs: README "Live (Node)" section + CHANGELOG + a note in CLAUDE.md.

**Out (deferred):** the browser/Web Audio adapter; DOA / auto-steer / lock-to-seat; the cleaning chain
(AEC/dereverb/NR); the STFT/MVDR frequency-domain beam and null steering; multi-array / multikit.

## 4. Architecture

### 4.1 Module layout (mirrors the existing `/node` subpath seam)

```
src/live/                    # backend-agnostic CORE — pure, ZERO-DEP, browser-safe (no node:*)
  types.ts                   # CaptureAdapter interface, LiveConfig, BeamOutput, CaptureDevice
  ring-buffer.ts             # pre-allocated per-channel history ring (no per-block alloc)
  beam.ts                    # fractional-delay-and-sum: steerRealDelays, fracDelayKernel,
                             #   StreamingDelaySumBeam (process(block)->mono, reset())
  meter.ts                   # running RMS / peak-hold / clip level meter
  engine.ts                  # LiveEngine: adapter -> accumulate block -> beam -> mono + meter
  mock-adapter.ts            # MockCaptureAdapter (synthetic plane-wave blocks)
  index.ts                   # "./live" subpath barrel (all of the above)
src/live-node/
  naudiodon-adapter.ts       # NodeCaptureAdapter; LAZY-imports naudiodon2; enumerate POLARIS by name
  output-sink.ts             # minimal naudiodon2 output stream (default device) so the monitor is audible
  index.ts                   # "./live-node" subpath barrel
```

`package.json` `exports` gains two entries beside `.` and `./node`:
```jsonc
"./live":      { "types": "./dist/live/index.d.ts",      "import": "./dist/live/index.js" },
"./live-node": { "types": "./dist/live-node/index.d.ts", "import": "./dist/live-node/index.js" }
```
`./live` is import-safe in **both** Node and browser (no `node:*`). `./live-node` is Node-only.

### 4.2 Preserving the hard invariants

The repo's invariants are: ESM-only, **zero runtime dependencies**, runs in Node **and** browser, and
the main barrel `src/index.ts` must **never** import `node:*`.

- The core (`src/live/*`) and its tests are **genuinely zero-dependency** and browser-safe.
- The native addon `naudiodon2` is declared an **optional `peerDependency`** (`peerDependenciesMeta:
  { naudiodon2: { optional: true } }`), so `dependencies: {}` stays empty — the package still ships
  **zero hard runtime deps**. The consumer installs `naudiodon2` only if they use `./live-node`.
- `naudiodon-adapter.ts` **lazy-imports `naudiodon2` inside a method** (not at module top level) and
  throws a clear install hint if it's missing — exactly mirroring the Python `[control]` extra and the
  existing `availableBackends()`/install-hint pattern.
- `src/index.ts` is **not** touched for the Node path. (Optionally it may add a pure
  `export * as live from './live/index.js'` namespace for discovery, since the core is browser-safe;
  decided in the plan.)

### 4.3 The beamformer (the technical crux)

The **offline** `src/beamformer` produces **narrowband** complex weights at a single design frequency
(`DEFAULT_DESIGN_FREQ_HZ = 1000`). Those weights **cannot** be applied to broadband time-domain audio:
the steering phase is frequency-dependent, so 1000-Hz weights misalign every other frequency (spatial
aliasing below, grating lobes above). This is why the offline layer re-solves weights *per octave band*
for verification.

Phase 1 therefore implements **fractional-delay-and-sum in the time domain** (the Python live engine's
`MODE_FRACDELAY`), which is frequency-invariant:

1. **`steerRealDelays(geom, unit, fs)`** — for plane-wave direction `u`, each active capsule `m` at
   position `p_m` gets delay `d_m = (p_m·u − min_k p_k·u) / c · fs` samples (earliest-arriving capsule
   delayed most, so all align on the farthest). Reuses `ArrayGeometry`/`sensibel8`/`SOUND_SPEED_MPS`
   and `activeIndices()` (dead-capsule mask). Port of `polaris_beamformer.py:245–280`.
2. **`fracDelayKernel(frac, taps=15)`** — Hann-windowed sinc FIR for the sub-sample remainder,
   normalized to unity DC; `frac==0` → unit impulse at center. Port of `polaris_beamformer.py:411–428`.
3. **`StreamingDelaySumBeam`** — per-channel **integer-delay ring** + **fractional FIR continuity tail**;
   `process(block: Float32Array[]) -> Float32Array` (mono), `reset()`. Split each `d_m` into integer
   (ring read) + fractional (FIR convolve), accumulate, normalize by active count, carry the `L-1`
   tail. Port of `polaris_beamformer.py:431–501`. Latency ≈ 0.16 ms.

Steering is set via a `plan/commit` split so the (cheap, here) delay computation stays off the audio
callback in spirit and matches the Phase-2 DOA model. Off-nadir is fixed at 90° (planar array can't
resolve elevation). Beam output is low-passed at the spatial-aliasing cutoff (~5.6 kHz) — carried as a
config knob, default on, to suppress grating lobes (matches the Python default).

### 4.4 CaptureAdapter contract

```ts
interface CaptureDevice { id: string; name: string; maxInputChannels: number; defaultSampleRate: number }

interface CaptureAdapter {
  enumerate(): Promise<CaptureDevice[]>;                 // for name-based selection (never a hardcoded index)
  start(opts: { deviceName: string; channels: number; sampleRate: number;
                onBlock: (channels: Float32Array[], sampleRate: number) => void }): Promise<void>;
  stop(): Promise<void>;
}
```
Both `NodeCaptureAdapter` and `MockCaptureAdapter` implement this identically. The device is selected
**by name** ("Digital Audio Interface (SB-POLARIS)") because indices re-enumerate per process/host-API
— a hard rule from the workspace. `onBlock` delivers de-interleaved per-channel `Float32Array`s.

### 4.5 Data flow

```
CaptureAdapter.onBlock(channels[8], fs)
  → LiveEngine accumulates into a fixed block (default 32 ms ≈ 1410 @ 44.1 kHz)
  → StreamingDelaySumBeam.process(block)  → mono Float32Array
  → band-limit (≤ ~5.6 kHz)               → meter.update(mono)  (RMS / peak / clip)
  → emit { mono, levelDb, peakDb, clipped, steeringDeg }  to the caller (playback / UI)
```
The **core's** contract ends at producing the mono block + meter (pure, browser-safe). **Playback** is
a `live-node` concern: the Node side includes a minimal **output sink** (a `naudiodon2` output stream
to the default device) so the Phase-1 monitor is actually audible end-to-end on headphones. Keeping
playback out of the core preserves the core's purity; keeping it in `live-node` satisfies the
"audible monitor" success criterion.

## 5. Real-time safety rules (encoded + reviewed)

JS is single-threaded, so the Python lock-across-DSP concern is lighter, but the rules still hold:
- **No allocation in the hot path** — ring buffers, FIR tails, and the mono out buffer are
  pre-allocated and reused (`.fill(0)`), sized at `start()`.
- **No heavy work in `onBlock`** — Phase 1 beam is pure delay-sum (no FFT); steering re-planning
  happens out of band.
- **Immutable config snapshots + atomic rebind** — changing steering/active-mask swaps a frozen config
  object by assignment, never mutates in place (avoids torn reads if a worker is later introduced).
- **Bit-exact pass-through when off** — the band-limit/meter and every future optional stage return the
  *same* array object when disabled (the Python convention that keeps tests byte-identical).

## 6. Testing strategy (hardware-free, CI-safe)

vitest, Node env, **no audio device in CI**. Mirrors the existing pure-DSP test style
(`test/beamformer.test.ts`).

- **`MockCaptureAdapter`** feeds pre-allocated synthetic multichannel blocks — a plane wave delay-
  steered from a known azimuth onto `sensibel8` geometry.
- **Core test cases:**
  1. A beam steered **at** the synthetic source reinforces vs steered **away** attenuates by a clear
     margin (≥ ~10 dB), cross-checked against `responseDb(weights, geom, u, f)`.
  2. `steerRealDelays` is correct & symmetric (known geometry/direction → known sample delays).
  3. `fracDelayKernel(0)` is a unit impulse at center; non-zero `frac` shifts a test impulse by the
     expected sub-sample amount (group-delay check).
  4. `StreamingDelaySumBeam` is sample-exact across block boundaries (no clicks): streaming a signal in
     blocks equals processing it whole.
  5. Dead-capsule mask (capsule 5) → that channel excluded, output well-defined.
  6. Meter: RMS/peak/clip values correct on known signals; clip flag on full-scale.
  7. Config atomic rebind: re-steering doesn't mutate the prior frozen config.
- **Not in CI:** real device capture (the `naudiodon2` path). Gated behind an env flag
  (`LIVE_DEVICE_TEST`), skipped by default, validated live on the POLARIS. The native adapter's
  non-DSP logic (enumerate-by-name selection, error/install-hint) is unit-tested with `naudiodon2`
  stubbed.

## 7. Deliverables & staged commits

1. `feat(live): pluggable capture core + fractional-delay-and-sum beamformer` (`src/live/*` + tests).
2. `feat(live-node): Node-native POLARIS capture adapter + output sink (naudiodon2, lazy/optional)`
   (`src/live-node/*` + `package.json` exports + optional peerDep + stubbed adapter tests).
3. `docs: live (Node) section in README + CHANGELOG + CLAUDE.md note`.
4. CI: the existing workflow already runs `npm test`/typecheck/build; no live device in CI (the core
   tests are pure). Add a note that `./live-node` needs `naudiodon2` + a C++ toolchain.

## 8. Risks / unknowns to validate during build

- **`naudiodon2` build**: needs a C++ toolchain (node-gyp) unless prebuilt; `audify` (RtAudio,
  prebuilt) is the documented fallback if install-time build is a problem. Validate on Windows with
  the real array first.
- **POLARIS enumeration**: confirm `getDevices()` exposes the array by the expected name and ≥8 input
  channels; indices re-enumerate per process (select by name only).
- **Fractional-delay kernel / ring boundaries**: classic off-by-one click sources — covered by the
  sample-exact streaming test (case 4).
- **Synthetic vs far-field**: a delay-steered test signal isn't a true far-field plane wave; assert
  against `responseDb` tolerance (±~1 dB), not absolute numbers.
- **Sample rate**: device 44.1 kHz; engine is rate-parameterized (block size scales with `fs`).

## 9. Success criteria

- `npm run typecheck`, `npm test`, `npm run build` all green; core tests prove the beam reinforces
  on-axis and attenuates off-axis without any hardware.
- `import { LiveEngine, MockCaptureAdapter } from 'conferencing-audio-pipeline/live'` works in a
  browser-safe bundle (no `node:*`).
- On the real kit, `./live-node` enumerates the POLARIS by name, captures 8 channels, and a steered
  beam is audible on headphones — the Phase-1 "live beam monitor", matching the Python engine's
  delay-sum path.
- `dependencies: {}` unchanged — the zero-hard-dependency invariant is intact.

## References (research, file:line)

- Python live core: `conf_pipeline_control/polaris_beamformer.py:72–96` (constants), `245–280`
  (`_steer_real_delays`), `411–428` (`_frac_delay_kernel`), `431–501` (`_FracDelaySumBeam`), `1728–1795`
  (`process_block` stage contract / RT safety), `1910–1951` (`reset_transient`).
- TS offline beamformer (narrowband, reuse geometry): `src/beamformer/beamformer.ts:69–83`
  (`steeringVector`), `src/beamformer/geometry.ts:19–20` (`SOUND_SPEED_MPS`), `99–145`
  (`ArrayGeometry`, `activeIndices`, `sensibel8`).
- Packaging seam: `src/node.ts:1–16`, `src/control-api/server.ts:20`, `package.json` exports `13–21`.
- Node addon: `naudiodon2` (Apache-2.0, N-API, `getDevices()` by name); `audify` (RtAudio, prebuilt)
  fallback.
- Browser limit: MDN `MediaStreamAudioSourceNode` / W3C MediaCapture — no discrete-channel access.
