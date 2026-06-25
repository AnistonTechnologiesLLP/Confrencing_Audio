# Live audio — Phase A4 (beam-slot tracker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A pure, deterministic `BeamSlotTracker` that assigns DOA talker targets to N persistent beam slots (with per-slot hold + salience ordering + bearing/seat matching) — the multi-talker slot-assignment layer the A5 mixer drives.

**Architecture:** A new `src/live/slot-tracker.ts` (port of Python `multibeam.py:BeamSlotTracker`): `update(targets, t) → BeamSlot[]` in three phases — (A) keep each target on the slot already holding it (seat-id, then nearest bearing within `matchRadiusDeg`); (B) place unmatched targets in an idle slot, else steal the stalest; (C) hold a target-less slot for `holdSeconds`, then release. Pure (caller supplies monotonic `t`).

**Tech Stack:** TypeScript ESM (strict), vitest, zero deps.

## Global Constraints

- Zero deps; `src/live/` browser-safe; `.js` relative imports; `import type` for types; no `as` casts (non-null `!` ok); `exactOptionalPropertyTypes`.
- Faithful to `conf_pipeline_control/multibeam.py:BeamSlotTracker` (+ `BeamTarget`/`BeamSlot`/`snap_targets`). Constants: `DEFAULT_N_BEAMS=3`, `DEFAULT_HOLD_SECONDS=0.6`, `DEFAULT_MATCH_RADIUS_DEG=25.0`.
- Reuses the wrap-aware `azSep` (exported from `mvdr-solver.ts`) for `angular_separation_deg`.
- Hardware-free tests. Gates: `npm run typecheck`, `npm test`, `npm run build`.

---

### Task 1: `BeamSlotTracker` + types + `snapTargets`

**Files:**
- Create: `src/live/slot-tracker.ts`
- Test: `test/live-slot-tracker.test.ts`

**Interfaces produced:**
- `interface BeamTarget { azimuthDeg: number; seatId: string | null; salienceDb: number }`
- `interface BeamSlot { index: number; azimuthDeg: number | null; seatId: string | null; active: boolean; held: boolean }`
- `class BeamSlotTracker { constructor(opts?: SlotTrackerOptions); update(targets, t): BeamSlot[]; reset(): void }`
- `interface SlotTrackerOptions { nSlots?; holdSeconds?; matchRadiusDeg? }`
- `function snapTargets(detections: readonly { azimuthDeg: number; salienceDb: number }[]): BeamTarget[]` (free-DOA; seat-snapping deferred)
- constants `DEFAULT_N_BEAMS`, `DEFAULT_HOLD_SECONDS`, `DEFAULT_MATCH_RADIUS_DEG`

- [ ] **Step 1: Write the failing test** — `test/live-slot-tracker.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { BeamSlotTracker, snapTargets, DEFAULT_N_BEAMS, type BeamTarget } from '../src/live/slot-tracker.js';

const tgt = (az: number, sal: number, seat: string | null = null): BeamTarget => ({ azimuthDeg: az, seatId: seat, salienceDb: sal });

describe('BeamSlotTracker', () => {
  it('assigns two targets to two slots (louder first into the first idle slot)', () => {
    const tr = new BeamSlotTracker({ nSlots: 3 });
    const slots = tr.update([tgt(10, 3), tgt(120, 9)], 0);
    const active = slots.filter((s) => s.active);
    expect(active.length).toBe(2);
    // the louder (120°, 9 dB) takes the first idle slot
    expect(slots[0]!.azimuthDeg).toBe(120);
    expect(slots[1]!.azimuthDeg).toBe(10);
  });

  it('keeps a talker on the same slot across ticks (bearing match within radius)', () => {
    const tr = new BeamSlotTracker({ nSlots: 2, matchRadiusDeg: 25 });
    tr.update([tgt(40, 5)], 0);
    const s = tr.update([tgt(50, 5)], 0.1); // 10° move ≤ 25° radius → same slot
    expect(s[0]!.azimuthDeg).toBe(50);
    expect(s.filter((x) => x.active).length).toBe(1);
  });

  it('holds a slot through a brief pause then releases after holdSeconds', () => {
    const tr = new BeamSlotTracker({ nSlots: 1, holdSeconds: 0.6 });
    tr.update([tgt(30, 5)], 0);
    const held = tr.update([], 0.3); // no target, within hold
    expect(held[0]!.active).toBe(false);
    expect(held[0]!.held).toBe(true);
    expect(held[0]!.azimuthDeg).toBe(30); // coasts on its bearing
    const released = tr.update([], 1.0); // past hold (since last_seen 0)
    expect(released[0]!.held).toBe(false);
    expect(released[0]!.azimuthDeg).toBe(null);
  });

  it('matches by seat identity even outside the bearing radius', () => {
    const tr = new BeamSlotTracker({ nSlots: 2, matchRadiusDeg: 10 });
    tr.update([tgt(40, 5, 'seatA')], 0);
    const s = tr.update([tgt(120, 5, 'seatA')], 0.1); // 80° move but same seat → same slot
    const slot = s.find((x) => x.seatId === 'seatA')!;
    expect(slot.azimuthDeg).toBe(120);
    expect(s.filter((x) => x.active).length).toBe(1);
  });

  it('when full, louder talkers win and the quietest unmatched is dropped', () => {
    const tr = new BeamSlotTracker({ nSlots: 2 });
    const s = tr.update([tgt(0, 1), tgt(90, 5), tgt(180, 9)], 0);
    const aims = s.filter((x) => x.active).map((x) => x.azimuthDeg).sort((a, b) => a! - b!);
    expect(s.filter((x) => x.active).length).toBe(2);
    expect(aims).toEqual([90, 180]); // the two loudest; 0°/1dB dropped
  });

  it('reset() clears all slots', () => {
    const tr = new BeamSlotTracker({ nSlots: 2 });
    tr.update([tgt(40, 5)], 0);
    tr.reset();
    const s = tr.update([], 0);
    expect(s.every((x) => x.azimuthDeg === null && !x.active && !x.held)).toBe(true);
  });

  it('snapTargets maps detections to free-DOA targets; DEFAULT_N_BEAMS=3', () => {
    expect(snapTargets([{ azimuthDeg: 45, salienceDb: 6 }])).toEqual([{ azimuthDeg: 45, seatId: null, salienceDb: 6 }]);
    expect(DEFAULT_N_BEAMS).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — `src/live/slot-tracker.ts`:
```ts
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
```

- [ ] **Step 4: Run + typecheck + full suite + build**

Run: `npx vitest run test/live-slot-tracker.test.ts && npm run typecheck && npm test && npm run build`
Expected: all green. The slot-assignment tests encode the exact Python semantics — if one fails, the port is wrong; fix the code.

- [ ] **Step 5: Commit**
```bash
git add src/live/slot-tracker.ts test/live-slot-tracker.test.ts
git commit -m "feat(live): beam-slot tracker (persistent multi-talker slot assignment)"
```

---

## Notes for the controller

- A4 is a pure state machine — no engine wiring (A5's mixer consumes `BeamSlot[]`). Seat-snapping (`snap_targets` with room/seat config) is deferred; `snapTargets` here is free-DOA.
- A5 (multi-beam mixer) owns N `FreqDomainBeam`s steered to the slots (each nulling the others) + `nom_automix` + engine wiring.

## Self-review (done)

- **Spec coverage:** the single task covers `BeamSlotTracker` + types + `snapTargets` (the whole A4 unit).
- **Type consistency:** `BeamTarget`/`BeamSlot`/`SlotTrackerOptions`/`BeamSlotTracker`/`snapTargets` + constants. Reuses `azSep`.
- **Faithfulness:** 3-phase algorithm, salience order, seat-then-bearing match, idle-then-steal-stalest, hold/release — line-for-line from `BeamSlotTracker`. `staleness` = lastSeenT (−∞ if never), min picked on steal.
- **Constraints:** zero-dep, browser-safe, `.js`, no `as`.
