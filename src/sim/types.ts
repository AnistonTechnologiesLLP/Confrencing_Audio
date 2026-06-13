/**
 * Value types for the placement-simulation / recommendation engine.
 *
 * Pure data — no acoustics or search logic here (those live in {@link
 * ./scoring.js} and {@link ./search.js}). Every type is an immutable value
 * object the engine never mutates: a {@link Recommendation} can be stashed on
 * UI state, and the engine never edits a caller's
 * {@link ../model/index.js#SystemConfig}.
 *
 * Coordinates follow the rest of the package: the floor plane is `(x, y)`
 * metres, `z` is height above the floor, and azimuth is the compass-style
 * bearing from {@link ../geometry/angles.js#steeringAngles} (`+Y = 0°`,
 * `+X = 90°`).
 */
import type { Point2D } from '../model/index.js';
import { DEFAULT_TALKER_ELEVATION_M } from '../model/index.js';

/**
 * Knobs for the heuristic sweep + (optional) physics validation. Weights need
 * not sum to 1 — the combiner normalises by their sum.
 *
 * Use {@link defaultSimParams} to obtain a value populated with the same
 * defaults as the Python `SimParams()` dataclass.
 */
export interface SimParams {
  // --- search grid (metres / degrees) ---
  gridStepM: number;
  refineStepM: number;
  refineRadiusM: number;
  /** Hard guard: auto-coarsen the grid past this many candidate cells. */
  maxCells: number;

  // --- geometry / heights ---
  /** `null` -> room height (ceiling mount). */
  arrayHeightM: number | null;
  /** 1.2 m mouth height. */
  talkerHeightM: number;
  /** Don't recommend a seat on top of another talker. */
  minTalkerSeparationM: number;

  // --- modelling scope ---
  /**
   * Score each talker by the BEST-covering array (the one being placed plus any
   * other placed arrays held fixed), instead of only the array under edit.
   */
  considerAllArrays: boolean;
  /**
   * Restrict recommended seats to the pickup/dedicated zones (the "table" /
   * seating area) when any are defined — so people are seated at the table, not
   * on open floor. Falls back to the whole room when no pickup zone exists.
   */
  seatInPickupZones: boolean;

  // --- acoustics ---
  /** `null` -> Sabine estimate from room volume. */
  rt60S: number | null;
  /** Average Sabine absorption coeff (used only when rt60 estimated). */
  absorption: number;

  // --- capture / directivity model ---
  /** 0 dB reference distance for the level term. */
  refDistanceM: number;
  /** Main-lobe half-angle of a ceiling array. */
  lobeHalfwidthDeg: number;
  /** Maps direct level -> [0,1]. */
  levelWindowDb: [number, number];
  /** Maps DRR -> [0,1]. */
  drrWindowDb: [number, number];

  // --- objective weights ---
  wSnr: number;
  wDrr: number;
  wCoverage: number;
  wFairness: number;
}

/** Build a {@link SimParams} with the Python `SimParams()` defaults, optionally overriding fields. */
export function defaultSimParams(overrides: Partial<SimParams> = {}): SimParams {
  return {
    gridStepM: 0.5,
    refineStepM: 0.1,
    refineRadiusM: 0.75,
    maxCells: 60000,
    arrayHeightM: null,
    talkerHeightM: DEFAULT_TALKER_ELEVATION_M,
    minTalkerSeparationM: 0.6,
    considerAllArrays: true,
    seatInPickupZones: true,
    rt60S: null,
    absorption: 0.18,
    refDistanceM: 1.0,
    lobeHalfwidthDeg: 35.0,
    levelWindowDb: [-24.0, 6.0],
    // DRR window tuned for ceiling pickup: a 3 m array onto a 1.2 m mouth sits
    // ~1.8 m away, already past the critical distance in most rooms, so the
    // window starts well below 0 dB to keep the objective discriminative.
    drrWindowDb: [-15.0, 3.0],
    wSnr: 0.35,
    wDrr: 0.25,
    wCoverage: 0.25,
    wFairness: 0.15,
    ...overrides,
  };
}

/**
 * A scored placement for one talker. Sub-scores are normalised to `0..1`; the
 * `*Db` / angle fields carry the raw physical quantities for display.
 */
export interface PlacementScore {
  /** Combined 0..1 (incl. fairness when scored in context). */
  total: number;
  /** 0..1 sub-score. */
  snr: number;
  drr: number;
  coverage: number;
  fairness: number;
  // raw quantities (for tooltips / debugging)
  distanceM: number;
  offNadirDeg: number;
  offAxisDeg: number;
  directLevelDb: number;
  /** `null` when no room geometry is available. */
  drrDb: number | null;
  inPickupZone: boolean;
  inExclusionZone: boolean;
}

/** One point in the joint search space: an array pose + (optional) seat. */
export interface Candidate {
  arrayPos: Point2D;
  arrayElev: number;
  /** 0 = straight down (nadir). */
  steerOffNadirDeg: number;
  steerAzDeg: number;
  /** `null` in array-only (multi-talker) mode. */
  talkerPos: Point2D | null;
  talkerElev: number;
}

/** The engine's answer: where to mount/steer the array and where to seat. */
export interface Recommendation {
  arrayId: string;
  arrayPos: Point2D;
  arrayElev: number;
  steerAzDeg: number;
  steerOffNadirDeg: number;
  talkerId: string | null;
  talkerPos: Point2D | null;
  score: PlacementScore;
  /** Per-talker quality breakdown at the recommended array placement. */
  perTalker: Record<string, PlacementScore>;
  validated: SimValidationResult | null;
  /** Human-readable caveat (e.g. "no talkers", "no room"). */
  note: string;
}

/**
 * Row-major grid of array-position scores (talkers held fixed).
 *
 * `values[iy * nx + ix]` is the score for the cell whose centre is at
 * `(origin.x + ix*stepM, origin.y + iy*stepM)`; `null` marks a cell outside the
 * room or inside an exclusion zone (skipped when drawing). Use {@link heatmapAt}
 * to index into a heatmap.
 */
export interface Heatmap {
  origin: Point2D;
  stepM: number;
  nx: number;
  ny: number;
  values: Array<number | null>;
  vmin: number;
  vmax: number;
}

/** Index a {@link Heatmap}'s row-major `values` (the Python `Heatmap.at`). */
export function heatmapAt(hm: Heatmap, ix: number, iy: number): number | null {
  return hm.values[iy * hm.nx + ix] ?? null;
}

/**
 * Physics-backend check of a single recommended geometry.
 *
 * Named `SimValidationResult` to avoid clashing with the validation engine's
 * `ValidationResult`.
 */
export interface SimValidationResult {
  /** "farfield" | "pyroomacoustics". */
  backend: string;
  /** Short description of the model used. */
  method: string;
  predictedSnrDb: number;
  predictedDrrDb: number | null;
  /** Array gain at the talker direction, vs on-axis. */
  beamOffAxisDb: number;
  nMics: number;
}
