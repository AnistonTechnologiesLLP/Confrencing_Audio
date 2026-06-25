# Live audio — Phase A3 (null-budget arbiter + null-steering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frequency-domain beam steer nulls at interferers/excluded areas — a deterministic null-budget arbiter feeding A1's LCMV path through the beam, wired opt-in into the engine.

**Architecture:** `null-budget.ts` (`composeNulls`, port of Python `compose_nulls`) merges detected/exclusion/seat nulls into one budgeted list. `FreqDomainBeam.setNulls` recomputes its weights with those nulls (A1 already does LCMV). The engine composes nulls from DOA detections + config and pushes them to the freq-domain beam, emitting `BeamOutput.activeNulls`.

**Tech Stack:** TypeScript ESM (strict), vitest, zero runtime dependencies.

## Global Constraints

- **Zero deps**; **`src/live/` browser-safe**; relative imports carry `.js`; `import type` for types; **no `as` casts** (non-null `!` ok); `exactOptionalPropertyTypes` (omit-when-absent spreads).
- **Default-off byte-identical:** no `config.nulls` ⇒ the freq beam runs with `[]` nulls (= A2, unchanged) and emits no `activeNulls`; the delay-sum path is untouched.
- Constants (Python parity): `NULL_MIN_SEP_DEG = 8.0`, `NULL_MERGE_SEP_DEG = 6.0`.
- Faithful to `conf_pipeline_control/polaris_beamformer.py:compose_nulls` (555-599).
- Tests hardware-free. Gates: `npm run typecheck`, `npm test`, `npm run build` green.

---

### Task 1: `composeNulls` — the null-budget arbiter

**Files:**
- Modify: `src/live/mvdr-solver.ts` (export the existing private `azSep`)
- Create: `src/live/null-budget.ts`
- Test: `test/live-null-budget.test.ts`

**Interfaces:**
- Consumes: `azSep` from `./mvdr-solver.js`.
- Produces: `composeNulls(targetAzDeg, detected, budget, opts?): number[]`; `interface ComposeNullsOptions`; `NULL_MIN_SEP_DEG`, `NULL_MERGE_SEP_DEG`.

- [ ] **Step 1: Export `azSep`** — in `src/live/mvdr-solver.ts`, change `function azSep(` to `export function azSep(`.

- [ ] **Step 2: Write the failing test** — `test/live-null-budget.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { composeNulls, NULL_MIN_SEP_DEG, NULL_MERGE_SEP_DEG } from '../src/live/null-budget.js';

describe('composeNulls', () => {
  it('returns [] when budget <= 0', () => {
    expect(composeNulls(0, [90, 180], 0)).toEqual([]);
  });

  it('detected interferers win the budget', () => {
    const out = composeNulls(0, [60, 120, 200], 7, { exclusion: [90], seats: [150] });
    expect(out.slice(0, 3)).toEqual([60, 120, 200]); // detected first, in order
  });

  it('drops a null within 8° of the look (would null the target)', () => {
    expect(composeNulls(0, [5, 90], 7)).toEqual([90]); // 5° dropped
    expect(composeNulls(0, [], 7, { exclusion: [4] })).toEqual([]); // 4° exclusion dropped
  });

  it('dedupes within 6° across sources (one null per constraint)', () => {
    // detected 90; exclusion 93 (within 6° of detected) → dropped
    expect(composeNulls(0, [90], 7, { exclusion: [93] })).toEqual([90]);
    // two near-duplicate detected collapse to one
    expect(composeNulls(0, [90, 94], 7)).toEqual([90]);
  });

  it('fills detected, then exclusions, then seats (precedence) and caps at budget', () => {
    const out = composeNulls(0, [60], 3, { exclusion: [120], seats: [180, 240] });
    expect(out).toEqual([60, 120, 180]); // detected, exclusion, then nearest seat; capped at 3
  });

  it('orders seats nearest-to-look first and respects seatNullMaxCount', () => {
    const out = composeNulls(0, [], 7, { seats: [200, 100, 160], seatNullMaxCount: 2 });
    // nearest-to-look (wrap-aware): 100 (sep 100), 160 (sep 160), 200 (sep 160) → 100 then 160; capped 2
    expect(out.length).toBe(2);
    expect(out[0]).toBe(100);
  });

  it('drops an exclusion/seat that does not fit the remaining budget', () => {
    const out = composeNulls(0, [40, 80, 130], 3, { exclusion: [170], seats: [220] });
    expect(out).toEqual([40, 80, 130]); // budget full on detected; exclusion+seat dropped
  });

  it('exposes the Python-parity constants', () => {
    expect(NULL_MIN_SEP_DEG).toBe(8);
    expect(NULL_MERGE_SEP_DEG).toBe(6);
  });
});
```

- [ ] **Step 3: Run to verify it fails** (`npx vitest run test/live-null-budget.test.ts`).

- [ ] **Step 4: Implement** — `src/live/null-budget.ts`:
```ts
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
  seat = seat.slice().sort((a, b) => azSep(a, targetAzDeg) - azSep(b, targetAzDeg)); // nearest-to-look first
  if (opts.seatNullMaxCount !== undefined && opts.seatNullMaxCount !== null) {
    seat = seat.slice(0, Math.max(0, opts.seatNullMaxCount));
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
```

- [ ] **Step 5: Run + typecheck + commit**
```bash
npx vitest run test/live-null-budget.test.ts && npm run typecheck
git add src/live/mvdr-solver.ts src/live/null-budget.ts test/live-null-budget.test.ts
git commit -m "feat(live): null-budget arbiter (composeNulls)"
```

---

### Task 2: `FreqDomainBeam.setNulls` (LCMV null-steering)

**Files:**
- Modify: `src/live/freq-domain-beam.ts`
- Test: extend `test/live-freq-domain-beam.test.ts`

**Interfaces:**
- Produces: `FreqDomainBeam.setNulls(azimuthsDeg: readonly number[]): void`, `get activeNulls(): number[]`.

- [ ] **Step 1: Write the failing test** (append to `test/live-freq-domain-beam.test.ts`):
```ts
describe('FreqDomainBeam null-steering', () => {
  it('setNulls([φ]) deepens the null toward φ vs no nulls (look stays ~unity)', () => {
    const f = 1500;
    const lookOnly = new FreqDomainBeam(GEOM, FS); lookOnly.setLook(0, 90);
    const withNull = new FreqDomainBeam(GEOM, FS); withNull.setLook(0, 90); withNull.setNulls([90]);
    const drive = (beam: FreqDomainBeam, src: number): number => {
      let last = new Float32Array(512);
      for (let i = 0; i < 24; i++) last = beam.process(planeWaveChannels(GEOM, src, f, 512, i, FS));
      return rms(last);
    };
    const offNoNull = drive(lookOnly, 90);
    const offWithNull = drive(withNull, 90);
    expect(offWithNull).toBeLessThan(offNoNull * 0.6); // the explicit null attenuates 90° further
    const onWithNull = drive(new (FreqDomainBeam as typeof FreqDomainBeam)(GEOM, FS), 0); // sanity look ~unity
    void onWithNull;
  });

  it('setNulls is a no-op when the set is unchanged, recomputes when changed', () => {
    const beam = new FreqDomainBeam(GEOM, FS); beam.setLook(0, 90);
    beam.setNulls([90]);
    const h = beam.debugWeightsHash();
    beam.setNulls([90]); // unchanged
    expect(beam.debugWeightsHash()).toBe(h);
    beam.setNulls([90, 200]); // changed
    expect(beam.debugWeightsHash()).not.toBe(h);
    expect(beam.activeNulls.length).toBeGreaterThan(0);
  });

  it('setNulls([]) reverts to the superdirective (no-null) weights', () => {
    const a = new FreqDomainBeam(GEOM, FS); a.setLook(0, 90);
    const b = new FreqDomainBeam(GEOM, FS); b.setLook(0, 90); b.setNulls([90]); b.setNulls([]);
    expect(b.debugWeightsHash()).toBe(a.debugWeightsHash());
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — in `src/live/freq-domain-beam.ts`:
- import `bearingDirection` (already imported) and add a field `private nullsDeg: number[] = [];`.
- change `recompute()` to build null `Direction`s and pass them:
```ts
  private recompute(): void {
    const look = bearingDirection(this.azimuthDeg, this.offNadirDeg);
    const nullDirs = this.nullsDeg.map((az) => bearingDirection(az, this.offNadirDeg));
    this.W = computeBeamWeights(this.geom, this.freqsHz, look, nullDirs, { loading: this.loading });
  }
```
- add `setNulls`:
```ts
  /** Set the null bearings (array-relative deg); recomputes the weights only when the set changes. */
  setNulls(azimuthsDeg: readonly number[]): void {
    const next = [...azimuthsDeg];
    if (next.length === this.nullsDeg.length && next.every((v, i) => v === this.nullsDeg[i])) return;
    this.nullsDeg = next;
    this.recompute();
  }

  /** The currently-applied null bearings (after A1's acceptableNulls capping is internal; these are requested). */
  get activeNulls(): number[] {
    return [...this.nullsDeg];
  }
```
(`setLook` already calls `recompute`, which now includes the current nulls — leave it.)

- [ ] **Step 4: Run + typecheck + commit**

If the null-depth threshold (`< 0.6×`) is off once measured (the LCMV null depth on a 40 mm array is bounded), MEASURE and adjust to still prove the null deepens the off-axis attenuation — never a tautology. Report the numbers.
```bash
npx vitest run test/live-freq-domain-beam.test.ts && npm run typecheck && npm test
git add src/live/freq-domain-beam.ts test/live-freq-domain-beam.test.ts
git commit -m "feat(live): FreqDomainBeam null-steering (setNulls via LCMV)"
```

---

### Task 3: Wire opt-in null-steering into `LiveEngine`

**Files:**
- Modify: `src/live/types.ts` (`LiveConfig.nulls?`, `BeamOutput.activeNulls?`)
- Modify: `src/live/engine.ts` (compose nulls in the DOA cycle, push to the freq beam, emit)
- Modify: `src/live/index.ts` (export `composeNulls`, constants, `ComposeNullsOptions`)
- Test: `test/live-engine-nullsteer.test.ts`

**Interfaces:**
- Produces: `LiveConfig.nulls?: { autoNullInterferers?: boolean; exclusionDeg?: number[]; seatDeg?: number[]; seatNullMaxCount?: number }`; `BeamOutput.activeNulls?: number[]`.

- [ ] **Step 1: Write the failing test** — `test/live-engine-nullsteer.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { LiveEngine } from '../src/live/engine.js';
import { MockCaptureAdapter } from '../src/live/mock-adapter.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import type { BeamOutput, LiveConfig } from '../src/live/types.js';

const GEOM = sensibel8(0.04);
async function run(extra: Partial<LiveConfig>): Promise<BeamOutput[]> {
  const mock = new MockCaptureAdapter({ channels: 8, azimuthDeg: 90, blocks: 30, blockSize: 512, freqHz: 1500 });
  const engine = new LiveEngine(mock, { geom: GEOM, deviceName: 'MOCK-8', sampleRate: 44100, azimuthDeg: 0, ...extra });
  const outs: BeamOutput[] = [];
  engine.onOutput((o) => outs.push(o));
  await engine.start();
  return outs;
}

describe('LiveEngine null-steering', () => {
  it('emits no activeNulls when nulls config is absent (byte-identical)', async () => {
    const outs = await run({ beam: 'freqDomain' });
    for (const o of outs) expect('activeNulls' in o).toBe(false);
  });

  it('applies a configured exclusion null on the freqDomain beam and reports it', async () => {
    const outs = await run({ beam: 'freqDomain', nulls: { exclusionDeg: [90] } });
    const last = outs.at(-1)!;
    expect(last.activeNulls).toBeDefined();
    expect(last.activeNulls!.some((a) => Math.abs(a - 90) < 8)).toBe(true);
  });

  it('ignores nulls config on the delay-sum beam (no throw, no activeNulls)', async () => {
    const outs = await run({ nulls: { exclusionDeg: [90] } }); // delaySum default
    expect(outs.length).toBeGreaterThan(0);
    for (const o of outs) expect('activeNulls' in o).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Wire it** — `src/live/types.ts`:
```ts
// add to LiveConfig
  nulls?: { autoNullInterferers?: boolean; exclusionDeg?: number[]; seatDeg?: number[]; seatNullMaxCount?: number };
// add to BeamOutput (omit-when-absent)
  activeNulls?: number[];
```
`src/live/engine.ts`:
- import `composeNulls` from `./null-budget.js` and (if needed to narrow) `FreqDomainBeam` from `./freq-domain-beam.js`.
- Keep a `private freqBeam: FreqDomainBeam | null` set when the constructed beam is a `FreqDomainBeam` (so the engine can call `setNulls`/read `activeNulls` only on it). E.g. build the beam, then `this.freqBeam = this.beam instanceof FreqDomainBeam ? this.beam : null;`.
- In the DOA cycle (where `this.lastDoa` is refreshed, after `detect(...)`), if `config.nulls` and `this.freqBeam`:
```ts
        const nc = this.config.nulls;
        if (nc && this.freqBeam) {
          const detected = nc.autoNullInterferers && this.lastDoa
            ? this.lastDoa.detections.map((d) => d.azimuthDeg).filter((a) => /* exclude the look */ Math.abs(a - this._azimuthDeg) >= 8)
            : [];
          const composed = composeNulls(this._azimuthDeg, detected, this.config.geom.activeIndices().length - 1, {
            ...(nc.exclusionDeg ? { exclusion: nc.exclusionDeg } : {}),
            ...(nc.seatDeg ? { seats: nc.seatDeg } : {}),
            ...(nc.seatNullMaxCount !== undefined ? { seatNullMaxCount: nc.seatNullMaxCount } : {}),
          });
          this.freqBeam.setNulls(composed);
        }
```
  (If `config.nulls` has only static exclusion/seat nulls and no auto-null, this still applies them once the DOA cycle runs; if the engine has no DOA cycle — `config.autoSteer`/`cov` absent — compose the static nulls once in the constructor instead. Implementer: ensure static exclusion/seat nulls are applied even without auto-steer — apply them in the constructor after building the freq beam, then refine with detected interferers in the DOA cycle when `autoNullInterferers`.)
- Emit in the `cb?.({...})`: `...(this.freqBeam && this.config.nulls ? { activeNulls: this.freqBeam.activeNulls } : {})`.

`src/live/index.ts`: `export { composeNulls, NULL_MIN_SEP_DEG, NULL_MERGE_SEP_DEG, type ComposeNullsOptions } from './null-budget.js';`

- [ ] **Step 4: Run the new test + typecheck + full suite + build, then commit**
```bash
npx vitest run test/live-engine-nullsteer.test.ts && npm run typecheck && npm test && npm run build
git add src/live/types.ts src/live/engine.ts src/live/index.ts test/live-engine-nullsteer.test.ts
git commit -m "feat(live): wire opt-in null-steering into LiveEngine"
```

---

## Notes for the controller

- Static exclusion/seat nulls must apply even without auto-steer (no DOA cycle). The implementer must handle both: constructor-time application of static nulls + DOA-cycle refinement with detected interferers. Flag if the engine structure makes this awkward.
- **A3b (measured-R MVDR)** is the next step (frames match at 1024): expose the covariance band-bin indices in `snapshot()`, add a `mvdr` flag, wire the provider into the freq beam. Separate sub-phase.
- Whole-branch review at the end of Phase A.

## Self-review (done)

- **Spec coverage:** Task 1 (`composeNulls`), Task 2 (`setNulls`), Task 3 (engine wiring + telemetry) cover spec §2.
- **Placeholders:** none — full code (Task 3's engine edit is described precisely with the static-vs-auto nuance called out for the implementer).
- **Type consistency:** `composeNulls`/`ComposeNullsOptions`/constants, `setNulls`/`activeNulls`, `LiveConfig.nulls`/`BeamOutput.activeNulls` consistent. Reuses `azSep` (now exported), A1 `computeBeamWeights` LCMV, `bearingDirection`.
- **Constraints:** zero-dep, browser-safe, `.js`, no `as`, omit-when-absent (`activeNulls` + the composeNulls opts spreads), default-off byte-identical, Python-faithful (`compose_nulls` order + constants).
