import { azSep } from './mvdr-solver.js';

/** Practical ceiling for the small array (2-3 separable talkers). */
export const DEFAULT_N_BEAMS = 3;
/** Keep a beam through a brief pause before releasing the slot (seconds). */
export const DEFAULT_HOLD_SECONDS = 0.6;
/** A target within this of a slot's bearing is "the same talker" (deg). */
export const DEFAULT_MATCH_RADIUS_DEG = 25.0;

/** A direction to capture this tick: an array-relative bearing + the room seat it snapped to (or null). */
export interface BeamTarget {
  azimuthDeg: number;
  seatId: string | null;
  salienceDb: number;
}

/** One persistent beam slot's published state. `azimuthDeg === null` ⇒ idle (no beam). */
export interface BeamSlot {
  index: number;
  azimuthDeg: number | null;
  seatId: string | null;
  active: boolean; // a live detection this tick
  held: boolean;   // coasting through a brief pause (keeps its bearing)
}

export interface SlotTrackerOptions {
  nSlots?: number;
  holdSeconds?: number;
  matchRadiusDeg?: number;
}

interface SlotState {
  azimuthDeg: number | null;
  seatId: string | null;
  lastSeenT: number | null;
}

/** Map raw `(azimuthDeg, salienceDb)` detections to free-DOA `BeamTarget`s (seat-snapping deferred). */
export function snapTargets(
  detections: readonly { azimuthDeg: number; salienceDb: number }[],
): BeamTarget[] {
  return detections.map((d) => ({ azimuthDeg: d.azimuthDeg, seatId: null, salienceDb: d.salienceDb }));
}

/**
 * Assign `BeamTarget`s to `nSlots` **persistent** beam slots with per-slot hold. A slot keeps the same
 * talker/seat across ticks: matched first by seat identity, then nearest bearing within `matchRadiusDeg`.
 * Unmatched targets fill idle slots (else steal the stalest). A target-less slot holds for `holdSeconds`,
 * then releases. Pure + deterministic (caller supplies monotonic `t`). Port of Python `BeamSlotTracker`.
 */
export class BeamSlotTracker {
  private readonly n: number;
  private readonly hold: number;
  private readonly radius: number;
  private slots: SlotState[];

  constructor(opts: SlotTrackerOptions = {}) {
    this.n = opts.nSlots ?? DEFAULT_N_BEAMS;
    if (this.n < 1) throw new Error('nSlots must be >= 1');
    this.hold = opts.holdSeconds ?? DEFAULT_HOLD_SECONDS;
    this.radius = opts.matchRadiusDeg ?? DEFAULT_MATCH_RADIUS_DEG;
    this.slots = this.freshSlots();
  }

  private freshSlots(): SlotState[] {
    return Array.from({ length: this.n }, () => ({ azimuthDeg: null, seatId: null, lastSeenT: null }));
  }

  update(targets: readonly BeamTarget[], t: number): BeamSlot[] {
    const claimed = new Array<boolean>(this.n).fill(false);
    const used = new Array<boolean>(targets.length).fill(false);
    // louder talkers first (stable for equal salience via index tiebreak)
    const order = targets.map((_, j) => j).sort((a, b) => targets[b]!.salienceDb - targets[a]!.salienceDb);

    // Phase A — keep each target on the slot already holding it (seat identity, then nearest bearing).
    for (const j of order) {
      const tg = targets[j]!;
      let bestI = -1;
      let bestGap: number | null = null;
      for (let i = 0; i < this.n; i++) {
        if (claimed[i]) continue;
        const s = this.slots[i]!;
        if (s.azimuthDeg === null) continue;
        if (tg.seatId !== null && s.seatId === tg.seatId) {
          bestI = i;
          break; // exact seat match wins outright
        }
        const gap = azSep(tg.azimuthDeg, s.azimuthDeg);
        if (gap <= this.radius && (bestGap === null || gap < bestGap)) {
          bestI = i;
          bestGap = gap;
        }
      }
      if (bestI >= 0) {
        this.assign(bestI, tg, t);
        claimed[bestI] = true;
        used[j] = true;
      }
    }

    // Phase B — place unmatched: an idle slot first, else steal the stalest unclaimed slot.
    for (const j of order) {
      if (used[j]) continue;
      const tg = targets[j]!;
      let i = -1;
      for (let k = 0; k < this.n; k++) {
        if (!claimed[k] && this.slots[k]!.azimuthDeg === null) { i = k; break; }
      }
      if (i < 0) {
        let stalest = -1;
        for (let k = 0; k < this.n; k++) {
          if (claimed[k]) continue;
          if (stalest < 0 || this.staleness(k) < this.staleness(stalest)) stalest = k;
        }
        if (stalest < 0) continue; // all slots busy with louder talkers
        i = stalest;
      }
      this.assign(i, tg, t);
      claimed[i] = true;
      used[j] = true;
    }

    // Phase C — hold or release slots that got no target this tick.
    const out: BeamSlot[] = [];
    for (let i = 0; i < this.n; i++) {
      const s = this.slots[i]!;
      if (claimed[i]) {
        out.push({ index: i, azimuthDeg: s.azimuthDeg, seatId: s.seatId, active: true, held: false });
      } else if (s.azimuthDeg !== null && s.lastSeenT !== null && t - s.lastSeenT <= this.hold) {
        out.push({ index: i, azimuthDeg: s.azimuthDeg, seatId: s.seatId, active: false, held: true });
      } else {
        s.azimuthDeg = null;
        s.seatId = null;
        out.push({ index: i, azimuthDeg: null, seatId: null, active: false, held: false });
      }
    }
    return out;
  }

  private assign(i: number, tg: BeamTarget, t: number): void {
    const s = this.slots[i]!;
    s.azimuthDeg = tg.azimuthDeg;
    s.seatId = tg.seatId;
    s.lastSeenT = t;
  }

  private staleness(k: number): number {
    const ls = this.slots[k]!.lastSeenT;
    return ls !== null ? ls : -Infinity;
  }

  reset(): void {
    this.slots = this.freshSlots();
  }
}
