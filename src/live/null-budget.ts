import { azSep } from './mvdr-solver.js';

/** Drop a null within this angular distance of the look (singular LCMV / would null the target). */
export const NULL_MIN_SEP_DEG = 8.0;
/** Cross-source dedupe distance — one null per constraint (≥ the beam's 5° look-guard). */
export const NULL_MERGE_SEP_DEG = 6.0;

export interface ComposeNullsOptions {
  /** User-drawn no-pickup azimuths (deg) — ranked above seats, below detected. */
  exclusion?: readonly number[];
  /** Empty-seat azimuths (deg) — speculative, lowest priority, nearest-to-look first. */
  seats?: readonly number[];
  /** Drop a null within this of the look (default {@link NULL_MIN_SEP_DEG}). */
  minSepDeg?: number;
  /** Cross-source dedupe distance (default {@link NULL_MERGE_SEP_DEG}). */
  mergeSepDeg?: number;
  /** Optionally cap the seat nulls to reserve budget headroom. */
  seatNullMaxCount?: number | null;
}

function dedupeAz(arr: readonly number[], sep: number): number[] {
  const out: number[] = [];
  for (const x of arr) if (!out.some((q) => azSep(x, q) < sep)) out.push(x);
  return out;
}
function nearAny(x: number, arr: readonly number[], sep: number): boolean {
  return arr.some((q) => azSep(x, q) < sep);
}

/**
 * Merge competing null **azimuths** (deg, array-relative) into one budgeted, deterministic list:
 * **detected interferers** (measured, win the budget) → **exclusions** (user-drawn, high intent) →
 * **seats** (speculative, nearest-to-look first). Drops near-look nulls (`minSepDeg`), dedupes across
 * sources (`mergeSepDeg`), caps at `budget` (= M−1). Port of Python `compose_nulls`.
 */
export function composeNulls(
  targetAzDeg: number,
  detected: readonly number[],
  budget: number,
  opts: ComposeNullsOptions = {},
): number[] {
  if (budget <= 0) return [];
  const minSep = opts.minSepDeg ?? NULL_MIN_SEP_DEG;
  const mergeSep = opts.mergeSepDeg ?? NULL_MERGE_SEP_DEG;

  const det = dedupeAz(detected.filter((d) => azSep(d, targetAzDeg) >= minSep), mergeSep);

  let excl = (opts.exclusion ?? []).filter((e) => azSep(e, targetAzDeg) >= minSep);
  excl = dedupeAz(excl.filter((e) => !nearAny(e, det, mergeSep)), mergeSep);

  let seat = (opts.seats ?? []).filter((s) => azSep(s, targetAzDeg) >= minSep);
  seat = seat.filter((s) => !nearAny(s, det, mergeSep) && !nearAny(s, excl, mergeSep));
  seat = dedupeAz(seat, mergeSep);
  // When seatNullMaxCount is explicitly set: sort nearest-first (prioritize closer seats).
  // When not set: sort farthest-first (be conservative, avoid nulling nearer occupied seats).
  if (opts.seatNullMaxCount !== undefined && opts.seatNullMaxCount !== null) {
    seat = seat.slice().sort((a, b) => azSep(a, targetAzDeg) - azSep(b, targetAzDeg)); // nearest-to-look first
    seat = seat.slice(0, Math.max(0, opts.seatNullMaxCount));
  } else {
    seat = seat.slice().sort((a, b) => azSep(b, targetAzDeg) - azSep(a, targetAzDeg)); // farthest-to-look first
  }

  const final = det.slice(0, budget);
  for (const tier of [excl, seat]) {
    for (const s of tier) {
      if (final.length >= budget) break;
      final.push(s);
    }
  }
  return final;
}
