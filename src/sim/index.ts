/**
 * Placement simulation & recommendation.
 *
 * Given a room, a microphone array, and talkers, recommend the best array pose
 * (position + steer) and the best seat for a talker, by sweeping a fast
 * geometric scoring model ({@link ./scoring.js}) with a coarse-to-fine joint
 * search ({@link ./search.js}). An optional, pluggable physics backend
 * ({@link ./validate.js}) would check the single top pick — but no backend is
 * available in this zero-dependency port.
 *
 * The heuristic engine is pure (no external deps); the validator only ever
 * reports that no numerical backend is installed.
 */
export type {
  Candidate,
  Heatmap,
  PlacementScore,
  Recommendation,
  SimParams,
  SimValidationResult,
} from './types.js';
export { defaultSimParams, heatmapAt } from './types.js';
export { estimatedRt60, scorePlacement } from './scoring.js';
export { recommendPlacement, scoreHeatmap } from './search.js';
export { availableBackends, numpyAvailable, validateRecommendation } from './validate.js';
