# Changelog

All notable changes to the **Conferencing Audio Pipeline** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The JSON **config schema** is versioned independently via `CONFIG_VERSION`
(currently `1`); changes that affect persisted documents note it explicitly.

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
