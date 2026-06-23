# Changelog

All notable changes to the **Conferencing Audio Pipeline** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The JSON **config schema** is versioned independently via `CONFIG_VERSION`
(currently `5`); changes that affect persisted documents note it explicitly.

## [Unreleased]

### Added
- **Live audio (Phase 1, Node)** — a real-time fractional-delay-and-sum beamformer. A pure,
  zero-dependency, browser-safe core (`./live`: `LiveEngine`, `StreamingDelaySumBeam`, `LevelMeter`,
  `MockCaptureAdapter`, `CaptureAdapter`) plus a Node-only POLARIS capture adapter + output sink
  (`./live-node`, optional `naudiodon2` peer dep, lazy-imported). The offline narrowband weights can't
  be applied to broadband audio, so the live path aligns capsules by geometric delay and sums (ported
  from the Python engine's `_FracDelaySumBeam`). The browser can't capture 8 discrete USB channels, so
  the live path is Node-only; DOA/steering and the cleaning chain are later phases. Zero hard runtime
  deps unchanged.
- **Live steering (Phase 2)** — the live engine steers itself. A pure, zero-dependency SRP-PHAT
  direction-of-arrival (`doa.ts`, fed by a built-in radix-2 `rfft` in `fft.ts` + a streaming
  spatial-covariance accumulator in `covariance.ts`) drives a wrap-aware hold/switch tracker
  (`tracker.ts`) and a single-beam auto-steer controller (`autosteer.ts`), wired into `LiveEngine`
  behind `LiveConfig.autoSteer` (`mode: 'manual' | 'follow' | 'lockSeat'`; default `manual` =
  Phase-1 behavior). `BeamOutput` gains `detected`/`doaActive`/`mode`/`lockedTarget`. Lock-to-seat
  reuses the seat-mapper. Azimuth-only (off-nadir 90°), band 300–3800 Hz, single-talker follow; the
  FFT adds no dependency. Ported from the Python engine's `doa`/`autosteer`/`tracking`.
- **Microphone-array mounting bearing** (schema **v4 → v5**) — `MicrophoneArray` gains
  an optional `bearingDeg` (compass heading of the array's 0° reference, 0° = +Y), so a
  detected array-relative azimuth can be mapped into room coordinates — the prerequisite
  for room-aware steering. Additive and omit-when-absent (mirrors the loudspeaker's
  `bearingDeg`), so existing v1–v4 documents migrate byte-identically; `setArrayBearing`
  API. Parity-matched with the Python engine's v5. (`src/model/devices.ts`,
  `src/persistence/serialize.ts`, `src/index.ts`; +3 round-trip/migration tests.)
- **Room-aware seat mapping** (`src/seat-mapper/seat-mapper.ts`) — a pure, zero-dependency
  geometry layer that turns a detected array-relative azimuth (`0° = +Y`, clockwise) into the
  nearest room seat, and back. `nearestSeat` / `nearestSeatForArray` (DOA → seat, gated by a
  max angular separation), `seatsOwnedByArray` (partition seats across arrays by distance),
  `seatAzimuthForArray` / `azimuthForArrayPoint` (lock-to-seat / lock-to-place inverse),
  `seatNullAzimuths` / `exclusionZoneAzimuths` (array-relative bearings to null), `roomSeats`,
  `azimuthInPickupZone`, and the `SeatMatch` type. Seat ids are synthesized as
  `${objectId}-seat${i}` (1-based) — byte-identical to `roomTargets`, so a matched seat
  correlates with a coverage-simulation target. Closes the remaining config-modeling gap with
  the Python engine (`conf_pipeline/seat_mapper.py`); tests ported 1:1 from its suite.
- **Commissioning / as-built report** — `commissioningReport(config, info?, fmt?)` + the
  `CommissioningInfo` type (`src/report/report.ts`). The as-built design report plus measured
  live state (estimated latency vs target, AEC/ERLE, A/B noise-bed proof, capsule health,
  front calibration) and a derived pass/fail **sign-off checklist** + hand-sign form. Reuses
  the design-report sections; `CommissioningInfo` fields are all optional, so an empty info
  yields the config-only report plus a blank sign-off. Markdown or HTML. Mirrors the Python
  engine's `commissioning_report`; tests ported 1:1.

### Fixed
- **Defensive load defaults** — `deserialize()` now mirrors the Python sibling's load
  defaults so any document Python accepts, TS accepts identically (a hand-edited or
  Python-written partial document round-trips and `validate()` never trips on an `undefined`):
  a schedule's `enabled` → `true` and `days` → every weekday; a scene's `muteStates`/
  `zoneStates`/`steer` → empty and each steer's `offNadirDeg` → `90`; a mute group's
  `deviceIds`/`zoneRefs`/`trigger`/`muted` → `[]`/`[]`/`'software'`/`false`; a room's
  `units`/`objects` → `'meters'`/`[]`; and a floor-plan background's `origin`/`opacity` →
  `{x:0,y:0}`/`0.5`. (`src/persistence/serialize.ts`; +9 tests.)

## [1.16.0] - 2026-06-13

Conferencing cameras, device aim, furniture geometry, and a geometric room
coverage simulator — matching the Python engine's v4. All additive and
**zero runtime dependency**.

### Added
- **Conferencing cameras** — a new `camera` device type (`ConferencingCamera`
  with `bearingDeg`/`tiltDeg`), `createCamera`, `addCamera`, and three camera
  profiles (`generic-ptz-camera`, `generic-wide-camera`, `generic-soundbar-camera`)
  carrying a `CameraSpec` (FOV/range) on their capabilities. Coverage-only —
  routing/scene presets are deferred.
- **Device aim** — `setCameraBearing` / `setCameraTilt` and optional loudspeaker
  aim (`setSpeakerBearing` / `setSpeakerTilt`); a `SpeakerSpec` (dispersion/range)
  on the loudspeaker profile.
- **Furniture geometry** (`src/furniture/`) — `RoomObject` gains optional
  `width`/`depth`/`height`/`rotationDeg`/`seats`/`absorption`/`blocksCamera`/
  `blocksAudio` and a `SeatAnchor` type. A catalog (`FURNITURE_CATALOG`,
  `FURNITURE_KINDS`) supplies per-kind defaults; resolvers (`resolvedDimensions`,
  `furnitureCorners`, …) combine overrides with the catalog. API: `addFurniture`,
  `removeFurniture`, `setFurniturePosition/Rotation/Dimensions`, `setSeatAnchors`.
- **Room coverage simulation** (`src/coverage-sim/`) — `simulateRoomCoverage`
  returns per-device mic pickup beams, camera field-of-view (with **height-aware**
  furniture occlusion via `cameraSees`), and loudspeaker dispersion, plus an
  aggregate `RoomCoverage` (covered %, framed %, gaps). Geometric / spec-based;
  the mic tier is pluggable.
- **Geometry helpers** — `bearingToDeg`, `angularSeparationDeg`, `pointInSector`,
  `obbCorners` (shared by the validator and the simulator).
- **Validation** — `CAMERA_UNPLACED`, `CAMERA_NO_SUBJECT`, `FURNITURE_OUTSIDE_ROOM`,
  `FURNITURE_GEOMETRY_INVALID`, `DEVICE_INSIDE_FURNITURE`.
- **Browser configurator** — camera device type + camera/loudspeaker aim controls,
  a furniture add/list panel, and a live coverage-sim summary.

### Changed
- **`CONFIG_VERSION` 3 → 4.** `deserialize` accepts v1–v4 and migrates losslessly
  (`v1 → v2 → v3 → v4`, a pure bump for v4); camera pose is normalized on load.
  A v3 config that uses none of the new fields round-trips byte-for-byte.
- `coverageAngleDeg` now lives on the device-capability profile (arrays);
  `coverage/check.ts` reads it from there.
- Suite grows to **332** tests.

## [1.15.0] - 2026-06-13

Feature-parity port of the Python engine's v1.9–v1.15 milestones — all
framework-agnostic, **zero runtime dependency**, strict TypeScript. The JSON
schema interoperates with the Python version at **v3**.

### Added
- **Placement simulation & recommendation** (`src/sim/`): a heuristic optimiser
  that recommends the best array pose (position + steer) and the best seat for a
  talker, blending direct-path SNR, direct-to-reverberant ratio, coverage/on-axis,
  and multi-talker fairness, via a coarse-to-fine joint search. Sabine `estimatedRt60`.
  Pure core (no deps); `recommendPlacement`, `scoreHeatmap`, `scorePlacement`,
  `validateRecommendation` (reports no numerical backend — the numpy/pyroomacoustics
  validators are Python-only), `availableBackends`, `numpyAvailable`, `defaultSimParams`.
- **Coverage reports** (`src/coverage/check.ts`): `coverageReport` (array pickup
  circles → covered / uncovered / overlapping) and `zoneCoverageReport`
  (per-area in-pickup-circle + automix lobe-contention), plus `arrayCoverageCircle`
  / `arrayCoverageRadius`.
- **Design report** (`designReport`): a shareable Markdown / dependency-free-HTML
  document (room + RT60, devices, routing, AEC, coverage, mute groups, validation).
- **Auto-Route & Optimize-room** (`autoRoute`, `optimizeRoom`): one-click
  optimisation (AEC references + automixer + near-end send, then far-end → speakers
  and a synced mute link; optionally placement + per-area channels first). Idempotent;
  never breaks the AEC self-reference rule.
- **Per-coverage-area output channels + gain** (v1.12.0 parity): `CoverageZone`
  gains optional `outputChannel` (1..8, à la MXA920 steerable coverage) + `gainDb`;
  `setZoneOutputChannel`, `setZoneGainDb`, `autoAssignZoneChannels`. New codes
  `COVERAGE_CHANNEL_INVALID`, `COVERAGE_CHANNEL_DUPLICATE`, `COVERAGE_GAIN_INVALID`.
- **Logic / mute control** (`ControlConfig`, `MuteGroup`, `ZoneChannelRef`):
  `createMuteGroup`, `addMuteGroup`, `removeMuteGroup`, `setMuteGroupMuted`. Code
  `CONTROL_MUTE_GROUP_INVALID`.
- **Scenes** (schema **v3**): named, recallable snapshots of the control surface
  (mute states, per-area gains, config-inert `active`/`steer` live-layer hints).
  `createScene`, `addScene`, `removeScene`, `getScene`, `captureScene`,
  `recallScene`. Code `SCENE_INVALID`.
- **Scene schedules** (additive on v3): `SceneSchedule`, builders, and
  `SceneScheduler` (injectable clock, manual `runPending()` tick, `nextFire`,
  cross-platform polling). Code `SCHEDULE_INVALID`.
- **Floor-plan background** (`RoomBackground`): `setRoomBackground`,
  `setRoomBackgroundScale`, `setRoomBackgroundOpacity`, `clearRoomBackground`,
  `calibratedScale`.
- **Commissioning transport seam** (`src/transport/`): `DeviceTransport` +
  `SimulatedTransport`, `onlineRoomStatus`, `pushToOnline`, `reconcileOnline`.
- **Beamformer DESIGN layer** (`src/beamformer/`, exported as the `beamformer`
  namespace): pure complex-number DSP — array geometry (`sensibel8`,
  `withActiveChannels`), zone→steering, delay-sum / superdirective (diffuse-noise
  MVDR) weights, DI / WNG / lobe analysis, and octave-band wideband verification
  (`designZoneBeams`, `beamPatternAzimuth`, `analyzeLobes`, `frequencyCurves`, …).
  The live capture / DOA / OCTOVOX layers are Python-only (numpy/sounddevice).
- **Node-only entry** `conferencing-audio-pipeline/node`: a local HTTP control API
  (`ControlApiServer`, `ConfigHolder`) and a project file manager
  (`ProjectFileManager` — recent files, autosave, crash recovery, migration notice).
  Built on Node built-ins; kept off the main barrel so the core stays browser-safe.
- **Browser configurator**: Auto-Route / Optimize / Report toolbar actions, a
  Scenes & mute-groups panel, and per-area output-channel + gain controls.

### Changed
- **`CONFIG_VERSION` 2 → 3.** `deserialize` accepts v1/v2/v3 and migrates losslessly
  through a chained `v1 → v2 → v3`; `control.{muteGroups,scenes,schedules}` are
  normalized to `[]` when a partial document omits them. `autoConfigure` is now
  idempotent (reuses an existing AEC-reference / automix bus).
- Test suite grows to **295** tests (was 38), mirroring the Python parity suites.

## [1.8.0] - 2026-06-09

Designer-inspired workflow features — all vendor-neutral, **configuration/
validation only** (no real-time audio, Dante control, device discovery, firmware,
or network I/O).

### Added
- **Projects (multi-room)** (`src/project/`): a `Project` holds several named
  rooms (each a `SystemConfig`) plus an active-room pointer, with versioned,
  round-trippable JSON (`createProject`, `addRoom`, `removeRoom`, `renameRoom`,
  `setActiveRoom`, `updateRoom`, `getActiveRoom`, `serializeProject`,
  `deserializeProject`). Per-room configs reuse the standard deserializer, so
  v1→v2 migration applies on load.
- **Deployment workflow** (`src/deployment/`): a config-only `deployment` state
  (`design`/`online`/`deployed`) via `setDeploymentStatus` / `markDeployed`, and a
  pure `deploymentDiff(base, target)` (devices/routes added/removed/changed).
- **Naming conventions** (`src/naming/`): `applyNamingScheme`, `suggestedLabel`,
  `labelCollisions`, plus `NAMING_DUPLICATE_LABEL` / `NAMING_EMPTY_LABEL`
  validation warnings.
- **Routing views** (`src/routing/`): `subscriptions`, `danteSubscriptions`,
  `routingSummary`, `signalFlowReport` (the "enhanced routing / Dante hub" view).
- **Device templates** (`src/devices/templates.ts`): `deviceTemplate` /
  `instantiateTemplate` capture and stamp out a configured device (profile + DSP
  chain), re-namespacing ids.
- **UI**: a multi-room **rooms bar** (add/switch/rename/remove), a **Deploy**
  button (marks deployed + toasts the diff), an **Auto-name** button, a **Routing
  summary / Dante hub** panel in the Routing tab, and a **light/dark theme**
  toggle. New tests bring the suite to 82.

### Notes
- `SystemConfig.deployment` is an additive optional field; configs without it
  round-trip unchanged (no schema-version bump — still v2).

## [1.7.0] - 2026-06-09

Vendor-neutral DSP and device-capability modeling — a Shure-Designer-inspired
foundation that stays manufacturer-agnostic and adds no real-time audio.

### Added
- **Device capability profiles** (`src/profiles/`): a vendor-neutral catalog
  (`generic-ceiling-array`, `generic-table-array`, `generic-wireless-mic`,
  `generic-wired-mic`, `generic-hardware-dsp`, `generic-software-dsp`,
  `generic-loudspeaker`, `generic-codec`, `generic-mute-control`). Each declares
  `appliesTo`, AEC/automix/mute capabilities, supported DSP blocks, coverage
  limits, and default ports. Exports: `DEVICE_PROFILES`, `getDeviceProfile`,
  `deviceCapabilities`, `defaultProfileId`, `assignDeviceProfile`. Factories
  assign a matching default `profileId`; capabilities are **derived**, not stored.
- **DSP block chains** (`Device.dspBlocks`): kinds `gain`, `mute`, `peq4`, `agc`,
  `compressor`, `delay`, `noiseReduction`, `deverb`, each with typed, range-checked
  parameters (settings only — no audio). Builders `createDspBlock`,
  `dspBlockParamIssues`, `defaultPeqBand`; pure API `addDspBlock`,
  `updateDspBlock`, `removeDspBlock`, `setDspBlockEnabled`. Blocks may target a
  processor bus (`targetBusId`).
- **Validation codes**: errors `DEVICE_PROFILE_UNKNOWN`,
  `DEVICE_CAPABILITY_MISMATCH`, `DSP_BLOCK_UNSUPPORTED`, `DSP_BLOCK_INVALID`,
  `DSP_TARGET_UNRESOLVED`; commissioning warnings `AEC_NO_FAR_END`,
  `AUTOMIX_OUTPUT_UNSET`, `MUTE_LINK_UNSUPPORTED`, `DSP_CHAIN_NO_LEVEL`. The AEC
  self-reference behavior is unchanged.
- **UI**: profile selector + capability hint in the device inspector; the AEC/DSP
  tab gains **Processing blocks** (per-device chain editor with compact editors
  for every block kind incl. PEQ bands) and **Mute / logic** sections.
- Tests for profiles, DSP block builders, validation ranges, v1→v2 migration, and
  JSON round-trip (73 tests total).

### Changed
- **`CONFIG_VERSION` 1 → 2.** `deserialize` accepts both v1 and v2; v1 documents
  are migrated by filling each device's default `profileId` and an empty
  `dspBlocks` chain. v2 serializes losslessly.

## [1.6.1] - 2026-06-08

### Fixed
- **Steering angles were hard to discover.** Angles are now shown **inline in the
  Build → People card** for every talker (e.g. `A1 52° · 2.4m`), with no need to
  select anything; azimuth and down-tilt are in the chip tooltip. Selecting a
  talker still shows the full per-array table and draws the canvas rays.
- Clear empty-states explaining that angles require a **placed microphone array**
  ("add a microphone array…" / "place an array on the canvas…").
- **Stale-bundle reloads.** `serve.mjs` now sends `cache-control: no-store` so a
  browser refresh always loads the freshly built `dist/`.

## [1.6.0] - 2026-06-08

### Added
- **Talkers (people).** A `Talker` model (id, label, floor `position`, optional
  `elevation`) on `SystemConfig.talkers` — a physical voice source, distinct from
  the signal-graph `Device`s. API: `createTalker`, `addTalker`, `removeTalker`,
  `setTalkerPosition`, `setTalkerElevation`, `renameTalker`, `talkerElevation`.
- **Steering-angle geometry** (`src/geometry/angles.ts`): pure `steeringAngles(source, target)`
  returning `{ distance, horizontalDistance, azimuthDeg, downtiltDeg, offNadirDeg }`
  (azimuth clockwise from +Y; off-nadir = angle from straight-down).
- `arrayToTalkerAngles(config, arrayId, talkerId)` — resolves array/talker
  elevations and returns the angles (or `null` if unplaced).
- `talkerCoverage(config, talkerId)` — whether a talker is **recorded** (inside a
  pickup zone and not an exclusion zone), with `pickupArrays` / `excludedBy`.
- Point-in-geometry helpers `pointInRect`, `pointInPolygon`, `pointInShape`.
- **UI:** Build → *People* card (add/select/remove); talkers render as a person
  glyph in 2D and 3D with a capture badge (recorded / excluded / not covered);
  selecting a talker draws labeled angle rays from each array; talkers are
  selectable and draggable on the floor plane.

### Changed
- Canvas legend renamed **"Speaker" → "Loudspeaker"** to disambiguate the
  loudspeaker device from a (human) talker.
- `deserialize` tolerates legacy JSON without a `talkers` field (defaults to `[]`).

## [1.5.0] - 2026-06-08

### Added
- **Exclusion (no-pickup) coverage zones.** New `exclusion` zone type and
  `exclusionZone(id, label, shape)` factory — a region whose audio is suppressed
  even where it overlaps a pickup zone (doorways, HVAC, windows).
- `isPickupZone` / `pickupZoneCount` helpers.
- **UI:** "No-pickup" option in the Zone tool and the coverage buttons; exclusion
  zones render in red in 2D and 3D, with a legend entry.

### Changed
- Manual-mode **lobe outputs and the `MANUAL_LOBE_LIMIT` check now count pickup
  zones only** — exclusion zones produce no output lobe (but still count toward
  the 8-zone-per-array maximum).

## [1.4.0] - 2026-06-08

### Added
- **3D room layout.** A fully orbitable 3D view (hand-rolled perspective
  projection — no Three.js / no runtime dependency): room box, floor grid,
  zones on the floor, signal-flow routes, and devices at their real heights with
  drop-poles and depth sorting. Orbit (drag), zoom (wheel), pick-select, and
  drag-move on the floor plane.
- **2D / 3D toggle** in the stage bar (keys `2` / `3`).
- Device **elevation**: optional `elevation` on devices, `setDeviceElevation` /
  `clearDeviceElevation`, and `defaultElevation(device, roomHeight?)` with
  sensible per-type defaults (ceiling array at the ceiling, table mic low, …).
- Editable **Z height** field in the device inspector.

## [1.3.0] - 2026-06-08

### Added
- **Complete UI redesign**: app shell with header, canvas *stage* hero, and a
  tabbed inspector (Build / Routing / AEC·DSP / Issues / JSON).
- **Signal-flow visualization**: routes drawn as transport-colored arrows
  between placed devices; validation **errors glow red** on offending
  markers/routes; clicking an issue highlights and selects it.
- **Connect tool** — click device→device to create a route (auto-picks
  compatible free ports by transport).
- **Selection + inspector** for devices/zones/routes (rename, edit position,
  delete); **undo/redo** with full history (`Ctrl+Z` / `Ctrl+Y`); **keyboard
  shortcuts** (`V/C/R/D/Z`, `Del`, `Esc`, `Alt+A`).
- **Automixer DSP panel** (NLP level, per-channel always-on + gating).
- Sample scenarios (Boardroom / Huddle / Empty), snap-to-grid, and export to
  **JSON / PNG / clipboard**.
- Engine: `renameDevice`, config-level `removeCoverageZone`.

## [1.2.0] - 2026-06-08

### Added
- **Graphical room editor** (canvas): draw the room outline, drag-place devices,
  and draw/resize coverage zones on a metre grid.
- Room & placement API: `setRoom`, `clearRoom`, `rectangularRoom`,
  `setDevicePosition`, `clearDevicePosition`, `setZoneShape`; `updateZoneShape`
  in the coverage subsystem.

## [1.1.0] - 2026-06-08

### Added
- **Visual configurator** (`index.html`): a standalone, framework-free single-page
  app that drives the public API in the browser and validates live (devices,
  routes, matrix, AEC references) by importing the built `dist/` bundle.
- **`serve.mjs`**: a tiny zero-dependency static server (browsers block ES-module
  imports over `file://`).
- **`demo.mjs`**: a headless Node walkthrough of the AEC self-reference trap and
  its fix. `npm` scripts: `demo`, `serve`, `web`.

## [1.0.0] - 2026-06-08

### Added
- Initial **configuration & signal-routing control plane** — a framework-agnostic,
  ESM, zero-dependency, strict-TypeScript module. Models *what connects to what*
  and validates correctness; it does **not** process real audio (see README §Scope).
- **Domain model** (`src/model/`): typed ports, devices (`microphoneArray`,
  `processor`, `wireless`/`wiredMic`, `loudspeaker`, `codec`), buses, routes,
  optional `RoomLayout`, and the `SystemConfig` root.
- **Matrix mixer** (`src/matrix/`): pure, immutable crosspoint grid with
  set/route/clear/query operations.
- **Coverage subsystem** (`src/coverage/`): up to 8 dynamic/dedicated zones per
  array and mode-driven (`automatic`/`manual`) output-port regeneration.
- **DSP config** (`src/dsp/`): AEC reference resolution, automixer config, and
  mute linking.
- **Validation engine** (`src/validation/`): a pure, deterministic `validate()`
  enforcing the **AEC self-reference rule** (`AEC_SELF_REFERENCE`,
  `AEC_REINFORCED_SHARED_REFERENCE`) plus transport/direction, coverage limits,
  orphaned routes, and automixer ranges.
- **Public API + persistence** (`src/index.ts`): builder-style helpers,
  `autoConfigure`, and versioned, round-trippable JSON `serialize`/`deserialize`.
- **Vitest** suite (AEC positive/negative cases, coverage limits, mode-switch
  port regeneration + orphan detection, matrix ops, JSON round-trip) and a worked
  integration test of the reference boardroom scenario.
- **README** with architecture overview, the AEC rule in prose, the full
  validation-code catalog, the public API reference, and the explicit scope
  boundary.

[1.6.1]: #161---2026-06-08
[1.6.0]: #160---2026-06-08
[1.5.0]: #150---2026-06-08
[1.4.0]: #140---2026-06-08
[1.3.0]: #130---2026-06-08
[1.2.0]: #120---2026-06-08
[1.1.0]: #110---2026-06-08
[1.0.0]: #100---2026-06-08
