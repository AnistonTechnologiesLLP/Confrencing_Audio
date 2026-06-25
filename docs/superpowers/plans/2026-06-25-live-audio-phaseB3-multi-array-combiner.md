# Live audio — Phase B3 (multi-array combiner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The testable dual-array combiner — select the active kit (B2), equal-power cross-fade on a switch, apply **one** combined AGC, with an optional triangulation **fence veto** (B1). Two kits → one glitch-free output.

**Architecture:** A new `src/live/multi-array-combiner.ts` (port of `multikit.py:MultiKitController._produce` — the stream-free testable core): owns a `KitSelector` (B2), N per-kit `SpeechPresenceScorer`s, an optional `FenceDecider` (B1), an optional `TargetLoudnessAgc` (Phase 3d, on master), and the cross-fade state. `process(kits, t, fenceCtx?)` returns the combined mono + decision telemetry. The actual two-`LiveEngine` host wiring (two adapters, clock sync) is a thin node-host concern, deferred.

**Tech Stack:** TypeScript ESM (strict), vitest, zero deps.

## Global Constraints

- Zero deps; `src/live/` browser-safe; `.js` relative imports; `import type` for types; no `as` casts (non-null `!` ok); `exactOptionalPropertyTypes` (omit-when-absent spreads).
- Float64 mix math; `Float32Array` output.
- Faithful to `multikit.py` (`crossfade_gains`, `_produce` select→fade→AGC, fence veto). Constant `DEFAULT_CROSSFADE_BLOCKS=6`.
- Reuses `KitSelector` (`./kit-selector.js`), `SpeechPresenceScorer` (`./speech-presence.js`), `FenceDecider`/`fusePosition` types (`./triangulation.js`), `TargetLoudnessAgc` (`./agc.js`).
- Hardware-free tests. Gates: `npm run typecheck`, `npm test`, `npm run build`.

---

### Task 1: `crossfadeGains` + `MultiArrayCombiner`

**Files:**
- Create: `src/live/multi-array-combiner.ts`
- Test: `test/live-multi-array-combiner.test.ts`

**Interfaces produced:**
- `function crossfadeGains(step: number, total: number): [number, number]`
- `class MultiArrayCombiner { constructor(sampleRate, opts?); process(kits, t, fenceCtx?): CombinedOutput; reset(): void; get active(): number }`
- `interface KitBlock { mono: Float32Array; azimuthDeg: number | null; salienceDb: number }`
- `interface CombinedOutput { mono: Float32Array; active: number; switching: boolean; speechPresent: boolean; scores: number[]; fenceKeep: boolean | null }`
- `interface MultiArrayCombinerOptions { nKits?; crossfadeBlocks?; agc?; fence?; selector?; scorerHopSeconds? }`
- const `DEFAULT_CROSSFADE_BLOCKS = 6`

- [ ] **Step 1: Write the failing test** — `test/live-multi-array-combiner.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { MultiArrayCombiner, crossfadeGains, DEFAULT_CROSSFADE_BLOCKS } from '../src/live/multi-array-combiner.js';
import type { KitPose } from '../src/live/triangulation.js';

const N = 512;
const FS = 44100;
/** A steady tone block (constant amplitude → low speech-presence score). */
function tone(amp: number): Float32Array {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / FS);
  return out;
}
/** A syllabically-modulated block whose amplitude is `amp` this tick (the caller alternates amp to fake modulation). */
function rms(x: Float32Array): number { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!; return Math.sqrt(s / x.length); }

describe('crossfadeGains (equal-power)', () => {
  it('cos²+sin²=1 across the ramp; clamps; total<=0 → (0,1)', () => {
    expect(crossfadeGains(0, 6)).toEqual([1, 0]);                       // start: all old
    const [go, gi] = crossfadeGains(3, 6);                              // midpoint
    expect(go * go + gi * gi).toBeCloseTo(1, 10);
    expect(crossfadeGains(6, 6)[0]).toBeCloseTo(0);                     // end: all new
    expect(crossfadeGains(99, 6)[0]).toBeCloseTo(0);                    // clamped
    expect(crossfadeGains(2, 0)).toEqual([0, 1]);                       // degenerate
  });
});

describe('MultiArrayCombiner', () => {
  it('outputs the active kit; switches to a clearly-louder talker and cross-fades', () => {
    const c = new MultiArrayCombiner(FS, { nKits: 2, crossfadeBlocks: DEFAULT_CROSSFADE_BLOCKS });
    // drive kit 1 with strong modulation (alternating loud/quiet) so its speech score climbs;
    // kit 0 steady (low score). After enough ticks the active should be kit 1.
    let out = c.process([{ mono: tone(0.001), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.3), azimuthDeg: 0, salienceDb: 0 }], 0);
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += N / FS;
      const k0 = tone(0.001);                                          // steady-quiet
      const k1 = tone(i % 2 === 0 ? 0.3 : 0.02);                       // modulated → speech-like
      out = c.process([{ mono: k0, azimuthDeg: 0, salienceDb: 0 }, { mono: k1, azimuthDeg: 0, salienceDb: 0 }], t);
    }
    expect(c.active).toBe(1);                                          // selected the modulated talker
    expect(out.mono.length).toBe(N);
    for (const v of out.mono) expect(Number.isFinite(v)).toBe(true);
    expect(out.scores.length).toBe(2);
  });

  it('with no modulation on either kit, stays on kit 0 and reports no speech', () => {
    const c = new MultiArrayCombiner(FS, { nKits: 2 });
    let out = c.process([{ mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }, { mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }], 0);
    for (let i = 1; i < 20; i++) out = c.process([{ mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }, { mono: tone(0.2), azimuthDeg: 0, salienceDb: -30 }], (i * N) / FS);
    expect(c.active).toBe(0);
    expect(out.speechPresent).toBe(false);
  });

  it('a combined AGC normalizes the output level (one AGC on the result)', () => {
    const c = new MultiArrayCombiner(FS, { nKits: 2, agc: { targetDb: -20 } });
    let out = c.process([{ mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }], 0);
    for (let i = 1; i < 60; i++) out = c.process([{ mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.01), azimuthDeg: 0, salienceDb: 0 }], (i * N) / FS);
    // the quiet input (RMS ~0.007) is pulled up toward the target by the AGC
    expect(rms(out.mono)).toBeGreaterThan(rms(tone(0.01)));
  });

  it('a fence veto silences the vetoed kit (drops it from contention)', () => {
    // poses: kit A at (0,0) bearing 0, kit B at (4,0) bearing 0; a tiny fence box near the origin.
    const poseA: KitPose = { position: { x: 0, y: 0 }, bearingDeg: 0 };
    const poseB: KitPose = { position: { x: 4, y: 0 }, bearingDeg: 0 };
    const polygon = [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }];
    const c = new MultiArrayCombiner(FS, { nKits: 2, fence: { holdTicks: 1, marginM: 0.1 }, crossfadeBlocks: 1 });
    // both kits point at a FAR source (rays cross far outside the tiny box) and quiet → fence rejects.
    let out = c.process(
      [{ mono: tone(1e-4), azimuthDeg: 80, salienceDb: -30 }, { mono: tone(1e-4), azimuthDeg: 280, salienceDb: -30 }],
      0, { poses: [poseA, poseB], polygon },
    );
    for (let i = 1; i < 5; i++) {
      out = c.process(
        [{ mono: tone(1e-4), azimuthDeg: 80, salienceDb: -30 }, { mono: tone(1e-4), azimuthDeg: 280, salienceDb: -30 }],
        (i * N) / FS, { poses: [poseA, poseB], polygon },
      );
    }
    expect(out.fenceKeep).toBe(false); // the out-of-fence source is vetoed
  });

  it('reset() clears selection + fade + scorers', () => {
    const c = new MultiArrayCombiner(FS, { nKits: 2 });
    c.process([{ mono: tone(0.001), azimuthDeg: 0, salienceDb: 0 }, { mono: tone(0.3), azimuthDeg: 0, salienceDb: 0 }], 0);
    c.reset();
    expect(c.active).toBe(0);
  });
});
```
(The modulation/score thresholds are behavioral — MEASURE if a switch doesn't happen in the block budget and lengthen the run / deepen the modulation so the test PROVES the selection, never a tautology. Report numbers.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — `src/live/multi-array-combiner.ts`:
```ts
import { KitSelector, type KitSelectorOptions } from './kit-selector.js';
import { SpeechPresenceScorer } from './speech-presence.js';
import { FenceDecider, type KitPose, type KitReading } from './triangulation.js';
import { TargetLoudnessAgc, type AgcOptions } from './agc.js';
import type { Point2D } from '../model/geometry.js';

/** Equal-power ramp length (blocks) on a kit switch (~0.2 s @ 32 ms). */
export const DEFAULT_CROSSFADE_BLOCKS = 6;

/** Equal-power crossfade gains `(gOut, gIn)` at fade `step` of `total` (cos²+sin²=1). */
export function crossfadeGains(step: number, total: number): [number, number] {
  if (total <= 0) return [0, 1];
  const p = Math.min(Math.max(step, 0), total) / total;
  return [Math.cos((p * Math.PI) / 2), Math.sin((p * Math.PI) / 2)];
}

/** One kit's current block + DOA reading. */
export interface KitBlock {
  mono: Float32Array;
  azimuthDeg: number | null;
  salienceDb: number;
}

/** The combiner's per-tick result. */
export interface CombinedOutput {
  mono: Float32Array;
  active: number;
  switching: boolean;
  speechPresent: boolean;
  scores: number[];
  fenceKeep: boolean | null;
}

export interface MultiArrayCombinerOptions {
  nKits?: number;
  crossfadeBlocks?: number;
  agc?: AgcOptions | null;
  fence?: { holdTicks?: number; marginM?: number; insideDb?: number } | null;
  selector?: KitSelectorOptions;
  scorerHopSeconds?: number;
}

function rmsOf(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return x.length ? Math.sqrt(s / x.length) : 0;
}

/**
 * Combine N kits (arrays) into one glitch-free output: per-kit speech-presence scores → kit selection
 * (hysteresis) → equal-power cross-fade on a switch → one combined AGC, with an optional triangulation
 * fence veto. Port of `multikit.py:MultiKitController._produce` (the stream-free testable core).
 */
export class MultiArrayCombiner {
  private readonly n: number;
  private readonly crossfadeBlocks: number;
  private readonly selector: KitSelector;
  private readonly scorers: SpeechPresenceScorer[];
  private readonly fence: FenceDecider | null;
  private readonly agc: TargetLoudnessAgc | null;
  private _active = 0;
  private fading = false;
  private fadeStep = 0;
  private fadeFrom = 0;

  constructor(sampleRate: number, opts: MultiArrayCombinerOptions = {}) {
    this.n = opts.nKits ?? 2;
    this.crossfadeBlocks = Math.max(1, opts.crossfadeBlocks ?? DEFAULT_CROSSFADE_BLOCKS);
    this.selector = new KitSelector({ nKits: this.n, ...(opts.selector ?? {}) });
    const hop = opts.scorerHopSeconds ?? 0.0116;
    this.scorers = Array.from({ length: this.n }, () => new SpeechPresenceScorer({ hopSeconds: hop }));
    this.fence = opts.fence ? new FenceDecider(opts.fence) : null;
    this.agc = opts.agc ? new TargetLoudnessAgc(sampleRate, opts.agc) : null;
  }

  get active(): number {
    return this._active;
  }

  process(
    kits: readonly KitBlock[],
    t: number,
    fenceCtx?: { poses: readonly [KitPose, KitPose]; polygon: readonly Point2D[] },
  ): CombinedOutput {
    const n = this.n;
    const len = kits[0]!.mono.length;
    // per-kit speech-presence scores from each kit's output RMS
    const scores: number[] = [];
    for (let i = 0; i < n; i++) scores.push(this.scorers[i]!.update(rmsOf(kits[i]!.mono)));

    // optional fence veto (drops the vetoed kit from contention)
    const eff = [...scores];
    let fenceKeep: boolean | null = null;
    if (this.fence && fenceCtx && n >= 2) {
      const mk = (i: number): KitReading => ({
        azimuthDeg: kits[i]!.azimuthDeg,
        salienceDb: kits[i]!.salienceDb,
        level: rmsOf(kits[i]!.mono),
        active: i === this._active,
      });
      const dec = this.fence.update(mk(0), mk(1), fenceCtx.poses[0], fenceCtx.poses[1], fenceCtx.polygon, t);
      fenceKeep = dec.keep;
      if (dec.vetoKit !== null) eff[dec.vetoKit] = 0;
    }

    const state = this.selector.update(eff, t);
    if (state.switching) {
      this.fadeFrom = this._active;
      this._active = state.active;
      this.fading = true;
      this.fadeStep = 0;
    }

    // mix: equal-power cross-fade while fading, else the active kit
    const out = new Float32Array(len);
    if (this.fading && this.fadeFrom !== this._active) {
      const [gOut, gIn] = crossfadeGains(this.fadeStep, this.crossfadeBlocks);
      const from = kits[this.fadeFrom]!.mono;
      const to = kits[this._active]!.mono;
      for (let i = 0; i < len; i++) out[i] = gOut * from[i]! + gIn * to[i]!;
      this.fadeStep += 1;
      if (this.fadeStep >= this.crossfadeBlocks) this.fading = false;
    } else {
      const a = kits[this._active]!.mono;
      for (let i = 0; i < len; i++) out[i] = a[i]!;
    }

    const mono = this.agc ? this.agc.process(out, false) : out;
    return { mono, active: this._active, switching: state.switching, speechPresent: state.speechPresent, scores: state.scores, fenceKeep };
  }

  reset(): void {
    this._active = 0;
    this.fading = false;
    this.fadeStep = 0;
    this.fadeFrom = 0;
    this.selector.reset();
    for (const s of this.scorers) s.reset();
    if (this.fence) this.fence.reset();
    if (this.agc) this.agc.reset();
  }
}
```
(If `TargetLoudnessAgc`'s constructor signature differs — read `src/live/agc.ts` — adapt the `new TargetLoudnessAgc(...)` call and the `AgcOptions` import accordingly.)

- [ ] **Step 4: Run + typecheck + full suite + build, then commit**
```bash
npx vitest run test/live-multi-array-combiner.test.ts && npm run typecheck && npm test && npm run build
git add src/live/multi-array-combiner.ts test/live-multi-array-combiner.test.ts
git commit -m "feat(live): multi-array combiner (select + cross-fade + one AGC + fence veto)"
```

---

## Notes for the controller

- B3 is the stream-free combiner core (no devices). The two-`LiveEngine` host wiring (two adapters, clock sync, feeding `process` each block) is a thin node-host concern, deferred (like `serve.mjs`).
- After B3, Phase B is complete — index.ts exports + a short docs pass, then PR Phase B.
- Watchdog (a stalled kit going dead) is omitted from the combiner core (a host concern); note it in the honest limits if surfacing.

## Self-review (done)

- **Spec coverage:** `crossfadeGains` + `MultiArrayCombiner` (scores → fence veto → select → cross-fade → AGC) = the testable `_produce` core.
- **Faithfulness:** equal-power cos/sin ramp, switch-starts-fade, eff-score veto, one combined AGC. Reuses B1 `FenceDecider`, B2 `KitSelector`, the shipped `SpeechPresenceScorer` + `TargetLoudnessAgc`.
- **Constraints:** zero-dep, browser-safe, `.js`, no `as`, omit-when-absent (selector spread), Float64 mix → Float32 out.
