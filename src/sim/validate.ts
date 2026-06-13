/**
 * Optional physics validation of a single recommended geometry (pluggable).
 *
 * In the Python package this is the *only* place that touches
 * numerical/acoustics libraries: a `farfield` backend (numpy) and a
 * `pyroomacoustics` backend (image-source RIR). Both require external numerical
 * dependencies.
 *
 * This TypeScript port is a **zero-runtime-dependency** library, so neither
 * backend can be implemented here. The capability probes therefore report that
 * nothing is installed: {@link numpyAvailable} is always `false` and
 * {@link availableBackends} is always empty. {@link validateRecommendation}
 * then behaves exactly as the Python does when no backend is installed — it
 * throws, with the same install hint — which is what the simulation test-suite
 * asserts.
 */
import type { SystemConfig } from '../model/index.js';
import {
  type Recommendation,
  type SimParams,
  type SimValidationResult,
  defaultSimParams,
} from './types.js';

// --------------------------------------------------------------------------- //
// capability probing
// --------------------------------------------------------------------------- //
/**
 * Whether numpy is importable. Always `false` in this zero-dependency port (the
 * far-field / RIR backends it would enable cannot be ported without numpy).
 */
export function numpyAvailable(): boolean {
  return false;
}

/**
 * Backends usable with no external dependencies. Both Python backends require
 * numpy (and the RIR one pyroomacoustics), so none are available here: this
 * returns an empty list.
 */
export function availableBackends(): string[] {
  return [];
}

// --------------------------------------------------------------------------- //
// public dispatch
// --------------------------------------------------------------------------- //
/**
 * Physically validate one recommended geometry with the chosen backend.
 *
 * No validation backend can run in this dependency-free port, so this always
 * throws — mirroring the Python `validate_recommendation` when no backend is
 * installed. The unused parameters preserve the Python signature.
 */
export function validateRecommendation(
  _config: SystemConfig,
  _rec: Recommendation,
  _params: SimParams = defaultSimParams(),
  _backend = 'auto',
): SimValidationResult {
  throw new Error(
    'No validation backend available. The physics validators (far-field / ' +
      'pyroomacoustics) require numerical dependencies that are not part of ' +
      'this zero-dependency library.',
  );
}
