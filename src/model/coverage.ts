import type { ZoneShape } from './geometry.js';

/**
 * Coverage configuration for a {@link MicrophoneArray}.
 *
 * An array operates in one of two modes, which determine how many Dante output
 * ports it exposes (see `src/coverage/`):
 *
 *  - `automatic` — the array folds all coverage zones into a **single** mixed
 *    Dante output.
 *  - `manual`    — up to **8** individually steered lobes, **each** with its own
 *    Dante output, **plus** one automix output.
 */
export type CoverageMode = 'automatic' | 'manual';

/** Maximum coverage zones per array. */
export const MAX_ZONES_PER_ARRAY = 8;

/** Maximum independently-steered lobes (and thus discrete outputs) in manual mode. */
export const MAX_MANUAL_LOBES = 8;

/** Canonical dedicated-zone side length, metres (~6 ft). Used as a default only. */
export const DEFAULT_DEDICATED_ZONE_SIZE_M = 1.8;

/**
 * A coverage zone within an array's pickup field.
 *
 *  - `dynamic`   — picks up any talker inside its (resizable) bounds; nothing
 *    outside any pickup zone is picked up. `alwaysOn` MUST be `false`.
 *  - `dedicated` — fixed-size region that is **always active** regardless of
 *    talker presence (lecterns, podiums, VIP seats). `alwaysOn` MUST be `true`.
 *  - `exclusion` — a **no-pickup** region: audio inside it is suppressed even
 *    where it overlaps a pickup zone (doorways, HVAC, windows). It produces no
 *    output lobe and `alwaysOn` MUST be `false`. (Planning annotation — the
 *    engine does not process audio; see README §Scope.)
 */
export type CoverageZoneType = 'dynamic' | 'dedicated' | 'exclusion';

export interface CoverageZone {
  /** Stable unique id within the array. */
  id: string;
  /** Zone behavior. */
  type: CoverageZoneType;
  /** Editable geometry, in metres. */
  shape: ZoneShape;
  /** `true` iff the zone is unconditionally active. Invariant: equals `type === 'dedicated'`. */
  alwaysOn: boolean;
  /** Human-readable label. */
  label: string;
}

/** Whether a zone produces pickup (and thus an output lobe in manual mode). */
export function isPickupZone(zone: CoverageZone): boolean {
  return zone.type !== 'exclusion';
}
