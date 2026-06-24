# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`conferencing-audio-pipeline` is a **configuration / signal-routing / validation control plane** for a
networked-conferencing audio system, in framework-agnostic, ESM-only, **zero-runtime-dependency**,
strict TypeScript. It models the chain:

```
mic coverage zones → signal-routing matrix → AEC reference + automix DSP config → outputs
```

**It is NOT a real-time audio DSP engine.** It models *what connects to what* and enforces the domain
rules; it does not process, mix, cancel, or stream audio. AEC, automix gating, NLP, and DSP blocks are
represented as **configuration + validation logic only**. Device models are generic (no vendor
firmware/protocol); "Dante" is only a transport *type label*. The value of the module is the domain
rules it catches at design time — above all the AEC self-reference rule (below).

This repo is the **TypeScript sibling** of `c:\Work\conferencing-audio-pipeline-py` (Python). See the
cross-project schema-parity constraint at the end — it is a hard invariant, not a nicety.

## Commands

```bash
npm install
npm test                        # vitest run (394 tests across 34 files)
npm run test:watch              # vitest (watch)
npx vitest run test/aec.test.ts # one test FILE
npx vitest run -t "self-reference"   # one test by NAME (substring)
npm run typecheck               # tsc --noEmit (strict; the real gate, build emits but typecheck checks test/ too)
npm run build                   # tsc -p tsconfig.build.json → dist/ (ESM + .d.ts), excludes test/
npm run web                     # build then serve the browser configurator at http://localhost:5174
npm run serve                   # serve an already-built dist/ (index.html)
npm run demo                    # headless AEC trap/fix walkthrough (run npm run build first)
```

There is no linter or formatter step — `tsc` strict mode is the static gate. `index.html` is a hand-rolled
single-page app (no framework, no bundler) that imports the built `dist/` directly, which is why the
browser configurator requires a prior `npm run build`.

## The AEC self-reference rule (the heart of the module)

Each mic's AEC needs a **reference** equal to what the loudspeakers are playing — *but the reference must
not contain that mic's own signal*, or the AEC cancels the mic against itself and silently destroys its
audio. This is the single most damaging conferencing misconfiguration and produces no obvious error.

`validate()` enforces it by **tracing actual source signals** to a mic's reference bus: from the reference
output bus, back through enabled matrix crosspoints to input buses, back through routes to source devices —
answering "is this mic in here?". Codes: `AEC_SELF_REFERENCE` (error), `AEC_REINFORCED_SHARED_REFERENCE`
(error; the reference IS the speaker-feed bus carrying the reinforced mic), `AEC_REFERENCE_MISSING` /
`AEC_REFERENCE_EMPTY` (warnings). The tracer lives in [src/dsp/aec.ts](src/dsp/aec.ts) (`analyzeAecReference`,
`sourcesFeedingOutputBus`); the canonical end-to-end scenario is [test/integration.test.ts](test/integration.test.ts).
Any new auto-* helper (`autoConfigure`, `autoRoute`, `optimizeRoom`) must **never** route a mic into an AEC
reference bus — they are written to keep `validate().errors` empty, and tests assert it.

## Architecture (the big picture)

A directed **signal graph**: devices ([src/model/devices.ts](src/model/devices.ts)) expose typed **ports**
([src/model/ports.ts](src/model/ports.ts)) connected by **routes**. Inside the single primary `Processor`, a
**matrix mixer** of crosspoints ([src/matrix/matrix.ts](src/matrix/matrix.ts)) connects input buses to
output buses. **Buses map 1:1 to processor ports (bus id === port id)**, so AEC reference resolution is a
deterministic two-hop trace. AEC, the automixer, and mute links are config objects layered on top.

Key structural facts that span files:

- **Two entry points, deliberately split for browser safety.**
  [src/index.ts](src/index.ts) is the main barrel — pure, **must never import `node:*`** (it would break
  browser bundles). [src/node.ts](src/node.ts) is the `conferencing-audio-pipeline/node` subpath entry and
  is the *only* place Node built-ins (`node:http`, `node:fs`) are used: `ControlApiServer` (localhost
  JSON-over-HTTP scene/mute/status, [src/control-api/server.ts](src/control-api/server.ts)) and
  `ProjectFileManager`. Neither adds an npm dependency. If you add a Node-only feature, wire it through
  `node.ts`, not the barrel.

- **Every builder is pure.** All functions in `index.ts` (and the subsystem builders they wrap) return a new
  `SystemConfig` and never mutate the input. Follow this — code and tests rely on it (e.g. `autoRoute`
  detects "no change" by comparing `serialize(next) === serialize(config)`).

- **`validate()` is the single source of correctness.** One pure, deterministic
  [src/validation/validate.ts](src/validation/validate.ts) → `{ ok, errors, warnings }`; `ok` is true iff
  zero errors. The code catalog is [src/validation/codes.ts](src/validation/codes.ts) and is mirrored in the
  README table. Coverage-mode switches **regenerate** an array's output ports; routes to removed ports are
  **kept and reported** as `ORPHANED_ROUTE`, never silently dropped.

- **Coverage modes drive port shape.** A `microphoneArray`'s output ports are derived from its
  `coverageMode` (automatic → one mixed output; manual → one per lobe, capped at 8). Up to 8 zones per array:
  `dynamic` (`alwaysOn=false`), `dedicated` (`alwaysOn=true`), `exclusion` (no-pickup region). The
  `alwaysOn`↔type invariant is validated. See [src/coverage/](src/coverage/).

- **Persistence is a lossless migration chain.** [src/persistence/serialize.ts](src/persistence/serialize.ts):
  `JSON.stringify`/`parse` round-trips because the config is plain data (no Maps/Sets/Dates). `deserialize`
  runs `migrateV1ToV2 → … → migrateV4ToV5`; **each step is lossless, additive, omit-when-absent, and bumps
  exactly one version.** `CONFIG_VERSION` lives in [src/model/config.ts](src/model/config.ts) (currently 5).

- **The offline beamformer is pure design math.** The `beamformer` namespace
  ([src/beamformer/](src/beamformer/)) is pure-stdlib complex-number math for a real array (geometry like
  `sensibel8`, zone→steering, delay-and-sum / superdirective / LCMV weights, DI/WNG/lobe analysis, octave-band
  verification). It *designs and verifies* beam patterns; it does not capture or stream — real-time capture +
  beamforming is the separate **live layer** (next bullet). The **DOA / auto-steer / cleaning / OCTOVOX**
  layers remain Python-only (numpy/sounddevice) and are not ported here.
  Likewise `recommendPlacement`/`scoreHeatmap` ([src/sim/](src/sim/)) are heuristic and numpy-free;
  `validateRecommendation` simply reports that no numerical-physics backend is installed.

- **Live audio (`src/live/` + `src/live-node/`, Phase 1).** A real-time fractional-delay-and-sum
  beamformer. `src/live/` is pure/zero-dep/browser-safe (exposed as `./live`); `src/live-node/` is
  Node-only (`./live-node`) and lazy-imports the optional `naudiodon2` addon — `dependencies` stays
  `{}`. The offline `src/beamformer` narrowband weights are NOT used live (wrong for broadband);
  the live beam aligns capsules by geometric delay. Browser 8-ch capture is infeasible (getUserMedia
  downmixes to stereo) — the live path is Node-only. Tests are hardware-free via `MockCaptureAdapter`.

- **Live steering (Phase 2, `src/live/{fft,covariance,doa,tracker,autosteer}.ts`).** SRP-PHAT DOA
  over a 2° azimuth grid (band 300–3800 Hz), fed by a built-in radix-2 `rfft` + a streaming
  spatial-covariance accumulator, drives a wrap-aware hold/switch tracker that re-aims the single
  delay-sum beam at the dominant in-sector talker (or a locked seat). Opt-in via `LiveConfig.autoSteer`
  (default `manual` = Phase-1 unchanged); still zero-dep (the FFT is pure TS). Azimuth-only (off-nadir
  90°; a planar ring can't resolve above/below the plane); multi-talker/nulling is a later
  frequency-domain phase.

- **Post-beam noise suppression (Phase 3a, `src/live/{spectral-processor,omlsa,level-preserving-cleaner}.ts`
  + `irfft` in `fft.ts`).** A streaming Hann overlap-add STFT (512/256) with a VAD-independent
  minimum-statistics noise floor and gate/OM-LSA/Wiener gain laws (the exponential integral is vendored —
  still zero-dep), plus a speech-gated level-preserving makeup so the talker stays full. Opt-in via
  `LiveConfig.cleaning` (default `off` = Phase-2 unchanged); the cleaning stage runs after the beam and
  before the meter. ~12 ms latency when active. Dereverb/AEC/AGC are later sub-phases; DFN3 needs ONNX
  (deferred, optional).

- **Dereverb (Phase 3b, `src/live/dereverb.ts` + `cleaner-chain.ts`).** A `StreamingDereverb` extends the
  Phase-3a STFT base and overrides the gain law with Lebart/Habets late-reverb spectral subtraction
  (`G = max(1 − β·R/P, Gmin)`; `R` = a T60-decayed delayed-power estimate). It runs **before** the denoiser
  via an ordered `ChainedCleaner` (matching the Python chain order). Opt-in via `LiveConfig.cleaning.dereverb`
  (default off = Phase-3a unchanged); still zero-dep. AEC/AGC/PEQ are later sub-phases.

## Conventions

- **Relative imports carry a `.js` extension** even though sources are `.ts` (ESM resolution). Match this —
  `import { x } from './foo.js'` from `foo.ts`. `verbatimModuleSyntax` is on, so use `import type` for
  type-only imports.
- **`tsconfig` is maximally strict**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`/`noUnusedParameters`, `noImplicitAny`. Because of `exactOptionalPropertyTypes`, optional
  fields are added with the **omit-when-absent spread** pattern (`...(x !== undefined ? { x } : {})`), not
  `{ x: undefined }`. This pattern is everywhere in `index.ts`; keep it.
- The domain model is a **discriminated union** on `Device.type`; narrow with the guards in
  [src/model/devices.ts](src/model/devices.ts) (`isMicDevice`, `isProcessor`, `isCamera`).
- Tests are vitest in [test/](test/), one file per subsystem plus version-parity files
  (`serialization.test.ts`, `designer-1.8.test.ts`, etc.).

## Cross-project schema parity (hard constraint)

This repo and `c:\Work\conferencing-audio-pipeline-py` share the **same JSON config schema** —
`CONFIG_VERSION = 5`, **camelCase keys on the wire**. There is no standalone `.json` schema document: the two
codebases ARE the schema and are kept in sync by review. The **TypeScript side is the type-level source of
truth** (`src/model/*.ts`, migrations in `src/persistence/serialize.ts`); the Python side maps snake_case
dataclasses ⇄ camelCase JSON.

**Any change to a serialized field must be made in BOTH repos**: same field name, same `CONFIG_VERSION` bump,
and an additive migration that sets its own explicit target version — otherwise old files silently break.
Migrations must be additive and omit-when-absent so prior-version documents round-trip byte-identically (the
existing `migrateV*ToV*` functions are the template).

## Git

Remote is `New` → `Confrencing_Audio` (not `origin`). Work happens on `master`. Push only when explicitly
asked.
