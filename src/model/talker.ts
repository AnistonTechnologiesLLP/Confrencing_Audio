import type { Point2D } from './geometry.js';

/**
 * A **talker** (participant / person speaking) placed in the room. Unlike a
 * {@link Device}, a talker is not a signal-graph node — it has no ports. It is a
 * physical voice-source position used for coverage and steering-angle planning:
 * is this person inside a pickup zone, and at what azimuth / down-tilt does a
 * ceiling array "see" them? Planning abstraction only; no audio is processed.
 */
export interface Talker {
  /** Stable unique id. */
  id: string;
  /** Human-readable label (e.g. "Presenter", "Seat 4"). */
  label: string;
  /** Floor position (x, y), metres, in room/coverage coordinates. */
  position: Point2D;
  /** Mouth height above the floor, metres. Defaults to {@link DEFAULT_TALKER_ELEVATION_M}. */
  elevation?: number;
}

/** Default talker mouth height, metres (~seated speaking height). */
export const DEFAULT_TALKER_ELEVATION_M = 1.2;
