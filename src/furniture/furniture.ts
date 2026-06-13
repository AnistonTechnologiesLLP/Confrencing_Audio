/**
 * Furniture catalog: default geometry / acoustics per room-object kind (v4).
 *
 * Like the device-profile catalog, this is a static, **non-serialized** factory
 * of defaults. A {@link RoomObject} stores only a `kind` plus optional
 * per-instance overrides; the resolvers here combine those with the catalog so
 * the coverage simulator, the validator, and the UI all agree on a piece of
 * furniture's footprint, height, occlusion behaviour, and acoustic absorption.
 */

import { type Point2D, obbCorners } from '../model/geometry.js';
import type { RoomObject } from '../model/room.js';

/** Catalog entry: default geometry + acoustics + occlusion for a furniture kind. */
export interface FurnitureType {
  kind: string;
  label: string;
  /** Width along local +X (before rotation), metres. */
  width: number;
  /** Depth along local +Y, metres. */
  depth: number;
  /** Height, metres. */
  height: number;
  /** Sabine absorption coefficient, 0..1. */
  absorption: number;
  /** Opaque to a camera's line of sight. */
  blocksCamera: boolean;
  /** Tall/solid enough to shadow sound (coarse). */
  blocksAudio: boolean;
  /** Nominal seating capacity. */
  seatCapacity: number;
}

function ft(
  kind: string,
  label: string,
  width: number,
  depth: number,
  height: number,
  absorption: number,
  blocksCamera: boolean,
  blocksAudio: boolean,
  seatCapacity = 0,
): FurnitureType {
  return { kind, label, width, depth, height, absorption, blocksCamera, blocksAudio, seatCapacity };
}

/**
 * Sensible defaults; all dimensions in metres. `blocks*` reflect whether a
 * typical item is tall/solid enough to occlude a seated person's face (camera)
 * or shadow sound (audio).
 */
export const FURNITURE_CATALOG: Record<string, FurnitureType> = {
  table: ft('table', 'Table', 2.4, 1.0, 0.74, 0.1, false, false),
  desk: ft('desk', 'Desk', 1.4, 0.7, 0.74, 0.1, false, false),
  chair: ft('chair', 'Chair', 0.55, 0.55, 0.9, 0.3, false, false, 1),
  seat: ft('seat', 'Seat', 0.55, 0.55, 0.5, 0.35, false, false, 1),
  sofa: ft('sofa', 'Sofa', 2.0, 0.9, 0.85, 0.45, true, false, 3),
  cabinet: ft('cabinet', 'Cabinet', 1.2, 0.5, 1.6, 0.15, true, true),
  screen: ft('screen', 'Display / screen', 1.8, 0.1, 1.4, 0.12, true, true),
  door: ft('door', 'Door', 0.9, 0.1, 2.1, 0.06, false, false),
  window: ft('window', 'Window', 1.4, 0.1, 1.4, 0.05, false, false),
  plant: ft('plant', 'Plant', 0.6, 0.6, 1.5, 0.2, false, false),
};

export const DEFAULT_FURNITURE_KIND = 'table';
export const FURNITURE_KINDS: readonly string[] = Object.keys(FURNITURE_CATALOG);

/** Catalog entry for a kind, or `undefined`. */
export function furnitureType(kind: string): FurnitureType | undefined {
  return FURNITURE_CATALOG[kind];
}

// ---- resolvers: per-instance override → catalog default → hard fallback ---- //

/** `[width, depth, height]` in metres for a room object, honouring overrides. */
export function resolvedDimensions(obj: RoomObject): [number, number, number] {
  const c = FURNITURE_CATALOG[obj.kind];
  const w = obj.width ?? c?.width ?? 0.8;
  const d = obj.depth ?? c?.depth ?? 0.8;
  const h = obj.height ?? c?.height ?? 0.8;
  return [w, d, h];
}

/** Sabine absorption coefficient for a room object. */
export function resolvedAbsorption(obj: RoomObject): number {
  const c = FURNITURE_CATALOG[obj.kind];
  return obj.absorption ?? c?.absorption ?? 0.1;
}

/** Whether the object occludes a camera's line of sight (`undefined` ⇒ catalog/`true`). */
export function blocksCamera(obj: RoomObject): boolean {
  if (obj.blocksCamera !== undefined) return obj.blocksCamera;
  return FURNITURE_CATALOG[obj.kind]?.blocksCamera ?? true;
}

/** Whether the object shadows sound (`undefined` ⇒ catalog/`false`). */
export function blocksAudio(obj: RoomObject): boolean {
  if (obj.blocksAudio !== undefined) return obj.blocksAudio;
  return FURNITURE_CATALOG[obj.kind]?.blocksAudio ?? false;
}

/** Oriented footprint (4 corners) of a room object on the floor plane. */
export function furnitureCorners(obj: RoomObject): Point2D[] {
  const [w, d] = resolvedDimensions(obj);
  return obbCorners(obj.position, w, d, obj.rotationDeg ?? 0);
}
