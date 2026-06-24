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
| `COVERAGE_CHANNEL_INVALID` | error | Coverage-area output channel out of range or on an exclusion zone. |
| `COVERAGE_CHANNEL_DUPLICATE` | error | Two coverage areas on an array share an output channel. |
| `COVERAGE_GAIN_INVALID` | error | Coverage-area gain trim is out of range. |
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
| `NAMING_DUPLICATE_LABEL` | warning | Two or more devices share the same label. |
| `NAMING_EMPTY_LABEL` | warning | A device has an empty label. |
| `CONTROL_MUTE_GROUP_INVALID` | error | A mute group references a missing device/area, or is empty. |
| `SCENE_INVALID` | error | A scene is empty, duplicates an id, or references a missing group/array/area. |
| `SCHEDULE_INVALID` | error | A scene schedule has a bad time/day, duplicate id, or recalls a missing scene. |
| `FURNITURE_GEOMETRY_INVALID` | error | A furniture object has non-positive width/depth. |
| `FURNITURE_OUTSIDE_ROOM` | warning | A furniture object is placed outside the room outline. |
| `DEVICE_INSIDE_FURNITURE` | warning | A device sits inside a furniture object's footprint, below its top. |
| `CAMERA_UNPLACED` | warning | A conferencing camera has no position in the room. |
| `CAMERA_NO_SUBJECT` | warning | A placed camera's field of view frames no talker or seat. |

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
npm test          # vitest run — 332 tests
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

## Designer-inspired workflow (1.8.0)

Vendor-neutral, configuration/validation-only features modeled on professional
networked-audio design tools (still **no** real-time audio, Dante control, device
discovery, firmware, or network I/O):

- **Projects (multi-room)** — a `Project` holds several named rooms (each a
  `SystemConfig`) with versioned, round-trippable JSON. In the browser app, a
  **rooms bar** lets you add/switch/rename/remove rooms.
- **Deployment** — a config-only `design`/`online`/`deployed` state plus a pure
  `deploymentDiff(base, target)` (what would change on deploy). The **Deploy**
  button marks the room deployed and toasts the diff.
- **Naming** — `applyNamingScheme` / `suggestedLabel` and duplicate/empty-label
  warnings; an **Auto-name** button.
- **Routing views** — `routingSummary`, `danteSubscriptions`, `signalFlowReport`
  surfaced in a **Routing summary / Dante hub** panel.
- **Device templates** — capture a configured device (profile + DSP chain) and
  stamp out copies (`deviceTemplate` / `instantiateTemplate`).
- **Light/dark theme** toggle.

## Simulation, reports, scenes & commissioning (1.9.0 – 1.15.0)

A feature-parity port of the Python engine's later milestones. All
framework-agnostic and **zero runtime dependency**; the JSON schema is now **v3**
and interoperates with the Python version (v1/v2 documents migrate losslessly).

- **Coverage reports** — `coverageReport(config)` returns covered / uncovered /
  overlapping arrays from each array's floor pickup circle (mount height × profile
  cone angle); `zoneCoverageReport(config)` answers, per drawn coverage *area*,
  "is it inside its array's pickup circle?" and flags automix **lobe contention**
  (an area covered by 2+ arrays). `arrayCoverageCircle` / `arrayCoverageRadius`.
- **Design report** — `designReport(config, 'markdown' | 'html')` produces a
  shareable doc (room + RT60, devices, routing, AEC, coverage areas, mute groups,
  validation). HTML conversion is dependency-free.
- **Commissioning / as-built report** — `commissioningReport(config, info?, 'markdown' | 'html')`
  layers measured live state onto the as-built design report (`CommissioningInfo`: estimated
  latency vs target, AEC/ERLE, A/B noise-bed proof, capsule health, front calibration) and
  derives a pass/fail **sign-off checklist** + hand-sign form. All `info` fields are optional —
  an empty info yields the config-only report plus a blank sign-off.
- **Auto-Route / Optimize-room** — `autoRoute(config)` one-click optimises (AEC
  references + automixer + near-end send, then far-end → loudspeakers and a synced
  mic mute-link) with a change summary; `optimizeRoom(config, opts)` additionally
  recommends + applies each array's placement and channels every coverage area.
  Both are **idempotent** and never break the AEC self-reference rule.
- **Per-coverage-area output channels + gain** — a pickup zone may carry its own
  numbered `outputChannel` (1..8, MXA920-style steerable coverage; grows an
  `<id>-out-ch-N` port) and a `gainDb` trim. `setZoneOutputChannel`,
  `setZoneGainDb`, `autoAssignZoneChannels`.
- **Logic / mute control** — `ControlConfig` + `MuteGroup` model a named set of
  devices and/or coverage-area channels that mute together
  (`createMuteGroup`, `addMuteGroup`, `setMuteGroupMuted`, …).
- **Scenes (schema v3)** — named, recallable snapshots of the control surface
  (mute states + per-area gains, plus config-inert `active`/`steer` live-layer
  hints). `captureScene`, `recallScene`, `createScene` / `addScene` / `getScene`.
- **Scene schedules** — recall a scene at a local `"HH:MM"` on chosen weekdays;
  `SceneScheduler` (injectable clock, manual `runPending()` tick, `nextFire`).
- **Floor-plan background** — `setRoomBackground` + `calibratedScale` (drag a line
  over a known distance to derive metres-per-pixel).
- **Placement simulation** — `recommendPlacement` / `scoreHeatmap` /
  `estimatedRt60`: a heuristic optimiser blending direct-path SNR, DRR,
  coverage/on-axis, and multi-talker fairness with a coarse-to-fine joint search.
  Pure (no numpy); `validateRecommendation` reports that no numerical physics
  backend is installed (those backends are Python-only).
- **Commissioning transport seam** — `SimulatedTransport` + `pushToOnline` /
  `reconcileOnline` / `onlineRoomStatus` model "deploy to online devices" (push,
  read back, reconcile device-reported vs designed) with no real network I/O.
- **Beamformer DESIGN layer** (`beamformer` namespace) — pure complex-number DSP
  for an actual array microphone: geometry (`sensibel8`, `withActiveChannels`),
  zone → steering, delay-and-sum / superdirective (diffuse-noise MVDR) weights,
  DI / WNG / lobe analysis, and octave-band wideband verification
  (`designZoneBeams`, `beamPatternAzimuth`, `analyzeLobes`, `frequencyCurves`). The
  *live* capture / DOA / OCTOVOX layers stay Python-only (they need numpy/sounddevice).

```ts
import { autoRoute, designReport, captureScene, recallScene, beamformer } from 'conferencing-audio-pipeline';
```

### Node-only features (`conferencing-audio-pipeline/node`)

A local HTTP control API and a project file manager live behind a separate
subpath entry, so the core stays browser-safe (no `node:*` imports leak into a
browser bundle). They build on Node's built-in modules — **no npm dependency**.

```ts
import { ControlApiServer, ConfigHolder, ProjectFileManager } from 'conferencing-audio-pipeline/node';

const holder = new ConfigHolder(config);
const srv = new ControlApiServer(() => holder.get(), (t) => holder.apply(t));
await srv.start();   // GET /api/status · GET /api/scenes
                     // POST /api/scenes/<id>/recall · POST /api/mute-groups/<id> {"muted": true}
```

## Cameras, furniture & coverage simulation (1.16.0)

Schema **v4** adds room-design coverage modeling (still vendor-neutral, offline,
zero-dependency; v1–v3 documents migrate losslessly):

- **Conferencing cameras** — a `camera` device type (`createCamera` / `addCamera`)
  with a pose (`bearingDeg` / `tiltDeg`) and a `CameraSpec` (FOV / range) on its
  profile. Aim with `setCameraBearing` / `setCameraTilt`; loudspeakers gain
  optional aim too (`setSpeakerBearing` / `setSpeakerTilt`, with a `SpeakerSpec`
  dispersion cone).
- **Furniture** — `RoomObject` gains real geometry (`width`/`depth`/`height`/
  `rotationDeg`), `seats` (`SeatAnchor`s — implied camera/mic targets), acoustic
  `absorption`, and occlusion flags. A catalog (`FURNITURE_CATALOG`) supplies
  per-kind defaults. Build/edit with `addFurniture`, `setFurniturePosition` /
  `…Rotation` / `…Dimensions`, `setSeatAnchors`, `removeFurniture`.
- **Room coverage simulation** — `simulateRoomCoverage(config)` returns, per placed
  device, a mic's steered-pickup beams, a camera's field-of-view (with
  **height-aware furniture occlusion** — a ceiling camera sees over a low table; a
  soundbar camera is blocked by a screen), and a loudspeaker's dispersion, plus an
  aggregate coverage / framed-percentage summary and the honest geometric caveats.
- **Validation** — `CAMERA_UNPLACED`, `CAMERA_NO_SUBJECT`, `FURNITURE_OUTSIDE_ROOM`,
  `FURNITURE_GEOMETRY_INVALID`, `DEVICE_INSIDE_FURNITURE`.

```ts
import { createCamera, addCamera, setCameraBearing, addFurniture, simulateRoomCoverage } from 'conferencing-audio-pipeline';
```

**Schema v5** additionally gives `MicrophoneArray` an optional `bearingDeg` (its mounting
heading, 0° = +Y) — the prerequisite for mapping a detected array-relative azimuth into room
coordinates (room-aware steering). Additive and omit-when-absent, so v1–v4 documents migrate
byte-identically; set it with `setArrayBearing(config, arrayId, deg)`. At matching v5 parity
with the Python engine.

## Room-aware seat mapping

A pure, zero-dependency geometry layer (`src/seat-mapper/`) composes *over* a detected
direction-of-arrival: given an array's room pose (`position` + the v5 `bearingDeg`) and the
room's furniture seats, it maps a detected **array-relative** azimuth (`0° = +Y`, clockwise) to
the nearest seat — and runs the inverse for pinning a beam to a chosen seat or clicked point.

- `nearestSeat` / `nearestSeatForArray` — DOA → nearest `SeatMatch` (gated by a max angular
  separation, so a direction "between seats" returns `null`).
- `seatsOwnedByArray` — partition seats across multiple arrays by distance (so two arrays don't
  both capture the same talker), ties to the lowest array id.
- `seatAzimuthForArray` / `azimuthForArrayPoint` — array-relative azimuth of a seat / arbitrary
  point ("lock to seat" / "lock to place").
- `seatNullAzimuths` / `exclusionZoneAzimuths` — array-relative bearings of the other seats /
  of no-pickup (exclusion) zone centres, for steering nulls; `azimuthInPickupZone` tests whether
  a detection falls inside any pickup zone; `roomSeats` enumerates `[seatId, anchor]`.

Seat ids are synthesized as `${objectId}-seat${i}` (1-based) — byte-identical to `roomTargets`,
so a matched seat correlates directly with a coverage-simulation target. Mirrors the Python
engine's `conf_pipeline/seat_mapper.py`.

```ts
import { setArrayBearing, nearestSeatForArray, seatAzimuthForArray } from 'conferencing-audio-pipeline';
```

## Live audio (Phase 1, Node)

A real-time **fractional-delay-and-sum** beamformer over a pluggable capture adapter. The core
(`conferencing-audio-pipeline/live`) is pure, zero-dependency, and browser-safe; the real 8-capsule
POLARIS capture path is a **Node-only** backend (`conferencing-audio-pipeline/live-node`) built on the
optional native addon `naudiodon2`.

**See it run in the browser:** `npm run web`, then open the **Live** tab in the app. It drives this exact
core on a *synthetic* plane-wave talker (browser 8-channel capture is infeasible — `getUserMedia` downmixes
to stereo), so you can drag the talker, toggle auto-steer / noise-suppression / dereverb, and watch the beam
track the talker via SRP-PHAT — all visualized on a top-down room canvas. The synthetic driver is the
browser-safe `ManualCaptureAdapter` (the host feeds one block per animation frame via `push(channels)`).

```ts
import { LiveEngine } from 'conferencing-audio-pipeline/live';
import { NodeCaptureAdapter, NodeOutputSink } from 'conferencing-audio-pipeline/live-node';
import { sensibel8 } from 'conferencing-audio-pipeline'; // beamformer.sensibel8

const geom = sensibel8(0.04);                    // your array's real radius (m)
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100, azimuthDeg: 0,
});
const sink = new NodeOutputSink();
await sink.start(44100);
engine.onOutput((o) => sink.write(o.mono));      // hear the steered beam; o.rmsDb / o.clipped for metering
await engine.start();
```

> The browser cannot capture 8 discrete USB channels (`getUserMedia` downmixes to stereo), so the
> live 8-channel path is Node-only. A browser/Web-Audio adapter, live DOA/auto-steer, and the cleaning
> chain are deferred to later phases. `naudiodon2` is an **optional peer dependency** — install it
> (with a C++ toolchain) only to use `./live-node`.

### Live steering (Phase 2)

The live engine can **steer itself**. Enable it with `LiveConfig.autoSteer`:

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  autoSteer: { mode: 'follow', sector: { centerDeg: 0, halfWidthDeg: 60 } }, // follow the dominant talker in front
});
engine.onOutput((o) => { /* o.detected = bearings; o.doaActive = VAD; o.azimuthDeg = where the beam points */ });
```

- `mode: 'follow'` — SRP-PHAT direction-of-arrival (2° azimuth grid, band-limited 300–3800 Hz) picks the
  dominant talker; a hold/switch tracker re-aims the single beam at it without jitter.
- `mode: 'lockSeat'` (+ `room`, `arrayId`, `seatId`) — pin the beam to a room seat's azimuth (via the
  seat-mapper; needs the array's `bearingDeg`). Falls back to `follow` if the seat can't be resolved.
- `mode: 'manual'` (default) — Phase-1 behavior; you call `setLook` yourself.

Still pure and zero-dependency: the FFT is a built-in radix-2 transform. **Honest limits:** azimuth only
(off-nadir fixed at 90°; a planar ring can't tell a source above the array plane from below); resolution
≈ beamwidth (~40° min talker separation); band-limited below the ~5.6 kHz spatial-aliasing cutoff;
single-talker follow (simultaneous multi-talker capture is a later, frequency-domain phase).

### Noise suppression (Phase 3a)

Opt-in post-beam cleaning kills steady fans/AC. Enable it with `LiveConfig.cleaning`:

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  cleaning: { engine: 'omlsa', strength: 1, preserveLevel: true }, // OM-LSA + makeup so the voice stays full
});
```

- `engine: 'omlsa' | 'wiener' | 'gate'` — an STFT denoiser with a VAD-independent **minimum-statistics**
  noise floor (learns steady fans/AC continuously). `omlsa` is the deepest cut; `gate` is the gentlest.
- `strength` (0..1) blends the cut toward unity for Gentle/Medium/Full.
- `preserveLevel` adds a **speech-gated makeup gain** that restores the ~5–7 dB every denoiser cuts from
  the talker — SNR-neutrally and boost-only, with a peak limiter so it never clips.
- `engine: 'off'` (default) — no cleaning; byte-identical to the Phase-2 path.

Still zero-dependency (pure-DSP, the exponential integral is vendored). **Honest limits:** adds ~12 ms STFT
latency when active (none when off); the floor needs ~0.7 s to warm up (bit-exact passthrough until then);
the makeup is boost-only and capped at 8 dB. Dereverb, AEC, and AGC/PEQ are later sub-phases;
DeepFilterNet3 (which needs ONNX) is an optional far-future add — the pure-DSP OM-LSA is the proven cut.

### Dereverb (Phase 3b)

Add an opt-in dereverb stage that runs **before** the denoiser to strip the late-reverberation tail
(the boxy/distant room "ring"):

```ts
const engine = new LiveEngine(new NodeCaptureAdapter(), {
  geom, deviceName: 'SB-POLARIS', sampleRate: 44100,
  cleaning: { dereverb: { t60: 0.5 }, engine: 'omlsa', preserveLevel: true }, // dereverb → OM-LSA → makeup
});
```

- `dereverb: { t60?, beta?, gminDb?, earlyMs? }` — single-channel Lebart/Habets **late-reverb spectral
  subtraction** (`G = max(1 − β·R/P, Gmin)`), where `R` is a T60-decayed estimate of a delayed power tap.
  Defaults: `t60 0.5 s`, `β 1.6`, `Gmin −10 dB`, `early 48 ms`.
- It composes with the 3a denoiser as an ordered chain (`dereverb → denoise`); the level-preserving makeup
  (if on) wraps the whole chain. Omitting `cleaning.dereverb` is byte-identical to Phase 3a.

Still zero-dependency (pure DSP). **Honest limits:** statistical single-channel dereverb (not an inverse/RIR
deconvolution); assumes a fixed T60; shares the ~12 ms STFT latency and ~0.7 s warmup; only LATE reverb
(older than `earlyMs`) is suppressed — early reflections are kept; the gain floor (−10 dB) means it never
hard-mutes. AEC and AGC/PEQ are later sub-phases.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the version history.

## License

MIT.
