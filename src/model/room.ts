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

/** An opaque object placed in the room (table, podium, etc.). */
export interface RoomObject {
  id: string;
  kind: string;
  position: Point2D;
  /** Free-form metadata; not interpreted by the pipeline. */
  meta?: Record<string, string | number | boolean>;
}
