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
  /** Manual mode with more than 8 lobes/zones. */
  | 'MANUAL_LOBE_LIMIT'
  // --- automixer ---
  /** Automixer channel/NLP value out of range, or output bus unresolved. */
  | 'AUTOMIXER_INVALID';

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
  MANUAL_LOBE_LIMIT: 'Manual mode with more than 8 lobes/zones.',
  AUTOMIXER_INVALID: 'Automixer value out of range or output bus unresolved.',
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
