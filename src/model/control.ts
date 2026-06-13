/**
 * Logic / control surface (v1.12.0 + v3 scenes) — config-only commissioning
 * parity with a Designer-style mute-control / logic block plus named, recallable
 * **scenes** of the operational control surface.
 *
 * No audio and no real logic I/O: these are settings + validation only. The
 * scene `steer` and per-area `active` hints are deliberately **config-inert** —
 * the live beamforming layer reads them, but recall never mutates the config's
 * zone-type invariants (a dedicated zone is `alwaysOn` by definition).
 */

/** How a mute group is triggered. Config label only — no real logic input. */
export type MuteTrigger = 'software' | 'logicIn' | 'button';

/** A reference to a coverage area's own output channel on an array. */
export interface ZoneChannelRef {
  /** Microphone-array device id. */
  arrayId: string;
  /** Coverage-zone id on that array. */
  zoneId: string;
}

/**
 * A named set of devices and/or coverage-area output channels that mute
 * together, with an optional external trigger. State + validation only.
 */
export interface MuteGroup {
  /** Stable unique id. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Devices muted together. */
  deviceIds: string[];
  /** Per-area output channels muted together. */
  zoneRefs: ZoneChannelRef[];
  /** How the group is triggered. */
  trigger: MuteTrigger;
  /** Current mute state. */
  muted: boolean;
}

/**
 * One coverage area's settings inside a {@link Scene}. `undefined` = leave
 * as-is. `gainDb` is applied to the config on recall; `active` is a **live-layer
 * hint** (include this pickup area when designing beams) — config-inert, like a
 * scene's steer entries, because the config-side `alwaysOn` flag is a zone-type
 * invariant (dedicated ⇔ `true`), not an operational toggle.
 */
export interface SceneZoneState {
  arrayId: string;
  zoneId: string;
  /** Per-area gain trim applied on recall. */
  gainDb?: number;
  /** Live-layer hint: include this area when designing beams. */
  active?: boolean;
}

/** A live-layer steer hint: aim this array at a bearing on recall. Config-inert. */
export interface SceneSteer {
  arrayId: string;
  azimuthDeg: number;
  /** Off-nadir angle (degrees from straight-down); defaults to 90 (horizontal). */
  offNadirDeg: number;
}

/**
 * A named, recallable snapshot of the operational control surface: mute-group
 * states, per-coverage-area gains / active flags, and optional per-array steer
 * hints. Recall is a pure config→config transform.
 */
export interface Scene {
  /** Stable unique id. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Mute-group id → muted. */
  muteStates: Record<string, boolean>;
  /** Per-coverage-area state. */
  zoneStates: SceneZoneState[];
  /** Per-array steer hints (config-inert). */
  steer: SceneSteer[];
}

/** Weekday keys for scene schedules, Monday-first. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** One weekday key. */
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Parse a strict 24-hour `"HH:MM"` into `[hour, minute]`, or `null` if malformed.
 * Both fields must be exactly two digits and in range.
 */
export function parseHhmm(text: string): [number, number] | null {
  const parts = text.split(':');
  if (parts.length !== 2) return null;
  if (!parts.every((p) => p.length === 2 && /^[0-9]{2}$/.test(p))) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return null;
  return [hour, minute];
}

/**
 * Recall `sceneId` at `time` (local `"HH:MM"`) on the given weekdays, every
 * week. Additive optional field on {@link ControlConfig} — the schema stays v3
 * and files without schedules are unaffected.
 */
export interface SceneSchedule {
  /** Stable unique id. */
  id: string;
  /** Scene to recall. */
  sceneId: string;
  /** Local `"HH:MM"` recall time. */
  time: string;
  /** Weekday keys this entry fires on. */
  days: string[];
  /** Whether this entry is active. */
  enabled: boolean;
}

/** The control surface attached to a {@link SystemConfig} (schema v3). */
export interface ControlConfig {
  /** Mute groups (v1.12.0). */
  muteGroups: MuteGroup[];
  /** Named recallable scenes (v3). */
  scenes: Scene[];
  /** Scene schedules (v3, additive). */
  schedules: SceneSchedule[];
}
