/**
 * Catalog of validation codes. Every code is documented here and in the README.
 * `validate()` is pure and deterministic; these codes are the stable contract.
 */

/** Severity of a validation issue. */
export type Severity = 'error' | 'warning';

/** All validation codes emitted by {@link validate}. */
export type ValidationCode =
  // --- routing ---
  /** A route's endpoint port id does not exist (e.g. removed by a mode switch). */
  | 'ORPHANED_ROUTE'
  /** A route connects mismatched transports (dante↔analog). */
  | 'ROUTE_TRANSPORT_MISMATCH'
  /** A route is not output→input (wrong direction). */
  | 'ROUTE_DIRECTION_INVALID'
  // --- AEC ---
  /** A mic's AEC reference contains the mic's own signal — destroys its audio. */
  | 'AEC_SELF_REFERENCE'
  /** A reinforced mic's AEC reference is the very speaker-feed bus carrying it. */
  | 'AEC_REINFORCED_SHARED_REFERENCE'
  /** AEC is enabled but no reference bus is assigned. */
  | 'AEC_REFERENCE_MISSING'
  /** AEC reference bus resolves to zero source signals (empty reference). */
  | 'AEC_REFERENCE_EMPTY'
  // --- coverage ---
  /** More than 8 coverage zones on an array. */
  | 'COVERAGE_ZONE_LIMIT'
  /** A zone has an invalid type/alwaysOn pairing or degenerate geometry. */
  | 'COVERAGE_ZONE_INVALID'
  /** Coverage-area output channel is out of range or assigned to an exclusion zone. */
  | 'COVERAGE_CHANNEL_INVALID'
  /** Two coverage areas on the same array share an output channel. */
  | 'COVERAGE_CHANNEL_DUPLICATE'
  /** Coverage-area gain trim is out of range. */
  | 'COVERAGE_GAIN_INVALID'
  /** Manual mode with more than 8 lobes/zones. */
  | 'MANUAL_LOBE_LIMIT'
  // --- automixer ---
  /** Automixer channel/NLP value out of range, or output bus unresolved. */
  | 'AUTOMIXER_INVALID'
  // --- profiles & DSP blocks (v1.7.0) ---
  /** Device references a profile id not in the catalog. */
  | 'DEVICE_PROFILE_UNKNOWN'
  /** Device's profile does not apply to the device's type. */
  | 'DEVICE_CAPABILITY_MISMATCH'
  /** A DSP block kind is not supported by the device's profile. */
  | 'DSP_BLOCK_UNSUPPORTED'
  /** A DSP block has out-of-range/invalid parameters. */
  | 'DSP_BLOCK_INVALID'
  /** A DSP block's `targetBusId` does not resolve to a bus on the device. */
  | 'DSP_TARGET_UNRESOLVED'
  /** AEC enabled but no far-end (codec) source exists anywhere (warning). */
  | 'AEC_NO_FAR_END'
  /** Mics exist but the automixer output bus is unset (warning). */
  | 'AUTOMIX_OUTPUT_UNSET'
  /** A mute link targets a device whose profile has no mute capability (warning). */
  | 'MUTE_LINK_UNSUPPORTED'
  /** A device has DSP blocks but no gain/mute stage (warning). */
  | 'DSP_CHAIN_NO_LEVEL'
  // --- naming (v1.8.0) ---
  /** Two or more devices share the same label (warning). */
  | 'NAMING_DUPLICATE_LABEL'
  /** A device has an empty/whitespace label (warning). */
  | 'NAMING_EMPTY_LABEL'
  // --- control: mute groups / scenes / schedules (v1.12.0 + v3) ---
  /** A mute group references a missing device or coverage area, or is empty. */
  | 'CONTROL_MUTE_GROUP_INVALID'
  /** A scene is empty, duplicates an id, or references a missing group/array/area. */
  | 'SCENE_INVALID'
  /** A scene schedule has a bad time/day, duplicates an id, or recalls a missing scene. */
  | 'SCHEDULE_INVALID'
  // --- room coverage design: cameras & furniture (v4) ---
  /** A conferencing camera has no position in the room (warning). */
  | 'CAMERA_UNPLACED'
  /** A placed camera's field of view frames no talker or seat (warning). */
  | 'CAMERA_NO_SUBJECT'
  /** A furniture object is placed outside the room outline (warning). */
  | 'FURNITURE_OUTSIDE_ROOM'
  /** A furniture object has non-positive width/depth. */
  | 'FURNITURE_GEOMETRY_INVALID'
  /** A device sits inside a furniture object's footprint, below its top (warning). */
  | 'DEVICE_INSIDE_FURNITURE';

/** Human-readable, one-line descriptions keyed by code (used in the README/catalog). */
export const CODE_DESCRIPTIONS: Record<ValidationCode, string> = {
  ORPHANED_ROUTE: 'Route references a port id that does not exist.',
  ROUTE_TRANSPORT_MISMATCH: 'Route connects mismatched transports (dante↔analog).',
  ROUTE_DIRECTION_INVALID: 'Route is not output→input.',
  AEC_SELF_REFERENCE: "Mic's AEC reference contains the mic's own signal.",
  AEC_REINFORCED_SHARED_REFERENCE:
    "Reinforced mic's AEC reference is the speaker-feed bus that carries it.",
  AEC_REFERENCE_MISSING: 'AEC enabled but no reference bus assigned.',
  AEC_REFERENCE_EMPTY: 'AEC reference bus resolves to zero source signals.',
  COVERAGE_ZONE_LIMIT: 'More than 8 coverage zones on an array.',
  COVERAGE_ZONE_INVALID: 'Zone has invalid type/alwaysOn pairing or degenerate geometry.',
  COVERAGE_CHANNEL_INVALID:
    'Coverage-area output channel is out of range or assigned to an exclusion zone.',
  COVERAGE_CHANNEL_DUPLICATE: 'Two coverage areas on the same array share an output channel.',
  COVERAGE_GAIN_INVALID: 'Coverage-area gain trim is out of range.',
  MANUAL_LOBE_LIMIT: 'Manual mode with more than 8 lobes/zones.',
  AUTOMIXER_INVALID: 'Automixer value out of range or output bus unresolved.',
  DEVICE_PROFILE_UNKNOWN: 'Device references a profile id not in the catalog.',
  DEVICE_CAPABILITY_MISMATCH: "Device's profile does not apply to its type.",
  DSP_BLOCK_UNSUPPORTED: "DSP block kind not supported by the device's profile.",
  DSP_BLOCK_INVALID: 'DSP block has out-of-range/invalid parameters.',
  DSP_TARGET_UNRESOLVED: "DSP block target bus does not resolve on the device.",
  AEC_NO_FAR_END: 'AEC enabled but no far-end (codec) source exists.',
  AUTOMIX_OUTPUT_UNSET: 'Mics exist but the automixer output bus is unset.',
  MUTE_LINK_UNSUPPORTED: 'Mute link targets a device with no mute capability.',
  DSP_CHAIN_NO_LEVEL: 'Device has DSP blocks but no gain/mute stage.',
  NAMING_DUPLICATE_LABEL: 'Two or more devices share the same label.',
  NAMING_EMPTY_LABEL: 'A device has an empty label.',
  CONTROL_MUTE_GROUP_INVALID:
    'A mute group references a missing device or coverage area, or is empty.',
  SCENE_INVALID:
    "A scene is empty, duplicates another scene's id, or references a missing mute group, array, or coverage area.",
  SCHEDULE_INVALID:
    "A scene schedule has a bad time/day, duplicates another schedule's id, or recalls a missing scene.",
  CAMERA_UNPLACED: 'A conferencing camera has no position in the room.',
  CAMERA_NO_SUBJECT: "A placed camera's field of view frames no talker or seat.",
  FURNITURE_OUTSIDE_ROOM: 'A furniture object is placed outside the room outline.',
  FURNITURE_GEOMETRY_INVALID: 'A furniture object has non-positive width/depth.',
  DEVICE_INSIDE_FURNITURE: "A device sits inside a furniture object's footprint, below its top.",
};

/** A single validation finding with references to the offending entities. */
export interface ValidationIssue {
  /** Severity. */
  severity: Severity;
  /** Stable machine-readable code. */
  code: ValidationCode;
  /** Human-readable explanation, including the domain rule where relevant. */
  message: string;
  /** Ids of the entities (devices/ports/routes/buses/zones) this issue refers to. */
  refs: string[];
}

/** Outcome of {@link validate}: split errors/warnings plus an `ok` summary. */
export interface ValidationResult {
  /** `true` iff there are no errors (warnings are allowed). */
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
