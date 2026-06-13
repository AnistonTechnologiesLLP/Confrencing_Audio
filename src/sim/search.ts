/**
 * Joint array-placement + seat search (pure arithmetic — no external deps).
 *
 * The search space is array `(x, y)` × array steer × seat `(x, y)`. Two facts
 * collapse it from a 6-D grid to two cheap 2-D sweeps:
 *
 *  - **Steer is derived, not searched** — the optimal steer always points
 *    straight at the talker (off-axis is minimised at 0), so we compute it from
 *    {@link ../geometry/angles.js#steeringAngles} instead of gridding over it.
 *  - **Coarse-to-fine** — a coarse sweep over the room footprint finds the
 *    basin, then a small local grid refines array and seat independently.
 */
import { steeringAngles } from '../geometry/angles.js';
import {
  type MicrophoneArray,
  type Point2D,
  type SystemConfig,
  type Talker,
  pointInPolygon,
} from '../model/index.js';
import * as scoring from './scoring.js';
import {
  type Heatmap,
  type PlacementScore,
  type Recommendation,
  type SimParams,
  defaultSimParams,
} from './types.js';

type BBox = [number, number, number, number];

/** Match Python `round(value, 4)` for the float values this module produces. */
function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

// --------------------------------------------------------------------------- //
// geometry / candidate generation
// --------------------------------------------------------------------------- //
function bbox(config: SystemConfig): BBox {
  const pts: Point2D[] = [];
  if (config.room !== undefined && config.room.vertices.length >= 2) {
    pts.push(...config.room.vertices);
  } else {
    for (const d of config.devices) {
      if (d.position !== undefined) {
        pts.push(d.position);
      }
    }
    for (const t of config.talkers) {
      pts.push(t.position);
    }
  }
  if (pts.length === 0) {
    return [0.0, 0.0, 10.0, 8.0];
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function insideRoom(config: SystemConfig, p: Point2D): boolean {
  const room = config.room;
  if (room === undefined || room.vertices.length < 3) {
    return true;
  }
  return pointInPolygon(p, room.vertices);
}

/** Grow the step so the bounding grid never exceeds `maxCells` cells. */
function effectiveStep(box: BBox, step: number, maxCells: number): number {
  const [minx, miny, maxx, maxy] = box;
  step = Math.max(step, 1e-3);
  for (;;) {
    const nx = Math.trunc((maxx - minx) / step) + 1;
    const ny = Math.trunc((maxy - miny) / step) + 1;
    if (nx * ny <= maxCells || step > 1e6) {
      return step;
    }
    step *= 1.5;
  }
}

/**
 * Grid over the room footprint (points inside the room polygon). Returns
 * `[points, effectiveStep]` — the step may be coarsened to honour `maxCells`.
 */
export function gridPoints(
  config: SystemConfig,
  step: number,
  maxCells: number,
): [Point2D[], number] {
  const box = bbox(config);
  step = effectiveStep(box, step, maxCells);
  const [minx, miny, maxx, maxy] = box;
  const pts: Point2D[] = [];
  let y = miny;
  while (y <= maxy + 1e-9) {
    let x = minx;
    while (x <= maxx + 1e-9) {
      const p: Point2D = { x: round4(x), y: round4(y) };
      if (insideRoom(config, p)) {
        pts.push(p);
      }
      x += step;
    }
    y += step;
  }
  if (pts.length === 0) {
    // degenerate polygon — fall back to the bbox centre
    return [[{ x: round4((minx + maxx) / 2), y: round4((miny + maxy) / 2) }], step];
  }
  return [pts, step];
}

function localGrid(
  center: Point2D,
  config: SystemConfig,
  step: number,
  radius: number,
): Point2D[] {
  const pts: Point2D[] = [];
  step = Math.max(step, 1e-6); // guard against a zero refine step (division by zero)
  // cap the per-axis count so a tiny step can't explode the grid (keep full radius)
  const maxN = 48;
  if (radius / step > maxN) {
    step = radius / maxN;
  }
  const n = Math.max(1, Math.round(radius / step));
  for (let iy = -n; iy <= n; iy++) {
    for (let ix = -n; ix <= n; ix++) {
      const p: Point2D = { x: round4(center.x + ix * step), y: round4(center.y + iy * step) };
      if (insideRoom(config, p)) {
        pts.push(p);
      }
    }
  }
  return pts.length > 0 ? pts : [center];
}

// --------------------------------------------------------------------------- //
// resolution helpers
// --------------------------------------------------------------------------- //
function resolveArray(config: SystemConfig, arrayId: string | null): MicrophoneArray {
  const arrays = config.devices.filter(
    (d): d is MicrophoneArray => d.type === 'microphoneArray',
  );
  if (arrays.length === 0) {
    throw new Error('Configuration has no microphone array to place.');
  }
  if (arrayId === null) {
    return arrays[0]!;
  }
  for (const a of arrays) {
    if (a.id === arrayId) {
      return a;
    }
  }
  throw new Error(`No microphone array with id '${arrayId}'`);
}

function talkerElev(talker: Talker, params: SimParams): number {
  return talker.elevation !== undefined ? talker.elevation : params.talkerHeightM;
}

function deriveSteer(
  arrayPos: Point2D,
  arrayElev: number,
  pos: Point2D,
  elev: number,
): [number, number] {
  const ang = steeringAngles(
    { x: arrayPos.x, y: arrayPos.y, z: arrayElev },
    { x: pos.x, y: pos.y, z: elev },
  );
  return [ang.offNadirDeg, ang.azimuthDeg];
}

// --------------------------------------------------------------------------- //
// evaluation at a fixed (array, seat)
// --------------------------------------------------------------------------- //
interface EvalResult {
  total: number;
  fairness: number;
  perTalker: Record<string, PlacementScore>;
  seatScore: PlacementScore | null;
  steerOffNadir: number;
  steerAz: number;
}

function evalPlacement(
  config: SystemConfig,
  array: MicrophoneArray,
  arrayPos: Point2D,
  arrayElev: number,
  seatPos: Point2D | null,
  seatElev: number,
  fixedTalkers: Talker[],
  dc: number | null,
  params: SimParams,
): EvalResult {
  const perTalker: Record<string, PlacementScore> = {};
  const fairInputs: number[] = [];
  for (const t of fixedTalkers) {
    const elev = talkerElev(t, params);
    // each talker is served by whichever array (this one or the others) covers best
    const ps = scoring.talkerBestQuality(
      config,
      array,
      arrayPos,
      arrayElev,
      t.position,
      elev,
      dc,
      params,
    );
    perTalker[t.id] = ps;
    fairInputs.push(ps.total);
  }
  const fairness = scoring.fairnessAggregate(fairInputs);
  // surface the aggregate on each per-talker entry for display
  for (const k of Object.keys(perTalker)) {
    perTalker[k] = { ...perTalker[k]!, fairness };
  }

  if (seatPos !== null) {
    const [on, az] = deriveSteer(arrayPos, arrayElev, seatPos, seatElev);
    const seatBase = scoring.talkerQuality(
      arrayPos,
      arrayElev,
      on,
      az,
      seatPos,
      seatElev,
      array,
      dc,
      params,
    );
    const total = scoring.combine(seatBase.snr, seatBase.drr, seatBase.coverage, fairness, params);
    const seat: PlacementScore = { ...seatBase, total, fairness };
    return { total, fairness, perTalker, seatScore: seat, steerOffNadir: on, steerAz: az };
  }

  // array-only: aim the displayed steer at the centroid of the fixed talkers
  const total = scoring.combine(fairness, fairness, fairness, fairness, params);
  let on = 0.0;
  let az = 0.0;
  if (fixedTalkers.length > 0) {
    const cx = fixedTalkers.reduce((acc, t) => acc + t.position.x, 0) / fixedTalkers.length;
    const cy = fixedTalkers.reduce((acc, t) => acc + t.position.y, 0) / fixedTalkers.length;
    [on, az] = deriveSteer(arrayPos, arrayElev, { x: cx, y: cy }, params.talkerHeightM);
  }
  return { total, fairness, perTalker, seatScore: null, steerOffNadir: on, steerAz: az };
}

interface BestSeat {
  pos: Point2D;
  elev: number;
  score: PlacementScore;
}

/**
 * Best seat for `talker` given a fixed array pose.
 *
 * Never returns a seat inside an exclusion zone *if any non-excluded candidate
 * exists* (crowding separation is relaxed before exclusion is). Only when every
 * candidate is in a no-pickup zone does it fall back to the talker's current
 * position — a degenerate, fully-excluded layout.
 */
function bestSeat(
  config: SystemConfig,
  array: MicrophoneArray,
  arrayPos: Point2D,
  arrayElev: number,
  candidates: Point2D[],
  talker: Talker,
  dc: number | null,
  params: SimParams,
): BestSeat {
  const elev = talkerElev(talker, params);
  const others = config.talkers.filter((t) => t.id !== talker.id);
  const sep = params.minTalkerSeparationM;

  const scan = (requireSeparation: boolean): BestSeat | null => {
    let best: BestSeat | null = null;
    for (const sp of candidates) {
      if (scoring.pointInAnyExclusion(config, sp)) {
        continue; // never seat inside any array's no-pickup zone
      }
      if (
        requireSeparation &&
        sep > 0 &&
        others.some((o) => Math.hypot(sp.x - o.position.x, sp.y - o.position.y) < sep)
      ) {
        continue; // don't seat someone on top of another talker
      }
      const [on, az] = deriveSteer(arrayPos, arrayElev, sp, elev);
      const ps = scoring.talkerQuality(arrayPos, arrayElev, on, az, sp, elev, array, dc, params);
      if (best === null || ps.total > best.score.total) {
        best = { pos: sp, elev, score: ps };
      }
    }
    return best;
  };

  // prefer a non-excluded, uncrowded seat; relax crowding before exclusion
  let best = scan(true) ?? scan(false);
  if (best === null) {
    // every candidate is in an exclusion zone — degenerate layout
    const [on, az] = deriveSteer(arrayPos, arrayElev, talker.position, elev);
    const ps = scoring.talkerQuality(
      arrayPos,
      arrayElev,
      on,
      az,
      talker.position,
      elev,
      array,
      dc,
      params,
    );
    best = { pos: talker.position, elev, score: ps };
  }
  return best;
}

/**
 * Where a person may be seated: drop exclusion zones, and — when any pickup zone
 * (a "table"/seating area) is defined — keep only seats inside one, so the
 * recommendation sits people at the table rather than on open floor. Relaxes to
 * the whole (non-excluded) floor if no candidate lands in a pickup zone.
 */
function seatCandidates(
  config: SystemConfig,
  candidates: Point2D[],
  params: SimParams,
): Point2D[] {
  const nonExcluded = candidates.filter((p) => !scoring.pointInAnyExclusion(config, p));
  if (params.seatInPickupZones && scoring.hasAnyPickupZone(config)) {
    const atTable = nonExcluded.filter((p) => scoring.pointInAnyPickup(config, p));
    if (atTable.length > 0) {
      return atTable;
    }
  }
  return nonExcluded;
}

// --------------------------------------------------------------------------- //
// public: recommendPlacement
// --------------------------------------------------------------------------- //
interface BestState {
  total: number;
  arrayPos: Point2D;
  seatPos: Point2D | null;
  seatElev: number;
  perTalker: Record<string, PlacementScore>;
  seatScore: PlacementScore | null;
  steerOn: number;
  steerAz: number;
}

/**
 * Recommend the best array pose (and, when `talkerId` is given, the best seat
 * for that talker), optimising direct level, DRR, coverage and fairness.
 */
export function recommendPlacement(
  config: SystemConfig,
  arrayId: string | null = null,
  talkerId: string | null = null,
  params: SimParams = defaultSimParams(),
): Recommendation {
  const array = resolveArray(config, arrayId);
  const arrayElev = scoring.arrayElevation(config, array, params);
  const dc = scoring.criticalDistance(config, params);

  const selected =
    talkerId !== null ? config.talkers.find((t) => t.id === talkerId) ?? null : null;
  const fixed = config.talkers.filter((t) => t.id !== talkerId);

  const [grid] = gridPoints(config, params.gridStepM, params.maxCells);
  const seatGrid = seatCandidates(config, grid, params); // seats at the table / off exclusion zones

  let note = '';
  if (config.talkers.length === 0) {
    note = 'No talkers placed — add a talker to optimise placement.';
  } else if (selected === null && talkerId !== null) {
    note = `Talker '${talkerId}' not found; optimised for all talkers.`;
  }

  // ---- Stage A: coarse array sweep --------------------------------------
  let best: BestState | null = null;
  for (const ap of grid) {
    let seatPos: Point2D | null;
    let seatElev: number;
    if (selected !== null) {
      const bs = bestSeat(config, array, ap, arrayElev, seatGrid, selected, dc, params);
      seatPos = bs.pos;
      seatElev = bs.elev;
    } else {
      seatPos = null;
      seatElev = params.talkerHeightM;
    }
    const ev = evalPlacement(config, array, ap, arrayElev, seatPos, seatElev, fixed, dc, params);
    if (best === null || ev.total > best.total) {
      best = {
        total: ev.total,
        arrayPos: ap,
        seatPos,
        seatElev,
        perTalker: ev.perTalker,
        seatScore: ev.seatScore,
        steerOn: ev.steerOffNadir,
        steerAz: ev.steerAz,
      };
    }
  }

  if (best === null) {
    throw new Error('search produced no candidate');
  }

  // ---- Stage C: coarse-to-fine refinement -------------------------------
  // refine array position with the seat held at the coarse optimum
  for (const ap of localGrid(best.arrayPos, config, params.refineStepM, params.refineRadiusM)) {
    const ev = evalPlacement(
      config,
      array,
      ap,
      arrayElev,
      best.seatPos,
      best.seatElev,
      fixed,
      dc,
      params,
    );
    if (ev.total > best.total) {
      best = {
        total: ev.total,
        arrayPos: ap,
        seatPos: best.seatPos,
        seatElev: best.seatElev,
        perTalker: ev.perTalker,
        seatScore: ev.seatScore,
        steerOn: ev.steerOffNadir,
        steerAz: ev.steerAz,
      };
    }
  }

  // refine the seat with the refined array held fixed — keep it only if it does
  // not regress the coarse/array-refined optimum (e.g. a fallback seat)
  if (selected !== null && best.seatPos !== null) {
    const local = seatCandidates(
      config,
      localGrid(best.seatPos, config, params.refineStepM, params.refineRadiusM),
      params,
    );
    const candSeat = bestSeat(config, array, best.arrayPos, arrayElev, local, selected, dc, params);
    const ev = evalPlacement(
      config,
      array,
      best.arrayPos,
      arrayElev,
      candSeat.pos,
      candSeat.elev,
      fixed,
      dc,
      params,
    );
    if (ev.total > best.total) {
      best = {
        total: ev.total,
        arrayPos: best.arrayPos,
        seatPos: candSeat.pos,
        seatElev: candSeat.elev,
        perTalker: ev.perTalker,
        seatScore: ev.seatScore,
        steerOn: ev.steerOffNadir,
        steerAz: ev.steerAz,
      };
    }
  }

  const score = best.seatScore !== null ? best.seatScore : arrayOnlyScore(best.total);
  return {
    arrayId: array.id,
    arrayPos: best.arrayPos,
    arrayElev,
    steerAzDeg: best.steerAz,
    steerOffNadirDeg: best.steerOn,
    talkerId: selected !== null ? selected.id : null,
    talkerPos: best.seatPos,
    score,
    perTalker: best.perTalker,
    validated: null,
    note,
  };
}

function arrayOnlyScore(total: number): PlacementScore {
  const fairness = total; // in array-only mode total == fairness aggregate
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

// --------------------------------------------------------------------------- //
// public: scoreHeatmap (array-position sweep, talkers fixed)
// --------------------------------------------------------------------------- //
/**
 * A grid of *where to mount the array* scores (talkers held fixed).
 *
 * `talkerId` is accepted for API symmetry but does not change the heatmap — the
 * heatmap always sweeps array position with every talker fixed (no nested seat
 * sweep), which is what makes it cheap enough to recompute interactively.
 */
export function scoreHeatmap(
  config: SystemConfig,
  arrayId: string | null = null,
  params: SimParams = defaultSimParams(),
  _talkerId: string | null = null,
): Heatmap {
  const array = resolveArray(config, arrayId);
  const arrayElev = scoring.arrayElevation(config, array, params);
  const dc = scoring.criticalDistance(config, params);
  const fixed = [...config.talkers];

  const box = bbox(config);
  const step = effectiveStep(box, params.gridStepM, params.maxCells);
  const [minx, miny, maxx, maxy] = box;
  const nx = Math.trunc((maxx - minx) / step) + 1;
  const ny = Math.trunc((maxy - miny) / step) + 1;

  const values: Array<number | null> = [];
  const finite: number[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const p: Point2D = { x: round4(minx + ix * step), y: round4(miny + iy * step) };
      if (!insideRoom(config, p)) {
        values.push(null);
        continue;
      }
      const ev = evalPlacement(config, array, p, arrayElev, null, params.talkerHeightM, fixed, dc, params);
      values.push(ev.total);
      finite.push(ev.total);
    }
  }

  const vmin = finite.length > 0 ? Math.min(...finite) : 0.0;
  const vmax = finite.length > 0 ? Math.max(...finite) : 1.0;
  return { origin: { x: minx, y: miny }, stepM: step, nx, ny, values, vmin, vmax };
}
