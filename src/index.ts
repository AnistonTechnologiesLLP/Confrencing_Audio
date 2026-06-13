/**
 * Conferencing Audio Pipeline — public API (control plane).
 *
 * A framework-agnostic, ESM, zero-dependency module that models and validates a
 * networked-conferencing audio configuration: mic coverage zones → matrix mixer
 * → AEC references + automixer → outputs. It models *what connects to what* and
 * enforces the domain rules (above all the AEC self-reference rule); it does
 * **not** process, mix, cancel, or stream real audio. See README §Scope.
 *
 * All builder functions are **pure**: they return a new {@link SystemConfig} and
 * never mutate their input.
 */

import type { SystemConfig, Route } from './model/config.js';
import { findDevice } from './model/config.js';
import type { Talker } from './model/talker.js';
import { DEFAULT_TALKER_ELEVATION_M } from './model/talker.js';
import { steeringAngles, type SteeringAngles, type Point3D } from './geometry/angles.js';
import type { Device, MicDevice, Processor } from './model/devices.js';
import { isMicDevice, isProcessor, defaultElevation } from './model/devices.js';
import type { DspBlockConfig } from './model/dsp-blocks.js';
import type { CoverageMode, CoverageZone } from './model/coverage.js';
import type {
  AecConfig,
  AutomixerConfig,
  Crosspoint,
  Point2D,
  RoomLayout,
  ZoneShape,
} from './model/index.js';
import * as matrixOps from './matrix/matrix.js';
import {
  setCoverageMode as coverageSetMode,
  addCoverageZone as coverageAddZone,
  updateZoneShape as coverageUpdateZoneShape,
  removeCoverageZone as coverageRemoveZone,
  setZoneOutputChannel as coverageSetZoneChannel,
  setZoneGainDb as coverageSetZoneGain,
  autoAssignZoneChannels as coverageAutoAssignChannels,
} from './coverage/coverage.js';
import { createMuteLink } from './dsp/mute.js';
import { serialize } from './persistence/serialize.js';
import { recommendPlacement, type SimParams } from './sim/index.js';
import type { RoomBackground } from './model/room.js';
import type { Bus } from './model/matrix.js';
import {
  createAutomixer,
  automixerChannel,
  upsertChannel,
  setAutomixOutput,
} from './dsp/automixer.js';
import {
  getPrimaryProcessor,
  processorInputBusesForDevice,
  outputBusesFeedingLoudspeakers,
} from './dsp/aec.js';

// ---------------------------------------------------------------------------
// Re-exports — model, subsystems, persistence, validation
// ---------------------------------------------------------------------------
export * from './model/index.js';
export * from './devices/factories.js';
export * from './coverage/coverage.js';
export * as matrix from './matrix/matrix.js';
export * from './dsp/aec.js';
export * from './dsp/automixer.js';
export * from './dsp/mute.js';
export {
  DEVICE_PROFILES,
  defaultProfileId,
  getDeviceProfile,
  deviceCapabilities,
  FALLBACK_CAPABILITIES,
  type DeviceProfile,
  type DeviceCapabilities,
  type ProfilePortDefaults,
} from './profiles/profiles.js';
export { createDspBlock, dspBlockParamIssues, defaultPeqBand } from './dsp/blocks.js';
export { steeringAngles } from './geometry/angles.js';
export type { Point3D, SteeringAngles } from './geometry/angles.js';
export { validate } from './validation/validate.js';
export {
  CODE_DESCRIPTIONS,
  type Severity,
  type ValidationCode,
  type ValidationIssue,
  type ValidationResult,
} from './validation/codes.js';
export { serialize, deserialize, DeserializeError } from './persistence/serialize.js';
// --- 1.8.0: deployment, naming, routing summary, templates, projects ---
export {
  setDeploymentStatus,
  markDeployed,
  deploymentDiff,
  type DeploymentDiff,
} from './deployment/deployment.js';
export { applyNamingScheme, suggestedLabel, labelCollisions, TYPE_LABEL } from './naming/naming.js';
export {
  subscriptions,
  danteSubscriptions,
  routingSummary,
  signalFlowReport,
  type Subscription,
} from './routing/summary.js';
export { deviceTemplate, instantiateTemplate, type DeviceTemplate } from './devices/templates.js';
export {
  PROJECT_VERSION,
  createProject,
  addRoom,
  removeRoom,
  renameRoom,
  setActiveRoom,
  updateRoom,
  getRoom,
  getActiveRoom,
  serializeProject,
  deserializeProject,
  type Project,
  type ProjectRoom,
} from './project/project.js';
// --- 1.10.0+: coverage check, design report, placement simulation ---
export * from './coverage/check.js';
export { designReport } from './report/report.js';
export {
  scorePlacement,
  estimatedRt60,
  recommendPlacement,
  scoreHeatmap,
  validateRecommendation,
  availableBackends,
  numpyAvailable,
  type SimParams,
  type PlacementScore,
  type Candidate,
  type Recommendation,
  type Heatmap,
  type SimValidationResult,
} from './sim/index.js';
// --- 1.12.0 + v3: control surface (mute groups, scenes, schedules) ---
export * from './scenes/scenes.js';
// --- commissioning: device-transport seam (simulated) ---
export * from './transport/transport.js';
// --- scene scheduler + local HTTP control API + project file manager ---
export { SceneScheduler, type SchedulerClock } from './scheduler/scheduler.js';
export { ControlApiServer, ConfigHolder } from './control-api/server.js';
export {
  ProjectFileManager,
  defaultStateDir,
  RECENT_MAX,
  type OpenResult,
  type RecoveryInfo,
} from './files/files.js';
// --- host-side array beamformer DESIGN layer (pure-stdlib, vendor-neutral) ---
export * as beamformer from './beamformer/index.js';

// ---------------------------------------------------------------------------
// Config lifecycle
// ---------------------------------------------------------------------------

export { createConfig } from './config/create.js';

/**
 * Add a device. When the first {@link Processor} is added, the config's primary
 * matrix and automixer are bound to it. Returns a new config. Throws on
 * duplicate device id.
 */
export function addDevice(config: SystemConfig, device: Device): SystemConfig {
  if (config.devices.some((d) => d.id === device.id)) {
    throw new Error(`Duplicate device id: ${device.id}`);
  }
  const next: SystemConfig = { ...config, devices: [...config.devices, device] };
  if (isProcessor(device) && next.matrix.processorId === '') {
    next.matrix = device.matrix;
    next.automixer = createAutomixer(device.id);
  }
  return next;
}

/** Rename a device (change its display label). Returns a new config. */
export function renameDevice(config: SystemConfig, deviceId: string, label: string): SystemConfig {
  return mapDevice(config, deviceId, (d) => ({ ...d, label }));
}

/** Remove a device and any routes touching its ports. Returns a new config. */
export function removeDevice(config: SystemConfig, deviceId: string): SystemConfig {
  const device = config.devices.find((d) => d.id === deviceId);
  if (!device) return config;
  const portIds = new Set(device.ports.map((p) => p.id));
  return {
    ...config,
    devices: config.devices.filter((d) => d.id !== deviceId),
    routes: config.routes.filter(
      (r) => !portIds.has(r.fromPortId) && !portIds.has(r.toPortId),
    ),
  };
}

// ---------------------------------------------------------------------------
// Room & placement (optional interop — see §2.4)
// ---------------------------------------------------------------------------

/** Attach/replace the optional room layout. Returns a new config. */
export function setRoom(config: SystemConfig, room: RoomLayout): SystemConfig {
  return { ...config, room };
}

/** Remove the room layout. Returns a new config. */
export function clearRoom(config: SystemConfig): SystemConfig {
  const { room: _room, ...rest } = config;
  return { ...rest };
}

/**
 * Build a rectangular room of `width`×`depth` metres (origin at 0,0), with the
 * given ceiling `height` metres. Convenience for the common case.
 */
export function rectangularRoom(width: number, depth: number, height = 3): RoomLayout {
  return {
    vertices: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: depth },
      { x: 0, y: depth },
    ],
    height,
    units: 'meters',
    objects: [],
  };
}

/** Set a device's position (metres, room/coverage coordinates). Returns a new config. */
export function setDevicePosition(
  config: SystemConfig,
  deviceId: string,
  position: Point2D,
): SystemConfig {
  return mapDevice(config, deviceId, (d) => ({ ...d, position }));
}

/** Remove a device's position. Returns a new config. */
export function clearDevicePosition(config: SystemConfig, deviceId: string): SystemConfig {
  return mapDevice(config, deviceId, (d) => {
    const { position: _p, ...rest } = d;
    return rest as Device;
  });
}

/** Set a device's elevation (metres above floor, the 3D height). Returns a new config. */
export function setDeviceElevation(
  config: SystemConfig,
  deviceId: string,
  elevation: number,
): SystemConfig {
  return mapDevice(config, deviceId, (d) => ({ ...d, elevation }));
}

/** Remove a device's explicit elevation (falls back to {@link defaultElevation}). Returns a new config. */
export function clearDeviceElevation(config: SystemConfig, deviceId: string): SystemConfig {
  return mapDevice(config, deviceId, (d) => {
    const { elevation: _e, ...rest } = d;
    return rest as Device;
  });
}

/** Replace a coverage zone's geometry (e.g. after drawing/dragging it). Returns a new config. */
export function setZoneShape(
  config: SystemConfig,
  arrayId: string,
  zoneId: string,
  shape: ZoneShape,
): SystemConfig {
  return mapDevice(config, arrayId, (d) => {
    if (d.type !== 'microphoneArray') throw new Error(`Device ${arrayId} is not a microphone array.`);
    return coverageUpdateZoneShape(d, zoneId, shape);
  });
}

// ---------------------------------------------------------------------------
// Talkers (people) — physical voice sources, not signal-graph devices
// ---------------------------------------------------------------------------

/** Default talker mouth height, metres. */
export { DEFAULT_TALKER_ELEVATION_M } from './model/talker.js';

/** Build a talker at a floor position. */
export function createTalker(
  id: string,
  label: string,
  position: Point2D,
  elevation?: number,
): Talker {
  const t: Talker = { id, label, position };
  if (elevation !== undefined) t.elevation = elevation;
  return t;
}

/** Add a talker. Returns a new config. Throws on duplicate id. */
export function addTalker(config: SystemConfig, talker: Talker): SystemConfig {
  if (config.talkers.some((t) => t.id === talker.id)) {
    throw new Error(`Duplicate talker id: ${talker.id}`);
  }
  return { ...config, talkers: [...config.talkers, talker] };
}

/** Remove a talker by id. Returns a new config. */
export function removeTalker(config: SystemConfig, talkerId: string): SystemConfig {
  return { ...config, talkers: config.talkers.filter((t) => t.id !== talkerId) };
}

function mapTalker(
  config: SystemConfig,
  talkerId: string,
  fn: (t: Talker) => Talker,
): SystemConfig {
  let found = false;
  const talkers = config.talkers.map((t) => {
    if (t.id !== talkerId) return t;
    found = true;
    return fn(t);
  });
  if (!found) throw new Error(`Unknown talker: ${talkerId}`);
  return { ...config, talkers };
}

/** Set a talker's floor position. Returns a new config. */
export function setTalkerPosition(
  config: SystemConfig,
  talkerId: string,
  position: Point2D,
): SystemConfig {
  return mapTalker(config, talkerId, (t) => ({ ...t, position }));
}

/** Set a talker's mouth height (metres above floor). Returns a new config. */
export function setTalkerElevation(
  config: SystemConfig,
  talkerId: string,
  elevation: number,
): SystemConfig {
  return mapTalker(config, talkerId, (t) => ({ ...t, elevation }));
}

/** Rename a talker. Returns a new config. */
export function renameTalker(config: SystemConfig, talkerId: string, label: string): SystemConfig {
  return mapTalker(config, talkerId, (t) => ({ ...t, label }));
}

/** Effective talker elevation (explicit or default). */
export function talkerElevation(talker: Talker): number {
  return talker.elevation ?? DEFAULT_TALKER_ELEVATION_M;
}

/**
 * Steering angles from a microphone array **down to a talker** — azimuth,
 * down-tilt, off-nadir, and distances. Resolves the array's elevation from its
 * `elevation` or {@link defaultElevation} (ceiling height), and the talker's from
 * `elevation` or {@link DEFAULT_TALKER_ELEVATION_M}. Returns `null` if either the
 * array is not a placed microphone array or the talker is unplaced/unknown.
 *
 * @param arrayId  A `microphoneArray` device id.
 * @param talkerId A talker id.
 */
export function arrayToTalkerAngles(
  config: SystemConfig,
  arrayId: string,
  talkerId: string,
): SteeringAngles | null {
  const array = findDevice(config, arrayId);
  const talker = config.talkers.find((t) => t.id === talkerId);
  if (!array || array.type !== 'microphoneArray' || !array.position || !talker) return null;
  const roomHeight = config.room?.height ?? 3;
  const from: Point3D = {
    x: array.position.x,
    y: array.position.y,
    z: array.elevation ?? defaultElevation(array, roomHeight),
  };
  const to: Point3D = {
    x: talker.position.x,
    y: talker.position.y,
    z: talker.elevation ?? DEFAULT_TALKER_ELEVATION_M,
  };
  return steeringAngles(from, to);
}

export { talkerCoverage, type TalkerCoverage } from './coverage/talker-coverage.js';

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Apply a device transform to one device by id, returning a new config. */
function mapDevice(
  config: SystemConfig,
  deviceId: string,
  fn: (d: Device) => Device,
): SystemConfig {
  let found = false;
  const devices = config.devices.map((d) => {
    if (d.id !== deviceId) return d;
    found = true;
    return fn(d);
  });
  if (!found) throw new Error(`Unknown device: ${deviceId}`);
  return { ...config, devices };
}

/**
 * Switch an array's coverage mode. Output ports are regenerated; routes that
 * referenced now-removed ports are KEPT and surfaced by {@link validate} as
 * `ORPHANED_ROUTE` (they are not silently dropped). Returns a new config.
 */
export function setCoverageMode(
  config: SystemConfig,
  arrayId: string,
  mode: CoverageMode,
): SystemConfig {
  return mapDevice(config, arrayId, (d) => {
    if (d.type !== 'microphoneArray') throw new Error(`Device ${arrayId} is not a microphone array.`);
    return coverageSetMode(d, mode);
  });
}

/** Add a coverage zone to an array (max 8). Returns a new config. */
export function addCoverageZone(
  config: SystemConfig,
  arrayId: string,
  zone: CoverageZone,
): SystemConfig {
  return mapDevice(config, arrayId, (d) => {
    if (d.type !== 'microphoneArray') throw new Error(`Device ${arrayId} is not a microphone array.`);
    return coverageAddZone(d, zone);
  });
}

/** Remove a coverage zone from an array by id. Returns a new config. */
export function removeCoverageZone(
  config: SystemConfig,
  arrayId: string,
  zoneId: string,
): SystemConfig {
  return mapDevice(config, arrayId, (d) => {
    if (d.type !== 'microphoneArray') throw new Error(`Device ${arrayId} is not a microphone array.`);
    return coverageRemoveZone(d, zoneId);
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Deterministic route id from its endpoints. */
function routeId(fromPortId: string, toPortId: string): string {
  return `r:${fromPortId}->${toPortId}`;
}

/** Add a route output→input (idempotent by endpoints). Returns a new config. */
export function route(config: SystemConfig, fromPortId: string, toPortId: string): SystemConfig {
  const id = routeId(fromPortId, toPortId);
  if (config.routes.some((r) => r.id === id)) return config;
  const r: Route = { id, fromPortId, toPortId };
  return { ...config, routes: [...config.routes, r] };
}

/** Remove a route by its endpoints. Returns a new config. */
export function unroute(config: SystemConfig, fromPortId: string, toPortId: string): SystemConfig {
  const id = routeId(fromPortId, toPortId);
  return { ...config, routes: config.routes.filter((r) => r.id !== id) };
}

// ---------------------------------------------------------------------------
// Matrix accessor
// ---------------------------------------------------------------------------

/** Mutating matrix operations bound to a processor; each returns a new config. */
export interface MatrixAccessor {
  set(inputBusId: string, outputBusId: string, crosspoint: Crosspoint): SystemConfig;
  route(inputBusId: string, outputBusId: string, gainDb?: number): SystemConfig;
  clear(inputBusId: string, outputBusId: string): SystemConfig;
  get(inputBusId: string, outputBusId: string): Crosspoint | undefined;
  isActive(inputBusId: string, outputBusId: string): boolean;
}

function applyMatrix(
  config: SystemConfig,
  processorId: string,
  fn: (m: Processor['matrix']) => Processor['matrix'],
): SystemConfig {
  let updated: Processor['matrix'] | undefined;
  const devices = config.devices.map((d) => {
    if (d.id !== processorId) return d;
    if (!isProcessor(d)) throw new Error(`Device ${processorId} is not a processor.`);
    updated = fn(d.matrix);
    return { ...d, matrix: updated, buses: [...updated.inputBuses, ...updated.outputBuses] };
  });
  if (!updated) throw new Error(`Unknown processor: ${processorId}`);
  const next: SystemConfig = { ...config, devices };
  if (config.matrix.processorId === processorId) next.matrix = updated;
  return next;
}

/** Accessor for a processor's crosspoint matrix. See {@link MatrixAccessor}. */
export function matrixFor(config: SystemConfig, processorId: string): MatrixAccessor {
  const proc = config.devices.find((d) => d.id === processorId);
  if (!proc || !isProcessor(proc)) throw new Error(`Unknown processor: ${processorId}`);
  return {
    set: (i, o, cp) => applyMatrix(config, processorId, (m) => matrixOps.set(m, i, o, cp)),
    route: (i, o, gainDb) => applyMatrix(config, processorId, (m) => matrixOps.route(m, i, o, gainDb)),
    clear: (i, o) => applyMatrix(config, processorId, (m) => matrixOps.clear(m, i, o)),
    get: (i, o) => matrixOps.get(proc.matrix, i, o),
    isActive: (i, o) => matrixOps.isActive(proc.matrix, i, o),
  };
}

// ---------------------------------------------------------------------------
// AEC + automixer
// ---------------------------------------------------------------------------

/**
 * Set a mic's AEC config. Enforces nothing here — assigning a self-referencing
 * bus is allowed at the API level and is caught by {@link validate} as
 * `AEC_SELF_REFERENCE`, so callers can detect the trap deterministically.
 * Returns a new config.
 */
export function setAec(config: SystemConfig, micId: string, aec: AecConfig): SystemConfig {
  return mapDevice(config, micId, (d) => {
    if (!isMicDevice(d)) throw new Error(`Device ${micId} has no AEC (not a microphone).`);
    return { ...(d as MicDevice), aec: { ...aec } } as Device;
  });
}

/** Replace the automixer configuration. Returns a new config. */
export function configureAutomixer(
  config: SystemConfig,
  processorId: string,
  automixer: AutomixerConfig,
): SystemConfig {
  if (automixer.processorId !== processorId) {
    throw new Error(
      `Automixer processorId "${automixer.processorId}" does not match "${processorId}".`,
    );
  }
  return { ...config, automixer: { ...automixer } };
}

// ---------------------------------------------------------------------------
// Device profiles & DSP blocks (v1.7.0)
// ---------------------------------------------------------------------------

/**
 * Assign a capability profile to a device. Validation flags unknown profiles
 * (`DEVICE_PROFILE_UNKNOWN`) and type mismatches (`DEVICE_CAPABILITY_MISMATCH`).
 * Returns a new config.
 */
export function assignDeviceProfile(
  config: SystemConfig,
  deviceId: string,
  profileId: string,
): SystemConfig {
  return mapDevice(config, deviceId, (d) => ({ ...d, profileId }));
}

/** Append a DSP block to a device's processing chain. Returns a new config. */
export function addDspBlock(
  config: SystemConfig,
  deviceId: string,
  block: DspBlockConfig,
): SystemConfig {
  return mapDevice(config, deviceId, (d) => {
    const blocks = d.dspBlocks ?? [];
    if (blocks.some((b) => b.id === block.id)) {
      throw new Error(`Duplicate DSP block id "${block.id}" on device "${deviceId}".`);
    }
    return { ...d, dspBlocks: [...blocks, block] };
  });
}

/**
 * Patch a DSP block (shallow-merge top-level fields; deep-merge `params`).
 * Returns a new config.
 */
export function updateDspBlock(
  config: SystemConfig,
  deviceId: string,
  blockId: string,
  patch: { enabled?: boolean; targetBusId?: string; params?: Record<string, unknown> },
): SystemConfig {
  return mapDevice(config, deviceId, (d) => ({
    ...d,
    dspBlocks: (d.dspBlocks ?? []).map((b) =>
      b.id === blockId
        ? ({
            ...b,
            ...patch,
            params: { ...b.params, ...(patch.params ?? {}) },
          } as DspBlockConfig)
        : b,
    ),
  }));
}

/** Remove a DSP block by id. Returns a new config. */
export function removeDspBlock(
  config: SystemConfig,
  deviceId: string,
  blockId: string,
): SystemConfig {
  return mapDevice(config, deviceId, (d) => ({
    ...d,
    dspBlocks: (d.dspBlocks ?? []).filter((b) => b.id !== blockId),
  }));
}

/** Enable/disable a DSP block. Returns a new config. */
export function setDspBlockEnabled(
  config: SystemConfig,
  deviceId: string,
  blockId: string,
  enabled: boolean,
): SystemConfig {
  return mapDevice(config, deviceId, (d) => ({
    ...d,
    dspBlocks: (d.dspBlocks ?? []).map((b) => (b.id === blockId ? { ...b, enabled } : b)),
  }));
}

// ---------------------------------------------------------------------------
// Auto-configure
// ---------------------------------------------------------------------------

/** Pick `count` unused Dante output buses (no active crosspoints, not speaker feeds). */
function pickUnusedDanteOutputBuses(
  config: SystemConfig,
  processor: Processor,
  count: number,
): string[] {
  const speakerFeeds = outputBusesFeedingLoudspeakers(config, processor);
  const used = new Set<string>();
  for (const cols of Object.values(processor.matrix.cells)) {
    for (const [outId, cp] of Object.entries(cols)) if (cp.enabled) used.add(outId);
  }
  const picked: string[] = [];
  for (const bus of processor.matrix.outputBuses) {
    if (picked.length >= count) break;
    const port = processor.ports.find((p) => p.id === bus.portId);
    if (!port || port.transport !== 'dante') continue;
    if (used.has(bus.id) || speakerFeeds.has(bus.id)) continue;
    picked.push(bus.id);
  }
  return picked;
}

/**
 * One-click sensible defaults across linked devices (analogous to a console's
 * "auto configure"):
 *  - builds a single **far-end-only** AEC reference bus (safe for every mic,
 *    reinforced or not — it never contains a mic) and enables AEC pointing at it;
 *  - adds automixer channels (presenter/reinforced mics set `alwaysOn`);
 *  - wires the automix sum to the far-end (codec) output.
 *
 * Guaranteed to produce a config whose {@link validate} has **no errors**.
 * Returns a new config. No-op if there is no processor.
 */
export function autoConfigure(config: SystemConfig): SystemConfig {
  const processor = getPrimaryProcessor(config);
  if (!processor) return config;

  let next = config;
  const codecs = next.devices.filter((d) => d.type === 'codec');
  const mics = next.devices.filter(isMicDevice);

  // Far-end input buses = processor inputs fed by codec outputs.
  const farEndInputBuses = new Set<string>();
  for (const codec of codecs) {
    for (const b of processorInputBusesForDevice(next, processor, codec.id)) {
      farEndInputBuses.add(b);
    }
  }

  const [refBus, automixBus] = pickUnusedDanteOutputBuses(next, processor, 2);

  // 1) Build the far-end-only reference bus (only if a far-end exists).
  if (refBus && farEndInputBuses.size > 0) {
    for (const inBus of farEndInputBuses) {
      next = matrixFor(next, processor.id).route(inBus, refBus);
    }
    // Enable AEC on every mic, referencing the far-end-only bus.
    for (const mic of mics) {
      next = setAec(next, mic.id, { enabled: true, referenceBusId: refBus });
    }
  }

  // 2) Automixer: a channel per mic input bus; reinforced mics are always-on.
  let am = createAutomixer(processor.id);
  const reinforced = new Set<string>();
  const speakerFeeds = outputBusesFeedingLoudspeakers(next, processor);
  for (const mic of mics) {
    for (const inBus of processorInputBusesForDevice(next, processor, mic.id)) {
      const isReinforced = matrixOps
        .outputsForInput(processor.matrix, inBus)
        .some((o) => speakerFeeds.has(o));
      if (isReinforced) reinforced.add(inBus);
      am = upsertChannel(
        am,
        automixerChannel(inBus, { alwaysOn: isReinforced, gatingSensitivity: 0.5 }),
      );
    }
  }

  // 3) Automix sum → far-end output, and mic inputs summed into the automix bus.
  if (automixBus) {
    am = setAutomixOutput(am, automixBus);
    for (const ch of am.channels) {
      next = matrixFor(next, processor.id).route(ch.inputBusId, automixBus);
    }
    // Route the automix output to the codec's near-end input where transports match.
    const automixPort = next.devices
      .find((d): d is Processor => d.id === processor.id && isProcessor(d))
      ?.ports.find((p) => p.id === automixBus);
    if (automixPort) {
      for (const codec of codecs) {
        const nearEndIn = codec.ports.find(
          (p) => p.kind === 'input' && p.transport === automixPort.transport,
        );
        if (nearEndIn) next = route(next, automixBus, nearEndIn.id);
      }
    }
  }

  return configureAutomixer(next, processor.id, am);
}

// ---------------------------------------------------------------------------
// Floor-plan background (v1.10.0)
// ---------------------------------------------------------------------------

/**
 * Attach (or replace) a floor-plan image under the room. `path` is a file
 * reference (not embedded). `opacity` is clamped to `0..1` (default 0.5);
 * `origin` defaults to the world origin. Returns a new config. Throws if there
 * is no room to attach to.
 */
export function setRoomBackground(
  config: SystemConfig,
  bg: {
    path: string;
    imageWidthPx: number;
    imageHeightPx: number;
    scaleMPerPx?: number;
    origin?: Point2D;
    opacity?: number;
  },
): SystemConfig {
  if (!config.room) throw new Error('No room to attach a floor-plan background to.');
  const background: RoomBackground = {
    path: bg.path,
    imageWidthPx: bg.imageWidthPx,
    imageHeightPx: bg.imageHeightPx,
    origin: bg.origin ?? { x: 0, y: 0 },
    opacity: bg.opacity === undefined ? 0.5 : Math.max(0, Math.min(1, bg.opacity)),
    ...(bg.scaleMPerPx !== undefined ? { scaleMPerPx: bg.scaleMPerPx } : {}),
  };
  return { ...config, room: { ...config.room, background } };
}

/** Set the floor-plan's metres-per-pixel scale (after calibration). Returns a new config. */
export function setRoomBackgroundScale(config: SystemConfig, scaleMPerPx: number): SystemConfig {
  if (!config.room?.background) throw new Error('No floor-plan background to scale.');
  return {
    ...config,
    room: { ...config.room, background: { ...config.room.background, scaleMPerPx } },
  };
}

/** Set the floor-plan render opacity (clamped 0..1). Returns a new config. */
export function setRoomBackgroundOpacity(config: SystemConfig, opacity: number): SystemConfig {
  if (!config.room?.background) throw new Error('No floor-plan background.');
  return {
    ...config,
    room: {
      ...config.room,
      background: { ...config.room.background, opacity: Math.max(0, Math.min(1, opacity)) },
    },
  };
}

/** Remove the floor-plan background (no-op if absent). Returns a new config. */
export function clearRoomBackground(config: SystemConfig): SystemConfig {
  if (!config.room?.background) return config;
  const { background: _bg, ...room } = config.room;
  return { ...config, room };
}

/**
 * New metres-per-pixel from a calibration drag: `scaleOld · realLen / worldDist`.
 * `worldDist` is the on-floor length the drawn line currently spans at
 * `scaleOld`; `realLen` is the true distance the user entered.
 */
export function calibratedScale(scaleOld: number, worldDist: number, realLen: number): number {
  if (worldDist <= 1e-6) throw new Error('Calibration distance is too small.');
  return (scaleOld * realLen) / worldDist;
}

// ---------------------------------------------------------------------------
// Per-coverage-area output channels + gain (v1.12.0) — config-level wrappers
// ---------------------------------------------------------------------------

/**
 * Assign (or clear with `undefined`) a coverage area's own numbered output
 * channel (Designer steerable-coverage style). Regenerates the array's output
 * ports. Returns a new config.
 */
export function setZoneOutputChannel(
  config: SystemConfig,
  arrayId: string,
  zoneId: string,
  channel: number | undefined,
): SystemConfig {
  return mapDevice(config, arrayId, (d) => {
    if (d.type !== 'microphoneArray') throw new Error(`Device ${arrayId} is not a microphone array.`);
    return coverageSetZoneChannel(d, zoneId, channel);
  });
}

/** Set (or clear with `undefined`) a coverage area's per-area gain trim (dB). Returns a new config. */
export function setZoneGainDb(
  config: SystemConfig,
  arrayId: string,
  zoneId: string,
  gainDb: number | undefined,
): SystemConfig {
  return mapDevice(config, arrayId, (d) => {
    if (d.type !== 'microphoneArray') throw new Error(`Device ${arrayId} is not a microphone array.`);
    return coverageSetZoneGain(d, zoneId, gainDb);
  });
}

/** Give every pickup area on the array a sequential output channel (idempotent). Returns a new config. */
export function autoAssignZoneChannels(config: SystemConfig, arrayId: string): SystemConfig {
  return mapDevice(config, arrayId, (d) => {
    if (d.type !== 'microphoneArray') throw new Error(`Device ${arrayId} is not a microphone array.`);
    return coverageAutoAssignChannels(d);
  });
}

// ---------------------------------------------------------------------------
// Auto-route (one-click optimize) + change summary (v1.10.0)
// ---------------------------------------------------------------------------

/** Result of {@link autoRoute}: the new config plus a human-readable change summary. */
export interface AutoRouteResult {
  config: SystemConfig;
  changes: string[];
  counts: { crosspoints: number; routes: number; muteLinks: number };
}

/**
 * First processor output bus whose port matches `transport` and is not a
 * forbidden column (any AEC reference / the automix bus).
 */
function pickProgramBus(processor: Processor, transport: string, forbidden: Set<string>): Bus | undefined {
  for (const bus of processor.matrix.outputBuses) {
    const port = processor.ports.find((p) => p.id === bus.portId);
    if (!port || port.transport !== transport) continue;
    if (forbidden.has(bus.id)) continue;
    return bus;
  }
  return undefined;
}

/**
 * One-click optimize. Runs {@link autoConfigure} (AEC references, automixer,
 * near-end send), then feeds the far-end to the loudspeakers and links mic
 * mutes, returning the new config plus a human-readable summary.
 *
 * Invariant: never routes a mic into an AEC reference bus, so
 * `validate(result.config).errors` stays empty (the AEC self-reference rule).
 */
export function autoRoute(config: SystemConfig): AutoRouteResult {
  const processor0 = getPrimaryProcessor(config);
  if (!processor0) {
    return { config, changes: ['No processor in the design — nothing to route.'], counts: { crosspoints: 0, routes: 0, muteLinks: 0 } };
  }

  const changes: string[] = [];
  const counts = { crosspoints: 0, routes: 0, muteLinks: 0 };

  let next = autoConfigure(config);
  const proc = getPrimaryProcessor(next)!; // autoConfigure never removes it
  const pid = proc.id;
  const mics = next.devices.filter(isMicDevice);
  const codecs = next.devices.filter((d) => d.type === 'codec');
  const speakers = next.devices.filter((d) => d.type === 'loudspeaker');

  const aecMics = mics.filter((m) => m.aec.enabled);
  if (aecMics.length > 0) changes.push(`AEC enabled on ${aecMics.length} mic(s), referencing the far-end bus`);
  if (next.automixer.channels.length > 0) changes.push(`Automixer configured with ${next.automixer.channels.length} channel(s)`);
  if (next.automixer.outputBusId && codecs.length > 0) changes.push('Mic mix routed to the codec (near-end send)');
  if (codecs.length === 0) changes.push('No codec in the design — far-end / AEC routing skipped');

  // Never reinforce into an AEC reference bus or the near-end mix bus.
  const forbidden = new Set<string>();
  for (const m of mics) if (m.aec.enabled && m.aec.referenceBusId) forbidden.add(m.aec.referenceBusId);
  if (next.automixer.outputBusId) forbidden.add(next.automixer.outputBusId);

  const farEndIn = new Set<string>();
  for (const codec of codecs) {
    for (const b of processorInputBusesForDevice(next, proc, codec.id)) farEndIn.add(b);
  }

  // Far-end audio -> loudspeakers (so remote participants are heard in the room).
  if (speakers.length > 0 && farEndIn.size > 0) {
    for (const spk of speakers) {
      const inPort = spk.ports.find((p) => p.kind === 'input');
      if (!inPort) continue;
      const procLatest = getPrimaryProcessor(next)!; // matrix changes as routes land
      const bus = pickProgramBus(procLatest, inPort.transport, forbidden);
      if (!bus) continue;
      for (const fe of farEndIn) {
        if (!matrixFor(next, pid).isActive(fe, bus.id)) {
          next = matrixFor(next, pid).route(fe, bus.id);
          counts.crosspoints += 1;
        }
      }
      const routeId = `r:${bus.portId}->${inPort.id}`;
      const had = next.routes.some((r) => r.id === routeId);
      next = route(next, bus.portId, inPort.id);
      if (!had) {
        counts.routes += 1;
        changes.push(`Fed far-end audio to ${spk.label}`);
      }
    }
  } else if (speakers.length > 0 && farEndIn.size === 0) {
    changes.push('Loudspeakers present but no codec/far-end source to feed them');
  }

  // Link mic mutes to the near-end mix so a room mute syncs (mics are mute-capable).
  if (next.automixer.outputBusId && mics.length > 0) {
    const linkId = `ml:auto:${next.automixer.outputBusId}`;
    if (!next.muteLinks.some((lk) => lk.id === linkId)) {
      const link = createMuteLink(linkId, next.automixer.outputBusId, mics.map((m) => m.id), {
        syncToCodec: codecs.length > 0,
      });
      next = { ...next, muteLinks: [...next.muteLinks, link] };
      counts.muteLinks += 1;
      changes.push(`Linked mute across ${mics.length} mic(s)` + (codecs.length > 0 ? ' (synced to codec)' : ''));
    }
  }

  if (serialize(next) === serialize(config)) {
    return { config, changes: ['No changes — the design is already routed.'], counts: { crosspoints: 0, routes: 0, muteLinks: 0 } };
  }
  return { config: next, changes, counts };
}

// ---------------------------------------------------------------------------
// Optimize room — one-click "do everything" (v1.12.0)
// ---------------------------------------------------------------------------

/** Result of {@link optimizeRoom}. */
export interface OptimizeRoomResult {
  config: SystemConfig;
  changes: string[];
  autoRoute?: AutoRouteResult;
}

/**
 * One-click optimize: (1) recommend + apply each array's best placement/steer
 * (when a room + talkers exist), (2) give every pickup area its own output
 * channel, (3) run {@link autoRoute}. Each stage is opt-out and idempotent.
 * Pure: returns a new config; never mutates the input.
 */
export function optimizeRoom(
  config: SystemConfig,
  opts: { placeArrays?: boolean; assignChannels?: boolean; route?: boolean; params?: SimParams } = {},
): OptimizeRoomResult {
  const placeArrays = opts.placeArrays ?? true;
  const assignChannels = opts.assignChannels ?? true;
  const doRoute = opts.route ?? true;

  let next = config;
  const changes: string[] = [];

  const arrays = next.devices.filter((d) => d.type === 'microphoneArray');

  if (placeArrays && next.room && next.talkers.length > 0 && arrays.length > 0) {
    for (const arr of arrays) {
      let rec;
      try {
        rec = opts.params !== undefined
          ? recommendPlacement(next, arr.id, null, opts.params)
          : recommendPlacement(next, arr.id);
      } catch (exc) {
        changes.push(`Placement skipped for "${arr.label}" (${(exc as Error).message}).`);
        continue;
      }
      if (!rec.arrayPos) continue;
      next = setDevicePosition(next, arr.id, rec.arrayPos);
      next = setDeviceElevation(next, arr.id, rec.arrayElev);
      changes.push(
        `Placed "${arr.label}" at (${rec.arrayPos.x.toFixed(2)}, ${rec.arrayPos.y.toFixed(2)}) m, ` +
          `elev ${rec.arrayElev.toFixed(2)} m (score ${rec.score.total.toFixed(2)}).`,
      );
    }
  }

  if (assignChannels) {
    for (const arr of next.devices) {
      if (arr.type !== 'microphoneArray') continue;
      const pickups = arr.zones.filter((z) => z.type !== 'exclusion');
      const unassigned = pickups.filter((z) => z.outputChannel === undefined);
      if (unassigned.length > 0) {
        next = autoAssignZoneChannels(next, arr.id);
        changes.push(`Assigned ${unassigned.length} output channel(s) on "${arr.label}".`);
      }
    }
  }

  let ar: AutoRouteResult | undefined;
  if (doRoute) {
    ar = autoRoute(next);
    next = ar.config;
    changes.push(...ar.changes);
  }

  if (changes.length === 0) {
    changes.push('Nothing to optimize — room already placed, channelled, and routed.');
  }
  return ar !== undefined ? { config: next, changes, autoRoute: ar } : { config: next, changes };
}
