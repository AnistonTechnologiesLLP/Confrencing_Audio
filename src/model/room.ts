import type { Point2D } from './geometry.js';

/**
 * Optional room layout, shaped to be compatible with a room-builder export.
 * The pipeline functions fully WITHOUT a room; when present, coverage zones and
 * device positions may be interpreted in this room's coordinate space.
 */
export interface RoomLayout {
  /** Floor outline, ordered vertices, in {@link RoomLayout.units}. */
  vertices: Point2D[];
  /** Ceiling height. */
  height: number;
  /** Units the room is expressed in. This module standardizes on metres. */
  units: 'meters';
  /** Arbitrary furniture / fixtures, opaque to this module. */
  objects: RoomObject[];
  /** Optional floor-plan image laid under the room (v1.10.0). */
  background?: RoomBackground;
}

/**
 * A floor-plan image laid under the room (v1.10.0). `path` is a file reference
 * (not embedded); `imageWidthPx`/`imageHeightPx` persist so the world rect is
 * reconstructable even if the file is missing. `scaleMPerPx` is `undefined`
 * until calibrated; `origin` is the world coordinate (metres) of the image's
 * top-left corner.
 */
export interface RoomBackground {
  /** File reference to the image (not embedded in the config). */
  path: string;
  /** Source image width in pixels. */
  imageWidthPx: number;
  /** Source image height in pixels. */
  imageHeightPx: number;
  /** Metres-per-pixel scale, once calibrated (`undefined` until then). */
  scaleMPerPx?: number;
  /** World coordinate (metres) of the image's top-left corner. */
  origin: Point2D;
  /** Render opacity, `0..1`. */
  opacity: number;
}

/**
 * A sit/stand position implied by a piece of furniture (a chair/sofa seat), v4.
 * Seats let the coverage simulator treat "where people sit" as camera/mic targets
 * without separate talkers.
 */
export interface SeatAnchor {
  /** Floor point, metres. */
  position: Point2D;
  /** Optional compass bearing the occupant faces (0° = +Y). */
  facingDeg?: number;
}

/**
 * A furniture item / obstacle in the room. The first fields are the original v1
 * shape (kept so legacy configs round-trip byte-identically); everything after is
 * optional furniture geometry (v4): real dimensions, yaw, seats, an acoustic
 * absorption coefficient, and occlusion flags. Unset overrides fall back to the
 * furniture catalog defaults for `kind`; `blocksCamera` defaults to `true` and
 * `blocksAudio` to `false` when unset.
 */
export interface RoomObject {
  id: string;
  kind: string;
  position: Point2D;
  /** Free-form metadata; not interpreted by the pipeline. */
  meta?: Record<string, string | number | boolean>;
  /** Width along local +X (before rotation), metres. */
  width?: number;
  /** Depth along local +Y, metres. */
  depth?: number;
  /** Height, metres. */
  height?: number;
  /** Clockwise yaw, degrees (0° = +Y). */
  rotationDeg?: number;
  /** Nominal seating capacity. */
  seatCapacity?: number;
  /** Explicit seat anchors (camera/mic targets). */
  seats?: SeatAnchor[];
  /** Sabine absorption coefficient, 0..1. */
  absorption?: number;
  /** Opaque to a camera's line of sight (`undefined` ⇒ catalog default, treated as `true`). */
  blocksCamera?: boolean;
  /** Tall/solid enough to shadow sound (`undefined` ⇒ catalog default, treated as `false`). */
  blocksAudio?: boolean;
}
