# Live audio — Phase A1 (per-bin MVDR/LCMV solver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, zero-dep per-FFT-bin LCMV/MVDR beam-weight solver (`computeBeamWeights`) that the Phase-A2 runtime will call off the audio lock.

**Architecture:** A new `src/live/mvdr-solver.ts` reuses the validated narrowband primitives (`steeringVector`, `diffuseCoherence`, the complex `solve`) from `src/beamformer/` and, per bin, builds `R = Γ(f) + loading·I` (optionally overlaying a measured complex covariance on DOA-band bins), then solves MVDR (`w=R⁻¹a/aᴴR⁻¹a`, K=0) or LCMV (`w=R⁻¹C(CᴴR⁻¹C)⁻¹g`, K>0, ridge-stabilised). Output is a `Complex[][]` weight table `[bin][channel]`.

**Tech Stack:** TypeScript ESM (strict), vitest, zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies** — `dependencies` stays `{}`. Pure complex math; reuses the existing pure-stdlib beamformer primitives.
- **`src/live/` is browser-safe** — NO `node:*`/`Buffer`. (It already imports `../beamformer/geometry.js`; `beamformer.ts`/`steering.ts` are pure stdlib too.)
- **Relative imports carry `.js`**; `import type` for type-only imports (`verbatimModuleSyntax`).
- **No `as` casts.** Non-null `!` is allowed (required by `noUncheckedIndexedAccess`).
- **`exactOptionalPropertyTypes`** — optional fields omit-when-absent.
- **`noUnusedLocals`/`noUnusedParameters`.**
- **Faithful to** `conf_pipeline_control/polaris_beamformer.py:_compute_weights` (the freq-domain beam is **Γ-based superdirective / measured-R MVDR**, never identity-R).
- Constants (Python parity): `DEFAULT_SUPERDIRECTIVE_LOADING = 0.05`, loading floor `1e-9`, LCMV DC ridge `1e-10`, `NULL_LOOK_GUARD_DEG = 5.0`.
- Tests hardware-free (vitest). Gates: `npm run typecheck`, `npm test`, `npm run build` green.

---

### Task 1: Export the complex `solve` for the live solver

**Files:**
- Modify: `src/beamformer/beamformer.ts` (add `export` to the private `solve` + `SingularMatrixError`)

**Interfaces:**
- Produces: `export function solve(a: Complex[][], b: Complex[]): Complex[]` and `export class SingularMatrixError` (already exist as non-exported — this only adds `export`).

- [ ] **Step 1: Locate the declarations**

In `src/beamformer/beamformer.ts`, the function is `function solve(a: Complex[][], b: Complex[]): Complex[]` (~line 113) and `SingularMatrixError` is the error it throws (search for `class SingularMatrixError` / `SingularMatrixError`).

- [ ] **Step 2: Add `export`**

Change `function solve(` → `export function solve(`. If `SingularMatrixError` is declared as `class SingularMatrixError extends Error` without `export`, add `export` to it too. Do NOT change any logic.

- [ ] **Step 3: Verify the offline suite is unaffected**

Run: `npx vitest run test/beamformer.test.ts && npm run typecheck`
Expected: PASS + clean (this is a purely additive export — no behavior change).

- [ ] **Step 4: Commit**

```bash
git add src/beamformer/beamformer.ts
git commit -m "feat(beamformer): export the complex solve for the live MVDR solver"
```

---

### Task 2: `mvdr-solver.ts` — per-bin MVDR/LCMV weights (+ measured-R MVDR)

**Files:**
- Create: `src/live/mvdr-solver.ts`
- Test: `test/live-mvdr-solver.test.ts`

**Interfaces:**
- Consumes: `steeringVector`, `diffuseCoherence`, `solve` from `../beamformer/beamformer.js`; `Complex`/`cadd`/`cconj`/`cdiv`/`cmul`/`complex`/`ArrayGeometry` from `../beamformer/geometry.js`; `Direction` from `../beamformer/steering.js`.
- Produces:
  - `interface MeasuredNoise { bandBins: readonly number[]; cov: readonly Complex[][][] }`
  - `interface BeamWeightOptions { loading?: number; measured?: MeasuredNoise | null }`
  - `function computeBeamWeights(geom, freqsHz, look, nulls, opts?): Complex[][]`
  - `function acceptableNulls(geom, look, nulls): Direction[]`
  - constants `DEFAULT_SUPERDIRECTIVE_LOADING`, `MVDR_LOADING_FLOOR`, `LCMV_DC_RIDGE`, `NULL_LOOK_GUARD_DEG`

- [ ] **Step 1: Write the failing test**

Create `test/live-mvdr-solver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeBeamWeights, acceptableNulls, DEFAULT_SUPERDIRECTIVE_LOADING } from '../src/live/mvdr-solver.js';
import { superdirectiveWeights, steeringVector } from '../src/beamformer/beamformer.js';
import { bearingDirection } from '../src/beamformer/beamformer.js';
import { sensibel8 } from '../src/beamformer/geometry.js';
import { cadd, cconj, cmul, cabs, type Complex } from '../src/beamformer/geometry.js';
import type { Direction } from '../src/beamformer/steering.js';

const GEOM = sensibel8(0.04);
const ZERO: Complex = { re: 0, im: 0 };

/** Array response R(u) = wᴴ a(u) at frequency f for a per-channel weight vector. */
function responseAt(w: Complex[], dir: Direction, f: number): number {
  const a = steeringVector(GEOM, dir.unit, f);
  let s: Complex = { re: 0, im: 0 };
  for (let i = 0; i < a.length; i++) s = cadd(s, cmul(cconj(w[i]!), a[i]!));
  return cabs(s);
}

describe('acceptableNulls', () => {
  it('drops a null within 5° of the look, near-duplicates, and caps at M-1', () => {
    const look = bearingDirection(0);
    const nulls = [bearingDirection(3), bearingDirection(90), bearingDirection(92), bearingDirection(180), bearingDirection(200), bearingDirection(250), bearingDirection(300), bearingDirection(330), bearingDirection(350)];
    const ok = acceptableNulls(GEOM, look, nulls);
    // 3° dropped (near look); 92° dropped (near 90°); remaining capped at na-1 = 7
    expect(ok.every((d) => Math.abs(((d.azimuthDeg + 180) % 360) - 180) >= 5 || d.azimuthDeg !== 3)).toBe(true);
    expect(ok.length).toBeLessThanOrEqual(GEOM.activeIndices().length - 1);
    expect(ok.map((d) => d.azimuthDeg)).not.toContain(3);
    expect(ok.map((d) => d.azimuthDeg)).not.toContain(92);
  });
});

describe('computeBeamWeights — analytic superdirective / LCMV', () => {
  it('matches the offline superdirectiveWeights bin-for-bin (K=0) at in-band freqs', () => {
    const look = bearingDirection(40);
    const freqs = [500, 1000, 2000, 3000];
    const W = computeBeamWeights(GEOM, freqs, look, []);
    freqs.forEach((f, b) => {
      const ref = superdirectiveWeights(GEOM, look, [], f, DEFAULT_SUPERDIRECTIVE_LOADING);
      for (let ch = 0; ch < GEOM.nChannels; ch++) {
        expect(W[b]![ch]!.re).toBeCloseTo(ref[ch]!.re, 6);
        expect(W[b]![ch]!.im).toBeCloseTo(ref[ch]!.im, 6);
      }
    });
  });

  it('matches the offline superdirectiveWeights with nulls (K>0) in-band (ridge negligible)', () => {
    const look = bearingDirection(0);
    const nulls = [bearingDirection(90)];
    const freqs = [800, 1500, 2500];
    const W = computeBeamWeights(GEOM, freqs, look, nulls);
    freqs.forEach((f, b) => {
      const ref = superdirectiveWeights(GEOM, look, nulls, f, DEFAULT_SUPERDIRECTIVE_LOADING);
      for (let ch = 0; ch < GEOM.nChannels; ch++) {
        expect(W[b]![ch]!.re).toBeCloseTo(ref[ch]!.re, 4);
        expect(W[b]![ch]!.im).toBeCloseTo(ref[ch]!.im, 4);
      }
    });
  });

  it('gives unity gain at the look and a deep null toward φ', () => {
    const look = bearingDirection(0);
    const nullDir = bearingDirection(90);
    const f = 2000;
    const W = computeBeamWeights(GEOM, [f], look, [nullDir]);
    const w = W[0]!;
    expect(responseAt(w, look, f)).toBeCloseTo(1, 3);            // unity at look
    const nullDb = 20 * Math.log10(responseAt(w, nullDir, f) + 1e-12);
    expect(nullDb).toBeLessThan(-40);                            // deep null toward φ
  });

  it('stays finite at DC and very low frequency (ridge / loading), with and without nulls', () => {
    const look = bearingDirection(0);
    const W0 = computeBeamWeights(GEOM, [0, 20], look, []);
    const W1 = computeBeamWeights(GEOM, [0, 20], look, [bearingDirection(90)]);
    for (const W of [W0, W1]) {
      for (const row of W) for (const c of row) {
        expect(Number.isFinite(c.re)).toBe(true);
        expect(Number.isFinite(c.im)).toBe(true);
      }
    }
  });

  it('zeroes inactive capsules and is deterministic', () => {
    // mark a capsule inactive via geometry if supported; otherwise assert active-set scatter is correct.
    const look = bearingDirection(10);
    const a = computeBeamWeights(GEOM, [1500], look, []);
    const b = computeBeamWeights(GEOM, [1500], look, []);
    expect(a).toEqual(b); // pure / deterministic
    const active = new Set(GEOM.activeIndices());
    for (let ch = 0; ch < GEOM.nChannels; ch++) {
      if (!active.has(ch)) expect(a[0]![ch]).toEqual(ZERO);
    }
  });
});

describe('computeBeamWeights — data-adaptive MVDR (measured covariance)', () => {
  it('nulls a synthetic rank-1 interferer supplied as a measured covariance', () => {
    const look = bearingDirection(0);
    const interferer = bearingDirection(70);
    const f = 1800;
    // R = σ²·a(φ)a(φ)ᴴ + ε I  (rank-1 interferer + small white floor), full M×M
    const a = steeringVector(GEOM, interferer.unit, f);
    const M = GEOM.nChannels;
    const sigma2 = 50, eps = 1e-2;
    const cov: Complex[][] = Array.from({ length: M }, (_r, i) =>
      Array.from({ length: M }, (_c, j) => {
        const outer = cmul(a[i]!, cconj(a[j]!)); // a_i · conj(a_j)
        return { re: sigma2 * outer.re + (i === j ? eps : 0), im: sigma2 * outer.im };
      }),
    );
    const W = computeBeamWeights(GEOM, [f], look, [], { measured: { bandBins: [0], cov: [cov] } });
    const w = W[0]!;
    const lookResp = responseAt(w, look, f);
    const intResp = responseAt(w, interferer, f);
    expect(lookResp).toBeGreaterThan(0.3);                       // still hears the look
    expect(20 * Math.log10(intResp / lookResp + 1e-12)).toBeLessThan(-15); // measured interferer suppressed
  });

  it('falls back to analytic Γ on bins outside the measured band', () => {
    const look = bearingDirection(0);
    const f0 = 1000, f1 = 2000;
    const a = steeringVector(GEOM, bearingDirection(70).unit, f1);
    const M = GEOM.nChannels;
    const cov: Complex[][] = Array.from({ length: M }, (_r, i) => Array.from({ length: M }, (_c, j) => {
      const outer = cmul(a[i]!, cconj(a[j]!));
      return { re: 50 * outer.re + (i === j ? 1e-2 : 0), im: 50 * outer.im };
    }));
    // measured only on bin index 1 (f1); bin 0 (f0) must equal the no-measured analytic result
    const W = computeBeamWeights(GEOM, [f0, f1], look, [], { measured: { bandBins: [1], cov: [cov] } });
    const ref0 = computeBeamWeights(GEOM, [f0], look, [])[0]!;
    for (let ch = 0; ch < M; ch++) {
      expect(W[0]![ch]!.re).toBeCloseTo(ref0[ch]!.re, 9);
      expect(W[0]![ch]!.im).toBeCloseTo(ref0[ch]!.im, 9);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/live-mvdr-solver.test.ts`
Expected: FAIL — `Cannot find module '../src/live/mvdr-solver.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/live/mvdr-solver.ts`:

```ts
import {
  ArrayGeometry,
  cadd,
  cconj,
  cdiv,
  cmul,
  complex,
  type Complex,
} from '../beamformer/geometry.js';
import { diffuseCoherence, solve, steeringVector } from '../beamformer/beamformer.js';
import type { Direction } from '../beamformer/steering.js';

/** Diagonal loading for the superdirective solve (Python `DEFAULT_SUPERDIRECTIVE_LOADING`). */
export const DEFAULT_SUPERDIRECTIVE_LOADING = 0.05;
/** Floor on the loading so the DC bin's rank-1 Γ stays solvable. */
export const MVDR_LOADING_FLOOR = 1e-9;
/** Trace-relative ridge for the LCMV `CᴴR⁻¹C` solve where manifolds collapse (DC/low-f). */
export const LCMV_DC_RIDGE = 1e-10;
/** Drop a null within this angular distance of the look (or a prior null). */
export const NULL_LOOK_GUARD_DEG = 5.0;

/** A measured noise covariance for the DOA-band bins (data-adaptive MVDR). */
export interface MeasuredNoise {
  /** rfft bin indices that carry a measured covariance. */
  bandBins: readonly number[];
  /** `cov[i]` = the M×M Hermitian covariance for bin `bandBins[i]` (full channels). */
  cov: readonly Complex[][][];
}

export interface BeamWeightOptions {
  /** Diagonal loading; default {@link DEFAULT_SUPERDIRECTIVE_LOADING}; floored at {@link MVDR_LOADING_FLOOR}. */
  loading?: number;
  /** Measured covariance overlay (data-adaptive MVDR); null/absent ⇒ analytic superdirective. */
  measured?: MeasuredNoise | null;
}

const ZERO = (): Complex => ({ re: 0, im: 0 });

/** Wrap-aware absolute azimuth separation in [0, 180]° (Python `_az_sep`). */
function azSep(a: number, b: number): number {
  const m = (((a - b + 180) % 360) + 360) % 360;
  return Math.abs(m - 180);
}

/**
 * Vet requested nulls for a well-posed LCMV solve: drop any within {@link NULL_LOOK_GUARD_DEG}
 * of the look or of an already-accepted null, then cap at `na − 1` (the array's null budget).
 * Mirrors Python `_acceptable_nulls`. (The rich budget arbiter — tiers/salience/seats — is Phase A3.)
 */
export function acceptableNulls(
  geom: ArrayGeometry,
  look: Direction,
  nulls: readonly Direction[],
): Direction[] {
  const maxCount = geom.activeIndices().length - 1;
  if (maxCount <= 0) return [];
  const out: Direction[] = [];
  for (const phi of nulls) {
    if (azSep(phi.azimuthDeg, look.azimuthDeg) < NULL_LOOK_GUARD_DEG) continue;
    if (out.some((q) => azSep(phi.azimuthDeg, q.azimuthDeg) < NULL_LOOK_GUARD_DEG)) continue;
    out.push(phi);
    if (out.length >= maxCount) break;
  }
  return out;
}

/**
 * Per-FFT-bin LCMV/MVDR beam weights — `w = R⁻¹a / (aᴴR⁻¹a)` (K=0) or
 * `w = R⁻¹C (CᴴR⁻¹C)⁻¹ g` (K>0), with `R = Γ(f) + loading·I` overlaid by a measured
 * covariance on the DOA-band bins. Returns `W[bin][channel]` (inactive channels = 0).
 *
 * Pure / off-lock — the heavy per-bin solve (the Phase-A2 runtime calls this in `plan`,
 * never on the audio callback). Faithful port of Python `_FreqDomainBeam._compute_weights`.
 */
export function computeBeamWeights(
  geom: ArrayGeometry,
  freqsHz: readonly number[],
  look: Direction,
  nulls: readonly Direction[],
  opts: BeamWeightOptions = {},
): Complex[][] {
  const idx = geom.activeIndices();
  const na = idx.length;
  const M = geom.nChannels;
  const loading = Math.max(MVDR_LOADING_FLOOR, opts.loading ?? DEFAULT_SUPERDIRECTIVE_LOADING);
  const phis = acceptableNulls(geom, look, nulls);
  const K = phis.length;

  const measured = opts.measured ?? null;
  const band = new Map<number, number>();
  if (measured) measured.bandBins.forEach((b, i) => band.set(b, i));

  const W: Complex[][] = [];
  for (let b = 0; b < freqsHz.length; b++) {
    const f = freqsHz[b]!;
    const aFull = steeringVector(geom, look.unit, f);
    const a = idx.map((i) => aFull[i]!); // active look manifold

    // R (na×na) complex
    let R: Complex[][];
    const mi = measured ? band.get(b) : undefined;
    if (measured && mi !== undefined) {
      const cov = measured.cov[mi]!;
      const rn: Complex[][] = idx.map((ri) => idx.map((ci) => ({ ...cov[ri]![ci]! })));
      let trSum = 0;
      for (let i = 0; i < na; i++) trSum += rn[i]![i]!.re;
      const ld = loading * Math.max(trSum / na, 1e-20); // trace-relative loading
      for (let i = 0; i < na; i++) rn[i]![i] = cadd(rn[i]![i]!, complex(ld, 0));
      R = rn;
    } else {
      const gamma = diffuseCoherence(geom, f); // na×na real Γ
      R = gamma.map((row, i) => row.map((g, j) => complex(g + (i === j ? loading : 0), 0)));
    }

    // solve
    let w: Complex[];
    if (K === 0) {
      const t = solve(R, a); // R⁻¹a
      let denom: Complex = ZERO();
      for (let i = 0; i < na; i++) denom = cadd(denom, cmul(cconj(a[i]!), t[i]!)); // aᴴR⁻¹a
      w = t.map((ti) => cdiv(ti, denom));
    } else {
      const cols: Complex[][] = [a];
      for (const phi of phis) {
        const aN = steeringVector(geom, phi.unit, f);
        cols.push(idx.map((i) => aN[i]!));
      }
      const rinvCols = cols.map((col) => solve(R, col)); // R⁻¹C, columnwise
      const kk = cols.length;
      const small: Complex[][] = Array.from({ length: kk }, () => Array.from({ length: kk }, ZERO));
      for (let p = 0; p < kk; p++) {
        for (let q = 0; q < kk; q++) {
          let s: Complex = ZERO();
          for (let i = 0; i < na; i++) s = cadd(s, cmul(cconj(cols[p]![i]!), rinvCols[q]![i]!));
          small[p]![q] = s; // CᴴR⁻¹C
        }
      }
      let trSmall = 0;
      for (let i = 0; i < kk; i++) trSmall += small[i]![i]!.re;
      const ridge = LCMV_DC_RIDGE * Math.max(trSmall, 1e-30);
      for (let i = 0; i < kk; i++) small[i]![i] = cadd(small[i]![i]!, complex(ridge, 0));
      const g: Complex[] = Array.from({ length: kk }, ZERO);
      g[0] = complex(1, 0);
      const y = solve(small, g);
      w = [];
      for (let i = 0; i < na; i++) {
        let s: Complex = ZERO();
        for (let q = 0; q < kk; q++) s = cadd(s, cmul(y[q]!, rinvCols[q]![i]!));
        w.push(s);
      }
    }

    // scatter into full channels (inactive = 0)
    const row: Complex[] = Array.from({ length: M }, ZERO);
    idx.forEach((ch, slot) => {
      row[ch] = w[slot]!;
    });
    W.push(row);
  }
  return W;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/live-mvdr-solver.test.ts`
Expected: PASS. If the K>0 cross-validation tolerance (`toBeCloseTo(..., 4)`) is too tight because of the ridge, RELAX it to 3 — but DO NOT relax the unity/null/measured-suppression behavioral assertions; if a behavioral test fails, the math is wrong — fix the implementation, not the test. Report any tolerance you changed.

- [ ] **Step 5: Typecheck + full suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green (the offline `solve` export from Task 1 + the new module; nothing else changes).

- [ ] **Step 6: Commit**

```bash
git add src/live/mvdr-solver.ts test/live-mvdr-solver.test.ts
git commit -m "feat(live): per-bin MVDR/LCMV beam-weight solver (superdirective + data-adaptive MVDR)"
```

---

## Notes for the controller

- **No engine wiring in A1** — A1 is the pure kernel. A2 builds the `FreqDomainBeam` runtime (STFT + MAC + plan/commit) that calls `computeBeamWeights`, and wires `LiveConfig.beam`.
- **Whole-branch review** runs at the end of Phase A (after A5) — not per sub-phase — but A1's cross-validation against the offline layer is itself a strong correctness gate.
- `bearingDirection` is imported from `beamformer.ts` in the test; confirm it's exported there (it is — line ~773).

## Self-review (done)

- **Spec coverage:** Task 1 (export `solve`) + Task 2 (`computeBeamWeights` analytic + measured-R + `acceptableNulls`) cover spec §2 entirely. The cross-validation is vs `superdirectiveWeights` (Γ-based) only — corrected from the spec's imprecise `lcmvWeights` mention (the freq-domain beam is never identity-R).
- **Placeholders:** none — full code.
- **Type consistency:** `MeasuredNoise`/`BeamWeightOptions`/`computeBeamWeights`/`acceptableNulls` + the 4 constants consistent. Reuses `Complex`/ops/`steeringVector`/`diffuseCoherence`/`solve`/`Direction`/`ArrayGeometry` from the beamformer layer.
- **Constraints:** zero-dep, browser-safe, `.js` imports, no `as`, fresh-object `ZERO()` (no shared-ref aliasing), Python-faithful constants + algorithm.
