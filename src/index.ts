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
import { CONFIG_VERSION, findDevice } from './model/config.js';
import type { Talker } from './model/talker.js';
import { DEFAULT_TALKER_ELEVATION_M } from './model/talker.js';
import { pointInShape } from './model/geometry.js';
import { steeringAngles, type SteeringAngles, type Point3D } from './geometry/angles.js';
import type { Device, MicDevice, Processor } from './model/devices.js';
import { isMicDevice, isProcessor } from './model/devices.js';
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
} from './coverage/coverage.js';
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

// ---------------------------------------------------------------------------
// Config lifecycle
// ---------------------------------------------------------------------------

/** Create an empty configuration. Matrix/automixer are wired when the first processor is added. */
export function createConfig(meta: { name: string; createdAt: string }): SystemConfig {
  return {
    version: CONFIG_VERSION,
    devices: [],
    routes: [],
    matrix: { processorId: '', inputBuses: [], outputBuses: [], cells: {} },
    automixer: { processorId: '', channels: [], nlp: 'medium', outputBusId: null },
    muteLinks: [],
    talkers: [],
    metadata: { ...meta },
  };
}

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

/**
 * Default elevation (metres above floor) used for 3D display when a device has
 * no explicit `elevation`. Ceiling devices sit near the room top; table/handheld
 * sources sit low. These are planning conveniences, not measurements.
 */
export function defaultElevation(device: Device, roomHeight = 3): number {
  switch (device.type) {
    case 'microphoneArray':
      return roomHeight; // ceiling-mounted array
    case 'loudspeaker':
      return Math.max(0, roomHeight - 0.3); // near-ceiling
    case 'codec':
      return 0.7;
    case 'processor':
      return 0.4; // rack height
    case 'wirelessMic':
    case 'wiredMic':
      return 1.1; // handheld / lectern height
    default:
      return 1;
  }
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

/** Per-array coverage finding for a talker. */
export interface TalkerCoverage {
  /** `true` iff the talker is inside at least one pickup zone and no exclusion zone. */
  captured: boolean;
  /** Array ids whose pickup zones contain the talker. */
  pickupArrays: string[];
  /** Array ids whose exclusion zones contain the talker (suppressing pickup). */
  excludedBy: string[];
}

/**
 * Determine whether a talker's floor position is **recorded**: inside any
 * array's pickup (dynamic/dedicated) zone and not inside any exclusion zone.
 * Note: an array in `automatic` mode with zero zones picks up its whole field;
 * this check is zone-based, so a talker is "captured" only where zones exist.
 */
export function talkerCoverage(config: SystemConfig, talkerId: string): TalkerCoverage {
  const talker = config.talkers.find((t) => t.id === talkerId);
  const pickupArrays: string[] = [];
  const excludedBy: string[] = [];
  if (!talker) return { captured: false, pickupArrays, excludedBy };
  for (const device of config.devices) {
    if (device.type !== 'microphoneArray') continue;
    let inPickup = false;
    let inExclusion = false;
    for (const zone of device.zones) {
      if (!pointInShape(talker.position, zone.shape)) continue;
      if (zone.type === 'exclusion') inExclusion = true;
      else inPickup = true;
    }
    if (inExclusion) excludedBy.push(device.id);
    else if (inPickup) pickupArrays.push(device.id);
  }
  return { captured: pickupArrays.length > 0 && excludedBy.length === 0, pickupArrays, excludedBy };
}

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
