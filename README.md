# Conferencing Audio Pipeline

A production-grade, **framework-agnostic TypeScript** module that models and
validates the configuration of a networked-conferencing audio system:

```
mic coverage zones  →  signal-routing matrix  →  AEC reference + automix DSP config  →  outputs
```

ESM-only, zero runtime dependencies, runs in Node and the browser. Strict
TypeScript throughout (`no any`, discriminated unions, `exactOptionalPropertyTypes`).

---

## ⚠️ Scope boundary — read this first

This is a **configuration and signal-routing control plane**. It models *what
connects to what* and validates that the configuration is correct. It is **not**
a real-time audio DSP engine.

- It does **not** process, mix, cancel, or stream real audio.
- **AEC, automix gating, and NLP are represented as configuration and validation
  logic, not DSP implementations.** Real echo cancellation requires a
  hardware/DSP audio engine outside this module's scope.
- Device models are **generic** (microphone array, processor, wireless/wired
  mic, loudspeaker, codec). They are modeled on common conferencing-system
  behavior and are **not** any specific manufacturer's firmware, protocol, or
  product. **"Dante" is used only as a transport *type label*; no proprietary
  protocol is implemented.**
- Coverage geometry is a **planning abstraction**, not a beam-forming or
  acoustic simulation.

The value of this module is the **domain rules** it enforces — above all the AEC
reference rule below — so that invalid configurations are caught at design time.

---

## The AEC reference rule (the heart of this module)

Acoustic Echo Cancellation (AEC) on a microphone removes, from that mic's
signal, whatever the room's loudspeakers are emitting. To do this, each mic's AEC
needs a **reference** signal equal to *what the speakers are playing* —

> **…but the reference must NOT contain that microphone's own signal.**

If a microphone is routed to the loudspeakers (local **sound reinforcement**) and
its AEC reference *also* contains the mic, the AEC will cancel the mic **against
itself**, silently destroying its audio. This is the single most common and most
damaging misconfiguration in conferencing systems, and it produces no obvious
error — the audio just sounds wrong.

### How the rule plays out

- **Non-reinforced mics** (e.g. ceiling arrays not sent to the local speakers)
  can use the default reference — the far-end / speaker-feed signal — because
  that signal does not contain them.
- **A reinforced mic** (e.g. a presenter mic sent to the loudspeakers) needs a
  **dedicated reference bus built from only the far-end sources** — explicitly
  excluding the mic itself. In practice you route the far-end-only signal to an
  unused processor output bus and point the mic's AEC reference at that bus.

### How the engine enforces it

For every mic with AEC enabled, the engine resolves the mic's reference bus and
**traces the actual source signals feeding it** through the routes and the matrix
crosspoints (`src/dsp/aec.ts`). Then:

| Condition | Result |
| --- | --- |
| Reference contains the mic's own signal | **error** `AEC_SELF_REFERENCE` |
| …and the reference bus is the very speaker-feed bus carrying the reinforced mic | **error** `AEC_REINFORCED_SHARED_REFERENCE` (the specialized "default-to-speaker-output" trap) |
| AEC enabled but no reference assigned | **warning** `AEC_REFERENCE_MISSING` |
| Reference bus resolves to zero sources | **warning** `AEC_REFERENCE_EMPTY` |

The worked integration test (`test/integration.test.ts`) builds the canonical
scene — two arrays + one reinforced wireless presenter mic + processor +
loudspeakers + codec — asserts it validates cleanly, and asserts that **removing
the dedicated far-end-only reference re-triggers the self-reference error.**

---

## Architecture

The model is a directed **signal graph** of devices, their typed **ports**, and
the **routes** between them. Inside the processor, a **matrix mixer** of
crosspoints connects input buses to output buses. AEC, the automixer, and mute
links are configuration objects layered on top.

```
src/
  model/         Strict types: geometry, ports, devices, matrix/buses, dsp, room, config
  matrix/        Pure crosspoint-matrix engine (set/route/clear/query)
  coverage/      Coverage zones + mode-driven output-port regeneration
  dsp/           AEC reference resolution, automixer config, mute linking
  validation/    validate(config) → typed errors + warnings; code catalog
  devices/       Generic device factories (processor, mics, loudspeaker, codec)
  persistence/   Versioned, lossless JSON serialize/deserialize
  index.ts       Builder-style public API
test/            Vitest unit + integration tests
```

### Signal-tracing model

```
source device output port  --Route-->  processor input port (= matrix input bus / row)
input bus  --matrix crosspoint-->  output bus (= processor output port / column)
output bus  --Route-->  sink (loudspeaker / codec), and/or used as an AEC reference
```

Buses map **1:1** to processor ports (bus id === port id), so AEC reference
resolution is a deterministic two-hop trace: from a reference output bus, back
through enabled crosspoints to input buses, back through routes to source
devices — answering "is the mic itself in here?".

---

## Subsystems

### Mic coverage (`src/coverage/`)
- **Automatic** mode → one mixed Dante output (`<id>-out-mix`).
- **Manual** mode → one Dante output per steered lobe (capped at **8**,
  `<id>-out-lobe-N`) plus one automix output (`<id>-out-automix`).
- Up to **8 zones** per array, mixable: **dynamic** (records talkers inside its
  resizable bounds; `alwaysOn=false`), **dedicated** (fixed-size, default ~1.8 m
  square, **always active**; `alwaysOn=true`), and **exclusion** (a **no-pickup**
  region that suppresses audio even where it overlaps a pickup zone — doorways,
  HVAC, windows; produces no output lobe, `alwaysOn=false`). Nothing **outside**
  any pickup zone is recorded, so zones define exactly where voice is and isn't
  captured.
- Switching mode **regenerates** the output ports. Routes that referenced removed
  ports are **kept and reported** as `ORPHANED_ROUTE` by `validate()` — never
  silently dropped.

### Matrix mixer (`src/matrix/`)
Pure, immutable crosspoint grid. `createMatrix`, `set`, `route`, `clear`, `get`,
`isActive`, `inputsForOutput`, `outputsForInput`, `activeCrosspoints`. Every
mutating op returns a new matrix; no audio.

### AEC + automixer + mute (`src/dsp/`)
- `analyzeAecReference()` / `sourcesFeedingOutputBus()` — the reference tracer.
- Automixer config: per-channel `alwaysOn`, `gatingSensitivity` (0..1), NLP level
  (`off|low|medium|high`), and an automix output bus. Stored & range-checked, not
  gated in real time.
- Mute links: mute state that resolves to which devices' indicators should light,
  with optional codec sync. State + logic only.

### Validation (`src/validation/`)
A single pure, deterministic `validate(config) → { ok, errors, warnings }`.

---

## Validation code catalog

| Code | Severity | Meaning |
| --- | --- | --- |
| `ORPHANED_ROUTE` | error | Route references a port id that does not exist (e.g. removed by a coverage-mode switch). |
| `ROUTE_TRANSPORT_MISMATCH` | error | Route connects mismatched transports (dante↔analog). |
| `ROUTE_DIRECTION_INVALID` | error | Route is not output→input. |
| `AEC_SELF_REFERENCE` | error | A mic's AEC reference contains the mic's own signal. |
| `AEC_REINFORCED_SHARED_REFERENCE` | error | A reinforced mic's AEC reference is the same speaker-feed bus that carries it. |
| `AEC_REFERENCE_MISSING` | warning | AEC enabled but no reference bus assigned. |
| `AEC_REFERENCE_EMPTY` | warning | AEC reference bus resolves to zero source signals. |
| `COVERAGE_ZONE_LIMIT` | error | More than 8 coverage zones on an array. |
| `COVERAGE_ZONE_INVALID` | error | Zone type/`alwaysOn` mismatch or degenerate geometry. |
| `MANUAL_LOBE_LIMIT` | error | Manual mode with more than 8 lobes/zones. |
| `AUTOMIXER_INVALID` | error | Automixer gating/NLP value out of range. |
| `DEVICE_PROFILE_UNKNOWN` | error | Device references a profile id not in the catalog. |
| `DEVICE_CAPABILITY_MISMATCH` | error | Device's profile does not apply to its type. |
| `DSP_BLOCK_UNSUPPORTED` | error | A DSP block kind is not supported by the device's profile. |
| `DSP_BLOCK_INVALID` | error | A DSP block has out-of-range/invalid parameters. |
| `DSP_TARGET_UNRESOLVED` | error | A DSP block's target bus does not resolve on the device. |
| `AEC_NO_FAR_END` | warning | AEC enabled but no far-end (codec) source exists. |
| `AUTOMIX_OUTPUT_UNSET` | warning | Mics exist but the automixer output bus is unset. |
| `MUTE_LINK_UNSUPPORTED` | warning | A mute link targets a device with no mute capability. |
| `DSP_CHAIN_NO_LEVEL` | warning | A device has DSP blocks but no gain/mute stage. |

`ok` is `true` iff there are **no errors** (warnings are allowed).

---

## Public API (`src/index.ts`)

All builder functions are **pure** — they return a new `SystemConfig` and never
mutate their input.

```ts
import {
  createConfig, addDevice, removeDevice,
  createProcessor, createWirelessMic, createWiredMic, createLoudspeaker, createCodec,
  createMicrophoneArray, dynamicZone, dedicatedZone,
  setCoverageMode, addCoverageZone,
  route, unroute, matrixFor,
  setAec, configureAutomixer, autoConfigure,
  validate, serialize, deserialize,
} from 'conferencing-audio-pipeline';

let cfg = createConfig({ name: 'Boardroom', createdAt: new Date().toISOString() });
cfg = addDevice(cfg, createProcessor('P', 'DSP'));
cfg = addDevice(cfg, createWirelessMic('PM', 'Presenter', 'dante'));
cfg = addDevice(cfg, createLoudspeaker('L', 'Speaker', 'analog'));
cfg = addDevice(cfg, createCodec('C', 'Codec', 'dante'));

cfg = route(cfg, 'PM-out-dante-1', 'P-in-dante-1');   // mic -> processor
cfg = route(cfg, 'C-out-dante-1',  'P-in-dante-2');   // far-end -> processor
cfg = route(cfg, 'P-out-analog-1', 'L-in-analog-1');  // speaker feed

cfg = matrixFor(cfg, 'P').route('P-in-dante-1', 'P-out-analog-1'); // reinforce presenter
cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-analog-1'); // far-end to speakers
cfg = matrixFor(cfg, 'P').route('P-in-dante-2', 'P-out-dante-2');  // far-end-ONLY reference bus

cfg = setAec(cfg, 'PM', { enabled: true, referenceBusId: 'P-out-dante-2' }); // safe reference

const result = validate(cfg);          // { ok: true, errors: [], warnings: [...] }
const json = serialize(cfg);           // versioned, lossless JSON
const restored = deserialize(json);    // round-trips exactly
```

### API reference

| Function | Purpose |
| --- | --- |
| `createConfig(meta)` | New empty config. Matrix/automixer bind to the first processor added. |
| `addDevice(config, device)` / `removeDevice(config, id)` | Add/remove a device (removing also drops routes touching it). |
| `createProcessor / createWirelessMic / createWiredMic / createLoudspeaker / createCodec` | Generic device factories with parameterized port counts. |
| `createMicrophoneArray(id, label, mode, zones?)` | Array with mode-derived output ports. |
| `dynamicZone(...)` / `dedicatedZone(...)` | Build coverage zones with the correct `alwaysOn`. |
| `setCoverageMode(config, arrayId, mode)` | Switch mode; **regenerates** ports (orphaned routes reported, not dropped). |
| `addCoverageZone(config, arrayId, zone)` | Add a zone (max 8). |
| `route(config, fromPortId, toPortId)` / `unroute(...)` | Add/remove a directed route (idempotent by endpoints). |
| `matrixFor(config, processorId)` | Accessor: `.set/.route/.clear` return a new config; `.get/.isActive` query. |
| `setAec(config, micId, { enabled, referenceBusId })` | Assign a mic's AEC reference (validation catches self-reference). |
| `setRoom(config, room)` / `clearRoom(config)` / `rectangularRoom(w, d, h?)` | Attach/remove/build the optional room layout (metres). |
| `setDevicePosition(config, deviceId, {x, y})` / `clearDevicePosition(...)` | Place a device (floor x, y) in room/coverage coordinates. |
| `setDeviceElevation(config, deviceId, m)` / `clearDeviceElevation(...)` / `defaultElevation(device, roomHeight?)` | Device height above floor (the 3D z); falls back to a per-type default. |
| `createTalker / addTalker / removeTalker / setTalkerPosition / setTalkerElevation / renameTalker` | Place and edit **talkers** (people speaking) — physical voice sources, not signal-graph devices. |
| `steeringAngles(source, target)` | Pure 3D geometry: azimuth, down-tilt, off-nadir angle, and distances between two points. |
| `arrayToTalkerAngles(config, arrayId, talkerId)` | Steering angles from a ceiling array down to a talker (resolves both elevations); `null` if unplaced. |
| `talkerCoverage(config, talkerId)` | Whether a talker is **recorded**: inside a pickup zone and not in an exclusion zone. |
| `setZoneShape(config, arrayId, zoneId, shape)` | Replace a coverage zone's geometry (e.g. after drawing/dragging it). |
| `configureAutomixer(config, processorId, automixerConfig)` | Replace the automixer config. |
| `autoConfigure(config)` | One-click sensible defaults; guaranteed to produce a config with **no validation errors**. |
| `validate(config)` | Pure, deterministic `{ ok, errors, warnings }`. |
| `serialize(config[, pretty])` / `deserialize(json)` | Versioned, lossless JSON round-trip. |

---

## Optional room interop

`SystemConfig.room` accepts an optional `RoomLayout` (`vertices`, `height`,
`units`, `objects`) shaped like a room-builder export. Coverage zones and device
positions may reference room coordinates when present — **but the pipeline
functions fully without a room.** Units are **metres** throughout.

## Visual configurator (browser)

A standalone single-page app — [`index.html`](index.html) — drives the whole API
live and validates on every edit. It imports the built `dist/` bundle directly.

```bash
npm run web        # builds dist/ then serves at http://localhost:5174
# (already built? npm run serve)
```

**Canvas (the hero):** a metre-grid stage with five tools —
- **Select** — drag devices, room vertices, and zones; resize zones by their corner handle; click a route line or marker to select it.
- **Connect** — click device → device to create a route (auto-picks compatible free ports by transport).
- **Room** — click to draw the outline (double-click to close), or use the width/depth/height quick-build.
- **Place** — click to position a device (new devices auto-place).
- **Zone** — drag a dynamic zone or click a dedicated one onto an array.

Routes render as **transport-colored signal-flow arrows** between placed
devices; validation **errors glow red** on the offending markers/routes, and
clicking an issue highlights and selects it.

**2D / 3D toggle** (`2` / `3`): the same scene renders in a top-down plan **or**
a fully orbitable **3D room** (hand-rolled projection, no Three.js). In 3D, drag
to orbit, scroll to zoom, click a device/talker to select, and drag it across the
floor plane to move it; ceiling arrays, speakers, and table mics sit at their
real heights (per-device elevation, editable in the inspector, with sensible
per-type defaults). Devices drop a pole to the floor and depth-sort correctly.

**Talkers & steering angles:** add **people** (talkers) from the Build tab's
*People* card and drag them into place (2D or 3D). Each talker shows a
**capture badge** — *recorded* (inside a pickup zone), *excluded* (inside a
no-pickup zone), or *not covered* (no pickup zone). Selecting a talker draws a
ray from every array to the person, labeled with the **off-nadir angle and
distance**, and the inspector lists the full **azimuth / down-tilt / off-nadir /
distance** per array — the geometry you need to plan beam steering and check
whether a talker falls inside an array's coverage cone.

**Inspector tabs:** Build (add/select/rename devices, coverage modes & zones),
Routing (route list + clickable crosspoint matrix), AEC/DSP (per-mic references +
automixer NLP/gating/always-on), Issues, and live JSON.

**Throughout:** undo/redo (`Ctrl+Z` / `Ctrl+Y`, full history), keyboard shortcuts
(`V/C/R/D/Z` tools, `Del` delete, `Esc` cancel, `Alt+A` auto-configure), sample
scenarios, snap-to-grid, and export to JSON / PNG / clipboard.

A tiny zero-dependency static server ([`serve.mjs`](serve.mjs)) hosts it because
browsers block ES-module imports over `file://`. A headless Node walkthrough of
the AEC trap/fix is in [`demo.mjs`](demo.mjs) (`npm run demo`, after `npm run build`).

---

## Develop

```bash
npm install
npm test          # vitest run — 38 tests
npm run typecheck # tsc --noEmit (strict)
npm run build     # emit ESM + .d.ts to dist/
```

### Test coverage highlights
- **AEC self-reference** — positive (plain + reinforced-shared) and negative cases.
- **Coverage** — 8-zone limit, dedicated/dynamic `alwaysOn` invariants, geometry.
- **Mode switch** — port regeneration + orphaned-route detection.
- **Matrix** — crosspoint set/route/clear/query + immutability.
- **JSON round-trip** — lossless serialize/deserialize + version/shape guards.
- **Integration** — the worked reference scenario, end to end.

## Device profiles & DSP blocks (1.7.0)

Each device carries a vendor-neutral **capability profile** (`profileId`) from a
generic catalog (`DEVICE_PROFILES`) — ceiling/table array, wireless/wired mic,
hardware/software DSP, loudspeaker, codec, mute-control. The profile derives the
device's **capabilities** (AEC, automix, mute, supported DSP blocks, coverage
limits); capabilities are never edited per device. Assign with
`assignDeviceProfile`; validation flags unknown profiles and type mismatches.

Devices also carry an ordered **DSP block chain** (`dspBlocks`) — `gain`, `mute`,
`peq4`, `agc`, `compressor`, `delay`, `noiseReduction`, `deverb` — with typed,
range-checked parameters (settings only; **no audio is processed**). Build with
`createDspBlock` and the pure helpers `addDspBlock`, `updateDspBlock`,
`removeDspBlock`, `setDspBlockEnabled`; a block may target a processor bus
(`targetBusId`). Validation flags unsupported kinds, out-of-range params, and
unresolved targets, plus soft commissioning warnings. In the UI these live in the
device inspector (profile + capability hint) and the **Processing blocks** /
**Mute / logic** sections of the AEC/DSP tab.

**Schema version 2.** Configs serialize as `version: 2`; v1 documents load via
automatic migration (default profile + empty DSP chain per device).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the version history.

## License

MIT.
