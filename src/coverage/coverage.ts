import type { Port } from '../model/ports.js';
import type { MicrophoneArray } from '../model/devices.js';
import {
  type CoverageMode,
  type CoverageZone,
  MAX_ZONES_PER_ARRAY,
  MAX_MANUAL_LOBES,
  DEFAULT_DEDICATED_ZONE_SIZE_M,
  ZONE_GAIN_DB_MIN,
  ZONE_GAIN_DB_MAX,
  isPickupZone,
} from '../model/coverage.js';
import type { Point2D, ZoneShape } from '../model/geometry.js';

/**
 * Coverage subsystem: zone management and mode-driven output-port regeneration
 * for {@link MicrophoneArray} devices. Pure functions returning new devices.
 *
 * Output-port topology is a function of {@link CoverageMode}:
 *  - `automatic` → exactly one mixed Dante output (`<id>-out-mix`).
 *  - `manual`    → one Dante output per zone/lobe (capped at 8,
 *    `<id>-out-lobe-N`) plus one automix output (`<id>-out-automix`).
 */

/** Typed error thrown by coverage operations that violate domain limits. */
export class CoverageError extends Error {
  constructor(
    /** Machine-readable code mirroring a validation code. */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoverageError';
  }
}

function outPort(arrayId: string, suffix: string, label: string): Port {
  return {
    id: `${arrayId}-out-${suffix}`,
    deviceId: arrayId,
    kind: 'output',
    transport: 'dante',
    label,
  };
}

/**
 * Compute the Dante output ports an array should expose for a given mode and
 * zone count. Deterministic and pure.
 *
 * @param arrayId  The array device id (used to namespace port ids).
 * @param mode     Coverage mode.
 * @param zoneCount Number of zones (clamped to {@link MAX_MANUAL_LOBES} for lobes).
 */
/** Count zones that produce a pickup lobe (everything except `exclusion`). */
export function pickupZoneCount(zones: CoverageZone[]): number {
  return zones.filter(isPickupZone).length;
}

/**
 * One dedicated Dante output per pickup zone that carries an `outputChannel`
 * (Designer steerable-coverage style). Channels are emitted in ascending order
 * so the port list is stable regardless of zone draw order.
 */
function zoneChannelPorts(arrayId: string, zones: CoverageZone[]): Port[] {
  return zones
    .filter((z): z is CoverageZone & { outputChannel: number } =>
      isPickupZone(z) && z.outputChannel !== undefined,
    )
    .sort((a, b) => a.outputChannel - b.outputChannel)
    .map((z) =>
      outPort(arrayId, `ch-${z.outputChannel}`, `Coverage Ch ${z.outputChannel} (${z.label})`),
    );
}

/**
 * Generate output ports for a mode. In manual mode `lobeZoneCount` is the number
 * of **pickup** zones (exclusion zones produce no lobe). When `zones` carry
 * per-area `outputChannel`s, one `<id>-out-ch-N` port is appended per channel.
 */
export function generateArrayOutputPorts(
  arrayId: string,
  mode: CoverageMode,
  lobeZoneCount: number,
  zones: CoverageZone[] = [],
): Port[] {
  const zonePorts = zoneChannelPorts(arrayId, zones);
  if (mode === 'automatic') {
    return [outPort(arrayId, 'mix', 'Mixed Dante Out'), ...zonePorts];
  }
  const lobeCount = Math.min(Math.max(lobeZoneCount, 0), MAX_MANUAL_LOBES);
  const ports: Port[] = [];
  for (let i = 1; i <= lobeCount; i++) {
    ports.push(outPort(arrayId, `lobe-${i}`, `Lobe ${i} Dante Out`));
  }
  ports.push(outPort(arrayId, 'automix', 'Automix Dante Out'));
  ports.push(...zonePorts);
  return ports;
}

/**
 * Create a microphone array with ports derived from its initial mode/zones.
 * AEC starts disabled with no reference.
 */
export function createMicrophoneArray(
  id: string,
  label: string,
  mode: CoverageMode = 'automatic',
  zones: CoverageZone[] = [],
  position?: Point2D,
): MicrophoneArray {
  if (zones.length > MAX_ZONES_PER_ARRAY) {
    throw new CoverageError(
      'COVERAGE_ZONE_LIMIT',
      `Array "${id}" cannot have more than ${MAX_ZONES_PER_ARRAY} zones (got ${zones.length}).`,
    );
  }
  zones.forEach(assertZoneValid);
  const array: MicrophoneArray = {
    id,
    type: 'microphoneArray',
    label,
    ports: generateArrayOutputPorts(id, mode, pickupZoneCount(zones), zones),
    coverageMode: mode,
    zones: [...zones],
    aec: { enabled: false, referenceBusId: null },
    profileId: 'generic-ceiling-array',
    dspBlocks: [],
  };
  if (position !== undefined) array.position = position;
  return array;
}

/**
 * Switch an array's coverage mode, **regenerating** its output ports. Routes are
 * NOT touched here — the caller/validation reports routes that referenced now-
 * removed ports as orphans (see `findOrphanedRoutes`). Returns a new array.
 */
export function setCoverageMode(array: MicrophoneArray, mode: CoverageMode): MicrophoneArray {
  return {
    ...array,
    coverageMode: mode,
    ports: generateArrayOutputPorts(array.id, mode, pickupZoneCount(array.zones), array.zones),
  };
}

/**
 * Add a coverage zone, enforcing the per-array max of 8 and the
 * dedicated⇒alwaysOn / dynamic⇒!alwaysOn invariants. In manual mode the new
 * zone grows the lobe-output set; ports are regenerated. Returns a new array.
 */
export function addCoverageZone(array: MicrophoneArray, zone: CoverageZone): MicrophoneArray {
  if (array.zones.length >= MAX_ZONES_PER_ARRAY) {
    throw new CoverageError(
      'COVERAGE_ZONE_LIMIT',
      `Array "${array.id}" already has ${MAX_ZONES_PER_ARRAY} zones; cannot add another.`,
    );
  }
  assertZoneValid(zone);
  const zones = [...array.zones, zone];
  return {
    ...array,
    zones,
    ports: generateArrayOutputPorts(array.id, array.coverageMode, pickupZoneCount(zones), zones),
  };
}

/**
 * Replace a zone's geometry (e.g. after dragging/resizing it in a room editor).
 * Validates the new shape. No-op if the zone id is absent. Returns a new array.
 */
export function updateZoneShape(
  array: MicrophoneArray,
  zoneId: string,
  shape: ZoneShape,
): MicrophoneArray {
  if (!array.zones.some((z) => z.id === zoneId)) return array;
  assertShapeValid(zoneId, shape);
  return {
    ...array,
    zones: array.zones.map((z) => (z.id === zoneId ? { ...z, shape } : z)),
  };
}

/** Remove a zone by id (no-op if absent). Regenerates ports. Returns a new array. */
export function removeCoverageZone(array: MicrophoneArray, zoneId: string): MicrophoneArray {
  const zones = array.zones.filter((z) => z.id !== zoneId);
  if (zones.length === array.zones.length) return array;
  return {
    ...array,
    zones,
    ports: generateArrayOutputPorts(array.id, array.coverageMode, pickupZoneCount(zones), zones),
  };
}

// ---------------------------------------------------------------------------
// Per-coverage-area output channel + gain (v1.12.0, Designer steerable coverage)
// ---------------------------------------------------------------------------

/** Set a zone's `outputChannel`, returning a new zone (key omitted when clearing). */
function withChannel(zone: CoverageZone, channel: number | undefined): CoverageZone {
  const { outputChannel: _omit, ...rest } = zone;
  return channel === undefined ? { ...rest } : { ...rest, outputChannel: channel };
}

/** Set a zone's `gainDb`, returning a new zone (key omitted when clearing). */
function withGain(zone: CoverageZone, gainDb: number | undefined): CoverageZone {
  const { gainDb: _omit, ...rest } = zone;
  return gainDb === undefined ? { ...rest } : { ...rest, gainDb };
}

/**
 * Assign (or clear, with `undefined`) a coverage area's own output channel. The
 * zone must be a pickup zone, `1..8`, and unique on the array. Regenerates the
 * array's output ports so the per-area Dante out appears. Returns a new array.
 */
export function setZoneOutputChannel(
  array: MicrophoneArray,
  zoneId: string,
  channel: number | undefined,
): MicrophoneArray {
  const zone = array.zones.find((z) => z.id === zoneId);
  if (!zone) {
    throw new CoverageError('COVERAGE_ZONE_INVALID', `Array "${array.id}" has no zone "${zoneId}".`);
  }
  if (channel !== undefined) {
    if (!isPickupZone(zone)) {
      throw new CoverageError(
        'COVERAGE_CHANNEL_INVALID',
        `Exclusion zone "${zoneId}" cannot have an output channel.`,
      );
    }
    if (!(channel >= 1 && channel <= MAX_ZONES_PER_ARRAY && Number.isInteger(channel))) {
      throw new CoverageError(
        'COVERAGE_CHANNEL_INVALID',
        `Output channel ${channel} out of range 1..${MAX_ZONES_PER_ARRAY}.`,
      );
    }
    if (array.zones.some((z) => z.id !== zoneId && z.outputChannel === channel)) {
      throw new CoverageError(
        'COVERAGE_CHANNEL_DUPLICATE',
        `Array "${array.id}" already uses output channel ${channel}.`,
      );
    }
  }
  const zones = array.zones.map((z) => (z.id === zoneId ? withChannel(z, channel) : z));
  return {
    ...array,
    zones,
    ports: generateArrayOutputPorts(array.id, array.coverageMode, pickupZoneCount(zones), zones),
  };
}

/** Set (or clear, with `undefined`) a coverage area's per-area gain trim (dB). Returns a new array. */
export function setZoneGainDb(
  array: MicrophoneArray,
  zoneId: string,
  gainDb: number | undefined,
): MicrophoneArray {
  const zone = array.zones.find((z) => z.id === zoneId);
  if (!zone) {
    throw new CoverageError('COVERAGE_ZONE_INVALID', `Array "${array.id}" has no zone "${zoneId}".`);
  }
  if (gainDb !== undefined && !(gainDb >= ZONE_GAIN_DB_MIN && gainDb <= ZONE_GAIN_DB_MAX)) {
    throw new CoverageError(
      'COVERAGE_GAIN_INVALID',
      `Zone gain ${gainDb} dB out of range [${ZONE_GAIN_DB_MIN}, ${ZONE_GAIN_DB_MAX}].`,
    );
  }
  const zones = array.zones.map((z) => (z.id === zoneId ? withGain(z, gainDb) : z));
  return { ...array, zones };
}

/**
 * Assign sequential output channels (1, 2, …) to every pickup zone that lacks
 * one, preserving any already-assigned channels. Idempotent. Returns a new array.
 */
export function autoAssignZoneChannels(array: MicrophoneArray): MicrophoneArray {
  const used = new Set<number>(
    array.zones.map((z) => z.outputChannel).filter((c): c is number => c !== undefined),
  );
  let nextCh = 1;
  const zones = array.zones.map((z) => {
    if (isPickupZone(z) && z.outputChannel === undefined) {
      while (used.has(nextCh) && nextCh <= MAX_ZONES_PER_ARRAY) nextCh += 1;
      if (nextCh <= MAX_ZONES_PER_ARRAY) {
        used.add(nextCh);
        return withChannel(z, nextCh);
      }
    }
    return z;
  });
  return {
    ...array,
    zones,
    ports: generateArrayOutputPorts(array.id, array.coverageMode, pickupZoneCount(zones), zones),
  };
}

/**
 * Build a dynamic coverage zone (picks up talkers inside `shape`; `alwaysOn`
 * forced `false`).
 */
export function dynamicZone(id: string, label: string, shape: ZoneShape): CoverageZone {
  return { id, type: 'dynamic', shape, alwaysOn: false, label };
}

/**
 * Build a dedicated coverage zone (`alwaysOn` forced `true`). Defaults to the
 * canonical ~1.8 m square at `origin` when no explicit shape is given.
 */
export function dedicatedZone(
  id: string,
  label: string,
  origin: Point2D,
  sizeMeters: number = DEFAULT_DEDICATED_ZONE_SIZE_M,
): CoverageZone {
  return {
    id,
    type: 'dedicated',
    shape: { kind: 'rect', origin, width: sizeMeters, height: sizeMeters },
    alwaysOn: true,
    label,
  };
}

/**
 * Build an **exclusion** (no-pickup) zone: a region whose audio is suppressed,
 * even where it overlaps a pickup zone. Produces no output lobe; `alwaysOn`
 * forced `false`. Planning annotation only (no audio is processed).
 */
export function exclusionZone(id: string, label: string, shape: ZoneShape): CoverageZone {
  return { id, type: 'exclusion', shape, alwaysOn: false, label };
}

/** Validate a zone's type/geometry/invariants. Throws {@link CoverageError}. */
export function assertZoneValid(zone: CoverageZone): void {
  const expectedAlwaysOn = zone.type === 'dedicated';
  if (zone.alwaysOn !== expectedAlwaysOn) {
    throw new CoverageError(
      'COVERAGE_ZONE_INVALID',
      `Zone "${zone.id}" (${zone.type}) must have alwaysOn=${expectedAlwaysOn}.`,
    );
  }
  assertShapeValid(zone.id, zone.shape);
}

function assertShapeValid(zoneId: string, shape: ZoneShape): void {
  if (shape.kind === 'rect') {
    if (!(shape.width > 0) || !(shape.height > 0)) {
      throw new CoverageError(
        'COVERAGE_ZONE_INVALID',
        `Zone "${zoneId}" rect must have positive width and height.`,
      );
    }
  } else {
    if (shape.points.length < 3) {
      throw new CoverageError(
        'COVERAGE_ZONE_INVALID',
        `Zone "${zoneId}" polygon needs at least 3 vertices (got ${shape.points.length}).`,
      );
    }
  }
}
