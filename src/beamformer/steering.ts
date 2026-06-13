/**
 * Translate engine *coverage zones* into beamformer *look directions* (stdlib).
 *
 * Port of `conf_pipeline_control/steering.py`. This is the bridge between the
 * planning model and the DSP: the areas you draw in the app (Records / dedicated
 * = **pickup**, No-pickup = **exclusion**) become unit direction vectors in the
 * array's local frame, which the beamformer steers toward (pickup) or nulls
 * (exclusion). Geometry reuses {@link steeringAngles} so a zone's bearing here is
 * identical to the steering rays drawn on the canvas.
 */
import type { SystemConfig, CoverageZone, Point2D, MicrophoneArray, Device } from '../model/index.js';
import { findDevice, isPickupZone } from '../model/index.js';
import { defaultElevation } from '../model/devices.js';
import { steeringAngles, type Point3D } from '../geometry/angles.js';
import { DEFAULT_TARGET_ELEVATION_M } from './model.js';

/**
 * A look direction in the array's local frame.
 *
 * `unit` is the unit vector pointing **from the array toward the area** (`z` up,
 * so a floor target has `uz < 0`). `azimuthDeg` / `offNadirDeg` mirror
 * {@link steeringAngles} (azimuth: compass bearing from +Y clockwise; off-nadir:
 * 0° = straight down).
 */
export interface Direction {
  unit: readonly [number, number, number];
  azimuthDeg: number;
  offNadirDeg: number;
  distanceM: number;
  label: string;
}

function isMicrophoneArray(device: Device): device is MicrophoneArray {
  return device.type === 'microphoneArray';
}

/** A representative interior point (floor plane) of a zone. */
export function zoneCentroid(zone: CoverageZone): Point2D {
  const shape = zone.shape;
  if (shape.kind === 'rect') {
    return { x: shape.origin.x + shape.width / 2.0, y: shape.origin.y + shape.height / 2.0 };
  }
  const pts = shape.points;
  if (pts.length === 0) {
    return { x: 0.0, y: 0.0 };
  }
  const sx = pts.reduce((acc, p) => acc + p.x, 0);
  const sy = pts.reduce((acc, p) => acc + p.y, 0);
  return { x: sx / pts.length, y: sy / pts.length };
}

function resolveArray(config: SystemConfig, arrayId: string): MicrophoneArray {
  const dev = findDevice(config, arrayId);
  if (dev === undefined || !isMicrophoneArray(dev)) {
    throw new Error(`${JSON.stringify(arrayId)} is not a microphone array in this config`);
  }
  if (dev.position === undefined) {
    throw new Error(`array ${JSON.stringify(arrayId)} has no position; place it in the room first`);
  }
  return dev;
}

/** Look direction from the array (at its mount height) to a floor `target`. */
export function lookDirection(
  config: SystemConfig,
  arrayId: string,
  target: Point2D,
  options: { targetElevationM?: number; label?: string } = {},
): Direction {
  const { targetElevationM = DEFAULT_TARGET_ELEVATION_M, label = '' } = options;
  const arr = resolveArray(config, arrayId);
  const roomH = config.room !== undefined ? config.room.height : 3.0;
  const mount = arr.elevation !== undefined ? arr.elevation : defaultElevation(arr, roomH);
  const position = arr.position!; // narrowed by resolveArray
  const src: Point3D = { x: position.x, y: position.y, z: mount };
  const dst: Point3D = { x: target.x, y: target.y, z: targetElevationM };
  const sa = steeringAngles(src, dst);

  const az = (sa.azimuthDeg * Math.PI) / 180;
  const nadir = (sa.offNadirDeg * Math.PI) / 180;
  const sinN = Math.sin(nadir);
  const unit: readonly [number, number, number] = [
    sinN * Math.sin(az),
    sinN * Math.cos(az),
    -Math.cos(nadir),
  ];
  return {
    unit,
    azimuthDeg: sa.azimuthDeg,
    offNadirDeg: sa.offNadirDeg,
    distanceM: sa.distance,
    label,
  };
}

/** Look direction toward a zone's centroid (labelled with the zone's label). */
export function zoneLookDirection(
  config: SystemConfig,
  arrayId: string,
  zone: CoverageZone,
  options: { targetElevationM?: number } = {},
): Direction {
  const { targetElevationM = DEFAULT_TARGET_ELEVATION_M } = options;
  return lookDirection(config, arrayId, zoneCentroid(zone), {
    targetElevationM,
    label: zone.label,
  });
}

/** One look direction per pickup zone (dynamic/dedicated) on the array. */
export function pickupDirections(
  config: SystemConfig,
  arrayId: string,
  options: { targetElevationM?: number } = {},
): Array<[CoverageZone, Direction]> {
  const { targetElevationM = DEFAULT_TARGET_ELEVATION_M } = options;
  const arr = resolveArray(config, arrayId);
  return arr.zones
    .filter((z) => isPickupZone(z))
    .map((z) => [z, zoneLookDirection(config, arrayId, z, { targetElevationM })] as [CoverageZone, Direction]);
}

/** One null direction per exclusion (No-pickup) zone on the array. */
export function exclusionDirections(
  config: SystemConfig,
  arrayId: string,
  options: { targetElevationM?: number } = {},
): Array<[CoverageZone, Direction]> {
  const { targetElevationM = DEFAULT_TARGET_ELEVATION_M } = options;
  const arr = resolveArray(config, arrayId);
  return arr.zones
    .filter((z) => !isPickupZone(z))
    .map((z) => [z, zoneLookDirection(config, arrayId, z, { targetElevationM })] as [CoverageZone, Direction]);
}
