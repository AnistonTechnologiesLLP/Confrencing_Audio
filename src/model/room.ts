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
}

/** An opaque object placed in the room (table, podium, etc.). */
export interface RoomObject {
  id: string;
  kind: string;
  position: Point2D;
  /** Free-form metadata; not interpreted by the pipeline. */
  meta?: Record<string, string | number | boolean>;
}
