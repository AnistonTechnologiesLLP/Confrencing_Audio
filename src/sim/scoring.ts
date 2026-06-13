/**
 * Heuristic acoustic scoring for placement simulation (pure arithmetic — no
 * external deps).
 *
 * Every objective is derived from geometry that the package already computes via
 * {@link ../geometry/angles.js#steeringAngles} (distance, off-nadir, azimuth)
 * plus the room volume. The array is modelled as a *point* with a downward
 * (nadir) reference axis, optionally tilted by a steer direction — so **no
 * per-element mic geometry is needed**. The four objectives are:
 *
 *  1. `snr`      direct-path level: inverse-distance spreading + main-lobe rolloff
 *  2. `drr`      direct-to-reverberant ratio from a Sabine RT60 / critical distance
 *  3. `coverage` gaussian main-lobe weight gated by pickup / exclusion zones
 *  4. `fairness` an *aggregate* over per-talker quality (balances all talkers)
 *
 * Sub-scores are normalised to `0..1` and blended by the weights in
 * {@link SimParams}.
 */
import { type SteeringAngles, steeringAngles } from '../geometry/angles.js';
import {
  type MicrophoneArray,
  type Point2D,
  type SystemConfig,
  defaultElevation,
  pointInShape,
} from '../model/index.js';
import {
  type Candidate,
  type PlacementScore,
  type SimParams,
  defaultSimParams,
} from './types.js';

// --------------------------------------------------------------------------- //
// small helpers
// --------------------------------------------------------------------------- //
function clamp01(x: number): number {
  return x < 0.0 ? 0.0 : x > 1.0 ? 1.0 : x;
}

function norm(value: number, window: readonly [number, number]): number {
  const [lo, hi] = window;
  return hi > lo ? clamp01((value - lo) / (hi - lo)) : 0.0;
}

/**
 * Unit vector pointing from the array toward a ray at `(offNadir, az)`.
 *
 * Matches the azimuth convention of {@link steeringAngles} (`+Y = 0°`,
 * `+X = 90°`); `offNadir = 0` is straight down (`z = -1`).
 */
function unitFromNadir(offNadirDeg: number, azDeg: number): [number, number, number] {
  const onr = (offNadirDeg * Math.PI) / 180;
  const azr = (azDeg * Math.PI) / 180;
  const s = Math.sin(onr);
  return [s * Math.sin(azr), s * Math.cos(azr), -Math.cos(onr)];
}

/**
 * Angle between the array→talker ray and the steer ray (both from the array).
 *
 * With the default (un-steered, `steerOffNadir = 0`) this collapses to
 * `ang.offNadirDeg` — i.e. the same number the rest of the app reports.
 */
export function offAxisDeg(
  ang: SteeringAngles,
  steerOffNadirDeg: number,
  steerAzDeg: number,
): number {
  const t = unitFromNadir(ang.offNadirDeg, ang.azimuthDeg);
  const s = unitFromNadir(steerOffNadirDeg, steerAzDeg);
  const dot = t[0] * s[0] + t[1] * s[1] + t[2] * s[2];
  return (Math.acos(Math.max(-1.0, Math.min(1.0, dot))) * 180) / Math.PI;
}

// --------------------------------------------------------------------------- //
// room acoustics
// --------------------------------------------------------------------------- //
function polygonArea(verts: Point2D[]): number {
  let a = 0.0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vi = verts[i]!;
    const vj = verts[j]!;
    a += vi.x * vj.y - vj.x * vi.y;
  }
  return Math.abs(a) / 2.0;
}

function perimeter(verts: Point2D[]): number {
  const n = verts.length;
  let p = 0.0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vi = verts[i]!;
    const vj = verts[j]!;
    p += Math.hypot(vj.x - vi.x, vj.y - vi.y);
  }
  return p;
}

/** `[volumeM3, totalSurfaceM2]` from the room polygon, or `null`. */
export function roomVolumeAndSurface(config: SystemConfig): [number, number] | null {
  const room = config.room;
  if (room === undefined || room.vertices.length < 3) {
    return null;
  }
  const area = polygonArea(room.vertices);
  if (area <= 0) {
    return null;
  }
  const h = room.height;
  const volume = area * h;
  const surface = 2.0 * area + perimeter(room.vertices) * h;
  return [volume, surface];
}

/**
 * Sabine RT60 (seconds): `0.161 * V / (absorption * S)`.
 *
 * Returns `params.rt60S` when the user supplied one, and a neutral 0.5 s when
 * there is no room geometry to estimate from.
 */
export function estimatedRt60(
  config: SystemConfig,
  params: SimParams = defaultSimParams(),
): number {
  if (params.rt60S !== null) {
    return params.rt60S;
  }
  const vs = roomVolumeAndSurface(config);
  if (vs === null) {
    return 0.5;
  }
  const [volume, surface] = vs;
  const absorbingArea = Math.max(params.absorption * surface, 1e-6);
  return (0.161 * volume) / absorbingArea;
}

export function criticalDistance(config: SystemConfig, params: SimParams): number | null {
  const vs = roomVolumeAndSurface(config);
  if (vs === null) {
    return null;
  }
  const [volume] = vs;
  const rt60 = estimatedRt60(config, params);
  return 0.057 * Math.sqrt(Math.max(volume, 1.0) / Math.max(rt60, 0.1));
}

/** Direct-to-reverberant ratio in dB; `null` when no room geometry. */
export function drrDb(distanceM: number, criticalDistanceM: number | null): number | null {
  if (criticalDistanceM === null) {
    return null;
  }
  return -20.0 * Math.log10(Math.max(distanceM, 0.25) / Math.max(criticalDistanceM, 0.25));
}

// --------------------------------------------------------------------------- //
// per-objective sub-scores
// --------------------------------------------------------------------------- //
/** Relative direct-path level (dB) vs `refDistance`: spreading + directivity. */
export function directLevelDb(
  distanceM: number,
  offAxisAngleDeg: number,
  params: SimParams,
): number {
  const d = Math.max(distanceM, 0.25);
  const spreadDb = -20.0 * Math.log10(d / params.refDistanceM);
  const x = offAxisAngleDeg / params.lobeHalfwidthDeg;
  const dirDb = -3.0 * (x * x);
  return spreadDb + dirDb;
}

export function snrScore(levelDb: number, params: SimParams): number {
  return norm(levelDb, params.levelWindowDb);
}

export function drrScore(drrDbValue: number | null, params: SimParams): number {
  if (drrDbValue === null) {
    return 0.5; // neutral when room geometry is unknown
  }
  return norm(drrDbValue, params.drrWindowDb);
}

export function coverageScore(
  offAxisAngleDeg: number,
  inPickup: boolean,
  inExclusion: boolean,
  params: SimParams,
): number {
  if (inExclusion) {
    return 0.0;
  }
  const r = offAxisAngleDeg / params.lobeHalfwidthDeg;
  const lobe = Math.exp(-0.5 * (r * r));
  const zoneFactor = inPickup ? 1.0 : 0.6; // soft penalty when no pickup zone is defined
  return clamp01(lobe * zoneFactor);
}

/**
 * Reward a high *mean* and a high *worst-case*, penalise *spread*.
 *
 * Empty input (no fixed talkers) returns a neutral 1.0 so the term drops out.
 */
export function fairnessAggregate(qualities: number[]): number {
  if (qualities.length === 0) {
    return 1.0;
  }
  const n = qualities.length;
  const mean = qualities.reduce((acc, q) => acc + q, 0) / n;
  const variance = qualities.reduce((acc, q) => acc + (q - mean) ** 2, 0) / n;
  const worst = Math.min(...qualities);
  return clamp01(0.5 * mean + 0.5 * worst - 0.5 * variance);
}

// --------------------------------------------------------------------------- //
// zone membership (mirrors api.talkerCoverage exactly)
// --------------------------------------------------------------------------- //
/** `[inPickup, inExclusion]` for `point` against one array's zones. */
export function zoneMembership(array: MicrophoneArray, point: Point2D): [boolean, boolean] {
  let inPickup = false;
  let inExclusion = false;
  for (const zone of array.zones) {
    if (!pointInShape(point, zone.shape)) {
      continue;
    }
    if (zone.type === 'exclusion') {
      inExclusion = true;
    } else {
      inPickup = true;
    }
  }
  return [inPickup, inExclusion];
}

// --------------------------------------------------------------------------- //
// multi-array helpers: the "table" (pickup zones) and best-covering array
// --------------------------------------------------------------------------- //
export function microphoneArrays(config: SystemConfig): MicrophoneArray[] {
  return config.devices.filter((d): d is MicrophoneArray => d.type === 'microphoneArray');
}

/** True if any array defines a pickup/dedicated zone (i.e. a seating area). */
export function hasAnyPickupZone(config: SystemConfig): boolean {
  return microphoneArrays(config).some((a) => a.zones.some((z) => z.type !== 'exclusion'));
}

export function pointInAnyPickup(config: SystemConfig, p: Point2D): boolean {
  return microphoneArrays(config).some((a) =>
    a.zones.some((z) => z.type !== 'exclusion' && pointInShape(p, z.shape)),
  );
}

export function pointInAnyExclusion(config: SystemConfig, p: Point2D): boolean {
  return microphoneArrays(config).some((a) =>
    a.zones.some((z) => z.type === 'exclusion' && pointInShape(p, z.shape)),
  );
}

function arrayActualElev(config: SystemConfig, array: MicrophoneArray): number {
  if (array.elevation !== undefined) {
    return array.elevation;
  }
  const roomHeight = config.room !== undefined ? config.room.height : 3.0;
  return defaultElevation(array, roomHeight);
}

/** One array's capture quality for a talker, steered straight at the talker. */
export function qualityFromArray(
  array: MicrophoneArray,
  arrayPos: Point2D,
  arrayElev: number,
  talkerPos: Point2D,
  talkerElev: number,
  dc: number | null,
  params: SimParams,
): PlacementScore {
  const ang = steeringAngles(
    { x: arrayPos.x, y: arrayPos.y, z: arrayElev },
    { x: talkerPos.x, y: talkerPos.y, z: talkerElev },
  );
  return talkerQuality(
    arrayPos,
    arrayElev,
    ang.offNadirDeg,
    ang.azimuthDeg,
    talkerPos,
    talkerElev,
    array,
    dc,
    params,
  );
}

/**
 * Best capture across the array under edit (at `targetPos`) and every other
 * *placed* array held at its current pose — a talker is served by whichever
 * array covers them best. With `considerAllArrays=false` only the target array
 * counts.
 */
export function talkerBestQuality(
  config: SystemConfig,
  targetArray: MicrophoneArray,
  targetPos: Point2D,
  targetElev: number,
  talkerPos: Point2D,
  talkerElev: number,
  dc: number | null,
  params: SimParams,
): PlacementScore {
  let best = qualityFromArray(targetArray, targetPos, targetElev, talkerPos, talkerElev, dc, params);
  if (params.considerAllArrays) {
    for (const a of microphoneArrays(config)) {
      if (a.id === targetArray.id || a.position === undefined) {
        continue;
      }
      const q = qualityFromArray(
        a,
        a.position,
        arrayActualElev(config, a),
        talkerPos,
        talkerElev,
        dc,
        params,
      );
      if (q.total > best.total) {
        best = q;
      }
    }
  }
  return best;
}

// --------------------------------------------------------------------------- //
// combiners
// --------------------------------------------------------------------------- //
/** Weighted blend of the three single-talker objectives (no fairness). */
export function geomQuality(
  snr: number,
  drr: number,
  coverage: number,
  params: SimParams,
): number {
  const wsum = params.wSnr + params.wDrr + params.wCoverage || 1.0;
  return (params.wSnr * snr + params.wDrr * drr + params.wCoverage * coverage) / wsum;
}

/** Final score: the three objectives plus the fairness aggregate. */
export function combine(
  snr: number,
  drr: number,
  coverage: number,
  fairness: number,
  params: SimParams,
): number {
  const wsum = params.wSnr + params.wDrr + params.wCoverage + params.wFairness || 1.0;
  return (
    (params.wSnr * snr +
      params.wDrr * drr +
      params.wCoverage * coverage +
      params.wFairness * fairness) /
    wsum
  );
}

// --------------------------------------------------------------------------- //
// the core scoring primitive
// --------------------------------------------------------------------------- //
export function arrayElevation(
  config: SystemConfig,
  array: MicrophoneArray,
  params: SimParams,
): number {
  if (params.arrayHeightM !== null) {
    return params.arrayHeightM;
  }
  if (array.elevation !== undefined) {
    return array.elevation;
  }
  const roomHeight = config.room !== undefined ? config.room.height : 3.0;
  return defaultElevation(array, roomHeight);
}

/**
 * Score how well `array` (at this pose) captures a talker at `talkerPos`.
 *
 * `total` here is the geometry-only quality (snr/drr/coverage); the fairness
 * term is folded in by the search layer, not by this primitive.
 */
export function talkerQuality(
  arrayPos: Point2D,
  arrayElev: number,
  steerOffNadirDeg: number,
  steerAzDeg: number,
  talkerPos: Point2D,
  talkerElev: number,
  array: MicrophoneArray,
  criticalDistanceM: number | null,
  params: SimParams,
): PlacementScore {
  const ang = steeringAngles(
    { x: arrayPos.x, y: arrayPos.y, z: arrayElev },
    { x: talkerPos.x, y: talkerPos.y, z: talkerElev },
  );
  const oa = offAxisDeg(ang, steerOffNadirDeg, steerAzDeg);
  const levelDb = directLevelDb(ang.distance, oa, params);
  const drrValue = drrDb(ang.distance, criticalDistanceM);
  const [inPickup, inExclusion] = zoneMembership(array, talkerPos);

  const snr = snrScore(levelDb, params);
  const drr = drrScore(drrValue, params);
  const cov = coverageScore(oa, inPickup, inExclusion, params);
  return {
    total: geomQuality(snr, drr, cov, params),
    snr,
    drr,
    coverage: cov,
    fairness: NaN, // filled in by the search layer
    distanceM: ang.distance,
    offNadirDeg: ang.offNadirDeg,
    offAxisDeg: oa,
    directLevelDb: levelDb,
    drrDb: drrValue,
    inPickupZone: inPickup,
    inExclusionZone: inExclusion,
  };
}

function findArray(config: SystemConfig, arrayId: string): MicrophoneArray {
  for (const d of config.devices) {
    if (d.id === arrayId && d.type === 'microphoneArray') {
      return d;
    }
  }
  throw new Error(`No microphone array with id '${arrayId}'`);
}

/**
 * Full score (incl. fairness) for one candidate placement.
 *
 * Pass `talkerId` to say which existing talker is being relocated to
 * `candidate.talkerPos` so it is excluded from the fairness aggregate — this
 * makes the result match {@link ./search.js#recommendPlacement} even after the
 * seat has moved away from the talker's stored position. Without it, the seated
 * talker is matched by coordinate (only reliable before moving).
 *
 * `snr/drr/coverage` reflect `candidate.talkerPos` (the seated talker);
 * `fairness` aggregates every *other* existing talker's quality at the candidate
 * array position. In array-only mode (`talkerPos === null`) the score reduces to
 * the fairness aggregate over all talkers.
 */
export function scorePlacement(
  config: SystemConfig,
  arrayId: string,
  candidate: Candidate,
  params: SimParams = defaultSimParams(),
  talkerId: string | null = null,
): PlacementScore {
  const array = findArray(config, arrayId);
  const dc = criticalDistance(config, params);

  const qualityAt = (pos: Point2D, elev: number): PlacementScore =>
    // each talker is captured by whichever array covers them best
    talkerBestQuality(config, array, candidate.arrayPos, candidate.arrayElev, pos, elev, dc, params);

  let seatedId = talkerId;
  if (seatedId === null && candidate.talkerPos !== null) {
    // fall back to matching an existing talker at this position (pre-move only)
    for (const t of config.talkers) {
      if (t.position.x === candidate.talkerPos.x && t.position.y === candidate.talkerPos.y) {
        seatedId = t.id;
        break;
      }
    }
  }

  const others = config.talkers.filter((t) => t.id !== seatedId);
  const fairInputs: number[] = [];
  for (const t of others) {
    const elev = t.elevation !== undefined ? t.elevation : params.talkerHeightM;
    fairInputs.push(qualityAt(t.position, elev).total);
  }
  const fairness = fairnessAggregate(fairInputs);

  if (candidate.talkerPos !== null) {
    const seat = talkerQuality(
      candidate.arrayPos,
      candidate.arrayElev,
      candidate.steerOffNadirDeg,
      candidate.steerAzDeg,
      candidate.talkerPos,
      candidate.talkerElev,
      array,
      dc,
      params,
    );
    const total = combine(seat.snr, seat.drr, seat.coverage, fairness, params);
    return {
      total,
      snr: seat.snr,
      drr: seat.drr,
      coverage: seat.coverage,
      fairness,
      distanceM: seat.distanceM,
      offNadirDeg: seat.offNadirDeg,
      offAxisDeg: seat.offAxisDeg,
      directLevelDb: seat.directLevelDb,
      drrDb: seat.drrDb,
      inPickupZone: seat.inPickupZone,
      inExclusionZone: seat.inExclusionZone,
    };
  }

  // array-only mode: nothing seated -> score is fairness over all talkers
  const total = combine(fairness, fairness, fairness, fairness, params);
  return {
    total,
    snr: fairness,
    drr: fairness,
    coverage: fairness,
    fairness,
    distanceM: NaN,
    offNadirDeg: NaN,
    offAxisDeg: NaN,
    directLevelDb: NaN,
    drrDb: null,
    inPickupZone: false,
    inExclusionZone: false,
  };
}
